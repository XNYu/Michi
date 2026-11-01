import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type {
  AppUpdateState, BackgroundServiceStatus, BrowserSurfaceState, ChooseFolderResult, ChooseFoldersResult,
  DesktopBridge, DesktopCommandContract, DesktopEventContract, DesktopInvokeContract, DesktopInvokeArgs,
  DesktopInvokeResult, DesktopLifetimeStatus, FilePreviewResult, FileTreeEntry, GitChangeEntry,
  RemoteAuthenticationTarget, SaveMarkdownResult, ScheduledNotice, ScheduledRunTarget,
  TerminalSurfaceSnapshot, VibrancyMaterial,
} from 'michi-shared';

function invoke<K extends keyof DesktopInvokeContract>(channel: K, ...args: DesktopInvokeArgs<K>): Promise<DesktopInvokeResult<K>> {
  return ipcRenderer.invoke(channel, ...args);
}
function send<K extends keyof DesktopCommandContract>(channel: K, ...args: DesktopCommandContract[K]): void {
  ipcRenderer.send(channel, ...args);
}
function on<K extends keyof DesktopEventContract>(channel: K, handler: (...args: DesktopEventContract[K]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: DesktopEventContract[K]) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Read bootstrap flags from the URL query string injected by main.ts —
// zero IPC, no sendSync blocking the renderer's main thread.
const _qs = new URLSearchParams(window.location.search);
const isPackaged: boolean = _qs.get('michiPackaged') === '1';
const michiWindowId: string = _qs.get('michiWindowId') ?? '';
const hasVibrancy: boolean = _qs.get('michiVibrancy') === '1';

// A window opened from a scheduled-run notification carries its target in
// the URL; the renderer opens it once the workspace has hydrated.
const initialScheduledRun: ScheduledRunTarget | null = _qs.get('michiOpenRun') && _qs.get('michiOpenWorkspace') && _qs.get('michiOpenJob')
  ? {
      runId: _qs.get('michiOpenRun')!,
      jobId: _qs.get('michiOpenJob')!,
      workspaceId: _qs.get('michiOpenWorkspace')!,
      nodeId: _qs.get('michiOpenNode'),
    }
  : null;

// Mark <html> before first paint so index.css can punch the see-through hole
// (transparent shell + sidebar) without an opaque→glass flash. document may not
// exist yet at preload start; set it as soon as it does.
function markVibrancy(): void {
  if (hasVibrancy && document.documentElement) {
    document.documentElement.setAttribute('data-vibrancy', 'on');
  }
}
if (document.documentElement) markVibrancy();
else document.addEventListener('DOMContentLoaded', markVibrancy, { once: true });

const electronBridge = {
  openExternal(url: string): void { send('app:openExternal', url); },
  onOpenUrl(handler: (url: string) => void): () => void {
    return on('app:openUrl', handler);
  },
  isPackaged,
  michiWindowId,
  hasVibrancy,
  chooseFolder(): Promise<ChooseFolderResult> {
    return invoke('app:chooseFolder');
  },
  chooseFolders(): Promise<ChooseFoldersResult> {
    return invoke('app:chooseFolders');
  },
  resolveSkipCwd(projectId: string): Promise<{ path: string }> {
    return invoke('app:resolveSkipCwd', projectId);
  },
  saveMarkdown(suggestedName: string, content: string): Promise<SaveMarkdownResult> {
    return invoke('app:saveMarkdown', suggestedName, content);
  },
  openPath(absPath: string): Promise<{ ok: boolean; error?: string }> {
    return invoke('app:openPath', absPath);
  },
  /** Fire-and-forget OS notification via main process. */
  showNotification(title: string, body: string): void {
    send('app:showNotification', title, body);
  },
  /** Match native chrome and Browser panes to the active palette. */
  setDarkMaterial(dark: boolean, backgroundColor?: string): void {
    send('app:setDarkMaterial', dark, backgroundColor);
  },
  /** Switch the sidebar's native vibrancy material (desktop see-through density). */
  setVibrancy(material: VibrancyMaterial): void {
    send('app:setVibrancy', material);
  },
  /** Relaunch the app (used after self-update). */
  relaunch(): void {
    send('app:relaunch');
  },
  /** Always-on backend (macOS LaunchAgent) status. */
  getBackgroundServiceStatus(): Promise<BackgroundServiceStatus> {
    return invoke('service:getStatus');
  },
  /** Hand the backend over to / back from the background service. */
  setBackgroundServiceEnabled(enabled: boolean): Promise<BackgroundServiceStatus> {
    return invoke('service:setEnabled', enabled);
  },
  getDesktopLifetimeStatus(): Promise<DesktopLifetimeStatus> {
    return invoke('lifetime:getStatus');
  },
  setKeepInBackground(enabled: boolean): Promise<DesktopLifetimeStatus> {
    return invoke('lifetime:setKeepInBackground', enabled);
  },
  setOpenAtLogin(enabled: boolean): Promise<DesktopLifetimeStatus> {
    return invoke('lifetime:setOpenAtLogin', enabled);
  },
  initialScheduledRun,
  /** A scheduled-run notification was clicked while this window exists. */
  onScheduledRunOpen(handler: (target: ScheduledRunTarget) => void): () => void {
    return on('scheduled:open-run', handler);
  },
  /** A scheduled run finished (or needs attention) while this window is focused. */
  onScheduledNotice(handler: (notice: ScheduledNotice) => void): () => void {
    return on('scheduled:notice', handler);
  },
  getUpdateState(): Promise<AppUpdateState> {
    return invoke('app:getUpdateState');
  },
  checkForUpdate(): Promise<AppUpdateState> {
    return invoke('app:checkForUpdate');
  },
  downloadUpdate(): Promise<AppUpdateState> {
    return invoke('app:downloadUpdate');
  },
  installUpdate(): Promise<AppUpdateState> {
    return invoke('app:installUpdate');
  },
  onAppUpdate(listener: (state: AppUpdateState) => void): () => void {
    return on('app:update-state', listener);
  },
  chooseFiles(): Promise<{ canceled: boolean; paths?: string[] }> {
    return invoke('app:chooseFiles');
  },
  readFile(absPath: string): Promise<{ content: string; size: number; modifiedAt: number } | null> {
    return invoke('app:readFile', absPath);
  },
  statFile(absPath: string): Promise<{ size: number; modifiedAt: number } | null> {
    return invoke('app:statFile', absPath);
  },
  listDirectory(absPath: string, allowedRoots: string[]): Promise<FileTreeEntry[]> {
    return invoke('app:listDirectory', absPath, allowedRoots);
  },
  readFilePreview(absPath: string): Promise<FilePreviewResult | null> {
    return invoke('app:readFilePreview', absPath);
  },
  listGitChanges(cwd: string, allowedRoots: string[]): Promise<GitChangeEntry[]> {
    return invoke('app:listGitChanges', cwd, allowedRoots);
  },
  getPathForFile(file: File): string | null {
    try {
      const p = webUtils.getPathForFile(file);
      return p && p.length > 0 ? p : null;
    } catch {
      return null;
    }
  },
  terminalCreate(surfaceId: string, cwd: string, cols: number, rows: number): Promise<TerminalSurfaceSnapshot> {
    return invoke('terminal:create', surfaceId, cwd, cols, rows);
  },
  terminalWrite(surfaceId: string, data: string): void {
    send('terminal:write', surfaceId, data);
  },
  remoteAuthCreate(surfaceId: string, target: RemoteAuthenticationTarget, cols: number, rows: number): Promise<TerminalSurfaceSnapshot> {
    return invoke('remote-auth:create', surfaceId, target, cols, rows);
  },
  terminalResize(surfaceId: string, cols: number, rows: number): void {
    send('terminal:resize', surfaceId, cols, rows);
  },
  terminalDestroy(surfaceId: string): void {
    send('terminal:destroy', surfaceId);
  },
  terminalListActive(): Promise<Array<{ surfaceId: string }>> {
    return invoke('terminal:listActive');
  },
  onTerminalData(handler: (surfaceId: string, data: string) => void): () => void {
    return on('terminal:data', handler);
  },
  onTerminalExit(handler: (surfaceId: string, exitCode: number) => void): () => void {
    return on('terminal:exit', handler);
  },
  browserCreate(surfaceId: string, projectId: string, url: string): Promise<BrowserSurfaceState> {
    return invoke('browser:create', surfaceId, projectId, url);
  },
  browserSetBounds(surfaceId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): void {
    send('browser:set-bounds', surfaceId, bounds, visible);
  },
  browserNavigate(surfaceId: string, url: string): Promise<BrowserSurfaceState> {
    return invoke('browser:navigate', surfaceId, url);
  },
  browserBack(surfaceId: string): void { send('browser:back', surfaceId); },
  browserForward(surfaceId: string): void { send('browser:forward', surfaceId); },
  browserReload(surfaceId: string): void { send('browser:reload', surfaceId); },
  browserStop(surfaceId: string): void { send('browser:stop', surfaceId); },
  browserDestroy(surfaceId: string): void { send('browser:destroy', surfaceId); },
  onBrowserState(handler: (state: BrowserSurfaceState) => void): () => void {
    return on('browser:state', handler);
  },
  onBrowserFocus(handler: (surfaceId: string) => void): () => void {
    return on('browser:focus', handler);
  },
  onBrowserCloseRequest(handler: (surfaceId: string) => void): () => void {
    return on('browser:close-request', handler);
  },
} satisfies DesktopBridge & { getPathForFile(file: File): string | null };

contextBridge.exposeInMainWorld('electron', electronBridge);
