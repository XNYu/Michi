import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PAGE_BLOCK_CATALOG, PAGE_BLOCK_TYPES } from 'michi-shared';
import { installMockApi } from '../fixtures/mockApi';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';
import { openArea } from '../fixtures/shell';

const evidence = resolve('.artifacts/native-visual');
// The specimen renders one block per catalog type that has an example, except threads.
const specimenBlockCount = PAGE_BLOCK_TYPES.filter((type) => PAGE_BLOCK_CATALOG[type].example && type !== 'threads').length;
const diagram = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280"><rect width="480" height="280" fill="#bbc4cc"/><circle cx="240" cy="140" r="70" fill="#687d8e"/></svg>';

for (const palette of ['bone', 'monokai']) test(`all native content renders with the new visual components in ${palette}`, async ({ page }) => {
  mkdirSync(evidence, { recursive: true });
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (/\/api\/desk|:4317/.test(request.url())) external.push(request.url()); });
  await page.route(/^https:\/\//, route => route.fulfill({ contentType: 'image/svg+xml', body: diagram }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?specimen=native-blocks&palette=${palette}`);
  await expect(page.locator('[data-native-page] > [data-block-id]')).toHaveCount(specimenBlockCount);
  await expect(page.locator('.desk-mermaid svg')).toBeAttached();
  await expect(page.locator('.desk-chart-box[role="img"]')).toBeAttached();
  await expect(page.getByRole('textbox', { name: /City/ })).toHaveCSS('border-top-width', '1px');
  await expect(page.getByRole('textbox', { name: /City/ })).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toHaveCSS('padding-left', '18px');
  await expect(page.locator('[data-michi-block="unknown"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);

  await page.goto(`/?specimen=native-blocks&palette=${palette}&only=heading,metrics,gauge,ring,chart,stepper,compare,form`);
  await page.setViewportSize({ width: 1440, height: 1800 });
  await expect(page.locator('.desk-chart-box[role="img"]')).toBeAttached();
  await page.locator('[data-block-id="sample-metrics"]').hover();
  await expect(page.locator('[data-block-id="sample-metrics"] [role="toolbar"]')).toBeVisible();
  await page.locator('article').screenshot({ path: resolve(evidence, `native-blocks-${palette}.png`), animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('all twelve chart designs render in a narrow native page', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 960 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?specimen=native-blocks&palette=monokai&only=chart&charts=all');
  await expect(page.locator('.desk-chart-box[role="img"]')).toHaveCount(12);
  await expect(page.locator('[data-michi-block="unknown"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('native block actions prefill the visible Spaces Assistant and preserve its fullscreen controls', async ({ page }) => {
  const sends: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/chats\/[^/]+\/message$/.test(new URL(request.url()).pathname)) sends.push(request.postData() ?? '');
  });
  const spaces = createSpacesHomeMock({ workspaceHomes: { 'ws-rich': { name: 'Visual review', blocks: [
    { id: 'action', rev: 1, type: 'actions', buttons: [{ label: 'Draft reply', prompt: 'Draft a release reply for review' }] },
    { id: 'gauge', rev: 1, type: 'gauge', title: 'Ready', value: 76, min: 0, max: 100, unit: '%' },
    { id: 'form', rev: 1, type: 'form', title: 'Trip', fields: [{ key: 'city', label: 'City', type: 'select', options: ['Kyoto', 'Tokyo'], required: true }], prompt: 'Plan a trip' },
  ] } } });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette: 'bone' }));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:metaChat:window:v1', JSON.stringify({ form: 'float', minimized: true, rect: null, dockRatio: 50 }));
  });
  await installMockApi(page, {
    workspaces: [
      { workspace: { id: 'ws-rich', name: 'Visual review', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] },
      { workspace: { id: 'ws-assistant', name: 'Assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }), active_tree_id: 'tree-rich' },
        trees: [{ id: 'tree-rich', workspace_id: 'ws-assistant', root_node_id: 'assistant-rich', name: 'Assistant', created_at: 1 }],
        nodes: [{ id: 'assistant-rich', workspace_id: 'ws-assistant', tree_id: 'tree-rich', kind: 'chat', title: 'Assistant', runtime_id: 'mock', status: 'idle', created_at: 1 }], messages: [], edges: [], contexts: [], artifacts: [] },
    ],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/assistant') { await route.fulfill({ json: { nodeId: 'assistant-rich', treeId: 'tree-rich', workspaceId: 'ws-assistant', settings: { runtimeId: 'mock', modelId: null, reasoning: null }, supportedRuntimes: ['mock'] } }); return true; }
      if (path === '/api/spaces') { await route.fulfill({ json: { items: [] } }); return true; }
      return spaces.handle(route);
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  await page.locator('.spaces-side').getByRole('button', { name: /^Visual review/ }).click();
  await page.getByRole('button', { name: 'Draft reply', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Assistant', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.terminal-composer [contenteditable="true"]')).toHaveText('Draft a release reply for review');
  await expect(panel).toContainText('Targeting:');
  expect(sends).toEqual([]);
  await panel.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(panel).toHaveAttribute('data-form', 'full');
  await expect(panel.getByRole('button', { name: 'New conversation' })).toBeVisible();
  await panel.getByRole('button', { name: 'Exit full screen' }).click();
  await panel.getByRole('button', { name: 'Minimize', exact: true }).click();
  await page.getByRole('combobox', { name: /City/ }).click();
  await page.getByRole('option', { name: 'Kyoto', exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(panel.locator('.terminal-composer [contenteditable="true"]')).toContainText('"city":"Kyoto"');
  expect(sends).toEqual([]);
  expect(errors).toEqual([]);
});
