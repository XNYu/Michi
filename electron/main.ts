import type {
  BackgroundServiceStatus, BrowserSurfaceState, DesktopCommandContract, DesktopEventContract, DesktopInvokeContract,
  DesktopInvokeArgs, DesktopInvokeResult, ScheduledRunTarget, TerminalSurfaceSnapshot,
} from 'michi-shared';
import { app, BrowserWindow, Menu, Tray, WebContentsView, ipcMain, dialog, nativeImage, shell, nativeTheme, powerSaveBlocker, powerMonitor, Notification as ElectronNotification } from 'electron';
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
import { toSurfaceBounds } from './browserBounds';
import { remoteAuthenticationProcess } from './remoteAuthentication';
import { SIGN_IN_COMMANDS } from './remoteCredentials';
import {
  appBundlePath,
  buildServiceLaunchSpec,
  expectedServerId,
  installAndStartService,
  readServiceState,
  runLaunchctl,
  serviceBuildStamp,
  servicePaths,
  stopService,
  writeServiceState,
} from './backgroundService';
import { planNoticeDelivery, ScheduledNotificationFeed, type ScheduledRunNotice } from './scheduledNotifications';
import {
  BACKGROUND_LAUNCH_ARG,
  HIDDEN_LAUNCH_ARG,
  PACKAGED_TRAY_ICON_NAME,
  TRAY_MENU,
  WindowsLifetimeController,
  isOwnedLifetimeSender,
  packagedTrayIconPath,
} from './windowsLifecycle';

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

function handleDesktopInvoke<K extends keyof DesktopInvokeContract>(
  channel: K,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: DesktopInvokeArgs<K>) => DesktopInvokeResult<K> | Promise<DesktopInvokeResult<K>>,
): void {
  ipcMain.handle(channel, handler);
}

function sendDesktopEvent<K extends keyof DesktopEventContract>(target: Pick<Electron.WebContents, 'send'>, channel: K, ...args: DesktopEventContract[K]): void {
  target.send(channel, ...args);
}
function onDesktopCommand<K extends keyof DesktopCommandContract>(
  channel: K,
  handler: (event: Electron.IpcMainEvent, ...args: DesktopCommandContract[K]) => void,
): void {
  ipcMain.on(channel, handler);
}

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
// reads this via the `michiVibrancy` URL query param (injected by createWindow)
// so it can punch the sidebar hole only when the window base is actually the
// vibrancy material — main authoritatively owns the flag so the CSS never
// assumes see-through the window doesn't have.
const VIBRANCY_ENABLED = process.platform === 'darwin' && process.env.MICHI_NO_VIBRANCY !== '1';

// Minimal skeleton HTML shown immediately while the backend starts. Matches
// the app's warm light / dark background so the transition to the real UI is
// seamless. Loaded via data: URL — no network, no disk read.
const SKELETON_HTML = `<!DOCTYPE html>
<html style="margin:0;height:100%">
<head><meta charset="utf-8"><title>Michi</title></head>
<body style="margin:0;height:100%;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  background:${VIBRANCY_ENABLED ? 'transparent' : '#F5F2EE'};color:#8B7E74;font-size:13px">
<div style="opacity:0.6">loading…</div>
</body></html>`;

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
const restoredWindows = new WeakSet<BrowserWindow>();
const windowSlots = new WeakMap<BrowserWindow, number>();
let nextWindowSlot = 0;
let backendChild: ChildProcess | null = null;
let resolvedBackendPort: number | null = null;
/** child: forked with the app. service: launchd LaunchAgent. external: dev server. */
let backendMode: 'child' | 'service' | 'external' = 'child';

// The background service launches the app with this flag so it can deliver
// notifications without opening a window (see backend appLauncher.ts).
const launchedInBackground = process.argv.includes(BACKGROUND_LAUNCH_ARG);
const launchedHidden = process.argv.includes(HIDDEN_LAUNCH_ARG);
/** Background launches quit after this long without any window. */
const BACKGROUND_IDLE_QUIT_MS = 15 * 60_000;

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

