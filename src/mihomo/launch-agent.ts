import { execFile } from 'node:child_process';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { CliConfig } from '../types/cli-config';
import { pathExists, writeTextFile } from '../utils/fs';

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
};

export const getMihomoServiceStatus = async (config: CliConfig): Promise<MihomoServiceStatus> => {
  const launchAgentPath = defaultMihomoLaunchAgentPath();
  let loaded = false;
  let pid: number | undefined;
  if (process.platform === 'darwin') {
    try {
      const result = await launchctl(['print', `${launchDomain()}/${MIHOMO_LAUNCH_AGENT_LABEL}`]);
      loaded = true;
      const match = result.stdout.match(/\bpid\s*=\s*(\d+)/);
      pid = match ? Number(match[1]) : undefined;
    } catch {
      loaded = false;
    }
  }

  let controllerReady = false;
  try {
    const response = await fetch(`http://${config.mihomo.controllerHost}:${config.mihomo.controllerPort}/version`, {
      headers: { Authorization: `Bearer ${config.mihomo.controllerSecret}` },
      signal: AbortSignal.timeout(1_500),
    });
    controllerReady = response.ok;
  } catch {
    controllerReady = false;
  }

  return { installed: await pathExists(launchAgentPath), loaded, pid, controllerReady };
};

export const installMihomoLaunchAgent = async (config: CliConfig) => {
  const launchAgentPath = defaultMihomoLaunchAgentPath();
  const configPath = join(config.mihomo.dataDir, 'config.yaml');
  await mkdir(join(config.mihomo.dataDir, 'logs'), { recursive: true });
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
