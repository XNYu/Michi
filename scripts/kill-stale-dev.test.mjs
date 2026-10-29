import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Running kill-stale-dev.mjs would stop this checkout's real dev processes, so
// this checks its source instead.
const source = readFileSync(new URL('./kill-stale-dev.mjs', import.meta.url), 'utf8');

test('waits for stale processes with a timer, not a busy loop', () => {
  assert.doesNotMatch(source, /while\s*\(\s*Date\.now\(\)\s*<[^)]*\)\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/);
  assert.match(source, /await new Promise\(\(resolve\) => setTimeout\(resolve, 100\)\)/);
});
