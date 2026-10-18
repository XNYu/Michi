import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

test('extracts a branch from its menu, continues with inherited history, and survives reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = Date.now();
  const snapshot = {
    workspace: { id: 'ws-extract', name: 'Extraction workspace', cwd: '/mock/extract', created_at: now, active_tree_id: 'original' },
    trees: [{ id: 'original', workspace_id: 'ws-extract', root_node_id: 'parent', name: 'Original thread', created_at: now, last_active_at: now }],
    nodes: [
      { id: 'parent', parent_node_id: null as string | null, tree_id: 'original', workspace_id: 'ws-extract', kind: 'chat', title: 'Parent chat', status: 'idle', created_at: now, message_count: 2 },
      { id: 'branch', parent_node_id: 'parent', tree_id: 'original', workspace_id: 'ws-extract', kind: 'chat', title: 'Extract this branch', status: 'idle', created_at: now, message_count: 2 },
      { id: 'leaf', parent_node_id: 'branch', tree_id: 'original', workspace_id: 'ws-extract', kind: 'chat', title: 'Keep this child', status: 'idle', created_at: now, message_count: 0 },
    ],
    edges: [
      { id: 'parent-branch', source_node_id: 'parent', target_node_id: 'branch', kind: 'branch', anchor_message_id: 'parent-a' },
      { id: 'branch-leaf', source_node_id: 'branch', target_node_id: 'leaf', kind: 'branch', anchor_message_id: 'branch-a' },
    ],
    contexts: [], messages: [] as Array<{ id: string; node_id: string; role: string; content: string; seq: number; created_at: number }>,
  };
  snapshot.messages = [
    { id: 'parent-u', node_id: 'parent', role: 'user', content: 'Original research question', seq: 0, created_at: now },
    { id: 'parent-a', node_id: 'parent', role: 'assistant', content: 'Important parent background', seq: 1, created_at: now },
    { id: 'branch-u', node_id: 'branch', role: 'user', content: 'Investigate this direction', seq: 0, created_at: now },
    { id: 'branch-a', node_id: 'branch', role: 'assistant', content: 'Independent branch answer', seq: 1, created_at: now },
  ];
  let extractionCalls = 0;
  let resumedHistory: unknown;
  await installMockApi(page, { workspaces: [snapshot], custom: async route => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === '/api/prefs' && method === 'GET') {
      await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, sidebarExpanded: {
        workspaces: { 'ws-extract': true }, threads: { original: true }, branches: { branch: true },
      } } } });
      return true;
    }
    const treeMessages = pathname.match(/\/trees\/([^/]+)\/messages$/);
    if (treeMessages) {
      const ids = snapshot.nodes.filter(node => node.tree_id === decodeURIComponent(treeMessages[1])).map(node => node.id);
      await route.fulfill({ json: { messages: snapshot.messages.filter(message => ids.includes(message.node_id)) } });
      return true;
    }
    if (pathname.endsWith('/nodes/branch/extract-tree')) {
      extractionCalls++;
      const { treeId } = route.request().postDataJSON();
      const tree = { id: treeId, workspace_id: 'ws-extract', root_node_id: 'branch', name: 'Extract this branch', created_at: now, last_active_at: now + 1 };
      snapshot.trees.push(tree);
      snapshot.workspace.active_tree_id = treeId;
      snapshot.nodes[1].parent_node_id = null;
      snapshot.nodes[1].tree_id = treeId;
      snapshot.nodes[1].message_count = 4;
      snapshot.nodes[1].inherited_message_count = 2;
      snapshot.nodes[1].forked_from_node_id = 'parent';
      snapshot.nodes[2].tree_id = treeId;
      snapshot.edges = snapshot.edges.filter(edge => edge.id !== 'parent-branch');
      const inherited = snapshot.messages.filter(message => message.node_id === 'parent')
        .map(message => ({ ...message, id: `copy-${message.id}`, node_id: 'branch' }));
      snapshot.messages = [...snapshot.messages.filter(message => message.node_id !== 'branch'), ...inherited,
        ...snapshot.messages.filter(message => message.node_id === 'branch').map(message => ({ ...message, seq: message.seq + 2 }))];
      await route.fulfill({ json: {
        tree, nodeIds: ['branch', 'leaf'],
        messages: snapshot.messages.filter(message => message.node_id === 'branch'),
        forkedFromNodeId: 'parent', inheritedMessageCount: 2,
        forkBoundaryMessageId: 'copy-parent-a',
      } });
      return true;
    }
    if (pathname.endsWith('/nodes/branch/ensure-session')) resumedHistory = route.request().postDataJSON().priorMessages;
    return false;
  } });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await expect(page.locator('.t-sidebar-toggle')).toBeVisible();
  if (!await page.locator('.terminal-sidebar').isVisible()) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  const branchRow = page.locator('[data-sidebar-row="branch"]');
  await expect(branchRow).toBeVisible();
  await branchRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Extract as new thread' }).click();
  const pane = page.locator('.terminal-pane').filter({ hasText: 'Independent branch answer' });
  await expect(pane).toContainText('Important parent background');
  await expect(pane).toContainText('Original research question');
  const divider = pane.locator('.t-inherited-divider');
  await expect(divider).toContainText('Inherited history');
  await expect(divider).toContainText('2 messages');
  expect(extractionCalls).toBe(1);
  await expect(page.locator('[data-sidebar-row="leaf"]')).toBeVisible();
  await pane.locator('[contenteditable="true"]').fill('Continue using the full history');
  await pane.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(pane).toContainText('Hello from mock kiro.');
  expect(resumedHistory).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: 'Original research question' }),
    expect.objectContaining({ text: 'Important parent background' }),
    expect.objectContaining({ text: 'Independent branch answer' }),
  ]));
  await page.reload();
  await page.locator('[data-sidebar-row="branch"]').click();
  const reloaded = page.locator('.terminal-pane').filter({ hasText: 'Independent branch answer' });
  await expect(reloaded).toContainText('Important parent background');
  await expect(reloaded.locator('.t-inherited-divider')).toContainText('Inherited history');
  await page.locator('[data-sidebar-row="parent"]').click();
  await expect(page.locator('.terminal-pane').filter({ hasText: 'Important parent background' })).not.toContainText('Independent branch answer');
  expect(errors).toEqual([]);
});
