/**
 * Typed access to the Electron preload bridge. window.electron is undefined
 * when the app runs in a normal browser; callers must feature-detect.
 */
export interface ChooseFolderResult {
  canceled: boolean;
  path?: string;
  name?: string;
}

export interface ChooseFoldersResult {
  canceled: boolean;
  folders: Array<{ path: string; name: string }>;
}

export interface SaveMarkdownResult {
  canceled: boolean;
  path?: string;
}

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'unavailable'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
  percent?: number;
  error?: string;
}

/** macOS NSVisualEffectView materials Michi exposes, lightest → densest frost. */
export type VibrancyMaterial = 'under-window' | 'sidebar' | 'menu' | 'hud';

export interface BrowserSurfaceState {
  surfaceId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface TerminalSurfaceSnapshot {
  surfaceId: string;
  data: string;
  exited: boolean;
  exitCode?: number;
}

export interface ElectronBridge {
  /** True only in `electron-builder` packaged builds. Absent in older builds — treat as false. */
  isPackaged?: boolean;
  /** Stable id injected by Electron main for per-window renderer state. */
  michiWindowId?: string;
  /** True when the window uses native macOS vibrancy (see-through). Absent in older builds / web. */
  hasVibrancy?: boolean;
  chooseFolder(): Promise<ChooseFolderResult>;
  /** Open a multi-select folder picker, returns array of paths. Optional — absent in older builds. */
  chooseFolders?(): Promise<ChooseFoldersResult>;
  /** Allocate a per-project scratch cwd outside TCC-protected dirs. Optional — absent in older builds. */
  resolveSkipCwd?(projectId: string): Promise<{ path: string }>;
  saveMarkdown(suggestedName: string, content: string): Promise<SaveMarkdownResult>;
  /** Open an absolute path with the OS default app. Optional — absent in older builds. */
  openPath?(absPath: string): Promise<{ ok: boolean; error?: string }>;
  /** Send an OS-level notification via Electron. Optional — absent in older builds. */
  showNotification?(title: string, body: string): void;
  /** Sync the native vibrancy material light/dark to the palette. Absent in older builds / web. */
  setDarkMaterial?(dark: boolean): void;
  /** Switch the sidebar's native vibrancy material (desktop see-through density). Absent in older builds / web. */
  setVibrancy?(material: VibrancyMaterial): void;
  /** Relaunch the app after self-update. Optional — absent in older builds. */
  relaunch?(): void;
  getUpdateState?(): Promise<AppUpdateState>;
  checkForUpdate?(): Promise<AppUpdateState>;
  downloadUpdate?(): Promise<AppUpdateState>;
  installUpdate?(): Promise<AppUpdateState>;
  onAppUpdate?(listener: (state: AppUpdateState) => void): () => void;
  /** Open a multi-select OS file picker, returns absolute paths. Optional — absent in older builds. */
  chooseFiles?(): Promise<{ canceled: boolean; paths?: string[] }>;
  /** Read a file by absolute path (bypasses backend sandbox). Returns null on failure. Optional — absent in older builds. */
  readFile?(absPath: string): Promise<{ content: string; size: number; modifiedAt: number } | null>;
  /** Stat a file by absolute path (size check without reading). Returns null on failure. Optional — absent in older builds. */
  statFile?(absPath: string): Promise<{ size: number; modifiedAt: number } | null>;
  /** Resolve absolute path of a File from drag-drop. Returns null if unavailable. Optional — absent in older builds. */
  getPathForFile?(file: File): string | null;
  terminalCreate?(surfaceId: string, cwd: string, cols: number, rows: number): Promise<TerminalSurfaceSnapshot>;
  terminalWrite?(surfaceId: string, data: string): void;
  terminalResize?(surfaceId: string, cols: number, rows: number): void;
  terminalDestroy?(surfaceId: string): void;
  onTerminalData?(handler: (surfaceId: string, data: string) => void): () => void;
  onTerminalExit?(handler: (surfaceId: string, exitCode: number) => void): () => void;
  browserCreate?(surfaceId: string, projectId: string, url: string): Promise<BrowserSurfaceState>;
  browserSetBounds?(surfaceId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): void;
  browserNavigate?(surfaceId: string, url: string): Promise<BrowserSurfaceState>;
  browserBack?(surfaceId: string): void;
  browserForward?(surfaceId: string): void;
  browserReload?(surfaceId: string): void;
  browserStop?(surfaceId: string): void;
  browserDestroy?(surfaceId: string): void;
  onBrowserState?(handler: (state: BrowserSurfaceState) => void): () => void;
  onBrowserFocus?(handler: (surfaceId: string) => void): () => void;
  onBrowserCloseRequest?(handler: (surfaceId: string) => void): () => void;
}

declare global {
  interface Window {
    electron?: ElectronBridge;
  }
}

export function getElectron(): ElectronBridge | null {
  if (typeof window === 'undefined') return null;
  return window.electron ?? null;
}
