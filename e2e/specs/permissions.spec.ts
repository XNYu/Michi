import { test, expect, type Page } from '@playwright/test';
import { installMockApi, bootWithWorkspace, sseBody } from '../fixtures/mockApi';
import type { ChatPermissionSettings } from 'michi-shared';

type PermissionSource = 'acp_permission' | 'claude_prompt_tool' | 'codex_approval' | 'michi_policy';
type PermissionOption = { optionId: string; name: string; kind: string };
declare global {
  interface Window {
    __michiPermissionAudit: { turnId: string | null; write: ((data: string) => void) | null };
  }
}
const options: PermissionOption[] = [
  { optionId: 'provider-allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'provider-allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'provider-deny', name: 'Deny', kind: 'reject_once' },
];

async function fixture(page: Page, initial: ChatPermissionSettings = { global: false, mode: 'ask' }, runtimeId = 'mock', registeredRuntimeIds = [runtimeId]) {
  const state = {
    settings: initial,
    runtimeId,
    responses: [] as Array<{ requestId: number; optionId?: string; cancel?: boolean }>,
    ensureBodies: [] as Array<Record<string, unknown>>,
    chatModes: [] as Array<{ mode: string }>,
  };
  await installMockApi(page, {
    custom: async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path.endsWith('/agent/status')) {
        await route.fulfill({ json: {
          runtime: state.runtimeId, label: state.runtimeId, hasRequiredKey: true, customAgentsEnabled: false,
          capabilities: { modes: false, permissions: true, models: false, providerModels: false,
            reasoning: false, apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false },
          availableRuntimes: registeredRuntimeIds.map((id) => ({ id, label: id, available: true })),
        } });
        return true;
      }
      if (request.method() === 'POST' && path.endsWith('/agent/options')) {
        state.runtimeId = request.postDataJSON().runtime ?? state.runtimeId;
        await route.fulfill({ json: { ok: true } });
        return true;
      }
      if (request.method() === 'GET' && path.endsWith('/prefs')) {
        await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, globalPermissions: state.settings.global, permissionMode: state.settings.mode } } });
        return true;
      }
      if (request.method() === 'PUT' && path.endsWith('/permissions/settings')) {
        state.settings = request.postDataJSON();
        await route.fulfill({ json: state.settings });
        return true;
      }
      if (request.method() === 'PUT' && /\/nodes\/[^/]+\/permissions$/.test(path)) {
        state.chatModes.push(request.postDataJSON());
        await route.fulfill({ json: { mode: state.chatModes.at(-1)!.mode } });
        return true;
      }
      if (request.method() === 'POST' && path.endsWith('/ensure-session')) {
        state.ensureBodies.push(request.postDataJSON());
        await route.fulfill({ json: {
          chatId: path.split('/').at(-2), currentModeId: null, resumeStrategy: 'fresh',
          runtimeId: request.postDataJSON().runtimeId ?? state.runtimeId,
        } });
        return true;
      }
      if (request.method() === 'POST' && path.endsWith('/permission-response')) {
        state.responses.push(request.postDataJSON());
        await route.fulfill({ json: { ok: true } });
        return true;
      }
      return false;
    },
  });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.__michiPermissionAudit = { turnId: null, write: null };
    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, window.location.href);
      if (init?.method === 'POST' && /^\/api\/chats\/[^/]+\/message$/.test(url.pathname)) {
        const payload = JSON.parse(String(init.body));
        window.__michiPermissionAudit.turnId = payload.turnId;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            window.__michiPermissionAudit.write = (data: string) => controller.enqueue(encoder.encode(data));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  });
  await bootWithWorkspace(page);
  return state;
}

