import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MANAGED_CONFIG_NAME = String.raw`sing-box\[\d+\]\.json`;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const POLL_INTERVAL_MS = 50;

export type ProcessEntry = {
  pid: number;
  command: string;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasCommandValue = (command: string, value: string) =>
  new RegExp(`(?:^|\\s|["'])${escapeRegExp(value)}(?:$|\\s|["'])`).test(command);

export const parseProcessList = (output: string): ProcessEntry[] =>
  output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) {
      return [];
    }

    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? [{ pid, command: match[2]! }] : [];
  });

export const findManagedSingBoxProcesses = ({
  output,
  singBoxBinary,
  outputDir,
  currentPid = process.pid,
}: {
  output: string;
  singBoxBinary: string;
  outputDir: string;
  currentPid?: number;
}) => {
  const binary = resolve(singBoxBinary);
  const configPrefix = `${escapeRegExp(resolve(outputDir))}/`;
  const configPattern = new RegExp(`(?:^|\\s|["'])${configPrefix}${MANAGED_CONFIG_NAME}(?:$|\\s|["'])`);

  return parseProcessList(output).filter(
    (entry) => entry.pid !== currentPid && hasCommandValue(entry.command, binary) && configPattern.test(entry.command),
  );
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
};

const waitForExit = async (pids: number[], timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = pids.filter(isRunning);
    if (running.length === 0) {
      return [];
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
  }
  return pids.filter(isRunning);
};

export const stopManagedSingBoxProcesses = async ({
  singBoxBinary,
  outputDir,
}: {
  singBoxBinary: string;
  outputDir: string;
}) => {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const managed = findManagedSingBoxProcesses({ output: stdout, singBoxBinary, outputDir });
  if (managed.length === 0) {
    return [];
  }

  for (const entry of managed) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
    }
  }

  const lingering = await waitForExit(
    managed.map((entry) => entry.pid),
    TERM_WAIT_MS,
  );
  for (const pid of lingering) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
    }
  }

  const stillRunning = await waitForExit(lingering, KILL_WAIT_MS);
  if (stillRunning.length > 0) {
    throw new Error(`Unable to stop managed sing-box processes: ${stillRunning.join(', ')}`);
  }

  return managed;
};
