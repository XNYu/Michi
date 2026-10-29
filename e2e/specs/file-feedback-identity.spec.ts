import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

const EVIDENCE = '/tmp/michi-improvements-phase2-2026-10-25/browser';
const V1 = '# Review notes\n\nOriginal selected passage stays attached to version one.\n\nClosing context from version one.';
const V2 = '# Updated notes\n\nA new paragraph shifts all old line numbers.\n\nReplacement content belongs to version two.';
const V1_HASH = createHash('sha256').update(V1).digest('hex');
const SELECTED = 'Original selected passage stays attached to version one.';

async function boot(page: Page, palette = 'slate') {
  const sent: Array<{ path: string; body: { text?: string } }> = [];
  let reads = 0;
  await installMockApi(page, { custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (/\/artifacts\/[^/]+\/read$/.test(path)) {
      const content = ++reads === 1 ? V1 : V2;
      await route.fulfill({ json: { content, path: 'notes.md', basename: 'notes.md', extension: 'md', size: content.length, modifiedAt: reads } });
      return true;
    }
    if (/\/chats\/[^/]+\/message$/.test(path)) sent.push({ path, body: route.request().postDataJSON() });
    if (path === '/api/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/api/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  } });
  await page.addInitScript((terminalPalette) => {
    localStorage.clear(); sessionStorage.clear();
    const nodes = Object.fromEntries(['root', 'target', 'other', 'outside'].map(id => [id, {
      nodeId: id, kind: 'chat', chatId: `mock-${id}`, runtimeId: 'mock', projectId: 'feedback-ws',
      title: id === 'target' ? 'Review target' : id === 'other' ? 'Other conversation' : id === 'outside' ? 'Outside tree' : 'Review root',
      status: 'idle', messages: id === 'target' ? [{ id: 'selection-answer', role: 'assistant', text: 'Selection toolbar shares the same raised surface.', toolCalls: [], createdAt: 2 }] : [], followUps: [],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'feedback-ws', nodes, projects: [{
      id: 'feedback-ws', name: 'File feedback regression', chatIds: Object.keys(nodes),
      edges: ['target', 'other'].map(target => ({ source: 'root', target, kind: 'branch' })),
      trees: [{ id: 'review-tree', rootNodeId: 'root', name: 'Review root', createdAt: 1, lastActiveAt: 1 },
        { id: 'outside-tree', rootNodeId: 'outside', name: 'Outside tree', createdAt: 2, lastActiveAt: 2 }],
      activeTreeId: 'review-tree', contexts: [], createdAt: 1,
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ terminalPalette, paneSpawnAnimation: 'none', defaultPaneWidth: 520, sidebarExpanded: { workspaces: { 'feedback-ws': true }, threads: { 'review-tree': true }, branches: { root: true } } }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'feedback-ws::review-tree': ['target', 'other', 'feedback-file'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'feedback-ws::review-tree': 'target' }));
    sessionStorage.setItem('michi:panes:items:v1', JSON.stringify({ 'feedback-file': {
      id: 'feedback-file', kind: 'file', projectId: 'feedback-ws', treeId: 'review-tree', title: 'notes.md',
      createdAt: 1, filePath: 'notes.md', viewMode: 'rendered', originChatNodeId: 'target',
    } }));
  }, palette);
  await page.goto('/');
  await page.getByText('Review root', { exact: true }).first().click();
  await expect(page.locator('[data-pane-kind="file"] .prose p').first()).toHaveText(SELECTED);
  return sent;
}

// Browser mouse selection exercises the real selectionchange/range/portal path.
async function selectPassage(page: Page, compose = true) {
  const paragraph = page.locator('[data-pane-kind="file"] .prose p').first();
  await paragraph.click();
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.evaluate(async el => {
    let previous = el.getBoundingClientRect().left;
    let stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const left = el.getBoundingClientRect().left;
      stable = Math.abs(left - previous) < 0.1 ? stable + 1 : 0;
      previous = left;
      if (stable >= 10) return;
    }
    throw new Error('File pane did not settle before mouse selection');
  });
  const endpoints = await paragraph.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0);
    const first = rects[0];
    const last = rects[rects.length - 1];
    return { x1: first.left + 0.2, y1: first.top + first.height / 2, x2: last.right - 0.2, y2: last.top + last.height / 2 };
  });
  await page.mouse.move(endpoints.x1, endpoints.y1);
  await page.mouse.down();
  await page.mouse.move(endpoints.x2, endpoints.y2, { steps: 20 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(SELECTED);
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  if (compose) await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'File feedback thread' })).toHaveValue('target');
}

async function screenshot(page: Page, name: string) {
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}/${name}.png`, animations: 'disabled' });
  const popup = page.locator('.sel-actions-with-context');
  if (await popup.count()) {
    await popup.screenshot({ path: `${EVIDENCE}/${name}-popup.png`, animations: 'disabled' });
  }
}

test.use({ viewport: { width: 1900, height: 1000 } });

test('selection keeps its destination and read version through focus drift and reload', async ({ page }) => {
  const sent = await boot(page);
  await selectPassage(page);
  const input = page.getByPlaceholder('your reply to this passage…');
  await input.fill('Please tighten this original passage.');
  await expect(page.locator('.sel-actions-term-preview')).toContainText(SELECTED);
  await expect(page.getByText(/Read version/)).toHaveCount(0);

  // Keyboard pane navigation and programmatic sidebar navigation both retain the comment.
  await page.keyboard.press('Control+Tab');
  await expect(input).toHaveValue('Please tighten this original passage.');
  await page.locator('[data-sidebar-row="other"]').evaluate(el => (el as HTMLElement).click());
  await expect(page.getByRole('combobox', { name: 'File feedback thread' })).toHaveValue('target');
  await page.getByRole('button', { name: 'Reload file', exact: true }).evaluate(el => (el as HTMLElement).click());
  await expect(page.locator('[data-pane-kind="file"] .prose p').first()).toContainText('new paragraph');
  await expect(input).toHaveValue('Please tighten this original passage.');
  await expect(page.getByText('File changed since this selection.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(page.locator('.sel-actions-term-highlight-layer')).toHaveCount(0);
  await screenshot(page, 'file-feedback-old-version-composer');
  await page.getByRole('button', { name: /^Save/ }).click();
  const targetPane = page.locator('.terminal-dashboard > [data-node-id="target"]');
  const otherPane = page.locator('.terminal-dashboard > [data-node-id="other"]');
  await expect(targetPane.getByText('Please tighten this original passage.', { exact: true })).toBeVisible();
  await expect(otherPane.getByText('Please tighten this original passage.', { exact: true })).toHaveCount(0);
  const composer = targetPane.getByRole('textbox', { name: 'Message', exact: true });
  await composer.click();
  await screenshot(page, 'file-feedback-fixed-destination');
  await composer.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].path).toMatch(/\/(?:mock-)?target\/message$/);
  expect(sent[0].body.text).toContain(SELECTED);
  expect(sent[0].body.text).toContain(V1_HASH);
  expect(sent[0].body.text).toContain('line 3');
  expect(sent[0].body.text).toContain('current file may differ');
  expect(sent[0].body.text).not.toContain('Replacement content');
});

for (const action of ['Delete subtree', 'Archive']) test(`${action} destination retains the comment until an explicit same-tree choice`, async ({ page }) => {
  await boot(page);
  await selectPassage(page);
  const input = page.getByPlaceholder('your reply to this passage…');
  await input.fill('Keep this comment if its destination disappears.');
  const row = page.locator('[data-sidebar-row="target"]');
  await row.dispatchEvent('contextmenu', { clientX: 160, clientY: 300 });
  await page.getByText(action, { exact: true }).evaluate(el => (el as HTMLElement).click());
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText('Choose an available thread in this tree. Your text is kept.', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Keep this comment if its destination disappears.');
  const destination = page.getByRole('combobox', { name: 'File feedback thread' });
  await expect(destination.locator('option', { hasText: 'Outside tree' })).toHaveCount(0);
  await screenshot(page, `file-feedback-${action === 'Archive' ? 'archived' : 'deleted'}-destination`);
  await destination.selectOption('other');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.locator('.terminal-dashboard > [data-node-id="other"]').getByText('Keep this comment if its destination disappears.', { exact: true })).toBeVisible();
});


test('selection comment restores its original identity after Home navigation unmounts the file', async ({ page }) => {
  await boot(page);
  await selectPassage(page);
  const input = page.getByPlaceholder('your reply to this passage…');
  await input.fill('Keep this draft while I visit Home.');
  // A real outside mouse down must save/hide the draft before Dashboard unmounts.
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('[data-pane-kind="file"]')).toHaveCount(0);
  await expect(input).toHaveCount(0);
  await page.locator('[data-sidebar-row="root"]').click();
  await expect(page.locator('[data-pane-kind="file"] .prose p').first()).toContainText('new paragraph');
  await expect(input).toHaveValue('Keep this draft while I visit Home.');
  await expect(page.getByRole('combobox', { name: 'File feedback thread' })).toHaveValue('target');
  await expect(page.getByText('File changed since this selection.', { exact: true })).toBeVisible();
  await expect(page.locator('.sel-actions-term-preview')).toContainText(SELECTED);
  await expect(page.locator('.sel-actions-term-composer details')).toHaveCount(0);
  await expect(page.locator('.sel-actions-term-highlight-layer')).toHaveCount(0);
  await screenshot(page, 'file-feedback-restored-after-home');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.locator('.terminal-dashboard > [data-node-id="target"]').getByText('Keep this draft while I visit Home.', { exact: true })).toBeVisible();
});


for (const palette of ['monokai', 'gruvbox', 'slate', 'bone']) test(`${palette} chat and file selections share a raised surface without details`, async ({ page }) => {
  await boot(page, palette);
  const chatText = page.locator('[data-msg-id="selection-answer"] .prose').first();
  await chatText.scrollIntoViewIfNeeded();
  await chatText.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const chatPopup = page.locator('.sel-actions-term-bar');
  await expect(chatPopup).toBeVisible();
  const chatBackground = await chatPopup.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.keyboard.press('Escape');
  await selectPassage(page, false);
  const popup = page.locator('.sel-actions-with-context');
  await expect(popup).toHaveCSS('background-color', chatBackground);
  await expect(popup).toHaveCSS('color-scheme', 'dark');
  if (palette === 'slate') await expect(popup).toHaveCSS('background-color', 'rgb(47, 58, 73)');
  if (palette === 'bone') await expect(popup).toHaveCSS('background-color', 'rgb(57, 52, 47)');
  await expect(popup.locator('details, summary')).toHaveCount(0);
  await expect(popup.getByText('Details', { exact: true })).toHaveCount(0);
  await expect(popup.locator('.sel-actions-term-preview')).toHaveCount(0);
  const toolbar = (await popup.locator('.sel-actions-term-toolbar').boundingBox())!;
  const target = (await popup.getByRole('combobox').boundingBox())!;
  expect(target.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
  if (palette === 'monokai' || palette === 'gruvbox') {
    expect(await popup.evaluate(el => {
      const rgb = (value: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      const [r, g, b] = rgb(getComputedStyle(el).backgroundColor);
      const base = rgb(getComputedStyle(document.querySelector('[data-pane-kind="file"]')!).getPropertyValue('--term-surface').trim());
      return (r + g + b) / 3 > (base[0] + base[1] + base[2]) / 3 + 8 && Math.max(r, g, b) < 110;
    })).toBe(true);
  }
  await screenshot(page, `file-selection-${palette}`);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(popup.locator('.sel-actions-term-preview')).toContainText(SELECTED);
  if (palette === 'slate') await expect(popup.locator('.sel-actions-term-preview')).toHaveCSS('background-color', 'rgb(38, 48, 61)');
  if (palette === 'bone') await expect(popup.locator('.sel-actions-term-preview')).toHaveCSS('background-color', 'rgb(48, 43, 38)');
  await expect(popup.locator('.sel-actions-term-footer').getByRole('combobox')).toHaveValue('target');
  await expect(popup).toHaveCSS('background-color', chatBackground);
  await expect.poll(() => popup.evaluate(el => {
    const box = el.getBoundingClientRect();
    const selected = document.querySelector('[data-pane-kind="file"] .prose p')!.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      && (box.bottom <= selected.top || box.top >= selected.bottom);
  })).toBe(true);
  await screenshot(page, `file-comment-${palette}`);
});

test('file comment fits a narrow phone sheet with a long destination title', async ({ page }) => {
  await boot(page, 'monokai');
  await selectPassage(page);
  await page.setViewportSize({ width: 320, height: 600 });
  const popup = page.locator('.sel-actions-term-composer.is-sheet');
  await expect(popup).toBeVisible();
  await page.getByRole('combobox', { name: 'File feedback thread' }).evaluate(el => {
    const selected = (el as HTMLSelectElement).selectedOptions[0];
    selected.textContent = 'A very long destination title that must not push the save button off screen';
  });
  await expect.poll(() => popup.evaluate(el => {
    const box = el.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      && el.scrollWidth <= el.clientWidth;
  })).toBe(true);
  await expect(page.getByRole('button', { name: /^Save comment/ })).toBeInViewport();
  await screenshot(page, 'file-comment-phone');
});
