import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const worker = await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['hash-worker.js'], bundle: true, write: false,
  platform: 'browser', format: 'iife', target: 'es2022', minify: true, legalComments: 'inline' });
const app = await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['app.js'], bundle: true, write: false,
  platform: 'browser', format: 'iife', target: 'es2022', minify: true, legalComments: 'inline',
  define: { __WEIDU_WORKER__: JSON.stringify(worker.outputFiles[0].text) } });
const css = await readFile(new URL('styles.css', root), 'utf8');
const template = await readFile(new URL('index.template.html', root), 'utf8');
const script = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace('/*__CSS__*/', css).replace('/*__APP__*/', script);
if ((html.match(/<\/script/gi) || []).length !== 1) throw new Error('Unexpected closing script tag in the bundled page.');
if (html.includes('/*__APP__*/') || html.includes('__WEIDU_WORKER__')) throw new Error('Unfinished build substitution.');
await mkdir(new URL('dist/', root), { recursive: true });
await mkdir(new URL('verification/', root), { recursive: true });
await writeFile(new URL('dist/index.html', root), html);
await writeFile(new URL('dist/weidu-drive-helper-v0.1.0.html', root), html);
await copyFile(new URL('node_modules/@noble/hashes/LICENSE', root), new URL('dist/NOBLE-HASHES-LICENSE.txt', root));
await writeFile(new URL('verification/build.json', root), JSON.stringify({ version: '0.1.0',
  created: new Date().toISOString(), htmlBytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'),
  bundled: true, runtimeNetworkDependencies: [], contentSecurityPolicy: "connect-src 'none'" }, null, 2));
console.log(JSON.stringify({ htmlBytes: Buffer.byteLength(html), dist: new URL('dist/index.html', root).pathname }));
