import { test, expect } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { KIRO_DESCRIPTOR } from '../../backend/src/agents/capabilityDescriptors';

for (const accepted of [true, false]) {
  test(`Kiro native Steer ${accepted ? 'keeps accepted input as a Steered message' : 'retains rejected input'} without a second turn`, async ({ page }, info) => {
    const steers: string[] = [];
    let releaseSteer!: () => void;
    const steerGate = new Promise<void>((resolve) => { releaseSteer = resolve; });
    await installMockApi(page, { custom: async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/agent/status')) {
        await route.fulfill({ json: { runtime: 'kiro', label: 'Kiro', hasRequiredKey: true,
          capabilities: { modes: false, permissions: true, models: false, reasoning: false },
          capabilityDescriptor: KIRO_DESCRIPTOR, availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }],
        } });
        return true;
      }
      if (url.pathname.endsWith('/steer')) {
        const body = route.request().postDataJSON();
        steers.push(body.text);
        await steerGate;
        const message = { messageId: 'accepted-steer', assistantId: 'steer-assistant', turnId: 'steer-turn',
          text: body.displayText, userMetadata: body.userMetadata, queueId: body.queueId, createdAt: Date.now(), pending: true };
        if (accepted) {
          // Live acknowledgement may arrive before the HTTP response, then replay.
          await page.evaluate((data) => {
            const frame = `event: steer_accepted\ndata: ${JSON.stringify({ ...data, seq: 2 })}\n\n`;
            (window as any).__steerFrame(frame + frame);
          }, message);
        }
        await route.fulfill({ json: { accepted, ...(accepted ? { pending: true, message } : { reason: 'no_active_turn' }) } });
        return true;
      }
      return false;
    } });
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      (window as any).__kiroTurns = 0;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/chats\/[^/]+\/message$/.test(url)) {
          (window as any).__kiroTurns++;
          const encoder = new TextEncoder();
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(encoder.encode('event: turn_start\ndata: {"turnId":"steer-turn","assistantId":"steer-assistant","userText":"Start a Kiro turn","seq":0}\n\n'));
            controller.enqueue(encoder.encode('event: chunk\ndata: {"text":"Kiro is working on the current turn."}\n\n'));
            (window as any).__steerFrame = (frame: string) => controller.enqueue(encoder.encode(frame));
            (window as any).__finishKiro = () => {
              controller.enqueue(encoder.encode('event: usage_summary\ndata: {"totalCredits":0.12,"source":"kiro-v3"}\n\nevent: done\ndata: {"stopReason":"end_turn"}\n\n'));
              controller.close();
            };
          } }), { headers: { 'content-type': 'text/event-stream' } });
        }
        return original(input, init);
      };
    });
    await bootWithWorkspace(page, 'Kiro ACP validation');
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.fill('Start a Kiro turn');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    await expect(page.getByText('Kiro is working on the current turn.').first()).toBeVisible();
    await editor.fill('Please focus on the native fork behavior');
    await page.getByRole('button', { name: /^Send next/ }).click();
    await expect(page.getByRole('button', { name: 'Steer now', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('kiro-steer-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    const button = page.getByRole('button', { name: 'Steer now', exact: true });
    const bounds = await button.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    await page.screenshot({ path: info.outputPath('kiro-steer-mobile.png'), animations: 'disabled' });
    await button.click();
    await expect.poll(() => steers.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Steering…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Dequeue message', exact: true })).toBeDisabled();
    releaseSteer();
    expect(steers[0]).toContain('Please focus on the native fork behavior');
    if (accepted) await expect(button).toHaveCount(0);
    else {
      await expect(button).toBeEnabled();
      await expect(page.getByText('Steer was not accepted. The message remains queued.')).toBeVisible();
      await expect(page.locator('.terminal-message-steered')).toHaveCount(0);
    }
    expect(await page.evaluate(() => (window as any).__kiroTurns)).toBe(1);
    if (accepted) {
      const bubble = page.locator('.terminal-message-user').filter({ hasText: 'Please focus on the native fork behavior' });
      await expect(bubble).toHaveCount(1);
      await expect(bubble.getByText('Steered', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop stream', exact: true })).toBeVisible();
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(bubble).toBeVisible();
        expect(await bubble.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`steered-message-${width}.png`), animations: 'disabled' });
      }
      await page.evaluate(() => (window as any).__finishKiro());
      await expect(page.getByRole('button', { name: 'Stop stream', exact: true })).toHaveCount(0);
      await expect(page.getByText(/0.12 credits/).first()).toBeVisible();
      await expect(page.getByText(/NaN|undefined credits/)).toHaveCount(0);
    }
  });
}

test('Steered user messages survive workspace hydration and reload', async ({ page }) => {
  const workspace = {
    workspace: { id: 'steered-ws', name: 'Steered history', active_tree_id: 'steered-tree', created_at: 1 },
    trees: [{ id: 'steered-tree', workspace_id: 'steered-ws', root_node_id: 'steered-node', name: 'Colors', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'steered-node', workspace_id: 'steered-ws', tree_id: 'steered-tree', kind: 'chat', title: 'Colors', runtime_id: 'kiro', status: 'idle', created_at: 1 }],
    edges: [], contexts: [], messages: [
      { id: 'user', node_id: 'steered-node', role: 'user', seq: 0, content: 'Pick a color' },
      { id: 'steer', node_id: 'steered-node', role: 'user', seq: 1, content: 'Use cobalt', metadata: JSON.stringify({ steered: true, quotedText: 'Color choice' }) },
      { id: 'answer', node_id: 'steered-node', role: 'assistant', seq: 2, content: 'Cobalt is selected.' },
    ],
  };
  await installMockApi(page, { workspaces: [workspace] });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
  await page.goto('/');
  for (let pass = 0; pass < 2; pass++) {
    await page.locator('.terminal-sidebar [data-sidebar-row="steered-node"]').click();
    const bubble = page.locator('.terminal-message-user').filter({ hasText: 'Use cobalt' });
    await expect(bubble).toHaveCount(1);
    await expect(bubble.getByText('Steered', { exact: true })).toBeVisible();
    await expect(bubble).toContainText('Color choice');
    await expect(page.locator('.terminal-message-steered')).toHaveCount(1);
    await expect(page.locator('.terminal-message-assistant')).toContainText('Cobalt is selected.');
    if (pass === 0) await page.reload();
  }
});

for (const status of [200, 403, 409]) {
  test(`Kiro compact ${status === 200 ? 'works without an exclusive window token' : `does not fall through after HTTP ${status}`}`, async ({ page }) => {
    const compacts: Array<{ instructions?: string }> = [];
    let messageCount = 0;
    let commandCount = 0;
    await installMockApi(page, { custom: async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'POST') return false;
      if (url.pathname.endsWith('/message')) messageCount++;
      if (url.pathname.endsWith('/command')) commandCount++;
      if (url.pathname.endsWith('/compact')) {
        const body = route.request().postDataJSON();
        compacts.push(body);
        await route.fulfill({ status,
          json: status === 403 ? { started: false, error: 'not authorized' }
            : status === 409 ? { started: false, detail: 'Cannot compact an active Kiro session' }
              : { started: true } });
        return true;
      }
      return false;
    } });
    await bootWithWorkspace(page, 'Kiro compact authorization');
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.fill('Start a Kiro turn');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    await expect(page.getByText(/Hello from mock kiro/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop stream', exact: true })).toHaveCount(0);
    await editor.fill('/compact preserve the project name');
    const response = page.waitForResponse((res) => res.url().endsWith('/compact'));
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    expect((await response).status()).toBe(status);
    expect(compacts).toEqual([{ instructions: 'preserve the project name' }]);
    if (status === 403) await expect(page.getByText('not authorized')).toBeVisible();
    if (status === 409) await expect(page.getByText('Cannot compact an active Kiro session')).toBeVisible();
    await expect(editor).toBeEmpty();
    expect(messageCount).toBe(1);
    expect(commandCount).toBe(0);
  });
}
