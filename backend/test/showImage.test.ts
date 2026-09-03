import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveShowImage, SHOW_IMAGE_MAX_BYTES } from '../src/agents/claude/showImage';
import { trySymlinkSync } from './symlinkUtil';

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showimg-'));
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

test('resolves a workspace image to relPath + mime', () => {
  const cwd = tmpWorkspace();
  const r = resolveShowImage(cwd, 'pic.png');
  assert.deepEqual(r, { ok: true, relPath: 'pic.png', mimeType: 'image/png', size: 4 });
});

test('rejects path traversal outside cwd', () => {
  const cwd = tmpWorkspace();
  const r = resolveShowImage(cwd, '../../../etc/hosts');
  assert.equal(r.ok, false);
});

test('rejects non-image extension', () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'x');
  const r = resolveShowImage(cwd, 'a.txt');
  assert.equal(r.ok, false);
});

test('rejects missing file', () => {
  const cwd = tmpWorkspace();
  const r = resolveShowImage(cwd, 'nope.png');
  assert.equal(r.ok, false);
});

test('rejects SVG (script-bearing)', () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'x.svg'), '<svg/>');
  const r = resolveShowImage(cwd, 'x.svg');
  assert.equal(r.ok, false);
});

test('rejects a symlink inside the workspace pointing outside it', () => {
  const cwd = tmpWorkspace();
  // A real image file living OUTSIDE the workspace.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showimg-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.png');
  fs.writeFileSync(outsideFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // A symlink INSIDE the workspace that escapes to it — this is exactly what
  // the realpath recheck (beyond resolveWithinCwd's lexical check) defeats.
  if (!trySymlinkSync(outsideFile, path.join(cwd, 'link.png'))) return;
  const r = resolveShowImage(cwd, 'link.png');
  assert.equal(r.ok, false);
});

test('accepts a workspace-absolute path', () => {
  const cwd = tmpWorkspace();
  const r = resolveShowImage(cwd, path.join(cwd, 'pic.png'));
  assert.deepEqual(r, { ok: true, relPath: 'pic.png', mimeType: 'image/png', size: 4 });
});

test('accepts an uppercase image extension', () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'PIC.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = resolveShowImage(cwd, 'PIC.PNG');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.mimeType, 'image/png');
});

test('rejects an image larger than the size cap', () => {
  const cwd = tmpWorkspace();
  // One byte over the cap.
  fs.writeFileSync(path.join(cwd, 'big.png'), Buffer.alloc(SHOW_IMAGE_MAX_BYTES + 1));
  const r = resolveShowImage(cwd, 'big.png');
  assert.equal(r.ok, false);
});

test('accepts an image exactly at the size cap', () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'atcap.png'), Buffer.alloc(SHOW_IMAGE_MAX_BYTES));
  const r = resolveShowImage(cwd, 'atcap.png');
  assert.equal(r.ok, true);
});
