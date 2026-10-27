import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RUNTIME_CONTRACT_VERSION } from '../src';

test('runtime contract version is 1, the major version of the package', () => {
  assert.equal(RUNTIME_CONTRACT_VERSION, 1);
  const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(Number(String(version).split('.')[0]), RUNTIME_CONTRACT_VERSION,
    `bump RUNTIME_CONTRACT_VERSION together with the major version of the package (${version})`);
});
