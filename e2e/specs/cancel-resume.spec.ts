import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace, sseBody } from '../fixtures/mockApi';

// AGENTS.md calls out a specific bug class:
//   "at the start of every prompt() call, the session queue is drained and
//    any previous in-flight session/prompt RPC is awaited. Without this, stale
//    chunks from a cancelled turn leak into the next turn's stream."
//
// We can't reproduce the *backend* drain logic from the frontend side, but we
// CAN regression-test the frontend half: that cancel actually aborts the
// fetch, and that a follow-up message starts a fresh stream rather than
// inheriting state from the cancelled one.

test.describe('cancel + resume', () => {
  test('cancel mid-stream → next message produces a clean reply', async ({ page }) => {
    let messageCalls = 0;

    // installMockApi MUST go first — Playwright matches routes in reverse
    // registration order, so the more specific message-route below shadows
    // the catch-all `**/api/**` glob. If we registered it the other way
    // round, the catch-all (defaultTurn) would intercept and the stream
    // would complete in milliseconds, leaving the Stop button a flicker.
    await installMockApi(page);
    await page.route('**/api/chats/*/message', async (route) => {
      messageCalls += 1;
      if (messageCalls === 1) {
        // First turn: never fulfill. The frontend's AbortController will tear
        // down this fetch when the user clicks Stop. Sleeping past the test
        // timeout is fine — Playwright tears down pending routes at end.
        await new Promise((r) => setTimeout(r, 120_000));
        // Unreachable in a green run; if reached, the abort never happened.
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseBody([
            { event: 'chunk', data: { text: 'STALE — should not appear' } },
            { event: 'done', data: { stopReason: 'end_turn' } },
          ]),
        });
      } else {
        // Second turn: respond fast with a clean message.
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseBody([
            { event: 'chunk', data: { text: 'FRESH reply after cancel' } },
            { event: 'done', data: { stopReason: 'end_turn' } },
          ]),
        });
      }
    });

    await bootWithWorkspace(page);

    // Fire first turn, then stop while it's still streaming.
    const composer = page.locator('textarea').first();
    await composer.click();
    await page.keyboard.type('start the long turn');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();

    // While streaming with an empty composer, the primary button morphs from
    // "Send (Enter)" to "Stop stream" (TPane.tsx aria-label switch on sendMode).
    const stopBtn = page.getByRole('button', { name: /Stop stream/ });
    await stopBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await stopBtn.click();

    // Now send a second turn — should produce a clean reply.
    await composer.click();
    await page.keyboard.type('second turn');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();

    await expect(page.getByText('FRESH reply after cancel')).toBeVisible({ timeout: 6_000 });

    // Negative assertion: STALE chunk must never render.
    await expect(page.getByText('STALE — should not appear')).toHaveCount(0);
  });
});
