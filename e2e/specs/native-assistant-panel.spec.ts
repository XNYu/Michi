import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { leaveSettings, openSettings } from '../fixtures/shell';

const previousAnswer = 'Start with the desktop acceptance checks, then confirm the release notes.';

test('the assistant follows the global settings: no Assistant settings, and ⌘J starts a new conversation itself', async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/desk') || url.port === '4317') external.push(request.url());
  });
  let current = 'old';
  const resets: unknown[] = [];
  const runs = { runtimeId: 'mock', providerId: null, modelId: null, reasoning: null };
  const assistantInfo = () => ({
    nodeId: `assistant-${current}`, treeId: `tree-${current}`, workspaceId: 'ws-assistant',
    settings: runs, conversation: runs, conversationFollowsGlobal: true, supportedRuntimes: ['mock'],
  });
  const messages = [
    { id: 'question-old', node_id: 'assistant-old', role: 'user', seq: 0, content: 'What should I focus on next?' },
    { id: 'answer-old', node_id: 'assistant-old', role: 'assistant', seq: 1, content: previousAnswer },
  ];
  const ids = () => (current === 'old' ? ['old'] : ['old', 'new']);
  const assistantWorkspace = () => ({
    workspace: { id: 'ws-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: `tree-${current}` },
    trees: ids().map(id => ({ id: `tree-${id}`, workspace_id: 'ws-assistant', root_node_id: `assistant-${id}`, name: 'Assistant', created_at: 1, archived_at: id === 'old' && current === 'new' ? 2 : null })),
    nodes: ids().map(id => ({ id: `assistant-${id}`, workspace_id: 'ws-assistant', tree_id: `tree-${id}`, kind: 'chat', title: 'Assistant', runtime_id: 'mock', status: 'idle', created_at: 1 })),
    messages, edges: [], contexts: [], artifacts: [],
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'ws-work', name: 'Work', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }, assistantWorkspace()],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/assistant') { await route.fulfill({ json: assistantInfo() }); return true; }
      if (path === '/api/assistant/reset') {
        resets.push(route.request().postDataJSON());
        current = 'new';
        await route.fulfill({ json: assistantInfo() });
        return true;
      }
      if (path === '/api/workspaces/ws-assistant') { await route.fulfill({ json: assistantWorkspace() }); return true; }
      if (path.includes('/api/workspaces/ws-assistant/trees/') && path.endsWith('/messages')) {
        await route.fulfill({ json: { messages: path.includes('tree-old') ? messages : [] } });
        return true;
      }
      return false;
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();

  // Runtime (global) is where the assistant's runtime comes from; it has no section of its own.
  const settings = await openSettings(page);
  const sections = settings.getByRole('navigation', { name: 'Settings sections' });
  await expect(sections.getByRole('button', { name: 'Runtime (global)', exact: true })).toBeVisible();
  await expect(sections.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
  await leaveSettings(page);

  // Starting over moved from Settings into the ⌘J panel.
  await page.keyboard.press('ControlOrMeta+j');
  const panel = page.getByRole('complementary', { name: 'Assistant', exact: true });
  await expect(panel.getByText(previousAnswer)).toBeVisible();
  await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(panel.getByText(previousAnswer)).toHaveCount(0);
  expect(resets).toEqual([{ nodeId: 'assistant-old' }]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
