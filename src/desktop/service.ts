import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import { isIPv4 } from 'node:net';

import { HOME_CONFIG_FILE_PATH, listSurgeProfiles, loadCliConfig } from '../configuration';
import {
  cleanManagedArtifacts,
  backupSurgeProfile,
  inspectPolicyGroups,
  rebuildSurgeFromLocalConfigs,
  restoreSurgeProfileBackup,
  runDoctor,
  syncSubscriptionToSurge,
} from '../surge';
import type { CliConfigInput } from '../types/cli-config';
import { pathExists, readJsonFile, readTextFile, writeTextFile } from '../utils/fs';
import {
  compareVersions,
  findHomebrew,
  inspectSingBoxVersion,
  installOfficialSingBox,
  installSingBoxWithHomebrew,
  rollbackOfficialSingBox,
} from './dependencies';
import { LAUNCH_AGENT_LABEL, LaunchAgentScheduler } from './scheduler';
import { clearHistory, readHistory, readLogTail, recordActivity } from './storage';
import type {
  ActionResult,
  ActivityEntry,
  DesktopAction,
  DesktopConfigView,
  DesktopState,
  RepairableCheck,
  ScheduleSettings,
  SingBoxInstallMethod,
} from './types';

const ACTION_LABELS: Record<DesktopAction, string> = {
  doctor: '环境检查',
  preview: '预览更新',
  sync: '同步到 Surge',
  rebuild: '本地重建',
  restore: '恢复最新备份',
  clean: '清理托管配置',
};

const uniqueLines = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

const validateSources = (subscriptionUrls: string[], vlessNodes: string[]) => {
  for (const value of subscriptionUrls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`无效的订阅地址：${value}`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'data:') {
      throw new Error(`订阅地址仅支持 HTTP 或 HTTPS：${url.origin}`);
    }
  }

  const invalidNode = vlessNodes.find((value) => !value.startsWith('vless://'));
  if (invalidNode) {
    throw new Error('直接节点必须以 vless:// 开头。');
  }
};

