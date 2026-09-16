import { expect, test, type Page } from '@playwright/test';
import {
  createPanePresenceMockController,
  installMockApi,
  type PanePresenceMockController,
} from '../fixtures/mockApi';

/**
 * P3-7 gap #3 (design §9, §10; brief's usePanePresenceIntegration.ts). Two Playwright PAGES in
 * the SAME BrowserContext: they share `localStorage` (same-origin storage partition) but each
 * gets its OWN `sessionStorage` — which is exactly what backs two distinct real browser windows
 * observing the same workspace, per `chatStore.tsx`'s `resolveWindowId()` (reads/writes a
 * `sessionStorage`-cached UUID) and `paneState.ts`'s own `sessionStorage`-backed open-pane/focus
 * maps. Seeding via `page.addInitScript` + `localStorage.setItem('michi:v1:state', ...)` is
 * established prior art in this codebase (see e2e/specs/branches.spec.ts's own `seed()`) — it
 * sidesteps the fact that `createProject` mints a client-side-random project id with no reliable
 * way to make two independently-dialog-driven pages converge on one workspace.
 */

const PROJECT_ID = 'presence-ws';
const TREE_ID = 'presence-tree';
const NODE_ID = 'presence-root';
const NODE_TITLE = 'Presence pane';
const BASE_T = 1_782_000_000_000;

function savedState() {
  return {
    version: 6,
    activeProjectId: PROJECT_ID,
    projects: [{
      id: PROJECT_ID,
      name: 'Presence workspace',
      chatIds: [NODE_ID],
      edges: [],
      trees: [{ id: TREE_ID, rootNodeId: NODE_ID, name: NODE_TITLE, createdAt: BASE_T, lastActiveAt: BASE_T }],
      activeTreeId: TREE_ID,
      contexts: [],
      createdAt: BASE_T,
    }],
    nodes: {
      [NODE_ID]: {
        nodeId: NODE_ID,
        kind: 'chat',
        chatId: `mock-${NODE_ID}`,
        runtimeId: 'mock',
        projectId: PROJECT_ID,
        messages: [],
        followUps: [],
        title: NODE_TITLE,
        status: 'idle',
      },
    },
  };
}

/** Seeds shared `localStorage` (same workspace/tree/node for every page in the context) plus
 *  THIS page's own `sessionStorage` open-pane/focus entry for the tree — each page gets an
 *  independent `sessionStorage`, so calling this once per page is what gives each one its own
 *  renderer session state while still landing in the identical workspace. Prefs (sidebarExpanded)
 *  are seeded too so the sidebar row is immediately visible without extra clicks — matching
 *  `sidebar-navigation.spec.ts`'s own established seeding pattern. */
async function seedSharedWorkspace(page: Page) {
  await page.addInitScript(({ state, slotKey, nodeId, projectId, treeId }) => {
    window.localStorage.setItem('michi:migrated', '1');
    window.localStorage.setItem('michi:v1:state', JSON.stringify(state));
    window.localStorage.setItem('michi:v1:prefs', JSON.stringify({
      sidebarCollapsed: false, onboardingCompletedAt: 1,
      sidebarExpanded: { workspaces: { [projectId]: true }, threads: { [treeId]: true }, branches: {} },
    }));
    // Seeded so the app boots straight to Home (page state is never persisted — see this file's
    // own module doc comment) with the sidebar already showing the thread row; the pane itself
    // is opened via a real sidebar click below, not by presuming this map alone routes to
    // Dashboard.
    window.sessionStorage.setItem('michi:panes:open', JSON.stringify({ [slotKey]: [nodeId] }));
    window.sessionStorage.setItem('michi:panes:focus', JSON.stringify({ [slotKey]: nodeId }));
  }, { state: savedState(), slotKey: `${PROJECT_ID}::${TREE_ID}`, nodeId: NODE_ID, projectId: PROJECT_ID, treeId: TREE_ID });
}

/** Opens the pane via the real sidebar row click (proven pattern from
 *  e2e/specs/sidebar-navigation.spec.ts) rather than presuming the seeded `sessionStorage`
 *  open-pane map alone routes the app to the Dashboard page — `page` (home/dashboard/...) is
 *  plain `useState('home')` in TerminalShell.tsx, never persisted or derived from it. */
