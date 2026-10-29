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
  const button = areaButton(page, area);
  // A narrow window has no rail: its area tabs live in the sidebar overlay.
  const openSidebar = page.getByRole('button', { name: 'Open sidebar', exact: true });
  await button.or(openSidebar).first().waitFor();
  if (!(await button.isVisible())) await openSidebar.click();
  await button.click();
}

export type SettingsSection = 'General' | 'Runtime (global)' | 'Meta agent' | 'Components' | 'Appearance' | 'Data & backup';

/** The global Settings drawer's content, separate from a Space's own settings. */
export function settingsMain(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Settings', exact: true }).locator('.terminal-settings--drawer');
}

/** The Settings drawer's header control: × on a wide window, Back on a phone. */
function settingsHeaderButton(page: Page, name: 'Close' | 'Back'): Locator {
  return page.getByRole('dialog', { name: 'Settings', exact: true }).locator('.ui-overlay-header').getByRole('button', { name, exact: true });
}

/**
 * Selects a section from the drawer's categories. A phone shows one level at
 * a time, so from a section its header Back returns to the list first.
 */
export async function selectSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  const nav = settingsMain(page).getByRole('navigation', { name: 'Settings sections' });
  const heading = settingsMain(page).getByRole('heading', { level: 1 });
  await nav.or(heading).filter({ visible: true }).first().waitFor();
  if (!(await nav.isVisible())) await settingsHeaderButton(page, 'Back').click();
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

/**
 * Dismisses Settings and leaves the underlying page where it was. A phone's
 * Back steps from a section to the list before it closes.
 */
export async function leaveSettings(page: Page): Promise<void> {
  const close = settingsHeaderButton(page, 'Close');
  const back = settingsHeaderButton(page, 'Back');
  await close.or(back).first().waitFor();
  if (await close.isVisible()) await close.click();
  else {
    const nav = settingsMain(page).getByRole('navigation', { name: 'Settings sections' });
    if (!(await nav.isVisible())) { await back.click(); await nav.waitFor(); }
    await back.click();
  }
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
