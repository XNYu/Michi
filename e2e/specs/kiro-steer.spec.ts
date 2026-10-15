import { test, expect } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { KIRO_DESCRIPTOR } from '../../backend/src/agents/capabilityDescriptors';

for (const accepted of [true, false]) {
  test(`Kiro native Steer ${accepted ? 'removes accepted input' : 'retains rejected input'} without a second turn`, async ({ page }, info) => {
    const steers: string[] = [];
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
        steers.push(route.request().postDataJSON().text);
        await route.fulfill({ json: { accepted, ...(accepted ? { pending: true } : { reason: 'no_active_turn' }) } });
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
            controller.enqueue(encoder.encode('event: chunk\ndata: {"text":"Kiro is working on the current turn."}\n\n'));
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
    expect(steers[0]).toContain('Please focus on the native fork behavior');
    if (accepted) await expect(button).toHaveCount(0);
    else await expect(button).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__kiroTurns)).toBe(1);
    if (accepted) {
      await page.evaluate(() => (window as any).__finishKiro());
      await expect(page.getByRole('button', { name: 'Stop stream', exact: true })).toHaveCount(0);
      await expect(page.getByText(/0.12 credits/).first()).toBeVisible();
      await expect(page.getByText(/NaN|undefined credits/)).toHaveCount(0);
    }
  });
}

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