async function send(page: Page) {
  await page.locator('[contenteditable="true"]').first().fill('permission test');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__michiPermissionAudit.turnId))).toBe(true);
}
async function finishTurn(page: Page) {
  const turnId = await page.evaluate(() => window.__michiPermissionAudit.turnId);
  await page.evaluate((body) => window.__michiPermissionAudit.write!(body), sseBody([
    { event: 'done', data: { stopReason: 'end_turn', turnId, seq: 0 } },
  ]));
  await expect(page.getByRole('button', { name: /^Permissions:/ })).toBeEnabled();
}
async function requestPermission(page: Page, source: PermissionSource, requestOptions = options) {
  const turnId = await page.evaluate(() => window.__michiPermissionAudit.turnId);
  const body = sseBody([{ event: 'permission_request', data: {
    requestId: 401, title: 'Test write approval', source, options: requestOptions, turnId, seq: 0,
  } }]);
  await page.evaluate((body) => window.__michiPermissionAudit.write!(body), body);
}
async function openSettings(page: Page) {
  await page.locator('.terminal-sidebar').getByText('Settings', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Model', exact: true }).click();
  return settings;
}
async function selectMode(page: Page, mode: string) {
  await page.getByRole('button', { name: /^Permissions:/ }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${mode}\\b`) }).click();
  await expect(page.getByRole('button', { name: `Permissions: ${mode}`, exact: true })).toBeVisible();
}

for (const source of ['acp_permission', 'claude_prompt_tool', 'codex_approval', 'michi_policy'] as const) {
  test(`${source}: Ask waits for the user and preserves the native deny option`, async ({ page }) => {
    const state = await fixture(page); await send(page);
    await requestPermission(page, source);
    await expect(page.getByTestId('permission-source').locator('..')).toContainText('Test write approval');
    expect(state.responses).toEqual([]);
    await page.getByRole('button', { name: /^Deny/ }).click();
    await expect.poll(() => state.responses).toEqual([{ requestId: 401, optionId: 'provider-deny' }]);
  });
}
for (const [button, optionId] of [['Allow once', 'provider-allow-once'], ['Always allow', 'provider-allow-always']]) {
  test(`manual ${button} preserves the provider option ID`, async ({ page }) => {
    const state = await fixture(page); await send(page);
    await requestPermission(page, 'michi_policy');
    await page.getByRole('button', { name: new RegExp(`^${button}`) }).click();
    await expect.poll(() => state.responses).toEqual([{ requestId: 401, optionId }]);
  });
}

test('global Trust hides both Composer controls and never approves an unexpected backend request in the renderer', async ({ page }) => {
  const state = await fixture(page, { global: true, mode: 'trust' });
  await expect(page.getByRole('button', { name: /^Permissions:/ })).toHaveCount(0);
  await send(page);
  await expect(page.getByRole('button', { name: /^Permissions:/ })).toHaveCount(0);
  await requestPermission(page, 'acp_permission');
  await expect(page.getByTestId('permission-source')).toBeVisible();
  expect(state.responses).toEqual([]);
});

test('new-chat permission choice reaches the backend before the first prompt and is displayed in its pane', async ({ page }) => {
  const state = await fixture(page);
  await selectMode(page, 'Trust');
  await expect(page.getByRole('button', { name: 'Permissions: Trust', exact: true })).toBeVisible();
  await send(page);
  expect(state.ensureBodies[0].permissionMode).toBe('trust');
  await expect(page.getByRole('button', { name: 'Permissions: Trust', exact: true })).toBeDisabled();
});

test('an existing chat saves its Composer mode and retains the selection across global control', async ({ page }) => {
  const state = await fixture(page);
  await selectMode(page, 'Trust');
  await send(page);
  const turnId = await page.evaluate(() => window.__michiPermissionAudit.turnId);
  await page.evaluate((body) => window.__michiPermissionAudit.write!(body), sseBody([
    { event: 'done', data: { stopReason: 'end_turn', turnId, seq: 0 } },
  ]));
  await expect(page.getByRole('button', { name: 'Permissions: Trust', exact: true })).toBeEnabled();
  await selectMode(page, 'Ask');
  expect(state.chatModes.map((entry) => entry.mode)).toEqual(['ask']);
  const settings = await openSettings(page);
  await settings.getByRole('switch', { name: 'Use global permissions' }).click();
  await expect.poll(() => state.settings.global).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Permissions:/ })).toHaveCount(0);
  const reopened = await openSettings(page);
  await reopened.getByRole('switch', { name: 'Use global permissions' }).click();
  await expect.poll(() => state.settings.global).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Permissions: Ask', exact: true })).toBeVisible();
});

test('Settings global switch hides Composer controls, saves the global mode, and restores the chat choice when disabled', async ({ page }) => {
  const state = await fixture(page);
  await selectMode(page, 'Trust');
  const settings = await openSettings(page);
  await settings.getByRole('switch', { name: 'Use global permissions' }).click();
  await expect.poll(() => state.settings.global).toBe(true);
  await settings.getByRole('button', { name: 'Permissions: Ask', exact: true }).click();
  await page.getByRole('menuitem', { name: /^YOLO\b/ }).click();
  await expect.poll(() => state.settings.mode).toBe('yolo');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Permissions:/ })).toHaveCount(0);
  const reopened = await openSettings(page);
  await reopened.getByRole('switch', { name: 'Use global permissions' }).click();
  await expect.poll(() => state.settings.global).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Permissions: Trust', exact: true })).toBeVisible();
});

for (const runtimeId of ['kiro', 'pi', 'claude', 'codex']) {
  test(`${runtimeId}: Home and chat permission menus expose the runtime's supported modes`, async ({ page }) => {
    await fixture(page, undefined, runtimeId);
    const supportsYolo = runtimeId === 'claude' || runtimeId === 'codex';
    await page.getByRole('button', { name: 'Permissions: Ask', exact: true }).click();
    await expect(page.getByRole('menuitem')).toHaveCount(supportsYolo ? 3 : 2);
    await expect(page.getByRole('menuitem', { name: /^YOLO\b/ })).toHaveCount(supportsYolo ? 1 : 0);
    await page.getByRole('menuitem', { name: /^Trust\b/ }).click();
    await expect(page.getByRole('button', { name: 'Permissions: Trust', exact: true })).toBeVisible();
    await send(page);
    await finishTurn(page);
    await page.getByRole('button', { name: 'Permissions: Trust', exact: true }).click();
    await expect(page.getByRole('menuitem')).toHaveCount(supportsYolo ? 3 : 2);
    await expect(page.getByRole('menuitem', { name: /^YOLO\b/ })).toHaveCount(supportsYolo ? 1 : 0);
  });
}

