import { createContext, useContext } from 'react';

/**
 * Where the Settings panes render: a drawer that fills a phone screen, or the
 * desktop Settings window. Panes leave out what only applies to a desktop
 * window on a phone (pane layout, keyboard shortcuts, the desktop app's
 * background service), and use the window's width for previews.
 */
export type SettingsLayout = 'phone' | 'window';

export const SettingsLayoutContext = createContext<SettingsLayout>('window');

export function useSettingsLayout(): SettingsLayout {
  return useContext(SettingsLayoutContext);
}

export function useSettingsPhone(): boolean {
  return useContext(SettingsLayoutContext) === 'phone';
}

/**
 * The setting a search result opened, by its name as the page shows it, so a
 * pane can reveal it (Appearance opens Advanced for an advanced setting).
 */
export const SettingsTargetContext = createContext<string | null>(null);

export function useSettingsTarget(): string | null {
  return useContext(SettingsTargetContext);
}
