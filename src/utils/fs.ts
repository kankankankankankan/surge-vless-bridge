import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

export const pathExists = async (path: string) => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const readTextFile = async (path: string) => readFile(path, 'utf8');

export const readJsonFile = async <T>(path: string) => JSON.parse(await readTextFile(path)) as T;

export const resolveWriteTarget = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling link must not be replaced by a regular file.
    const entry = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== 'ENOENT') throw failure;
      return undefined;
    });
    if (entry?.isSymbolicLink()) throw error;
    return resolve(path);
  }
};

const writeAtomicFile = async (path: string, value: string | Uint8Array) => {
  const target = await resolveWriteTarget(path);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (previous && !previous.isFile()) throw new Error('The write target must be a regular file.');
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(value);
    if (previous) await file.chmod(previous.mode & 0o777);
    await file.sync();
    await file.close();
    await rename(temporary, target);
  } finally {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
};

export const writeTextFile = async (path: string, value: string) => writeAtomicFile(path, value);

export const writeBinaryFile = async (path: string, value: Uint8Array) => writeAtomicFile(path, value);