const captureConsole = async <T>(run: () => Promise<T>) => {
  const lines: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const collect = (...args: unknown[]) => lines.push(args.map(String).join(' '));

  console.log = collect;
  console.warn = collect;
  console.error = collect;
  try {
    return { result: await run(), output: lines.join('\n').trim() };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
};

export class DesktopService {
  readonly configPath: string;
  readonly stateDir: string;
  readonly historyPath: string;
  readonly schedulerLogPath: string;
  readonly scheduler: LaunchAgentScheduler;
  private operationRunning = false;
  private latestSingBoxCache?: { version: string; expiresAt: number };

  constructor({
    configPath = join(homedir(), HOME_CONFIG_FILE_PATH),
    executablePath,
    scheduledEntryPath,
  }: {
    configPath?: string;
    executablePath: string;
    scheduledEntryPath: string;
  }) {
    this.configPath = configPath;
    this.stateDir = join(dirname(configPath), 'desktop');
    this.historyPath = join(this.stateDir, 'history.json');
    this.schedulerLogPath = join(this.stateDir, 'scheduler.log');
    this.scheduler = new LaunchAgentScheduler({
      metadataPath: join(this.stateDir, 'schedule.json'),
      launchAgentPath: join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
      logPath: this.schedulerLogPath,
      configPath,
      executablePath,
      scheduledEntryPath,
    });
  }

  private async loadConfig() {
    return loadCliConfig({ cwd: homedir(), configPath: this.configPath });
  }

  private async updateConfig(patch: CliConfigInput) {
    const raw = (await pathExists(this.configPath)) ? await readJsonFile<CliConfigInput>(this.configPath) : {};
    await writeTextFile(this.configPath, `${JSON.stringify({ ...raw, ...patch }, null, 2)}\n`);
  }

  async saveSources(input: { subscriptionUrls: string[]; vlessNodes: string[] }) {
    const subscriptionUrls = uniqueLines(input.subscriptionUrls);
    const vlessNodes = uniqueLines(input.vlessNodes);
    validateSources(subscriptionUrls, vlessNodes);
    await this.updateConfig({ subscriptionUrl: '', subscriptionUrls, vlessNodes });
    return this.getState();
  }

  async saveSettings(input: DesktopConfigView) {
    const portStart = Number(input.portStart);
    const backupKeep = Number(input.backupKeep);
    const connectTimeoutSeconds = Number(input.connectTimeoutSeconds);
    if (!Number.isInteger(portStart) || portStart < 1024 || portStart > 65535) {
      throw new Error('起始端口必须在 1024 到 65535 之间。');
    }
    if (!Number.isInteger(backupKeep) || backupKeep < 1 || backupKeep > 200) {
      throw new Error('备份数量必须在 1 到 200 之间。');
    }
    if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1 || connectTimeoutSeconds > 300) {
      throw new Error('连接超时必须在 1 到 300 秒之间。');
    }

    const policyGroupName = input.policyGroupName.trim() || 'VLESS';
    const policyGroupTargets = uniqueLines(input.policyGroupTargets).filter((name) => name !== policyGroupName);
    const policyGroupExclusions = uniqueLines(input.policyGroupExclusions ?? []).filter(
      (name) => name !== policyGroupName && !policyGroupTargets.includes(name),
    );
    const validPolicyGroupTargetModes = new Set(['auto', 'merge', 'reference']);
    const policyGroupTargetModes = Object.fromEntries(
      policyGroupTargets.map((name) => {
        const mode = input.policyGroupTargetModes?.[name] ?? 'auto';
        if (!validPolicyGroupTargetModes.has(mode)) {
          throw new Error(`策略组接入方式无效：${name}`);
        }
        return [name, mode];
      }),
    );
    const invalidPolicyGroupName = [policyGroupName, ...policyGroupTargets, ...policyGroupExclusions].find((name) =>
      /[=,\r\n]/.test(name),
    );
    if (invalidPolicyGroupName) {
      throw new Error(`策略组名称不能包含逗号、等号或换行：${invalidPolicyGroupName}`);
    }

    const dohEndpoint = input.addressResolverDohEndpoint.trim();
    const dnsServers = uniqueLines(input.addressResolverDnsServers);
    if (input.addressResolverStrategy === 'doh') {
      let url: URL;
      try {
        url = new URL(dohEndpoint);
      } catch {
        throw new Error('DoH 地址格式无效。');
      }
      if (url.protocol !== 'https:') {
        throw new Error('DoH 地址必须使用 HTTPS。');
      }
    }
    if (input.addressResolverStrategy === 'dns') {
      if (dnsServers.length === 0) {
        throw new Error('请至少填写一个 DNS 服务器。');
      }
      try {
        new Resolver().setServers(dnsServers);
      } catch {
        throw new Error('指定 DNS 中包含无效地址。');
      }
    }
    const udpTestTarget = input.udpTestTarget.trim() || 'apple.com@8.8.8.8';
    if (input.udpRelay && input.udpTestEnabled) {
      const parts = udpTestTarget.split('@');
      if (parts.length !== 2 || !parts[0] || /\s/.test(parts[0]) || !isIPv4(parts[1] ?? '')) {
        throw new Error('UDP 测试目标格式应为域名@IPv4，例如 apple.com@8.8.8.8。');
      }
    }

    await this.updateConfig({
      surgeConfigPath: input.surgeConfigPath.trim(),
      singBoxBinary: input.singBoxBinary.trim(),
      policyGroupName,
      policyGroupTargets,
      policyGroupExclusions,
      policyGroupTargetModes,
      portStart,
      backupKeep,
      autoReload: Boolean(input.autoReload),
      udpRelay: Boolean(input.udpRelay),
      udpTestEnabled: Boolean(input.udpRelay && input.udpTestEnabled),
      udpTestTarget,
      tcpFastOpen: Boolean(input.tcpFastOpen),
      connectTimeoutEnabled: Boolean(input.connectTimeoutEnabled),
      connectTimeoutSeconds,
      addressResolver: {
        strategy: input.addressResolverStrategy,
        dohEndpoint,
        dnsServers,
        filterSurgeFakeIp: Boolean(input.addressResolverFilterSurgeFakeIp),
      },
    });
    return this.getState();
  }

  private async listBackups(backupDir: string) {
    try {
      const entries = await readdir(backupDir, { withFileTypes: true });
      const backups = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
          .map(async (entry) => {
            const path = join(backupDir, entry.name);
            const info = await stat(path);
            return {
              path,
              name: entry.name,
              modifiedAt: info.mtime.toISOString(),
              size: info.size,
            };
          }),
      );
      return backups.sort((left, right) => right.name.localeCompare(left.name));
    } catch {
      return [];
    }
  }

  private async countNodes(outputDir: string) {
    try {
      const entries = await readdir(outputDir);
      return entries.filter((entry) => /^sing-box\[\d+\]\.json$/.test(entry)).length;
    } catch {
      return 0;
    }
  }

  private async singBoxStatus(binaryPath: string, includeLatest = false) {
    const homebrewPath = await findHomebrew();
    const managedSingBoxPath = join(dirname(this.configPath), 'bin', 'sing-box');
    const localStatus = await inspectSingBoxVersion({
      binaryPath,
      managedPath: managedSingBoxPath,
      brewPath: homebrewPath,
    });
    if (!includeLatest) return { homebrewPath, managedSingBoxPath, status: localStatus };

    if (this.latestSingBoxCache && this.latestSingBoxCache.expiresAt > Date.now()) {
      const latestVersion = this.latestSingBoxCache.version;
      return {
        homebrewPath,
        managedSingBoxPath,
        status: {
          ...localStatus,
          latestVersion,
          updateAvailable: localStatus.currentVersion
            ? compareVersions(localStatus.currentVersion, latestVersion) < 0
            : undefined,
        },
      };
    }

    const status = await inspectSingBoxVersion({
      binaryPath,
      managedPath: managedSingBoxPath,
      brewPath: homebrewPath,
      includeLatest: true,
    });
    if (status.latestVersion) {
      this.latestSingBoxCache = { version: status.latestVersion, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
    }
    return { homebrewPath, managedSingBoxPath, status };
  }

  async getState(): Promise<DesktopState> {
    const loaded = await this.loadConfig();
    const dependency = await this.singBoxStatus(loaded.config.singBoxBinary);
    const doctorCapture = await captureConsole(() => runDoctor(loaded.config));
    const profiles = await listSurgeProfiles();
    const surgeText = loaded.config.surgeConfigPath
      ? await readTextFile(loaded.config.surgeConfigPath).catch(() => '')
      : '';

    return {
      configPath: loaded.configPath,
      configExists: loaded.exists,
      config: {
        subscriptionUrls: [loaded.config.subscriptionUrl, ...(loaded.config.subscriptionUrls ?? [])].filter(
          (value): value is string => Boolean(value),
        ),
        vlessNodes: loaded.config.vlessNodes ?? [],
        surgeConfigPath: loaded.config.surgeConfigPath,
        singBoxBinary: loaded.config.singBoxBinary,
        policyGroupName: loaded.config.policyGroupName,
        policyGroupTargets: loaded.config.policyGroupTargets,
        policyGroupExclusions: loaded.config.policyGroupExclusions,
        policyGroupTargetModes: loaded.config.policyGroupTargetModes,
        portStart: loaded.config.portStart,
        backupKeep: loaded.config.backupKeep,
        autoReload: loaded.config.autoReload,
        udpRelay: loaded.config.udpRelay,
        udpTestEnabled: loaded.config.udpTestEnabled,
        udpTestTarget: loaded.config.udpTestTarget,
        tcpFastOpen: loaded.config.tcpFastOpen,
        connectTimeoutEnabled: loaded.config.connectTimeoutEnabled,
        connectTimeoutSeconds: loaded.config.connectTimeoutSeconds,
        addressResolverStrategy: loaded.config.addressResolver.strategy,
        addressResolverDohEndpoint: loaded.config.addressResolver.dohEndpoint,
        addressResolverDnsServers: loaded.config.addressResolver.dnsServers,
        addressResolverFilterSurgeFakeIp: loaded.config.addressResolver.filterSurgeFakeIp,
      },
      doctor: doctorCapture.result,
      nodeCount: await this.countNodes(loaded.config.outputDir),
      backups: (await this.listBackups(loaded.config.backupDir)).slice(0, 20),
      history: await readHistory(this.historyPath),
      schedule: await this.scheduler.getSettings(),
      schedulerLog: await readLogTail(this.schedulerLogPath),
      profiles: profiles.map((profile) => ({ path: profile.path, modifiedAt: new Date(profile.mtimeMs).toISOString() })),
      policyGroups: inspectPolicyGroups({ surgeText, policyGroupName: loaded.config.policyGroupName }),
      environment: {
        homebrewPath: dependency.homebrewPath,
        managedSingBoxPath: dependency.managedSingBoxPath,
        singBox: dependency.status,
      },
    };
  }

  async checkSingBoxUpdate() {
    const loaded = await this.loadConfig();
    return (await this.singBoxStatus(loaded.config.singBoxBinary, true)).status;
  }

  async inspectPolicyGroups(input: { surgeConfigPath: string; policyGroupName: string }) {
    const surgeConfigPath = input.surgeConfigPath.trim();
    if (!surgeConfigPath) {
      throw new Error('请先选择 Surge 配置文件。');
    }
    const surgeText = await readTextFile(surgeConfigPath);
    return inspectPolicyGroups({ surgeText, policyGroupName: input.policyGroupName.trim() || 'VLESS' });
  }

  async repairCheck(check: RepairableCheck): Promise<ActionResult> {
    if (this.operationRunning) {
      return { success: false, message: '已有一个任务正在执行。', output: '' };
    }

    this.operationRunning = true;
    try {
      const loaded = await this.loadConfig();
      let message = '';
      let output = '';

      if (check === 'surgeConfigPath') {
        const profile = (await listSurgeProfiles())[0];
        if (!profile) {
          throw new Error('没有自动找到 Surge 配置，请在设置中手动选择。');
        }
        await this.updateConfig({ surgeConfigPath: profile.path });
        message = '已选择最近使用的 Surge 配置。';
        output = profile.path;
      } else if (check === 'outputDir' || check === 'backupDir') {
        const path = check === 'outputDir' ? loaded.config.outputDir : loaded.config.backupDir;
        await mkdir(path, { recursive: true });
        message = check === 'outputDir' ? '节点目录已创建。' : '备份目录已创建。';
        output = path;
      } else {
        if (!loaded.config.surgeConfigPath || !(await pathExists(loaded.config.surgeConfigPath))) {
          throw new Error('请先选择有效的 Surge 配置文件。');
        }
        const section = check === 'proxy-section' ? '[Proxy]' : '[Proxy Group]';
        const source = await readTextFile(loaded.config.surgeConfigPath);
        if (source.includes(section)) {
          message = `${section} 已存在。`;
          output = loaded.config.surgeConfigPath;
        } else {
          const backupPath = await backupSurgeProfile(loaded.config);
          const updated = `${source.replace(/\s*$/, '')}\n\n${section}\n`;
          await writeTextFile(loaded.config.surgeConfigPath, updated);
          message = `已补齐 ${section}。`;
          output = `备份：${backupPath}\n配置：${loaded.config.surgeConfigPath}`;
        }
      }

      await recordActivity(this.historyPath, {
        action: 'repair-environment',
        success: true,
        message,
        output,
      });
      return { success: true, message, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordActivity(this.historyPath, {
        action: 'repair-environment',
        success: false,
        message,
        output: message,
      });
      return { success: false, message, output: message };
    } finally {
      this.operationRunning = false;
    }
  }

  async installSingBox(method: SingBoxInstallMethod): Promise<ActionResult> {
    if (this.operationRunning) {
      return { success: false, message: '已有一个任务正在执行。', output: '' };
    }

    this.operationRunning = true;
    let activityAction: 'install-sing-box' | 'update-sing-box' = 'install-sing-box';
    try {
      const loaded = await this.loadConfig();
      const before = await this.singBoxStatus(loaded.config.singBoxBinary);
      const result =
        method === 'direct'
          ? await installOfficialSingBox(join(dirname(this.configPath), 'bin'), loaded.config.outputDir)
          : await installSingBoxWithHomebrew();
      await this.updateConfig({ singBoxBinary: result.path });
      this.latestSingBoxCache = undefined;
      activityAction = before.status.installed ? 'update-sing-box' : 'install-sing-box';
      const message = before.status.installed ? `sing-box 已更新到 ${result.version}。` : `sing-box ${result.version} 已安装。`;
      await recordActivity(this.historyPath, {
        action: activityAction,
        success: true,
        message,
        output: result.output,
      });
      return { success: true, message, output: result.output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordActivity(this.historyPath, {
        action: activityAction,
        success: false,
        message,
        output: message,
      });
      return { success: false, message, output: message };
    } finally {
      this.operationRunning = false;
    }
  }

  async rollbackSingBox(): Promise<ActionResult> {
    if (this.operationRunning) {
      return { success: false, message: '已有一个任务正在执行。', output: '' };
    }

    this.operationRunning = true;
    try {
      const loaded = await this.loadConfig();
      const result = await rollbackOfficialSingBox(join(dirname(this.configPath), 'bin'), loaded.config.outputDir);
      await this.updateConfig({ singBoxBinary: result.path });
      this.latestSingBoxCache = undefined;
      const message = `sing-box 已回退到 ${result.version}。`;
      await recordActivity(this.historyPath, {
        action: 'rollback-sing-box',
        success: true,
        message,
        output: result.output,
      });
      return { success: true, message, output: result.output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordActivity(this.historyPath, {
        action: 'rollback-sing-box',
        success: false,
        message,
        output: message,
      });
      return { success: false, message, output: message };
    } finally {
      this.operationRunning = false;
    }
  }

  async runAction(action: DesktopAction): Promise<ActionResult> {
    if (this.operationRunning) {
      return { success: false, message: '已有一个任务正在执行。', output: '' };
    }

    this.operationRunning = true;
    const label = ACTION_LABELS[action];
    try {
      const loaded = await this.loadConfig();
      const captured = await captureConsole(async () => {
        switch (action) {
          case 'doctor':
            return runDoctor(loaded.config);
          case 'preview':
            return syncSubscriptionToSurge(loaded.config, { dryRun: true });
          case 'sync':
            return syncSubscriptionToSurge(loaded.config);
          case 'rebuild':
            return rebuildSurgeFromLocalConfigs(loaded.config);
          case 'restore':
            return restoreSurgeProfileBackup({ config: loaded.config });
          case 'clean':
            return cleanManagedArtifacts(loaded.config);
        }
      });
      const result = captured.result as { count?: number; preview?: ActionResult['preview'] } | string;
      const count = typeof result === 'object' && result && 'count' in result ? result.count : undefined;
      const preview = typeof result === 'object' && result && 'preview' in result ? result.preview : undefined;
      const doctorFailures =
        action === 'doctor' && typeof result === 'object' && result && 'failures' in result
          ? Number(result.failures)
          : 0;
      const success = doctorFailures === 0;
      const message =
        doctorFailures > 0
          ? `${label}发现 ${doctorFailures} 项问题。`
          : count === undefined
            ? `${label}已完成。`
            : `${label}已完成，共 ${count} 个节点。`;
      await recordActivity(this.historyPath, {
        action,
        success,
        message,
        output: captured.output,
        count,
      });
      return { success, message, output: captured.output, count, preview };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordActivity(this.historyPath, {
        action,
        success: false,
        message,
        output: message,
      });
      return { success: false, message, output: message };
    } finally {
      this.operationRunning = false;
    }
  }

  async saveSchedule(input: ScheduleSettings) {
    if (input.enabled) {
      const loaded = await this.loadConfig();
      const doctor = await captureConsole(() => runDoctor(loaded.config));
      if (doctor.result.failures > 0) {
        throw new Error(`请先处理环境检查中的 ${doctor.result.failures} 项问题，再启用定时任务。`);
      }
    }
    return this.scheduler.save(input);
  }

  async disableSchedule() {
    return this.scheduler.disable();
  }

  async clearHistory() {
    return clearHistory(this.historyPath);
  }

  async cleanOldBackups() {
    const loaded = await this.loadConfig();
    const backups = await this.listBackups(loaded.config.backupDir);
    const stale = backups.slice(1);
    await Promise.all(stale.map((backup) => rm(backup.path, { force: true })));
    return {
      deletedCount: stale.length,
      backups: backups.slice(0, 1),
    };
  }
}
