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

import type { RemoteAuthenticationTarget } from './remoteDiagnostics';

/** Public desktop payloads contain no Electron, DOM, Node, or process objects. */
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

export interface FileTreeEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

export interface GitChangeEntry {
  path: string;
  status: string;
}

export type FilePreviewResult =
  | { kind: 'text'; content: string; size: number; modifiedAt: number; extension: string }
  | { kind: 'image'; dataUrl: string; size: number; modifiedAt: number; extension: string };

/** Always-on backend (macOS LaunchAgent) state reported by Electron main. */
export interface BackgroundServiceStatus {
  supported: boolean;
  /** Why the service cannot be used on this install (dev build, platform…). */
  reason?: string;
  enabled: boolean;
  /** True when this window's backend is the background service. */
  running: boolean;
  port: number | null;
}

/** Thread a scheduled-run notification points at. */
export interface ScheduledRunTarget {
  runId: string;
  jobId: string;
  workspaceId: string;
  nodeId: string | null;
}

export interface ScheduledNotice {
  title: string;
  subtitle: string;
  body: string;
  target: ScheduledRunTarget;
}

export interface DesktopBridge {
  openExternal(url: string): void;
  /** Background service controls. Absent in browsers and older builds. */
  getBackgroundServiceStatus(): Promise<BackgroundServiceStatus>;
  setBackgroundServiceEnabled(enabled: boolean): Promise<BackgroundServiceStatus>;
  /** Set when this window was opened by clicking a scheduled-run notification. */
  initialScheduledRun: ScheduledRunTarget | null;
  onScheduledRunOpen(handler: (target: ScheduledRunTarget) => void): () => void;
  /** Scheduled-run notices delivered while this window is focused (shown as toasts). */
  onScheduledNotice(handler: (notice: ScheduledNotice) => void): () => void;
  onOpenUrl(handler: (url: string) => void): () => void;
  /** True only in `electron-builder` packaged builds. Absent in older builds — treat as false. */
  isPackaged: boolean;
  /** Stable id injected by Electron main for per-window renderer state. */
  michiWindowId: string;
  /** True when the window uses native macOS vibrancy (see-through). Absent in older builds / web. */
  hasVibrancy: boolean;
  chooseFolder(): Promise<ChooseFolderResult>;
  /** Open a multi-select folder picker, returns array of paths. Optional — absent in older builds. */
  chooseFolders(): Promise<ChooseFoldersResult>;
  /** Allocate a per-project scratch cwd outside TCC-protected dirs. Optional — absent in older builds. */
  resolveSkipCwd(projectId: string): Promise<{ path: string }>;
  saveMarkdown(suggestedName: string, content: string): Promise<SaveMarkdownResult>;
  /** Open an absolute path with the OS default app. Optional — absent in older builds. */
  openPath(absPath: string): Promise<{ ok: boolean; error?: string }>;
  /** Send an OS-level notification via Electron. Optional — absent in older builds. */
  showNotification(title: string, body: string): void;
  /** Sync native chrome and Browser panes to the active palette. Absent in older builds / web. */
  setDarkMaterial(dark: boolean, backgroundColor?: string): void;
  /** Switch the sidebar's native vibrancy material (desktop see-through density). Absent in older builds / web. */
  setVibrancy(material: VibrancyMaterial): void;
  /** Relaunch the app after self-update. Optional — absent in older builds. */
  relaunch(): void;
  getUpdateState(): Promise<AppUpdateState>;
  checkForUpdate(): Promise<AppUpdateState>;
  downloadUpdate(): Promise<AppUpdateState>;
  installUpdate(): Promise<AppUpdateState>;
  onAppUpdate(listener: (state: AppUpdateState) => void): () => void;
  /** Open a multi-select OS file picker, returns absolute paths. Optional — absent in older builds. */
  chooseFiles(): Promise<{ canceled: boolean; paths?: string[] }>;
  /** Read a file by absolute path (bypasses backend sandbox). Returns null on failure. Optional — absent in older builds. */
  readFile(absPath: string): Promise<{ content: string; size: number; modifiedAt: number } | null>;
  /** Stat a file by absolute path (size check without reading). Returns null on failure. Optional — absent in older builds. */
  statFile(absPath: string): Promise<{ size: number; modifiedAt: number } | null>;
  /** List one directory level after constraining the request to registered workspace roots. */
  listDirectory(absPath: string, allowedRoots: string[]): Promise<FileTreeEntry[]>;
  /** Read text or a supported image for the in-pane Files preview. */
  readFilePreview(absPath: string): Promise<FilePreviewResult | null>;
  /** Return git working-tree changes for a registered workspace root. */
  listGitChanges(cwd: string, allowedRoots: string[]): Promise<GitChangeEntry[]>;
  terminalCreate(surfaceId: string, cwd: string, cols: number, rows: number): Promise<TerminalSurfaceSnapshot>;
  remoteAuthCreate(surfaceId: string, target: RemoteAuthenticationTarget, cols: number, rows: number): Promise<TerminalSurfaceSnapshot>;
  terminalWrite(surfaceId: string, data: string): void;
  terminalResize(surfaceId: string, cols: number, rows: number): void;
  terminalDestroy(surfaceId: string): void;
  terminalListActive(): Promise<Array<{ surfaceId: string }>>;
  onTerminalData(handler: (surfaceId: string, data: string) => void): () => void;
  onTerminalExit(handler: (surfaceId: string, exitCode: number) => void): () => void;
  browserCreate(surfaceId: string, projectId: string, url: string): Promise<BrowserSurfaceState>;
  browserSetBounds(surfaceId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): void;
  browserNavigate(surfaceId: string, url: string): Promise<BrowserSurfaceState>;
  browserBack(surfaceId: string): void;
  browserForward(surfaceId: string): void;
  browserReload(surfaceId: string): void;
  browserStop(surfaceId: string): void;
  browserDestroy(surfaceId: string): void;
  onBrowserState(handler: (state: BrowserSurfaceState) => void): () => void;
  onBrowserFocus(handler: (surfaceId: string) => void): () => void;
  onBrowserCloseRequest(handler: (surfaceId: string) => void): () => void;
}

