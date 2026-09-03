import { app, BrowserWindow, Menu, WebContentsView, ipcMain, dialog, shell, nativeTheme, powerSaveBlocker, Notification as ElectronNotification } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { execFile, fork, ChildProcess } from 'child_process';
import {
  isStartupTraceLine,
  startupMark,
  startupRunId,
  startupTraceEnabled,
  startupTraceFileQuery,
  withStartupTraceQuery,
} from './startupTrace';
import { checkForUpdate, initAutoUpdate } from './autoUpdate';
import { isClosePaneShortcut } from './paneShortcuts';
import { listWorkspaceDirectory, resolveAllowedDirectory } from './workspaceFiles';
import { applyBrowserTheme, normalizeBrowserTheme, type BrowserTheme } from './browserTheme';

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

// Bare Electron uses one global userData directory by default. Without an
// override, a dev process from another checkout owns the single-instance lock
// and receives this checkout's second-instance event. Keep each checkout's
// localStorage/session/lock isolated; packaged Michi retains its normal path.
if (isDev && process.env.MICHI_ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MICHI_ELECTRON_USER_DATA_DIR));
}

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

// Power-save blocker — prevents macOS/Windows from sleeping while Michi is
// running (useful during long agent sessions). Controlled exclusively via
// ~/.michi/config.json top-level key "preventSleep": true. No UI toggle.
let powerSaveBlockerId: number | null = null;

