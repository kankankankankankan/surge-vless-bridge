import { execFile } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { pathExists, readJsonFile, writeTextFile } from '../utils/fs';
import type { ScheduleSettings } from './types';

const execFileAsync = promisify(execFile);

export const LAUNCH_AGENT_LABEL = 'com.chen86860.surge-vless-bridge.sync';

export const DEFAULT_SCHEDULE: ScheduleSettings = {
  enabled: false,
  kind: 'interval',
  intervalHours: 12,
  hour: 8,
  minute: 0,
  runAtLoad: false,
};

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const validateSchedule = (input: ScheduleSettings): ScheduleSettings => {
  if (!Number.isInteger(input.intervalHours) || input.intervalHours < 1 || input.intervalHours > 168) {
    throw new Error('定时间隔必须是 1 到 168 之间的整数小时。');
  }

  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) {
    throw new Error('定时小时必须在 0 到 23 之间。');
  }

  if (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) {
    throw new Error('定时分钟必须在 0 到 59 之间。');
  }

  return {
    enabled: Boolean(input.enabled),
    kind: input.kind === 'daily' ? 'daily' : 'interval',
    intervalHours: input.intervalHours,
    hour: input.hour,
    minute: input.minute,
    runAtLoad: Boolean(input.runAtLoad),
  };
};

export const renderLaunchAgentPlist = ({
  schedule,
  executablePath,
  scheduledEntryPath,
  configPath,
  logPath,
}: {
  schedule: ScheduleSettings;
  executablePath: string;
  scheduledEntryPath: string;
  configPath: string;
  logPath: string;
}) => {
  const normalized = validateSchedule(schedule);
  const trigger =
    normalized.kind === 'daily'
      ? `<key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key><integer>${normalized.hour}</integer>\n    <key>Minute</key><integer>${normalized.minute}</integer>\n  </dict>`
      : `<key>StartInterval</key>\n  <integer>${normalized.intervalHours * 60 * 60}</integer>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executablePath)}</string>
    <string>${escapeXml(scheduledEntryPath)}</string>
    <string>--config</string>
    <string>${escapeXml(configPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  ${trigger}
  <key>RunAtLoad</key>
  <${normalized.runAtLoad ? 'true' : 'false'}/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
};

export class LaunchAgentScheduler {
  constructor(
    private readonly paths: {
      metadataPath: string;
      launchAgentPath: string;
      logPath: string;
      configPath: string;
      executablePath: string;
      scheduledEntryPath: string;
    },
  ) {}

  async getSettings(): Promise<ScheduleSettings> {
    if (!(await pathExists(this.paths.metadataPath))) {
      return { ...DEFAULT_SCHEDULE };
    }

    try {
      return validateSchedule(await readJsonFile<ScheduleSettings>(this.paths.metadataPath));
    } catch {
      return { ...DEFAULT_SCHEDULE };
    }
  }

  async save(input: ScheduleSettings) {
    if (process.platform !== 'darwin') {
      throw new Error('定时任务只能在 macOS 上注册。');
    }

    const schedule = validateSchedule(input);
    if (!schedule.enabled) {
      return this.disable();
    }
    if (this.paths.executablePath.startsWith('/Volumes/')) {
      throw new Error('请先将应用拖到「应用程序」文件夹，再启用定时任务。');
    }

    await mkdir(dirname(this.paths.launchAgentPath), { recursive: true });
    await mkdir(dirname(this.paths.logPath), { recursive: true });
    if (!(await pathExists(this.paths.executablePath))) {
      throw new Error(`应用可执行文件不存在：${this.paths.executablePath}`);
    }
    if (!(await pathExists(this.paths.scheduledEntryPath))) {
      throw new Error(`定时同步入口不存在：${this.paths.scheduledEntryPath}`);
    }

    const temporaryPath = `${this.paths.launchAgentPath}.tmp`;
    await writeTextFile(
      temporaryPath,
      renderLaunchAgentPlist({
        schedule,
        executablePath: this.paths.executablePath,
        scheduledEntryPath: this.paths.scheduledEntryPath,
        configPath: this.paths.configPath,
        logPath: this.paths.logPath,
      }),
    );
    await rename(temporaryPath, this.paths.launchAgentPath);

    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFileAsync('launchctl', ['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
    try {
      await execFileAsync('launchctl', ['bootstrap', domain, this.paths.launchAgentPath]);
      await execFileAsync('launchctl', ['enable', `${domain}/${LAUNCH_AGENT_LABEL}`]);
      await writeTextFile(this.paths.metadataPath, `${JSON.stringify(schedule, null, 2)}\n`);
    } catch (error) {
      await rm(this.paths.launchAgentPath, { force: true });
      throw error;
    }
    return schedule;
  }

  async disable() {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    if (process.platform === 'darwin') {
      await execFileAsync('launchctl', ['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
    }

    await rm(this.paths.launchAgentPath, { force: true });
    await rm(this.paths.metadataPath, { force: true });
    return { ...DEFAULT_SCHEDULE };
  }
}
