import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach } from 'node:test';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageWriteError } from '../src/services/pages/core';
import { PageComponents } from '../src/services/pages/components';
import { callPageComponentCapability, clearPageComponentCapabilitiesForTests, mintPageComponentCapability } from '../src/services/pages/componentCapabilities';
import { createDatabase, getDatabase } from '../src/services/pages/repository';
import { COMPONENT_SANDBOX_CSP, COMPONENT_SANDBOX_HTML, COMPONENT_SANDBOX_WRAPPER_HTML, componentSandboxWrapper } from '../src/services/pages/sandboxDocument';

let dir: string;
let oldData: string | undefined;
const owner = 'component-owner';
const source = { kind: 'chat' as const, nodeId: 'node-1', turnId: 'turn-1', assistantId: 'assistant-1' };
const components = new PageComponents();
let componentId = '';
const host = { kind: 'page_block' as const, pageId: 'page-1', blockId: 'block-1' };
function mint(props: unknown = {}) {
  return mintPageComponentCapability({ workspaceId: 'ws-1', ownerUserId: owner, componentId, version: 1, host, props });
}

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-component-capability-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb(); clearPageComponentCapabilitiesForTests();
  const db = getDb();
  db.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)').run('ws-1', 'Workspace', owner, 1, 1);
  db.prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('node-1','ws-1','chat','idle')").run();
  db.prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('turn-1','node-1','assistant-1','active',1,1)").run();
  const saved = components.save('ws-1', owner, {
    input: { name: 'sample-component', description: 'Sample component', code: 'root.textContent = props.label;' },
    expectedLibraryRevision: 0, source, now: 2,
  });
  componentId = saved.component.id;
  db.prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,title,blocks,updated_at,created_at)
    VALUES('page-1',?,'ws-1','Host page',?,3,3)`).run(owner, JSON.stringify([{ type: 'component', componentId, props: { label: 'hello' }, id: 'block-1', rev: 1 }]));
  components.replaceReferences(owner, 'ws-1', 'page_block', 'page-1', [
    { componentId, blockId: 'block-1', pinnedVersion: null, protected: false, hostRevision: 1 },
  ], 4);
});

afterEach(() => {
  clearPageComponentCapabilitiesForTests(); closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('capability is opaque, parent-held, host-scoped, and returns only the bound page block', () => {
  const minted = mint();
  assert.ok(minted.capability.length >= 64);
  assert.equal(minted.version, 1);
  assert.deepEqual(minted.props, { label: 'hello' });
  const result = callPageComponentCapability(minted.capability, owner, { method: 'read.host' }) as { page: { id: string }; block: { id: string } };
  assert.deepEqual(result, { page: { id: 'page-1', title: 'Host page', revision: 1 }, block: { type: 'component', componentId, props: { label: 'hello' }, id: 'block-1', rev: 1 } });
  assert.throws(() => callPageComponentCapability(minted.capability, 'other-owner', { method: 'read.host' }), (error: unknown) => error instanceof PageWriteError && error.status === 404);
  assert.throws(() => callPageComponentCapability(minted.capability, owner, { method: 'read.database', resourceId: 'private-db' }), (error: unknown) => error instanceof PageWriteError && error.status === 404);
});

test('capabilities survive unrelated page revisions but fail on host config changes and disable', () => {
  const minted = mint();
  assert.throws(() => callPageComponentCapability(minted.capability, owner, { method: 'resize', args: [1] }), /Invalid component height/);
  getDb().prepare("UPDATE pages SET title='Unrelated metadata edit', revision=revision+1 WHERE id='page-1'").run();
  assert.equal((callPageComponentCapability(minted.capability, owner, { method: 'read.host' }) as { page: { title: string } }).page.title, 'Unrelated metadata edit');
  getDb().prepare("UPDATE pages SET blocks=?,revision=revision+1 WHERE id='page-1'")
    .run(JSON.stringify([{ type: 'component', componentId, props: { label: 'changed' }, id: 'block-1', rev: 2 }]));
  assert.throws(() => callPageComponentCapability(minted.capability, owner, { method: 'read.host' }), (error: unknown) => error instanceof PageWriteError && error.code === 'stale_revision');
  getDb().prepare("UPDATE pages SET blocks=?,revision=1 WHERE id='page-1'")
    .run(JSON.stringify([{ type: 'component', componentId, props: { label: 'hello' }, id: 'block-1', rev: 1 }]));
  const next = mint();
  components.setEnabled('ws-1', owner, componentId, false, { expectedLibraryRevision: 1, actor: { kind: 'user' }, now: 10 });
  assert.throws(() => callPageComponentCapability(next.capability, owner, { method: 'read.host' }), (error: unknown) => error instanceof PageWriteError && error.status === 404);
});

test('caller props cannot replace the host-owned component configuration', () => {
  const minted = mint({ databaseId: 'unlinked-database', databaseIds: ['other-workspace-database'] });
  assert.deepEqual(minted.props, { label: 'hello' });
  assert.throws(() => callPageComponentCapability(minted.capability, owner, {
    method: 'read.database', resourceId: 'unlinked-database',
  }), (error: unknown) => error instanceof PageWriteError && error.status === 404);
});

test('database-view capabilities remain valid across repeated component row writes', () => {
  const database = createDatabase({
    workspaceId: 'ws-1', ownerUserId: owner, title: 'Component rows', now: 10,
    columns: [{ id: 'task', name: 'Task', type: 'text' }],
    views: [{ id: 'view-1', name: 'Component', position: 0, type: 'custom', config: {
      filters: [], match: 'all', sorts: [], componentId, props: { label: 'hello' },
    } }],
    rows: [],
  });
  components.replaceReferences(owner, 'ws-1', 'database_view', database.id, [
    { componentId, viewId: 'view-1', pinnedVersion: null, protected: false, hostRevision: database.revision },
  ], 11);
  const capability = mintPageComponentCapability({ workspaceId: 'ws-1', ownerUserId: owner, componentId, version: 1,
    host: { kind: 'database_view', databaseId: database.id, viewId: 'view-1' } });
  callPageComponentCapability(capability.capability, owner, { method: 'write.rows', args: [[{ op: 'row.add', values: { task: 'first' } }]] });
  callPageComponentCapability(capability.capability, owner, { method: 'write.rows', args: [[{ op: 'row.add', values: { task: 'second' } }]] });
  assert.deepEqual(getDatabase(database.id, owner).rows.map((row) => row.values.task), ['first', 'second']);
});

test('sandbox document blocks network, embeds no credentials, and uses an opaque script-only policy', () => {
  assert.match(COMPONENT_SANDBOX_CSP, /connect-src 'none'/);
  assert.match(COMPONENT_SANDBOX_CSP, /sandbox allow-scripts/);
  assert.doesNotMatch(COMPONENT_SANDBOX_CSP, /allow-same-origin|allow-top-navigation|allow-popups/);
  assert.match(COMPONENT_SANDBOX_HTML, /new Function\("root","props","data","call","document"/);
  assert.match(COMPONENT_SANDBOX_HTML, /new Worker\(workerUrl\)/);
  assert.match(COMPONENT_SANDBOX_HTML, /worker-src blob:/);
  assert.match(COMPONENT_SANDBOX_HTML, /Object\.defineProperty\(globalThis,key/);
  assert.match(COMPONENT_SANDBOX_HTML, /event\.source !== parent/);
  assert.doesNotMatch(COMPONENT_SANDBOX_HTML, /localStorage|electronBridge/);
  assert.equal(COMPONENT_SANDBOX_WRAPPER_HTML, COMPONENT_SANDBOX_HTML);
  const local = componentSandboxWrapper('/api/component-sandbox-wrapper');
  assert.match(local.csp, /frame-src 'none'/);
  assert.match(local.csp, /worker-src blob:/);
  assert.doesNotMatch(local.html, /<iframe/);
  const remote = componentSandboxWrapper('/api/component-sandbox-wrapper');
  assert.equal(remote.html, local.html);
  assert.equal(remote.csp, local.csp);
  assert.throws(() => componentSandboxWrapper('/bad-path'));
});

test('trusted sandbox and emitted Worker JavaScript both parse', () => {
  const script = COMPONENT_SANDBOX_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script, { filename: 'component-sandbox.html' });

  let messageListener: ((event: { source: unknown; data: unknown }) => void) | undefined;
  let emittedWorker: { parts: unknown[] } | undefined;
  const parent = { postMessage() {} };
  const root = { addEventListener() {}, replaceChildren() {}, appendChild() {} };
  class CapturedBlob { constructor(readonly parts: unknown[]) {} }
  class CapturedWorker {
    onerror?: (event: unknown) => void;
    onmessage?: (event: unknown) => void;
    constructor(blob: unknown) { emittedWorker = blob as CapturedBlob; }
    postMessage() {}
    terminate() {}
  }
  const context = {
    document: { getElementById: () => root, createTextNode: () => ({}), createElement: () => ({}) },
    parent,
    addEventListener: (_type: string, listener: typeof messageListener) => { messageListener = listener; },
    Blob: CapturedBlob,
    Worker: CapturedWorker,
    URL: { createObjectURL: (blob: unknown) => blob, revokeObjectURL() {} },
    TextEncoder,
    Map,
    Set,
    Number,
    String,
    Array,
    Object,
    JSON,
    Error,
    TypeError,
  };
  vm.runInNewContext(script, context, { filename: 'component-sandbox.html' });
  messageListener?.({ source: parent, data: { type: 'michi-component:wrapper-init', channel: '0123456789abcdef0123456789abcdef' } });
  messageListener?.({ source: parent, data: { type: 'michi-component:load', channel: '0123456789abcdef0123456789abcdef', code: 'root.textContent = "safe";', props: {}, data: {} } });
  assert.ok(emittedWorker);
  const workerSource = emittedWorker.parts.join('');
  new vm.Script(workerSource, { filename: 'component-worker.js' });
});

test('sandbox bounds the live tree rather than cumulative node allocations', () => {
  const script = COMPONENT_SANDBOX_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  let messageListener: ((event: { source: unknown; data: unknown }) => void) | undefined;
  let workerInstance: CapturedWorkerForUpdates | undefined;
  const parent = { postMessage() {} };
  const root = { addEventListener() {}, replaceChildren() {}, appendChild() {} };
  class CapturedBlob { constructor(readonly parts: unknown[]) {} }
  class CapturedWorkerForUpdates {
    onerror?: (event: unknown) => void;
    onmessage?: (event: { data: unknown }) => void;
    constructor(blob: unknown) {
      const workerContext: Record<string, unknown> = {
        postMessage: (data: unknown) => this.onmessage?.({ data }),
        TextEncoder,
        Map,
        Set,
        Number,
        String,
        Array,
        Object,
        JSON,
        Error,
        TypeError,
        Promise,
        queueMicrotask,
        setTimeout: (fn: () => void) => { fn(); return 0; },
      };
      vm.runInNewContext((blob as CapturedBlob).parts.join(''), workerContext, { filename: 'component-worker.js' });
      this.dispatch = workerContext.onmessage as (event: { data: unknown }) => void;
      workerInstance = this;
    }
    dispatch: (event: { data: unknown }) => void = () => {};
    postMessage(data: unknown) { this.dispatch({ data }); }
    terminate() {}
  }
  const context = {
    document: { getElementById: () => root, createTextNode: () => ({}), createElement: () => ({}) },
    parent,
    addEventListener: (_type: string, listener: typeof messageListener) => { messageListener = listener; },
    Blob: CapturedBlob,
    Worker: CapturedWorkerForUpdates,
    URL: { createObjectURL: (blob: unknown) => blob, revokeObjectURL() {} },
    TextEncoder,
    Map,
    Set,
    Number,
    String,
    Array,
    Object,
    JSON,
    Error,
    TypeError,
  };
  vm.runInNewContext(script, context, { filename: 'component-sandbox.html' });
  messageListener?.({ source: parent, data: { type: 'michi-component:wrapper-init', channel: '0123456789abcdef0123456789abcdef' } });
  messageListener?.({
    source: parent,
    data: {
      type: 'michi-component:load',
      channel: '0123456789abcdef0123456789abcdef',
      code: 'root.appendChild(document.createElement("span")); globalThis.onMichiComponentUpdate = props => { if (props.oversize) root.replaceChildren(...Array.from({length: 2001}, () => document.createElement("span"))); else root.replaceChildren(document.createElement("span")); };',
      props: {},
      data: {},
    },
  });
  assert.ok(workerInstance);

  let lastMessage: Record<string, unknown> | undefined;
  workerInstance.onmessage = ({ data }) => {
    const message = data as Record<string, unknown>;
    lastMessage = message;
  };
  for (let index = 0; index < 2100; index += 1) {
    workerInstance.postMessage({ type: 'update', props: {}, data: {} });
  }
  assert.equal(lastMessage?.type, 'render');

  workerInstance.postMessage({
    type: 'update',
    props: { oversize: true },
    data: {},
  });
  assert.equal(lastMessage?.type, 'error');
  assert.match(String(lastMessage?.message), /render is too large/);
});

test('sandbox document takes the palette from its host, only known variables with safe values', () => {
  const script = COMPONENT_SANDBOX_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.match(COMPONENT_SANDBOX_HTML, /<style>[^<]*color:var\(--term-fg,CanvasText\)[^<]*var\(--ui-font,system-ui,sans-serif\)/);
  let messageListener: ((event: { source: unknown; data: unknown }) => void) | undefined;
  let workers = 0;
  const applied = new Map<string, string>();
  const parent = { postMessage() {} };
  const root = { addEventListener() {}, replaceChildren() {}, appendChild() {} };
  class CapturedWorker { constructor() { workers += 1; } postMessage() {} terminate() {} }
  const context = {
    document: {
      getElementById: () => root, createTextNode: () => ({}), createElement: () => ({}),
      documentElement: { style: { setProperty: (name: string, value: string) => { applied.set(name, value); }, removeProperty: (name: string) => { applied.delete(name); } } },
    },
    parent,
    addEventListener: (_type: string, listener: typeof messageListener) => { messageListener = listener; },
    Blob: class { constructor(readonly parts: unknown[]) {} },
    Worker: CapturedWorker,
    URL: { createObjectURL: (blob: unknown) => blob, revokeObjectURL() {} },
    TextEncoder, Map, Set, Number, String, Array, Object, JSON, Error, TypeError,
  };
  vm.runInNewContext(script, context, { filename: 'component-sandbox.html' });
  const channel = '0123456789abcdef0123456789abcdef';
  const send = (data: unknown) => messageListener?.({ source: parent, data });
  // Before the handshake binds a channel, and from anyone but the parent, nothing applies.
  send({ type: 'michi-component:theme', channel, theme: { '--term-fg': '#111111' } });
  messageListener?.({ source: {}, data: { type: 'michi-component:theme', channel, theme: { '--term-fg': '#111111' } } });
  send({ type: 'michi-component:wrapper-init', channel });
  send({ type: 'michi-component:theme', channel: 'f'.repeat(32), theme: { '--term-fg': '#111111' } });
  assert.equal(applied.size, 0);

  send({ type: 'michi-component:load', channel, code: 'root.textContent = "x";', props: {}, data: {}, theme: {
    '--term-fg': '#eeeeee', '--term-bg': 'url(https://t.example/track.png)', '--term-line': 'red;background:url(x)', '--other': '#000000', '--ui-font': "'Geist', system-ui",
  } });
  assert.equal(workers, 1);
  assert.deepEqual(Object.fromEntries(applied), { '--term-fg': '#eeeeee', '--ui-font': "'Geist', system-ui" });
  // Each theme is whole: what it leaves out, or would load something, goes back to the frame's default.
  send({ type: 'michi-component:theme', channel, theme: { '--term-fg': '#222222', '--term-accent': 'image-set("https://t.example/a.png" 1x)' } });
  assert.deepEqual(Object.fromEntries(applied), { '--term-fg': '#222222' });
  assert.equal(workers, 1);
});
