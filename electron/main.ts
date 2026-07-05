import { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, Notification as ElectronNotification } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { fork, ChildProcess } from 'child_process';
import {
  isStartupTraceLine,
  startupMark,
  startupRunId,
  startupTraceEnabled,
  startupTraceFileQuery,
  withStartupTraceQuery,
} from './startupTrace';

// Patch PATH from the user's login shell so the forked backend can find
// kiro-cli (common macOS issue when launched from Finder). fix-path v5 is
// ESM-only; use dynamic import so our CommonJS build doesn't fail at require.
(async () => {
  try {
    const mod = await import('fix-path');
    (mod.default ?? (mod as unknown as () => void))();
  } catch {
    /* best effort */
  }
})();

const isDev = process.env.ELECTRON_DEV === '1';

// True window vibrancy (see-through to desktop / other apps behind Michi) is a
// native macOS NSVisualEffectView feature. Off on Windows/Linux (no equivalent)
// and can be force-disabled with MICHI_NO_VIBRANCY=1 for debugging. The renderer
// reads this over `app:vibrancy` (sync) so it can punch the sidebar hole only
// when the window base is actually the vibrancy material — main authoritatively
// owns the flag so the CSS never assumes see-through the window doesn't have.
const VIBRANCY_ENABLED = process.platform === 'darwin' && process.env.MICHI_NO_VIBRANCY !== '1';

// Capture once at load — Electron may not chdir, but be defensive.
// `bin/michi` forwards the shell's pwd via `open --env MICHI_LAUNCH_CWD=…`
// because `open` doesn't inherit cwd. Direct `electron …` invocations
// fall back to process.cwd(). Finder launches give "/".
const LAUNCH_CWD = process.env.MICHI_LAUNCH_CWD || process.cwd();
startupMark('electron_main_start', { isDev, launchCwd: LAUNCH_CWD });

// Lifecycle log dir — same root as the SQLite store (~/.michi/) so a single
// "open log folder" button can take the user to everything they need to
// attach when reporting a startup issue. Override via MICHI_LOG_DIR for
// tests / debugging.
const LOG_DIR = process.env.MICHI_LOG_DIR || path.join(os.homedir(), '.michi', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* falls back to stdout */ }
const ELECTRON_LOG = path.join(LOG_DIR, 'electron-main.log');

function elog(level: 'INFO' | 'WARN' | 'ERROR', stage: string, msg: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  let metaStr = '';
  if (meta) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined) continue;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(`${k}=${s}`);
    }
    if (parts.length > 0) metaStr = ' ' + parts.join(' ');
  }
  const line = `${ts} ${level.padEnd(5, ' ')} ${stage.padEnd(10, ' ')} ${msg}${metaStr}\n`;
  try { fs.appendFileSync(ELECTRON_LOG, line); } catch { /* best effort */ }
  if (level === 'ERROR') process.stderr.write(line);
  else process.stdout.write(line);
}

const windows = new Set<BrowserWindow>();
const windowSlots = new WeakMap<BrowserWindow, number>();
let nextWindowSlot = 0;
let backendChild: ChildProcess | null = null;
let resolvedBackendPort: number | null = null;

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? windows.values().next().value ?? null;
}

interface WindowState {
  width: number;
  height: number;
  isMaximized: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1600, height: 1000, isMaximized: false };
const MIN_PERSISTED_WIDTH = 1000;
const MIN_PERSISTED_HEIGHT = 700;

function windowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function coerceWindowState(value: unknown): WindowState {
  if (value && typeof value === 'object') {
    const p = value as Record<string, unknown>;
    const w = typeof p.width === 'number' ? p.width : NaN;
    const h = typeof p.height === 'number' ? p.height : NaN;
    if (Number.isFinite(w) && Number.isFinite(h) && w >= MIN_PERSISTED_WIDTH && h >= MIN_PERSISTED_HEIGHT) {
      return {
        width: Math.round(w),
        height: Math.round(h),
        isMaximized: !!p.isMaximized,
      };
    }
  }
  return DEFAULT_WINDOW_STATE;
}

function loadWindowStates(): WindowState[] {
  try {
    const raw = fs.readFileSync(windowStateFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(coerceWindowState);
    if (parsed && typeof parsed === 'object') return [coerceWindowState(parsed)];
  } catch {
    /* fall through to defaults */
  }
  return [];
}

function loadWindowState(slot: number): WindowState {
  return loadWindowStates()[slot] ?? DEFAULT_WINDOW_STATE;
}

function captureWindowState(win: BrowserWindow): WindowState | null {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getNormalBounds();
  return {
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  };
}

function writeWindowStateForSlot(slot: number, state: WindowState): void {
  try {
    const states = loadWindowStates();
    while (states.length <= slot) states.push(DEFAULT_WINDOW_STATE);
    states[slot] = state;
    const file = windowStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(states));
  } catch {
    /* best effort */
  }
}

