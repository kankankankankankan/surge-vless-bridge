import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CliConfig } from '../types/cli-config';
import type { InstallProgressReporter } from '../install-progress';
import { pathExists } from '../utils/fs';
import { installOfficialMihomo, installMihomoWithHomebrew, readMihomoVersion } from './dependencies';
import { getMihomoServiceStatus, restartMihomoLaunchAgent, stopMihomoLaunchAgent, waitForMihomoRuntime } from './launch-agent';

const execFileAsync = promisify(execFile);
type InstallResult = { path: string; version: string; output: string };

const defaultOperations = {
  installOfficial: installOfficialMihomo,
  installHomebrew: installMihomoWithHomebrew,
  status: getMihomoServiceStatus,
  readVersion: readMihomoVersion,
  restart: restartMihomoLaunchAgent,
  stop: stopMihomoLaunchAgent,
  verify: waitForMihomoRuntime,
  validate: async (binary: string, config: CliConfig) => {
    try {
      await execFileAsync(binary, ['-t', '-d', config.mihomo.dataDir, '-f', join(config.mihomo.dataDir, 'config.yaml')],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    } catch {
      throw new Error('新 Mihomo 未通过当前配置校验，已停止更新。');
    }
  },
};

export const installAndVerifyMihomo = async ({
  config, installDir, method, reportProgress, saveBinaryPath,
}: {
  config: CliConfig;
  installDir: string;
  method: 'direct' | 'homebrew';
  reportProgress?: InstallProgressReporter;
  saveBinaryPath: (binary: string) => Promise<void>;
}, overrides: Partial<typeof defaultOperations> = {}) => {
  const operations = { ...defaultOperations, ...overrides };
  await mkdir(installDir, { recursive: true });
  const lockDir = join(installDir, '.mihomo-update.lock');
  try { await mkdir(lockDir, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('已有 Mihomo 更新或待恢复事务。请先检查 bin/.mihomo-update.lock，保留其中备份后处理。');
    }
    throw error;
  }
  let retainBackup = false;
  const snapshots: Array<{ target: string; backup: string; existed: boolean }> = [];
  const snapshot = async (target: string, name: string) => {
    const existed = await pathExists(target);
    if (existed && (await lstat(target)).isSymbolicLink()) throw new Error('托管更新目标是符号链接，请使用对应安装来源更新。');
    const backup = join(lockDir, name);
    if (existed) await copyFile(target, backup);
    snapshots.push({ target, backup, existed });
  };
  try {
    const before = await operations.status(config);
    const wasRunning = Boolean(before.loaded && before.pid);
    if (before.loaded && !before.pid) throw new Error('Mihomo 服务已加载但没有运行进程，请先停止或修复服务，再执行更新。');
    if (before.loaded && !before.serviceMatchesConfig) throw new Error('Mihomo 服务与当前配置不匹配，已停止更新。');
    if (before.controllerReady && !wasRunning) throw new Error('Controller 正由未确认归属的进程提供服务，已停止更新。');
    const oldVersion = wasRunning ? await operations.readVersion(config.mihomo.binary) : undefined;
    const hasConfig = await pathExists(join(config.mihomo.dataDir, 'config.yaml'));
    if (wasRunning && !hasConfig) throw new Error('运行中的 Mihomo 缺少配置文件，已停止更新。');
    if (wasRunning && oldVersion) await operations.verify(config, oldVersion);
    if (method === 'direct') {
      await snapshot(join(installDir, 'mihomo'), 'binary');
      await snapshot(join(installDir, 'mihomo.previous'), 'previous-binary');
    }
    let installed = false;
    let restartAttempted = false;
    let saveAttempted = false;
    try {
      const result: InstallResult = method === 'direct'
        ? await operations.installOfficial(installDir, reportProgress, async (path) => {
          if (hasConfig) await operations.validate(path, config);
        })
        : await operations.installHomebrew(reportProgress);
      installed = true;
      const next = { ...config, mihomo: { ...config.mihomo, binary: result.path } };
      if (method === 'homebrew' && hasConfig) await operations.validate(result.path, next);
      if (wasRunning) {
        reportProgress?.({ target: 'mihomo', method, phase: 'validating', percent: 97,
          message: '正在验证运行中的新版本', detail: '重启服务并核对进程归属、版本与 Controller' });
        restartAttempted = true;
        await operations.restart(next);
        await operations.verify(next, result.version);
      }
      saveAttempted = true;
      await saveBinaryPath(result.path);
      return { ...result, runtimeVerified: wasRunning,
        output: `${result.output}\n${wasRunning ? '运行版本与 Controller 已验证。' : '服务未运行，已完成文件验证，未启动服务。'}` };
    } catch {
      const failures: string[] = [];
      if (restartAttempted) {
        try { await operations.stop({}); } catch { failures.push('停止候选服务失败'); }
      }
      if (method === 'direct') {
        for (const entry of snapshots) {
          try {
            if (entry.existed) {
              const staged = `${entry.target}.recover`;
              await copyFile(entry.backup, staged);
              await rename(staged, entry.target);
            } else await rm(entry.target, { force: true });
          } catch { failures.push('恢复托管文件失败'); }
        }
      }
      if (saveAttempted) {
        try { await saveBinaryPath(config.mihomo.binary); } catch { failures.push('恢复应用配置失败'); }
      }
      if (restartAttempted && oldVersion) {
        try {
          await operations.restart(config);
          await operations.verify(config, oldVersion);
        } catch { failures.push('恢复旧服务或验证旧版本失败'); }
      }
      if (failures.length) {
        retainBackup = true;
        throw new Error(`Mihomo 更新失败，${failures.join('；')}。备份保留在 bin/.mihomo-update.lock，请先恢复后重试。`);
      }
      if (method === 'homebrew') {
        throw new Error('Homebrew 安装或运行验证失败。应用配置已保留，但 Homebrew 管理的二进制无法自动回退，请检查 Homebrew 安装和服务状态。');
      }
      throw new Error(installed ? 'Mihomo 更新未通过运行验证或配置保存，已恢复更新前文件和服务状态。'
        : 'Mihomo 下载、校验或安装失败，已保留更新前文件和服务状态。');
    }
  } finally {
    if (!retainBackup) await rm(lockDir, { recursive: true, force: true });
  }
};
