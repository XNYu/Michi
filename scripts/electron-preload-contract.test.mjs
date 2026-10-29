import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the actual preload with an IPC double; no Electron process, windows,
// user files, background service or terminal process is started.
function loadPreload(search = '') {
  const calls = [];
  const handlers = new Map();
  const responses = new Map();
  let bridge;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'electron'); bridge = value; } },
    ipcRenderer: {
      invoke(channel, ...args) { calls.push([channel, ...args]); return Promise.resolve(responses.get(channel)); },
      send(channel, ...args) { calls.push([channel, ...args]); },
      on(channel, handler) { handlers.set(channel, handler); },
      removeListener(channel, handler) { if (handlers.get(channel) === handler) handlers.delete(channel); },
    },
    webUtils: { getPathForFile(file) { if (file.invalid) throw new Error('not a native file'); return file.path; } },
  };
  vm.runInNewContext(compiled, {
    require(name) { assert.equal(name, 'electron'); return electron; },
    exports: {}, URLSearchParams, window: { location: { search } },
    document: { documentElement: { setAttribute() {} } },
  }, { filename: 'electron/preload.ts' });
  return { bridge, calls, handlers, responses };
}

test('preload forwards typed service and terminal responses without wrapping or dropping fields', async () => {
  const { bridge, calls, responses } = loadPreload();
  const service = { supported: true, enabled: false, running: false, port: null };
  const terminal = { surfaceId: 'surface', data: 'hello', exited: true, exitCode: 2 };
  responses.set('service:getStatus', service);
  responses.set('service:setEnabled', service);
  responses.set('terminal:create', terminal);
  assert.equal(await bridge.getBackgroundServiceStatus(), service);
  assert.equal(await bridge.setBackgroundServiceEnabled(true), service);
  assert.equal(await bridge.terminalCreate('surface', '/workspace', 80, 24), terminal);
  assert.deepEqual(calls, [['service:getStatus'], ['service:setEnabled', true], ['terminal:create', 'surface', '/workspace', 80, 24]]);
});

test('remote authentication target crosses only its dedicated IPC channel', async () => {
  const { bridge, calls, responses } = loadPreload();
  const target = { host: 'example.test', user: 'test', port: 22, scope: 'remote' };
  const snapshot = { surfaceId: 'auth', data: '', exited: false };
  responses.set('remote-auth:create', snapshot);
  assert.equal(await bridge.remoteAuthCreate('auth', target, 100, 30), snapshot);
  assert.deepEqual(calls, [['remote-auth:create', 'auth', target, 100, 30]]);
});

test('preload event subscriptions preserve payloads and release their exact listener', () => {
  const { bridge, handlers } = loadPreload();
  const notice = { title: 'Done', subtitle: 'Scheduled', body: 'Result', target: { runId: 'r', jobId: 'j', workspaceId: 'w', nodeId: null } };
  let received;
  const stop = bridge.onScheduledNotice((value) => { received = value; });
  handlers.get('scheduled:notice')({}, notice);
  assert.equal(received, notice);
  stop();
  assert.equal(handlers.has('scheduled:notice'), false);
});

test('bootstrap values and native File conversion retain legacy renderer behavior', () => {
  const { bridge, calls } = loadPreload('?michiPackaged=1&michiWindowId=window&michiOpenRun=r&michiOpenJob=j&michiOpenWorkspace=w');
  assert.equal(bridge.isPackaged, true);
  assert.equal(bridge.michiWindowId, 'window');
  assert.equal(JSON.stringify(bridge.initialScheduledRun), JSON.stringify({ runId: 'r', jobId: 'j', workspaceId: 'w', nodeId: null }));
  assert.equal(bridge.getPathForFile({ path: '/workspace/file' }), '/workspace/file');
  assert.equal(bridge.getPathForFile({ invalid: true }), null);
  assert.deepEqual(calls, []);
});