function readPreventSleep(): boolean {
  try {
    const cfgPath = path.join(os.homedir(), '.michi', 'config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return raw?.preventSleep === true;
  } catch {
    return false;
  }
}

function applyPowerSaveBlocker(): void {
  const wanted = readPreventSleep();
  if (wanted && powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    elog('INFO', 'power', 'powerSaveBlocker started', { id: powerSaveBlockerId });
  } else if (!wanted && powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    elog('INFO', 'power', 'powerSaveBlocker stopped', { id: powerSaveBlockerId });
    powerSaveBlockerId = null;
  }
}

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

const MAX_TERMINAL_REPLAY_CHARS = 1024 * 1024;

interface TerminalSurface {
  ownerId: number;
  process: pty.IPty;
  replay: string;
  exited: boolean;
  exitCode?: number;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
}

interface BrowserSurface {
  ownerId: number;
  host: BrowserWindow;
  view: WebContentsView;
  surfaceId: string;
  error?: string;
}

const terminalSurfaces = new Map<string, TerminalSurface>();
const browserSurfaces = new Map<string, BrowserSurface>();
let currentBrowserTheme: BrowserTheme = normalizeBrowserTheme(nativeTheme.shouldUseDarkColors, undefined);

function surfaceKey(ownerId: number, surfaceId: string): string {
  return `${ownerId}:${surfaceId}`;
}

function validSurfaceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

function normalizeSurfaceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function browserState(surface: BrowserSurface) {
  const contents = surface.view.webContents;
  return {
    surfaceId: surface.surfaceId,
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    ...(surface.error ? { error: surface.error } : {}),
  };
}

function emitBrowserState(surface: BrowserSurface): void {
  if (!surface.host.isDestroyed()) {
    surface.host.webContents.send('browser:state', browserState(surface));
  }
}

async function syncBrowserTheme(surface: BrowserSurface): Promise<void> {
  try {
    await applyBrowserTheme(surface.view, currentBrowserTheme);
  } catch (error) {
    elog('WARN', 'browser', 'failed to apply browser color scheme', {
      surfaceId: surface.surfaceId,
      colorScheme: currentBrowserTheme.colorScheme,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function destroyBrowserSurface(key: string): void {
  const surface = browserSurfaces.get(key);
  if (!surface) return;
  browserSurfaces.delete(key);
  try { surface.host.contentView.removeChildView(surface.view); } catch { /* already detached */ }
  try { surface.view.webContents.close(); } catch { /* already destroyed */ }
}

function destroyTerminalSurface(key: string): void {
  const surface = terminalSurfaces.get(key);
  if (!surface) return;
  terminalSurfaces.delete(key);
  if (surface.flushTimer) clearTimeout(surface.flushTimer);
  try { surface.process.kill(); } catch { /* already exited */ }
}

function destroyOwnedSurfaces(ownerId: number): void {
  for (const [key, surface] of terminalSurfaces) {
    if (surface.ownerId === ownerId) destroyTerminalSurface(key);
  }
  for (const [key, surface] of browserSurfaces) {
    if (surface.ownerId === ownerId) destroyBrowserSurface(key);
  }
}

ipcMain.handle('terminal:create', (event, surfaceId: unknown, cwd: unknown, cols: unknown, rows: unknown) => {
  if (!validSurfaceId(surfaceId)) throw new Error('Invalid terminal surface id');
  const key = surfaceKey(event.sender.id, surfaceId);
  const existing = terminalSurfaces.get(key);
  if (existing) {
    return { surfaceId, data: existing.replay, exited: existing.exited, exitCode: existing.exitCode };
  }
  const requestedCwd = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : os.homedir();
  const safeCwd = (() => {
    try { return fs.statSync(requestedCwd).isDirectory() ? requestedCwd : os.homedir(); }
    catch { return os.homedir(); }
  })();
  const shellPath = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const processHandle = pty.spawn(shellPath, process.platform === 'win32' ? [] : ['-l'], {
    name: 'xterm-256color',
    cols: typeof cols === 'number' ? Math.max(2, Math.floor(cols)) : 80,
    rows: typeof rows === 'number' ? Math.max(1, Math.floor(rows)) : 24,
    cwd: safeCwd,
    env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  const surface: TerminalSurface = {
    ownerId: event.sender.id,
    process: processHandle,
    replay: '',
    exited: false,
    pending: '',
    flushTimer: null,
  };
  terminalSurfaces.set(key, surface);
  processHandle.onData((data) => {
    surface.replay = (surface.replay + data).slice(-MAX_TERMINAL_REPLAY_CHARS);
    surface.pending += data;
    if (surface.flushTimer) return;
    surface.flushTimer = setTimeout(() => {
      surface.flushTimer = null;
      const chunk = surface.pending;
      surface.pending = '';
      if (!event.sender.isDestroyed() && chunk) event.sender.send('terminal:data', surfaceId, chunk);
    }, 8);
  });
  processHandle.onExit(({ exitCode }) => {
    surface.exited = true;
    surface.exitCode = exitCode;
    if (!event.sender.isDestroyed()) event.sender.send('terminal:exit', surfaceId, exitCode);
  });
  return { surfaceId, data: '', exited: false };
});

ipcMain.on('terminal:write', (event, surfaceId: unknown, data: unknown) => {
  if (!validSurfaceId(surfaceId) || typeof data !== 'string') return;
  const surface = terminalSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (surface && !surface.exited) surface.process.write(data);
});

ipcMain.on('terminal:resize', (event, surfaceId: unknown, cols: unknown, rows: unknown) => {
  if (!validSurfaceId(surfaceId) || typeof cols !== 'number' || typeof rows !== 'number') return;
  const surface = terminalSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface || surface.exited) return;
  try { surface.process.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows))); } catch { /* process exited */ }
});

ipcMain.on('terminal:destroy', (event, surfaceId: unknown) => {
  if (validSurfaceId(surfaceId)) destroyTerminalSurface(surfaceKey(event.sender.id, surfaceId));
});

ipcMain.handle('browser:create', async (event, surfaceId: unknown, projectId: unknown, rawUrl: unknown) => {
  if (!validSurfaceId(surfaceId)) throw new Error('Invalid browser surface id');
  const url = normalizeSurfaceUrl(rawUrl);
  if (!url) throw new Error('Only HTTP(S) URLs are supported');
  const host = BrowserWindow.fromWebContents(event.sender);
  if (!host) throw new Error('Browser host window not found');
  const key = surfaceKey(event.sender.id, surfaceId);
  let surface = browserSurfaces.get(key);
  if (!surface) {
    const partitionSuffix = String(projectId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `persist:michi-browser-${partitionSuffix}`,
      },
    });
    surface = { ownerId: event.sender.id, host, view, surfaceId };
    browserSurfaces.set(key, surface);
    host.contentView.addChildView(view);
    view.setVisible(false);
    // A brand-new WebContentsView does not have a fully initialized CDP target
    // until its first navigation. Prime it before registering state listeners
    // so the internal about:blank never leaks into renderer pane metadata.
    view.setBackgroundColor(currentBrowserTheme.backgroundColor);
    await view.webContents.loadURL('about:blank');
    await syncBrowserTheme(surface);
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      const next = normalizeSurfaceUrl(popupUrl);
      if (next) void view.webContents.loadURL(next);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (navEvent, target) => {
      if (!normalizeSurfaceUrl(target)) navEvent.preventDefault();
    });
    const syncState = () => {
      surface!.error = undefined;
      emitBrowserState(surface!);
    };
    view.webContents.on('did-start-loading', syncState);
    view.webContents.on('did-stop-loading', syncState);
    view.webContents.on('did-navigate', syncState);
    view.webContents.on('did-navigate-in-page', syncState);
    view.webContents.on('page-title-updated', syncState);
    view.webContents.on('focus', () => {
      if (!host.isDestroyed()) host.webContents.send('browser:focus', surfaceId);
    });
    view.webContents.on('before-input-event', (inputEvent, input) => {
      if (!isClosePaneShortcut(input)) return;
      inputEvent.preventDefault();
      if (!host.isDestroyed()) host.webContents.send('browser:close-request', surfaceId);
    });
    view.webContents.on('did-fail-load', (_loadEvent, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      surface!.error = `${description} (${code})`;
      emitBrowserState(surface!);
      elog('WARN', 'browser', 'surface navigation failed', { failedUrl, code, description });
    });
  }
  if (surface.view.webContents.getURL() !== url) await surface.view.webContents.loadURL(url);
  return browserState(surface);
});

