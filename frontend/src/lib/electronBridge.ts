/** Typed access to the preload bridge. Browser callers must feature-detect it. */
import type { LegacyDesktopBridge } from 'michi-shared';
export type {
  AppUpdateState, AppUpdateStatus, ChooseFolderResult, ChooseFoldersResult, SaveMarkdownResult, VibrancyMaterial,
  BrowserSurfaceState, TerminalSurfaceSnapshot, FileTreeEntry, GitChangeEntry,
  FilePreviewResult, BackgroundServiceStatus, ScheduledRunTarget, ScheduledNotice,
} from 'michi-shared';

export interface ElectronBridge extends LegacyDesktopBridge {
  /** DOM File stays at the renderer/preload boundary, outside the IPC DTOs. */
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
