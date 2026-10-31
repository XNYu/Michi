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

/** A Settings page, or one of the older sections whose names specs still use. */
export type SettingsSection = 'General' | 'Runtime (global)' | 'Meta agent' | 'Components' | 'Appearance' | 'Data & backup'
  | 'Runtime & model' | 'Machines' | 'Notifications' | 'Links' | 'Backup & restore'
  | 'Scheduled jobs' | 'Keyboard shortcuts' | 'Account';

/** The global Settings (a window, or a drawer on a phone), separate from a Space's own settings. */
export function settingsMain(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Settings', exact: true }).locator('.terminal-settings');
}

/** The Settings header control: × for the window, Back on a phone. */
function settingsHeaderButton(page: Page, name: 'Close' | 'Back'): Locator {
  return page.getByRole('dialog', { name: 'Settings', exact: true }).locator('.ui-overlay-header').getByRole('button', { name, exact: true });
}

/**
 * The page that holds what an older section is opened for: General's
 * machines, the global runtime, and backup. Pages named like their section
 * need no entry.
 */
const PAGE_FOR_SECTION: Partial<Record<SettingsSection, SettingsSection>> = {
  General: 'Machines',
  'Runtime (global)': 'Runtime & model',
  'Data & backup': 'Backup & restore',
};

/** True when Settings fills a phone screen and shows its list and a page one at a time. */
async function settingsIsStacked(page: Page): Promise<boolean> {
  return (await settingsMain(page).getAttribute('data-stacked')) !== null;
}

/**
 * Opens a Settings page from its navigation. A phone shows one level at a
 * time, so from a page its header Back returns to the list first; there Data
 * & backup stays on the list, whose Data group holds Trash, Archived and backup.
 */
export async function selectSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  const nav = settingsMain(page).getByRole('navigation', { name: 'Settings sections' });
  const heading = settingsMain(page).getByRole('heading', { level: 1 });
  await nav.or(heading).filter({ visible: true }).first().waitFor();
  const stacked = await settingsIsStacked(page);
  if (stacked && !(await nav.isVisible())) await settingsHeaderButton(page, 'Back').click();
  if (stacked && section === 'Data & backup') {
    await nav.getByRole('group', { name: 'Data' }).waitFor();
    return;
  }
  const target = PAGE_FOR_SECTION[section] ?? section;
  await nav.getByRole('button', { name: target, exact: true }).click();
  await settingsMain(page).getByRole('heading', { level: 1, name: target, exact: true }).waitFor();
}

/**
 * Opens the global Settings, then the given page from its navigation.
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
