/**
 * [INPUT]: Runtime-specific source URLs, normalized proxy links and parser diagnostics.
 * [OUTPUT]: Private atomic snapshots, public source status and source-removal pruning.
 * [POS]: Cache boundary keeps native multi-protocol snapshots separate from VLESS backends.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CliConfig } from '../types/cli-config';
import { parseVlessNode } from './parse-vless-node';
import { parseNativeProxy } from '../native/proxy';

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
  notices?: string[];
};
type CacheEntry = SubscriptionStatus & { version: 1; nodes: string[] };
const directory = (config: CliConfig) => join(config.outputDir, '.subscription-cache');
const key = (config: CliConfig, url: string) => createHash('sha256')
  .update(JSON.stringify([url, Object.entries(config.requestHeaders).sort(([a], [b]) => a.localeCompare(b)),
    ...(config.runtimeMode === 'surge-native' ? ['native-multi-v1'] : [])]))
  .digest('hex');
const file = (config: CliConfig, url: string) => join(directory(config), `${key(config, url)}.json`);

export const readSubscriptionCache = async (config: CliConfig, url: string): Promise<CacheEntry | undefined> => {
  try {
    const text = await readFile(file(config, url), 'utf8').catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || config.runtimeMode !== 'surge-native') throw error;
      // Older native releases used the VLESS-only cache key. Reuse that snapshot
      // only until a native snapshot exists; an explicit empty result stays empty.
      return readFile(file({ ...config, runtimeMode: 'external' }, url), 'utf8');
    });
    const entry = JSON.parse(text) as CacheEntry;
    if (entry.version !== 1 || !Array.isArray(entry.nodes) || !entry.nodes.every(node => typeof node === 'string') ||
        !['fresh', 'cached', 'failed'].includes(entry.state) || !Number.isFinite(Date.parse(entry.checkedAt)) ||
        (entry.lastSuccessAt !== undefined && !Number.isFinite(Date.parse(entry.lastSuccessAt))) ||
        (entry.notices !== undefined && (!Array.isArray(entry.notices) || entry.notices.some(note => typeof note !== 'string')))) return;
    entry.nodes.forEach((node, index) => {
      if (config.runtimeMode === 'surge-native' && !/^vless:\/\//i.test(node)) parseNativeProxy(node, index);
      else {
        if (!/^vless:\/\//i.test(node)) throw new Error('Unexpected cached protocol');
        parseVlessNode(node, index);
      }
    });
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
  const retained = new Set(urls.flatMap(url => [
    `${key({ ...config, runtimeMode: 'external' }, url)}.json`,
    `${key({ ...config, runtimeMode: 'surge-native' }, url)}.json`,
  ]));
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