const windowStateSaveTimers = new WeakMap<BrowserWindow, NodeJS.Timeout>();
function scheduleSaveWindowState(win: BrowserWindow): void {
  const existing = windowStateSaveTimers.get(win);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    windowStateSaveTimers.delete(win);
    const state = captureWindowState(win);
    const slot = windowSlots.get(win);
    if (state && slot !== undefined) writeWindowStateForSlot(slot, state);
  }, 300);
  windowStateSaveTimers.set(win, timer);
}

function flushWindowState(win: BrowserWindow): void {
  const existing = windowStateSaveTimers.get(win);
  if (existing) {
    clearTimeout(existing);
    windowStateSaveTimers.delete(win);
  }
  const state = captureWindowState(win);
  const slot = windowSlots.get(win);
  if (state && slot !== undefined) writeWindowStateForSlot(slot, state);
}

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
  return n;
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

const PORT_FILE = path.join(os.homedir(), '.michi', 'backend-port');

async function chooseBackendPort(): Promise<number> {
  const envPort = parsePort(process.env.MICHI_PORT) ?? parsePort(process.env.PORT);
  if (envPort) return envPort;

  // Reuse the previously persisted port so the origin stays stable and
  // localStorage (prefs, workspace state) survives across restarts.
  try {
    const saved = parsePort(fs.readFileSync(PORT_FILE, 'utf8').trim());
    if (saved && await isPortAvailable(saved)) return saved;
  } catch { /* no saved port or unreadable — pick a new one */ }

  const port = await findAvailablePort();
  try { fs.writeFileSync(PORT_FILE, String(port), 'utf8'); } catch { /* best-effort */ }
  return port;
}

