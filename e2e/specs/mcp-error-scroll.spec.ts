import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi, sseBody } from '../fixtures/mockApi';

declare global {
  interface Window {
    mcpErrorTestStream?: ReadableStreamDefaultController<Uint8Array>;
  }
}

for (const width of [1280, 390]) {
  test(`MCP failures stay beside the reply without jumping over the spacer at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await installMockApi(page);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method === 'POST' && /^\/api\/chats\/[^/]+\/message$/.test(url.pathname)) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) { window.mcpErrorTestStream = controller; },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        return originalFetch(input, init);
      };
    });
    await bootWithWorkspace(page, 'MCP scroll regression');
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('Continue this task');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect.poll(() => page.evaluate(() => !!window.mcpErrorTestStream)).toBe(true);
    const scroller = page.locator('[data-node-id] .term-scrollbar').first();
    const userMessage = page.locator('[data-msg-id]').filter({ hasText: 'Continue this task' });
    await expect(userMessage).toBeVisible();
    // Let the initial send animation and its 700ms pin window settle.
    await page.waitForTimeout(900);
    const before = await scroller.evaluate(el => el.scrollTop);

    await page.evaluate(body => window.mcpErrorTestStream!.enqueue(new TextEncoder().encode(body)), sseBody([
      { event: 'mcp_server_error', data: { serverName: 'treg', error: 'MCP HTTP headers helper returned a reserved header' } },
    ]));
    const error = page.getByRole('alert');
    await expect(error).toContainText('reserved header');
    await page.waitForTimeout(300);
    expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - before)).toBeLessThan(3);
    await expect(userMessage).toBeVisible();

    const gap = await error.evaluate(el => {
      const previous = el.previousElementSibling!;
      return el.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
    expect(gap).toBeLessThan(32);

    await page.evaluate(body => window.mcpErrorTestStream!.enqueue(new TextEncoder().encode(body)), sseBody([
      { event: 'chunk', data: { text: 'The task can continue while this MCP server is unavailable.' } },
      { event: 'mcp_server_error', data: {
        serverName: 'treg',
        error: `MCP startup failed: ${'Transport::StreamableHttpClientWorker::'.repeat(12)} MCP HTTP headers helper returned a reserved header`,
      } },
    ]));
    await expect(page.getByText('The task can continue while this MCP server is unavailable.')).toBeVisible();
    await expect(error).toContainText('StreamableHttpClientWorker');
    expect(await error.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await scroller.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(error.getByRole('button', { name: 'Dismiss' })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`mcp-error-${width}.png`), animations: 'disabled' });
    await error.getByRole('button', { name: 'Dismiss' }).click();
    await expect(error).toHaveCount(0);

    await page.evaluate(body => {
      window.mcpErrorTestStream!.enqueue(new TextEncoder().encode(body));
      window.mcpErrorTestStream!.close();
    }, sseBody([{ event: 'done', data: { stopReason: 'end_turn' } }]));
    await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
  });
}
