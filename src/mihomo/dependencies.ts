import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { compareVersions, findHomebrew } from '../desktop/dependencies';
import {
  downloadResponseBuffer,
  runStreamingCommand,
  type InstallProgressReporter,
} from '../install-progress';
import { pathExists } from '../utils/fs';

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const RELEASE_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

const commandEnvironment = () => ({
  ...process.env,
  PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH].filter(Boolean).join(':'),
});

export type MihomoReleaseAsset = {
  name: string;
  browser_download_url: string;
  digest?: string;
  size: number;
};

export type MihomoRelease = { tag_name: string; prerelease?: boolean; assets: MihomoReleaseAsset[] };
export type MihomoInstallSource = 'managed' | 'homebrew' | 'custom' | 'missing';
export type MihomoVersionStatus = {
  path: string;
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  source: MihomoInstallSource;
  updateAvailable?: boolean;
  rollbackAvailable: boolean;
};

export const selectMihomoAsset = (release: MihomoRelease, architecture: NodeJS.Architecture) => {
  const token = architecture === 'x64' ? 'darwin-amd64-compatible' : architecture === 'arm64' ? 'darwin-arm64' : '';
  if (!token) throw new Error(`当前处理器架构暂不支持直接安装：${architecture}`);
  const asset = release.assets.find(
    (item) => item.name.includes(token) && item.name.endsWith('.gz') && !/alpha|debug|go\d+/i.test(item.name),
  );
  if (!asset) throw new Error(`官方发布中没有找到 ${token} 稳定构建。`);
  if (!asset.digest?.startsWith('sha256:')) throw new Error('官方发布包缺少 SHA-256 摘要，已停止安装。');
  return asset;
};

export const normalizeMihomoVersion = (value: string) =>
  value.match(/(?:mihomo\s+meta\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)?.[1];

const getLatestRelease = async () => {
  const response = await fetch(RELEASE_API, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'surge-vless-bridge',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`读取 Mihomo 官方版本失败：HTTP ${response.status}`);
  const release = (await response.json()) as MihomoRelease;
  if (release.prerelease) throw new Error('Mihomo 最新发布为预览版，已停止自动安装。');
  return release;
};

export const readMihomoVersion = async (binaryPath: string) => {
  const result = await execFileAsync(binaryPath, ['-v'], { encoding: 'utf8', timeout: 15_000 });
  const version = normalizeMihomoVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) throw new Error('无法识别 Mihomo 版本。');
  return version;
};

const readVersion = readMihomoVersion;

const sourceFor = ({ binaryPath, managedPath, brewPath }: { binaryPath: string; managedPath: string; brewPath?: string }) => {
  if (!binaryPath) return 'missing' as const;
  const normalized = resolve(binaryPath);
  if (normalized === resolve(managedPath)) return 'managed' as const;
  if (brewPath && normalized.startsWith(`${resolve(dirname(dirname(brewPath)))}/`)) return 'homebrew' as const;
  return 'custom' as const;
};

export const inspectMihomoVersion = async ({
  binaryPath,
  managedPath,
  brewPath,
  includeLatest = false,
}: {
  binaryPath: string;
  managedPath: string;
  brewPath?: string;
  includeLatest?: boolean;
}): Promise<MihomoVersionStatus> => {
  const installed = Boolean(binaryPath && (await pathExists(binaryPath)));
  const currentVersion = installed ? await readVersion(binaryPath).catch(() => undefined) : undefined;
  const latestVersion = includeLatest ? normalizeMihomoVersion((await getLatestRelease()).tag_name) : undefined;
  return {
    path: binaryPath,
    installed,
    currentVersion,
    latestVersion,
    source: installed ? sourceFor({ binaryPath, managedPath, brewPath }) : 'missing',
    updateAvailable: currentVersion && latestVersion ? compareVersions(currentVersion, latestVersion) < 0 : undefined,
    rollbackAvailable: await pathExists(`${managedPath}.previous`),
  };
};

