import type { Locator, Page } from '@playwright/test';

/**
 * The conversation composers' editors. The Spaces assistant window stays
 * mounted (hidden) outside Spaces so it keeps its draft; its editor is not one
 * of these.
 */
export const COMPOSER_EDITOR = '[contenteditable="true"]:not(.meta-chat-panel *)';

/** A conversation composer (Home, a pane, Digest), not the Spaces assistant window's. */
export const CONVERSATION_COMPOSER = '.terminal-composer:not(.meta-chat-panel *)';

export function composerEditor(scope: Page | Locator): Locator {
  return scope.locator(COMPOSER_EDITOR);
}

export type ShellArea = 'conversations' | 'spaces' | 'scheduled' | 'settings';

/** One of the left rail's area buttons. Its accessible name carries its badge, so match by area. */
export function areaButton(page: Page, area: ShellArea): Locator {
  return page.getByRole('navigation', { name: 'Areas' }).locator(`button[data-area="${area}"]`);
}

export async function openArea(page: Page, area: ShellArea): Promise<void> {
  await areaButton(page, area).click();
}

export type SettingsSection = 'General' | 'Runtime (global)' | 'Meta agent' | 'Components' | 'Assistant' | 'Appearance' | 'Data & backup';

/** The global Settings drawer's content, separate from a Space's own settings. */
export function settingsMain(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Settings', exact: true }).locator('.terminal-settings--drawer');
}

/** Settings keeps its categories inside the drawer at every window width. */
export async function selectSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  const nav = settingsMain(page).getByRole('navigation', { name: 'Settings sections' });
  await nav.getByRole('button', { name: section, exact: true }).click();
  await settingsMain(page).getByRole('heading', { level: 1, name: section, exact: true }).waitFor();
}

/**
 * Opens the global Settings drawer, then the given section from its categories.
 */
export async function openSettings(page: Page, section?: SettingsSection): Promise<Locator> {
  const main = settingsMain(page);
  if (!(await main.isVisible())) await openArea(page, 'settings');
  await main.waitFor();
  if (section) await selectSettingsSection(page, section);
  return main;
}

/** Dismisses Settings and leaves the underlying page where it was. */
export async function leaveSettings(page: Page): Promise<void> {
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await settingsMain(page).waitFor({ state: 'detached' });
}

/**
 * Opens a conversation from the Conversations sidebar, as Home no longer lists
 * recent threads. A collapsed wide sidebar opens for the click and collapses
 * again; the narrow overlay closes by itself once a thread opens.
 */
export async function openThreadFromSidebar(page: Page, name: string): Promise<void> {
  const row = page.locator('.terminal-sidebar').getByText(name, { exact: true }).first();
  const open = page.getByRole('button', { name: 'Open sidebar', exact: true });
  await row.or(open).first().waitFor();
  if (await row.isVisible()) {
    await row.click();
    return;
  }
  // A narrow window renders no sidebar until its overlay opens.
  const wideCollapsed = (await page.locator('.terminal-sidebar[data-collapsed]').count()) > 0;
  await open.click();
  await row.click();
  if (wideCollapsed) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
}