ipcMain.handle('browser:navigate', async (event, surfaceId: unknown, rawUrl: unknown) => {
  if (!validSurfaceId(surfaceId)) throw new Error('Invalid browser surface id');
  const url = normalizeSurfaceUrl(rawUrl);
  if (!url) throw new Error('Only HTTP(S) URLs are supported');
  const surface = browserSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface) throw new Error('Browser surface not found');
  surface.error = undefined;
  await surface.view.webContents.loadURL(url);
  return browserState(surface);
});

ipcMain.on('browser:set-bounds', (event, surfaceId: unknown, value: unknown, visible: unknown) => {
  if (!validSurfaceId(surfaceId) || !value || typeof value !== 'object') return;
  const surface = browserSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface) return;
  const rect = value as Record<string, unknown>;
  if (![rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return;
  const bounds = {
    x: Math.round(rect.x as number),
    y: Math.round(rect.y as number),
    width: Math.max(1, Math.round(rect.width as number)),
    height: Math.max(1, Math.round(rect.height as number)),
  };
  surface.view.setBounds(bounds);
  surface.view.setVisible(visible === true && bounds.width > 1 && bounds.height > 1);
});

for (const [channel, action] of [
  ['browser:back', 'back'],
  ['browser:forward', 'forward'],
  ['browser:reload', 'reload'],
  ['browser:stop', 'stop'],
] as const) {
  ipcMain.on(channel, (event, surfaceId: unknown) => {
    if (!validSurfaceId(surfaceId)) return;
    const surface = browserSurfaces.get(surfaceKey(event.sender.id, surfaceId));
    if (!surface) return;
    const contents = surface.view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
  });
}

ipcMain.on('browser:destroy', (event, surfaceId: unknown) => {
  if (validSurfaceId(surfaceId)) destroyBrowserSurface(surfaceKey(event.sender.id, surfaceId));
});

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

function isExecutable(cand: string): boolean {
  if (!fs.existsSync(cand)) return false;
  if (process.platform === 'win32') return true;
  try { fs.accessSync(cand, fs.constants.X_OK); return true; } catch { return false; }
}

function candidateBinNames(binName: string): string[] {
  if (process.platform !== 'win32' || path.extname(binName)) return [binName];
  return [`${binName}.exe`, `${binName}.cmd`, `${binName}.bat`, binName];
}

function probePath(binName: string): boolean {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    if (candidateBinNames(binName).some((name) => isExecutable(path.join(dir, name)))) return true;
  }
  return false;
}

