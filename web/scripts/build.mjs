import { rm, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  copyFile(resolve(root, 'index.html'), resolve(output, 'index.html')),
  copyFile(resolve(root, 'styles.css'), resolve(output, 'styles.css')),
]);
await build({
  entryPoints: [resolve(root, 'src/App.jsx')],
  bundle: true,
  minify: true,
  outfile: resolve(output, 'app.js'),
  target: ['es2020'],
  legalComments: 'none',
});
