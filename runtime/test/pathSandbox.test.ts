import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { expandPath } from '../src/core/pathSandbox';

test('expandPath joins ~ and ~\\ onto the home directory', () => {
  const home = os.homedir();
  assert.equal(expandPath('~/docs'), path.join(home, 'docs'));
  assert.equal(expandPath('~\\docs'), path.join(home, 'docs'));
  assert.equal(expandPath('~'), home);
});
