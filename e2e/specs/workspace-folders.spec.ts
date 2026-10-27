import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

const workspaceId = 'folder-workspace';

async function openManage(page: Page) {
  const row = page.getByTestId(`workspace-row-${workspaceId}`);
  await row.locator('.t-row-hover').first().hover();
  await row.getByRole('button', { name: 'Workspace options', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Manage workspace/ }).click();
  await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
}

test('adding the first folder sets fresh-session cwd and survives backend hydration after reload', async ({ page }) => {
  const selectedFolder = mkdtempSync(join(tmpdir(), 'michi-folder-e2e-'));
  const snapshot = {
    workspace: { id: workspaceId, name: 'Folder workspace', cwd: null as string | null,
      folders: null as string | null, active_tree_id: null as string | null, created_at: 1 },
    nodes: [] as Array<Record<string, unknown>>, trees: [] as Array<Record<string, unknown>>,
    messages: [], edges: [], contexts: [],
  };
  const ensures: Array<Record<string, unknown>> = [];
  const workspaceWrites: Array<Record<string, unknown>> = [];
  let workspaceReads = 0;
  const upsert = (rows: Array<Record<string, unknown>>, payload: Record<string, unknown>) => {
    const existing = rows.find(row => row.id === payload.id);
    if (existing) Object.assign(existing, payload);
    else rows.push({ ...payload });
  };

  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript((path) => {
      localStorage.setItem('michi:migrated', '1');
      localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
      Object.assign(window, { electron: {
        chooseFolders: async () => ({ canceled: false, folders: [{ path, name: 'Selected fixture folder' }] }),
      } });
    }, selectedFolder);
    await installMockApi(page, { workspaces: [snapshot], custom: async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && /^\/api\/workspaces(?:\/all)?$/.test(path)) workspaceReads++;
      if (request.method() === 'GET' && path === `/api/workspaces/${workspaceId}`) {
        workspaceReads++;
        await route.fulfill({ json: snapshot });
        return true;
      }
      if (request.method() === 'POST' && path === `/api/workspaces/${workspaceId}/commands`) {
        const body = request.postDataJSON();
        // Like multi-window-editing.spec, persist only rows submitted by the
        // renderer. No test-owned expected folder value is injected on reload.
        for (const command of body.commands) {
          if (command.type === 'workspace.upsert') {
            workspaceWrites.push(command.payload);
            Object.assign(snapshot.workspace, command.payload);
          } else if (command.type === 'tree.upsert') upsert(snapshot.trees, command.payload);
          else if (command.type === 'node.upsert' || command.type === 'node.patch') upsert(snapshot.nodes, command.payload);
        }
        await route.fulfill({ json: { operationId: body.operationId, applied: body.commands.map((command: { type: string; payload: { id: string } }) => ({ type: command.type, id: command.payload.id })) } });
        return true;
      }
      if (request.method() === 'POST' && /^\/api\/nodes\/[^/]+\/ensure-session$/.test(path)) {
        ensures.push(request.postDataJSON());
      }
      return false;
    } });

    await page.goto('/');
    await openManage(page);
    await page.getByRole('button', { name: '+ Add folder', exact: true }).click();
    await expect(page.getByText('(working directory)', { exact: true })).toBeVisible();
    await expect.poll(() => workspaceWrites.some(row => row.cwd === selectedFolder && typeof row.folders === 'string')).toBe(true);
    const savedFolders = JSON.parse(snapshot.workspace.folders!);
    expect(savedFolders).toEqual([expect.objectContaining({ path: selectedFolder, label: 'Selected fixture folder' })]);

    await page.locator('main [contenteditable="true"]').fill('Read the selected workspace');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect.poll(() => ensures.length).toBe(1);
    expect(ensures[0]).toMatchObject({ cwd: selectedFolder, workspaceId });
    await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();

    // Hydration must restore the persisted backend row even with no durable
    // localStorage state available to make an unsaved folder appear restored.
    await page.evaluate(() => localStorage.clear());
    const readsBeforeReload = workspaceReads;
    await page.reload();
    await openManage(page);
    expect(workspaceReads).toBeGreaterThan(readsBeforeReload);
    await expect(page.getByText('Selected fixture folder(working directory)', { exact: true })).toBeVisible();
    await expect(page.getByText('(working directory)', { exact: true })).toBeVisible();
    await expect(page.getByText(selectedFolder, { exact: true }).last()).toBeVisible();
    expect(JSON.parse(snapshot.workspace.folders!)).toEqual(savedFolders);
  } finally {
    rmSync(selectedFolder, { recursive: true, force: true });
  }
});
