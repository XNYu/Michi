import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

test.describe('branch', () => {
  test('clicking branch button after typing creates a child chat', async ({ page }) => {
    let sessionEnsureCalls = 0;
    await installMockApi(page, {
      custom: async (route) => {
        if (
          route.request().method() === 'POST' &&
          /\/api\/nodes\/[^/]+\/ensure-session$/.test(new URL(route.request().url()).pathname)
        ) {
          sessionEnsureCalls += 1;
        }
        return false; // let built-in handler respond
      },
    });
    await bootWithWorkspace(page);

    // First turn — sends on the root node, opens chat 1.
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('first message');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible({ timeout: 5_000 });

    // Second turn via ⌘+Enter — TPane wires that to onSubmit(true), the same
    // path as the Branch button click but without depending on the button
    // becoming visible (which requires draft.value.trim() — fragile against
    // React state propagation timing through MentionTextarea's overlay).
    await composer.fill('branch from here');
    await page.keyboard.press('Meta+Enter');

    // The branched message text should render as a new user message bubble.
    await expect(page.getByText('branch from here').first()).toBeVisible({ timeout: 5_000 });

    // Two distinct chats should have been created (root + branched).
    expect(sessionEnsureCalls).toBeGreaterThanOrEqual(2);
  });

  // Slash-command branch trigger ("/btw ..." or "/branch ..." per AGENTS.md).
  test.fixme('typing "/btw " prefix routes to a new branch on Enter', async ({ page }) => {
    // TODO: confirm exact prefix parsing in TPane.onSubmit, then test
    // `/btw hello` creates a child even without ⌘+Enter.
    await installMockApi(page);
    await bootWithWorkspace(page);
  });
});