for (const runtimeId of ['kiro', 'pi']) {
  test(`${runtimeId}: global settings show legacy YOLO as Trust and offer only Ask / Trust`, async ({ page }) => {
    const state = await fixture(page, { global: true, mode: 'yolo' }, runtimeId);
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Permissions: Trust', exact: true }).click();
    await expect(page.getByRole('menuitem')).toHaveCount(2);
    await expect(page.getByRole('menuitem', { name: /^Trust\b/ })).toContainText('✓');
    await expect(page.getByRole('menuitem', { name: /^YOLO\b/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: /^Ask\b/ }).click();
    await expect.poll(() => state.settings.mode).toBe('ask');
  });
}

test('a mixed Backend keeps global YOLO for Claude/Codex while Pi chat controls only offer Ask / Trust', async ({ page }) => {
  await fixture(page, { global: false, mode: 'yolo' }, 'pi', ['pi', 'kiro', 'claude', 'codex']);
  await page.getByRole('button', { name: 'Permissions: Ask', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(2);
  await page.keyboard.press('Escape');
  const settings = await openSettings(page);
  await settings.getByRole('switch', { name: 'Use global permissions' }).click();
  await settings.getByRole('button', { name: 'Permissions: YOLO', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^YOLO\b/ })).toBeVisible();
});

test('a YOLO draft becomes Trust when switched to Pi and sends the displayed mode', async ({ page }) => {
  const state = await fixture(page, undefined, 'codex', ['codex', 'pi']);
  await selectMode(page, 'YOLO');
  const settings = await openSettings(page);
  await settings.getByRole('combobox').selectOption('pi');
  await expect.poll(() => state.runtimeId).toBe('pi');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Permissions: Trust', exact: true })).toBeVisible();
  await send(page);
  expect(state.ensureBodies[0].permissionMode).toBe('trust');
  await finishTurn(page);
  await page.getByRole('button', { name: 'Permissions: Trust', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(2);
});

test('an existing Codex chat keeps YOLO after the default runtime switches to Pi', async ({ page }) => {
  await fixture(page, undefined, 'codex', ['codex', 'pi']);
  await selectMode(page, 'YOLO');
  await send(page);
  await finishTurn(page);
  const settings = await openSettings(page);
  await settings.getByRole('combobox').selectOption('pi');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Permissions: YOLO', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Permissions: YOLO', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(3);
});
