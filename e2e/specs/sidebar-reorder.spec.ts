import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

// Persistent workspace ordering — commit 27e17c9.
// WorkspaceRow renders <div data-testid="workspace-row-${project.id}"> at the
// drag root, so we can locate rows deterministically without relying on
// duplicated name text.
//
// Two open questions remain before this can flip from .fixme() to green:
//
//   1. The exact shape the mock must return from GET /api/workspaces —
//      workspacePersistence.ts unions several fields and runs a migration.
//      Easiest is probably driving NewWorkspaceDialog twice via UI to seed
//      two rows, rather than mocking the persistence payload.
//   2. Playwright's `dragTo` dispatches HTML5 drag events; React handlers
//      sometimes ignore the synthetic dataTransfer. Fallback: dispatch
//      dragstart / dragover / drop manually via page.evaluate.

test.describe('sidebar reorder', () => {
  test.fixme('dragging workspace B above A reorders + persists across reload', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/');

    // TODO: seed two workspaces (either via mock payload once we pin the
    // shape, or by clicking through NewWorkspaceDialog twice).

    const rows = page.locator('[data-testid^="workspace-row-"]');
    await rows.first().waitFor();
    const [src, dst] = [rows.nth(1), rows.first()];
    await src.dragTo(dst);

    const orderAfter = await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid'))
    );
    expect(orderAfter[0]).not.toBe(orderAfter[1]); // sanity placeholder

    await page.reload();
    const orderReloaded = await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid'))
    );
    expect(orderReloaded).toEqual(orderAfter);
  });
});
