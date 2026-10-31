import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  downloadResponseBuffer,
  runStreamingCommand,
  type InstallProgressReporter,
} from '../install-progress';
import { pathExists } from '../utils/fs';

const execFileAsync = promisify(execFile);
const GITHUB_RELEASE_API = 'https://api.github.com/repos/SagerNet/sing-box/releases/latest';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest?: string;
  size: number;
};

type GithubRelease = {
  tag_name: string;
  assets: ReleaseAsset[];
};

export type SingBoxInstallSource = 'managed' | 'homebrew' | 'custom' | 'missing';

export type SingBoxVersionStatus = {
  path: string;
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  source: SingBoxInstallSource;
  updateAvailable?: boolean;
  rollbackAvailable: boolean;
};

export type SingBoxInstallResult = {
  path: string;
  version: string;
  output: string;
  previousVersion?: string;
};

const commandEnvironment = () => ({
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH].filter(Boolean).join(':'),
});

export const findHomebrew = async () => {
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (await pathExists(candidate)) return candidate;
  }

  try {
    const result = await execFileAsync('/usr/bin/which', ['brew'], {
      encoding: 'utf8',
      env: commandEnvironment(),
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

export const selectOfficialAsset = (release: GithubRelease, architecture: NodeJS.Architecture) => {
  const archiveArchitecture = architecture === 'x64' ? 'amd64' : architecture === 'arm64' ? 'arm64' : undefined;
  if (!archiveArchitecture) {
    throw new Error(`当前处理器架构暂不支持直接安装：${architecture}`);
  }

  const suffix = `darwin-${archiveArchitecture}.tar.gz`;
  const asset = release.assets.find((item) => item.name.endsWith(suffix) && !item.name.includes('legacy'));
  if (!asset) {
    throw new Error(`官方发布中没有找到 ${suffix}。`);
  }
  if (!asset.digest?.startsWith('sha256:')) {
    throw new Error('官方发布包缺少 SHA-256 摘要，已停止安装。');
  }
  return asset;
};

export const normalizeSingBoxVersion = (value: string) =>
  value.match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/i)?.[1];

export const compareVersions = (left: string, right: string) => {
  const parse = (value: string) => value.split(/[+-]/, 1)[0]!.split('.').map((part) => Number(part));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
};

export const getLatestRelease = async () => {
  const response = await fetch(GITHUB_RELEASE_API, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'surge-vless-bridge',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`读取 sing-box 官方版本失败：HTTP ${response.status}`);
  }
  return (await response.json()) as GithubRelease;
};

const downloadAsset = async (asset: ReleaseAsset, reportProgress?: InstallProgressReporter) => {
  const response = await fetch(asset.browser_download_url, {
    headers: { 'user-agent': 'surge-vless-bridge' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`下载 sing-box 失败：HTTP ${response.status}`);
  }

  let lastPercent = -1;
  let lastUpdate = 0;
  const bytes = await downloadResponseBuffer({
    response,
    expectedSize: asset.size,
    onProgress: (receivedBytes, totalBytes) => {
      const percent = Math.min(60, 8 + Math.round((receivedBytes / Math.max(1, totalBytes)) * 52));
      const now = Date.now();
      if (percent === lastPercent && now - lastUpdate < 250) return;
      lastPercent = percent;
      lastUpdate = now;
      reportProgress?.({
        target: 'sing-box',
        method: 'direct',
        phase: 'downloading',
        message: '正在下载 sing-box',
        detail: asset.name,
        percent,
        receivedBytes,
        totalBytes,
      });
    },
  });
  if (bytes.length !== asset.size) {
    throw new Error(`下载大小不一致，期望 ${asset.size} 字节，实际 ${bytes.length} 字节。`);
  }

  reportProgress?.({
    target: 'sing-box',
    method: 'direct',
    phase: 'verifying',
    message: '正在校验下载文件',
    detail: '核对文件大小与 SHA-256',
    percent: 64,
  });
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  const expectedDigest = asset.digest!.slice('sha256:'.length);
  if (actualDigest !== expectedDigest) {
    throw new Error('sing-box 发布包 SHA-256 校验失败。');
  }
  return bytes;
};

const readVersion = async (binaryPath: string) => {
  const result = await execFileAsync(binaryPath, ['version'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim().split(/\r?\n/)[0] || 'sing-box';
};

const readNormalizedVersion = async (binaryPath: string) => {
  const output = await readVersion(binaryPath);
  const version = normalizeSingBoxVersion(output);
  if (!version) throw new Error(`无法识别 sing-box 版本：${output}`);
  return version;
};

const managedConfigPaths = async (outputDir: string) => {
  try {
    return (await readdir(outputDir))
      .filter((name) => /^sing-box\[\d+\]\.json$/.test(name))
      .map((name) => join(outputDir, name));
  } catch {
    return [];
  }
};

const validateManagedConfigs = async (binaryPath: string, outputDir: string) => {
  for (const configPath of await managedConfigPaths(outputDir)) {
    try {
      await execFileAsync(binaryPath, ['check', '-c', configPath], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error);
      throw new Error(`新版 sing-box 无法读取 ${configPath}${stderr ? `：${stderr}` : ''}`);
    }
  }
};

const homebrewPrefix = (brewPath?: string) => (brewPath ? dirname(dirname(brewPath)) : undefined);

const detectInstallSource = ({
  binaryPath,
  managedPath,
  brewPath,
}: {
  binaryPath: string;
  managedPath: string;
  brewPath?: string;
}): SingBoxInstallSource => {
  if (!binaryPath) return 'missing';
  const normalizedBinary = resolve(binaryPath);
  if (normalizedBinary === resolve(managedPath)) return 'managed';
  const prefix = homebrewPrefix(brewPath);
  if (prefix && normalizedBinary.startsWith(`${resolve(prefix)}/`)) return 'homebrew';
  return 'custom';
};

export const inspectSingBoxVersion = async ({
  binaryPath,
  managedPath,
  brewPath,
  includeLatest = false,
}: {
  binaryPath: string;
  managedPath: string;
  brewPath?: string;
  includeLatest?: boolean;
}): Promise<SingBoxVersionStatus> => {
  const installed = Boolean(binaryPath && (await pathExists(binaryPath)));
  const source = installed ? detectInstallSource({ binaryPath, managedPath, brewPath }) : 'missing';
  const currentVersion = installed ? await readNormalizedVersion(binaryPath).catch(() => undefined) : undefined;
  const latestVersion = includeLatest ? normalizeSingBoxVersion((await getLatestRelease()).tag_name) : undefined;
  return {
    path: binaryPath,
    installed,
    currentVersion,
    latestVersion,
    source,
    updateAvailable:
      currentVersion && latestVersion ? compareVersions(currentVersion, latestVersion) < 0 : undefined,
    rollbackAvailable: source === 'managed' && (await pathExists(`${managedPath}.previous`)),
  };
};

export const installOfficialSingBox = async (
  installDir: string,
  outputDir: string,
  reportProgress?: InstallProgressReporter,
): Promise<SingBoxInstallResult> => {
  reportProgress?.({
    target: 'sing-box',
    method: 'direct',
    phase: 'preparing',
    message: '正在读取官方稳定版',
    detail: 'SagerNet/sing-box',
    percent: 3,
  });
  const release = await getLatestRelease();
  const asset = selectOfficialAsset(release, process.arch);
  const archiveBytes = await downloadAsset(asset, reportProgress);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'surge-vless-sing-box-'));

  try {
    const archivePath = join(temporaryRoot, asset.name);
    const extractedPath = join(temporaryRoot, 'extracted');
    await writeFile(archivePath, archiveBytes);
    await mkdir(extractedPath);
    reportProgress?.({
      target: 'sing-box',
      method: 'direct',
      phase: 'extracting',
      message: '正在解压官方发布包',
      detail: asset.name,
      percent: 72,
    });
    await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', extractedPath], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    const sourcePath = join(extractedPath, asset.name.replace(/\.tar\.gz$/, ''), 'sing-box');
    if (!(await pathExists(sourcePath))) {
      throw new Error('官方发布包中没有找到 sing-box 可执行文件。');
    }

    await mkdir(installDir, { recursive: true, mode: 0o700 });
    const targetPath = join(installDir, 'sing-box');
    const nextPath = join(installDir, 'sing-box.next');
    const previousPath = join(installDir, 'sing-box.previous');
    reportProgress?.({
      target: 'sing-box',
      method: 'direct',
      phase: 'installing',
      message: '正在安装 sing-box',
      detail: `目标位置：${targetPath}`,
      percent: 82,
    });
    await rm(nextPath, { force: true });
    await copyFile(sourcePath, nextPath);
    await chmod(nextPath, 0o755);
    const version = await readNormalizedVersion(nextPath);
    reportProgress?.({
      target: 'sing-box',
      method: 'direct',
      phase: 'validating',
      message: '正在验证新版本',
      detail: '检查现有节点配置兼容性',
      percent: 92,
    });
    await validateManagedConfigs(nextPath, outputDir);
    const previousVersion = (await pathExists(targetPath)) ? await readNormalizedVersion(targetPath).catch(() => undefined) : undefined;
    if ((await pathExists(targetPath)) && previousVersion !== version) {
      await copyFile(targetPath, previousPath);
      await chmod(previousPath, 0o755);
    }
    await rename(nextPath, targetPath);
    return {
      path: targetPath,
      version,
      previousVersion,
      output: `来源：SagerNet/sing-box ${release.tag_name}\n文件：${asset.name}\nSHA-256：已验证\n安装位置：${targetPath}`,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

export const installSingBoxWithHomebrew = async (
  reportProgress?: InstallProgressReporter,
): Promise<SingBoxInstallResult> => {
  reportProgress?.({
    target: 'sing-box',
    method: 'homebrew',
    phase: 'preparing',
    message: '正在检查 Homebrew',
    percent: 5,
  });
  const brewPath = await findHomebrew();
  if (!brewPath) {
    throw new Error('没有找到 Homebrew。可以选择“下载官方版”，或先安装 Homebrew。');
  }

  let installed = false;
  try {
    await execFileAsync(brewPath, ['list', '--versions', 'sing-box'], {
      encoding: 'utf8',
      env: commandEnvironment(),
      timeout: 30_000,
    });
    installed = true;
  } catch {
    installed = false;
  }

  reportProgress?.({
    target: 'sing-box',
    method: 'homebrew',
    phase: 'installing',
    message: installed ? '正在通过 Homebrew 更新 sing-box' : '正在通过 Homebrew 安装 sing-box',
    detail: '等待 Homebrew 返回安装步骤',
    percent: 18,
    indeterminate: true,
  });
  let latestDetail = '';
  const result = await runStreamingCommand({
    file: brewPath,
    args: [installed ? 'upgrade' : 'install', 'sing-box'],
    env: commandEnvironment(),
    timeout: INSTALL_TIMEOUT_MS,
    onLine: (line) => {
      latestDetail = line;
      const downloading = /download|fetch|bottle/i.test(line);
      const linking = /link|cleanup|caveat/i.test(line);
      reportProgress?.({
        target: 'sing-box',
        method: 'homebrew',
        phase: downloading ? 'downloading' : 'installing',
        message: downloading ? 'Homebrew 正在下载 sing-box' : 'Homebrew 正在安装 sing-box',
        detail: line,
        percent: linking ? 84 : downloading ? 42 : 68,
        indeterminate: true,
      });
    },
  });
  const prefix = (
    await execFileAsync(brewPath, ['--prefix'], {
      encoding: 'utf8',
      env: commandEnvironment(),
    })
  ).stdout.trim();
  const binaryPath = join(prefix, 'bin', 'sing-box');
  if (!(await pathExists(binaryPath))) {
    throw new Error(`Homebrew 已完成，但没有找到 ${binaryPath}。`);
  }

  reportProgress?.({
    target: 'sing-box',
    method: 'homebrew',
    phase: 'validating',
    message: '正在验证 Homebrew 安装结果',
    detail: latestDetail || binaryPath,
    percent: 94,
  });
  return {
    path: binaryPath,
    version: await readNormalizedVersion(binaryPath),
    output: [result.stdout.trim(), result.stderr.trim(), `安装位置：${binaryPath}`].filter(Boolean).join('\n'),
  };
};

export const rollbackOfficialSingBox = async (
  installDir: string,
  outputDir: string,
): Promise<SingBoxInstallResult> => {
  const targetPath = join(installDir, 'sing-box');
  const previousPath = join(installDir, 'sing-box.previous');
  const nextPath = join(installDir, 'sing-box.next');
  const previousNextPath = join(installDir, 'sing-box.previous.next');
  if (!(await pathExists(targetPath)) || !(await pathExists(previousPath))) {
    throw new Error('没有可回退的 sing-box 版本。');
  }

  await rm(nextPath, { force: true });
  await rm(previousNextPath, { force: true });
  await copyFile(previousPath, nextPath);
  await chmod(nextPath, 0o755);
  const version = await readNormalizedVersion(nextPath);
  await validateManagedConfigs(nextPath, outputDir);
  const previousVersion = await readNormalizedVersion(targetPath).catch(() => undefined);
  await copyFile(targetPath, previousNextPath);
  await chmod(previousNextPath, 0o755);
  await rename(nextPath, targetPath);
  await rename(previousNextPath, previousPath);

  return {
    path: targetPath,
    version,
    previousVersion,
    output: `已回退到 sing-box ${version}\n当前版本已保留为可回退版本。`,
  };
};
