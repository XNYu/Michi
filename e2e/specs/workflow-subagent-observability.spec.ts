import { test, expect, type Page, type Route } from '@playwright/test';
import type { SubagentInfo, WorkflowRunDtoV1 } from '../../shared/src';
import { installMockApi } from '../fixtures/mockApi';

/**
 * Durable subagent rosters and workflow runs, browser-side: a saved Claude
 * chat whose message spawned a subagent and launched a workflow. The roster
 * comes back from message metadata after reload; the workflow arrives on
 * the workflow-run stream and renders under its launching chip. Both cards
 * are one-line summaries that open the Background work drawer, where the
 * subagent's task/result and the workflow's steps, Stop and approvals live.
 * The pane title carries a badge while background work runs.
 */

const subagent: SubagentInfo = {
  sessionId: 'toolu_agent', parentToolCallId: 'toolu_agent', sessionName: 'Map the auth flow', agentName: 'Explore',
  initialQuery: 'Map the auth flow', description: 'Map the auth flow', status: 'terminated', outcome: 'completed',
  group: '', dependsOn: [], prompt: 'Find every place the session cookie is read.', model: 'haiku', source: 'claude',
  result: '**Three readers** in `src/auth.ts`.', usage: { totalTokens: 12_400, durationMs: 4_200 },
  activity: [{ id: 'c1', kind: 'tool', title: 'Read src/auth.ts', status: 'completed', toolKind: 'Read', detail: 'src/auth.ts', startedAt: 1, endedAt: 2 }],
};

function workflow(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_e2e', runtime: 'claude', nativeId: 'wg8d0aje6', workspaceId: 'obs-ws', nodeId: 'obs-node',
    parentToolCallId: 'toolu_wf', name: 'read-probe', description: 'Two parallel agents read alpha.txt and beta.txt',
    definition: "phase('read')", status: 'running',
    nodes: [
      { id: 'phase:1', kind: 'phase', title: 'read', status: 'running' },
      { id: 'agent:1', parentId: 'phase:1', kind: 'agent', title: 'alpha', status: 'completed', model: 'claude-sonnet', result: 'ALPHA_MARKER=A', prompt: 'Read alpha.txt' },
      { id: 'agent:2', parentId: 'phase:1', kind: 'agent', title: 'beta', status: 'running', currentTool: 'Read beta.txt' },
    ],
    log: [], actions: ['stop'], startedAt: Date.now() - 4_000, updatedAt: Date.now(), revision: 3,
    ...patch,
  };
}

function awaitingApproval(): WorkflowRunDtoV1 {
  return workflow({
    approvals: [{
      id: 'appr_1', nodeId: 'agent:2', title: 'Read beta.txt', detail: 'fs_read beta.txt',
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }],
      requestedAt: Date.now(),
    }],
  });
}

const workspace = {
  workspace: { id: 'obs-ws', name: 'Observability', active_tree_id: 'obs-tree', created_at: 1 },
  trees: [{ id: 'obs-tree', workspace_id: 'obs-ws', root_node_id: 'obs-node', name: 'Auth audit', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: 'obs-node', workspace_id: 'obs-ws', tree_id: 'obs-tree', kind: 'chat', title: 'Auth audit', runtime_id: 'claude', status: 'idle', created_at: 1 }],
  edges: [], contexts: [],
  messages: [
    { id: 'ask', node_id: 'obs-node', role: 'user', seq: 1, content: 'Audit the auth flow.' },
    {
      id: 'answer', node_id: 'obs-node', role: 'assistant', seq: 2, content: 'Delegated the audit.',
      tool_calls: JSON.stringify([
        { id: 'toolu_agent', title: 'Agent', status: 'completed', kind: 'tool', detail: JSON.stringify({ subagent_type: 'Explore', description: 'Map the auth flow' }) },
        { id: 'toolu_wf', title: 'Workflow', status: 'completed', kind: 'tool' },
      ]),
      blocks: JSON.stringify([
        { id: 'b0', kind: 'tool', toolCallId: 'toolu_agent', section: 'answer', rawOffset: 0 },
        { id: 'b1', kind: 'tool', toolCallId: 'toolu_wf', section: 'answer', rawOffset: 0 },
        { id: 'b2', kind: 'answer', rawText: 'Delegated the audit.' },
      ]),
      metadata: JSON.stringify({ subagents: [subagent] }),
    },
  ],
};

/** Workflow-run endpoints over one mutable run; records actions and answers. */
async function openChat(page: Page, initial: WorkflowRunDtoV1) {
  let current = initial;
  const actions: string[] = [];
  const answers: Array<{ approvalId: string; optionId: string }> = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const custom = async (route: Route): Promise<boolean> => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');
    const method = route.request().method();
    if (method === 'GET' && path === '/workflow-runs/subscribe') {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `event: workflow_run\ndata: ${JSON.stringify({ version: 1, event: 'workflow_run', run: current, emittedAt: Date.now() })}\n\n`,
      });
      return true;
    }
    if (method === 'GET' && path === '/workflow-runs/wfr_e2e') { await route.fulfill({ json: { run: current } }); return true; }
    if (method === 'POST' && path === '/workflow-runs/wfr_e2e/actions') {
      const { action } = route.request().postDataJSON() as { action: string };
      actions.push(action);
      current = workflow({
        status: 'cancelled', statusDetail: 'Stopped by you', actions: [], revision: current.revision + 1, endedAt: Date.now(),
        nodes: current.nodes.map((node) => node.status === 'running' ? { ...node, status: 'cancelled', currentTool: undefined } : node),
      });
      await route.fulfill({ json: { run: current } });
      return true;
    }
    const answer = method === 'POST' ? path.match(/^\/workflow-runs\/wfr_e2e\/approvals\/([^/]+)$/) : null;
    if (answer) {
      const { optionId } = route.request().postDataJSON() as { optionId: string };
      answers.push({ approvalId: decodeURIComponent(answer[1]), optionId });
      current = { ...current, approvals: [], revision: current.revision + 1 };
      await route.fulfill({ json: { run: current } });
      return true;
    }
    if (path === '/workflow-runs') { await route.fulfill({ json: { runs: [current] } }); return true; }
    if (path === '/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/agent-runs/subscribe') { await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true; }
    return false;
  };
  await installMockApi(page, { workspaces: [workspace], custom });
  await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
  await page.goto('/');
  await page.locator('.terminal-sidebar [data-sidebar-row="obs-node"]').click();
  const message = page.locator('[data-msg-id="answer"]');
  await expect(message).toBeVisible();
  return { message, actions, answers, errors };
}

