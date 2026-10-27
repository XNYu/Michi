import { test, expect, type Page, type Route } from '@playwright/test';
import type { BackgroundSubagentsEndedV1, BackgroundSubagentsUpdateV1, SubagentInfo } from '../../shared/src';
import { SUBAGENT_SESSION_ENDED_ERROR, SUBAGENT_UNTRACKED_ERROR } from '../../shared/src/subagents';
import { installMockApi } from '../fixtures/mockApi';

/**
 * Background subagent liveness, browser-side: a saved Claude chat whose
 * launch turn ended with its agent still in the background (no outcome
 * yet). The workflow-runs feed says which background agents a live agent
 * process still tracks: a `background_subagents` snapshot per connection,
 * then deltas. While the feed lists the agent, the pane badge and the
 * transcript line say it runs; once a delta drops it, the process that ran
 * it has ended and both read stopped. A feed that then disconnects keeps
 * that last word for agents started before the disconnect, so the stopped
 * agent does not light up again while the feed reconnects.
 */

const NODE = 'live-node';
const AGENT = 'toolu_bg';

const subagent: SubagentInfo = {
  sessionId: AGENT, parentToolCallId: AGENT, sessionName: 'Run the slow suite', agentName: 'Explore',
  initialQuery: 'Run the slow suite', description: 'Run the slow suite', status: 'terminated', background: true,
  group: '', dependsOn: [], prompt: 'Run the slow test suite and report failures.', source: 'claude',
  startedAt: Date.now() - 10 * 60_000,
};

const workspace = {
  workspace: { id: 'live-ws', name: 'Liveness', active_tree_id: 'live-tree', created_at: 1 },
  trees: [{ id: 'live-tree', workspace_id: 'live-ws', root_node_id: NODE, name: 'Slow suite', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: NODE, workspace_id: 'live-ws', tree_id: 'live-tree', kind: 'chat', title: 'Slow suite', runtime_id: 'claude', status: 'idle', created_at: 1 }],
  edges: [], contexts: [],
  messages: [
    { id: 'ask', node_id: NODE, role: 'user', seq: 1, content: 'Run the slow suite in the background.' },
    {
      id: 'answer', node_id: NODE, role: 'assistant', seq: 2, content: 'Started it in the background.',
      tool_calls: JSON.stringify([
        { id: AGENT, title: 'Agent', status: 'completed', kind: 'tool', detail: JSON.stringify({ subagent_type: 'Explore', description: 'Run the slow suite', run_in_background: true }) },
      ]),
      blocks: JSON.stringify([
        { id: 'b0', kind: 'tool', toolCallId: AGENT, section: 'answer', rawOffset: 0 },
        { id: 'b1', kind: 'answer', rawText: 'Started it in the background.' },
      ]),
      metadata: JSON.stringify({ subagents: [subagent] }),
    },
  ],
};

function liveness(update: BackgroundSubagentsUpdateV1): string {
  const envelope = { version: 1, event: 'background_subagents', run: null, backgroundSubagents: update, emittedAt: Date.now() };
  return `event: background_subagents\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function endedFrame(ended: BackgroundSubagentsEndedV1): string {
  const envelope = { version: 1, event: 'background_subagents_ended', run: null, backgroundSubagentsEnded: ended, emittedAt: Date.now() };
  return `event: background_subagents_ended\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * The feed, one body per connection (the mock cannot hold a stream open,
 * so each ends and the client reconnects): the first lists the agent; the
 * second, held until `releaseSecond`, lists it in its snapshot and then
 * drops it in a delta; later ones fail as an unreachable backend would.
 */
async function openChat(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let connections = 0;
  let releaseSecond!: () => void;
  const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const custom = async (route: Route): Promise<boolean> => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');
    const method = route.request().method();
    if (method === 'GET' && path === '/workflow-runs/subscribe') {
      connections += 1;
      const connection = connections;
      if (connection === 1) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: liveness({ snapshot: true, nodes: { [NODE]: [AGENT] } }),
        });
      } else if (connection === 2) {
        await second;
        // The page may be gone if the test failed before releasing it.
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: liveness({ snapshot: true, nodes: { [NODE]: [AGENT] } }) + liveness({ snapshot: false, nodes: { [NODE]: [] } }),
        }).catch(() => {});
      } else {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) }).catch(() => {});
      }
      return true;
    }
    if (path === '/workflow-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  };
  await installMockApi(page, { workspaces: [workspace], custom });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
  await page.goto('/');
  await page.locator(`.terminal-sidebar [data-sidebar-row="${NODE}"]`).click();
  const message = page.locator('[data-msg-id="answer"]');
  await expect(message).toBeVisible();
  return { message, errors, connections: () => connections, releaseSecond };
}

