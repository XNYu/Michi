import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { areaButton, openArea } from '../fixtures/shell';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';

const workspace = {
  workspace: { id: 'ws-release', name: 'Release work', created_at: 1 },
  trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [],
};

test('Spaces opens on its Home, a workspace home opens from the sidebar, and ⌘J opens, minimises and restores the assistant', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const spaces = createSpacesHomeMock({
    homeBlocks: [{ id: 'home-lead', rev: 1, type: 'markdown', text: 'Two threads moved overnight.' }],
    workspaceHomes: { 'ws-release': { name: 'Release work', blocks: [{ id: 'ws-lead', rev: 1, type: 'markdown', text: 'The release is waiting on QA.' }] } },
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, { workspaces: [workspace], custom: spaces.handle });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();

  // The rail's Spaces button always lands on the Spaces Home.
  await openArea(page, 'spaces');
  await expect(areaButton(page, 'spaces')).toHaveAttribute('aria-current', 'page');
  const home = page.locator('main.spaces-home');
  await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(home.getByText('Two threads moved overnight.')).toBeVisible();
  const sidebar = page.locator('.spaces-side');
  await expect(sidebar.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');

  // A workspace row opens that workspace's home.
  await sidebar.getByRole('button', { name: /^Release work/ }).click();
  const workspaceHome = page.getByRole('main', { name: 'Release work' });
  await expect(workspaceHome.getByRole('heading', { name: 'Release work', level: 1 })).toBeVisible();
  await expect(workspaceHome.getByText('The release is waiting on QA.')).toBeVisible();
  await expect(sidebar.locator('[data-workspace="ws-release"]')).toHaveAttribute('aria-current', 'page');
  expect(spaces.requests).toContain('GET /workspaces/ws-release/home');

  // Browser-style history returns to this exact workspace home, not global Home.
  await openArea(page, 'conversations');
  await page.getByRole('button', { name: 'Navigate back', exact: true }).click();
  await expect(workspaceHome.getByRole('heading', { name: 'Release work', level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+]');
  await expect(areaButton(page, 'conversations')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ControlOrMeta+[');
  await expect(workspaceHome.getByRole('heading', { name: 'Release work', level: 1 })).toBeVisible();


  // The assistant window floats over Spaces by default; start from its minimised pill.
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  // The minimised window's pill; home blocks also have a hover "Ask assistant" button.
  const pill = page.locator('button.meta-chat-pill');
  await assistant.or(pill).first().waitFor();
  if (await assistant.isVisible()) await assistant.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(pill).toBeVisible();
  await expect(assistant).toBeHidden();

  // ⌘J (Ctrl+J) opens it floating, on the page on screen.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(assistant).toBeVisible();
  await expect(assistant).toHaveAttribute('data-form', 'float');
  await expect(assistant).toContainText('Viewing: Release work');
  await expect(pill).toBeHidden();

  // Minimise from the title bar, restore from the pill.
  await assistant.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(assistant).toBeHidden();
  await pill.click();
  await expect(assistant).toBeVisible();
  await expect(assistant).toHaveAttribute('data-form', 'float');

  // ⌘J minimises it again, and the next ⌘J restores it.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(pill).toBeVisible();
  await expect(assistant).toBeHidden();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(assistant).toBeVisible();

  // The window belongs to Spaces: hidden in Conversations, back on return.
  await openArea(page, 'conversations');
  await expect(assistant).toBeHidden();
  await expect(pill).toBeHidden();
  await openArea(page, 'spaces');
  await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(assistant).toBeVisible();
  expect(errors).toEqual([]);
});
