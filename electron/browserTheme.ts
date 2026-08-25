export interface BrowserTheme {
  colorScheme: 'dark' | 'light';
  backgroundColor: string;
}

interface ThemeDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

export interface ThemeableBrowserView {
  setBackgroundColor(color: string): void;
  webContents: {
    debugger: ThemeDebugger;
  };
}

const SAFE_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

export function normalizeBrowserTheme(dark: unknown, backgroundColor: unknown): BrowserTheme {
  const isDark = dark === true;
  return {
    colorScheme: isDark ? 'dark' : 'light',
    backgroundColor: typeof backgroundColor === 'string' && SAFE_COLOR.test(backgroundColor)
      ? backgroundColor
      : isDark ? '#121212' : '#ffffff',
  };
}

/**
 * Match Chromium's preferred color scheme to Michi without modifying page CSS.
 * Sites that implement `prefers-color-scheme` switch natively; other sites are
 * left unchanged. The view background prevents a white flash during navigation.
 */
export async function applyBrowserTheme(view: ThemeableBrowserView, theme: BrowserTheme): Promise<void> {
  view.setBackgroundColor(theme.backgroundColor);
  const debuggerApi = view.webContents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
  await debuggerApi.sendCommand('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-color-scheme', value: theme.colorScheme }],
  });
}