test('a background agent reads stopped once the feed stops listing it, and stays stopped while the feed reconnects', async ({ page }) => {
  const { message, errors, connections, releaseSecond } = await openChat(page);
  try {
    const badge = page.getByTestId('pane-background-work-badge');
    const delegation = message.getByTestId('subagent-card');
    // The default (card) chrome; a completed group may start collapsed.
    if (!(await delegation.isVisible())) await message.locator('button[data-toolgroup-header]').first().click();
    const line = delegation.getByTestId('subagent-summary');
    // (The line's hidden hint "Show in background work" is not its status.)
    const inBackground = /in background(?! work)/;

    // The first connection's snapshot listed the agent and the client is
    // reconnecting: its last word still says the agent runs.
    await expect.poll(connections).toBe(2);
    await expect(badge).toHaveText('◆1');
    await expect(badge).toHaveAttribute('aria-label', '1 subagent running. Show background work');
    await expect(line).toContainText('Explore');
    await expect(line).toHaveText(inBackground);

    // The second connection lists it in its snapshot, then a delta drops it:
    // the process that ran it ended before it reported back.
    releaseSecond();
    await expect(badge).toHaveCount(0);
    await expect(line).toContainText(SUBAGENT_UNTRACKED_ERROR.split('\n')[0]);
    await expect(line).toContainText('stopped');
    await expect(line).not.toHaveText(inBackground);

    // That connection ended too and the backend is unreachable now: the
    // agent started before the disconnect, so it stays stopped.
    await expect.poll(connections).toBeGreaterThanOrEqual(3);
    await expect(badge).toHaveCount(0);
    await expect(line).toContainText('stopped');
    await expect(line).not.toHaveText(inBackground);
    expect(errors).toEqual([]);
  } finally {
    releaseSecond();
  }
});

test('an agent the backend records as ended reads stopped with its reason, whatever the liveness feed still says', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let connections = 0;
  const custom = async (route: Route): Promise<boolean> => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');
    const method = route.request().method();
    if (method === 'GET' && path === '/workflow-runs/subscribe') {
      connections += 1;
      // Every connection still lists the agent as live; only the first
      // carries its end. The end alone must stop it, and keep it stopped.
      const body = liveness({ snapshot: true, nodes: { [NODE]: [AGENT] } })
        + (connections === 1 ? endedFrame({ nodeId: NODE, subagents: [{ sessionId: AGENT, outcome: 'cancelled', endedAt: Date.now(), error: SUBAGENT_SESSION_ENDED_ERROR }] }) : '');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }).catch(() => {});
      return true;
    }
    if (path === '/workflow-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  };
  await installMockApi(page, { workspaces: [workspace], custom });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
  await page.goto('/');
  await page.locator(`.terminal-sidebar [data-sidebar-row="${NODE}"]`).click();
  const message = page.locator('[data-msg-id="answer"]');
  await expect(message).toBeVisible();
  const badge = page.getByTestId('pane-background-work-badge');
  const delegation = message.getByTestId('subagent-card');
  if (!(await delegation.isVisible())) await message.locator('button[data-toolgroup-header]').first().click();
  const line = delegation.getByTestId('subagent-summary');

  await expect(badge).toHaveCount(0);
  await expect(line).toContainText('stopped');
  await expect(line).toContainText(SUBAGENT_SESSION_ENDED_ERROR.split('\n')[0]);
  // Later connections list it live again without its end: still stopped.
  await expect.poll(() => connections).toBeGreaterThanOrEqual(2);
  await expect(badge).toHaveCount(0);
  await expect(line).toContainText('stopped');
  expect(errors).toEqual([]);
});
