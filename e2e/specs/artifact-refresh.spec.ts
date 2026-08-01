import { test, expect, type Route } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

// Artifact-pane live refresh (hermetic — mockApi intercepts all /api/**):
//   1. Open a file as an artifact pane via an internal markdown link.
//   2. The pane reads v1 content from disk.
//   3. Push an `artifact_changed` frame down the persistent watch EventSource.
//   4. The "● Changed on disk · refresh" badge appears (content is NOT auto-replaced).
//      (getByText locators below must stay byte-identical to the ArtifactPane label.)
//   5. Click the badge → the pane re-reads and swaps v1 → v2.
//
// EventSource needs a *pushable* stream: Playwright's route.fulfill sends a
// complete body then closes, so we HOLD the /watch/stream connection open
// (never fulfil on connect) and only fulfil it — with the change frame — once
// the test decides to "push". That avoids the race where a change delivered
// mid-initial-load gets cleared by the v1 `artifact-loaded`.

test.describe('artifact-pane live refresh', () => {
  test('badge appears on disk change and click re-reads the file', async ({ page }) => {
    let heldWatchRoute: Route | null = null;
    let readCount = 0;

    const readResult = (content: string) => ({
      content,
      path: 'notes.md',
      basename: 'notes.md',
      extension: 'md',
      size: content.length,
      modifiedAt: readCount,
    });

    await installMockApi(page, {
      // Assistant reply carries a relative link → clicking it opens an artifact
      // pane (TPane intercepts `michi:internal-link` → openArtifactPane).
      streamEvents: [
        { event: 'chunk', data: { text: 'See the file here: [open the notes file](notes.md)' } },
        { event: 'done', data: { stopReason: 'end_turn' } },
      ],
      custom: async (route: Route) => {
        const url = new URL(route.request().url());
        const path = url.pathname.replace(/^.*\/api/, '');
        const method = route.request().method();

        // Persistent watch stream — hold it open; the test pushes into it later.
        if (method === 'GET' && /^\/workspaces\/[^/]+\/watch\/stream$/.test(path)) {
          heldWatchRoute = route; // captured; deliberately NOT fulfilled here
          return true;
        }
        // Declare paths — best-effort; echo an empty accepted set.
        if (method === 'POST' && /^\/workspaces\/[^/]+\/watch$/.test(path)) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ watching: [] }),
          });
          return true;
        }
        // File read — v1 on the first read (mount), v2 on the refresh click.
        if (method === 'GET' && /^\/artifacts\/[^/]+\/read$/.test(path)) {
          readCount += 1;
          const content = readCount === 1 ? '# Version ONE' : '# Version TWO';
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(readResult(content)),
          });
          return true;
        }
        return false; // everything else → built-in mock handlers
      },
    });

    await bootWithWorkspace(page);

    // Turn 1: send a message; assistant reply contains the link.
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('show me the notes');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();

    // Open the artifact pane by clicking the internal link in the reply.
    const link = page.getByRole('link', { name: /open the notes file/i });
    await expect(link).toBeVisible({ timeout: 5_000 });
    await link.click();

    // Pane loads v1. (Rendered markdown → the "# Version ONE" heading text.)
    await expect(page.getByText('Version ONE')).toBeVisible({ timeout: 5_000 });
    // No badge yet — nothing has changed on disk.
    await expect(page.getByText('● Changed on disk · refresh')).toHaveCount(0);

    // Wait for the EventSource to have connected (route captured), then push.
    await expect.poll(() => heldWatchRoute !== null, { timeout: 5_000 }).toBe(true);
    await heldWatchRoute!.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache' },
      body:
        ': connected\n\n' +
        `event: artifact_changed\ndata: ${JSON.stringify({ filePath: 'notes.md' })}\n\n`,
    });

    // Badge appears; content is still v1 (never auto-replaced).
    const badge = page.getByText('● Changed on disk · refresh');
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Version ONE')).toBeVisible();

    // Click to reload → re-reads (readCount → 2) and swaps content to v2.
    await badge.click();
    await expect(page.getByText('Version TWO')).toBeVisible({ timeout: 5_000 });
    // Badge clears after a successful reload.
    await expect(page.getByText('● Changed on disk · refresh')).toHaveCount(0);
    expect(readCount).toBe(2);
  });
});
