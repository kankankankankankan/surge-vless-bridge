import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeTextFile } from './fs';

export type PortIdentity = { name: string; server: string; serverPort: number; uuid: string; variant?: string };
export type PortEntry = { id: string; port: number };
type PortMap = { version: 1; portStart: number; entries: PortEntry[] };

export const stableNodeIdentity = (node: PortIdentity) => createHash('sha256')
  .update(JSON.stringify([node.name, node.server.toLowerCase(), node.serverPort, node.uuid]))
  .digest('hex');

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
};

export const stableNodeVariant = (node: object) => {
  // Runtime tuning and the generated display name do not identify the subscribed endpoint.
  const { tag, tcp_fast_open, connect_timeout, ...identity } = node as Record<string, unknown>;
  return createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
};

export const stablePortFile = (directory: string, mode: 'external' | 'mihomo') => join(directory, `.node-ports-${mode}.json`);

const portAvailable = (port: number) => new Promise<boolean>((resolve) => {
  const server = createServer();
  server.unref();
  server.once('error', () => resolve(false));
  server.once('listening', () => server.close(() => resolve(true)));
  server.listen(port, '127.0.0.1');
});

export const planStablePorts = async ({
  filePath, portStart, identities, previous = [], available = portAvailable,
}: {
  filePath: string;
  portStart: number;
  identities: string[];
  previous?: PortEntry[];
  available?: (port: number) => Promise<boolean>;
}) => {
  if (!Number.isInteger(portStart) || portStart < 1 || portStart > 65535) throw new Error('节点起始端口必须在 1 到 65535 之间。');
  if (new Set(identities).size !== identities.length) throw new Error('节点身份重复，无法安全分配端口。');
  let saved: PortMap | undefined;
  try {
    saved = JSON.parse(await readFile(filePath, 'utf8')) as PortMap;
    if (saved.version !== 1 || !Array.isArray(saved.entries) || !Number.isInteger(saved.portStart)
      || saved.entries.some(entry => !/^[a-f0-9]{64}$/.test(entry.id) || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535)
      || new Set(saved.entries.map(entry => entry.id)).size !== saved.entries.length
      || new Set(saved.entries.map(entry => entry.port)).size !== saved.entries.length) {
      throw new Error('Invalid map');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('节点端口记录无法读取，请恢复记录后重试。');
  }

  const prior = saved?.portStart === portStart ? saved.entries : saved ? [] : previous;
  const existing = new Map(prior.map(entry => [entry.id, entry.port]));
  const owned = new Set(previous.map(entry => entry.port));
  const used = new Set<number>();
  const ports = new Map<string, number>();
  for (const id of identities) {
    const port = existing.get(id);
    if (port !== undefined && port >= portStart && port <= 65535 && !used.has(port)) {
      if (!owned.has(port) && !(await available(port))) throw new Error(`已记录的节点端口 ${port} 被其他程序占用，请先检查占用程序。`);
      ports.set(id, port);
      used.add(port);
    }
  }
  let cursor = portStart;
  for (const id of identities) {
    if (ports.has(id)) continue;
    // Existing managed listeners are reusable; never stop an unrelated process to claim a new port.
    while (cursor <= 65535 && (used.has(cursor) || (!owned.has(cursor) && !(await available(cursor))))) cursor++;
    if (cursor > 65535) throw new Error('可用节点端口不足，请调整起始端口或减少节点数量。');
    ports.set(id, cursor);
    used.add(cursor++);
  }
  const entries = identities.map(id => ({ id, port: ports.get(id)! }));
  const document: PortMap = { version: 1, portStart, entries: [...entries].sort((left, right) => left.port - right.port) };
  return {
    ports: entries.map(entry => entry.port),
    commit: async () => {
      const value = `${JSON.stringify(document, null, 2)}\n`;
      if (await readFile(filePath, 'utf8').catch(() => '') !== value) await writeTextFile(filePath, value);
    },
  };
};
