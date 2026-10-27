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
