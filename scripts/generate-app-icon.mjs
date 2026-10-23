import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { icons } = require('lucide');
const execFileAsync = promisify(execFile);
const outputDir = join(process.cwd(), 'desktop', 'assets');
const iconsetDir = join(outputDir, 'AppIcon.iconset');
const pngPath = join(outputDir, 'AppIcon.png');
const icnsPath = join(outputDir, 'AppIcon.icns');

const attributes = (value) =>
  Object.entries(value)
    .map(([key, item]) => `${key}="${String(item)}"`)
    .join(' ');
const iconBody = icons.Cable.map(([tag, value]) => `<${tag} ${attributes(value)} />`).join('');
const svg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="96" y="96" width="832" height="832" rx="190" fill="#3f4549" />
  <rect x="112" y="112" width="800" height="800" rx="176" fill="none" stroke="#626a70" stroke-width="12" />
  <circle cx="512" cy="512" r="116" fill="#2d3337" stroke="#7b858b" stroke-width="10" />
  <g transform="translate(212 212) scale(25)" fill="none" stroke="#ffffff" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">
    ${iconBody}
  </g>
</svg>
`);

await mkdir(iconsetDir, { recursive: true });
await sharp(svg).png().toFile(pngPath);

const sizes = [16, 32, 128, 256, 512];
for (const size of sizes) {
  await sharp(svg).resize(size, size).png().toFile(join(iconsetDir, `icon_${size}x${size}.png`));
  await sharp(svg).resize(size * 2, size * 2).png().toFile(join(iconsetDir, `icon_${size}x${size}@2x.png`));
}

await rm(icnsPath, { force: true });
await execFileAsync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath]);
await rm(iconsetDir, { recursive: true, force: true });
