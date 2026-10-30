import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

const answer = [
  'Keep tool output separate from **runtime control messages**. Check the tool definition, stream events, and rendered output.',
  '',
  'A second paragraph stays plain.',
].join('\n');

async function boot(page: Page, palette: string) {
  const prefs = { terminalPalette: palette, onboardingCompletedAt: 1, sidebarCollapsed: true,
    defaultPaneWidth: 880, paneWidthMode: 'fixed' };
  const createdAt = Date.now() - 5 * 60_000;
  const node = (id: string, title: string, status = 'idle') => ({
    id, kind: 'chat', acp_session_id: id, runtime_id: 'mock', workspace_id: 'quote-ws', tree_id: 'tree',
    title, status, created_at: createdAt, follow_ups: '[]',
  });
  const edge = (target: string, at: number) => ({
    source_node_id: 'root', target_node_id: target, kind: 'branch', anchor_message_id: 'root-answer', created_at: createdAt + at,
  });
  const workspace = {
    workspace: { id: 'quote-ws', name: 'Quote branches', active_tree_id: 'tree', created_at: createdAt },
    trees: [{ id: 'tree', workspace_id: 'quote-ws', root_node_id: 'root', name: 'Tool output', created_at: createdAt, last_active_at: createdAt }],
    nodes: [node('root', 'Tool output'), node('child', 'Control messages in the stream'), node('other', 'Where usage events come from', 'error')],
    edges: [edge('child', 3), edge('other', 6)],
    messages: [
      { id: 'root-question', node_id: 'root', role: 'user', seq: 0, content: 'Review the tool result handling.', created_at: createdAt },
      { id: 'root-answer', node_id: 'root', role: 'assistant', seq: 1, content: answer, created_at: createdAt + 1 },
      // Branch on a selection: the selection crossed the bold text.
      { id: 'child-question', node_id: 'child', role: 'user', seq: 0, content: 'Which ones?', created_at: createdAt + 4,
        metadata: JSON.stringify({ quotedText: 'from runtime control messages. Check' }) },
      { id: 'child-answer', node_id: 'child', role: 'assistant', seq: 1, created_at: createdAt + 5,
        content: '**Mode changes** and usage. Both ride the session channel, so they never mix with tool output or the rendered reply.' },
      // A second branch on a passage inside the first: one mark lists both.
      { id: 'other-question', node_id: 'other', role: 'user', seq: 0, content: 'And usage?', created_at: createdAt + 7,
        metadata: JSON.stringify({ quotedText: 'runtime control messages' }) },
    ],
    contexts: [],
  };
  await installMockApi(page, { workspaces: [workspace], custom: async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/prefs' && route.request().method() === 'GET') {
      await route.fulfill({ json: { prefs } });
      return true;
    }
    return false;
  } });
  await page.addInitScript((initial) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify(initial));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'quote-ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'quote-ws::tree': 'root' }));
  }, prefs);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await openThreadFromSidebar(page, 'Tool output');
  return page.locator('.terminal-pane[data-node-id="root"]');
}

for (const palette of ['monokai', 'bone']) {
  test(`a quoted passage is underlined and its card opens the branch: ${palette}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const pane = await boot(page, palette);
    const underline = pane.locator('[data-msg-id="root-answer"] .t-branch-anchor-underline');
    await expect(underline).toHaveCount(1);
    await expect(underline).toHaveText('from runtime control messages. Check');
    await expect(underline.locator('strong')).toHaveText('runtime control messages');
    await expect(underline).toHaveCSS('text-decoration-line', 'underline');
    await expect(underline).toHaveCSS('text-decoration-style', 'dotted');
    // The branches keep their turn markers below the reply.
    await expect(pane.getByRole('button', { name: 'Open branch: Control messages in the stream' })).toBeVisible();

    await underline.hover();
    const card = page.getByRole('group', { name: '2 branches from this passage' });
    await expect(card).toBeVisible();
    const [mark, box] = await Promise.all([underline.boundingBox(), card.boundingBox()]);
    expect(box!.y).toBeGreaterThanOrEqual(mark!.y + mark!.height);
    expect(box!.y - (mark!.y + mark!.height)).toBeLessThan(12);
    const items = card.locator('.t-branch-card-item');
    await expect(items).toHaveCount(2);
    // Each branch reads as a footnote: the question asked in it, then its reply.
    await expect(items.first().locator('.t-branch-card-question')).toHaveText('Which ones?');
    await expect(items.first().locator('.t-branch-card-reply')).toHaveText(/^Mode changes and usage\. Both ride/);
    await expect(items.nth(1).locator('.t-branch-card-question')).toHaveText('And usage?');
    await expect(items.nth(1).locator('.t-branch-anchor-status')).toHaveText('Needs attention');
    // Nothing in the card overflows its row.
    const overflow = await card.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('.t-branch-card-item, .t-branch-card-head'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
    expect(overflow).toEqual([]);
    await items.first().hover();
    await page.screenshot({ path: info.outputPath('quote-card.png'), clip: { x: box!.x - 220, y: box!.y - 70, width: 780, height: box!.height + 100 } });

    // The pointer can travel into the card, and a row opens its branch.
    await card.getByRole('button', { name: 'Open branch: Control messages in the stream' }).click();
    await expect(page.locator('.terminal-pane[data-node-id="child"]')).toBeVisible();
    await expect(card).toHaveCount(0);
  });
}
