import { contextBridge, ipcRenderer, webUtils } from 'electron';

interface ChooseFolderResult {
  canceled: boolean;
  path?: string;
  name?: string;
}

interface ChooseFoldersResult {
  canceled: boolean;
  folders: Array<{ path: string; name: string }>;
}

interface SaveMarkdownResult {
  canceled: boolean;
  path?: string;
}

interface BrowserSurfaceState {
  surfaceId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

const isPackaged: boolean = ipcRenderer.sendSync('app:isPackaged') === true;
const michiWindowId: string = new URLSearchParams(window.location.search).get('michiWindowId') ?? '';
const hasVibrancy: boolean = ipcRenderer.sendSync('app:vibrancy') === true;

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

// Belt-and-suspenders: intercept clicks on external <a> at the DOM level so
// they ALWAYS open in the system browser, regardless of target/_blank/Streamdown
// rendering quirks. Fires before Chromium's navigation or window-open machinery.
function isExternalUrl(href: string): boolean {
  try {
    const u = new URL(href, window.location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname !== 'localhost' && u.hostname !== '127.0.0.1';
  } catch {
    return false;
  }
}

document.addEventListener('click', (e) => {
  const anchor = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!href) return;
  if (isExternalUrl(href)) {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('app:openExternal', href);
  }
}, true);

contextBridge.exposeInMainWorld('electron', {
  isPackaged,
  michiWindowId,
  hasVibrancy,
  chooseFolder(): Promise<ChooseFolderResult> {
    return ipcRenderer.invoke('app:chooseFolder');
  },
  chooseFolders(): Promise<ChooseFoldersResult> {
    return ipcRenderer.invoke('app:chooseFolders');
  },
  resolveSkipCwd(projectId: string): Promise<{ path: string }> {
    return ipcRenderer.invoke('app:resolveSkipCwd', projectId);
  },
  saveMarkdown(suggestedName: string, content: string): Promise<SaveMarkdownResult> {
    return ipcRenderer.invoke('app:saveMarkdown', suggestedName, content);
  },
  openPath(absPath: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('app:openPath', absPath);
  },
  /** Fire-and-forget OS notification via main process. */
  showNotification(title: string, body: string): void {
    ipcRenderer.send('app:showNotification', title, body);
  },
  /** Match the native vibrancy material's light/dark to the active palette. */
  setDarkMaterial(dark: boolean): void {
    ipcRenderer.send('app:setDarkMaterial', dark);
  },
  /** Switch the sidebar's native vibrancy material (desktop see-through density). */
  setVibrancy(material: string): void {
    ipcRenderer.send('app:setVibrancy', material);
  },
  /** Relaunch the app (used after self-update). */
  relaunch(): void {
    ipcRenderer.send('app:relaunch');
  },
  getUpdateState(): Promise<AppUpdateState> {
    return ipcRenderer.invoke('app:getUpdateState');
  },
  checkForUpdate(): Promise<AppUpdateState> {
    return ipcRenderer.invoke('app:checkForUpdate');
  },
  downloadUpdate(): Promise<AppUpdateState> {
    return ipcRenderer.invoke('app:downloadUpdate');
  },
  installUpdate(): Promise<AppUpdateState> {
    return ipcRenderer.invoke('app:installUpdate');
  },
  onAppUpdate(listener: (state: AppUpdateState) => void): () => void {
    const handler = (_ev: unknown, state: AppUpdateState) => { listener(state); };
    ipcRenderer.on('app:update-state', handler);
    return () => { ipcRenderer.removeListener('app:update-state', handler); };
  },
  chooseFiles(): Promise<{ canceled: boolean; paths?: string[] }> {
    return ipcRenderer.invoke('app:chooseFiles');
  },
  readFile(absPath: string): Promise<{ content: string; size: number; modifiedAt: number } | null> {
    return ipcRenderer.invoke('app:readFile', absPath);
  },
  statFile(absPath: string): Promise<{ size: number; modifiedAt: number } | null> {
    return ipcRenderer.invoke('app:statFile', absPath);
  },
  getPathForFile(file: File): string | null {
    try {
      const p = webUtils.getPathForFile(file);
      return p && p.length > 0 ? p : null;
    } catch {
      return null;
    }
  },
  terminalCreate(surfaceId: string, cwd: string, cols: number, rows: number) {
    return ipcRenderer.invoke('terminal:create', surfaceId, cwd, cols, rows);
  },
  terminalWrite(surfaceId: string, data: string): void {
    ipcRenderer.send('terminal:write', surfaceId, data);
  },
  terminalResize(surfaceId: string, cols: number, rows: number): void {
    ipcRenderer.send('terminal:resize', surfaceId, cols, rows);
  },
  terminalDestroy(surfaceId: string): void {
    ipcRenderer.send('terminal:destroy', surfaceId);
  },
  onTerminalData(handler: (surfaceId: string, data: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, surfaceId: string, data: string) => handler(surfaceId, data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit(handler: (surfaceId: string, exitCode: number) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, surfaceId: string, exitCode: number) => handler(surfaceId, exitCode);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  browserCreate(surfaceId: string, projectId: string, url: string): Promise<BrowserSurfaceState> {
    return ipcRenderer.invoke('browser:create', surfaceId, projectId, url);
  },
  browserSetBounds(surfaceId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): void {
    ipcRenderer.send('browser:set-bounds', surfaceId, bounds, visible);
  },
  browserNavigate(surfaceId: string, url: string): Promise<BrowserSurfaceState> {
    return ipcRenderer.invoke('browser:navigate', surfaceId, url);
  },
  browserBack(surfaceId: string): void { ipcRenderer.send('browser:back', surfaceId); },
  browserForward(surfaceId: string): void { ipcRenderer.send('browser:forward', surfaceId); },
  browserReload(surfaceId: string): void { ipcRenderer.send('browser:reload', surfaceId); },
  browserStop(surfaceId: string): void { ipcRenderer.send('browser:stop', surfaceId); },
  browserDestroy(surfaceId: string): void { ipcRenderer.send('browser:destroy', surfaceId); },
  onBrowserState(handler: (state: BrowserSurfaceState) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserSurfaceState) => handler(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
  onBrowserFocus(handler: (surfaceId: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, surfaceId: string) => handler(surfaceId);
    ipcRenderer.on('browser:focus', listener);
    return () => ipcRenderer.removeListener('browser:focus', listener);
  },
  onBrowserCloseRequest(handler: (surfaceId: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, surfaceId: string) => handler(surfaceId);
    ipcRenderer.on('browser:close-request', listener);
    return () => ipcRenderer.removeListener('browser:close-request', listener);
  },
});
