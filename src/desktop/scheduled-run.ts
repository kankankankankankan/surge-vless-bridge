#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { loadCliConfig } from '../configuration';
import { syncSubscriptionToSurge } from '../surge';
import { recordActivity } from './storage';

const execFileAsync = promisify(execFile);

const getConfigPath = () => {
  const index = process.argv.indexOf('--config');
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const notifyFailure = async (message: string) => {
  if (process.platform !== 'darwin') {
    return;
  }

  const safeMessage = message.replace(/\s+/g, ' ').slice(0, 180);
  await execFileAsync('osascript', [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 1 of argv) with title "Surge VLESS Bridge" subtitle "定时同步失败"',
    '-e',
    'end run',
    safeMessage,
  ]).catch(() => undefined);
};

const main = async () => {
  const configPath = getConfigPath();
  if (!configPath) {
    throw new Error('Missing --config path.');
  }

  const loaded = await loadCliConfig({ cwd: process.cwd(), configPath });
  const historyPath = join(dirname(configPath), 'desktop', 'history.json');
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] Scheduled sync started.`);

  try {
    const result = await syncSubscriptionToSurge(loaded.config);
    const message = `定时同步已完成，共 ${result.count} 个节点。`;
    console.log(message);
    await recordActivity(historyPath, {
      action: 'scheduled-sync',
      success: true,
      message,
      output: message,
      count: result.count,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    await recordActivity(historyPath, {
      action: 'scheduled-sync',
      success: false,
      message,
      output: message,
    });
    await notifyFailure(message);
    process.exitCode = 1;
  }
};

void main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  await notifyFailure(message);
  process.exitCode = 1;
});
