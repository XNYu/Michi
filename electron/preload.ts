import { contextBridge, ipcRenderer, webUtils } from 'electron';

interface ChooseFolderResult {
  canceled: boolean;
  path?: string;
  name?: string;
}

interface SaveMarkdownResult {
  canceled: boolean;
  path?: string;
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

contextBridge.exposeInMainWorld('electron', {
  isPackaged,
  michiWindowId,
  hasVibrancy,
  chooseFolder(): Promise<ChooseFolderResult> {
    return ipcRenderer.invoke('app:chooseFolder');
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
  chooseFiles(): Promise<{ canceled: boolean; paths?: string[] }> {
    return ipcRenderer.invoke('app:chooseFiles');
  },
  getPathForFile(file: File): string | null {
    try {
      const p = webUtils.getPathForFile(file);
      return p && p.length > 0 ? p : null;
    } catch {
      return null;
    }
  },
});