function probeNamedBins(binName: string, extraFiles: string[] = []): boolean {
  if (probePath(binName)) return true;
  const home = os.homedir();
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.toolbox', 'bin'),
    path.join(home, '.npm-global', 'bin'),
  ];
  const extras = [...extraFiles];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.unshift(path.join(localAppData, 'Toolbox', 'bin'));
    dirs.push(path.join(appData, 'npm'));
  } else {
    extras.push(`/usr/local/bin/${binName}`, `/opt/homebrew/bin/${binName}`);
  }
  if (dirs.some((dir) => candidateBinNames(binName).some((name) => isExecutable(path.join(dir, name))))) {
    return true;
  }
  return extras.some((cand) => fs.existsSync(cand));
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

  if (probeNamedBins('kiro-cli')) return true;

  if (process.platform === 'darwin') {
    const toolsDir = path.join(home, '.toolbox', 'tools', 'kiro-cli');
    try {
      for (const v of fs.readdirSync(toolsDir)) {
        const cand = path.join(toolsDir, v, 'Kiro CLI.app', 'Contents', 'MacOS', 'kiro-cli');
        if (isExecutable(cand)) return true;
      }
    } catch { /* toolsDir may not exist */ }
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    if (candidateBinNames('kiro-cli').some((name) => isExecutable(path.join(localAppData, 'Kiro-Cli', name)))) {
      return true;
    }
    const toolsDir = path.join(localAppData, 'Toolbox', 'tools', 'kiro-cli');
    try {
      for (const v of fs.readdirSync(toolsDir)) {
        if (candidateBinNames('kiro-cli').some((name) => isExecutable(path.join(toolsDir, v, name)))) {
          return true;
        }
      }
    } catch { /* toolsDir may not exist */ }
  }

  return false;
}

/**
 * Mirror of backend/src/agents/codex/codexBinary.ts findCodexBinary() for
 * the packaged-default decision. Kept in sync by hand.
 */
function probeCodexCli(): boolean {
  const env = process.env.CODEX_CLI_BIN;
  if (env && fs.existsSync(env)) return true;
  return probeNamedBins('codex', [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ]);
}

/**
 * Mirror of backend/src/agents/claude/claudeBinary.ts findClaudeBinary()
 * for the packaged-default decision. Kept in sync by hand.
 */
function probeClaudeCli(): boolean {
  const env = process.env.CLAUDE_CLI_BIN;
  if (env && fs.existsSync(env)) return true;
  return probeNamedBins('claude');
}

/**
 * Pick the packaged-app default runtime: first CLI detected in preference
 * order codex → claude → kiro, falling back to the CLI-less `pi` runtime.
 */
function detectDefaultRuntime(): string {
  if (probeCodexCli()) return 'codex';
  if (probeClaudeCli()) return 'claude';
  if (probeKiroCli()) return 'kiro';
  return 'pi';
}

/**
 * Load a .env file into an object (does NOT pollute process.env).
 * Supports KEY=VALUE, KEY="VALUE", KEY='VALUE', comments (#), blank lines.
 * Returns an empty object if the file doesn't exist or is unreadable.
 */