function browserState(surface: BrowserSurface): BrowserSurfaceState {
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
    sendDesktopEvent(surface.host.webContents, 'browser:state', browserState(surface));
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

function createTerminalSurface(event: Electron.IpcMainInvokeEvent, surfaceId: unknown, cwd: unknown, cols: unknown, rows: unknown, authentication?: unknown): TerminalSurfaceSnapshot {
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
  const auth = authentication === undefined ? undefined : remoteAuthenticationProcess(authentication, SIGN_IN_COMMANDS);
  const processHandle = pty.spawn(auth?.binary ?? shellPath, auth?.args ?? (process.platform === 'win32' ? [] : ['-l']), {
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
    // Authentication output is ephemeral and never enters terminal replay/logs.
    if (!auth) surface.replay = (surface.replay + data).slice(-MAX_TERMINAL_REPLAY_CHARS);
    surface.pending += data;
    if (surface.flushTimer) return;
    surface.flushTimer = setTimeout(() => {
      surface.flushTimer = null;
      const chunk = surface.pending;
      surface.pending = '';
      if (!event.sender.isDestroyed() && chunk) sendDesktopEvent(event.sender, 'terminal:data', surfaceId, chunk);
    }, 8);
  });
  processHandle.onExit(({ exitCode }) => {
    if (surface.flushTimer) { clearTimeout(surface.flushTimer); surface.flushTimer = null; }
    if (!event.sender.isDestroyed() && surface.pending) sendDesktopEvent(event.sender, 'terminal:data', surfaceId, surface.pending);
    surface.pending = '';
    surface.exited = true;
    surface.exitCode = exitCode;
    if (!event.sender.isDestroyed()) sendDesktopEvent(event.sender, 'terminal:exit', surfaceId, exitCode);
  });
  return { surfaceId, data: '', exited: false };
}

handleDesktopInvoke('terminal:create', (event, surfaceId, cwd, cols, rows) => createTerminalSurface(event, surfaceId, cwd, cols, rows));
handleDesktopInvoke('remote-auth:create', (event, surfaceId, target, cols, rows) => {
  remoteAuthenticationProcess(target, SIGN_IN_COMMANDS);
  return createTerminalSurface(event, surfaceId, os.homedir(), cols, rows, target);
});

onDesktopCommand('terminal:write', (event, surfaceId: unknown, data: unknown) => {
  if (!validSurfaceId(surfaceId) || typeof data !== 'string') return;
  const surface = terminalSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (surface && !surface.exited) surface.process.write(data);
});

onDesktopCommand('terminal:resize', (event, surfaceId: unknown, cols: unknown, rows: unknown) => {
  if (!validSurfaceId(surfaceId) || typeof cols !== 'number' || typeof rows !== 'number') return;
  const surface = terminalSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface || surface.exited) return;
  try { surface.process.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows))); } catch { /* process exited */ }
});

onDesktopCommand('terminal:destroy', (event, surfaceId: unknown) => {
  if (validSurfaceId(surfaceId)) destroyTerminalSurface(surfaceKey(event.sender.id, surfaceId));
});

handleDesktopInvoke('terminal:listActive', (event) => {
  const ownerId = event.sender.id;
  const active: Array<{ surfaceId: string }> = [];
  for (const [key, surface] of terminalSurfaces) {
    if (surface.ownerId === ownerId && !surface.exited) {
      active.push({ surfaceId: key.slice(`${ownerId}:`.length) });
    }
  }
  return active;
});

