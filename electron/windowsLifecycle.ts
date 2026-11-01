/**
 * Windows tray lifetime and opt-in login startup.
 * No `electron` import — tests inject adapters and drive this controller in Node.
 */

export const HIDDEN_LAUNCH_ARG = '--michi-hidden';
export const BACKGROUND_LAUNCH_ARG = '--michi-background-launch';
export const PACKAGED_TRAY_ICON_NAME = 'icon.ico';

export const TRAY_MENU = [
  { id: 'show', label: 'Show Michi' },
  { id: 'quit', label: 'Quit' },
] as const;

export interface LifetimePreferences {
  keepInBackground: boolean;
  openAtLogin: boolean;
}

export interface LifetimeSupportEnv {
  platform: string;
  isPackaged: boolean;
  isDev: boolean;
}

export interface LifetimeWindow {
  id: number;
  webContentsId: number;
  visible: boolean;
  minimized: boolean;
  destroyed: boolean;
}

export interface LoginItemSettings {
  openAtLogin: boolean;
  path: string;
  args: string[];
  enabled?: boolean;
}

export interface LoginItemSnapshot {
  openAtLogin: boolean;
  executableWillLaunchAtLogin?: boolean;
  enabled?: boolean;
}

export interface DesktopLifetimeStatus {
  supported: boolean;
  reason?: string;
  keepInBackground: boolean;
  openAtLogin: boolean;
  trayActive: boolean;
  canStartHidden: boolean;
}

export interface LifetimeAdapters {
  readPreferences(): unknown;
  writePreferences(prefs: LifetimePreferences): void;
  fileExists(path: string): boolean;
  execPath: string;
  createTray(): boolean;
  destroyTray(): void;
  hideWindow(id: number): void;
  restoreWindow(id: number): void;
  focusWindow(id: number): void;
  listWindows(): LifetimeWindow[];
  quit(): void;
  stopBackend(): void | Promise<void>;
  setLoginItem(settings: LoginItemSettings): boolean | void;
  getLoginItem(query: { path: string; args: string[] }): LoginItemSnapshot;
}

export type ReadyDecision = {
  createWindow: boolean;
  trayActive: boolean;
  startHidden: boolean;
};

export type CloseDecision = 'hide' | 'allow-close' | 'quit-close';
export type SecondInstanceDecision =
  | { action: 'ignore' }
  | { action: 'restore'; windowId: number }
  | { action: 'create-window' };

export function parseLifetimePreferences(raw: unknown): LifetimePreferences {
  if (!raw || typeof raw !== 'object') return { keepInBackground: false, openAtLogin: false };
  const value = raw as Record<string, unknown>;
  return {
    keepInBackground: value.keepInBackground === true,
    openAtLogin: value.openAtLogin === true,
  };
}

export function serializeLifetimePreferences(prefs: { keepInBackground?: unknown; openAtLogin?: unknown }): LifetimePreferences {
  return {
    keepInBackground: prefs.keepInBackground === true,
    openAtLogin: prefs.openAtLogin === true,
  };
}

export function isOwnedWindowSender(senderId: number, windowWebContentsIds: readonly number[]): boolean {
  return windowWebContentsIds.includes(senderId);
}

export function isOwnedLifetimeSender(input: {
  senderId: number;
  windowWebContentsIds: readonly number[];
  senderFrameIsMainFrame: boolean;
}): boolean {
  return input.senderFrameIsMainFrame && isOwnedWindowSender(input.senderId, input.windowWebContentsIds);
}

export function osWillLaunchAtLogin(snapshot: LoginItemSnapshot): boolean {
  if (snapshot.enabled === false) return false;
  if (snapshot.executableWillLaunchAtLogin === false) return false;
  return snapshot.openAtLogin === true;
}

function pathSep(value: string): string {
  return value.includes('\\') ? '\\' : '/';
}

function pathDirname(value: string): string {
  const sep = pathSep(value);
  const index = value.lastIndexOf(sep);
  return index < 0 ? value : value.slice(0, index);
}

function pathBasename(value: string): string {
  const sep = pathSep(value);
  const index = value.lastIndexOf(sep);
  return index < 0 ? value : value.slice(index + 1);
}

export function packagedTrayIconPath(resourcesPath: string): string {
  return `${resourcesPath}${pathSep(resourcesPath)}${PACKAGED_TRAY_ICON_NAME}`;
}

/** NSIS uses the app exe; Squirrel-style layouts launch the stub next to Update.exe. */
export function loginItemLaunchPath(execPath: string, exists: (path: string) => boolean): string {
  const parent = pathDirname(pathDirname(execPath));
  const stub = `${parent}${pathSep(execPath)}${pathBasename(execPath)}`;
  const updateExe = `${parent}${pathSep(execPath)}Update.exe`;
  return exists(updateExe) ? stub : execPath;
}

export function lifetimeSupport(env: LifetimeSupportEnv): { supported: boolean; reason?: string } {
  if (env.platform !== 'win32') return { supported: false, reason: 'Tray background mode is available on Windows.' };
  if (env.isDev || !env.isPackaged) return { supported: false, reason: 'Tray background mode is available in the installed Windows app.' };
  return { supported: true };
}

export class WindowsLifetimeController {
  private prefs: LifetimePreferences;
  private trayActive = false;
  private quitting = false;

