import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAntigravityBinary } from '../src/agents/antigravity/antigravityBinary';
import { AntigravitySession } from '../src/agents/antigravity/AntigravitySession';
import {
  ensureAntigravityCustomization,
  warmAntigravityCustomization,
} from '../src/agents/antigravity/antigravityCustomization';

const RUN = process.env.RUN_ANTIGRAVITY_SMOKE === '1';

describe('Antigravity runtime live smoke', { skip: !RUN && 'set RUN_ANTIGRAVITY_SMOKE=1 to use the real AGY CLI' }, () => {
  test('print streams and native conversation resume recalls prior context', { timeout: 180_000 }, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-smoke-'));
    const logDir = path.join(cwd, 'logs');
    let conversationId = '';
    try {
      const first = new AntigravitySession({
        nodeId: 'smoke-first',
        cwd,
        binaryPath: findAntigravityBinary(),
        logDir,
        onConversationId: (id) => { conversationId = id; },
      });
      let firstText = '';
      for await (const event of first.send('Remember the token AGY_SMOKE_TOKEN and reply with exactly PONG.')) {
        if (event.kind === 'chunk') firstText += event.text;
      }
      assert.match(firstText, /PONG/i);
      assert.match(conversationId, /^[0-9a-f-]{36}$/i);

      const resumed = new AntigravitySession({
        nodeId: 'smoke-resume',
        cwd,
        binaryPath: findAntigravityBinary(),
        logDir,
        externalConversationId: conversationId,
      });
      let recalled = '';
      for await (const event of resumed.send('Which token did I ask you to remember? Reply with only the token.')) {
        if (event.kind === 'chunk') recalled += event.text;
      }
      assert.match(recalled, /AGY_SMOKE_TOKEN/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('discovers and applies the runtime-owned Michi custom agent', { timeout: 180_000 }, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-agent-smoke-'));
    try {
      const customization = ensureAntigravityCustomization(dataDir);
      const binaryPath = findAntigravityBinary();
      await warmAntigravityCustomization(binaryPath, customization);
      const session = new AntigravitySession({
        nodeId: 'smoke-agent',
        cwd: dataDir,
        binaryPath,
        logDir: path.join(dataDir, 'logs'),
        customizationDir: customization.rootDir,
        agentName: customization.agentName,
        mode: 'plan',
      });
      let text = '';
      for await (const event of session.send('Explain 2+2 in one short sentence.')) {
        if (event.kind === 'chunk') text += event.text;
      }
      assert.match(text, /\[TITLE:/);
      assert.match(text, /\[FOLLOW-UP 1\/3:/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
