import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CliConfig } from '../types/cli-config';
import { parseVlessNode } from './parse-vless-node';

export type SubscriptionStatus = {
  checkedAt: string;
  lastSuccessAt?: string;
  state: 'fresh' | 'cached' | 'failed';
  count: number;
  detail?: string;
  sourceCount?: number;
  filteredCount?: number;
  skippedCount?: number;
  skippedReasons?: string[];
};
type CacheEntry = SubscriptionStatus & { version: 1; nodes: string[] };
const directory = (config: CliConfig) => join(config.outputDir, '.subscription-cache');
const key = (config: CliConfig, url: string) => createHash('sha256')
  .update(JSON.stringify([url, Object.entries(config.requestHeaders).sort(([a], [b]) => a.localeCompare(b))]))
  .digest('hex');
const file = (config: CliConfig, url: string) => join(directory(config), `${key(config, url)}.json`);

export const readSubscriptionCache = async (config: CliConfig, url: string): Promise<CacheEntry | undefined> => {
  try {
    const entry = JSON.parse(await readFile(file(config, url), 'utf8')) as CacheEntry;
    if (entry.version !== 1 || !Array.isArray(entry.nodes) || !entry.nodes.every(node => typeof node === 'string') ||
        !['fresh', 'cached', 'failed'].includes(entry.state) || !Number.isFinite(Date.parse(entry.checkedAt)) ||
        (entry.lastSuccessAt !== undefined && !Number.isFinite(Date.parse(entry.lastSuccessAt)))) return;
    entry.nodes.forEach((node, index) => parseVlessNode(node, index));
    return entry;
  } catch { return; }
};

export const writeSubscriptionCache = async (config: CliConfig, url: string, entry: CacheEntry) => {
  const dir = directory(config);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file(config, url));
  } finally { await rm(temporary, { force: true }); }
};

export const pruneSubscriptionCache = async (config: CliConfig, urls: string[]) => {
  const retained = new Set(urls.map(url => `${key(config, url)}.json`));
  const files = await readdir(directory(config)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw new Error('无法读取订阅缓存目录。');
  });
  await Promise.all(files.filter(name => /^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name))
    .map(name => rm(join(directory(config), name), { force: true })));
};

export const readSubscriptionStatuses = async (config: CliConfig, urls: string[]) => Promise.all(urls.map(async url => {
  const entry = await readSubscriptionCache(config, url);
  if (!entry) return undefined;
  const { nodes: _nodes, version: _version, ...status } = entry;
  return status;
}));
