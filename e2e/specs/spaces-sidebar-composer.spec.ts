import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { installMockApi } from '../fixtures/mockApi';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';
import { openArea } from '../fixtures/shell';
import { controlledStreamState, installControlledChatStream, pushChatStream } from '../fixtures/controlledChatStream';

const evidence = resolve('.artifacts/spaces-sidebar-composer');
const titles = ['Review the desktop release', 'Plan the next milestone', 'Compare the open decisions', 'Check the launch notes', 'Review the weekly summary', 'Continue the earlier investigation', 'Collect the remaining risks'];

for (const palette of ['bone', 'monokai']) test(`Spaces settings, assistant history and shared composer in ${palette}`, async ({ page }) => {
  mkdirSync(evidence, { recursive: true });
  await page.setViewportSize({ width: 1520, height: 980 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let selected = 0;
  const modelPatches: unknown[] = [];
  const model = { runtimeId: 'mock', providerId: null as string | null, modelId: 'model-one', reasoning: null };
  const info = () => ({ nodeId: `assistant-${selected}`, treeId: `tree-${selected}`, workspaceId: 'ws-assistant', settings: model, conversation: model, supportedRuntimes: ['mock'] });
  const messages = titles.flatMap((title, i) => [
    { id: `question-${i}`, node_id: `assistant-${i}`, role: 'user', seq: 0, content: title, created_at: 1700000000000 - i * 86400000 },
    { id: `answer-${i}`, node_id: `assistant-${i}`, role: 'assistant', seq: 1, content: `Saved answer for conversation ${i}.`, created_at: 1700000000001 - i * 86400000 },
  ]);
  const assistantWorkspace = () => ({
    workspace: { id: 'ws-assistant', name: 'Assistant', cwd: '/tmp/assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: `tree-${selected}` },
    trees: titles.map((_, i) => ({ id: `tree-${i}`, workspace_id: 'ws-assistant', root_node_id: `assistant-${i}`, name: 'Assistant', created_at: 1, archived_at: i === selected ? null : 2 })),
    nodes: titles.map((title, i) => ({ id: `assistant-${i}`, workspace_id: 'ws-assistant', tree_id: `tree-${i}`, kind: 'chat', title, runtime_id: 'mock', model_id: model.modelId, status: 'idle', created_at: 1 })),
    messages, edges: [], contexts: [], artifacts: [],
  });
  const spaces = createSpacesHomeMock();
  const metaInfo = () => ({ settings: { ...model, writeWorkspaceHomes: null, maintainSpacesHome: null, firstRunDays: null }, resolved: { ...model, followsGlobal: false }, availability: { available: true, reason: null }, guard: { maintenance: null, chat: null }, usageToday: { checks: 0, modelCalls: 0, tokens: null } });
  await page.addInitScript(terminalPalette => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette, uiFont: 'Geist' }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:metaChat:window:v1', JSON.stringify({ form: 'dock', minimized: true, rect: null, dockRatio: 50 }));
  }, palette);
  await installControlledChatStream(page);
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'ws-review', name: 'Release review', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }, assistantWorkspace()],
    custom: async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === '/api/prefs' && route.request().method() === 'GET') { await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: palette, uiFont: 'Geist' } } }); return true; }
      if (path === '/api/assistant') { await route.fulfill({ json: info() }); return true; }
      if (path === '/api/assistant/conversations') {
        const start = Number(url.searchParams.get('cursor') ?? 0);
        await route.fulfill({ json: { items: titles.slice(start, start + 5).map((title, offset) => ({ nodeId: `assistant-${start + offset}`, title, updatedAt: 1700000000000 - (start + offset) * 86400000 })), nextCursor: start + 5 < titles.length ? String(start + 5) : null } }); return true;
      }
      const activate = path.match(/^\/api\/assistant\/conversations\/assistant-(\d+)\/activate$/);
      if (activate) {
        expect(route.request().postDataJSON()).toEqual({ currentNodeId: `assistant-${selected}` });
        selected = Number(activate[1]); await route.fulfill({ json: info() }); return true;
      }
      if (path === '/api/workspaces/ws-assistant') { await route.fulfill({ json: assistantWorkspace() }); return true; }
      const tree = path.match(/^\/api\/workspaces\/ws-assistant\/trees\/tree-(\d+)\/messages$/);
      if (tree) { await route.fulfill({ json: { messages: messages.filter(message => message.node_id === `assistant-${tree[1]}`) } }); return true; }
      if (path === '/api/agent/runtime-catalog') { await route.fulfill({ json: { runtimeId: 'mock', providers: [], models: [{ id: 'model-one', label: 'Model One' }, { id: 'model-two', label: 'Model Two' }], capabilities: { models: true, providerModels: false, reasoning: false } } }); return true; }
      if (path === '/api/meta-agent/settings') { const patch = route.request().postDataJSON(); modelPatches.push(patch); Object.assign(model, patch); await route.fulfill({ json: metaInfo() }); return true; }
      if (path === '/api/meta-agent') { await route.fulfill({ json: metaInfo() }); return true; }
      if (path === '/api/spaces') { await route.fulfill({ json: { items: [] } }); return true; }
      return spaces.handle(route);
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  const sidebar = page.locator('.spaces-side');
  const settings = sidebar.getByRole('button', { name: 'Pages settings' });
  const settingsBox = await settings.boundingBox();
  expect(settingsBox!.y).toBeGreaterThan(850);
  await settings.click();
  const settingsPage = page.getByRole('main', { name: 'Pages settings', exact: true });
  await expect(settingsPage).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await settingsPage.getByRole('button', { name: 'Browse components' }).click();
  await expect(settingsPage.getByRole('heading', { name: 'Components', exact: true })).toBeVisible();
  await settingsPage.getByRole('button', { name: 'Back to settings' }).click();
  await page.screenshot({ path: resolve(evidence, `settings-${palette}.png`), animations: 'disabled' });
  await settingsPage.getByRole('button', { name: 'Back to Pages' }).click();
  const history = sidebar.getByRole('navigation', { name: 'Assistant conversations' });
  await expect(history.locator('.spaces-assistant-history__row')).toHaveCount(5);
  const rowType = await history.locator('.spaces-assistant-history__row').first().evaluate(element => {
    const style = getComputedStyle(element);
    const sidebar = element.closest('.terminal-sidebar')!;
    const reference = getComputedStyle(sidebar.querySelector('.area-side__row.is-nav')!);
    return { fontSize: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, referenceSize: reference.fontSize, referenceLineHeight: reference.lineHeight };
  });
  expect(rowType.fontSize).toBe(rowType.referenceSize);
  expect(rowType.lineHeight).toBe(rowType.referenceLineHeight);
  expect(rowType.weight).toBe('450');
  await history.getByRole('button', { name: 'Show more' }).click();
  await expect(history.locator('.spaces-assistant-history__row')).toHaveCount(7);
  await history.getByRole('button', { name: new RegExp(titles[5]) }).click();
  const panel = page.getByRole('region', { name: 'Assistant', exact: true });
  await expect(panel.getByText('Saved answer for conversation 5.')).toBeVisible();
  const editor = panel.locator('.terminal-composer [contenteditable="true"]');
  await expect(panel.locator('.terminal-composer')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: /^Model settings:/ })).toBeEnabled();
  await expect(panel.getByRole('button', { name: /^Permissions:/ })).toBeVisible();
  await expect(panel.getByTitle('Attach file', { exact: true })).toBeVisible();
  await expect(panel.getByTitle('Mention context or node', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: /^Model settings:/ }).click();
  const picker = page.getByRole('dialog', { name: 'Model settings', exact: true });
  await picker.getByRole('button', { name: /^Select model:/ }).click();
  await picker.getByRole('menuitemradio', { name: 'Model Two', exact: true }).click();
  await expect.poll(() => modelPatches).toEqual([{ runtimeId: 'mock', modelId: 'model-two' }]);
  await expect(panel.getByRole('button', { name: /^Model settings:.*Model Two/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await editor.fill('Keep this draft in conversation 5');
  await page.getByRole('navigation', { name: 'Areas' }).locator('[data-area="conversations"]').click();
  await page.getByRole('navigation', { name: 'Areas' }).locator('[data-area="spaces"]').click();
  await expect(editor).toHaveText('Keep this draft in conversation 5');
  await history.getByRole('button', { name: 'Show more' }).click();
  await expect(history.locator('.spaces-assistant-history__row')).toHaveCount(7);
  await expect(panel.getByRole('button', { name: /^Branch \(/ })).toHaveCount(0);
  await history.getByRole('button', { name: new RegExp(titles[0]) }).click();
  await expect(editor).toHaveText('');
  await editor.fill('Draft in conversation 0');
  await history.getByRole('button', { name: new RegExp(titles[5]) }).click();
  await expect(editor).toHaveText('Keep this draft in conversation 5');
  await panel.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(editor).toHaveText('Keep this draft in conversation 5');
  await panel.getByRole('button', { name: 'Exit full screen' }).click();
  await editor.fill('Continue this investigation');
  await panel.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(async () => (await controlledStreamState(page)).requests.length).toBe(1);
  const request = (await controlledStreamState(page)).requests[0];
  expect(request.url).toContain('assistant-5');
  expect(request.body.metaAgentContext).toMatchObject({ pageId: 'spaces-home' });
  await expect(panel.getByRole('button', { name: /Stop/ })).toBeVisible();
  await editor.fill('Queue the follow-up');
  await panel.getByRole('button', { name: /^Send next/ }).click();
  await expect(panel.getByText('Queue the follow-up', { exact: true })).toBeVisible();
  expect((await controlledStreamState(page)).requests).toHaveLength(1);
  await page.screenshot({ path: resolve(evidence, `history-composer-${palette}.png`), animations: 'disabled' });
  await pushChatStream(page, [{ event: 'error', data: { error: 'Fixture ending', turnId: request.body.turnId, assistantId: 'test-answer', nodeId: 'assistant-5' } }], true);
  await page.setViewportSize({ width: 940, height: 760 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});