function loadDotenv(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return result;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
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

  // Load ~/.michi/.env so users can persist runtime API keys in one place
  // that works regardless of launch method (terminal, Dock, Spotlight).
  // Values from this file do NOT override existing process.env entries —
  // explicit env vars and launchctl setenv still take precedence.
  const michiEnvPath = path.join(os.homedir(), '.michi', '.env');
  const userDotenv = loadDotenv(michiEnvPath);
  const userDotenvKeys = Object.keys(userDotenv);
  if (userDotenvKeys.length > 0) {
    elog('INFO', 'boot', 'loaded ~/.michi/.env', { keys: userDotenvKeys.length });
  }

  // Packaged builds fall back to Pi only when kiro-cli is not installed, so
  // the dmg works for users without kiro-cli while developers with kiro-cli on
  // disk still get the kiro default. Dev keeps the agentConfig default (Kiro)
  // unless the developer explicitly sets MICHI_AGENT_RUNTIME. We pass via
  // MICHI_DEFAULT_RUNTIME (read by agentConfig.ts) so an existing on-disk
  // config still wins — only first-run packaged builds with no config see
  // this default.
  const env: NodeJS.ProcessEnv = {
    ...userDotenv,
    ...process.env,
    PORT: String(port),
    MICHI_LOG_DIR: LOG_DIR,
    MICHI_LAUNCH_CWD: LAUNCH_CWD,
  };
  if (startupTraceEnabled()) {
    env.MICHI_STARTUP_TRACE = '1';
    env.MICHI_STARTUP_RUN_ID = startupRunId();
  }
  if (app.isPackaged && env.MICHI_DEFAULT_RUNTIME == null) {
    const detected = detectDefaultRuntime();
    env.MICHI_DEFAULT_RUNTIME = detected;
    elog('INFO', 'boot', 'default runtime detected', { runtime: detected });
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
            {
              label: 'Check for Updates…',
              click: () => { void checkForUpdate(); },
            },
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
    // visualEffectState 'followWindow' (the macOS default): the material is
    // active/see-through only while the window is focused, and goes muted/opaque
    // when Michi is in the background. This is the native NSVisualEffectView
    // behavior (Finder, Notes) and gives a clear focus cue in a multi-window
    // setup — the front window "glows" glassy, background ones recede.
    ...(VIBRANCY_ENABLED
      ? {
          vibrancy: 'under-window' as const,
          visualEffectState: 'followWindow' as const,
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
  const ownerWebContentsId = win.webContents.id;
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
  win.webContents.on('render-process-gone', () => destroyOwnedSurfaces(ownerWebContentsId));

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
    // Each worktree may have its own Vite process. The launcher selects an
    // available port and passes the exact renderer URL so we never attach to
    // a stale dev server from another checkout.
    const url = withWindowId(process.env.MICHI_RENDERER_URL || 'http://127.0.0.1:3001');
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
    destroyOwnedSurfaces(ownerWebContentsId);
    windows.delete(win);
    windowSlots.delete(win);
  });
}

function pickerDefaultPath(): string {
  if (LAUNCH_CWD && LAUNCH_CWD !== '/' && LAUNCH_CWD !== path.sep) return LAUNCH_CWD;
  return app.getPath('home');
}

// Preload-level click interceptor sends external URLs here for shell.openExternal.
ipcMain.on('app:openExternal', (_ev, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
});

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

ipcMain.handle('app:chooseFolders', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    defaultPath: pickerDefaultPath(),
  });
  if (r.canceled || r.filePaths.length === 0) {
    return { canceled: true, folders: [] };
  }
  return {
    canceled: false,
    folders: r.filePaths.map((p) => ({ path: p, name: path.basename(p) })),
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

ipcMain.handle('app:listDirectory', async (_ev, absPath: unknown, rawRoots: unknown) => {
  return listWorkspaceDirectory(absPath, rawRoots);
});

const IMAGE_MIME = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

ipcMain.handle('app:readFilePreview', async (_ev, absPath: unknown) => {
  try {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return null;
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
    const extension = path.extname(absPath).slice(1).toLowerCase();
    const mime = IMAGE_MIME.get(extension);
    const data = await fs.promises.readFile(absPath);
    if (mime) {
      return { kind: 'image', dataUrl: `data:${mime};base64,${data.toString('base64')}`, size: stat.size, modifiedAt: stat.mtimeMs, extension };
    }
    if (data.subarray(0, 8192).includes(0)) return null;
    const content = data.toString('utf8');
    return { kind: 'text', content, size: stat.size, modifiedAt: stat.mtimeMs, extension };
  } catch {
    return null;
  }
});

ipcMain.handle('app:listGitChanges', async (_ev, cwd: unknown, rawRoots: unknown) => {
  const { directory } = await resolveAllowedDirectory(cwd, rawRoots);
  return new Promise<Array<{ path: string; status: string }>>((resolve) => {
    execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: directory,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error && !stdout) {
        resolve([]);
        return;
      }
      resolve(stdout.split('\n').flatMap((line) => {
        if (line.length < 4) return [];
        const status = line.slice(0, 2).trim() || '?';
        const rawPath = line.slice(3).trim();
        const filePath = rawPath.includes(' -> ') ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4) : rawPath;
        return filePath ? [{ path: filePath.replace(/^"|"$/g, ''), status }] : [];
      }));
    });
  });
});