test('public updater uses the shared invoke channels and update-state event', async () => {
  const { bridge, calls, handlers, responses } = loadPreload();
  const state = { status: 'ready', currentVersion: '0.3.2', latestVersion: '0.3.3' };
  for (const name of ['getUpdateState', 'checkForUpdate', 'downloadUpdate', 'installUpdate']) {
    responses.set(`app:${name}`, state);
    assert.equal(await bridge[name](), state);
  }
  assert.deepEqual(calls.map(([channel]) => channel), [
    'app:getUpdateState', 'app:checkForUpdate', 'app:downloadUpdate', 'app:installUpdate',
  ]);
  const received = [];
  const unsubscribe = bridge.onAppUpdate(value => received.push(value));
  handlers.get('app:update-state')({}, state);
  assert.deepEqual(received, [state]);
  unsubscribe();
  assert.equal(handlers.has('app:update-state'), false);
});

// ── Sandbox contract ──────────────────────────────────────────────────────
// The windows run with sandbox: true, so the shipped preload may require only
// 'electron' and must not touch Node-only globals. These checks read the real
// tsc output; run `npm run electron:build-main` first.
const NODE_ONLY_GLOBALS = new Set(['Buffer', 'setImmediate', 'clearImmediate', 'process', '__dirname', '__filename', 'global', 'module']);

function isPropertyName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  return (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node;
}

function sandboxViolations(code) {
  const file = ts.createSourceFile('preload.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const violations = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (node.text === 'require') {
        const call = node.parent;
        const ok = ts.isCallExpression(call) && call.expression === node && call.arguments.length === 1
          && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'electron';
        if (!ok) violations.push(node.parent.getText(file));
      } else if (NODE_ONLY_GLOBALS.has(node.text)) {
        violations.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function webPreferencesOf(sourceText, constructorNames) {
  const file = ts.createSourceFile('main.ts', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && constructorNames.includes(node.expression.text)) {
      const options = node.arguments?.[0];
      const prefs = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(file) === 'webPreferences')
        : undefined;
      if (prefs && ts.isObjectLiteralExpression(prefs.initializer)) {
        const values = {};
        for (const p of prefs.initializer.properties) {
          if (ts.isPropertyAssignment(p)) values[p.name.getText(file)] = p.initializer.getText(file);
        }
        found.push({ constructor: node.expression.text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, values });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test('sandbox scan detects Node-only globals and non-electron requires', () => {
  assert.deepEqual(
    sandboxViolations('const fs = require("fs"); Buffer.from("x"); setImmediate(() => {}); process.platform; obj.process = 1;'),
    ['require("fs")', 'Buffer', 'setImmediate', 'process'],
  );
  assert.deepEqual(sandboxViolations('const electron_1 = require("electron"); window.process; ({ process: 1 });'), []);
});

test('compiled preload requires only electron and uses no Node-only globals', () => {
  const builtUrl = new URL('../electron/dist/preload.js', import.meta.url);
  assert.ok(fs.existsSync(builtUrl), 'electron/dist/preload.js is missing; run `npm run electron:build-main` first');
  const built = fs.readFileSync(builtUrl, 'utf8');
  assert.deepEqual(sandboxViolations(built), []);
  // The tsc CommonJS output loads with only the module/exports/require a
  // sandboxed preload receives, plus the web globals it reads.
  let exposed;
  vm.runInNewContext(built, {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } },
        ipcRenderer: { invoke() {}, send() {}, on() {}, removeListener() {} },
        webUtils: { getPathForFile() { return ''; } },
      };
    },
    exports: {}, URLSearchParams, window: { location: { search: '' } },
    document: { documentElement: { setAttribute() {} } },
  }, { filename: 'electron/dist/preload.js' });
  assert.equal(typeof exposed?.getPathForFile, 'function');
});

test('every window and view that loads web content keeps the renderer sandboxed', () => {
  const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const found = webPreferencesOf(mainSource, ['BrowserWindow', 'WebContentsView']);
  assert.ok(found.some((entry) => entry.constructor === 'BrowserWindow' && 'preload' in entry.values), 'main window webPreferences not found');
  for (const entry of found) {
    const where = `${entry.constructor} at electron/main.ts:${entry.line}`;
    assert.equal(entry.values.sandbox, 'true', `${where} must set sandbox: true`);
    assert.equal(entry.values.contextIsolation, 'true', `${where} must set contextIsolation: true`);
    assert.equal(entry.values.nodeIntegration, 'false', `${where} must set nodeIntegration: false`);
  }
});
