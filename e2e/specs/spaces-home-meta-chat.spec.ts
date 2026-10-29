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

test('floating assistant stays inset when dragged, resized, and the viewport shrinks', async ({ page }) => {
  const spaces = createSpacesHomeMock({ homeBlocks: [] });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:metaChat:window:v1', JSON.stringify({
      form: 'float', minimized: false, rect: { x: 650, y: 300, w: 450, h: 600 }, dockRatio: 50,
    }));
  });
  await installMockApi(page, { workspaces: [workspace], custom: spaces.handle });
  await page.goto('/');
  await openArea(page, 'spaces');
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  await expect(assistant).toBeVisible();
  const expectInside = async () => {
    await expect.poll(async () => assistant.evaluate((el) => {
      const panel = el.getBoundingClientRect();
      const area = el.closest('.meta-chat-area')!.getBoundingClientRect();
      return Math.min(panel.left - area.left, panel.top - area.top, area.right - panel.right, area.bottom - panel.bottom);
    })).toBeGreaterThanOrEqual(17.5);
  };
  await expectInside();
  const title = await assistant.locator('header').boundingBox();
  await page.mouse.move(title!.x + 30, title!.y + 20);
  await page.mouse.down();
  await page.mouse.move(0, 990, { steps: 5 });
  await expectInside();
  await page.mouse.up();
  const corner = await assistant.locator('[data-dir="se"]').boundingBox();
  await page.mouse.move(corner!.x + 5, corner!.y + 5);
  await page.mouse.down();
  await page.mouse.move(1435, 995, { steps: 5 });
  await page.mouse.up();
  await expectInside();
  await page.setViewportSize({ width: 800, height: 500 });
  await expectInside();
  await expect(assistant.getByRole('button', { name: 'Minimize', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectInside();
});
