import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

async function bootMenus(page: Page, palette: 'bone' | 'monokai', extraPrefs: Record<string, unknown> = {}) {
  await installMockApi(page, { streamEvents: [
    { event: 'chunk', data: { text: 'Menu checks complete.' } },
    { event: 'usage_summary', data: { contextUsagePercentage: 47, totalCredits: 0, turnDurationMs: 20,
      totalTokens: 79500, inputTokens: 60000, outputTokens: 19500, cachedInputTokens: 12000 } },
    { event: 'done', data: { stopReason: 'end_turn' } },
  ], custom: async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/agent/status') {
      await route.fulfill({ json: {
        runtime: 'mock', label: 'Mock Runtime', hasRequiredKey: true, customAgentsEnabled: false,
        capabilities: { modes: true, models: false, reasoning: false, providerModels: false },
        availableRuntimes: [{ id: 'mock', label: 'Mock Runtime', available: true }],
      } });
      return true;
    }
    if (path.endsWith('/modes')) {
      await route.fulfill({ json: { availableModes: [
        { id: 'build', name: 'Build', description: 'Implement and validate changes' },
        { id: 'plan', name: 'Plan', description: 'Explore the next steps' },
      ] } });
      return true;
    }
    if (path === '/prefs' && route.request().method() === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette } } });
      return true;
    }
    return false;
  } });
  await page.addInitScript(({ terminalPalette, extraPrefs }) => {
    const ids = ['root', 'branch', 'branch2'];
    const extraWorkspaces = Array.from({ length: 9 }, (_, index) => ({
      id: `workspace-${index + 1}`, name: `Workspace ${index + 1}`,
      chatIds: [`workspace-root-${index + 1}`], edges: [], artifacts: [], createdAt: 1,
      trees: [{ id: `workspace-tree-${index + 1}`, rootNodeId: `workspace-root-${index + 1}`, createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: `workspace-tree-${index + 1}`,
    }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'menu-ws',
      nodes: { ...Object.fromEntries(ids.map((nodeId) => [nodeId, {
        nodeId, kind: 'chat', chatId: null, projectId: 'menu-ws', title: `${nodeId} conversation`,
        status: 'idle', followUps: [], contextUsagePercentage: 47,
        usageSummary: { totalTokens: 79500, inputTokens: 60000, outputTokens: 19500, cachedInputTokens: 12000 },
        messages: [{ id: `${nodeId}-message`, role: 'user', text: 'Review the menu spacing and interactions.', toolCalls: [], createdAt: 1 }],
      }])), ...Object.fromEntries(extraWorkspaces.map((workspace) => [workspace.chatIds[0], {
        nodeId: workspace.chatIds[0], kind: 'chat', chatId: null, projectId: workspace.id,
        title: `${workspace.name} conversation`, status: 'idle', followUps: [], messages: [],
      }])) },
      projects: [{ id: 'menu-ws', name: 'Menu implementation', chatIds: ids,
        edges: ['branch', 'branch2'].map((target) => ({ source: 'root', target, kind: 'branch' })),
        trees: [{ id: 'tree', rootNodeId: 'root', name: 'root conversation', createdAt: 1, lastActiveAt: 1 }],
        activeTreeId: 'tree', createdAt: 1,
        artifacts: Array.from({ length: 10 }, (_, index) => ({
          id: `notes-${index}`, name: index ? `Reference notes ${index}` : 'Design notes',
          filePath: `notes-${index}.md`, type: 'doc', source: 'user', createdAt: 1, updatedAt: 1,
        })),
      }, ...extraWorkspaces],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ terminalPalette, sidebarView: 'structure', sidebarCollapsed: false,
      onboardingCompletedAt: 1, sidebarExpanded: { workspaces: { 'menu-ws': true }, threads: { tree: true }, branches: {} },
      ...extraPrefs,
    }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'menu-ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'menu-ws::tree': null }));
  }, { terminalPalette: palette, extraPrefs });
  await page.goto('/');
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
}

type Material = Awaited<ReturnType<typeof materialOf>>;

/** Every tuned menu shares the palette's glass except the solid right-click menu. */
async function assertSurface(menu: Locator, width: number, viewportWidth: number, paletteMaterial?: Material) {
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('border-radius', '4px');
  await expect(menu).toHaveCSS('font-size', '13px');
  await expect(menu).toHaveCSS('font-weight', '500');
  const isContext = await menu.getAttribute('data-menu') === 'context';
  if (isContext) {
    await expect(menu).not.toHaveClass(/\bterm-glass\b/);
    await expect(menu).toHaveCSS('backdrop-filter', 'none');
  } else {
    // Same glass recipe as the palette (tint, highlight, cast shadow), at the
    // denser menu setting: blur floored at 26px, surface at 78%.
    await expect(menu).toHaveClass(/\bterm-glass\b/);
    await expect(menu).toHaveCSS('backdrop-filter', /blur\(26px\)/);
    if (paletteMaterial) expect((await materialOf(menu)).boxShadow).toEqual(paletteMaterial.boxShadow);
  }
  await expect(menu).toHaveCSS('padding', '6px');
  await expect.poll(() => menu.evaluate((element) => element.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  const bounds = (await menu.boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewportWidth - 8);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  await expect(menu.locator('h1, h2, h3')).toHaveCount(0);
}

async function materialOf(surface: Locator) {
  return surface.evaluate((element) => {
    const css = getComputedStyle(element);
    return { background: css.background, backdropFilter: css.backdropFilter, boxShadow: css.boxShadow };
  });
}

async function expectQuietSearch(input: Locator) {
  await input.focus();
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS('outline-style', 'none');
  await expect(input).toHaveCSS('box-shadow', 'none');
}

for (const palette of ['bone', 'monokai'] as const) {
  test(`${palette}: workspace, agents, autocomplete and context menus use the tuned tokens`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await bootMenus(page, palette);
    await expect(page.locator('html')).toHaveAttribute('data-terminal-palette', palette);

    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const paletteDialog = page.getByRole('dialog', { name: /Command palette/i });
    await expect(paletteDialog).toBeVisible();
    await expect(paletteDialog).toHaveCSS('border-radius', '4px');
    await expectQuietSearch(paletteDialog.getByRole('textbox'));
    const paletteMaterial = await materialOf(paletteDialog);
    const paletteFont = await paletteDialog.evaluate((element) => getComputedStyle(element).fontFamily);
    // The palette's list is built from the same menu rows as every dropdown.
    const paletteRow = paletteDialog.locator('.michi-menu-scope .ui-menu-item').first();
    await expect(paletteRow).toHaveCSS('border-radius', '2px');
    await expect(paletteRow).toHaveCSS('font-size', '13px');
    await expect(paletteRow).toHaveCSS('border-left-width', '0px');
    await paletteDialog.screenshot({ path: info.outputPath('command-palette.png') });
    await page.keyboard.press('Escape');

    await page.getByTitle('Switch workspace', { exact: true }).click();
    const workspace = page.getByRole('menu', { name: 'Workspaces', exact: true });
    await assertSurface(workspace, 252, 1280, paletteMaterial);
    expect(await workspace.evaluate((element) => getComputedStyle(element).fontFamily)).toBe(paletteFont);
    await expect(workspace.locator('.ui-menu-item').first()).toHaveCSS('min-height', '35px');
    await expect(workspace.locator('.ui-menu-item').first()).toHaveCSS('padding', '9px 10px');
    const workspaceList = workspace.locator('.michi-menu-list:not(.michi-menu-pinned)');
    const workspaceRows = workspaceList.getByRole('menuitem');
    const workspaceSearch = workspace.getByRole('textbox');
    const newWorkspace = workspace.getByRole('menuitem', { name: /new workspace/ });
    await expect(workspaceRows).toHaveCount(10);
    await expect(workspaceList).toHaveCSS('max-height', '175px');
    expect((await workspaceList.boundingBox())!.height).toBe(175);
    for (const row of (await workspaceRows.all()).slice(0, 5)) await expect(row).toBeInViewport({ ratio: 1 });
    await expect(workspaceRows.nth(5)).not.toBeInViewport();
    await expect(newWorkspace).toBeInViewport({ ratio: 1 });
    await expectQuietSearch(workspaceSearch);
    await workspace.screenshot({ path: info.outputPath('workspace.png') });
    await page.screenshot({ path: info.outputPath('workspace-page.png'), fullPage: true });
    for (let index = 0; index < 10; index++) await workspaceSearch.press('ArrowDown');
    await expect(workspaceRows.last()).toBeInViewport({ ratio: 1 });
    expect(await workspaceList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(workspaceSearch).toBeInViewport({ ratio: 1 });
    await expect(newWorkspace).toBeInViewport({ ratio: 1 });
    await workspaceSearch.fill('Workspace 9');
    await expect(workspaceRows).toHaveCount(1);
    await expect(workspaceRows.first()).toBeInViewport({ ratio: 1 });
    await workspaceSearch.fill('no workspace matches');
    await expect(workspaceRows).toHaveCount(0);
    await expect(newWorkspace).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');

    await page.locator('[title^="Switch agent"]').click();
    const agents = page.getByRole('menu', { name: 'Agents', exact: true });
    await assertSurface(agents, 480, 1280, paletteMaterial);
    await expectQuietSearch(agents.getByRole('textbox'));
    await expect(agents.getByRole('menuitem', { name: /Default Agent/ })).toBeVisible();
    await agents.screenshot({ path: info.outputPath('agents.png') });
    await page.keyboard.press('Escape');

    const sidebar = page.locator('.terminal-sidebar');
    await sidebar.getByText('root conversation', { exact: true }).first().click();
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.fill('@');
    const mentions = page.getByRole('listbox', { name: 'Mentions', exact: true });
    await assertSurface(mentions, 420, 1280, paletteMaterial);
    await expect(mentions.locator('input')).toHaveCount(0);
    await mentions.screenshot({ path: info.outputPath('mentions.png') });
    await editor.press('ArrowUp');
    await expect(mentions.getByRole('option').last()).toBeInViewport();
    await editor.fill('@Design');
    await expect(mentions.getByRole('option')).toHaveCount(1);
    await editor.press('Enter');
    await expect(editor.locator('.mention-chip')).toHaveText('@Design notes');
    await expect(editor).toBeFocused();
    await expect(mentions).toHaveCount(0);

    await editor.fill('/');
    const slash = page.getByRole('listbox', { name: 'Slash commands', exact: true });
    await assertSurface(slash, 480, 1280, paletteMaterial);
    await expect(slash.locator('input')).toHaveCount(0);
    const branch = slash.getByRole('option', { name: /^\/branch / });
    await expect(branch).toContainText('Open this message as a new child thread.');
    const command = (await branch.locator('.michi-menu-command').boundingBox())!;
    const description = (await branch.locator('.michi-menu-caption').boundingBox())!;
    expect(Math.abs(command.y + command.height / 2 - description.y - description.height / 2)).toBeLessThan(1);
    await slash.screenshot({ path: info.outputPath('slash.png') });
    await page.screenshot({ path: info.outputPath('slash-page.png'), fullPage: true });
    await branch.click();
    await expect(editor).toHaveText('/branch');
    await expect(slash).toHaveCount(0);

    await page.getByLabel('root conversation pane, focused', { exact: true }).click({ button: 'right' });
    const context = page.getByRole('menu', { name: 'Actions', exact: true });
    await assertSurface(context, 252, 1280);
    await expect(context.locator('.ui-menu-item').first()).toHaveCSS('min-height', '32px');
    await expect(context.locator('.ui-menu-item').first()).toHaveCSS('border-radius', '2px');
    await context.screenshot({ path: info.outputPath('pane-context.png') });
    await page.screenshot({ path: info.outputPath('pane-context-page.png'), fullPage: true });
    await page.keyboard.press('Escape');

    for (const [label, screenshot] of [['Menu implementation', 'workspace-context'], ['root conversation', 'thread-context'], ['branch conversation', 'node-context']]) {
      await sidebar.getByText(label, { exact: true }).first().click({ button: 'right' });
      await assertSurface(context, 252, 1280);
      await context.screenshot({ path: info.outputPath(`${screenshot}.png`) });
      await page.keyboard.press('Escape');
    }
    await sidebar.getByText('branch conversation', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
    await sidebar.getByText('branch2 conversation', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
    await sidebar.getByText('branch conversation', { exact: true }).click({ button: 'right' });
    await assertSurface(context, 252, 1280);
    await expect(context).toContainText('Weave 2 chats');
    await context.screenshot({ path: info.outputPath('multi-context.png') });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Artifacts', exact: true });
    const artifactSearch = drawer.getByRole('searchbox');
    const unfocusedBorder = await artifactSearch.evaluate((element) => getComputedStyle(element).borderColor);
    await expectQuietSearch(artifactSearch);
    await expect(artifactSearch).toHaveCSS('border-color', unfocusedBorder);
    await artifactSearch.fill('Design');
    await expect(drawer.getByText('Reference notes 1', { exact: true })).toHaveCount(0);
    await drawer.screenshot({ path: info.outputPath('artifact-search.png') });
    await drawer.getByText('Design notes', { exact: true }).click({ button: 'right' });
    await assertSurface(context, 252, 1280);
    await context.screenshot({ path: info.outputPath('artifact-context.png') });
    await page.keyboard.press('Escape');
    await expect(context).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();

    await editor.fill('Inspect context usage');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    await page.getByRole('meter').hover();
    const usage = page.locator('[data-menu="usage"]');
    await assertSurface(usage, 288, 1280, paletteMaterial);
    await expect(usage).toContainText('79.5K tokens');
    await usage.screenshot({ path: info.outputPath('usage.png') });

    await page.getByRole('button', { name: 'Search', exact: true }).hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveCSS('border-radius', '2px');
    await expect(tooltip).toHaveCSS('font-size', '11px');
    await expect(tooltip).toHaveCSS('backdrop-filter', 'none');
    expect(errors).toEqual([]);
  });
}

test('autocomplete stays within a narrow viewport and reduced motion skips the blink', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bootMenus(page, 'bone');
  await page.getByTitle('Switch workspace', { exact: true }).click();
  await assertSurface(page.getByRole('menu', { name: 'Workspaces', exact: true }), 252, 1280);
  await page.keyboard.press('Escape');
  // The sidebar is responsive; navigate before collapsing it on small screens.
  await page.locator('.terminal-sidebar').getByText('root conversation', { exact: true }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = page.locator('[contenteditable="true"]').first();
  for (const [query, name, width] of [['@', 'Mentions', 420], ['/', 'Slash commands', 480]] as const) {
    await editor.fill(query);
    const menu = page.getByRole('listbox', { name, exact: true });
    await assertSurface(menu, width, 390);
    await expect(menu).toHaveCSS('animation-name', 'none');
    await menu.screenshot({ path: info.outputPath(`${name.replaceAll(' ', '-')}-mobile.png`) });
    await page.screenshot({ path: info.outputPath(`${name.replaceAll(' ', '-')}-mobile-page.png`), fullPage: true });
    if (query === '@') {
      await menu.getByRole('option').first().click();
      await expect(editor.locator('.mention-chip')).toHaveCount(1);
    }
  }
});

test('glass menus follow glass preferences and reduced transparency; right-click stays solid', async ({ page }, info) => {
  await bootMenus(page, 'monokai');
  await page.evaluate(() => {
    const style = document.documentElement.style;
    style.setProperty('--term-glass-blur', '36px');
    style.setProperty('--term-glass-saturate', '120%');
    style.setProperty('--term-glass-solid-alpha', '.65');
    style.setProperty('--term-glass-wash-strength', '0.5');
    style.setProperty('--term-glass-depth', '1.3');
  });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const paletteMaterial = await materialOf(page.getByRole('dialog', { name: /Command palette/i }));
  await page.keyboard.press('Escape');
  await page.getByTitle('Switch workspace', { exact: true }).click();
  const workspace = page.getByRole('menu', { name: 'Workspaces', exact: true });
  await expect(workspace).toHaveCSS('backdrop-filter', 'blur(36px) saturate(1.2)');
  await expect.poll(() => workspace.evaluate((element) => element.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  // A blur above the menu floor follows the pref; the shared cast/highlight too.
  expect((await materialOf(workspace)).boxShadow).toEqual(paletteMaterial.boxShadow);
  await workspace.screenshot({ path: info.outputPath('custom-glass.png') });
  await page.keyboard.press('Escape');

  await page.locator('.terminal-sidebar').getByText('Menu implementation', { exact: true }).first().click({ button: 'right' });
  const context = page.getByRole('menu', { name: 'Actions', exact: true });
  await expect(context).toHaveCSS('backdrop-filter', 'none');
  const surface = await context.evaluate((element) => getComputedStyle(element).getPropertyValue('--term-surface').trim());
  // Resolve the theme token through a CSS property, independent of color notation.
  await context.evaluate((element, color) => { element.style.color = color; }, surface);
  const solidColor = await context.evaluate((element) => getComputedStyle(element).color);
  await context.evaluate((element) => { element.style.removeProperty('color'); });
  await expect(context).toHaveCSS('background-color', solidColor);
  await page.keyboard.press('Escape');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ] });
  await page.getByTitle('Switch workspace', { exact: true }).click();
  await expect(workspace).toHaveCSS('backdrop-filter', 'none');
  await expect(workspace).toHaveCSS('background-image', 'none');
  await expect(workspace).toHaveCSS('background-color', solidColor);
  await workspace.screenshot({ path: info.outputPath('reduced-transparency.png') });
});

test('the corner radius preference reshapes menus, modals, rows and controls together', async ({ page }, info) => {
  await bootMenus(page, 'bone', { cornerRadius: 10 });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const paletteDialog = page.getByRole('dialog', { name: /Command palette/i });
  await expect(paletteDialog).toHaveCSS('border-radius', '10px');
  await expect(paletteDialog.locator('.michi-menu-scope .ui-menu-item').first()).toHaveCSS('border-radius', '5px');
  await paletteDialog.screenshot({ path: info.outputPath('palette-radius-10.png') });
  await page.keyboard.press('Escape');

  await page.getByTitle('Switch workspace', { exact: true }).click();
  const workspace = page.getByRole('menu', { name: 'Workspaces', exact: true });
  await expect(workspace).toHaveCSS('border-radius', '10px');
  await expect(workspace.locator('.ui-menu-item').first()).toHaveCSS('border-radius', '5px');
  await workspace.screenshot({ path: info.outputPath('workspace-radius-10.png') });
  await page.keyboard.press('Escape');

  await page.locator('.terminal-sidebar').getByText('root conversation', { exact: true }).first().click({ button: 'right' });
  const context = page.getByRole('menu', { name: 'Actions', exact: true });
  await expect(context).toHaveCSS('border-radius', '10px');
  await page.keyboard.press('Escape');

  // Square is a valid choice too: 0 flattens every surface and row.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ui-radius', '0px');
    document.documentElement.style.setProperty('--ui-radius-sm', '0px');
  });
  await page.getByTitle('Switch workspace', { exact: true }).click();
  await expect(workspace).toHaveCSS('border-radius', '0px');
  await expect(workspace.locator('.ui-menu-item').first()).toHaveCSS('border-radius', '0px');
});

test('workspace list scrolls without losing search or New on small viewports', async ({ page }, info) => {
  await bootMenus(page, 'monokai');
  await page.getByTitle('Switch workspace', { exact: true }).click();
  const workspace = page.getByRole('menu', { name: 'Workspaces', exact: true });
  for (const height of [844, 240]) {
    await page.setViewportSize({ width: 390, height });
    await assertSurface(workspace, 252, 390);
    const box = (await workspace.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(height - 8);
    await expect(workspace.getByRole('textbox')).toBeInViewport({ ratio: 1 });
    await expect(workspace.getByRole('menuitem', { name: /new workspace/ })).toBeInViewport({ ratio: 1 });
    await workspace.screenshot({ path: info.outputPath(`workspace-${height}px.png`) });
  }
  const lastWorkspace = workspace.getByRole('menuitem', { name: 'Workspace 9', exact: true });
  await lastWorkspace.scrollIntoViewIfNeeded();
  await expect(lastWorkspace).toBeInViewport({ ratio: 1 });
  await lastWorkspace.click();
  await expect(workspace).toHaveCount(0);
  await expect(page.getByTitle('Switch workspace', { exact: true })).toContainText('Workspace 9');
});

test('workspace, agent and model pickers share selection mark, pressed trigger, toggle and entrance', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await bootMenus(page, 'bone');
  const hover = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.background = 'var(--term-hover-bg, var(--term-alt))';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  const selectedMark = async (row: Locator) => row.evaluate((element) => {
    const glyph = element.querySelector('.michi-menu-glyph');
    return glyph?.textContent === '✓' && element.lastElementChild === glyph;
  });

  const pickers = [
    { name: 'workspace', trigger: page.getByTitle('Switch workspace', { exact: true }), surface: page.getByRole('menu', { name: 'Workspaces', exact: true }) },
    { name: 'agent', trigger: page.locator('[title^="Switch agent"]').first(), surface: page.getByRole('menu', { name: 'Agents', exact: true }) },
    { name: 'model', trigger: page.getByRole('button', { name: /^Model settings:/ }), surface: page.getByRole('dialog', { name: 'Model settings' }) },
  ];
  for (const { name, trigger, surface } of pickers) {
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(surface).toBeVisible();
    await expect(surface).toHaveAttribute('data-menu-animate', 'true');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.move(2, 890);
    await expect(trigger).toHaveCSS('background-color', hover);
    if (name === 'model') await surface.getByRole('button', { name: /Select runtime:/ }).click();
    await page.mouse.move(2, 890);
    const selected = name === 'workspace'
      ? surface.getByRole('menuitem', { name: /Menu implementation/ })
      : name === 'agent'
        ? surface.getByRole('menuitem', { name: /Default Agent/ })
        : surface.getByRole('menuitemradio', { checked: true });
    expect(await selectedMark(selected), `${name} marks the selection with a trailing check`).toBe(true);
    await expect(selected).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await surface.screenshot({ path: info.outputPath(`${name}-picker.png`) });
    await trigger.click();
    await expect(surface).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
});
