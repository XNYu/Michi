import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

for (const runtime of ['Kiro', 'Codex', 'Claude']) {
for (const outcome of ['failure', 'success']) {
test(`${runtime} native recovery is visible before the first token and ${outcome} clears the status`, async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript((runtime) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/chats/') && url.endsWith('/message')) {
        const encoder = new TextEncoder();
        const body = new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode(`event: retry_start\ndata: ${JSON.stringify({ detail: `Restoring original ${runtime} session` })}\n\n`));
          (window as any).__failRecovery = () => {
            controller.enqueue(encoder.encode('event: error\ndata: {"message":"Original session retained. Retry after the other task finishes."}\n\n'));
            controller.close();
          };
          (window as any).__completeRecovery = () => {
            controller.enqueue(encoder.encode('event: retry_end\ndata: {}\n\nevent: chunk\ndata: {"text":"Continued on the original native session."}\n\nevent: done\ndata: {"stopReason":"end_turn"}\n\n'));
            controller.close();
          };
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return original(input, init);
    };
  }, runtime);
  await bootWithWorkspace(page);
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.fill('Continue with the original session');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  const status = page.getByRole('status', { name: new RegExp(`Restoring original ${runtime} session`) });
  await expect(status).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(status).toBeVisible();
    // ResizeObserver/React layout can settle after setViewportSize resolves.
    await expect.poll(async () => {
      const bounds = await status.boundingBox();
      return bounds ? bounds.x + bounds.width : Infinity;
    }).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `/tmp/michi-${runtime.toLowerCase()}-recovery-${outcome}-${width}.png`, animations: 'disabled' });
  }
  await page.evaluate((outcome) => outcome === 'success'
    ? (window as any).__completeRecovery() : (window as any).__failRecovery(), outcome);
  await expect(status).toHaveCount(0);
  await expect(page.getByText(outcome === 'success'
    ? 'Continued on the original native session.'
    : 'Original session retained. Retry after the other task finishes.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
  await composer.fill('Retry when ready');
  await expect(composer).toHaveText('Retry when ready');
});
}
}
