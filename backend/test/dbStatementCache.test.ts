import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, initDb, prepareCached } from '../src/services/db';

describe('static SQLite statement cache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-statement-cache-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('reuses a static statement on one connection', () => {
    const first = prepareCached('SELECT ? AS value');
    const second = prepareCached('SELECT ? AS value');

    assert.equal(second, first);
    assert.equal((first.get('first') as { value?: string } | undefined)?.value, 'first');
    assert.equal((second.get('second') as { value?: string } | undefined)?.value, 'second');
  });

  test('invalidates cached statements when closeDb replaces the connection', () => {
    const first = prepareCached('SELECT ? AS value');
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-statement-cache-next-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    initDb();
    const second = prepareCached('SELECT ? AS value');

    assert.notEqual(second, first);
    assert.equal((second.get('fresh') as { value?: string } | undefined)?.value, 'fresh');
  });
});