  constructor(
    private readonly env: LifetimeSupportEnv,
    private readonly adapters: LifetimeAdapters,
  ) {
    this.prefs = parseLifetimePreferences(this.adapters.readPreferences());
  }

  status(): DesktopLifetimeStatus {
    const support = lifetimeSupport(this.env);
    if (!support.supported) {
      return {
        supported: false,
        reason: support.reason,
        keepInBackground: false,
        openAtLogin: false,
        trayActive: false,
        canStartHidden: false,
      };
    }
    return {
      supported: true,
      keepInBackground: this.prefs.keepInBackground,
      openAtLogin: this.osOpenAtLogin(),
      trayActive: this.trayActive,
      canStartHidden: this.canStartHidden(),
    };
  }

  onAppReady(input: { launchedHidden: boolean }): ReadyDecision {
    this.syncTray();
    const startHidden = input.launchedHidden && this.canStartHidden();
    return { createWindow: true, trayActive: this.trayActive, startHidden };
  }

  setKeepInBackground(enabled: boolean): DesktopLifetimeStatus {
    this.assertSupported();
    this.prefs = serializeLifetimePreferences({ ...this.prefs, keepInBackground: enabled });
    this.persistPrefs();
    this.syncTray();
    if (this.osOpenAtLogin() && !this.writeLoginItem(true)) {
      throw new Error('Windows could not update sign-in startup.');
    }
    return this.status();
  }

  setOpenAtLogin(enabled: boolean): DesktopLifetimeStatus {
    this.assertSupported();
    if (!this.writeLoginItem(enabled)) {
      throw new Error(enabled
        ? 'Windows could not enable open at sign-in.'
        : 'Windows could not update sign-in startup.');
    }
    this.prefs = serializeLifetimePreferences({ ...this.prefs, openAtLogin: enabled });
    this.persistPrefs();
    return this.status();
  }

  handleWindowClose(windowId: number): CloseDecision {
    if (this.quitting) return this.env.platform === 'win32' ? 'quit-close' : 'allow-close';
    if (!this.canStayInTray()) return 'allow-close';
    const others = this.adapters.listWindows().filter((window) => window.id !== windowId);
    if (others.length > 0) return 'allow-close';
    this.adapters.hideWindow(windowId);
    return 'hide';
  }

  shouldQuitWhenNoWindows(): boolean {
    return this.quitting || !this.canStayInTray();
  }

  beginQuit(_reason: 'user' | 'updater' | 'shutdown' | string): void {
    this.quitting = true;
  }

  async finalizeQuit(): Promise<void> {
    this.quitting = true;
    this.adapters.destroyTray();
    this.trayActive = false;
    await this.adapters.stopBackend();
  }

  handleSecondInstance(argv: readonly string[]): SecondInstanceDecision {
    if (argv.includes(BACKGROUND_LAUNCH_ARG)) return { action: 'ignore' };
    const windows = this.adapters.listWindows();
    const target = windows.find((window) => !window.visible)
      ?? windows.find((window) => window.minimized)
      ?? windows[0];
    if (!target) return { action: 'create-window' };
    this.adapters.restoreWindow(target.id);
    this.adapters.focusWindow(target.id);
    return { action: 'restore', windowId: target.id };
  }

  private supported(): boolean {
    return lifetimeSupport(this.env).supported;
  }

  private assertSupported(): void {
    const support = lifetimeSupport(this.env);
    if (!support.supported) throw new Error(support.reason ?? 'Tray background mode is available on Windows.');
  }

  private canStartHidden(): boolean {
    return this.supported() && this.prefs.keepInBackground && this.trayActive;
  }

  private canStayInTray(): boolean {
    return this.canStartHidden();
  }

  private persistPrefs(): void {
    this.adapters.writePreferences(serializeLifetimePreferences(this.prefs));
  }

  private syncTray(): void {
    if (this.supported() && this.prefs.keepInBackground) {
      this.trayActive = this.adapters.createTray();
      return;
    }
    if (this.trayActive) this.adapters.destroyTray();
    this.trayActive = false;
  }

  private launchPath(): string {
    return loginItemLaunchPath(this.adapters.execPath, (candidate) => this.adapters.fileExists(candidate));
  }

  private loginLaunch(): { path: string; args: string[] } {
    return {
      path: this.launchPath(),
      args: this.canStartHidden() ? [HIDDEN_LAUNCH_ARG] : [],
    };
  }

  private osOpenAtLogin(): boolean {
    if (!this.supported()) return false;
    const path = this.launchPath();
    return osWillLaunchAtLogin(this.adapters.getLoginItem({ path, args: [HIDDEN_LAUNCH_ARG] }))
      || osWillLaunchAtLogin(this.adapters.getLoginItem({ path, args: [] }));
  }

  private writeLoginItem(openAtLogin: boolean): boolean {
    const path = this.launchPath();
    if (!openAtLogin) {
      for (const args of [[HIDDEN_LAUNCH_ARG], []] as string[][]) {
        try { this.adapters.setLoginItem({ openAtLogin: false, path, args }); } catch { /* try the other args */ }
      }
      return !this.osOpenAtLogin();
    }
    const next = this.loginLaunch();
    try {
      if (this.adapters.setLoginItem({ openAtLogin: true, enabled: true, ...next }) === false) return false;
    } catch {
      return false;
    }
    return osWillLaunchAtLogin(this.adapters.getLoginItem(next));
  }
}
