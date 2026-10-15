import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

const questions = [
  'Where in the Michi source is the completion marker in the set_branch_overview result generated?',
  'What could go wrong with frontend parsing if the model outputs that marker?',
  'Do instructions embedded in tool results pose a prompt injection risk?',
];

async function boot(page: Page, palette = 'monokai') {
  const sentChats: string[] = [];
  const prefs = { terminalPalette: palette, onboardingCompletedAt: 1, enableFollowUps: true,
    sidebarCollapsed: true, defaultPaneWidth: 880, paneWidthMode: 'fixed', messageFontSize: 16.5 };
  const ids = ['root', 'child', 'error-child'];
  const createdAt = Date.now() - 5 * 60_000;
  const workspace = {
    workspace: { id: 'followups-ws', name: 'Branch design', active_tree_id: 'tree', created_at: createdAt },
    trees: [{ id: 'tree', workspace_id: 'followups-ws', root_node_id: 'root', name: 'Tool results', created_at: createdAt, last_active_at: createdAt }],
    nodes: ids.map((id, index) => ({
      id, kind: 'chat', acp_session_id: id, runtime_id: 'mock', workspace_id: 'followups-ws', tree_id: 'tree',
      title: index === 0 ? 'Tool results and completion markers' : index === 1
        ? 'Trace set_branch_overview completion markers across tool definitions, runtime control messages, and frontend projection'
        : 'Frontend parsing of completion markers',
      status: index === 2 ? 'error' : 'idle', created_at: createdAt + index,
      follow_ups: JSON.stringify(index === 0 ? questions : []),
      follow_ups_source_message_id: index === 0 ? 'root-answer' : undefined,
    })),
    edges: ids.slice(1).map((target, i) => ({
      source_node_id: 'root', target_node_id: target, kind: 'branch',
      anchor_message_id: 'root-answer', created_at: createdAt + i + 3,
    })),
    messages: ids.flatMap(id => [
      { id: `${id}-question`, node_id: id, role: 'user', seq: 0, content: 'Review the tool result handling.', created_at: createdAt },
      { id: `${id}-answer`, node_id: id, role: 'assistant', seq: 1, content: 'Keep tool output separate from runtime control messages. Check the tool definition, stream events, and rendered output.', created_at: createdAt + 1 },
    ]),
    contexts: [],
  };
  await installMockApi(page, { workspaces: [workspace], custom: async route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
    if (path === '/prefs' && route.request().method() === 'GET') {
      await route.fulfill({ json: { prefs } });
      return true;
    }
    if (route.request().method() === 'POST' && /^\/chats\/[^/]+\/message$/.test(path)) {
      sentChats.push(path.split('/')[2]);
    }
    return false;
  } });
  await page.addInitScript(prefs => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify(prefs));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'followups-ws::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'followups-ws::tree': 'root' }));
  }, prefs);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByText('Tool results', { exact: true }).last().click();
  const pane = page.locator('.terminal-pane[data-node-id="root"]');
  await expect(pane.locator('.t-followup-row')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  return { pane, sentChats };
}

async function assertLayout(pane: Locator) {
  const problems = await pane.evaluate(root => {
    const issues: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('.t-branch-anchor-row, .t-branch-anchor-name, .t-branch-anchor-meta, .t-followup-row, .t-followup-text, .t-followup-branch')) {
      if (el.scrollWidth > el.clientWidth + 1) issues.push(`${el.className} overflows`);
    }
    for (const row of root.querySelectorAll('.t-followup-row')) {
      const bounds = row.getBoundingClientRect();
      const fork = row.querySelector('.t-followup-branch')!.getBoundingClientRect();
      const text = row.querySelector('.t-followup-text')!.getBoundingClientRect();
      if (Math.abs(fork.width / bounds.width - .25) > .005) issues.push('branch is not the right quarter');
      if (Math.abs(fork.right - bounds.right) > 1 || Math.abs(fork.height - bounds.height) > 1) issues.push('branch does not fill its target');
      if (text.right > fork.left + 1) issues.push('actions overlap');
    }
    for (const row of root.querySelectorAll('.t-branch-anchor-row')) {
      const title = row.querySelector('.t-branch-anchor-name')!.getBoundingClientRect();
      const meta = row.querySelector('.t-branch-anchor-meta')!.getBoundingClientRect();
      if (meta.top < title.bottom - 1 && meta.left < title.right + 8) issues.push('branch title overlaps metadata');
      if (getComputedStyle(row).borderLeftWidth !== '0px' || getComputedStyle(row).boxShadow !== 'none') issues.push('generated branch has a rail');
    }
    return issues;
  });
  expect(problems).toEqual([]);
}

