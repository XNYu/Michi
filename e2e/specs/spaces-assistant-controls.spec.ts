import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { installMockApi } from '../fixtures/mockApi';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';
import { openArea } from '../fixtures/shell';

const evidence = resolve('.artifacts/hover-fullscreen');
const previousAnswer = 'Start with the desktop acceptance checks, then confirm the release notes.';

for (const palette of ['bone', 'monokai']) test(`native hover actions and assistant full screen/new conversation in ${palette}`, async ({ page }) => {
  mkdirSync(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let current = 'old';
  let resets = 0;
  const assistantInfo = () => ({ nodeId: `assistant-${current}`, treeId: `tree-${current}`, workspaceId: 'ws-assistant', settings: { runtimeId: 'mock', modelId: null, reasoning: null }, supportedRuntimes: ['mock'] });
  const messages = [
    { id: 'question-old', node_id: 'assistant-old', role: 'user', seq: 0, content: 'What should I focus on next?' },
    { id: 'answer-old', node_id: 'assistant-old', role: 'assistant', seq: 1, content: previousAnswer },
  ];
  const assistantWorkspace = () => ({
    workspace: { id: 'ws-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: `tree-${current}` },
    trees: (current === 'old' ? ['old'] : ['old', 'new']).map(id => ({ id: `tree-${id}`, workspace_id: 'ws-assistant', root_node_id: `assistant-${id}`, name: 'Assistant', created_at: 1, archived_at: id === 'old' && current === 'new' ? 2 : null })),
    nodes: (current === 'old' ? ['old'] : ['old', 'new']).map(id => ({ id: `assistant-${id}`, workspace_id: 'ws-assistant', tree_id: `tree-${id}`, kind: 'chat', title: 'Assistant', runtime_id: 'mock', status: 'idle', created_at: 1 })),
    messages, edges: [], contexts: [], artifacts: [],
  });
  const spaces = createSpacesHomeMock({
    workspaceHomes: { 'ws-review': { name: 'Release review', blocks: [{ id: 'review-block', rev: 1, type: 'markdown', text: 'Review the desktop build and confirm the release notes.', sources: [{ nodeId: 'assistant-old', turnId: 'turn-old', assistantId: 'answer-old' }] }] } },
  });
  await page.addInitScript(terminalPalette => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette, uiFont: 'Geist' }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:metaChat:window:v1', JSON.stringify({ form: 'float', minimized: true, rect: null, dockRatio: 50 }));
  }, palette);
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'ws-review', name: 'Release review', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }, assistantWorkspace()],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/prefs' && route.request().method() === 'GET') { await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette, uiFont: 'Geist' } } }); return true; }
      if (path === '/api/assistant') { await route.fulfill({ json: assistantInfo() }); return true; }
      if (path === '/api/assistant/reset') {
        expect(route.request().postDataJSON()).toEqual({ nodeId: 'assistant-old' });
        resets += 1;
        current = 'new';
        await route.fulfill({ json: assistantInfo() }); return true;
      }
      if (path === '/api/workspaces/ws-assistant') { await route.fulfill({ json: assistantWorkspace() }); return true; }
      if (path.includes('/api/workspaces/ws-assistant/trees/') && path.endsWith('/messages')) {
        await route.fulfill({ json: { messages: path.includes('tree-old') ? messages : [] } }); return true;
      }
      if (path === '/api/spaces') { await route.fulfill({ json: { items: [] } }); return true; }
      return spaces.handle(route);
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  await page.locator('.spaces-side').getByRole('button', { name: /^Release review/ }).click();
  const home = page.getByRole('main', { name: 'Release review', exact: true });
  const block = home.locator('[data-block-id="review-block"]');
  await block.hover();
  const toolbar = block.getByRole('toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveText('');
  await expect(toolbar.getByRole('button')).toHaveCount(6);
  await expect(toolbar.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
  await expect(toolbar.getByText(/Codex/)).toHaveCount(0);
  await page.screenshot({ path: resolve(evidence, `hover-${palette}.png`), animations: 'disabled' });
  await toolbar.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(block).toHaveAttribute('data-selected', 'true');
  await toolbar.getByRole('button', { name: 'Ask assistant' }).click();
  const panel = page.getByRole('region', { name: 'Assistant', exact: true });
  await expect(panel.getByText(previousAnswer)).toBeVisible();
  await expect(panel.getByText(/Targeting:/)).toBeVisible();
  const editor = panel.locator('.terminal-composer [contenteditable="true"]');
  await editor.fill('Keep this unsent question');
  const floatBox = await panel.boundingBox();
  await panel.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(panel).toHaveAttribute('data-form', 'full');
  await expect(home).toBeHidden();
  await expect(editor).toHaveText('Keep this unsent question');
  await expect(panel.getByText(previousAnswer)).toBeVisible();
  const area = await page.locator('.meta-chat-area').boundingBox();
  const full = await panel.boundingBox();
  expect(full!.width).toBeCloseTo(area!.width, 0);
  expect(full!.height).toBeCloseTo(area!.height, 0);
  await page.screenshot({ path: resolve(evidence, `fullscreen-${palette}.png`), animations: 'disabled' });
  await panel.getByRole('button', { name: 'Exit full screen' }).click();
  await expect(panel).toHaveAttribute('data-form', 'float');
  expect(await panel.boundingBox()).toEqual(floatBox);
  await expect(editor).toHaveText('Keep this unsent question');
  await panel.getByRole('button', { name: 'Dock as half screen' }).click();
  await panel.getByRole('button', { name: 'Full screen', exact: true }).click();
  await panel.getByRole('button', { name: 'Exit full screen' }).click();
  await expect(panel).toHaveAttribute('data-form', 'dock');
  await panel.getByRole('button', { name: 'Full screen', exact: true }).click();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await expect(panel.getByText(previousAnswer)).toHaveCount(0);
  await expect(editor).toHaveText('');
  await expect(panel.getByText(/Targeting:/)).toHaveCount(0);
  await expect(panel.locator('.meta-chat-conversation [data-node-id="assistant-new"]')).toBeVisible();
  expect(resets).toBe(1);
  await page.screenshot({ path: resolve(evidence, `new-conversation-${palette}.png`), animations: 'disabled' });
  await page.setViewportSize({ width: 820, height: 740 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(panel.getByRole('button', { name: 'Exit full screen' })).toBeInViewport();
  await expect(panel.getByRole('button', { name: 'New conversation' })).toBeInViewport();
  await page.screenshot({ path: resolve(evidence, `fullscreen-narrow-${palette}.png`), animations: 'disabled' });
  expect(errors).toEqual([]);
});
