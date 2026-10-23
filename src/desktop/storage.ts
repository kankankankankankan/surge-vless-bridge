import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';

import { pathExists, readJsonFile, writeTextFile } from '../utils/fs';
import type { ActivityEntry } from './types';

const MAX_HISTORY_ENTRIES = 100;

export const readHistory = async (historyPath: string): Promise<ActivityEntry[]> => {
  if (!(await pathExists(historyPath))) {
    return [];
  }

  try {
    const entries = await readJsonFile<ActivityEntry[]>(historyPath);
    return Array.isArray(entries) ? entries.slice(0, MAX_HISTORY_ENTRIES) : [];
  } catch {
    return [];
  }
};

export const recordActivity = async (
  historyPath: string,
  entry: Omit<ActivityEntry, 'id' | 'createdAt'> & { createdAt?: string },
) => {
  const history = await readHistory(historyPath);
  const next: ActivityEntry = {
    ...entry,
    id: randomUUID(),
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };

  await writeTextFile(historyPath, `${JSON.stringify([next, ...history].slice(0, MAX_HISTORY_ENTRIES), null, 2)}\n`);
  return next;
};

export const clearHistory = async (historyPath: string) => {
  const count = (await readHistory(historyPath)).length;
  await rm(historyPath, { force: true });
  return count;
};

export const readLogTail = async (logPath: string, maxBytes = 64 * 1024) => {
  try {
    const bytes = await readFile(logPath);
    return bytes
      .subarray(Math.max(0, bytes.length - maxBytes))
      .toString('utf8')
      .split('\n')
      .filter(
        (line) =>
          !(line.includes('electron/shell/common/mac/codesign_util.cc') && line.includes('task_name_for_pid')),
      )
      .join('\n');
  } catch {
    return '';
  }
};
