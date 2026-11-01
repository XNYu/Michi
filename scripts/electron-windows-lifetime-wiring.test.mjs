import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('..', import.meta.url);
const main = fs.readFileSync(new URL('electron/main.ts', root), 'utf8');
const lifecycle = fs.readFileSync(new URL('electron/windowsLifecycle.ts', root), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));

function extraResources() {
  return [...(pkg.build?.extraResources ?? []), ...(pkg.build?.win?.extraResources ?? [])];
}

test('packaged tray icon is declared at the path main probes', () => {
  const resources = extraResources();
  const mapped = resources.some((entry) => {
    const from = typeof entry === 'string' ? entry : entry.from;
    const to = typeof entry === 'string' ? entry.split(/[\\/]/).pop() : entry.to;
    return from === 'assets/icons/icon.ico' && (to === 'icon.ico' || to === 'icons/icon.ico');
  });
  assert.equal(mapped, true, 'package.json must extraResources assets/icons/icon.ico to resources/icon.ico');
  assert.equal(/PACKAGED_TRAY_ICON_NAME/.test(lifecycle), true);
  assert.equal(main.includes('packagedTrayIconPath'), true);
  assert.equal(fs.existsSync(new URL('assets/icons/icon.ico', root)), true);
});

test('session-end is wired on BrowserWindow and never on App', () => {
  assert.equal(/win\.on\(\s*['"]query-session-end['"]/.test(main), true);
  assert.equal(/win\.on\(\s*['"]session-end['"]/.test(main), true);
  assert.equal(/beginQuit\(\s*['"]shutdown['"]/.test(main), true);
  assert.equal(/app\.on\(\s*['"]session-end['"]/.test(main), false);
  assert.equal(/as Electron\.App/.test(main), false);
  const query = main.indexOf("win.on('query-session-end'");
  assert.equal(query >= 0, true);
  assert.equal(/preventDefault/.test(main.slice(query, query + 280)), false);
});

test('hidden login start still creates a BrowserWindow so shutdown events have a target', () => {
  assert.equal(/onAppReady\(\s*\{\s*launchedHidden/.test(main), true);
  assert.equal(/hidden:\s*ready\.startHidden/.test(main), true);
  assert.equal(/await createWindow\(backendPort, healthPromise, undefined, \{ hidden: ready\.startHidden \}\)/.test(main), true);
});

test('non-Windows second-instance keeps the original create-window path', () => {
  const start = main.indexOf("app.on('second-instance'");
  assert.notEqual(start, -1);
  const block = main.slice(start, start + 650);
  assert.equal(/process\.platform !== ['"]win32['"]/.test(block), true);
  assert.equal(block.includes('BACKGROUND_LAUNCH_ARG'), true);
  assert.equal(block.includes('createWindow(resolvedBackendPort)'), true);
  assert.equal(block.includes('handleSecondInstance'), true);
});

test('lifetime IPC requires an owned window main frame', () => {
  assert.equal(main.includes('senderFrame'), true);
  assert.equal(main.includes('mainFrame'), true);
  assert.equal(main.includes('isOwnedLifetimeSender'), true);
});

test('restore clears skipTaskbar and ready-to-show cannot rehide a restored window', () => {
  const reveal = main.includes('function revealWindow')
    ? main.slice(main.indexOf('function revealWindow'), main.indexOf('function revealWindow') + 420)
    : main.slice(main.indexOf('restoreWindow'), main.indexOf('restoreWindow') + 280);
  assert.equal(reveal.includes('setSkipTaskbar(false)'), true);
  assert.equal(/setSkipTaskbar\(false\)[\s\S]*\.show\(/.test(reveal), true);
  const ready = main.slice(main.indexOf("win.once('ready-to-show'"), main.indexOf("win.once('ready-to-show'") + 380);
  assert.equal(ready.includes('restoredWindows'), true);
  assert.equal(/options\?\.hidden && !restoredWindows/.test(ready), true);
});

test('Windows quit-close skips the terminal confirm; query-session-end is not irrevocable', () => {
  const close = main.slice(main.indexOf("win.on('close'"), main.indexOf("win.once('ready-to-show'"));
  assert.equal(close.includes("=== 'quit-close'"), true);
  const quitReturn = close.indexOf("=== 'quit-close'");
  const prompt = close.indexOf('showMessageBox');
  assert.equal(quitReturn >= 0 && prompt > quitReturn, true);
  const query = main.slice(main.indexOf("win.on('query-session-end'"), main.indexOf("win.on('session-end'"));
  assert.equal(/beginQuit/.test(query), false);
  const ended = main.slice(main.indexOf("win.on('session-end'"), main.indexOf("win.on('session-end'") + 220);
  assert.equal(/beginQuit\(\s*['"]shutdown['"]/.test(ended), true);
});
