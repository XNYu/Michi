/**
 * Typed access to the Electron preload bridge. window.electron is undefined
 * when the app runs in a normal browser; callers must feature-detect.
 */
export interface ChooseFolderResult {
  canceled: boolean;
  path?: string;
  name?: string;
}

export interface SaveMarkdownResult {
  canceled: boolean;
  path?: string;
}

/** macOS NSVisualEffectView materials Michi exposes, lightest → densest frost. */
export type VibrancyMaterial = 'under-window' | 'sidebar' | 'menu' | 'hud';

export interface ElectronBridge {
  /** True only in `electron-builder` packaged builds. Absent in older builds — treat as false. */
  isPackaged?: boolean;
  /** Stable id injected by Electron main for per-window renderer state. */
  michiWindowId?: string;
  /** True when the window uses native macOS vibrancy (see-through). Absent in older builds / web. */
  hasVibrancy?: boolean;
  chooseFolder(): Promise<ChooseFolderResult>;
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
  /** Open a multi-select OS file picker, returns absolute paths. Optional — absent in older builds. */
  chooseFiles?(): Promise<{ canceled: boolean; paths?: string[] }>;
  /** Resolve absolute path of a File from drag-drop. Returns null if unavailable. Optional — absent in older builds. */
  getPathForFile?(file: File): string | null;
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
