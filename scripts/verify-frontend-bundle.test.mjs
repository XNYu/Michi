import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function verify(extra, imports = []) {
  const root = mkdtempSync(join(tmpdir(), 'michi-bundle-'));
  try {
    mkdirSync(join(root, 'assets'));
    mkdirSync(join(root, '.vite'));
    writeFileSync(join(root, 'index.html'), '<script type="module" src="./assets/main.js"></script>');
    const manifest = { 'index.html': { file: 'assets/main.js', imports }, ...extra };
    for (const entry of Object.values(manifest)) writeFileSync(join(root, entry.file), 'export const ready = true;');
    writeFileSync(join(root, '.vite/manifest.json'), JSON.stringify(manifest));
    return spawnSync(process.execPath, [resolve('scripts/verify-frontend-bundle.mjs'), root], { encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('allows optional renderers that are only dynamically imported', () => {
  const result = verify({ 'src/components/MentionEditor.tsx': { file: 'assets/MentionEditor.js' } });
  assert.equal(result.status, 0, result.stderr);
});

for (const engine of ['MentionEditor', 'LegacyHighlightedCode', 'mermaid.core', 'elk.bundled', 'katex']) {
  test(`rejects a transitive static dependency on ${engine}, even without HTML preload`, () => {
    const result = verify({
      shared: { file: 'assets/shared.js', imports: [engine] },
      [engine]: { file: `assets/${engine}.js` },
    }, ['shared']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /optional renderer on the static boot path/);
  });
}
