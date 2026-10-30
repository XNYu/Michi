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
  await expect(page.locator('.home-page')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
}

test('Home adapts to desktop, phone and a short window without clipping its composer', async ({ page }, info) => {
  await boot(page);
  for (const [width, height] of [[1440, 900], [768, 900], [390, 844], [320, 568], [900, 500]]) {
    await page.setViewportSize({ width, height });
    const composer = page.locator('.home-compose .terminal-composer');
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

test('a phone lists workspaces as rows, acts on them from a sheet and manages one in a single column', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await boot(page);
    await page.getByLabel('Open sidebar', { exact: true }).click();
    await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
    const row = page.getByTestId('workspace-row-design');
    await expect(row).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    // Search reaches thread titles and marks the hit.
    const search = page.getByRole('searchbox', { name: 'Filter workspaces' });
    await search.fill('quieter');
    await expect(row.locator('mark')).toHaveText('quieter');
    await search.fill('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    for (const control of [row.getByRole('button', { name: 'More actions' }), page.getByRole('button', { name: 'New workspace' }), search]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    }
    await page.screenshot({ animations: 'disabled', path: info.outputPath('mobile-workspaces.png') });

    await row.getByRole('button', { name: 'More actions' }).tap();
    const sheet = page.getByRole('dialog', { name: 'Research journal' });
    await expect(sheet).toBeVisible();
    // It rises from below; once settled it sits on the bottom edge, full width.
    await expect.poll(async () => {
      const box = (await sheet.boundingBox())!;
      return [Math.round(box.y + box.height), Math.round(box.width)];
    }).toEqual([844, 390]);
    await page.screenshot({ animations: 'disabled', path: info.outputPath('mobile-workspace-sheet.png') });
    await sheet.getByRole('button', { name: 'Rename…' }).tap();
    const field = page.getByRole('textbox', { name: 'Workspace name' });
    await expect(field).toBeFocused();
    await field.fill('Field notes');
    await field.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).toContainText('Field notes');

    // A tap opens the workspace; on a phone its side panels follow the lists.
    await row.getByRole('button', { name: /Field notes/ }).tap();
    const manage = page.getByTestId('workspace-manage');
    await expect(manage).toBeVisible();
    expect(await manage.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    const tabs = (await page.getByRole('button', { name: /^Chats/ }).boundingBox())!;
    const settings = (await page.getByRole('complementary', { name: 'Workspace settings' }).boundingBox())!;
    expect(settings.y).toBeGreaterThan(tabs.y + tabs.height);
    expect(settings.x).toBeGreaterThanOrEqual(0);
    expect(settings.x + settings.width).toBeLessThanOrEqual(390);
    await page.screenshot({ animations: 'disabled', path: info.outputPath('mobile-workspace-manage.png'), fullPage: true });
  } finally { await context.close(); }
});


test('resizing to desktop restores its original design without losing the draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const editor = page.getByRole('textbox', { name: 'Message' });
  await editor.fill('Keep this draft through resize');
  await expect(page.locator('.home-default-headline')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('.home-default-headline')).toBeVisible();
  await expect(page.locator('.home-page h1')).toHaveText('_ Another road diverged in a yellow wood.');
  await expect(editor).toHaveText('Keep this draft through resize');
  await expect(page.locator('.terminal-composer__input')).toHaveCSS('padding', '10px 12px 4px');
  await expect(page.locator('.terminal-composer__toolbar')).toHaveCSS('padding', '4px 10px 8px');
  await expect(page.locator('.mention-editor-placeholder')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Workspace views', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Map', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.home-default-headline')).toBeVisible();
  await expect(editor).toHaveText('Keep this draft through resize');
});

for (const palette of ['bone', 'monokai']) {
  test(`${palette}: touch targets fit a phone and respect app reduced motion`, async ({ browser, baseURL }, info) => {
    const context = await browser.newContext({baseURL, viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true});
    const page = await context.newPage();
    try {
      await boot(page, palette, true);
      await expect(page.locator('.home-default-headline')).toHaveCSS('animation-name', 'none');
      const composer = page.locator('.home-compose .terminal-composer');
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

test('a phone Home keeps one toolbar row and moves workspace and permissions to a tray', async ({ browser, baseURL }, info) => {
  const greeting = { text: '几个示例项目正在推进', detail: 'Atlas 笔记还有两段待整理，Orchid 示例还有几项待检查。' };
  for (const [width, globalPermissions] of [[390, false], [390, true], [320, false]] as const) {
    const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await installMockApi(page, {
        workspaces: [{ workspace: { id: 'ws', name: 'Cedar Studio', created_at: 1 }, trees: [], nodes: [], messages: [], edges: [], artifacts: [] }],
        custom: async (route) => {
          const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
          if (path === '/home/cards') {
            await route.fulfill({ json: { greeting, sets: [], generatedAt: 1, inputFingerprint: null } });
            return true;
          }
          if (path === '/prefs' && route.request().method() === 'GET') {
            await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, globalPermissions, permissionMode: 'ask' } } });
            return true;
          }
          return false;
        },
      });
      await page.addInitScript(() => {
        localStorage.setItem('michi:migrated', '1');
        localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
      });
      await page.goto('/');
      await expect(page.locator('.home-greeting__text')).toBeVisible();
      await expect(page.locator('[data-testid="home-card"]').first()).toBeVisible();
      // The lazy editor changes the composer's height when it arrives.
      await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

      const composer = (await page.locator('.home-compose .terminal-composer').boundingBox())!;
      const box = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!;
      const toolbar = page.locator('.home-compose .terminal-composer__toolbar');
      const attach = await box(toolbar.getByText('+', { exact: true }));
      // Typing @ still mentions; the phone has no @ chip.
      await expect(toolbar.getByTitle('Mention context or node')).toBeHidden();
      const model = await box(toolbar.locator('.composer-model-trigger'));
      const send = await box(toolbar.getByRole('button', { name: 'Send (Enter)', exact: true }));
      // One toolbar row: +, model and send.
      expect(Math.abs(model.y - attach.y)).toBeLessThan(1);
      expect(Math.abs(send.y - attach.y)).toBeLessThan(1);
      expect(send.x + send.width).toBeLessThanOrEqual(composer.x + composer.width);
      await expect(toolbar.getByTitle('Switch workspace')).toHaveCount(0);
      await expect(toolbar.getByRole('button', { name: /^Permissions:/ })).toHaveCount(0);

      // The tray hangs from the composer, inset on both sides.
      const tray = page.locator('.home-compose .composer-tray');
      const trayBox = await box(tray);
      expect(Math.abs(trayBox.y - (composer.y + composer.height))).toBeLessThan(1);
      expect(trayBox.x).toBeGreaterThan(composer.x);
      expect(trayBox.x + trayBox.width).toBeLessThan(composer.x + composer.width);
      await expect(tray.getByTitle('Switch workspace')).toContainText('Cedar Studio');
      const permissions = tray.getByRole('button', { name: /^Permissions:/ });
      if (globalPermissions) await expect(permissions).toHaveCount(0);
      else {
        // Named in full on the right, level with the workspace. One layout
        // snapshot, so nothing loading in between can shift one of them.
        await expect(permissions).toContainText('Ask');
        const { workspace, permission, end } = await tray.evaluate((el) => {
          const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; };
          return {
            workspace: rect(el.querySelector('[title="Switch workspace"]')!),
            permission: rect(el.querySelector('[aria-label^="Permissions:"]')!),
            end: el.getBoundingClientRect().right,
          };
        });
        expect(Math.abs(permission.y - workspace.y)).toBeLessThan(1);
        expect(permission.x).toBeGreaterThan(workspace.x + workspace.width);
        expect(permission.x + permission.width).toBeLessThanOrEqual(end);
      }
      for (const control of await tray.locator('.t-toolbar-chip').all()) {
        expect((await box(control)).height).toBeGreaterThanOrEqual(40);
      }
      // Neither the page nor Home scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(await page.locator('.home-scroll').evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
      await page.screenshot({ animations: 'disabled', path: info.outputPath(`home-greeting-${width}-${globalPermissions}.png`) });

      // A tap leaves :hover on the chip; its folder icon stays while the menu is open.
      await tray.getByTitle('Switch workspace').tap();
      const workspaces = page.getByRole('menu', { name: 'Workspaces', exact: true });
      await expect(workspaces).toBeVisible();
      await expect(tray.locator('.home-workspace-chip__folder')).toBeVisible();
      // Tray menus open downward, off the draft above.
      const trayBottom = trayBox.y + trayBox.height;
      await expect.poll(async () => (await workspaces.boundingBox())!.y).toBeGreaterThan(trayBottom);
      await page.screenshot({ animations: 'disabled', path: info.outputPath(`home-greeting-${width}-${globalPermissions}-workspaces.png`) });
      if (!globalPermissions) {
        await tray.getByTitle('Switch workspace').tap();
        await expect(workspaces).toBeHidden();
        await permissions.tap();
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThan(trayBottom);
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`home-greeting-${width}-permissions.png`) });
      }
    } finally { await context.close(); }
  }
});
