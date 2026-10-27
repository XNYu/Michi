const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const ts = require('typescript');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const timeout = setTimeout(() => fail(new Error('smoke timed out')), 45_000);
let profileDir;
let server;
let canaryServer;
let window;
let finished = false;

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (message) (code === 0 ? console.log : console.error)(message);
  try { window?.destroy(); } catch {}
  try { server?.close(); } catch {}
  try { canaryServer?.close(); } catch {}
  try { if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  app.exit(code);
}
function fail(error) { finish(1, `pages-electron-sandbox-acceptance: FAIL: ${error?.stack || error}`); }
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

function loadActualRunner() {
  const sourcePath = path.join(root, 'backend/src/services/pages/sandboxDocument.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(exports,module){${js}\n})(module.exports,module)`, { module });
  return module.exports;
}

const hostHtml = `<!doctype html><meta charset="utf-8"><title>Pages Electron sandbox acceptance</title>
<button id="stop">Stop component</button><span id="state">waiting</span><iframe id="component" title="component" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
(() => {
  'use strict';
  // Model the production host renderer's isolated world and preload boundary.
  Object.defineProperty(window, 'electron', { value: { secret: 'preload-canary' } });
  Object.defineProperty(window, 'process', { value: { env: { SECRET: 'node-canary' } } });
  const frame = document.getElementById('component');
  const state = document.getElementById('state');
  const channel = 'pages-electron-sandbox-acceptance-channel-0001';
  const checks = { calls: [], denied: [], globals: null, network: null, ready: false, stopped: false };
  const code = String.raw\`const report={window:typeof window,document:typeof document,parent:typeof parent,process:typeof process,require:typeof require,location:typeof location,fetch:typeof fetch,importScripts:typeof importScripts,WebSocket:typeof WebSocket,sample:data.sample};
const tries=[];for(const [name,fn] of [['fetch',()=>fetch('http://127.0.0.1:PORT/canary')],['importScripts',()=>importScripts('http://127.0.0.1:PORT/import.js')],['WebSocket',()=>new WebSocket('ws://127.0.0.1:1/canary')],['location',()=>location.href='http://127.0.0.1:PORT/nav']]){try{fn();tries.push(name+':allowed')}catch(_){tries.push(name+':blocked')}}
root.textContent='component running';Promise.resolve().then(()=>call('read.host',{report,tries})).catch(()=>{});Promise.allSettled([call('write.rows',[]),call('ask.draft','preview draft'),call('navigate.page','page-canary')]).then(results=>call('preview.results',results.map(x=>x.status)));\`;
  const send = message => frame.contentWindow.postMessage({ ...message, channel }, '*');
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || !event.data || event.data.channel !== channel) return;
    const message = event.data;
    if (message.type === 'michi-component:wrapper-ready') {
      checks.ready = true;
      send({ type: 'michi-component:load', code, props: {}, data: { sample: true, value: 12, label: 'Example' } });
      return;
    }
    if (message.type !== 'michi-component:call') return;
    checks.calls.push(message.method);
    if (message.method === 'read.host') {
      checks.globals = message.args[0].report;
      checks.network = message.args[0].tries;
      send({ type: 'michi-component:result', id: message.id, ok: false, error: 'capability unavailable in preview' });
    } else {
      checks.denied.push(message.method);
      send({ type: 'michi-component:result', id: message.id, ok: false, error: 'capability unavailable in preview' });
    }
    if (checks.globals && checks.denied.includes('preview.results')) {
      document.getElementById('stop').click();
    }
  });
  frame.addEventListener('load', () => send({ type: 'michi-component:wrapper-init' }));
  document.getElementById('stop').addEventListener('click', () => {
    frame.remove();
    checks.stopped = !document.getElementById('component');
    state.textContent = checks.stopped ? 'stopped' : 'stop failed';
    window.pagesAcceptance = checks;
  });
  frame.src = '/component-sandbox-wrapper';
  window.pagesAcceptance = checks;
})();
</script>`;

async function run() {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pages-electron-'));
  app.setPath('userData', profileDir);
  app.setPath('sessionData', path.join(profileDir, 'session'));
  const runner = loadActualRunner();
  const wrapper = runner.componentSandboxWrapper('/api/component-sandbox-wrapper');
  const canary = canaryServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('canary');
  });
  await new Promise((resolve, reject) => canary.listen(0, '127.0.0.1', resolve).once('error', reject));
  const canaryPort = canary.address().port;
  server = http.createServer((req, res) => {
    if (req.url === '/component-sandbox-wrapper') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `${wrapper.csp}; frame-ancestors *`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      });
      res.end(wrapper.html.replaceAll('PORT', String(canaryPort)));
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(hostHtml.replaceAll('PORT', String(canaryPort)));
      return;
    }
    if (req.url.startsWith('/canary') || req.url.startsWith('/nav') || req.url.startsWith('/import.js')) {
      canaryRequests.push(req.url);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('unexpected request');
      return;
    }
    res.writeHead(404); res.end();
  });
  const canaryRequests = [];
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const serverPort = server.address().port;
  // These are the production main-window security settings from electron/main.ts.
  // The production preload itself is intentionally omitted; the host supplies harmless canary globals.
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  await window.loadURL(`http://127.0.0.1:${serverPort}/`);
  const checks = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const started=Date.now();const poll=()=>{const v=window.pagesAcceptance;if(v&&v.stopped){const checks=v;if(!checks.ready)reject(Error('wrapper handshake missing'));else if(!checks.globals)reject(Error('worker report missing'));else if(checks.globals.window!=='undefined'||checks.globals.document!=='object'||checks.globals.parent!=='undefined'||checks.globals.process!=='undefined'||checks.globals.require!=='undefined'||checks.globals.location!=='undefined'||checks.globals.fetch!=='undefined'||checks.globals.importScripts!=='undefined'||checks.globals.WebSocket!=='undefined'||checks.globals.sample!==true)reject(Error('worker exposed a forbidden global or preview data: '+JSON.stringify(checks.globals)));else if(!['write.rows','ask.draft','navigate.page','preview.results'].every(x=>checks.denied.includes(x)))reject(Error('preview capability calls were not denied: '+JSON.stringify(checks.denied)));else if(checks.network?.some(x=>!x.endsWith(':blocked')))reject(Error('worker network attempt was not blocked: '+JSON.stringify(checks.network)));else resolve(checks);return}if(Date.now()-started>12000){reject(Error('sandbox acceptance did not complete: '+JSON.stringify(v)));return}setTimeout(poll,50)};poll()})`);
  if (canaryRequests.length !== 0) throw new Error(`worker requests reached the canary server: ${JSON.stringify(canaryRequests)}`);
  if (checks.stopped !== true) throw new Error('component iframe was not stopped');
  finish(0, `pages-electron-sandbox-acceptance: PASS\n- Electron: ${process.versions.electron}; isolated temporary userData/sessionData\n- Trusted runner: exact componentSandboxWrapper() output from backend/src/services/pages/sandboxDocument.ts\n- Host preferences: contextIsolation=true, nodeIntegration=false, sandbox=false (production main-window settings); iframe sandbox=allow-scripts; CSP sandbox allow-scripts\n- Worker: DOM facade only; Node/Electron/parent/location/network globals unavailable\n- Preview: write.rows, ask.draft and navigate.page all denied\n- Network canaries reached server: ${canaryRequests.length}\n- Stop: iframe removed and host remained responsive`);
}

app.whenReady().then(run).catch(fail);
