import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

test('Kiro V3 commands render results and queued commands never become model prompts', async ({ page }) => {
  const prompts: string[] = [], commands: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await installMockApi(page, { custom: async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'POST') return false;
    if (path.endsWith('/ensure-session')) {
      await route.fulfill({ json: { chatId: path.split('/').at(-2), runtimeId: 'kiro', currentModeId: 'vibe', resumeStrategy: 'live',
        sessionState: { runtimeId: 'kiro', nativeEngine: 'v3', commands: [{ name: 'context' }, { name: 'tools' }] },
      } }); return true;
    }
    if (path.endsWith('/execute-command')) {
      const { command } = req.postDataJSON(); commands.push(command);
      await route.fulfill({ json: { success: command !== 'unknown', message: command === 'unknown' ? 'This command is unavailable.' : undefined,
        data: command === 'context' ? 'Context contains 123 tokens.' : 'Available tools: read, write.',
      } }); return true;
    }
    if (path.endsWith('/message')) {
      prompts.push(req.postDataJSON().text);
      if (prompts.length === 2) await blocked;
    }
    return false;
  } });
  await bootWithWorkspace(page);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill('Start a session');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  await editor.fill('/context');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('Context contains 123 tokens.', { exact: true })).toBeVisible();
  expect(commands).toEqual(['context']); expect(prompts).toHaveLength(1);
  await editor.fill('Keep working');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByRole('button', { name: 'Stop stream', exact: true })).toBeVisible();
  await editor.fill('/tools');
  await page.getByRole('button', { name: /^Send next/ }).click();
  expect(commands).toEqual(['context']);
  release();
  await expect.poll(() => commands).toEqual(['context', 'tools']);
  await expect(page.getByText('Available tools: read, write.', { exact: true })).toBeVisible();
  expect(prompts).toHaveLength(2);
  await editor.fill('/unknown');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('This command is unavailable.', { exact: false })).toBeVisible();
  expect(prompts).toHaveLength(2);
});

test('sending during a command preserves the draft and does not send a second request', async ({ page }) => {
  const commands: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await installMockApi(page, { custom: async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/agent/status')) {
      await route.fulfill({ json: { runtime: 'kiro', label: 'Kiro', hasRequiredKey: true,
        capabilities: { modes: false, permissions: true, providerModels: false, reasoning: false,
          apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false },
        availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }],
      } });
      return true;
    }
    if (!path.endsWith('/execute-command')) return false;
    commands.push(route.request().postDataJSON().command);
    await blocked;
    await route.fulfill({ json: { success: true, data: 'Context ready.' } });
    return true;
  } });
  await bootWithWorkspace(page);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill('/context');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect.poll(() => commands).toEqual(['context']);
  await editor.fill('/tools');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(editor).toHaveText('/tools');
  expect(commands).toEqual(['context']);
  release();
  await expect(page.getByText('Context ready.', { exact: true })).toBeVisible();
});
