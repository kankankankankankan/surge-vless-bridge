/**
 * [INPUT]: Packaged macOS application and renderer asset contracts.
 * [OUTPUT]: Rejects missing resources, stale build content and ASAR integrity mismatches.
 * [POS]: Packaging verification; complements the renderer interaction smoke.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';

const appPath = process.argv[2];
if (!appPath) {
  throw new Error('Usage: npm run desktop:verify -- "/path/to/Surge VLESS Bridge.app"');
}

const resolvedAppPath = resolve(appPath);
const resourcesPath = join(resolvedAppPath, 'Contents', 'Resources');
const asar = createRequire(import.meta.url)('@electron/asar');
const archivePath = join(resourcesPath, 'app.asar');
const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const packagedMetadata = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'));
if (packagedMetadata.version !== packageJson.version) throw new Error('Packaged application version differs from package.json.');

const verifyTree = async (source, packagedPrefix, archive = false) => {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const packagedPath = `${packagedPrefix}/${entry.name}`;
    if (entry.isDirectory()) await verifyTree(sourcePath, packagedPath, archive);
    else if (entry.isFile()) {
      const expected = await readFile(sourcePath);
      const actual = archive ? asar.extractFile(archivePath, packagedPath) : await readFile(join(resourcesPath, packagedPath));
      if (!expected.equals(actual)) throw new Error(`Packaged content differs from current build: ${packagedPath}`);
      if (archive) {
        const metadata = asar.statFile(archivePath, packagedPath);
        const digest = createHash('sha256').update(actual).digest('hex');
        if (metadata.size !== actual.length || metadata.integrity?.algorithm !== 'SHA256' || metadata.integrity.hash !== digest) {
          throw new Error(`ASAR integrity differs from packaged content: ${packagedPath}`);
        }
      }
    }
  }
};
await verifyTree(resolve('dist'), 'dist', true);
await verifyTree(resolve('dist/desktop/renderer'), 'renderer');
const requiredFiles = [
  ['renderer/index.html', 'id="view-overview"'],
  ['renderer/styles.css', '.app-shell'],
  ['renderer/app.js', 'window.surgeBridge'],
  ['renderer/boot.js', '读取配置超时，请重试'],
  ['renderer/theme.js', 'surge-vless-bridge.appearance'],
  ['renderer/theme.css', 'data-theme="dark"'],
  ['renderer/vendor/lucide.js', 'lucide'],
  ['app.asar.unpacked/dist/native/proxy.js', 'parseNativeProxy'],
  ['app.asar.unpacked/dist/native/clash.js', 'clashNativeProxyToLink'],
  ['app.asar.unpacked/dist/native/anytls-sni.js', 'applyAnyTlsSniOverride'],
  ['app.asar.unpacked/dist/native/tls.js', 'normalizeCertificateFingerprint'],
  ['app.asar.unpacked/dist/native/parameters.js', 'nativePolicyParameters'],
  ['app.asar.unpacked/dist/native/xhttp.js', 'nativeXhttpParameters'],
  ['app.asar.unpacked/dist/desktop/native-probe.js', 'test-policy-udp'],
];

for (const [relativePath, marker] of requiredFiles) {
  const filePath = join(resourcesPath, relativePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new Error(`Invalid packaged renderer file: ${filePath}`);
  }
  const contents = await readFile(filePath, 'utf8');
  if (!contents.includes(marker)) {
    throw new Error(`Missing marker ${marker} in ${filePath}`);
  }
}

for (const name of ['sing-box.svg', 'surge.png', 'mihomo.jpeg']) {
  const icon = await stat(join(resourcesPath, 'renderer', 'assets', 'engines', name));
  if (!icon.isFile() || icon.size === 0) throw new Error(`Missing engine artwork: ${name}`);
}

console.log(`Packaged GUI resources verified: ${basename(resolvedAppPath)}`);