handleDesktopInvoke('browser:create', async (event, surfaceId: unknown, projectId: unknown, rawUrl: unknown) => {
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
      if (!host.isDestroyed()) sendDesktopEvent(host.webContents, 'browser:focus', surfaceId);
    });
    view.webContents.on('before-input-event', (inputEvent, input) => {
      if (!isClosePaneShortcut(input)) return;
      inputEvent.preventDefault();
      if (!host.isDestroyed()) sendDesktopEvent(host.webContents, 'browser:close-request', surfaceId);
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

handleDesktopInvoke('browser:navigate', async (event, surfaceId: unknown, rawUrl: unknown) => {
  if (!validSurfaceId(surfaceId)) throw new Error('Invalid browser surface id');
  const url = normalizeSurfaceUrl(rawUrl);
  if (!url) throw new Error('Only HTTP(S) URLs are supported');
  const surface = browserSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface) throw new Error('Browser surface not found');
  surface.error = undefined;
  await surface.view.webContents.loadURL(url);
  return browserState(surface);
});

onDesktopCommand('browser:set-bounds', (event, surfaceId: unknown, value: unknown, visible: unknown) => {
  if (!validSurfaceId(surfaceId)) return;
  const surface = browserSurfaces.get(surfaceKey(event.sender.id, surfaceId));
  if (!surface) return;
  // The renderer sends CSS pixels; setBounds takes window points. Scale by the
  // sending window's current zoom so View > Zoom In/Out cannot misplace the view.
  const bounds = toSurfaceBounds(value, event.sender.getZoomFactor());
  if (!bounds) return;
  const nowVisible = visible === true && bounds.width > 1 && bounds.height > 1;
  // Always set bounds BEFORE visibility so the view lands in the right place
  // when transitioning to visible. Then re-apply AFTER setVisible for safety —
  // Electron may not reliably apply setBounds to a hidden view (see #39993).
  surface.view.setBounds(bounds);
  surface.view.setVisible(nowVisible);
  if (nowVisible) {
    // Re-apply after setVisible(true) ensures the compositor has the correct
    // position even if the first setBounds was a no-op on a hidden view.
    surface.view.setBounds(bounds);
  }
});

for (const [channel, action] of [
  ['browser:back', 'back'],
  ['browser:forward', 'forward'],
  ['browser:reload', 'reload'],
  ['browser:stop', 'stop'],
] as const) {
  onDesktopCommand(channel, (event, surfaceId: unknown) => {
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

onDesktopCommand('browser:destroy', (event, surfaceId: unknown) => {
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
 * Mirror of runtime/src/adapters/kiro/kiroCli.ts findKiroCli() for the
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
 * Mirror of runtime/src/adapters/codex/codexBinary.ts findCodexBinary() for
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
 * Mirror of runtime/src/adapters/claude/claudeBinary.ts findClaudeBinary()
 * for the packaged-default decision. Kept in sync by hand.
 */
function probeClaudeCli(): boolean {
  const env = process.env.CLAUDE_CLI_BIN;
  if (env && fs.existsSync(env)) return true;
  return probeNamedBins('claude');
}

/** Pick the first installed CLI, falling back to the CLI-free Pi runtime. */
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

/**
 * Fork the backend child and return the port immediately — does NOT wait for
 * /api/health. Callers that need readiness should follow up with
 * waitForBackend(port). This split lets us show a skeleton window in parallel
 * with backend startup.
 */
async function forkBackend(): Promise<number | null> {
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

  // Packaged builds select an installed CLI, falling back to Pi.
  // Dev keeps the agentConfig default (Kiro)
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
    // The child bundled with the desktop app is always the loopback gateway.
    // Ignore remote-server flags inherited from a shell or ~/.michi/.env.
    MICHI_REMOTE_ACCESS: '0',
    MICHI_BIND_HOST: '127.0.0.1',
  };
  delete env.MICHI_REMOTE_TOKEN;
  if (app.isPackaged) {
    // Dev-renderer flags make the backend trust another local page's origin
    // (backend/src/services/localOrigins.ts). The installed app serves its
    // own UI, so drop them when a shell or ~/.michi/.env passes them on.
    delete env.MICHI_DEV_RENDERER;
    delete env.MICHI_RENDERER_URL;
  }
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

// ── Background service (macOS LaunchAgent) ─────────────────────────────────
// When enabled, the backend runs under launchd and outlives the app, so
// scheduled jobs keep running after Michi quits. The app attaches to it on
// launch and never stops it on quit.

const SERVICE_PATHS = servicePaths();
let dockHidden = false;

function showDock(): void {
  if (process.platform !== 'darwin' || !dockHidden || !app.dock) return;
  dockHidden = false;
  void app.dock.show();
}

function serviceSupport(): { supported: boolean; reason?: string } {
  if (process.platform !== 'darwin') return { supported: false, reason: 'The background service is available on macOS.' };
  if (isDev || !app.isPackaged) return { supported: false, reason: 'The background service is available in the installed app.' };
  if (!resolveBackendEntry()) return { supported: false, reason: 'The bundled backend is missing.' };
  return { supported: true };
}

interface BackendHealth {
  service?: string;
  serverId?: string;
  serviceMode?: boolean;
  serviceBuild?: string | null;
}

function probeHealth(port: number, timeoutMs = 1500): Promise<BackendHealth | null> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 64_000) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body) as BackendHealth); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function isOurService(health: BackendHealth | null): boolean {
  return !!health
    && health.service === 'michi-backend'
    && health.serverId === expectedServerId()
    && health.serviceMode === true;
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Make sure our LaunchAgent serves `port` with the current app build,
 * installing or restarting it as needed. Resolves true once healthy.
 */
async function ensureServiceRunning(port: number): Promise<boolean> {
  const build = serviceBuildStamp(app.getAppPath(), app.getVersion());
  const health = await probeHealth(port);
  if (isOurService(health) && health!.serviceBuild === build) return true;
  if (health && !isOurService(health)) {
    elog('WARN', 'service', 'port is held by a different backend', { port, serviceMode: health.serviceMode });
    return false;
  }
  const entry = resolveBackendEntry();
  if (!entry) return false;
  const helper = (process as NodeJS.Process & { helperExecPath?: string }).helperExecPath || process.execPath;
  const spec = buildServiceLaunchSpec({
    nodeExecPath: helper,
    entry,
    port,
    logDir: LOG_DIR,
    bundlePath: appBundlePath(process.execPath),
    build,
    baseEnv: process.env,
    defaultRuntime: detectDefaultRuntime(),
  });
  try {
    elog('INFO', 'service', health ? 'restarting background service for this build' : 'starting background service', { port, build });
    await installAndStartService({ spec, run: runLaunchctl, uid: os.userInfo().uid, plistFile: SERVICE_PATHS.plistFile });
    await waitForBackend(port, 30_000);
  } catch (err) {
    elog('ERROR', 'service', 'background service did not start', { port, err: (err as Error).message });
    return false;
  }
  return isOurService(await probeHealth(port));
}

/** Attach to the background service when enabled, else fork the app-owned backend. */
async function startBackend(): Promise<number | null> {
  if (!resolveBackendEntry()) {
    backendMode = 'external';
    return forkBackend();
  }
  const state = serviceSupport().supported ? readServiceState(SERVICE_PATHS.stateFile) : null;
  if (state?.enabled) {
    startupMark('backend_service_attach_start', { port: state.port });
    if (await ensureServiceRunning(state.port)) {
      backendMode = 'service';
      elog('INFO', 'service', 'attached to background service', { port: state.port });
      return state.port;
    }
    elog('ERROR', 'service', 'background service unavailable; using an app-owned backend this session', { port: state.port });
    await stopService({ run: runLaunchctl, uid: os.userInfo().uid, plistFile: SERVICE_PATHS.plistFile }).catch(() => {});
  }
  backendMode = 'child';
  return forkBackend();
}

function backgroundServiceStatus(): BackgroundServiceStatus {
  const support = serviceSupport();
  const state = support.supported ? readServiceState(SERVICE_PATHS.stateFile) : null;
  return {
    supported: support.supported,
    ...(support.reason ? { reason: support.reason } : {}),
    enabled: !!state?.enabled,
    running: backendMode === 'service',
    port: resolvedBackendPort,
  };
}

let serviceTransition: Promise<unknown> | null = null;

/**
 * Hand the backend over between the app-owned child and the LaunchAgent on
 * the same port, so the renderer origin (and its local state) is unchanged.
 */
async function setBackgroundServiceEnabled(enabled: boolean): Promise<BackgroundServiceStatus> {
  const support = serviceSupport();
  if (!support.supported) throw new Error(support.reason ?? 'The background service is not available.');
  while (serviceTransition) await serviceTransition.catch(() => {});
  const uid = os.userInfo().uid;
  const work = (async () => {
    if (enabled && backendMode !== 'service') {
      const port = resolvedBackendPort ?? await chooseBackendPort();
      await stopBackend();
      await waitForPortFree(port, 10_000);
      writeServiceState(SERVICE_PATHS.stateFile, { enabled: true, port });
      if (await ensureServiceRunning(port)) {
        backendMode = 'service';
        resolvedBackendPort = port;
      } else {
        writeServiceState(SERVICE_PATHS.stateFile, { enabled: false, port });
        await stopService({ run: runLaunchctl, uid, plistFile: SERVICE_PATHS.plistFile, removePlist: true }).catch(() => {});
        await waitForPortFree(port, 10_000);
        backendMode = 'child';
        resolvedBackendPort = await forkBackend();
        if (resolvedBackendPort) await waitForBackend(resolvedBackendPort).catch(() => {});
        throw new Error(`The background service did not start. See ${path.join(LOG_DIR, 'service.err.log')}.`);
      }
    } else if (!enabled && backendMode === 'service') {
      const port = resolvedBackendPort;
      const state = readServiceState(SERVICE_PATHS.stateFile);
      if (state) writeServiceState(SERVICE_PATHS.stateFile, { ...state, enabled: false });
      await stopService({ run: runLaunchctl, uid, plistFile: SERVICE_PATHS.plistFile, removePlist: true });
      if (port) await waitForPortFree(port, 15_000);
      backendMode = 'child';
      resolvedBackendPort = await forkBackend();
      if (resolvedBackendPort) await waitForBackend(resolvedBackendPort);
      if (resolvedBackendPort !== port) {
        for (const win of windows) {
          if (!win.isDestroyed()) void win.loadURL(`http://127.0.0.1:${resolvedBackendPort}`);
        }
      }
    } else if (!enabled) {
      const state = readServiceState(SERVICE_PATHS.stateFile);
      if (state?.enabled) writeServiceState(SERVICE_PATHS.stateFile, { ...state, enabled: false });
    }
    notificationFeed.restart();
    return backgroundServiceStatus();
  })();
  serviceTransition = work;
  try {
    return await work;
  } finally {
    serviceTransition = null;
  }
}

// ── Scheduled job notifications ────────────────────────────────────────────

const liveNotifications = new Set<ElectronNotification>();
let backgroundIdleTimer: ReturnType<typeof setTimeout> | null = null;

function devBackendPort(): number {
  return parsePort(process.env.MICHI_BACKEND_PORT) ?? parsePort(process.env.PORT) ?? 3000;
}

const notificationFeed = new ScheduledNotificationFeed({
  port: () => resolvedBackendPort ?? (backendMode === 'external' ? devBackendPort() : null),
  onNotice: (notice) => handleScheduledNotice(notice),
  log: (level, message, meta) => elog(level, 'schedule', message, meta),
});

function cancelBackgroundIdleQuit(): void {
  if (backgroundIdleTimer) clearTimeout(backgroundIdleTimer);
  backgroundIdleTimer = null;
}

/** A hidden background launch exits again if the user never opens a window. */
function armBackgroundIdleQuit(): void {
  if (!launchedInBackground) return;
  cancelBackgroundIdleQuit();
  backgroundIdleTimer = setTimeout(() => {
    if (windows.size === 0) {
      elog('INFO', 'schedule', 'background launch idle; quitting');
      app.quit();
    }
  }, BACKGROUND_IDLE_QUIT_MS);
}

function targetOf(notice: ScheduledRunNotice): ScheduledRunTarget {
  return { runId: notice.runId, jobId: notice.jobId, workspaceId: notice.workspaceId, nodeId: notice.nodeId };
}

function openScheduledRun(target: ScheduledRunTarget): void {
  cancelBackgroundIdleQuit();
  showDock();
  const existing = BrowserWindow.getFocusedWindow() ?? [...windows].find((win) => !win.isDestroyed()) ?? null;
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    sendDesktopEvent(existing.webContents, 'scheduled:open-run', target);
  } else {
    void createWindow(resolvedBackendPort, undefined, target);
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function handleScheduledNotice(notice: ScheduledRunNotice): void {
  const focused = BrowserWindow.getFocusedWindow();
  const focusedWindow = focused && windows.has(focused) && !focused.isDestroyed() ? focused : null;
  const plan = planNoticeDelivery(notice, {
    hasFocusedWindow: focusedWindow !== null,
    osNotificationsSupported: ElectronNotification.isSupported(),
  });
  const target = targetOf(notice);
  if (plan.kind === 'toast' && focusedWindow) {
    sendDesktopEvent(focusedWindow.webContents, 'scheduled:notice', { ...plan.content, target });
  } else if (plan.kind === 'banner') {
    const { title, subtitle, body } = plan.content;
    const notification = new ElectronNotification({ title, subtitle, body });
    // Hold a reference until the user acts on it, or its click handler can be collected.
    liveNotifications.add(notification);
    notification.on('click', () => {
      liveNotifications.delete(notification);
      openScheduledRun(target);
    });
    notification.on('close', () => liveNotifications.delete(notification));
    notification.show();
  }
  if (plan.ack) notificationFeed.acknowledge(notice.runId);
  if (plan.kind === 'banner' || plan.kind === 'defer') armBackgroundIdleQuit();
}

handleDesktopInvoke('service:getStatus', () => backgroundServiceStatus());

handleDesktopInvoke('service:setEnabled', (_ev, enabled: unknown) => {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  return setBackgroundServiceEnabled(enabled);
});

function lifetimePrefsFile(): string {
  return path.join(app.getPath('userData'), 'desktop-lifetime.json');
}

function findWindowById(id: number): BrowserWindow | undefined {
  return [...windows].find((win) => !win.isDestroyed() && win.id === id);
}

function restoreLifetimeWindow(): void {
  const decision = windowsLifetime.handleSecondInstance([]);
  if (decision.action === 'create-window') void createWindow(resolvedBackendPort);
}

function resolveTrayImage(): Electron.NativeImage | null {
  const candidates = [
    packagedTrayIconPath(process.resourcesPath),
    path.join(path.dirname(process.execPath), PACKAGED_TRAY_ICON_NAME),
    path.join(__dirname, '..', '..', 'assets', 'icons', PACKAGED_TRAY_ICON_NAME),
    path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.png'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image;
  }
  return null;
}

let windowsTray: Tray | null = null;

function createWindowsTray(): boolean {
  if (windowsTray && !windowsTray.isDestroyed()) return true;
  try {
    const image = resolveTrayImage();
    if (!image) return false;
    const tray = new Tray(image);
    tray.setToolTip('Michi');
    tray.setContextMenu(Menu.buildFromTemplate(TRAY_MENU.map((item) => ({
      label: item.label,
      click: () => {
        if (item.id === 'show') restoreLifetimeWindow();
        else {
          windowsLifetime.beginQuit('user');
          app.quit();
        }
      },
    }))));
    tray.on('click', () => restoreLifetimeWindow());
    windowsTray = tray;
    return !tray.isDestroyed();
  } catch (err) {
    elog('WARN', 'lifetime', 'tray creation failed', { err: (err as Error).message });
    windowsTray = null;
    return false;
  }
}

function destroyWindowsTray(): void {
  if (!windowsTray) return;
  try { if (!windowsTray.isDestroyed()) windowsTray.destroy(); } catch { /* already gone */ }
  windowsTray = null;
}

const windowsLifetime = new WindowsLifetimeController(
  { platform: process.platform, isPackaged: app.isPackaged, isDev },
  {
    readPreferences() {
      try { return JSON.parse(fs.readFileSync(lifetimePrefsFile(), 'utf8')); } catch { return null; }
    },
    writePreferences(prefs) {
      const file = lifetimePrefsFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(prefs)}\n`, { mode: 0o600 });
    },
    fileExists: (candidate) => fs.existsSync(candidate),
    execPath: process.execPath,
    createTray: createWindowsTray,
    destroyTray: destroyWindowsTray,
    hideWindow(id) { findWindowById(id)?.hide(); },
    restoreWindow(id) {
      const win = findWindowById(id);
      if (win) revealWindow(win);
    },
    focusWindow(id) { findWindowById(id)?.focus(); },
    listWindows: () => [...windows].filter((win) => !win.isDestroyed()).map((win) => ({
      id: win.id,
      webContentsId: win.webContents.id,
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      destroyed: win.isDestroyed(),
    })),
    quit: () => { app.quit(); },
    stopBackend: () => stopBackend(),
    setLoginItem(settings) {
      try {
        app.setLoginItemSettings({
          openAtLogin: settings.openAtLogin,
          path: settings.path,
          args: settings.args,
          ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
        });
        return true;
      } catch (err) {
        elog('WARN', 'lifetime', 'login item update failed', { err: (err as Error).message });
        return false;
      }
    },
    getLoginItem(query) {
      const settings = app.getLoginItemSettings({ path: query.path, args: query.args });
      const items = settings.launchItems ?? [];
      return {
        openAtLogin: settings.openAtLogin,
        executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin,
        enabled: items.length === 0 ? undefined : items.every((item) => item.enabled),
      };
    },
  },
);

function revealWindow(win: BrowserWindow): void {
  restoredWindows.add(win);
  win.setSkipTaskbar(false);
  if (win.isMinimized()) win.restore();
  win.show();
}

function recoverVisibleWindows(): void {
  for (const win of windows) {
    if (!win.isDestroyed()) revealWindow(win);
  }
}

function attachWindowSessionEnd(win: BrowserWindow): void {
  win.on('query-session-end', () => {
    // Query can still be cancelled by Windows. Do not mark an irrevocable quit.
  });
  win.on('session-end', () => {
    windowsLifetime.beginQuit('shutdown');
    destroyWindowsTray();
    void stopBackend();
  });
}

function assertOwnedLifetimeSender(event: Electron.IpcMainInvokeEvent): void {
  const ids = [...windows].filter((win) => !win.isDestroyed()).map((win) => win.webContents.id);
  const frame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  if (!isOwnedLifetimeSender({
    senderId: event.sender.id,
    windowWebContentsIds: ids,
    senderFrameIsMainFrame: !!frame && !!mainFrame && frame === mainFrame,
  })) throw new Error('Unauthorized');
}

handleDesktopInvoke('lifetime:getStatus', (event) => {
  assertOwnedLifetimeSender(event);
  return windowsLifetime.status();
});

handleDesktopInvoke('lifetime:setKeepInBackground', (event, enabled: unknown) => {
  assertOwnedLifetimeSender(event);
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const status = windowsLifetime.setKeepInBackground(enabled);
  if (!status.canStartHidden) recoverVisibleWindows();
  return status;
});

handleDesktopInvoke('lifetime:setOpenAtLogin', (event, enabled: unknown) => {
  assertOwnedLifetimeSender(event);
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  return windowsLifetime.setOpenAtLogin(enabled);
});

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

async function createWindow(
  backendPort: number | null,
  healthPromise?: Promise<void>,
  openRun?: ScheduledRunTarget,
  options?: { hidden?: boolean },
): Promise<void> {
  showDock();
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
      // The preload needs only contextBridge, ipcRenderer and webUtils;
      // scripts/electron-preload-contract.test.mjs keeps it sandbox-safe.
      sandbox: true,
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
  attachWindowSessionEnd(win);

  if (savedState.isMaximized) {
    win.maximize();
  }

  win.on('resize', () => scheduleSaveWindowState(win));
  win.on('maximize', () => scheduleSaveWindowState(win));
  win.on('unmaximize', () => scheduleSaveWindowState(win));

  // Confirm close when active (non-exited) terminal surfaces are running.
  let closingConfirmed = false;
  win.on('close', (event) => {
    flushWindowState(win);
    if (closingConfirmed) return;
    const closeDecision = windowsLifetime.handleWindowClose(win.id);
    if (closeDecision === 'hide') {
      event.preventDefault();
      return;
    }
    if (closeDecision === 'quit-close') return;

    let activeTerminals = 0;
    for (const [, surface] of terminalSurfaces) {
      if (surface.ownerId === ownerWebContentsId && !surface.exited) activeTerminals++;
    }

    if (activeTerminals > 0) {
      event.preventDefault();
      dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Close anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Active terminals',
        message: `${activeTerminals} terminal${activeTerminals > 1 ? 's' : ''} still running`,
        detail: 'Closing this window will terminate all running processes.',
      }).then(({ response }) => {
        if (response === 0) {
          closingConfirmed = true;
          win.close();
        }
      });
    }
  });

  win.once('ready-to-show', () => {
    startupMark('window_ready_to_show', { slot });
    if (options?.hidden && !restoredWindows.has(win)) {
      win.setSkipTaskbar(true);
      return;
    }
    win.setSkipTaskbar(false);
    win.show();
  });

  win.webContents.on('did-finish-load', () => {
    startupMark('renderer_did_finish_load', { slot });
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    destroyOwnedSurfaces(ownerWebContentsId);
    // V8-level renderer crash (OOM, segfault, etc.) — not triggered by React
    // errors, but covers extreme cases.  Must be deferred: calling reload()
    // synchronously inside this handler can crash the main process on older
    // Electron versions (Chromium re-enters RenderProcessHostImpl::Init
    // while iterating the observer list).
    if (details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          // eslint-disable-next-line no-console
          console.log(`[main] renderer gone (${details.reason}), reloading window`);
          win.webContents.reload();
        }
      }, 1000);
    }
  });

  win.webContents.on('console-message', (_event, _level, message) => {
    if (isStartupTraceLine(message)) {
      process.stdout.write(`${message}\n`);
    }
  });

  // Keep web navigation out of the app window. The renderer resolves the
  // user's browser preference; explicit external opening uses its own IPC.
  const routeLink = (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') sendDesktopEvent(win.webContents, 'app:openUrl', parsed.href);
      else if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') void shell.openExternal(parsed.href);
    } catch { /* Ignore malformed navigation. */ }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    routeLink(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    try {
      const current = new URL(win.webContents.getURL());
      const target = new URL(url);
      if (['http:', 'https:'].includes(current.protocol) && target.origin === current.origin) return;
    } catch { /* Invalid navigation is blocked below. */ }
    event.preventDefault();
    routeLink(url);
  });

  const withWindowId = (base: string): string => {
    const url = new URL(base);
    url.searchParams.set('michiWindowId', windowId);
    if (app.isPackaged) url.searchParams.set('michiPackaged', '1');
    if (VIBRANCY_ENABLED) url.searchParams.set('michiVibrancy', '1');
    if (openRun) {
      // Read once by the preload; the renderer opens the run after hydration.
      url.searchParams.set('michiOpenRun', openRun.runId);
      url.searchParams.set('michiOpenJob', openRun.jobId);
      url.searchParams.set('michiOpenWorkspace', openRun.workspaceId);
      if (openRun.nodeId) url.searchParams.set('michiOpenNode', openRun.nodeId);
    }
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
      // In production the backend serves the frontend HTML. If we have a
      // pending health promise, show a local skeleton immediately so the
      // window appears while the backend is still starting, then navigate
      // once the backend is ready.
      if (healthPromise) {
        startupMark('skeleton_load_start', { slot });
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SKELETON_HTML)}`);
        startupMark('skeleton_load_done', { slot });
        // Window is visible with the skeleton; now wait for the backend.
        await healthPromise;
      }
      const url = withWindowId(`http://127.0.0.1:${backendPort}`);
      startupMark('renderer_load_start', { url, slot });
      await win.loadURL(withStartupTraceQuery(url));
      startupMark('renderer_load_done', { slot });
    } else {
      const indexPath = path.join(app.getAppPath(), 'frontend', 'build', 'index.html');
      startupMark('renderer_load_start', { file: indexPath, slot });
      await win.loadFile(indexPath, {
        query: {
          ...(startupTraceFileQuery() ?? {}),
          michiWindowId: windowId,
          ...(app.isPackaged ? { michiPackaged: '1' } : {}),
          ...(VIBRANCY_ENABLED ? { michiVibrancy: '1' } : {}),
        },
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

// Explicit system-browser actions bypass the preferred link destination.
onDesktopCommand('app:openExternal', (_ev, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
});

handleDesktopInvoke('app:chooseFolder', async () => {
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

handleDesktopInvoke('app:chooseFolders', async () => {
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
handleDesktopInvoke('app:resolveSkipCwd', async (_ev, projectId: string) => {
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
handleDesktopInvoke('app:openPath', async (_ev, absPath: string) => {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, error: 'absPath required' };
  }
  const err = await shell.openPath(absPath);
  if (err) return { ok: false, error: err };
  return { ok: true };
});

handleDesktopInvoke('app:chooseFiles', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    defaultPath: pickerDefaultPath(),
  });
  if (r.canceled || r.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, paths: r.filePaths };
});

handleDesktopInvoke('app:saveMarkdown', async (_ev, suggestedName: string, content: string) => {
  const r = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  await fs.promises.writeFile(r.filePath, content, 'utf8');
  return { canceled: false, path: r.filePath };
});

handleDesktopInvoke('app:listDirectory', async (_ev, absPath: unknown, rawRoots: unknown) => {
  return listWorkspaceDirectory(absPath, rawRoots);
});

const IMAGE_MIME = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

handleDesktopInvoke('app:readFilePreview', async (_ev, absPath: unknown) => {
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

handleDesktopInvoke('app:listGitChanges', async (_ev, cwd: unknown, rawRoots: unknown) => {
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
handleDesktopInvoke('app:readFile', async (_ev, absPath: string) => {
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

handleDesktopInvoke('app:statFile', async (_ev, absPath: string) => {
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
onDesktopCommand('app:showNotification', (_ev, title: string, body: string) => {
  const n = new ElectronNotification({ title, body });
  n.on('click', () => {
    focusedWindow()?.focus();
  });
  n.show();
});

// Relaunch the app (used after self-update). app.exit() skips before-quit,
// so stop an app-owned backend first; otherwise the orphan keeps the port
// and the relaunched app starts a second backend on the same data.
onDesktopCommand('app:relaunch', () => {
  void (async () => {
    notificationFeed.stop();
    await stopBackend();
    app.relaunch();
    app.exit(0);
  })();
});

// isPackaged and vibrancy flags are injected via URL query params by
// createWindow — the preload reads them from window.location.search with
// zero IPC. Legacy sendSync handlers removed.

// (vibrancy flag is now injected via URL query param — see above comment)

// Keep native chrome, vibrancy, and Browser WebContentsViews aligned with the
// active Michi palette. Browser views receive a Chromium preferred-color-scheme
// emulation, so sites with native dark CSS update without destructive filters.
onDesktopCommand('app:setDarkMaterial', (_ev, dark: boolean, backgroundColor?: string) => {
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
onDesktopCommand('app:setVibrancy', (_ev, material: string) => {
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
  elog('INFO', 'boot', 'another instance owns the Electron profile; forwarded launch', { userData: app.getPath('userData') });
  app.exit(0);
}

app.on('second-instance', (_event, argv) => {
  if (process.platform !== 'win32') {
    if (argv.includes(BACKGROUND_LAUNCH_ARG)) return;
    void createWindow(resolvedBackendPort);
    return;
  }
  const decision = windowsLifetime.handleSecondInstance(argv);
  if (decision.action === 'ignore' || decision.action === 'restore') return;
  void createWindow(resolvedBackendPort);
});

app.whenReady().then(async () => {
  powerMonitor.on('resume', () => {
    if (!resolvedBackendPort) return;
    // Ask the owning backend to check its forwards. A healthy SSH session
    // survives; repeated end-to-end failure triggers its bounded supervisor.
    const request = http.request({ hostname: '127.0.0.1', port: resolvedBackendPort,
      path: '/api/backend-connections/check', method: 'POST', timeout: 5_000 }, response => response.resume());
    request.on('timeout', () => request.destroy());
    request.on('error', () => {});
    request.end();
  });
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

    // Fork the backend and get the port immediately (fast: ~50ms for port
    // selection + fork), then create the window in parallel with the health
    // wait. In dev mode forkBackend returns null (external Vite serves the
    // frontend); in prod the backend serves the frontend HTML so the window
    // initially loads a local skeleton and navigates once health passes.
    // A hidden background launch (woken by the service to deliver a
    // notification) keeps the Dock icon away until a window opens.
    if (launchedInBackground && process.platform === 'darwin' && app.dock) {
      app.dock.hide();
      dockHidden = true;
    }
    const backendPort = await startBackend();
    resolvedBackendPort = backendPort;

    // Start backend health check and window creation in parallel.
    const healthPromise = backendPort != null
      ? (async () => {
          try {
            startupMark('backend_health_wait_start', { port: backendPort });
            await waitForBackend(backendPort);
            elog('INFO', 'boot', 'backend ready', { port: backendPort });
            startupMark('backend_health_ready', { port: backendPort });
          } catch (err) {
            elog('ERROR', 'boot', 'backend did not become ready', { port: backendPort, err: (err as Error).message });
            startupMark('backend_health_failed', { port: backendPort, error: (err as Error).message });
            throw err;
          }
        })()
      : Promise.resolve();

    await installDevExtensions();
    if (launchedInBackground) {
      elog('INFO', 'boot', 'background launch; delivering notifications without a window', { backendMode });
      armBackgroundIdleQuit();
    } else {
      const ready = windowsLifetime.onAppReady({ launchedHidden });
      if (ready.startHidden) elog('INFO', 'lifetime', 'hidden login start; keeping a real window for shutdown');
      await createWindow(backendPort, healthPromise, undefined, { hidden: ready.startHidden });
    }

    // Wait for backend health to finish (may already be resolved by now).
    await healthPromise;
    elog('INFO', 'boot', launchedInBackground ? 'backend ready (background)' : 'window created', { backendPort, backendMode });
    notificationFeed.start();
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
      if (BrowserWindow.getAllWindows().length === 0) {
        cancelBackgroundIdleQuit();
        void createWindow(resolvedBackendPort);
      }
    });
  } catch (err) {
    elog('ERROR', 'boot', 'startup failed', { err: (err as Error).message, stack: (err as Error).stack });
    throw err;
  }
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (!windowsLifetime.shouldQuitWhenNoWindows()) return;
  void app.quit();
});

app.on('before-quit', async (ev) => {
  windowsLifetime.beginQuit('user');
  destroyWindowsTray();
  notificationFeed.stop();
  // Only an app-owned backend stops with the app. The background service
  // (backendMode === 'service') deliberately keeps running.
  if (backendChild) {
    ev.preventDefault();
    elog('INFO', 'boot', 'stopping backend on quit');
    await stopBackend();
    app.quit();
  }
});
