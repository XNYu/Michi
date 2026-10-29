import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

/**
 * A window that opens a running turn after its question was saved (asked while
 * another window watched, then a reload or reconnect) never sees the live
 * user_input_request event. The saved block alone must make the question
 * answerable, on a phone as on a desktop.
 */
const workspaceId = 'ask-ws';
const nodeId = 'ask-node';
const treeId = 'ask-tree';
const question = { id: 'q1', question: 'Ship the status email now?', multiSelect: false, options: [{ label: 'Yes, send it' }, { label: 'Not yet' }] };

test('a question saved before this window opened can be answered from a phone', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const responses: Array<Record<string, unknown>> = [];
  try {
    await installMockApi(page, {
      workspaces: [{
        workspace: { id: workspaceId, name: 'Status email', active_tree_id: treeId, created_at: 1 },
        trees: [{ id: treeId, workspace_id: workspaceId, root_node_id: nodeId, name: 'Status email', created_at: 1, last_active_at: 1 }],
        nodes: [{
          id: nodeId, kind: 'chat', workspace_id: workspaceId, tree_id: treeId, acp_session_id: nodeId, runtime_id: 'mock',
          title: 'Status email', status: 'streaming', created_at: 1, last_applied_turn_id: 'turn-1', last_applied_seq: 4,
        }],
        edges: [],
        messages: [
          { id: 'u1', node_id: nodeId, role: 'user', content: 'Draft and send the status email', seq: 0, created_at: 1 },
          { id: 'a1', node_id: nodeId, role: 'assistant', content: 'The draft is ready.', seq: 1, created_at: 2,
            blocks: JSON.stringify([
              { id: 'a1-b-0', kind: 'answer', rawText: 'The draft is ready.', streaming: false },
              { id: 'a1-b-1', kind: 'user-input', requestId: 3, section: 'answer', rawOffset: 19,
                interaction: { interactionId: 'turn-1:input:3', requestId: 3, questions: [question], answers: [], status: 'pending' } },
            ]) },
        ],
        artifacts: [],
      }],
      custom: async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/^.*\/api/, '');
        // The turn is still waiting on the answer: its replay stays open.
        if (/^\/chats\/[^/]+\/stream$/.test(path)) {
          await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
          return true;
        }
        if (request.method() === 'POST' && path.endsWith('/user-input-response')) {
          responses.push(request.postDataJSON());
          await route.fulfill({ json: { ok: true } });
          return true;
        }
        return false;
      },
    });
    await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 })));
    await page.goto('/');

    // The ASK bar announces it before the thread is open.
    const alert = page.locator('.ask-alert-bar');
    await expect(alert).toContainText('Ship the status email now?');
    await alert.getByRole('button', { name: /answer the agent's question/ }).tap();

    const card = page.locator('.ask-card').filter({ hasText: 'Ship the status email now?' });
    const yes = card.getByRole('radio', { name: 'Yes, send it' });
    await expect(yes).toBeEnabled();
    await yes.tap();
    await expect(yes).toHaveAttribute('aria-checked', 'true');
    await card.getByRole('button', { name: 'Submit', exact: true }).tap();
    await expect.poll(() => responses.length).toBe(1);
    expect(responses[0]).toMatchObject({ requestId: 3, interactionId: 'turn-1:input:3', answers: [{ id: 'q1', answer: 'Yes, send it' }] });
  } finally {
    await context.close();
  }
});
