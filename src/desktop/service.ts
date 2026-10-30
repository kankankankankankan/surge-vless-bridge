import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import { isIPv4 } from 'node:net';

import {
  HOME_CONFIG_FILE_PATH,
  listSurgeProfiles,
  loadCliConfig,
  persistMihomoControllerSecret,
} from '../configuration';
import {
  backupSurgeProfile,
  inspectPolicyGroups,
  restoreSurgeProfileBackup,
} from '../surge';
import { cleanBridge, doctorBridge, rebuildBridge, syncBridge } from '../engines';
import type { CliConfig, CliConfigInput, RuntimeMode } from '../types/cli-config';
import { assertRuntimeModeConfirmed } from '../runtime-mode';
import { pathExists, readJsonFile, readTextFile, writeTextFile } from '../utils/fs';
import {
  compareVersions,
  findHomebrew,
  inspectSingBoxVersion,
  installOfficialSingBox,
  installSingBoxWithHomebrew,
  rollbackOfficialSingBox,
} from './dependencies';
import {
  inspectMihomoVersion,
  installMihomoWithHomebrew,
  installOfficialMihomo,
  rollbackOfficialMihomo,
} from '../mihomo/dependencies';
import {
  getMihomoServiceStatus,
  installMihomoLaunchAgent,
  restartMihomoLaunchAgent,
  stopMihomoLaunchAgent,
} from '../mihomo/launch-agent';
import { readMihomoNodes } from '../mihomo/sync';
import type { InstallProgressEvent, InstallProgressReporter } from '../install-progress';
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
  MihomoInstallMethod,
  MihomoServiceAction,
} from './types';

const ACTION_LABELS: Record<DesktopAction, string> = {
  doctor: '环境检查',
  preview: '预览更新',
  sync: '同步到 Surge',
  rebuild: '本地重建',
  restore: '恢复最新备份',
  clean: '清理托管配置',
};

type DesktopServiceDependencies = {
  switchSync: typeof syncBridge;
  readMihomoServiceStatus: typeof getMihomoServiceStatus;
  installMihomoService: typeof installMihomoLaunchAgent;
  stopMihomoService: typeof stopMihomoLaunchAgent;
  writeConfigFile: typeof writeTextFile;
};

