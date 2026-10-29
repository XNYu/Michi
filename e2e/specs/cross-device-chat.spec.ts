import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

declare global {
  interface Window {
    crossDeviceFeed?: ReadableStreamDefaultController<Uint8Array>;
    crossDeviceSubscriptions: Array<{ cursors: Record<string, { turnId: string; seq: number }>; includeForeground: boolean }>;
  }
}

test('another device’s message streams into an open chat without refresh and reconnects without duplicates', async ({ page }) => {
  let nodeId = '';
  let sends = 0;
  await installMockApi(page, { custom: async (route) => {
    const match = /\/chats\/([^/]+)\/message$/.exec(new URL(route.request().url()).pathname);
    if (match) { nodeId = match[1]; sends++; }
    return false;
  } });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.crossDeviceSubscriptions = [];
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (url.pathname.endsWith('/chats/background/subscribe')) {
        window.crossDeviceSubscriptions.push(JSON.parse(String(init?.body)));
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          window.crossDeviceFeed = controller;
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  });
  await bootWithWorkspace(page);
  const composer = page.locator(COMPOSER_EDITOR).first();
  await composer.fill('Initial desktop message');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeVisible();
  await expect.poll(() => nodeId).not.toBe('');
  await composer.fill('My unsent desktop draft');
  await expect.poll(() => page.evaluate(() => !!window.crossDeviceFeed)).toBe(true);
  const envelope = { chatId: nodeId, nodeId, turnId: 'phone-turn', assistantId: 'phone-answer' };
  const frame = (event: string, seq: number, data: Record<string, unknown>) =>
    `event: foreground_event\ndata: ${JSON.stringify({ event, data: { ...envelope, seq, ...data } })}\n\n`;
  const start = frame('turn_start', 0, { userText: 'Message sent from my phone' });
  const chunk = frame('chunk', 1, { text: 'Live response from the phone turn.' });
  const done = frame('done', 2, { persisted: true, stopReason: 'end_turn' });
  await page.evaluate(body => window.crossDeviceFeed!.enqueue(new TextEncoder().encode(body)), start + chunk + chunk);
  await expect(page.locator('.terminal-message-user').getByText('Message sent from my phone', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Live response from the phone turn.', { exact: true })).toBeVisible();
  await expect(composer).toHaveText('My unsent desktop draft');
  await page.evaluate(body => { window.crossDeviceFeed!.enqueue(new TextEncoder().encode(body)); window.crossDeviceFeed!.close(); }, done);
  await expect.poll(() => page.evaluate(() => window.crossDeviceSubscriptions.length)).toBe(2);
  expect(await page.evaluate(() => window.crossDeviceSubscriptions.at(-1))).toMatchObject({
    includeForeground: true, cursors: { [nodeId]: { turnId: 'phone-turn', seq: 2 } },
  });
  await page.evaluate(body => window.crossDeviceFeed!.enqueue(new TextEncoder().encode(body)), start + chunk + done);
  await expect(page.locator('.terminal-message-user').getByText('Message sent from my phone', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Live response from the phone turn.', { exact: true })).toHaveCount(1);
  await expect(composer).toHaveText('My unsent desktop draft');
  expect(sends).toBe(1);
});
