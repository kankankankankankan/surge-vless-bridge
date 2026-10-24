import { spawn } from 'node:child_process';

export type InstallTarget = 'sing-box' | 'mihomo';
export type InstallMethod = 'direct' | 'homebrew';
export type InstallPhase =
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'
  | 'validating'
  | 'complete'
  | 'failed';

export type InstallProgressEvent = {
  target: InstallTarget;
  method: InstallMethod;
  phase: InstallPhase;
  message: string;
  detail?: string;
  percent?: number;
  indeterminate?: boolean;
  receivedBytes?: number;
  totalBytes?: number;
};

export type InstallProgressReporter = (event: InstallProgressEvent) => void;

export const downloadResponseBuffer = async ({
  response,
  expectedSize,
  onProgress,
}: {
  response: Response;
  expectedSize: number;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}) => {
  const totalBytes = Number(response.headers.get('content-length')) || expectedSize;
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    onProgress?.(bytes.length, totalBytes || bytes.length);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    receivedBytes += chunk.length;
    onProgress?.(receivedBytes, totalBytes || expectedSize || receivedBytes);
  }
  return Buffer.concat(chunks);
};

export const runStreamingCommand = async ({
  file,
  args,
  env,
  timeout,
  onLine,
}: {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeout: number;
  onLine?: (line: string) => void;
}) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pendingStdout = '';
    let pendingStderr = '';

    const emitLines = (value: string, stream: 'stdout' | 'stderr') => {
      const combined = `${stream === 'stdout' ? pendingStdout : pendingStderr}${value}`;
      const lines = combined.split(/\r?\n/);
      const pending = lines.pop() ?? '';
      if (stream === 'stdout') pendingStdout = pending;
      else pendingStderr = pending;
      lines.map((line) => line.trim()).filter(Boolean).forEach((line) => onLine?.(line));
    };

    child.stdout.on('data', (chunk) => {
      const value = String(chunk);
      stdout += value;
      emitLines(value, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      const value = String(chunk);
      stderr += value;
      emitLines(value, 'stderr');
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`命令执行超过 ${Math.round(timeout / 60_000)} 分钟。`));
    }, timeout);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (pendingStdout.trim()) onLine?.(pendingStdout.trim());
      if (pendingStderr.trim()) onLine?.(pendingStderr.trim());
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `命令退出：${code ?? signal ?? '未知状态'}`));
    });
  });