// Read a file by absolute path. Used by ArtifactPane to open reference artifacts
// that live outside the workspace cwd (bypassing the backend sandbox).
// Security: Electron main process already has full disk access; this is no more
// privileged than the existing openPath handler. Limited to text files < 512KB.
ipcMain.handle('app:readFile', async (_ev, absPath: string) => {
  try {
    if (!absPath || !path.isAbsolute(absPath)) return null;
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) return null;
    const content = await fs.promises.readFile(absPath, 'utf8');
    return { content, size: stat.size, modifiedAt: stat.mtimeMs };
  } catch {
    return null;
  }
});

ipcMain.handle('app:statFile', async (_ev, absPath: string) => {
  try {
    if (!absPath || !path.isAbsolute(absPath)) return null;
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) return null;
    return { size: stat.size, modifiedAt: stat.mtimeMs };
  } catch {
    return null;
  }
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

// Keep native chrome, vibrancy, and Browser WebContentsViews aligned with the
// active Michi palette. Browser views receive a Chromium preferred-color-scheme
// emulation, so sites with native dark CSS update without destructive filters.
ipcMain.on('app:setDarkMaterial', (_ev, dark: boolean, backgroundColor?: string) => {
  currentBrowserTheme = normalizeBrowserTheme(dark, backgroundColor);
  nativeTheme.themeSource = currentBrowserTheme.colorScheme;
  for (const surface of browserSurfaces.values()) void syncBrowserTheme(surface);
});

// Runtime-switch the sidebar's NSVisualEffectView material so users can pick how
// see-through / dense the desktop-vibrancy sidebar reads. macOS materials range
// from 'under-window' (lightest, our default) to denser frosts ('sidebar',
// 'menu', 'hud'). Applies to every open window. No-op unless vibrancy is on
// (off macOS / MICHI_NO_VIBRANCY) or on an invalid material string.
const VIBRANCY_MATERIALS = new Set(['under-window', 'sidebar', 'menu', 'hud']);
ipcMain.on('app:setVibrancy', (_ev, material: string) => {
  if (!VIBRANCY_ENABLED || !VIBRANCY_MATERIALS.has(material)) return;
  for (const w of windows) {
    if (!w.isDestroyed()) w.setVibrancy(material as 'under-window' | 'sidebar' | 'menu' | 'hud');
  }
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
  applyPowerSaveBlocker();
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
    initAutoUpdate({
      isDev,
      isPackaged: app.isPackaged,
      sendToWindows: (channel, payload) => {
        for (const w of windows) {
          if (!w.isDestroyed()) w.webContents.send(channel, payload);
        }
      },
    });

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