test('subagent and workflow cards open the Background work drawer; the pane badge tracks the run', async ({ page }, info) => {
  const { message, actions, errors } = await openChat(page, workflow());
  const drawer = page.getByRole('dialog', { name: 'Background work' });

  // The pane title says background work runs: the workflow (the subagent finished).
  const badge = page.getByTestId('pane-background-work-badge');
  await expect(badge).toHaveText('◆1');
  await expect(badge).toHaveAttribute('aria-label', '1 workflow running. Show background work');

  // The subagent card is one line: name, the result's first line, status.
  const delegation = message.getByTestId('subagent-card');
  // The default (card) chrome; a completed group may start collapsed.
  if (!(await delegation.isVisible())) await message.locator('button[data-toolgroup-header]').first().click();
  const line = delegation.getByTestId('subagent-summary');
  await expect(line).toContainText('Explore');
  await expect(line).toContainText('Three readers in src/auth.ts.');
  await expect(line).toContainText('completed');
  await expect(message.getByTestId('subagent-detail')).toHaveCount(0);

  // Clicking it opens the drawer on that agent, expanded to task and result.
  await line.click();
  await expect(drawer).toBeVisible();
  const agentRow = drawer.getByTestId('background-subagent-row');
  await expect(agentRow).toHaveAttribute('data-subagent-id', 'toolu_agent');
  await expect(agentRow.getByTestId('subagent-task')).toHaveText('Find every place the session cookie is read.');
  await expect(agentRow.getByTestId('subagent-result').locator('strong')).toHaveText('Three readers');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // Workflow card under the launching message, live from the stream.
  const card = message.getByTestId('workflow-run-card');
  await expect(card).toContainText('read-probe');
  await expect(card).toContainText('1/2 agents');
  await expect(card.getByTestId('workflow-now')).toContainText('beta ❯ Read beta.txt');

  // Open → shows the run in the drawer, not in a pane.
  await card.getByRole('button', { name: 'Open workflow read-probe' }).click();
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId('workflow-run-pane')).toHaveCount(0);
  const runRow = drawer.getByTestId('background-workflow-row');
  await expect(runRow.getByRole('button', { name: 'Workflow read-probe, running' })).toHaveAttribute('aria-expanded', 'true');
  await expect(runRow.getByTestId('workflow-node')).toHaveCount(3);
  await runRow.getByRole('button', { name: 'Show alpha details' }).click();
  await expect(runRow.getByTestId('workflow-node-detail')).toContainText('ALPHA_MARKER=A');
  await page.screenshot({ path: info.outputPath('background-work-drawer.png'), animations: 'disabled' });

  await runRow.getByRole('button', { name: 'Stop workflow read-probe' }).click();
  await expect.poll(() => actions).toEqual(['stop']);
  await expect(runRow).toContainText('stopped');
  await expect(runRow.getByRole('button', { name: 'Stop workflow read-probe' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(card).toContainText('stopped');
  // Nothing runs any more: the badge goes away.
  await expect(badge).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a workflow step\'s approval is answered from its card', async ({ page }) => {
  const { message, answers, errors } = await openChat(page, awaitingApproval());
  const card = message.getByTestId('workflow-run-card');
  const approval = card.getByRole('group', { name: 'Approval needed: Read beta.txt' });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText('beta');
  await expect(approval).toContainText('fs_read beta.txt');
  await approval.getByRole('button', { name: 'Allow once' }).click();
  await expect.poll(() => answers).toEqual([{ approvalId: 'appr_1', optionId: 'allow_once' }]);
  await expect(card.getByTestId('workflow-approval')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a workflow step\'s approval is answered in the drawer opened from the pane badge', async ({ page }) => {
  const { message, answers, errors } = await openChat(page, awaitingApproval());
  const card = message.getByTestId('workflow-run-card');
  await expect(card.getByTestId('workflow-approval')).toHaveCount(1);

  await page.getByTestId('pane-background-work-badge').click();
  const drawer = page.getByRole('dialog', { name: 'Background work' });
  await expect(drawer).toBeVisible();
  // Opened without a focus: one collapsed line that says it waits on you.
  const runRow = drawer.getByTestId('background-workflow-row');
  const toggle = runRow.getByRole('button', { name: 'Workflow read-probe, running, needs approval' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const approval = runRow.getByRole('group', { name: 'Approval needed: Read beta.txt' });
  await expect(approval).toContainText('fs_read beta.txt');
  await approval.getByRole('button', { name: 'Allow once' }).click();
  await expect.poll(() => answers).toEqual([{ approvalId: 'appr_1', optionId: 'allow_once' }]);
  await expect(runRow.getByTestId('workflow-approval')).toHaveCount(0);
  await expect(runRow).not.toContainText('needs approval');
  await page.keyboard.press('Escape');
  await expect(card.getByTestId('workflow-approval')).toHaveCount(0);
  expect(errors).toEqual([]);
});