const defaultDependencies: DesktopServiceDependencies = {
  switchSync: syncBridge,
  readMihomoServiceStatus: getMihomoServiceStatus,
  installMihomoService: installMihomoLaunchAgent,
  stopMihomoService: stopMihomoLaunchAgent,
  writeConfigFile: writeTextFile,
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
  private readonly dependencies: DesktopServiceDependencies;
  private operationRunning = false;
  private latestSingBoxCache?: { version: string; expiresAt: number };
  private readonly reportInstallProgress?: InstallProgressReporter;

  constructor({
    configPath = join(homedir(), HOME_CONFIG_FILE_PATH),
    executablePath,
    scheduledEntryPath,
    dependencies,
    onInstallProgress,
  }: {
    configPath?: string;
    executablePath: string;
    scheduledEntryPath: string;
    dependencies?: Partial<DesktopServiceDependencies>;
    onInstallProgress?: InstallProgressReporter;
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
    this.dependencies = { ...defaultDependencies, ...dependencies };
    this.reportInstallProgress = onInstallProgress;
  }

  private emitInstallProgress(event: InstallProgressEvent) {
    this.reportInstallProgress?.(event);
  }

  private async loadConfig() {
    return loadCliConfig({ cwd: homedir(), configPath: this.configPath });
  }

  private async updateConfig(patch: CliConfigInput) {
    const raw = (await pathExists(this.configPath)) ? await readJsonFile<CliConfigInput>(this.configPath) : {};
    await this.dependencies.writeConfigFile(this.configPath, `${JSON.stringify({ ...raw, ...patch }, null, 2)}\n`);
  }

  private async restoreMihomoServiceState(
    config: CliConfig,
    status: Awaited<ReturnType<typeof getMihomoServiceStatus>>,
  ) {
    if (status.loaded) {
      await this.dependencies.installMihomoService(config);
      return;
    }
    if (status.installed) {
      await this.dependencies.installMihomoService(config);
      await this.dependencies.stopMihomoService();
      return;
    }
    await this.dependencies.stopMihomoService({ uninstall: true });
  }

  async saveSources(input: { subscriptionUrls: string[]; subscriptionNames?: string[]; vlessNodes: string[] }) {
    const seenSubscriptions = new Set<string>();
    const subscriptions = input.subscriptionUrls
      .map((value, index) => ({
        url: value.trim(),
        name: input.subscriptionNames?.[index]?.trim() ?? '',
      }))
      .filter((entry) => {
        if (!entry.url || seenSubscriptions.has(entry.url)) return false;
        seenSubscriptions.add(entry.url);
        return true;
      });
    const subscriptionUrls = subscriptions.map((entry) => entry.url);
    const subscriptionNames = subscriptions.map((entry) => entry.name);
    const vlessNodes = uniqueLines(input.vlessNodes);
    validateSources(subscriptionUrls, vlessNodes);
    await this.updateConfig({ subscriptionUrl: '', subscriptionUrls, subscriptionNames, vlessNodes });
    return this.getState();
  }

  async saveSettings(input: DesktopConfigView) {
    const portStart = Number(input.portStart);
    const backupKeep = Number(input.backupKeep);
    const connectTimeoutSeconds = Number(input.connectTimeoutSeconds);
    const mihomoControllerPort = Number(input.mihomoControllerPort);
    if (!Number.isInteger(portStart) || portStart < 1024 || portStart > 65535) {
      throw new Error('起始端口必须在 1024 到 65535 之间。');
    }
    if (!Number.isInteger(backupKeep) || backupKeep < 1 || backupKeep > 200) {
      throw new Error('备份数量必须在 1 到 200 之间。');
    }
    if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1 || connectTimeoutSeconds > 300) {
      throw new Error('连接超时必须在 1 到 300 秒之间。');
    }
    if (!Number.isInteger(mihomoControllerPort) || mihomoControllerPort < 1024 || mihomoControllerPort > 65535) {
      throw new Error('Mihomo controller 端口必须在 1024 到 65535 之间。');
    }
    if (!['silent', 'error', 'warning', 'info', 'debug'].includes(input.mihomoLogLevel)) {
      throw new Error('Mihomo 日志级别无效。');
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

    const loaded = await this.loadConfig();
    await this.updateConfig({
      surgeConfigPath: input.surgeConfigPath.trim(),
      singBoxBinary: input.singBoxBinary.trim(),
      mihomo: {
        ...loaded.config.mihomo,
        binary: input.mihomoBinary.trim(),
        dataDir: input.mihomoDataDir.trim(),
        controllerPort: mihomoControllerPort,
        autoStart: Boolean(input.mihomoAutoStart),
        logLevel: input.mihomoLogLevel,
      },
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

  private async countMihomoNodes(config: CliConfig) {
    return (await readMihomoNodes(config).catch(() => [])).length;
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

  private async mihomoStatus(binaryPath: string, includeLatest = false) {
    const homebrewPath = await findHomebrew();
    const managedMihomoPath = join(dirname(this.configPath), 'bin', 'mihomo');
    return {
      homebrewPath,
      managedMihomoPath,
      status: await inspectMihomoVersion({
        binaryPath,
        managedPath: managedMihomoPath,
        brewPath: homebrewPath,
        includeLatest,
      }),
    };
  }

  async getState(): Promise<DesktopState> {
    const loaded = await this.loadConfig();
    const [
      dependency,
      mihomoDependency,
      mihomoService,
      doctorCapture,
      profiles,
      surgeText,
      nodeCount,
      backups,
      history,
      schedule,
      schedulerLog,
    ] = await Promise.all([
      this.singBoxStatus(loaded.config.singBoxBinary),
      this.mihomoStatus(loaded.config.mihomo.binary),
      getMihomoServiceStatus(loaded.config),
      captureConsole(() => doctorBridge(loaded.config)),
      listSurgeProfiles(),
      loaded.config.surgeConfigPath ? readTextFile(loaded.config.surgeConfigPath).catch(() => '') : Promise.resolve(''),
      loaded.config.runtimeMode === 'mihomo'
        ? this.countMihomoNodes(loaded.config)
        : this.countNodes(loaded.config.outputDir),
      this.listBackups(loaded.config.backupDir),
      readHistory(this.historyPath),
      this.scheduler.getSettings(),
      readLogTail(this.schedulerLogPath),
    ]);

    return {
      configPath: loaded.configPath,
      configExists: loaded.exists,
      runtimeModeConfirmed: loaded.config.runtimeModeConfirmed,
      config: {
        runtimeMode: loaded.config.runtimeMode,
        subscriptionUrls: [loaded.config.subscriptionUrl, ...(loaded.config.subscriptionUrls ?? [])].filter(
          (value): value is string => Boolean(value),
        ),
        subscriptionNames: [
          ...(loaded.config.subscriptionUrl ? [''] : []),
          ...(loaded.config.subscriptionUrls ?? []).map(
            (_, index) => loaded.config.subscriptionNames?.[index]?.trim() ?? '',
          ),
        ],
        vlessNodes: loaded.config.vlessNodes ?? [],
        surgeConfigPath: loaded.config.surgeConfigPath,
        singBoxBinary: loaded.config.singBoxBinary,
        mihomoBinary: loaded.config.mihomo.binary,
        mihomoDataDir: loaded.config.mihomo.dataDir,
        mihomoControllerPort: loaded.config.mihomo.controllerPort,
        mihomoAutoStart: loaded.config.mihomo.autoStart,
        mihomoLogLevel: loaded.config.mihomo.logLevel,
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
      nodeCount,
      backups: backups.slice(0, 20),
      history,
      schedule,
      schedulerLog,
      profiles: profiles.map((profile) => ({ path: profile.path, modifiedAt: new Date(profile.mtimeMs).toISOString() })),
      policyGroups: inspectPolicyGroups({ surgeText, policyGroupName: loaded.config.policyGroupName }),
      environment: {
        homebrewPath: dependency.homebrewPath,
        managedSingBoxPath: dependency.managedSingBoxPath,
        managedMihomoPath: mihomoDependency.managedMihomoPath,
        singBox: dependency.status,
        mihomo: mihomoDependency.status,
        mihomoService,
        controllerSecretConfigured: Boolean(loaded.config.mihomo.controllerSecret),
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
      } else if (check === 'outputDir' || check === 'backupDir' || check === 'mihomo-data-dir') {
        const path =
          check === 'outputDir'
            ? loaded.config.outputDir
            : check === 'mihomo-data-dir'
              ? loaded.config.mihomo.dataDir
              : loaded.config.backupDir;
        await mkdir(path, { recursive: true });
        message =
          check === 'outputDir'
            ? '节点目录已创建。'
            : check === 'mihomo-data-dir'
              ? 'Mihomo 数据目录已创建。'
              : '备份目录已创建。';
        output = path;
      } else if (
        check === 'mihomo-launch-agent' ||
        check === 'mihomo-controller' ||
        check === 'mihomo-listeners'
      ) {
        if (!(await pathExists(join(loaded.config.mihomo.dataDir, 'config.yaml')))) {
          throw new Error('请先执行一次 Mihomo 同步，生成并校验 config.yaml。');
        }
        if (check === 'mihomo-launch-agent') {
          await installMihomoLaunchAgent(loaded.config);
          message = 'Mihomo LaunchAgent 已安装并启动。';
        } else {
          await restartMihomoLaunchAgent(loaded.config);
          message = check === 'mihomo-controller' ? 'Mihomo 已重启，正在重新连接 Controller。' : 'Mihomo 已重启，listener 已重建。';
        }
        output = message;
      } else {
        if (!loaded.config.surgeConfigPath || !(await pathExists(loaded.config.surgeConfigPath))) {
          throw new Error('请先选择有效的 Surge 配置文件。');
        }
        const section =
          check === 'proxy-section' ? '[Proxy]' : check === 'rule-section' ? '[Rule]' : '[Proxy Group]';
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
          ? await installOfficialSingBox(
              join(dirname(this.configPath), 'bin'),
              loaded.config.outputDir,
              (event) => this.emitInstallProgress(event),
            )
          : await installSingBoxWithHomebrew((event) => this.emitInstallProgress(event));
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
      this.emitInstallProgress({
        target: 'sing-box',
        method,
        phase: 'complete',
        message,
        detail: result.path,
        percent: 100,
      });
      return { success: true, message, output: result.output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitInstallProgress({ target: 'sing-box', method, phase: 'failed', message, detail: message });
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

  async checkMihomoUpdate() {
    const loaded = await this.loadConfig();
    return (await this.mihomoStatus(loaded.config.mihomo.binary, true)).status;
  }

  async installMihomo(method: MihomoInstallMethod): Promise<ActionResult> {
    if (this.operationRunning) return { success: false, message: '已有一个任务正在执行。', output: '' };
    this.operationRunning = true;
    let activityAction: 'install-mihomo' | 'update-mihomo' = 'install-mihomo';
    try {
      const loaded = await this.loadConfig();
      const before = await this.mihomoStatus(loaded.config.mihomo.binary);
      const result =
        method === 'direct'
          ? await installOfficialMihomo(join(dirname(this.configPath), 'bin'), (event) => this.emitInstallProgress(event))
          : await installMihomoWithHomebrew((event) => this.emitInstallProgress(event));
      await this.updateConfig({ mihomo: { ...loaded.config.mihomo, binary: result.path } });
      activityAction = before.status.installed ? 'update-mihomo' : 'install-mihomo';
      const message = before.status.installed ? `Mihomo 已更新到 ${result.version}。` : `Mihomo ${result.version} 已安装。`;
      await recordActivity(this.historyPath, { action: activityAction, success: true, message, output: result.output });
      this.emitInstallProgress({
        target: 'mihomo',
        method,
        phase: 'complete',
        message,
        detail: result.path,
        percent: 100,
      });
      return { success: true, message, output: result.output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitInstallProgress({ target: 'mihomo', method, phase: 'failed', message, detail: message });
      await recordActivity(this.historyPath, { action: activityAction, success: false, message, output: message });
      return { success: false, message, output: message };
    } finally {
      this.operationRunning = false;
    }
  }

  async rollbackMihomo(): Promise<ActionResult> {
    if (this.operationRunning) return { success: false, message: '已有一个任务正在执行。', output: '' };
    this.operationRunning = true;
    try {
      const result = await rollbackOfficialMihomo(join(dirname(this.configPath), 'bin'));
      const loaded = await this.loadConfig();
      await this.updateConfig({ mihomo: { ...loaded.config.mihomo, binary: result.path } });
      if (loaded.config.runtimeMode === 'mihomo') await restartMihomoLaunchAgent({ ...loaded.config, mihomo: { ...loaded.config.mihomo, binary: result.path } });
      const message = `Mihomo 已回退到 ${result.version}。`;
      await recordActivity(this.historyPath, { action: 'rollback-mihomo', success: true, message, output: result.output });
      return { success: true, message, output: result.output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordActivity(this.historyPath, { action: 'rollback-mihomo', success: false, message, output: message });
      return { success: false, message, output: message };
    } finally {
      this.operationRunning = false;
    }
  }

  async controlMihomo(action: MihomoServiceAction): Promise<ActionResult> {
    if (this.operationRunning) return { success: false, message: '已有一个任务正在执行。', output: '' };
    this.operationRunning = true;
    try {
      const loaded = await this.loadConfig();
      if (action === 'stop') await stopMihomoLaunchAgent();
      else if (action === 'restart') await restartMihomoLaunchAgent(loaded.config);
      else await installMihomoLaunchAgent(loaded.config);
      const message = action === 'stop' ? 'Mihomo 后台服务已停止。' : action === 'restart' ? 'Mihomo 后台服务已重启。' : 'Mihomo 后台服务已启动。';
      await recordActivity(this.historyPath, {
        action: action === 'stop' ? 'stop-mihomo' : 'start-mihomo',
        success: true,
        message,
        output: message,
      });
      return { success: true, message, output: message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message, output: message };
    } finally {
      this.operationRunning = false;
    }
  }

  async switchEngine(targetMode: RuntimeMode): Promise<ActionResult> {
    if (this.operationRunning) return { success: false, message: '已有一个任务正在执行。', output: '' };
    this.operationRunning = true;
    const loaded = await this.loadConfig();

    if (!loaded.config.runtimeModeConfirmed) {
      try {
        const dependency =
          targetMode === 'mihomo'
            ? (await this.mihomoStatus(loaded.config.mihomo.binary)).status
            : (await this.singBoxStatus(loaded.config.singBoxBinary)).status;
        const engineLabel = targetMode === 'mihomo' ? 'Mihomo' : 'sing-box';
        if (!dependency.installed) {
          throw new Error(`请先安装或选择 ${engineLabel} 可执行文件。`);
        }
        if (!dependency.currentVersion) {
          throw new Error(`无法识别 ${engineLabel} 版本，请重新安装或选择正确的可执行文件。`);
        }

        const confirmedConfig =
          targetMode === 'mihomo'
            ? await persistMihomoControllerSecret({ config: loaded.config, configPath: loaded.configPath })
            : loaded.config;
        await this.updateConfig({
          runtimeMode: targetMode,
          runtimeModeConfirmed: true,
          mihomo: confirmedConfig.mihomo,
        });
        const message = `已选择 ${targetMode === 'mihomo' ? 'Mihomo 网关' : 'sing-box External'}。`;
        await recordActivity(this.historyPath, { action: 'switch-engine', success: true, message, output: message });
        return { success: true, message, output: message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordActivity(this.historyPath, { action: 'switch-engine', success: false, message, output: message });
        return { success: false, message, output: message };
      } finally {
        this.operationRunning = false;
      }
    }

    if (loaded.config.runtimeMode === targetMode && loaded.config.runtimeModeConfirmed) {
      this.operationRunning = false;
      return { success: true, message: '当前已经使用该运行引擎。', output: '' };
    }
    const originalConfigExists = await pathExists(loaded.configPath);
    const originalConfigText = originalConfigExists ? await readTextFile(loaded.configPath) : undefined;
    const originalSurgeText = await readTextFile(loaded.config.surgeConfigPath);
    const originalMihomoStatus = await this.dependencies.readMihomoServiceStatus(loaded.config);
    try {
      const baseConfig =
        targetMode === 'mihomo'
          ? await persistMihomoControllerSecret({ config: loaded.config, configPath: loaded.configPath })
          : loaded.config;
      const targetConfig: CliConfig = { ...baseConfig, runtimeMode: targetMode, runtimeModeConfirmed: false };
      await this.dependencies.switchSync(targetConfig, { dryRun: true });
      if (targetMode === 'external') {
        await this.dependencies.stopMihomoService();
      }
      const result = await this.dependencies.switchSync(targetConfig);
      await this.updateConfig({ runtimeMode: targetMode, runtimeModeConfirmed: true, mihomo: targetConfig.mihomo });
      if (targetMode === 'external') await this.dependencies.stopMihomoService({ uninstall: true });
      const message = `运行引擎已切换为 ${targetMode === 'mihomo' ? 'Mihomo 网关' : 'sing-box External'}。`;
      await recordActivity(this.historyPath, { action: 'switch-engine', success: true, message, output: message, count: result.count });
      return { success: true, message, output: message, count: result.count };
    } catch (error) {
      const rollbackErrors: string[] = [];
      await writeTextFile(loaded.config.surgeConfigPath, originalSurgeText).catch((rollbackError) => {
        rollbackErrors.push(`Surge: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`);
      });
      if (originalConfigText === undefined) {
        await rm(loaded.configPath, { force: true }).catch((rollbackError) => {
          rollbackErrors.push(`配置: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`);
        });
      } else {
        await this.dependencies.writeConfigFile(loaded.configPath, originalConfigText).catch((rollbackError) => {
          rollbackErrors.push(`配置: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`);
        });
      }
      await this.restoreMihomoServiceState(loaded.config, originalMihomoStatus).catch((rollbackError) => {
        rollbackErrors.push(`Mihomo 服务: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`);
      });
      const cause = error instanceof Error ? error.message : String(error);
      const message = rollbackErrors.length > 0 ? `${cause}；回滚未完整完成：${rollbackErrors.join('；')}` : cause;
      await recordActivity(this.historyPath, { action: 'switch-engine', success: false, message, output: message });
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
      if (action !== 'doctor' && !loaded.config.runtimeModeConfirmed) {
        assertRuntimeModeConfirmed(loaded.config);
      }
      const captured = await captureConsole(async () => {
        switch (action) {
          case 'doctor':
            return doctorBridge(loaded.config);
          case 'preview':
            return syncBridge(loaded.config, { dryRun: true });
          case 'sync':
            return syncBridge(loaded.config);
          case 'rebuild':
            return rebuildBridge(loaded.config);
          case 'restore':
            return restoreSurgeProfileBackup({ config: loaded.config });
          case 'clean':
            return cleanBridge(loaded.config);
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
      assertRuntimeModeConfirmed(loaded.config);
      const doctor = await captureConsole(() => doctorBridge(loaded.config));
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
