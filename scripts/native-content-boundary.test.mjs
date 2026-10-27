import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function productionSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['dist', 'gen', 'migrations', 'node_modules'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test('native content has no external Desk endpoint, credentials, protocol or module dependency', () => {
  const forbidden = /\/api\/desk\b|\bMICHI_DESK(?:_\w+)?\b|\bAGENT_DESK_\w+\b|127\.0\.0\.1:4317|desk:\/\/|(?:from\s+|import\s*)['"][^'"]*\/desk(?:\/|['"])/;
  const violations = ['frontend/src', 'backend/src', 'shared/src', 'electron']
    .flatMap(directory => productionSources(join(root, directory)))
    .filter(path => forbidden.test(readFileSync(path, 'utf8')))
    .map(path => relative(root, path));
  assert.deepEqual(violations, []);
});
