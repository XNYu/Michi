import { expect, test } from '@playwright/test';
import type { HomeCardsDto, PageDto } from 'michi-shared';
import { installMockApi } from '../fixtures/mockApi';
import { createPagesMockController } from '../fixtures/pagesFixtures';
import { COMPOSER_EDITOR, openArea } from '../fixtures/shell';

test('Chat Home renders and edits a native Page below its working composer, survives reload and restores defaults', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const mock = createPagesMockController();
  const doc: PageDto = {
    id: 'my-chat-home', workspaceId: 'home-ws', parentId: null, position: 0,
    title: 'My Home', color: null, updatedAt: 1, updatedBy: 'agent', pendingProposals: 0,
    helperNodeId: null, revision: 1, viewVersion: 1,
    blocks: [
      { id: 'focus', rev: 1, type: 'heading', level: 2, text: 'My weekly focus' },
      { id: 'note', rev: 1, type: 'markdown', text: 'Keep this space personal.' },
      { id: 'columns', rev: 1, type: 'grid', regions: [
        { id: 'links', title: 'Common links', span: 6, tabletSpan: 12, blocks: [{ type: 'markdown', text: '[Documentation](https://example.com)' }] },
        { id: 'todos', title: 'My tasks', span: 6, tabletSpan: 12, blocks: [{ type: 'markdown', text: 'Prepare next week.' }] },
      ] },
      { id: 'check', rev: 1, type: 'checklist', items: [{ text: 'Review the plan', done: false }] },
    ],
  };
  mock.pages.set(doc.id, doc);
  let contentMode: HomeCardsDto['contentMode'] = 'page';
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'home-ws', name: 'My workspace', created_at: 1 }, trees: [], nodes: [], messages: [], edges: [], artifacts: [] }],
    custom: async route => {
      const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
      if (path === '/home/cards') {
        await route.fulfill({ json: { greeting: null, sets: [], generatedAt: null, inputFingerprint: null,
          contentMode, contentPage: contentMode === 'page' ? mock.pages.get(doc.id) : null } satisfies HomeCardsDto });
        return true;
      }
      return mock.handle(route);
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:migrated', '1');
    if (!localStorage.getItem('michi:v1:prefs')) localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
  });
  await page.goto('/');
  const body = page.getByRole('region', { name: 'Home content' });
  await expect(body.getByRole('heading', { name: 'My weekly focus' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Quick starts' })).toHaveCount(0);
  const links = body.locator('[data-region-id="links"]');
  const todos = body.locator('[data-region-id="todos"]');
  await expect.poll(async () => {
    const a = await links.boundingBox(); const b = await todos.boundingBox();
    return !!a && !!b && Math.abs(a.y - b.y) < 2 && b.x > a.x + a.width;
  }).toBe(true);
  await page.setViewportSize({ width: 960, height: 1000 });
  await expect.poll(async () => {
    const a = await links.boundingBox(); const b = await todos.boundingBox();
    return !!a && !!b && b.y > a.y && Math.abs(a.x - b.x) < 2;
  }).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await expect(page.locator('[data-testid="home-card"]')).toHaveCount(0);
  await page.locator(COMPOSER_EDITOR).first().fill('Arrange my Home');
  await expect(page.locator(COMPOSER_EDITOR).first()).toContainText('Arrange my Home');
  const check = body.getByRole('checkbox', { name: 'Review the plan' });
  await expect(body.getByRole('button', { name: 'Edit', exact: true }).first()).toBeVisible();
  await expect(check).not.toHaveAttribute('aria-readonly', 'true');
  await check.click();
  await expect.poll(() => mock.writes.filter(write => write.path.includes('/edits')).length).toBe(1);
  await page.reload();
  await expect(body.getByRole('heading', { name: 'My weekly focus' })).toBeVisible();
  await expect(body.getByRole('checkbox', { name: 'Review the plan' })).toBeChecked();
  await openArea(page, 'settings');
  const settings = page.locator('.terminal-settings--drawer');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  const recommendations = settings.getByRole('switch', { name: 'Pages recommendations on Home' });
  await expect(recommendations).toBeChecked();
  await recommendations.click();
  await expect(recommendations).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('michi:v1:prefs')!).homeRecommendations)).toBe(false);
  await page.reload();
  await expect(body).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Quick starts' })).toBeVisible();
  await expect(page.locator('.terminal-sidebar').getByRole('button', { name: /^All threads/ })).toHaveCount(0);
  await openArea(page, 'settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(recommendations).not.toBeChecked();
  await recommendations.click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('michi:v1:prefs')!).homeRecommendations)).toBe(true);
  await page.reload();
  await expect(body.getByRole('heading', { name: 'My weekly focus' })).toBeVisible();
  contentMode = 'hidden';
  await page.reload();
  await expect(page.locator('.home-page')).toBeVisible();
  await expect(body).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Quick starts' })).toHaveCount(0);
  contentMode = 'default';
  await page.reload();
  await expect(page.getByRole('group', { name: 'Quick starts' })).toBeVisible();
  expect(mock.pages.get(doc.id)?.blocks).toHaveLength(4);
  expect(errors).toEqual([]);
});
