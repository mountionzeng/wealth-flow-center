import { rm, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { validatePublicCloudConfig } from '../src/buildConfig.js';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
const cloudConfig = validatePublicCloudConfig({
  url: process.env.BERICH_SUPABASE_URL,
  publishableKey: process.env.BERICH_SUPABASE_PUBLISHABLE_KEY,
});

if (cloudConfig.reason === '浏览器不能使用 Supabase 私密密钥') {
  throw new Error('BERICH_SUPABASE_PUBLISHABLE_KEY 只能使用 sb_publishable_*，不能写入私密密钥。');
}

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
  define: {
    __BERICH_SUPABASE_URL__: JSON.stringify(cloudConfig.enabled ? cloudConfig.url : ''),
    __BERICH_SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(cloudConfig.enabled ? cloudConfig.publishableKey : ''),
  },
});