async function openPaneFromSidebar(page: Page) {
  await page.locator('.terminal-sidebar').getByText(NODE_TITLE, { exact: true }).first().click();
  await expect(page.locator('.terminal-dashboard > [data-node-id]').first()).toBeVisible({ timeout: 10_000 });
}

/** Waits until the presence controller has recorded exactly `count` PUT submissions carrying a
 *  non-empty view list (i.e. real "pane is open" submissions, not the empty-snapshot case) —
 *  used instead of a fixed sleep because the reporter's first submission fires from a `useEffect`
 *  after hydration, not synchronously on `goto`. */
async function waitForNonEmptySubmits(controller: PanePresenceMockController, count: number) {
  await expect.poll(() => new Set(controller.submitCalls.filter((c) => c.viewCount > 0).map((c) => c.rendererLeaseId)).size).toBeGreaterThanOrEqual(count);
}

test.describe('pane presence — two windows on one workspace', () => {
  test('two pages opening the same pane get distinct leases and coexist', async ({ browser }, testInfo) => {
    const controller = createPanePresenceMockController();
    const context = await browser.newContext();
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await seedSharedWorkspace(page1);
    await seedSharedWorkspace(page2);
    await installMockApi(page1, { custom: (route) => controller.handle(route) });
    await installMockApi(page2, { custom: (route) => controller.handle(route) });

    await page1.goto('/');
    await openPaneFromSidebar(page1);
    await waitForNonEmptySubmits(controller, 1);

    await page2.goto('/');
    await openPaneFromSidebar(page2);
    await waitForNonEmptySubmits(controller, 2);

    // Both windowIds differ (independent sessionStorage per page) and both leases are live —
    // proving two renderer instances observing the same pane do NOT collapse into one lease.
    const live = controller.liveLeases();
    expect(live).toHaveLength(2);
    const [lease1, lease2] = live;
    expect(lease1.rendererLeaseId).not.toBe(lease2.rendererLeaseId);
    expect(lease1.windowId).not.toBe(lease2.windowId);
    // Both leases report the SAME open pane (the one shared workspace/node) — coexistence, not
    // two different objects that happen to both exist.
    expect(lease1.paneIds).toEqual([`node:${NODE_ID}`]);
    expect(lease2.paneIds).toEqual([`node:${NODE_ID}`]);

    await page1.screenshot({ path: testInfo.outputPath('pane-window-1.png'), fullPage: true });
    await page2.screenshot({ path: testInfo.outputPath('pane-window-2.png'), fullPage: true });

    await context.close();
  });

  test('closing the pane sends DELETE with no chat/run cancel; reload mints a fresh lease', async ({ browser }) => {
    const controller = createPanePresenceMockController();
    const context = await browser.newContext();
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await seedSharedWorkspace(page1);
    await seedSharedWorkspace(page2);
    await installMockApi(page1, { custom: (route) => controller.handle(route) });
    await installMockApi(page2, { custom: (route) => controller.handle(route) });

    await page1.goto('/');
    await openPaneFromSidebar(page1);
    await waitForNonEmptySubmits(controller, 1);
    const page1LeaseId = controller.submitCalls[0].rendererLeaseId;

    await page2.goto('/');
    await openPaneFromSidebar(page2);
    await waitForNonEmptySubmits(controller, 2);

    expect(controller.liveLeases()).toHaveLength(2);

    // Close page1's ONLY pane via the real close button (PaneCaption.tsx's
    // `aria-label={`Close ${title}`}`) rather than `page.close()` — this is the reliable,
    // synchronous-effect-driven lifecycle path (`wentAway` in usePanePresenceReporter.ts), NOT
    // the best-effort `beforeunload` handler. `page.close()` firing an async unload fetch is
    // NOT something Playwright/the browser guarantees, so this test deliberately does not rely
    // on it for the DELETE assertion — see this file's own module doc comment.
    //
    // Close via the real ⌘W shortcut (TerminalShell.tsx: `if (meta && ... key === 'w') {
    // closePane(focusedPane) }`) rather than the PaneCaption close button — that button is
    // `aria-hidden` until its caption chip is hovered (`PaneCaption.tsx`'s `aria-hidden={!hovered}`,
    // driven by local React `onMouseEnter` state), which makes a synthetic Playwright hover
    // ordering-sensitive. ⌘W is an equally real, user-reachable close path with none of that
    // hover-timing fragility, and it drives the exact same `closePane` callback either way.
    await page1.keyboard.press('Meta+w');
    await expect.poll(() => controller.removeCalls.length).toBeGreaterThanOrEqual(1);

    // Real backend semantics (backend/src/services/panePresence.ts's `removePresence`): a
    // paneIds-scoped DELETE only drops the NAMED views — it does not delete the lease itself,
    // even once it reaches zero panes. The lease survives (empty) until a full removal (no
    // `paneIds`) or TTL sweep; `usePanePresenceReporter.ts` deliberately never issues that full
    // removal from the "closed my last pane while still hydrated" path (see its own
    // `skipEmptyPut` comment — that guard is about avoiding an empty PUT, not about tearing the
    // lease down). So page1's lease stays live with an EMPTY paneIds list; page2's lease is
    // untouched and still open on the same pane.
    const leasesAfterClose = controller.liveLeases();
    const page1LeaseAfterClose = leasesAfterClose.find((l) => l.rendererLeaseId === page1LeaseId);
    expect(page1LeaseAfterClose?.paneIds).toEqual([]);
    const page2Lease = leasesAfterClose.find((l) => l.rendererLeaseId !== page1LeaseId);
    expect(page2Lease?.paneIds).toEqual([`node:${NODE_ID}`]);

    // Closing a pane must never cancel a chat/run — presence records views and nothing else
    // (design §9's own "关闭 view：更新登记；不调用 chat/run cancel").
    expect(controller.cancelCalls).toHaveLength(0);

    // Reload page1: a fresh page load always mints a brand-new in-memory lease (rendererLeaseId
    // lives only in a React ref per usePanePresenceReporter.ts — nothing persists it across a
    // reload), so this also re-proves "reload creates a fresh lease" without needing any special
    // reload-detection logic in the app itself. The pane was just closed above (which persists to
    // `sessionStorage` — `paneState.ts`'s `setOpenPanes` writes through on every change), so
    // page1 reopens it via the sidebar again after reload, exactly like a real user returning to
    // a thread post-refresh.
    const submitsBeforeReload = controller.submitCalls.length;
    const page2LeaseId = page2Lease!.rendererLeaseId;
    await page1.reload();
    await openPaneFromSidebar(page1);
    await expect.poll(() => controller.submitCalls.length).toBeGreaterThan(submitsBeforeReload);

    const newPage1Submit = controller.submitCalls
      .slice(submitsBeforeReload)
      .find((call) => call.viewCount > 0 && call.rendererLeaseId !== page2LeaseId);
    expect(newPage1Submit).toBeDefined();
    expect(newPage1Submit!.rendererLeaseId).not.toBe(page1LeaseId);

    const leasesAfterReload = controller.liveLeases();
    expect(leasesAfterReload.find((lease) => lease.rendererLeaseId === newPage1Submit!.rendererLeaseId)?.paneIds)
      .toEqual([`node:${NODE_ID}`]);
    // page2's lease is completely unaffected. The old page1 lease may already have been removed
    // by beforeunload, or may remain empty until TTL if the browser aborted that best-effort
    // request during navigation; neither outcome is allowed to affect the new lease or page2.
    expect(leasesAfterReload.find((lease) => lease.rendererLeaseId === page2LeaseId)?.paneIds)
      .toEqual([`node:${NODE_ID}`]);
    const oldPage1Lease = leasesAfterReload.find((lease) => lease.rendererLeaseId === page1LeaseId);
    if (oldPage1Lease) expect(oldPage1Lease.paneIds).toEqual([]);
    // Still never cancelled anything, even across the reload.
    expect(controller.cancelCalls).toHaveLength(0);

    await context.close();
  });
});