for (const palette of ['monokai', 'bone']) {
  for (const width of [1440, 390]) {
    test(`Flow layout and hover behavior: ${palette}, ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1080 });
      const { pane } = await boot(page, palette);
      const rows = pane.locator('.t-followup-row');
      const row = rows.first();
      const text = row.locator('.t-followup-text');
      const branch = row.locator('.t-followup-branch');
      await pane.locator('[contenteditable="true"]').fill('Explore another approach');
      const composerBranch = pane.getByRole('button', { name: /^Branch \(/ });
      const composerIcon = composerBranch.locator('svg.lucide-split');
      const followUpIcon = branch.locator('svg.lucide-split');
      await expect(composerIcon).toBeVisible();
      await expect(followUpIcon).toBeVisible();
      await expect(composerIcon).toHaveCSS('rotate', '90deg');
      await expect(followUpIcon).toHaveCSS('rotate', '90deg');
      expect(await composerIcon.innerHTML()).toBe(await followUpIcon.innerHTML());
      await expect(pane.locator('.t-followup-num, .t-followup-text svg, .t-branch-anchor-pulse, .lucide-panel-right-open')).toHaveCount(0);
      await expect(pane.locator('.t-branch-anchor-name').first()).toHaveCSS('font-size', '15.5px');
      await expect(text).toHaveCSS('font-size', '15.5px');
      await row.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await expect(row).toHaveCSS('background-image', 'none');
      await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect.poll(() => row.evaluate(el => getComputedStyle(el, '::before').opacity)).toBe('0');
      await assertLayout(pane);
      await pane.screenshot({ path: info.outputPath('flow-idle.png') });

      await text.hover();
      await expect(row).toHaveCSS('background-image', /linear-gradient/);
      await expect.poll(() => row.evaluate(el => getComputedStyle(el, '::before').opacity)).toBe('1');
      await branch.hover();
      await expect.poll(() => row.evaluate(el => getComputedStyle(el).getPropertyValue('--followup-tint').trim())).toBe('26%');
      await expect(branch).toHaveCSS('background-image', 'none');
      await expect(branch).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await pane.screenshot({ path: info.outputPath('flow-hover.png') });
      await page.mouse.move(0, 0);
      await expect(row).toHaveCSS('background-image', 'none');
      await expect.poll(() => row.evaluate(el => getComputedStyle(el, '::before').opacity)).toBe('0');

      await text.focus();
      await text.press('Tab');
      await expect(branch).toBeFocused();
      await expect(branch).toHaveCSS('outline-style', 'solid');
      await expect(row).toHaveCSS('background-image', 'none');
      await pane.getByRole('button', { name: 'Collapse follow-ups' }).click();
      await expect(row).toBeHidden();
      await pane.getByRole('button', { name: 'Expand follow-ups' }).click();
      await expect(row).toBeVisible();

      await page.evaluate(() => document.documentElement.style.setProperty('--message-body-size-base', '22px'));
      await expect(text).toHaveCSS('font-size', '21px');
      await assertLayout(pane);
      await pane.screenshot({ path: info.outputPath('flow-large-type.png') });
    });
  }
}

test('generated branch metadata opens the existing child without creating or sending a turn', async ({ page }) => {
  const { pane, sentChats } = await boot(page);
  await expect(pane.locator('.t-branch-anchor-status').first()).toHaveText('Idle');
  await expect(pane.locator('.t-branch-anchor-status').nth(1)).toHaveText('Needs attention');
  await pane.locator('.t-branch-anchor-row').first().getByText('2 messages').click();
  await expect(page.locator('.terminal-pane[data-node-id="child"]')).toBeVisible();
  expect(sentChats).toEqual([]);
});

for (const corner of ['top-left', 'bottom-right']) {
  test(`the ${corner} corner of the branch quarter only sends to the child`, async ({ page }) => {
    const { pane, sentChats } = await boot(page);
    const branch = pane.locator('.t-followup-branch').first();
    const size = await branch.boundingBox();
    await branch.click({ position: corner === 'top-left' ? { x: 3, y: 3 } : { x: size!.width - 3, y: size!.height - 3 } });
    await expect.poll(() => sentChats.length).toBe(1);
    expect(sentChats[0]).not.toBe('root');
    await expect(pane.locator('.t-branch-anchor-row')).toHaveCount(3);
    await expect(pane.locator('.terminal-message-user').filter({ hasText: questions[0] })).toHaveCount(0);
  });
}

test('continuing sends in the parent without adding a branch', async ({ page }) => {
  const { pane, sentChats } = await boot(page);
  await pane.locator('.t-followup-text').first().click();
  await expect.poll(() => sentChats.length).toBe(1);
  expect(sentChats).toEqual(['root']);
  await expect(pane.locator('.t-branch-anchor-row')).toHaveCount(2);
});
