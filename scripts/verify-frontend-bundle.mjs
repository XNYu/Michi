import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const buildDir = resolve(process.argv[2] ?? join(process.cwd(), 'frontend', 'build'));
const indexPath = join(buildDir, 'index.html');
if (!existsSync(indexPath)) {
  throw new Error(`frontend build not found at ${indexPath}; run npm run frontend:build first`);
}

const html = readFileSync(indexPath, 'utf8');
const violations = [];
if (/rel="modulepreload"[^>]+href="[^"]*(?:math|katex)[^"/]*\.js"/i.test(html)) {
  violations.push('index.html still modulepreloads the KaTeX JavaScript chunk');
}
if (/rel="stylesheet"[^>]+href="[^"]*(?:math|katex)[^"/]*\.css"/i.test(html)) {
  violations.push('index.html still links the KaTeX stylesheet on the boot path');
}

const assetsDir = join(buildDir, 'assets');
const jsAssets = new Set(readdirSync(assetsDir).filter((name) => name.endsWith('.js')));
const bootAssets = Array.from(
  new Set(
    Array.from(html.matchAll(/(?:src|href)="\.\/assets\/([^"]+\.js)"/g), (match) => match[1])
      .filter((name) => jsAssets.has(name)),
  ),
);
const staticMathImport = /\bimport(?:[^;]{0,160}?\bfrom)?\s*["']\.\/(?:math|katex)[^"']+\.js["']/i;
for (const asset of bootAssets) {
  const source = readFileSync(join(assetsDir, asset), 'utf8');
  if (staticMathImport.test(source)) {
    violations.push(`${asset} still statically imports the KaTeX JavaScript chunk`);
  }
  if (source.includes('KaTeX parse error:')) {
    violations.push(`${asset} still contains the KaTeX rendering engine`);
  }
}

if (violations.length > 0) {
  throw new Error(`frontend bundle verification failed:\n- ${violations.join('\n- ')}`);
}

console.log(
  `frontend bundle verification passed (${basename(indexPath)}; checked ${bootAssets.length} boot assets)`,
);
