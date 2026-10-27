import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

/** Argument Electron recognizes as "start without a window to deliver notifications". */
export const BACKGROUND_LAUNCH_ARG = '--michi-background-launch';

export interface AppLauncher {
  /** Ask the desktop app to start (hidden) so it can show pending notifications. */
  wake(): boolean;
}

type ExecFile = (file: string, args: string[], callback: (error: Error | null) => void) => void;

export interface DesktopAppLauncherOptions {
  bundlePath?: string | null;
  enabled?: boolean;
  platform?: NodeJS.Platform;
  throttleMs?: number;
  clock?: () => number;
  exec?: ExecFile;
  exists?: (file: string) => boolean;
}

/**
 * Only the macOS background service launches the app: the backend itself
 * cannot show clickable notifications, and a forked child exits with the app.
 */
export function createDesktopAppLauncher(options: DesktopAppLauncherOptions = {}): AppLauncher {
  const bundlePath = options.bundlePath ?? process.env.MICHI_APP_BUNDLE ?? null;
  const enabled = options.enabled ?? process.env.MICHI_SERVICE_MODE === '1';
  const platform = options.platform ?? process.platform;
  const throttleMs = options.throttleMs ?? 60_000;
  const clock = options.clock ?? Date.now;
  const exec: ExecFile = options.exec ?? ((file, args, callback) => {
    execFile(file, args, { timeout: 15_000 }, (error) => callback(error));
  });
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));
  let lastWakeAt = Number.NEGATIVE_INFINITY;

  const validBundle = !!bundlePath
    && path.isAbsolute(bundlePath)
    && bundlePath.endsWith('.app')
    && !bundlePath.includes('\0');

  return {
    wake() {
      if (!enabled || platform !== 'darwin' || !validBundle || !exists(bundlePath!)) return false;
      const now = clock();
      if (now - lastWakeAt < throttleMs) return false;
      lastWakeAt = now;
      // -g: do not bring to the foreground. -j: launch hidden. Arguments are
      // passed as an argv array; nothing goes through a shell.
      exec('/usr/bin/open', ['-g', '-j', bundlePath!, '--args', BACKGROUND_LAUNCH_ARG], (error) => {
        if (error) log.warn('scheduler', 'could not wake the desktop app', { error: error.message });
      });
      return true;
    },
  };
}
