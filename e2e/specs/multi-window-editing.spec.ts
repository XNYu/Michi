import { expect, test, type Page, type Route } from '@playwright/test';
import { mergeWindowComposerDraft, selectWindowComposerDraft } from 'michi-shared';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

const workspaceId = 'editable-ws';
const treeId = 'editable-tree';
const nodeId = 'editable-root';

async function seedPrefs(page: Page) {
  await page.addInitScript(({ workspaceId, treeId }) => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify({
      onboardingCompletedAt: 1, sidebarCollapsed: false,
      sidebarExpanded: { workspaces: { [workspaceId]: true }, threads: { [treeId]: true }, branches: {} },
    }));
  }, { workspaceId, treeId });
}

async function openPane(page: Page) {
  await page.locator('.terminal-sidebar [data-sidebar-row="editable-root"]').click();
  await expect(page.locator('.terminal-dashboard [data-node-id="editable-root"]').first()).toBeVisible();
}

test('two windows edit independently and restore their own durable drafts', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  const node = {
    id: nodeId, workspace_id: workspaceId, tree_id: treeId, title: 'Editable conversation',
    kind: 'chat', status: 'idle', created_at: 1, composer_draft: null as string | null,
  };
  const workspace = {
    workspace: { id: workspaceId, name: 'Editable workspace', active_tree_id: treeId, created_at: 1 },
    trees: [{ id: treeId, workspace_id: workspaceId, root_node_id: nodeId, name: 'Editable conversation', created_at: 1, last_active_at: 1 }],
    nodes: [node], messages: [], edges: [], artifacts: [],
  };
  const leaseCalls: string[] = [];
  const custom = async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (/\/(claim|heartbeat|release)$/.test(url.pathname)) leaseCalls.push(url.pathname);
    if (method === 'GET' && /^\/api\/workspaces(?:\/all)?$/.test(url.pathname)) {
      await route.fulfill({ json: { workspaces: [workspace] } });
      return true;
    }
    if (method === 'GET' && url.pathname === `/api/workspaces/${workspaceId}`) {
      await route.fulfill({ json: workspace });
      return true;
    }
    if (method === 'POST' && url.pathname === `/api/workspaces/${workspaceId}/commands`) {
      const body = route.request().postDataJSON();
      for (const command of body.commands) {
        if (command.type !== 'node.patch' || command.payload.id !== nodeId) continue;
        const payload = command.payload;
        if ('composer_draft' in payload && payload.composer_draft_window_id) {
          node.composer_draft = mergeWindowComposerDraft(node.composer_draft, payload.composer_draft_window_id, payload.composer_draft);
        }
      }
      await route.fulfill({ json: { operationId: body.operationId, applied: true } });
      return true;
    }
    return false;
  };
  try {
    for (const page of [first, second]) {
      await seedPrefs(page);
      await installMockApi(page, { custom });
      await page.goto('/');
      await openPane(page);
    }
    const editor = (page: Page) => page.locator('.terminal-dashboard [contenteditable]').first();
    const firstId = await first.evaluate(() => sessionStorage.getItem('michi:windowId')!);
    const secondId = await second.evaluate(() => sessionStorage.getItem('michi:windowId')!);
    expect(firstId).not.toBe(secondId);
    await expect(editor(first)).toHaveAttribute('contenteditable', 'true');
    await expect(editor(second)).toHaveAttribute('contenteditable', 'true');
    await editor(first).fill('Draft from first window');
    await editor(second).fill('Draft from second window');
    const savedText = (windowId: string) => {
      const draft = selectWindowComposerDraft(node.composer_draft, windowId);
      return draft ? JSON.parse(draft).value : null;
    };
    await expect.poll(() => savedText(firstId)).toBe('Draft from first window');
    await expect.poll(() => savedText(secondId)).toBe('Draft from second window');

    await first.reload();
    await openPane(first);
    await expect(editor(first)).toHaveText('Draft from first window');
    await expect(editor(second)).toHaveText('Draft from second window');
    await editor(first).fill('');
    await expect.poll(() => savedText(firstId)).toBeNull();
    expect(savedText(secondId)).toBe('Draft from second window');
    await second.reload();
    await openPane(second);
    await expect(editor(second)).toHaveText('Draft from second window');
    expect(leaseCalls).toEqual([]);
    await expect(first.getByText(/another window.*edit/i)).toHaveCount(0);
    await expect(second.getByText(/another window.*edit/i)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a competing send retains the input and never requests cancellation', async ({ page }) => {
  const message = 'This conversation already has a running task. Wait for it to finish or start a branch.';
  const cancels: string[] = [];
  await installMockApi(page, { custom: async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/chats\/[^/]+\/cancel$/.test(path)) cancels.push(path);
    if (/\/chats\/[^/]+\/message$/.test(path)) {
      await route.fulfill({ status: 409, json: { error: message, code: 'turn_active' } });
      return true;
    }
    return false;
  } });
  await bootWithWorkspace(page);
  const editor = page.locator('[contenteditable]').first();
  await editor.fill('Keep this unsent question');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(editor).toHaveText('Keep this unsent question');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  expect(cancels).toEqual([]);
});
