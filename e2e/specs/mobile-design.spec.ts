import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

async function boot(page: Page, palette = 'bone', reduceMotion = false) {
  await installMockApi(page);
  await page.addInitScript(({ palette, reduceMotion }) => {
    const now = Date.now();
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify({
      onboardingCompletedAt: 1, terminalPalette: palette, reduceMotion,
      sidebarView: 'structure', sidebarCollapsed: false,
      sidebarExpanded: { workspaces: { design: true }, threads: {}, branches: {} },
    }));
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'design',
      projects: [{ id: 'design', name: 'Research journal', createdAt: now, chatIds: ['root'],
        edges: [], artifacts: [], activeTreeId: 'tree',
        trees: [{ id: 'tree', rootNodeId: 'root', name: 'A quieter way to work', createdAt: now, lastActiveAt: now }] }],
      nodes: { root: { nodeId: 'root', projectId: 'design', chatId: null, kind: 'chat', title: 'A quieter way to work',
        status: 'idle', messagesLoaded: true, followUps: [], messages: [
          { id: 'message', role: 'assistant', text: '## Make room for the thought\n\nA conversation can become a working landscape.', toolCalls: [], createdAt: now },
        ] } },
    }));
    sessionStorage.setItem('michi:panes:open', '{}');
    sessionStorage.setItem('michi:panes:focus', '{}');
  }, { palette, reduceMotion });
  await page.goto('/');
  await expect(page.locator('.michi-home')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
}

test('Home adapts to desktop, phone and a short window without clipping its composer', async ({ page }, info) => {
  await boot(page);
  for (const [width, height] of [[1440, 900], [768, 900], [390, 844], [320, 568], [900, 500]]) {
    await page.setViewportSize({ width, height });
    const composer = page.locator('.terminal-composer');
    await expect(composer).toBeVisible();
    const bounds = await composer.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width <= 700) await expect(page.getByRole('button', { name: 'Workspace views', exact: true })).toBeVisible();
    else await expect(page.getByRole('button', { name: 'Workspace views', exact: true })).toBeHidden();
    await page.screenshot({ animations: 'disabled', path: info.outputPath(`home-${width}.png`) });
  }
});

test('narrow toolbar retains view navigation, keyboard escape and focus', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const trigger = page.getByRole('button', { name: 'Workspace views', exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const map = page.getByRole('button', { name: 'Map', exact: true });
  await expect(map).toBeVisible();
  await map.focus();
  await map.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(map).toBeHidden();
  await trigger.click();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('mobile-views.png') });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await expect(page.locator('.terminal-topbar')).toHaveAttribute('data-page', 'branches');
});

test('system reduced motion also disables the narrow toolbar entrance', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await page.getByRole('button', { name: 'Workspace views', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Workspace view controls' })).toHaveCSS('animation-name', 'none');
});

test('placeholder is not draft content and clearing restores the empty state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const editor = page.getByRole('textbox', { name: 'Message' });
  const placeholder = page.locator('.mention-editor-placeholder');
  await expect(placeholder).toBeVisible();
  await expect(editor).toHaveText('');
  await editor.fill('A real question');
  await expect(placeholder).toBeHidden();
  await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeEnabled();
  await editor.fill('');
  await expect(placeholder).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeDisabled();
});

test('workspace controls remain usable in a phone width', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await page.getByLabel('Open sidebar', { exact: true }).click();
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Filter workspaces' });
  await expect(search).toBeVisible();
  await search.fill('Research');
  await expect(page.getByTestId('workspace-table-row-design')).toBeVisible();
  const actions = await page.locator('.michi-workspaces__actions').boundingBox();
  expect(actions!.x + actions!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('mobile-workspaces.png') });
});


test('resizing to desktop restores its original design without losing the draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const editor = page.getByRole('textbox', { name: 'Message' });
  await editor.fill('Keep this draft through resize');
  await expect(page.locator('.michi-home__hero')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('.michi-home__hero')).toHaveCount(0);
  await expect(page.locator('.michi-home h1')).toHaveText('_ Another road diverged in a yellow wood.');
  await expect(editor).toHaveText('Keep this draft through resize');
  await expect(page.locator('.terminal-composer__input')).toHaveCSS('padding', '10px 12px 4px');
  await expect(page.locator('.terminal-composer__toolbar')).toHaveCSS('padding', '4px 10px 8px');
  await expect(page.locator('.mention-editor-placeholder')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Workspace views', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Map', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.michi-home__hero')).toBeVisible();
  await expect(editor).toHaveText('Keep this draft through resize');
});

for (const palette of ['bone', 'monokai']) {
  test(`${palette}: touch targets fit a phone and respect app reduced motion`, async ({ browser, baseURL }, info) => {
    const context = await browser.newContext({baseURL, viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true});
    const page = await context.newPage();
    try {
      await boot(page, palette, true);
      await expect(page.locator('.michi-home__hero')).toHaveCSS('animation-name', 'none');
      const composer = page.locator('.terminal-composer');
      const bounds = (await composer.boundingBox())!;
      for (const control of await composer.locator('.t-toolbar-chip, .t-action-btn').all()) {
        if (!await control.isVisible()) continue;
        const box = (await control.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(40);
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      }
      await page.getByRole('button', { name: 'Workspace views', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Workspace view controls' })).toHaveCSS('animation-name', 'none');
      await page.screenshot({animations: 'disabled', path: info.outputPath(`touch-${palette}.png`)});
    } finally { await context.close(); }
  });
}
