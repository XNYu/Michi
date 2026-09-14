import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

test('native recovery is visible before the first token and failure leaves a usable composer', async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/chats/') && url.endsWith('/message')) {
        const encoder = new TextEncoder();
        const body = new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode('event: retry_start\ndata: {"detail":"Restoring original Kiro session"}\n\n'));
          (window as any).__failRecovery = () => {
            controller.enqueue(encoder.encode('event: error\ndata: {"message":"Original session retained. Retry after the other task finishes."}\n\n'));
            controller.close();
          };
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return original(input, init);
    };
  });
  await bootWithWorkspace(page);
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.fill('Continue with the original session');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  const status = page.getByRole('status', { name: /Restoring original Kiro session/ });
  await expect(status).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(status).toBeVisible();
    const bounds = await status.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `/tmp/michi-kiro-recovery-${width}.png`, animations: 'disabled' });
  }
  await page.evaluate(() => (window as any).__failRecovery());
  await expect(status).toHaveCount(0);
  await expect(page.getByText('Original session retained. Retry after the other task finishes.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
  await composer.fill('Retry when ready');
  await expect(composer).toHaveText('Retry when ready');
});