async function waitForBackend(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Backend did not become ready on port ${port}`));
        return;
      }
      setTimeout(attempt, 150);
    };

    const attempt = () => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/api/health', timeout: 1000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', retry);
    };

    attempt();
  });
}

/**
 * Mirror of backend/src/services/acpClient.ts findKiroCli() for the
 * packaged-default decision. Kept in sync by hand — both probes look in
 * the same set of locations.
 */
function probeKiroCli(): boolean {
  const env = process.env.KIRO_CLI_BIN;
  if (env && fs.existsSync(env)) return true;
  const home = os.homedir();

  const local = path.join(home, '.local', 'bin', 'kiro-cli');
  if (fs.existsSync(local)) {
    try { fs.accessSync(local, fs.constants.X_OK); return true; } catch { /* fall through */ }
  }

  const toolsDir = path.join(home, '.toolbox', 'tools', 'kiro-cli');
  try {
    for (const v of fs.readdirSync(toolsDir)) {
      const cand = path.join(toolsDir, v, 'Kiro CLI.app', 'Contents', 'MacOS', 'kiro-cli');
      if (fs.existsSync(cand)) {
        try { fs.accessSync(cand, fs.constants.X_OK); return true; } catch { /* fall through */ }
      }
    }
  } catch { /* toolsDir may not exist */ }

  for (const p of (process.env.PATH || '').split(':')) {
    if (!p) continue;
    const cand = path.join(p, 'kiro-cli');
    if (fs.existsSync(cand)) {
      try { fs.accessSync(cand, fs.constants.X_OK); return true; } catch { /* fall through */ }
    }
  }

  const toolboxBin = path.join(home, '.toolbox', 'bin', 'kiro-cli');
  if (fs.existsSync(toolboxBin)) {
    try { fs.accessSync(toolboxBin, fs.constants.X_OK); return true; } catch { /* fall through */ }
  }

  return false;
}

function resolveBackendEntry(): string | null {
  // In dev mode backend runs via nodemon externally; don't fork.
  if (isDev) return null;
  // In packaged prod, app.getAppPath() resolves inside the asar.
  const candidate = path.join(app.getAppPath(), 'backend', 'dist', 'server.js');
  if (!fs.existsSync(candidate)) return null;
  return candidate;
}

async function startBackend(): Promise<number | null> {
  const entry = resolveBackendEntry();
  if (!entry) {
    startupMark('backend_external_dev', { isDev });
    return null;
  }
  const port = await chooseBackendPort();

  // Packaged builds fall back to Pi only when kiro-cli is not installed, so
  // the dmg works for users without kiro-cli while developers with kiro-cli on
  // disk still get the kiro default. Dev keeps the agentConfig default (Kiro)
  // unless the developer explicitly sets MICHI_AGENT_RUNTIME. We pass via
  // MICHI_DEFAULT_RUNTIME (read by agentConfig.ts) so an existing on-disk
  // config still wins — only first-run packaged builds with no config see
  // this default.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    MICHI_LOG_DIR: LOG_DIR,
    MICHI_LAUNCH_CWD: LAUNCH_CWD,
  };
  if (startupTraceEnabled()) {
    env.MICHI_STARTUP_TRACE = '1';
    env.MICHI_STARTUP_RUN_ID = startupRunId();
  }
  if (app.isPackaged && env.MICHI_DEFAULT_RUNTIME == null && !probeKiroCli()) {
    env.MICHI_DEFAULT_RUNTIME = 'pi';
    elog('INFO', 'boot', 'kiro-cli not detected, defaulting runtime to pi');
  }

  elog('INFO', 'boot', 'forking backend', { entry, port });
  startupMark('backend_fork_start', { entry, port });
  backendChild = fork(entry, [], {
    env,
    silent: false,
    stdio: 'inherit',
  });
  backendChild.on('exit', (code, signal) => {
    elog('WARN', 'boot', 'backend child exited', { code, signal });
    backendChild = null;
  });
  try {
    startupMark('backend_health_wait_start', { port });
    await waitForBackend(port);
    elog('INFO', 'boot', 'backend ready', { port });
    startupMark('backend_health_ready', { port });
  } catch (err) {
    elog('ERROR', 'boot', 'backend did not become ready', { port, err: (err as Error).message });
    startupMark('backend_health_failed', { port, error: (err as Error).message });
    throw err;
  }
  return port;
}

async function stopBackend(): Promise<void> {
  if (!backendChild) return;
  const child = backendChild;
  backendChild = null;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { resolve(); }
  });
}

// Custom application menu. macOS's default menu binds Cmd+W to "Close Window",
// which intercepts the accelerator before the renderer can use it for "close
// focused pane". We rebuild the menu mirroring the platform default but bind
// "Close Window" to Shift+Cmd+W (Chrome/Safari convention) so plain Cmd+W
// falls through as a normal keydown that TerminalShell handles.
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => { void createWindow(resolvedBackendPort); },
        },
        { type: 'separator' },
        isMac
          ? { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' }
          : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: () => { void shell.openExternal('https://github.com/'); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(backendPort: number | null): Promise<void> {
  const slot = nextWindowSlot++;
  const savedState = loadWindowState(slot);
  const cascade = slot * 32;
  const windowId = `win-${slot}`;
  startupMark('browser_window_create_start', { backendPort, slot });
  const win = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    ...(cascade > 0 ? { x: 80 + cascade, y: 80 + cascade } : {}),
    minWidth: 360,
    minHeight: 480,
    show: false,
    // With vibrancy on: the NSVisualEffectView material IS the window base and
    // provides its own alpha, so the desktop shows through wherever the DOM is
    // transparent. Do NOT also set `transparent: true` — that makes a hard-alpha
    // window that SUPPRESSES the material (looks flat/opaque). backgroundColor
    // must be fully transparent so no solid layer paints over the material.
    // Without vibrancy, keep the warm opaque background (web/Win/Linux path).
    // 'under-window' is the lightest / most see-through NSVisualEffectView
    // material — the desktop shows through much more than 'sidebar' (which is
    // a denser frost). Still frosted (macOS has no fully-clear vibrancy
    // material), just far more transparent.
    ...(VIBRANCY_ENABLED
      ? {
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : { backgroundColor: '#F5F2EE' }),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Streaming output should keep draining even when the app is behind
      // another window; otherwise Chromium pauses rAF/timers and the UI
      // replays a stale typewriter backlog when the window returns.
      backgroundThrottling: false,
    },
  });
  windows.add(win);
  windowSlots.set(win, slot);
  startupMark('browser_window_created', { backendPort, slot });

  if (savedState.isMaximized) {
    win.maximize();
  }

  win.on('resize', () => scheduleSaveWindowState(win));
  win.on('maximize', () => scheduleSaveWindowState(win));
  win.on('unmaximize', () => scheduleSaveWindowState(win));
  win.on('close', () => flushWindowState(win));

  win.once('ready-to-show', () => {
    startupMark('window_ready_to_show', { slot });
    win.show();
  });

  win.webContents.on('did-finish-load', () => {
    startupMark('renderer_did_finish_load', { slot });
  });

  win.webContents.on('console-message', (_event, _level, message) => {
    if (isStartupTraceLine(message)) {
      process.stdout.write(`${message}\n`);
    }
  });

  // Route all external links to the system browser. The app itself loads
  // localhost:3001 (dev) or 127.0.0.1:<port> (prod); anything else — http(s)
  // links inside chat content, markdown, etc. — should never replace the app
  // window or pop a child Electron window.
  const isInternalUrl = (url: string): boolean => {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return true;
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  const withWindowId = (base: string): string => {
    const url = new URL(base);
    url.searchParams.set('michiWindowId', windowId);
    return url.toString();
  };

  if (isDev) {
    const url = withWindowId('http://localhost:3001');
    startupMark('renderer_load_start', { url, slot });
    await win.loadURL(withStartupTraceQuery(url));
    startupMark('renderer_load_done', { slot });
    // DevTools only opens when explicitly requested. Set
    // ELECTRON_OPEN_DEVTOOLS=1 in the environment to auto-open; otherwise
    // use Cmd+Opt+I / View → Toggle Developer Tools.
    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    if (backendPort) {
      const url = withWindowId(`http://127.0.0.1:${backendPort}`);
      startupMark('renderer_load_start', { url, slot });
      await win.loadURL(withStartupTraceQuery(url));
      startupMark('renderer_load_done', { slot });
    } else {
      const indexPath = path.join(app.getAppPath(), 'frontend', 'build', 'index.html');
      startupMark('renderer_load_start', { file: indexPath, slot });
      await win.loadFile(indexPath, {
        query: { ...(startupTraceFileQuery() ?? {}), michiWindowId: windowId },
      });
      startupMark('renderer_load_done', { slot });
    }
  }

  win.on('closed', () => {
    windows.delete(win);
    windowSlots.delete(win);
  });
}