export const installOfficialMihomo = async (
  installDir: string,
  reportProgress?: InstallProgressReporter,
  validateCandidate?: (path: string) => Promise<void>,
) => {
  reportProgress?.({
    target: 'mihomo',
    method: 'direct',
    phase: 'preparing',
    message: '正在读取官方稳定版',
    detail: 'MetaCubeX/mihomo',
    percent: 3,
  });
  const release = await getLatestRelease();
  const asset = selectMihomoAsset(release, process.arch);
  const response = await fetch(asset.browser_download_url, {
    headers: { 'user-agent': 'surge-vless-bridge' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`下载 Mihomo 失败：HTTP ${response.status}`);
  let lastPercent = -1;
  let lastUpdate = 0;
  const bytes = await downloadResponseBuffer({
    response,
    expectedSize: asset.size,
    onProgress: (receivedBytes, totalBytes) => {
      const percent = Math.min(62, 8 + Math.round((receivedBytes / Math.max(1, totalBytes)) * 54));
      const now = Date.now();
      if (percent === lastPercent && now - lastUpdate < 250) return;
      lastPercent = percent;
      lastUpdate = now;
      reportProgress?.({
        target: 'mihomo',
        method: 'direct',
        phase: 'downloading',
        message: '正在下载 Mihomo',
        detail: asset.name,
        percent,
        receivedBytes,
        totalBytes,
      });
    },
  });
  if (bytes.length !== asset.size) throw new Error('Mihomo 下载大小与官方发布信息不一致。');
  reportProgress?.({
    target: 'mihomo',
    method: 'direct',
    phase: 'verifying',
    message: '正在校验下载文件',
    detail: '核对文件大小与 SHA-256',
    percent: 68,
  });
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.digest!.slice('sha256:'.length)) throw new Error('Mihomo 发布包 SHA-256 校验失败。');

  await mkdir(installDir, { recursive: true, mode: 0o700 });
  const targetPath = join(installDir, 'mihomo');
  const nextPath = `${targetPath}.next`;
  const previousPath = `${targetPath}.previous`;
  await rm(nextPath, { force: true });
  reportProgress?.({
    target: 'mihomo',
    method: 'direct',
    phase: 'extracting',
    message: '正在解压 Mihomo',
    detail: asset.name,
    percent: 76,
  });
  try {
    await writeFile(nextPath, await gunzipAsync(bytes), { mode: 0o700 });
    await chmod(nextPath, 0o755);
    reportProgress?.({
      target: 'mihomo',
      method: 'direct',
      phase: 'validating',
      message: '正在验证新版本',
      detail: '读取 Mihomo 版本信息',
      percent: 90,
    });
    const version = await readVersion(nextPath);
    if (version !== normalizeMihomoVersion(release.tag_name)) throw new Error('Mihomo 文件版本与官方发布版本不一致。');
    await validateCandidate?.(nextPath);
    const previousVersion = (await pathExists(targetPath)) ? await readVersion(targetPath).catch(() => undefined) : undefined;
    if (await pathExists(targetPath)) await copyFile(targetPath, previousPath);
    reportProgress?.({
      target: 'mihomo',
      method: 'direct',
      phase: 'installing',
      message: '正在安装 Mihomo',
      detail: `目标位置：${targetPath}`,
      percent: 92,
    });
    await rename(nextPath, targetPath);
    return {
      path: targetPath,
      version,
      previousVersion,
      output: `来源：MetaCubeX/mihomo ${release.tag_name}\n文件：${asset.name}\nSHA-256：已验证\n安装位置：${targetPath}`,
    };
  } finally {
    await rm(nextPath, { force: true });
  }
};

export const installMihomoWithHomebrew = async (reportProgress?: InstallProgressReporter) => {
  reportProgress?.({
    target: 'mihomo',
    method: 'homebrew',
    phase: 'preparing',
    message: '正在检查 Homebrew',
    percent: 5,
  });
  const brewPath = await findHomebrew();
  if (!brewPath) throw new Error('没有找到 Homebrew。');
  let installed = false;
  try {
    await execFileAsync(brewPath, ['list', '--versions', 'mihomo'], { encoding: 'utf8', timeout: 30_000 });
    installed = true;
  } catch {
    installed = false;
  }
  reportProgress?.({
    target: 'mihomo',
    method: 'homebrew',
    phase: 'installing',
    message: installed ? '正在通过 Homebrew 更新 Mihomo' : '正在通过 Homebrew 安装 Mihomo',
    detail: '等待 Homebrew 返回安装步骤',
    percent: 18,
    indeterminate: true,
  });
  let latestDetail = '';
  const result = await runStreamingCommand({
    file: brewPath,
    args: [installed ? 'upgrade' : 'install', 'mihomo'],
    env: commandEnvironment(),
    timeout: INSTALL_TIMEOUT_MS,
    onLine: (line) => {
      latestDetail = line;
      const downloading = /download|fetch|bottle/i.test(line);
      const linking = /link|cleanup|caveat/i.test(line);
      reportProgress?.({
        target: 'mihomo',
        method: 'homebrew',
        phase: downloading ? 'downloading' : 'installing',
        message: downloading ? 'Homebrew 正在下载 Mihomo' : 'Homebrew 正在安装 Mihomo',
        detail: line,
        percent: linking ? 84 : downloading ? 42 : 68,
        indeterminate: true,
      });
    },
  });
  const prefix = (
    await execFileAsync(brewPath, ['--prefix'], { encoding: 'utf8', env: commandEnvironment() })
  ).stdout.trim();
  const binaryPath = join(prefix, 'bin', 'mihomo');
  if (!(await pathExists(binaryPath))) throw new Error(`Homebrew 已完成，但没有找到 ${binaryPath}。`);
  reportProgress?.({
    target: 'mihomo',
    method: 'homebrew',
    phase: 'validating',
    message: '正在验证 Homebrew 安装结果',
    detail: latestDetail || binaryPath,
    percent: 94,
  });
  return {
    path: binaryPath,
    version: await readVersion(binaryPath),
    output: [result.stdout.trim(), result.stderr.trim(), `安装位置：${binaryPath}`].filter(Boolean).join('\n'),
  };
};

export const rollbackOfficialMihomo = async (installDir: string) => {
  const targetPath = join(installDir, 'mihomo');
  const previousPath = `${targetPath}.previous`;
  if (!(await pathExists(targetPath)) || !(await pathExists(previousPath))) throw new Error('没有可回退的 Mihomo 版本。');
  const swapPath = `${targetPath}.swap`;
  await copyFile(targetPath, swapPath);
  await copyFile(previousPath, targetPath);
  await copyFile(swapPath, previousPath);
  await rm(swapPath, { force: true });
  await chmod(targetPath, 0o755);
  return { path: targetPath, version: await readVersion(targetPath), output: '已恢复上一版 Mihomo。' };
};
