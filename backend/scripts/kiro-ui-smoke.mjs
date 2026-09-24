import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

// Opt-in real browser + real server/CLI. Build first; never points at user data.
if (!['v2', 'v3'].includes(process.env.MICHI_KIRO_UI_SMOKE)) throw new Error('Set MICHI_KIRO_UI_SMOKE=v2 or v3');
const engine = process.env.MICHI_KIRO_UI_SMOKE;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `michi-kiro-ui-${engine}-`)));
const output = process.env.MICHI_KIRO_SMOKE_OUTPUT ?? directory;
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
  agent: { runtime: 'kiro', modelByRuntime: { kiro: 'claude-opus-4.7' }, reasoningByRuntime: { kiro: 'low' } },
  prefs: { onboardingCompletedAt: Date.now(), terminalPalette: 'monokai' },
}));
const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const log = fs.openSync(path.join(output, `${engine}-ui-backend.log`), 'w');
const proc = spawn(process.execPath, [path.join(root, 'backend/dist/server.js')], {
  cwd: directory, detached: true, stdio: ['ignore', log, log],
  env: { ...process.env, PORT: String(port), MICHI_DATA_DIR: directory, MICHI_CONFIG_DIR: directory,
    MICHI_AGENT_RUNTIME: 'kiro', MICHI_ENABLED_RUNTIMES: 'kiro', MICHI_KIRO_ENGINE: engine,
    MICHI_TITLE_MODEL_KIRO: 'off', MICHI_KIRO_WARM_POOL_SIZE: '1', MICHI_CLOUD: '0',
    MICHI_LOG_DIR: path.join(directory, 'logs') },
});
const base = `http://127.0.0.1:${port}`;
let browser;
let db;
const errors = [];
const timeout = setTimeout(() => { try { process.kill(-proc.pid, 'SIGTERM'); } catch {} }, 420_000);
try {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/api/agent/status`)).ok) break; } catch {}
    if (i === 199) throw new Error('server did not start');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true });
  db = new DatabaseSync(path.join(directory, 'data.db'), { readOnly: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  page.on('pageerror', (error) => errors.push(error.message));
  const ensures = [];
  page.on('response', async (response) => {
    if (response.url().endsWith('/ensure-session')) {
      try {
        const result = await response.json();
        ensures.push(result);
        if (!response.ok()) errors.push(result.error ?? `ensure-session failed: ${response.status()}`);
      } catch {}
    }
  });
  await page.goto(base);
  await page.getByPlaceholder(/workspace|untitled/i).first().fill(`Kiro ${engine} live verification`, { timeout: 20000 });
  await page.getByRole('button', { name: /^create$/i }).click();
  const editor = () => page.locator('[contenteditable="true"]').last();
  const projectName = `CrystalHarbor${Date.now()}`;
  await editor().fill(`We are discussing a fictional project named ${projectName}. Acknowledge the project name briefly. Do not use external tools; the Michi branch overview tool is fine.`);
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).last().click();
  let expectedTurns = 0;
  async function finishTurn() {
    expectedTurns++;
    const deadline = Date.now() + 110000;
    while (Date.now() < deadline) {
      const allow = page.getByRole('button', { name: /^Allow once/ });
      if (await allow.count()) await allow.first().click();
      const turns = db.prepare('SELECT status, error FROM turns').all();
      assert.deepEqual(errors, []);
      assert.ok(!turns.some((turn) => turn.status === 'error'), JSON.stringify(turns));
      if (turns.length === expectedTurns && turns.every((turn) => turn.status === 'completed')) return;
      await page.waitForTimeout(200);
    }
    throw new Error('live UI turn did not finish');
  }
  await finishTurn();
  assert.ok(ensures.some((r) => r.chatId || r.sessionId || r.nodeId), JSON.stringify(ensures));
  await page.screenshot({ path: path.join(output, `${engine}-live-parent.png`), fullPage: true });
  await editor().fill('What is the fictional project name we discussed? State it and record the branch overview. No external tools.');
  await page.keyboard.press('Meta+Enter');
  await finishTurn();
  assert.ok(ensures.length >= 2, 'branch goes through ensure-session');
  assert.equal(ensures.at(-1).resumeReason, 'native_fork', 'UI branch must use a native fork, not text fallback');
  let data = await (await fetch(`${base}/api/workspaces/all`)).json();
  const workspace = data.workspaces[0];
  const parent = workspace.nodes.find((node) => !node.parent_node_id);
  const child = workspace.nodes.find((node) => node.parent_node_id === parent.id);
  assert.ok(child && child.acp_session_id !== parent.acp_session_id);
  assert.equal(child.runtime_engine, engine);
  assert.ok(workspace.messages.some((message) => message.node_id === child.id
    && message.role === 'assistant' && message.content.includes(projectName)), 'child recalls native parent history');
  fs.writeFileSync(path.join(output, `${engine}-ui-workspaces.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(output, `${engine}-ui-ensure.json`), JSON.stringify(ensures, null, 2));
  await page.screenshot({ path: path.join(output, `${engine}-live-branch-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, `${engine}-live-branch-mobile.png`), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 980 });
  await editor().fill('Compare blue, red and green for our fictional project UI. Write eight short paragraphs, then recommend one. Do not use external tools.');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).last().click();
  for (let i = 0; i < 300; i++) {
    if (db.prepare("SELECT 1 FROM turns WHERE node_id = ? AND status = 'active'").get(child.id)) break;
    if (i === 299) throw new Error('steering turn did not start');
    await page.waitForTimeout(100);
  }
  await editor().fill('New constraint: recommend cobalt. Use the exact word cobalt in your final recommendation.');
  await page.getByRole('button', { name: /^Send next/ }).last().click();
  const steerResponse = page.waitForResponse((response) => response.url().endsWith('/steer'));
  await page.screenshot({ path: path.join(output, `${engine}-live-steer.png`), fullPage: true });
  await page.getByRole('button', { name: 'Steer now', exact: true }).click();
  const steer = await (await steerResponse).json();
  assert.equal(steer.accepted, true, JSON.stringify(steer));
  await finishTurn();
  const lastReply = db.prepare("SELECT content FROM messages WHERE node_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1").get(child.id);
  assert.match(lastReply.content, /cobalt/i, 'real model consumes UI steering');
  assert.equal(db.prepare('SELECT count(*) AS count FROM turns').get().count, 3, 'native steering does not start a second turn');
  await editor().fill('/compact');
  const compactResponse = page.waitForResponse((response) => response.url().endsWith('/compact'), { timeout: 100000 });
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).last().click();
  const compact = await (await compactResponse).json();
  assert.equal(compact.started, true, JSON.stringify(compact));
  assert.equal(compact.completed, true, 'compact waits for native completion');
  await page.reload();
  data = await (await fetch(`${base}/api/workspaces/all`)).json();
  const restored = data.workspaces[0].nodes.find((node) => node.id === child.id);
  assert.equal(restored.acp_session_id, child.acp_session_id, 'refresh preserves native child identity');
  // The shell intentionally starts on Home after a reload; reopen the branch.
  await page.getByText(restored.title, { exact: true }).first().click({ timeout: 20000 });
  await page.getByText(/cobalt/i).first().waitFor({ timeout: 20000 });
  await editor().fill('What is our fictional project name and which UI color did we choose? Reply briefly with both. No external tools.');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).last().click();
  await finishTurn();
  const afterCompact = db.prepare("SELECT content FROM messages WHERE node_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1").get(child.id);
  assert.ok(afterCompact.content.includes(projectName), 'native history survives compaction and refresh');
  assert.match(afterCompact.content, /cobalt/i, 'native steering survives compaction and refresh');
  data = await (await fetch(`${base}/api/workspaces/all`)).json();
  fs.writeFileSync(path.join(output, `${engine}-ui-workspaces.json`), JSON.stringify(data, null, 2));
  await page.screenshot({ path: path.join(output, `${engine}-live-reloaded.png`), fullPage: true });
  assert.deepEqual(errors, []);
  const result = { engine, directory, output, base, ensureCount: ensures.length, steer, compact, pageErrors: errors };
  fs.writeFileSync(path.join(output, `${engine}-ui-result.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: path.join(output, `${engine}-live-failure.png`), fullPage: true });
    if (page) fs.writeFileSync(path.join(output, `${engine}-live-failure.txt`), await page.locator('body').innerText());
  }
  throw error;
} finally {
  clearTimeout(timeout);
  await browser?.close();
  db?.close();
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  if (proc.exitCode === null && proc.signalCode === null) await new Promise((resolve) => proc.once('exit', resolve));
  fs.closeSync(log);
  // Retain isolated DB + native IDs as evidence, never replace the user's app.
}
