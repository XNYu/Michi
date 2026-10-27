import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { PageLayoutRule } from 'michi-shared';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { createPagesMockController } from '../fixtures/pagesFixtures';
import { leaveSettings, openArea, openSettings } from '../fixtures/shell';

const evidence = resolve('.artifacts/spaces-michi-refinement');

for (const palette of ['bone', 'monokai']) test(`Space settings and component previews stay plain and usable in ${palette}`, async ({ page }) => {
  mkdirSync(evidence, { recursive: true });
  const mock = createPagesMockController();
  const errors: string[] = [];
  let rules: PageLayoutRule[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await installMockApi(page, { custom: async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/prefs' && method === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette, uiFont: 'Geist' } } }); return true;
    }
    if (/\/workspaces\/[^/]+\/components$/.test(path)) {
      await route.fulfill({ json: { revision: 0, items: [] } }); return true;
    }
    if (/\/workspaces\/[^/]+\/maintenance$/.test(path)) {
      await route.fulfill({ json: { config: null, job: null, status: null, backlog: { plans: [], pendingSources: 0, attentionSources: 0 }, excludedSpaceIds: [], catchUpSuggestions: [] } }); return true;
    }
    if (path.startsWith('/api/pages/page-1/layout-rules')) {
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        const rule: PageLayoutRule = { id: 'rule-1', text: body.text, createdBy: 'user', createdAt: Date.now(), sourceMessage: null };
        rules = [rule];
        await route.fulfill({ json: rule });
      } else {
        if (method === 'DELETE') rules = [];
        await route.fulfill({ json: { items: rules } });
      }
      return true;
    }
    if (path === '/api/pages/page-1' && method === 'PATCH') {
      const body = route.request().postDataJSON();
      const saved = mock.pages.get('page-1')!;
      expect(body.revision).toBe(saved.revision);
      saved.title = body.title; saved.revision++;
      await route.fulfill({ json: { page: saved } }); return true;
    }
    return mock.handle(route);
  } });
  await bootWithWorkspace(page, 'Release workspace');
  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  if (await dialog.count()) await dialog.getByRole('button', { name: 'Close' }).click();
  await openArea(page, 'spaces');
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  await assistant.or(page.getByRole('button', { name: /^Ask assistant/ })).first().waitFor();
  if (await assistant.isVisible()) await assistant.getByRole('button', { name: 'Minimize', exact: true }).click();
  await page.locator('.spaces-side').getByRole('button', { name: 'New page', exact: true }).click();
  const create = page.locator('.spaces-modal');
  await create.getByLabel('Name').fill('Launch plan');
  await create.getByLabel('Starting point').selectOption('release');
  await create.getByRole('button', { name: 'Create page' }).click();
  const space = page.locator('main.space-doc');
  await expect(space.getByRole('heading', { name: 'Launch plan', exact: true })).toBeVisible();
  await expect(space.getByText('The release is in review.')).toBeVisible();
  await page.screenshot({ path: resolve(evidence, `space-${palette}.png`) });

  await space.getByRole('button', { name: 'Page settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Page settings', exact: true });
  await expect(settings.getByText('No layout rules yet.')).toBeVisible();
  await settings.getByLabel('Page name').fill('Release plan');
  await settings.getByRole('button', { name: 'Save name' }).click();
  await expect(settings.getByRole('heading', { name: 'Release plan · Settings' })).toBeVisible();
  await settings.getByRole('button', { name: 'Put risks first', exact: true }).click();
  await settings.getByRole('button', { name: 'Add rule', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Delete rule: Put risks first' })).toBeVisible();
  await page.screenshot({ path: resolve(evidence, `space-settings-${palette}.png`) });
  await settings.getByRole('button', { name: 'Browse components' }).click();
  const catalog = page.getByRole('region', { name: 'Built-in components' });
  await expect(catalog.getByRole('article')).toHaveCount(16);
  await expect(page.getByLabel('Component code')).toHaveCount(0);
  await expect(catalog.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const previewTask = catalog.getByRole('checkbox', { name: 'Verify the installer' });
  await previewTask.click();
  await expect(previewTask).toBeChecked();
  expect(mock.pages.get('page-1')!.blocks.some(block => block.type === 'checklist')).toBe(false);
  await page.screenshot({ path: resolve(evidence, `space-components-${palette}.png`) });
  await catalog.getByRole('searchbox').fill('metrics');
  await expect(catalog.getByRole('article')).toHaveCount(5);
  await catalog.getByRole('button', { name: /^Add metrics to the page$/i }).click();
  await expect(catalog).toHaveCount(0);
  await expect(space.locator('[data-michi-block="metrics"]')).toBeVisible();
  expect(mock.pages.get('page-1')!.blocks.some(block => block.type === 'metrics')).toBe(true);

  await space.getByRole('button', { name: 'Page settings', exact: true }).click();
  await expect(settings.getByLabel('Page name')).toHaveValue('Release plan');
  await settings.getByRole('button', { name: 'Delete rule: Put risks first' }).click();
  await expect(settings.getByText('No layout rules yet.')).toBeVisible();
  await page.setViewportSize({ width: 940, height: 850 });
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidence, `space-settings-narrow-${palette}.png`) });

  await page.setViewportSize({ width: 1440, height: 1050 });
  await settings.getByLabel('Page name').fill('Draft name stays here');
  const settingsElement = await settings.elementHandle();
  await openSettings(page, 'Appearance');
  const globalDrawer = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(globalDrawer).toBeVisible();
  await expect(space).toBeVisible();
  await expect(page.locator('.terminal-topbar')).toHaveAttribute('data-page', 'space');
  await page.screenshot({ path: resolve(evidence, `global-settings-drawer-${palette}.png`) });
  await leaveSettings(page);
  expect(await settingsElement?.evaluate(element => element.isConnected)).toBe(true);
  await expect(settings.getByLabel('Page name')).toHaveValue('Draft name stays here');

  await openSettings(page, 'Components');
  await expect(page.getByRole('region', { name: 'Built-in components' }).getByRole('article')).toHaveCount(16);
  await expect(page.getByLabel('Workspace', { exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(evidence, `settings-components-${palette}.png`) });
  await openSettings(page, 'Meta agent');
  const meta = page.locator('.meta-set');
  await expect(meta.getByRole('heading', { name: 'Reading', exact: true })).toBeVisible();
  await expect(meta.getByLabel('First-run range')).toBeVisible();
  for (const row of await meta.locator('.meta-set__radio').all()) {
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  await page.screenshot({ path: resolve(evidence, `settings-meta-agent-${palette}.png`) });
  expect(errors).toEqual([]);
});