function pickerDefaultPath(): string {
  if (LAUNCH_CWD && LAUNCH_CWD !== '/' && LAUNCH_CWD !== path.sep) return LAUNCH_CWD;
  return app.getPath('home');
}

ipcMain.handle('app:chooseFolder', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: pickerDefaultPath(),
  });
  if (r.canceled || r.filePaths.length === 0) {
    return { canceled: true };
  }
  const p = r.filePaths[0];
  return {
    canceled: false,
    path: p,
    name: path.basename(p),
  };
});

// Mint a per-project scratch cwd outside macOS-protected directories so
// kiro-cli doesn't trip TCC prompts when the user skips folder selection.
ipcMain.handle('app:resolveSkipCwd', async (_ev, projectId: string) => {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('resolveSkipCwd: projectId required');
  }
  const safeId = projectId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const target = path.join(app.getPath('home'), '.michi', 'workspaces', safeId);
  await fs.promises.mkdir(target, { recursive: true });
  return { path: target };
});

// Open an absolute path with the OS default app. Used by the Contexts list
// to open pinned files on click; the path is the resolved cwd-relative path
// the renderer already has, so no extra validation is needed beyond the
// shell call's own existence check.
ipcMain.handle('app:openPath', async (_ev, absPath: string) => {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, error: 'absPath required' };
  }
  const err = await shell.openPath(absPath);
  if (err) return { ok: false, error: err };
  return { ok: true };
});

ipcMain.handle('app:chooseFiles', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    defaultPath: pickerDefaultPath(),
  });
  if (r.canceled || r.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, paths: r.filePaths };
});

ipcMain.handle('app:saveMarkdown', async (_ev, suggestedName: string, content: string) => {
  const r = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  await fs.promises.writeFile(r.filePath, content, 'utf8');
  return { canceled: false, path: r.filePath };
});

// OS-level notification triggered from the renderer via preload bridge.
ipcMain.on('app:showNotification', (_ev, title: string, body: string) => {
  const n = new ElectronNotification({ title, body });
  n.on('click', () => {
    focusedWindow()?.focus();
  });
  n.show();
});

