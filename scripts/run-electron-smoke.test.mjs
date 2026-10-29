import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { smokeScript } from './run-electron-smoke.mjs';

// The smokes themselves need Electron and a display session, so they run only
// from the test:electron-* scripts; these checks keep every smoke reachable.
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const smokeNames = readdirSync(scriptsDir)
  .map((file) => /^electron-(.+)-smoke\.cjs$/.exec(file)?.[1])
  .filter(Boolean)
  .sort();

test('smoke names resolve to their scripts; anything else is refused', () => {
  assert.equal(smokeScript('native-shortcut'), path.join(scriptsDir, 'electron-native-shortcut-smoke.cjs'));
  assert.throws(() => smokeScript('../package'), /Unknown Electron smoke/);
  assert.throws(() => smokeScript('missing'), /Unknown Electron smoke/);
});

test('every Electron smoke runs from an npm script', () => {
  assert.deepEqual(smokeNames, ['browser-theme', 'native-shortcut']);
  const scripts = Object.values(JSON.parse(readFileSync(path.join(scriptsDir, '..', 'package.json'), 'utf8')).scripts);
  const launched = new Set(
    scripts.flatMap((command) => [...command.matchAll(/scripts\/run-electron-smoke\.mjs((?: [a-z-]+)+)/g)]
      .flatMap((match) => match[1].trim().split(' '))),
  );
  for (const name of smokeNames) assert.ok(launched.has(name), `${name} smoke has no npm script`);
});

test('every Electron smoke uses the shared harness', () => {
  for (const name of smokeNames) {
    const source = readFileSync(path.join(scriptsDir, `electron-${name}-smoke.cjs`), 'utf8');
    assert.match(source, /require\('\.\/electron-smoke-harness\.cjs'\)/, name);
  }
});
