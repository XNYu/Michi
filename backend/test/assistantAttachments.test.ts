import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAssistantAttachments } from '../src/assistant/attachments';

test('assistant receives images natively and uploaded text inline without a general file reader', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-attachments-'));
  try {
    const dir = path.join(cwd, '.attachments'); fs.mkdirSync(dir);
    const text = path.join(dir, 'notes.txt'); fs.writeFileSync(text, 'Review the release notes.');
    const image = path.join(dir, 'screen.png'); fs.writeFileSync(image, 'image fixture');
    const pdf = path.join(dir, 'report.pdf'); fs.writeFileSync(pdf, Buffer.from([0, 1, 2, 3]));
    const output = prepareAssistantAttachments('Read these', [{ name: 'notes', absPath: text }, { name: 'screen', absPath: image }, { name: 'report', absPath: pdf }], cwd);
    assert.match(output.text, /Review the release notes/);
    assert.match(output.text, /binary format cannot be read/);
    assert.deepEqual(output.attachments, [{ name: 'screen', absPath: fs.realpathSync(image) }]);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('attachment containment rejects outside paths and symlinks and caps text size', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-attachments-'));
  try {
    const dir = path.join(cwd, '.attachments'); fs.mkdirSync(dir);
    const outside = path.join(cwd, 'private.txt'); fs.writeFileSync(outside, 'NOT_SHARED');
    const link = path.join(dir, 'link.txt'); fs.symlinkSync(outside, link);
    const big = path.join(dir, 'large.txt'); fs.writeFileSync(big, 'X'.repeat(512 * 1024 + 1));
    const output = prepareAssistantAttachments('Read these', [{ name: 'private', absPath: outside }, { name: 'link', absPath: link }, { name: 'large', absPath: big }], cwd);
    assert.ok(!output.text.includes('NOT_SHARED'));
    assert.match(output.text, /Too large to inline/);
    assert.deepEqual(output.attachments, []);
    assert.deepEqual(prepareAssistantAttachments('No files', undefined, cwd), { text: 'No files', attachments: undefined });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
