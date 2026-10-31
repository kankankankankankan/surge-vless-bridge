import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveWriteTarget } from './fs';

const execFileAsync = promisify(execFile);

export const findSurgeCli = async ({
  applicationDirs = ['/Applications', join(homedir(), 'Applications')],
  pathEnv = process.env.PATH ?? '',
}: { applicationDirs?: string[]; pathEnv?: string } = {}): Promise<string | undefined> => {
  const candidates = [
    ...applicationDirs.map((directory) => join(directory, 'Surge.app', 'Contents', 'Applications', 'surge-cli')),
    ...pathEnv.split(delimiter).filter(Boolean).map((directory) => resolve(directory, 'surge-cli')),
  ];
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Keep searching when an installation was moved or a PATH entry is unavailable.
    }
  }
  return undefined;
};

export const validateSurgeProfile = async (
  surgeText: string,
  profilePath: string,
  { cliPath }: { cliPath?: string | null } = {},
): Promise<{ checked: boolean; warning?: string }> => {
  const binary = cliPath === undefined ? await findSurgeCli() : cliPath;
  if (!binary) {
    const warning = '未找到 surge-cli，未执行 Surge 原生配置校验；请安装 Surge 后再次预览。';
    console.warn(warning);
    return { checked: false, warning };
  }
  const target = await resolveWriteTarget(profilePath);
  // Relative resources must resolve beside the real profile, including symlinked profiles.
  const candidate = join(dirname(target), `.surge-vless-check-${randomUUID()}.conf`);
  await writeFile(candidate, surgeText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await execFileAsync(binary, ['--check', candidate], {
      cwd: dirname(target), timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    return { checked: true };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; killed?: boolean };
    // Native diagnostics include entire proxy lines and credentials. Retain only a line number.
    const output = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`;
    const line = output.match(/(?:at #|\bline\s+|第\s*)(\d+)/i)?.[1];
    if (failure.killed) throw new Error('Surge 原生配置校验超时，已取消更新。');
    throw new Error(`Surge 原生配置校验未通过${line ? `（第 ${line} 行）` : ''}，已取消更新。请在 Surge 中检查配置语法与策略组引用。`);
  } finally {
    await rm(candidate, { force: true });
  }
};
