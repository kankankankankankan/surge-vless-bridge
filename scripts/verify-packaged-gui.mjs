import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const appPath = process.argv[2];
if (!appPath) {
  throw new Error('Usage: npm run desktop:verify -- "/path/to/Surge VLESS Bridge.app"');
}

const resolvedAppPath = resolve(appPath);
const resourcesPath = join(resolvedAppPath, 'Contents', 'Resources');
const requiredFiles = [
  ['renderer/index.html', 'id="view-overview"'],
  ['renderer/styles.css', '.app-shell'],
  ['renderer/app.js', 'window.surgeBridge'],
  ['renderer/boot.js', '读取配置超时，请重试'],
  ['renderer/vendor/lucide.js', 'lucide'],
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

console.log(`Packaged GUI resources verified: ${basename(resolvedAppPath)}`);
