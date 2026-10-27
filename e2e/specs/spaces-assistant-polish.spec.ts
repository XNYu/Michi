import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PageBlock } from 'michi-shared';
import { installMockApi } from '../fixtures/mockApi';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';
import { openArea } from '../fixtures/shell';

const evidence = resolve('.artifacts/spaces-assistant-polish');
const workspace = (id: string, name: string) => ({
  workspace: { id, name, created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [],
});
const assistant = {
  workspace: { id: 'ws-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: 'tree-assistant' },
  trees: [{ id: 'tree-assistant', workspace_id: 'ws-assistant', root_node_id: 'node-assistant', name: 'Assistant', created_at: 1 }],
  nodes: [{ id: 'node-assistant', workspace_id: 'ws-assistant', tree_id: 'tree-assistant', kind: 'chat', title: 'Assistant', runtime_id: 'mock', status: 'idle', created_at: 1 }],
  edges: [], contexts: [], artifacts: [],
  messages: [
    { id: 'message-user', node_id: 'node-assistant', role: 'user', seq: 0, content: 'What should I focus on next?' },
    { id: 'message-assistant', node_id: 'node-assistant', role: 'assistant', seq: 1, content: 'The release is ready for review. Start with the desktop acceptance checks, then confirm the release notes.' },
  ],
};
const source = [{ nodeId: 'release-chat', turnId: 'release-turn', assistantId: 'release-answer' }];
const blocks: PageBlock[] = [
  { id: 'lead', rev: 1, type: 'markdown', text: 'The release is ready for review. Desktop acceptance checks and release notes are the next steps.', sources: source },
  { id: 'heading', rev: 1, type: 'heading', text: 'Ready for review', sources: source },
  { id: 'review', rev: 1, type: 'markdown', text: 'The assistant and Spaces now share a calmer layout. Review the page at full width and check the focused conversation before publishing.', sources: source },
];

for (const palette of ['bone', 'monokai']) test(`Spaces and Michi assistant stay focused in ${palette}`, async ({ page }) => {
  mkdirSync(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1720, height: 1080 });
  const spaces = createSpacesHomeMock({
    homeBlocks: blocks,
    workspaceHomes: { 'ws-release': { name: 'Release work', blocks }, 'ws-empty': { name: 'Empty workspace', blocks: [] } },
  });
  await page.addInitScript((terminalPalette) => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette, uiFont: 'Geist' }));
    localStorage.setItem('michi:migrated', '1');
  }, palette);
  await installMockApi(page, {
    workspaces: [workspace('ws-release', 'Release work'), workspace('ws-empty', 'Empty workspace'), assistant],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/prefs' && route.request().method() === 'GET') {
        await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette, uiFont: 'Geist' } } }); return true;
      }
      if (path === '/api/assistant') {
        await route.fulfill({ json: { nodeId: 'node-assistant', workspaceId: 'ws-assistant', treeId: 'tree-assistant', settings: { runtimeId: 'mock', modelId: null, reasoning: null }, supportedRuntimes: ['mock'] } }); return true;
      }
      if (path === '/api/workspaces/ws-assistant') {
        await route.fulfill({ json: assistant }); return true;
      }
      if (path === '/api/workspaces/ws-assistant/trees/tree-assistant/messages') {
        await route.fulfill({ json: { messages: assistant.messages } }); return true;
      }
      if (path === '/api/spaces') {
        await route.fulfill({ json: { items: [] } }); return true;
      }
      return spaces.handle(route);
    },
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-terminal-palette', palette);
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  const sidebar = page.locator('.spaces-side');
  await expect(sidebar.getByRole('button', { name: /^All threads/ })).toHaveCount(0);
  await expect(sidebar.locator('[data-workspace="ws-empty"]')).toHaveCount(0);
  await sidebar.getByRole('button', { name: /^Release work/ }).click();
  const home = page.getByRole('main', { name: 'Release work', exact: true });
  await expect(home.getByText('The release is ready for review. Desktop acceptance checks and release notes are the next steps.')).toBeVisible();
  const panel = page.getByRole('region', { name: 'Assistant', exact: true });
  const launcher = page.locator('button.meta-chat-pill');
  await panel.or(launcher).first().waitFor();
  if (await panel.isVisible()) await panel.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(launcher).toHaveAccessibleName('Ask assistant');
  await expect(launcher).toHaveText('');
  await expect(home.getByText('Agent updated', { exact: true })).toHaveCount(0);
  await expect(home.getByText('Agent maintained', { exact: true })).toHaveCount(0);
  const column = home.locator('.area-settings__doc');
  const columnBox = await column.boundingBox();
  const homeBox = await home.boundingBox();
  expect(columnBox!.width).toBeGreaterThan(homeBox!.width * 0.9);
  await page.screenshot({ animations: 'disabled', path: resolve(evidence, `workspace-${palette}.png`) });

  await launcher.click();
  await expect(panel).toContainText('Viewing: Release work');
  await expect(panel.locator('.meta-chat-panel__badge')).toHaveCount(0);
  await expect(panel.getByText('The release is ready for review. Start with the desktop acceptance checks, then confirm the release notes.')).toBeVisible();
  await expect(panel.getByText('Michi', { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole('button', { name: 'What is the biggest risk right now?' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Summarize this page in 3 lines' })).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: resolve(evidence, `assistant-${palette}.png`) });
  await panel.getByRole('button', { name: 'Minimize', exact: true }).click();
  await page.setViewportSize({ width: 940, height: 850 });
  expect(await home.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: resolve(evidence, `workspace-narrow-${palette}.png`) });
  expect(errors).toEqual([]);
});
