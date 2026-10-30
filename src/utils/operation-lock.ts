import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CliConfig } from '../types/cli-config';

export const withDirectoryLock = async <T>(path: string, run: () => Promise<T>): Promise<T> => {
  await mkdir(dirname(path), { recursive: true });
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Identify crashed owners without displacing live or incomplete locks.
    const owner = Number(await readFile(join(path, 'pid'), 'utf8').catch(() => ''));
    let abandoned = false;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); } catch (probeError) { abandoned = (probeError as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
    // Leave stale locks intact to avoid two contenders removing a newly acquired lock.
    throw new Error(abandoned
      ? `上次任务异常退出，请确认没有同步或更新运行后删除锁目录：${path}`
      : '已有同步、诊断或更新任务正在运行，请稍后重试。');
  }
  try {
    await writeFile(join(path, 'pid'), String(process.pid), { mode: 0o600 });
    return await run();
  } finally { await rm(path, { recursive: true, force: true }); }
};

export const withBridgeOperation = <T>(config: CliConfig, run: () => Promise<T>) =>
  withDirectoryLock(join(config.outputDir, '.bridge-operation.lock'), run);
