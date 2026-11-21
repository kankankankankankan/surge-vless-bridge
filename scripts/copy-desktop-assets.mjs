/**
 * [INPUT]: Renderer source, theme palette and official engine artwork.
 * [OUTPUT]: Complete offline renderer under dist/desktop/renderer.
 * [POS]: Desktop build asset stage; package extraResources mirrors this inventory.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const source = join(process.cwd(), 'desktop');
const destination = join(process.cwd(), 'dist', 'desktop', 'renderer');

await mkdir(join(destination, 'vendor'), { recursive: true });
await Promise.all([
  cp(join(source, 'index.html'), join(destination, 'index.html')),
  cp(join(source, 'styles.css'), join(destination, 'styles.css')),
  cp(join(source, 'app.js'), join(destination, 'app.js')),
  cp(join(source, 'boot.js'), join(destination, 'boot.js')),
  cp(join(source, 'theme.js'), join(destination, 'theme.js')),
  cp(join(source, 'theme.css'), join(destination, 'theme.css')),
  cp(join(source, 'assets', 'engines'), join(destination, 'assets', 'engines'), { recursive: true }),
  cp(join(process.cwd(), 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js'), join(destination, 'vendor', 'lucide.js')),
]);
