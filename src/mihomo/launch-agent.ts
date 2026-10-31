import { execFile } from 'node:child_process';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { CliConfig } from '../types/cli-config';
import { pathExists, writeTextFile } from '../utils/fs';
import { normalizeMihomoVersion } from './dependencies';

const execFileAsync = promisify(execFile);
export const MIHOMO_LAUNCH_AGENT_LABEL = 'com.chen86860.surge-vless-bridge.mihomo';

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const defaultMihomoLaunchAgentPath = () =>
  join(homedir(), 'Library', 'LaunchAgents', `${MIHOMO_LAUNCH_AGENT_LABEL}.plist`);

export const renderMihomoLaunchAgentPlist = ({
  binary,
  dataDir,
  configPath,
  autoStart,
}: {
  binary: string;
  dataDir: string;
  configPath: string;
  autoStart: boolean;
}) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MIHOMO_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(binary)}</string>
    <string>-d</string><string>${escapeXml(dataDir)}</string>
    <string>-f</string><string>${escapeXml(configPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(dataDir)}</string>
  <key>RunAtLoad</key>${autoStart ? '<true/>' : '<false/>'}
  <key>KeepAlive</key>${autoStart ? '<true/>' : '<false/>'}
  <key>StandardOutPath</key><string>${escapeXml(join(dataDir, 'logs', 'mihomo.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(dataDir, 'logs', 'mihomo-error.log'))}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;

const launchDomain = () => `gui/${process.getuid?.() ?? 0}`;

const launchctl = async (args: string[]) => {
  if (process.platform !== 'darwin') return { stdout: '', stderr: '' };
  return execFileAsync('/bin/launchctl', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
};

export type MihomoServiceStatus = {
  installed: boolean;
  loaded: boolean;
  pid?: number;
  controllerReady: boolean;
  runningVersion?: string;
  serviceMatchesConfig?: boolean;
};

export const matchesMihomoLaunchService = (output: string, config: CliConfig) => {
  const program = output.match(/^\s*program\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
  const args = output.match(/\barguments\s*=\s*\{([\s\S]*?)\}/)?.[1]
    ?.split('\n').map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean) ?? [];
  const dataIndex = args.indexOf('-d');
  const configIndex = args.indexOf('-f');
  return Boolean(program && resolve(program) === resolve(config.mihomo.binary)
    && dataIndex >= 0 && args[dataIndex + 1] === config.mihomo.dataDir
    && configIndex >= 0 && args[configIndex + 1] === join(config.mihomo.dataDir, 'config.yaml'));
};

export const getMihomoServiceStatus = async (config: CliConfig): Promise<MihomoServiceStatus> => {
  const launchAgentPath = defaultMihomoLaunchAgentPath();
  let loaded = false;
  let pid: number | undefined;
  let serviceMatchesConfig = false;
  if (process.platform === 'darwin') {
    try {
      const result = await launchctl(['print', `${launchDomain()}/${MIHOMO_LAUNCH_AGENT_LABEL}`]);
      loaded = true;
      const match = result.stdout.match(/\bpid\s*=\s*(\d+)/);
      pid = match ? Number(match[1]) : undefined;
      serviceMatchesConfig = matchesMihomoLaunchService(result.stdout, config);
    } catch {
      loaded = false;
    }
  }

  let controllerReady = false;
  let runningVersion: string | undefined;
  try {
    const response = await fetch(`http://${config.mihomo.controllerHost}:${config.mihomo.controllerPort}/version`, {
      headers: { Authorization: `Bearer ${config.mihomo.controllerSecret}` },
      signal: AbortSignal.timeout(1_500),
    });
    controllerReady = response.ok;
    if (response.ok) {
      const body = await response.json() as { version?: unknown };
      if (typeof body.version === 'string') runningVersion = normalizeMihomoVersion(body.version);
    }
  } catch {
    controllerReady = false;
  }

  return { installed: await pathExists(launchAgentPath), loaded, pid, controllerReady, runningVersion, serviceMatchesConfig };
};

export const waitForMihomoRuntime = async (config: CliConfig, version: string, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = await getMihomoServiceStatus(config);
    if (status.loaded && status.pid && status.serviceMatchesConfig && status.controllerReady && status.runningVersion === version) {
      try {
        // A matching version alone could belong to an unrelated controller on the same port.
        const owner = await execFileAsync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(status.pid),
          `-iTCP:${config.mihomo.controllerPort}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 2_000 });
        if (owner.stdout.split('\n').includes(`p${status.pid}`)) return;
      } catch {
        // Wait for the managed process to acquire its controller listener.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error('Mihomo 运行验证失败：服务归属、Controller 就绪状态或运行版本不匹配。');
};

export const installMihomoLaunchAgent = async (config: CliConfig) => {
  const launchAgentPath = defaultMihomoLaunchAgentPath();
  const configPath = join(config.mihomo.dataDir, 'config.yaml');
  await mkdir(join(config.mihomo.dataDir, 'logs'), { recursive: true, mode: 0o700 });
  await mkdir(dirname(launchAgentPath), { recursive: true });
  await writeTextFile(
    launchAgentPath,
    renderMihomoLaunchAgentPlist({
      binary: config.mihomo.binary,
      dataDir: config.mihomo.dataDir,
      configPath,
      autoStart: config.mihomo.autoStart,
    }),
  );
  await chmod(launchAgentPath, 0o600);
  if (process.platform === 'darwin') {
    await launchctl(['bootout', launchDomain(), launchAgentPath]).catch(() => undefined);
    await launchctl(['bootstrap', launchDomain(), launchAgentPath]);
    await launchctl(['enable', `${launchDomain()}/${MIHOMO_LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
    await launchctl(['kickstart', '-k', `${launchDomain()}/${MIHOMO_LAUNCH_AGENT_LABEL}`]);
  }
  return launchAgentPath;
};

export const stopMihomoLaunchAgent = async ({ uninstall = false }: { uninstall?: boolean } = {}) => {
  const launchAgentPath = defaultMihomoLaunchAgentPath();
  if (process.platform === 'darwin') {
    await launchctl(['bootout', launchDomain(), launchAgentPath]).catch(() => undefined);
  }
  if (uninstall) await rm(launchAgentPath, { force: true });
};

export const restartMihomoLaunchAgent = async (config: CliConfig) => installMihomoLaunchAgent(config);
