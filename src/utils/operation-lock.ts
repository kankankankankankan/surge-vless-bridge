/**
 * [INPUT]: 文件系统目录、进程存活探测和唯一所有者标记。
 * [OUTPUT]: withDirectoryLock 和 withBridgeOperation 互斥入口。
 * [POS]: 同步与订阅缓存共用的跨进程锁，自动恢复已退出进程的锁。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CliConfig } from '../types/cli-config';

const busy = () => new Error('已有同步、诊断或更新任务正在运行，请稍后重试。');
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const isDead = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return code(error) === 'ESRCH'; }
  return false;
};

const removeEmptyDirectory = async (path: string) => {
  try { await rmdir(path); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error;
  }
};

const recoverDeadOwners = async (path: string) => {
  let entries: string[];
  try { entries = await readdir(path); } catch (error) {
    if (code(error) === 'ENOENT') return;
    throw error;
  }
  // An empty directory can belong to an owner that has not written its marker yet.
  if (!entries.length) throw busy();
  for (const entry of entries) {
    if (entry !== 'pid' && !/^owner-[a-f0-9-]+$/.test(entry)) throw busy();
    let marker = join(path, entry);
    let pid = Number(await readFile(marker, 'utf8').catch(() => ''));
    if (!isDead(pid)) throw busy();
    if (entry === 'pid') {
      // Rename the legacy record before deleting it. Recheck the moved PID because
      // another contender could have replaced the directory since our first read.
      const migrated = join(path, `owner-${randomUUID()}`);
      try { await rename(marker, migrated); } catch (error) {
        if (code(error) === 'ENOENT') continue;
        // APFS can reject rename when another contender removes its parent.
        if (code(error) === 'EINVAL') throw busy();
        throw error;
      }
      marker = migrated;
      pid = Number(await readFile(marker, 'utf8').catch(() => ''));
      if (!isDead(pid)) throw busy();
    }
    // Unique names prevent a delayed contender from unlinking a new owner's record.
    await unlink(marker).catch(error => { if (code(error) !== 'ENOENT') throw error; });
  }
  await removeEmptyDirectory(path);
};

export const withDirectoryLock = async <T>(path: string, run: () => Promise<T>): Promise<T> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await mkdir(path, { mode: 0o700 }); acquired = true; break; } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      await recoverDeadOwners(path);
    }
  }
  if (!acquired) throw busy();
  const name = `owner-${randomUUID()}`;
  const marker = join(path, name);
  let entered = false;
  try {
    await writeFile(marker, String(process.pid), { mode: 0o600, flag: 'wx' });
    const entries = await readdir(path);
    if (entries.length !== 1 || entries[0] !== name) throw busy();
    entered = true;
    return await run();
  } catch (error) {
    // APFS also returns EINVAL when a contender removes the empty parent during open.
    if (!entered && ['ENOENT', 'EINVAL'].includes(code(error) ?? '')) throw busy();
    throw error;
  } finally {
    await unlink(marker).catch(error => { if (code(error) !== 'ENOENT') throw error; });
    await removeEmptyDirectory(path);
  }
};

export const withBridgeOperation = <T>(config: CliConfig, run: () => Promise<T>) =>
  withDirectoryLock(join(config.outputDir, '.bridge-operation.lock'), run);
