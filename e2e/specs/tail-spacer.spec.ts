import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi, sseBody, type SseEvent } from '../fixtures/mockApi';

declare global {
  interface Window {
    tailSpacerTestStream?: ReadableStreamDefaultController<Uint8Array>;
  }
}

for (const width of [1280, 390]) {
  test(`reply space shrinks with rendered tools and text at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installMockApi(page);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method === 'POST' && /^\/api\/chats\/[^/]+\/message$/.test(url.pathname)) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) { window.tailSpacerTestStream = controller; },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        return originalFetch(input, init);
      };
    });
    await bootWithWorkspace(page, 'Tail space regression');
    const send = async (text: string) => {
      await page.locator('[contenteditable="true"]').first().fill(text);
      await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
      await expect.poll(() => page.evaluate(() => !!window.tailSpacerTestStream)).toBe(true);
    };
    const emit = async (events: SseEvent[], close = false) => {
      await page.evaluate(({ body, close }) => {
        window.tailSpacerTestStream!.enqueue(new TextEncoder().encode(body));
        if (close) {
          window.tailSpacerTestStream!.close();
          window.tailSpacerTestStream = undefined;
        }
      }, { body: sseBody(events), close });
    };
    // Existing history makes it possible to place a new user message at 30%.
    await send('Build some history');
    await emit([
      { event: 'chunk', data: { text: Array.from({ length: 36 }, (_, i) => `History paragraph ${i}.`).join('\n\n') } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ], true);
    await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
    await expect(page.getByText('History paragraph 35.', { exact: true })).toBeVisible();

    await send('Continue with a tool');
    const scroller = page.locator('[data-node-id] .term-scrollbar').first();
    const spacer = scroller.locator('[data-tail-spacer]');
    const user = scroller.locator('[data-msg-id]').filter({ hasText: 'Continue with a tool' });
    const anchorFraction = () => user.evaluate(el => {
      const scroll = el.closest('.term-scrollbar')!;
      return (el.getBoundingClientRect().top - scroll.getBoundingClientRect().top) / scroll.clientHeight;
    });
    await expect.poll(anchorFraction).toBeCloseTo(0.3, 1);
    const initialHeight = await spacer.evaluate(el => el.getBoundingClientRect().height);
    expect(initialHeight).toBeGreaterThan(100);

    await emit([{ event: 'tool_call', data: { toolCallId: 'write-1', title: 'Write', status: 'in_progress', kind: 'edit' } }]);
    await expect(scroller.getByText('Edit', { exact: true })).toBeVisible();
    await expect.poll(() => spacer.evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(initialHeight - 10);

    // At the manual scroll limit, the user stays at the intended anchor;
    // there is no additional composer-height-sized stretch of empty space.
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(anchorFraction).toBeCloseTo(0.3, 1);

    await page.setViewportSize({ width, height: 700 });
    await expect.poll(() => spacer.evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(initialHeight - 100);

    // Fewer than 1500 answer characters can still fill the entire viewport.
    await emit([{ event: 'chunk', data: { text: Array.from({ length: 32 }, (_, i) => `Reply paragraph ${i}.`).join('\n\n') } }]);
    await expect.poll(() => spacer.evaluate(el => el.getBoundingClientRect().height)).toBe(0);
    // A zero spacer can precede the final paced text frame. Measure the
    // settled reply after all paragraphs have rendered.
    await expect(scroller.getByText('Reply paragraph 31.', { exact: true })).toBeVisible();
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => spacer.evaluate(el => {
      const scroll = el.closest('.term-scrollbar') as HTMLElement;
      const contentBottom = el.getBoundingClientRect().top;
      return Math.abs(scroll.getBoundingClientRect().bottom - contentBottom - parseFloat(getComputedStyle(scroll).paddingBottom));
    })).toBeLessThan(3);

    await emit([{ event: 'done', data: { stopReason: 'end_turn' } }], true);
    await expect(spacer).toHaveCount(0);
  });
}
