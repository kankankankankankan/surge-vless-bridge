import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const source = join(process.cwd(), 'desktop');
const destination = join(process.cwd(), 'dist', 'desktop', 'renderer');

await mkdir(join(destination, 'vendor'), { recursive: true });
await Promise.all([
  cp(join(source, 'index.html'), join(destination, 'index.html')),
  cp(join(source, 'styles.css'), join(destination, 'styles.css')),
  cp(join(source, 'app.js'), join(destination, 'app.js')),
  cp(join(process.cwd(), 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js'), join(destination, 'vendor', 'lucide.js')),
]);