/** Existing desktop builds guarantee only these original methods. */
export type LegacyDesktopBridge = Pick<DesktopBridge, 'chooseFolder' | 'saveMarkdown'>
  & Partial<Omit<DesktopBridge, 'chooseFolder' | 'saveMarkdown'>>;

/** Channel contract shared by preload invoke calls and main response handlers. */
export interface DesktopInvokeContract {
  'app:getUpdateState': { args: []; result: AppUpdateState };
  'app:checkForUpdate': { args: []; result: AppUpdateState };
  'app:downloadUpdate': { args: []; result: AppUpdateState };
  'app:installUpdate': { args: []; result: AppUpdateState };
  'app:chooseFolder': { args: []; result: ChooseFolderResult };
  'app:chooseFolders': { args: []; result: ChooseFoldersResult };
  'app:resolveSkipCwd': { args: [projectId: string]; result: { path: string } };
  'app:saveMarkdown': { args: [suggestedName: string, content: string]; result: SaveMarkdownResult };
  'app:openPath': { args: [absPath: string]; result: { ok: boolean; error?: string } };
  'service:getStatus': { args: []; result: BackgroundServiceStatus };
  'service:setEnabled': { args: [enabled: boolean]; result: BackgroundServiceStatus };
  'app:chooseFiles': { args: []; result: { canceled: boolean; paths?: string[] } };
  'app:readFile': { args: [absPath: string]; result: { content: string; size: number; modifiedAt: number } | null };
  'app:statFile': { args: [absPath: string]; result: { size: number; modifiedAt: number } | null };
  'app:listDirectory': { args: [absPath: string, allowedRoots: string[]]; result: FileTreeEntry[] };
  'app:readFilePreview': { args: [absPath: string]; result: FilePreviewResult | null };
  'app:listGitChanges': { args: [cwd: string, allowedRoots: string[]]; result: GitChangeEntry[] };
  'terminal:create': { args: [surfaceId: string, cwd: string, cols: number, rows: number]; result: TerminalSurfaceSnapshot };
  'remote-auth:create': { args: [surfaceId: string, target: RemoteAuthenticationTarget, cols: number, rows: number]; result: TerminalSurfaceSnapshot };
  'terminal:listActive': { args: []; result: Array<{ surfaceId: string }> };
  'browser:create': { args: [surfaceId: string, projectId: string, url: string]; result: BrowserSurfaceState };
  'browser:navigate': { args: [surfaceId: string, url: string]; result: BrowserSurfaceState };
}

export type DesktopInvokeArgs<K extends keyof DesktopInvokeContract> = DesktopInvokeContract[K]['args'];
export type DesktopInvokeResult<K extends keyof DesktopInvokeContract> = DesktopInvokeContract[K]['result'];

export interface DesktopCommandContract {
  'app:openExternal': [url: string];
  'app:showNotification': [title: string, body: string];
  'app:setDarkMaterial': [dark: boolean, backgroundColor?: string];
  'app:setVibrancy': [material: VibrancyMaterial];
  'app:relaunch': [];
  'terminal:write': [surfaceId: string, data: string];
  'terminal:resize': [surfaceId: string, cols: number, rows: number];
  'terminal:destroy': [surfaceId: string];
  'browser:set-bounds': [surfaceId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean];
  'browser:back': [surfaceId: string];
  'browser:forward': [surfaceId: string];
  'browser:reload': [surfaceId: string];
  'browser:stop': [surfaceId: string];
  'browser:destroy': [surfaceId: string];
}

export interface DesktopEventContract {
  'app:update-state': [state: AppUpdateState];
  'app:openUrl': [url: string];
  'scheduled:open-run': [target: ScheduledRunTarget];
  'scheduled:notice': [notice: ScheduledNotice];
  'terminal:data': [surfaceId: string, data: string];
  'terminal:exit': [surfaceId: string, exitCode: number];
  'browser:state': [state: BrowserSurfaceState];
  'browser:focus': [surfaceId: string];
  'browser:close-request': [surfaceId: string];
}
