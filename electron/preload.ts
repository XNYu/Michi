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

contextBridge.exposeInMainWorld('electron', {
  isPackaged,
  michiWindowId,
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