// Relaunch the app (used after self-update).
ipcMain.on('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// Synchronous channel so the renderer can decide at first paint whether to
// render packaged-only UI (e.g. Update & Restart) without an async round trip.
ipcMain.on('app:isPackaged', (ev) => {
  ev.returnValue = app.isPackaged;
});

// Synchronous so the renderer can set the see-through hole-punch on <html>
// before first paint — otherwise the sidebar would flash opaque then turn
// transparent. Only true on macOS Electron; the CSS reads this to switch the
// sidebar from CSS-glass (blur its own wash) to real window vibrancy.
ipcMain.on('app:vibrancy', (ev) => {
  ev.returnValue = VIBRANCY_ENABLED;
});

// The NSVisualEffectView material's light/dark is chosen by the OS window
// appearance, NOT by Michi's CSS palette. So a dark palette (monokai/gruvbox)
// would otherwise get a LIGHT frost and read wrong. The renderer reports its
// palette darkness here; we set themeSource so the material matches. Safe:
// the frontend has zero `prefers-color-scheme` rules, so forcing the OS theme
// source only affects the native chrome (traffic lights + vibrancy), not the
// palette-token-driven UI. No-op off macOS.
ipcMain.on('app:setDarkMaterial', (_ev, dark: boolean) => {
  if (!VIBRANCY_ENABLED) return;
  nativeTheme.themeSource = dark ? 'dark' : 'light';
});

async function installDevExtensions(): Promise<void> {
  if (!isDev) return;
  try {
    const { downloadChromeExtension } = await import(
      'electron-devtools-installer/dist/downloadChromeExtension'
    ) as { downloadChromeExtension: (id: string, opts?: { forceDownload?: boolean }) => Promise<string> };
    const REACT_DEVELOPER_TOOLS_ID = 'fmkadmapgofadopljbjfkapdkoienihi';
    const { session } = await import('electron');
    const target = session.defaultSession;
    const extensions = target.extensions ?? (target as unknown as { extensions: { getAllExtensions: () => { id: string; name: string }[]; loadExtension: (path: string, opts?: { allowFileAccess?: boolean }) => Promise<{ name: string }> } }).extensions;
    const already = extensions.getAllExtensions().find((e: { id: string }) => e.id === REACT_DEVELOPER_TOOLS_ID);
    const folder = already ? null : await downloadChromeExtension(REACT_DEVELOPER_TOOLS_ID);
    const ext = already ?? (folder ? await extensions.loadExtension(folder, { allowFileAccess: true }) : null);
    if (ext) console.log(`[devtools] installed ${ext.name}`);
  } catch (err) {
    console.warn('[devtools] failed to install React DevTools:', err);
  }
}

// Single-instance lock: when `michi` (CLI) and Spotlight both launch the same
// bundle, the second invocation should activate the existing window instead
// of spawning a duplicate backend + window. Acquired before whenReady so
// rejected instances exit cleanly without booting the backend.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.on('second-instance', () => {
  void createWindow(resolvedBackendPort);
});

app.whenReady().then(async () => {
  elog('INFO', 'boot', 'app ready', { isDev, isPackaged: app.isPackaged, logDir: LOG_DIR, launchCwd: LAUNCH_CWD });
  startupMark('electron_app_ready', { isDev, isPackaged: app.isPackaged, logDir: LOG_DIR });
  try {
    // In dev the bare `electron` binary uses Electron's default dock icon —
    // override it so `npm run electron:dev` matches the packaged app.
    if (isDev && process.platform === 'darwin' && app.dock) {
      const devIcon = path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.png');
      if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
    }
    buildAppMenu();
    const backendPort = await startBackend();
    resolvedBackendPort = backendPort;
    await installDevExtensions();
    await createWindow(backendPort);
    elog('INFO', 'boot', 'window created', { backendPort });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow(resolvedBackendPort);
    });
  } catch (err) {
    elog('ERROR', 'boot', 'startup failed', { err: (err as Error).message, stack: (err as Error).stack });
    throw err;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void app.quit();
  }
});

app.on('before-quit', async (ev) => {
  if (backendChild) {
    ev.preventDefault();
    elog('INFO', 'boot', 'stopping backend on quit');
    await stopBackend();
    app.quit();
  }
});

// Reveal the log directory in Finder so the user can attach files when
// reporting a "michi didn't start" issue. Kept synchronous so the renderer
// can call it from a menu item without round-tripping data.
ipcMain.handle('app:openLogFolder', async () => {
  await shell.openPath(LOG_DIR);
  return { path: LOG_DIR };
});

ipcMain.handle('app:getLogPaths', async () => {
  return {
    logDir: LOG_DIR,
    electronLog: ELECTRON_LOG,
    backendLog: path.join(LOG_DIR, 'backend.log'),
    kiroCliLog: path.join(LOG_DIR, 'kiro-cli.log'),
  };
});
