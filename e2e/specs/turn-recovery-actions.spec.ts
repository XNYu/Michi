import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { bootWithWorkspace, installMockApi, sseBody } from '../fixtures/mockApi';

for (const recovery of ['unavailable', 'saved'] as const) {
  test(`checking an uncertain turn ${recovery === 'saved' ? 'restores its complete result' : 'keeps output until an explicit rerun'}`, async ({ page }) => {
    const posts: Array<{ turnId: string; nodeId: string; text: string }> = [];
    const checks: URL[] = [];
    const replays: URL[] = [];
    const cancelRequests: string[] = [];
    await installMockApi(page, { custom: async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/cancel')) cancelRequests.push(url.pathname);
      if (request.method() === 'POST' && /\/chats\/[^/]+\/message$/.test(url.pathname)) {
        const body = request.postDataJSON();
        posts.push(body);
        const { turnId, nodeId } = body;
        await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
          { event: 'turn_start', data: { turnId, nodeId, assistantId: `answer-${posts.length}`, userText: body.text, seq: 0 } },
          { event: 'chunk', data: { turnId, seq: 1, text: posts.length === 1 ? 'Original partial result.' : 'Explicit new execution.' } },
          ...(posts.length === 1
            ? [{ event: 'error' as const, data: { turnId, seq: 2, message: 'Final save could not be confirmed', code: 'turn_persistence_failed', recoverable: true } }]
            : [{ event: 'done' as const, data: { turnId, seq: 2, persisted: true, stopReason: 'end_turn' as const } }]),
        ]) });
        return true;
      }
      if (request.method() === 'GET' && /\/chats\/[^/]+\/stream$/.test(url.pathname)) replays.push(url);
      if (request.method() === 'GET' && posts[0] && url.pathname.endsWith(`/turns/${posts[0].turnId}`)) {
        checks.push(url);
        const { turnId, nodeId } = posts[0];
        await route.fulfill({ json: recovery === 'unavailable'
          ? { turnId, assistantId: 'answer-1', status: 'active', stopReason: null, completedAt: null, lastSeq: 2, message: null }
          : { turnId, assistantId: 'answer-1', status: 'completed', stopReason: 'end_turn', completedAt: 123, lastSeq: 2,
            message: { id: 'answer-1', node_id: nodeId, role: 'assistant', seq: 1, created_at: 2,
              content: 'Original partial result. Complete recovered answer.' } } });
        return true;
      }
      return false;
    } });
    await bootWithWorkspace(page);
    await page.locator('[contenteditable="true"]').first().fill('Perform one mock action');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    await expect(page.getByText('Original partial result.', { exact: true })).toBeVisible();
    await page.getByTestId('error-tail-retry').click();
    if (recovery === 'saved') {
      await expect(page.getByText('Original partial result. Complete recovered answer.', { exact: true })).toBeVisible();
      await expect(page.getByTestId('error-tail-retry')).toHaveCount(0);
      await expect(page.locator('.terminal-message-assistant')).toHaveCount(1);
    } else {
      await expect(page.getByText(/The original result could not be confirmed/)).toBeVisible();
      await expect(page.getByText('Original partial result.', { exact: true })).toBeVisible();
    }
    expect(posts).toHaveLength(1);
    expect(checks).toHaveLength(1);
    expect(replays).toHaveLength(0);
    expect(cancelRequests).toHaveLength(0);
    await mkdir('/tmp/michi-improvements-2026-10-24', { recursive: true });
    await page.screenshot({ path: `/tmp/michi-improvements-2026-10-24/recovery-${recovery}.png` });
    if (recovery === 'unavailable') {
      await page.getByRole('button', { name: 'Run again', exact: true }).click();
      await expect(page.getByText(/may repeat file changes/)).toBeVisible();
      expect(posts).toHaveLength(1);
      await page.getByRole('button', { name: 'Run again anyway' }).click();
      await expect(page.getByText('Explicit new execution.', { exact: true })).toBeVisible();
      await expect(page.getByText('Original partial result.', { exact: true })).toBeVisible();
      expect(posts).toHaveLength(2);
      expect(posts[1].turnId).not.toBe(posts[0].turnId);
    }
  });
}

// This starts from backend rows, as after hydration, rather than generating a
// classified live-stream failure whose failed turn ID remains in renderer state.
test('a hydrated unclassified error preserves output until an explicitly confirmed new execution', async ({ page }) => {
  const workspaceId = 'hydrated-recovery-ws';
  const nodeId = 'hydrated-recovery-node';
  const treeId = 'hydrated-recovery-tree';
  const originalOutput = 'Previously produced output must remain available.';
  const originalPrompt = 'Perform the previously requested action';
  const posts: Array<{ turnId: string; text: string }> = [];
  const checks: URL[] = [];
  const destructiveCalls: string[] = [];
  const workspace = {
    workspace: { id: workspaceId, name: 'Hydrated recovery workspace', active_tree_id: treeId, created_at: 1 },
    trees: [{ id: treeId, workspace_id: workspaceId, root_node_id: nodeId, name: 'Uncertain hydrated conversation', created_at: 1, last_active_at: 1 }],
    nodes: [{
      id: nodeId, kind: 'chat', workspace_id: workspaceId, tree_id: treeId,
      acp_session_id: nodeId, runtime_id: 'mock', title: 'Uncertain hydrated conversation',
      status: 'error', created_at: 1,
      // This watermark belongs to an older successful turn, not necessarily
      // the failed operation. Checking must not guess it as errorTurnId.
      last_applied_turn_id: 'older-successful-turn', last_applied_seq: 9,
    }],
    messages: [
      { id: 'hydrated-original-user', node_id: nodeId, role: 'user', seq: 0, content: originalPrompt, created_at: 1 },
      { id: 'hydrated-original-assistant', node_id: nodeId, role: 'assistant', seq: 1, content: originalOutput, created_at: 2 },
    ],
    edges: [], artifacts: [],
  };
  const prefs = { onboardingCompletedAt: 1, sidebarCollapsed: false,
    sidebarExpanded: { workspaces: { [workspaceId]: true }, threads: { [treeId]: true }, branches: {} },
  };
  await installMockApi(page, { workspaces: [workspace], custom: async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/prefs')) {
      await route.fulfill({ json: { prefs } }); return true;
    }
    if (/\/(?:cancel|trim)(?:\/|$)/.test(url.pathname) || request.method() === 'DELETE') {
      destructiveCalls.push(`${request.method()} ${url.pathname}`);
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/commands')) {
      const body = request.postDataJSON();
      for (const command of body.commands ?? []) {
        if (/delete|trim|truncate/i.test(command.type ?? '')) destructiveCalls.push(command.type);
      }
    }
    if (request.method() === 'GET' && /\/chats\/[^/]+\/(?:stream|turns\/[^/]+)$/.test(url.pathname)) checks.push(url);
    if (request.method() === 'POST' && /\/chats\/[^/]+\/message$/.test(url.pathname)) {
      const body = request.postDataJSON();
      posts.push(body);
      await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
        { event: 'turn_start', data: { turnId: body.turnId, nodeId, assistantId: 'hydrated-new-assistant', userText: body.text, seq: 0 } },
        { event: 'chunk', data: { turnId: body.turnId, seq: 1, text: 'Explicit execution after hydration.' } },
        { event: 'done', data: { turnId: body.turnId, seq: 2, persisted: true, stopReason: 'end_turn' } },
      ]) });
      return true;
    }
    return false;
  } });
  await page.addInitScript(prefs => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:prefs', JSON.stringify(prefs));
  }, prefs);
  await page.goto('/');
  await page.locator(`.terminal-sidebar [data-sidebar-row="${nodeId}"]`).click();
  const pane = page.locator(`.terminal-pane[data-node-id="${nodeId}"]`);
  await expect(pane.getByText(originalOutput, { exact: true })).toBeVisible();
  const recovery = pane.getByTestId('error-tail-retry');
  await expect(recovery).toHaveText('Check original turn');
  await recovery.click();
  await expect(pane.getByText(/The original result could not be confirmed/)).toBeVisible();
  await expect(pane.getByText(originalOutput, { exact: true })).toBeVisible();
  await expect(pane.locator('.terminal-message-user')).toHaveCount(1);
  await expect(pane.locator('.terminal-message-assistant')).toHaveCount(1);
  expect(posts).toHaveLength(0);
  expect(checks).toHaveLength(0);
  expect(destructiveCalls).toHaveLength(0);
  await mkdir('/tmp/michi-improvements-2026-10-24', { recursive: true });
  await page.screenshot({ path: '/tmp/michi-improvements-2026-10-24/recovery-hydrated-unknown.png' });

  await pane.getByRole('button', { name: 'Run again', exact: true }).click();
  await expect(page.getByText(/may repeat file changes/)).toBeVisible();
  expect(posts).toHaveLength(0);
  await page.getByRole('button', { name: 'Run again anyway' }).click();
  await expect(pane.getByText('Explicit execution after hydration.', { exact: true })).toBeVisible();
  await expect(pane.getByText(originalOutput, { exact: true })).toBeVisible();
  await expect(pane.locator('.terminal-message-user')).toHaveCount(2);
  await expect(pane.locator('.terminal-message-assistant')).toHaveCount(2);
  expect(posts).toHaveLength(1);
  expect(posts[0].turnId).not.toBe('older-successful-turn');
  expect(destructiveCalls).toHaveLength(0);
});

for (const missingTail of [false, true]) {
  test(`automatic reconnect restores persisted ${missingTail ? 'answer tail and completion' : 'completion without duplicating content'}`, async ({ page }) => {
    const posts: Array<{ turnId: string; nodeId: string }> = [];
    const cursors: string[] = [];
    await installMockApi(page, { custom: async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && /\/chats\/[^/]+\/message$/.test(url.pathname)) {
        const body = request.postDataJSON();
        posts.push(body);
        const envelope = { turnId: body.turnId, nodeId: body.nodeId, assistantId: 'saved-answer' };
        // Transport ends before done; the remote task completed independently.
        await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
          { event: 'turn_start', data: { ...envelope, seq: 0, userText: body.text } },
          { event: 'chunk', data: { ...envelope, seq: 1, text: 'Saved remote answer.' } },
        ]) });
        return true;
      }
      if (request.method() === 'GET' && /\/chats\/[^/]+\/stream$/.test(url.pathname) && posts[0]) {
        expect(url.searchParams.get('fromTurnId')).toBe(posts[0].turnId);
        cursors.push(url.searchParams.get('fromSeq')!);
        const envelope = { ...posts[0], assistantId: 'saved-answer' };
        await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
          ...(missingTail ? [{ event: 'chunk' as const, data: { ...envelope, seq: 2, text: ' Recovered tail.' } }] : []),
          { event: 'done', data: { ...envelope, seq: missingTail ? 3 : 2, persisted: true, completedAt: 123, stopReason: 'end_turn' } },
        ]) });
        return true;
      }
      return false;
    } });
    await bootWithWorkspace(page);
    await page.locator('[contenteditable="true"]').first().fill('Recover remote completion');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    await expect(page.getByText(missingTail ? 'Saved remote answer. Recovered tail.' : 'Saved remote answer.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('error-tail-retry')).toHaveCount(0);
    await expect(page.locator('.terminal-message-assistant')).toHaveCount(1);
    expect(posts).toHaveLength(1);
    expect(cursors).toEqual(['2']);
  });
}

const RESTARTED = 'Michi restarted while this task was running. Review the partial output above, then resume.';
const savedTurnStates = {
  // Completed before the restart; only the in-memory replay is gone.
  completed: { replayCode: 'turn_replay_unavailable', replayError: 'The live reply is no longer available.',
    status: 'completed', stopReason: 'end_turn', completedAt: 123, lastSeq: 3, content: 'Partial live text. Saved complete reply.' },
  // The restart cut the turn short; startup recovery wrote the restart receipt.
  interrupted: { replayCode: 'backend_restarted', replayError: RESTARTED,
    status: 'error', stopReason: null, completedAt: 123, lastSeq: 1, content: 'Partial live text.' },
  // Still running on another window's backend view, or not readable as finished.
  running: { replayCode: 'turn_replay_unavailable', replayError: 'The live reply is no longer available.',
    status: 'active', stopReason: null, completedAt: null, lastSeq: 1, content: 'Partial live text.' },
} as const;

for (const state of ['completed', 'interrupted', 'running'] as const) {
  const saved = savedTurnStates[state];
  test(`a reconnect whose live replay is gone, for a ${state} turn, ${{
    completed: 'shows the saved reply without an error',
    interrupted: 'offers Resume, which carries the turn on',
    running: 'keeps the check-original error',
  }[state]}`, async ({ page }) => {
    const posts: Array<{ turnId: string; nodeId: string; text: string; displayText?: string }> = [];
    const reads: string[] = [];
    await installMockApi(page, { custom: async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && /\/chats\/[^/]+\/message$/.test(url.pathname)) {
        const body = request.postDataJSON();
        posts.push(body);
        const assistantId = posts.length === 1 ? 'saved-answer' : 'resumed-answer';
        const envelope = { turnId: body.turnId, nodeId: body.nodeId, assistantId };
        await route.fulfill({ contentType: 'text/event-stream', body: sseBody(posts.length === 1
          // Transport ends before done, and the in-memory replay has expired.
          ? [
            { event: 'turn_start', data: { ...envelope, seq: 0, userText: body.text } },
            { event: 'chunk', data: { ...envelope, seq: 1, text: 'Partial live text.' } },
          ]
          : [
            { event: 'turn_start', data: { ...envelope, seq: 0, userText: body.displayText ?? body.text } },
            { event: 'chunk', data: { ...envelope, seq: 1, text: 'Carried on after the restart.' } },
            { event: 'done', data: { ...envelope, seq: 2, persisted: true, stopReason: 'end_turn' } },
          ]) });
        return true;
      }
      if (request.method() === 'GET' && /\/chats\/[^/]+\/stream$/.test(url.pathname) && posts[0]
        && url.searchParams.get('fromTurnId') === posts[0].turnId) {
        reads.push('stream');
        await route.fulfill({ status: 410, json: { error: saved.replayError, code: saved.replayCode } });
        return true;
      }
      if (request.method() === 'GET' && posts[0] && url.pathname.endsWith(`/turns/${posts[0].turnId}`)) {
        reads.push('saved-turn');
        const { turnId, nodeId } = posts[0];
        await route.fulfill({ json: {
          turnId, assistantId: 'saved-answer', status: saved.status, stopReason: saved.stopReason,
          completedAt: saved.completedAt, lastSeq: saved.lastSeq,
          message: { id: 'saved-answer', node_id: nodeId, role: 'assistant', seq: 1, created_at: 2, content: saved.content },
        } });
        return true;
      }
      return false;
    } });
    await bootWithWorkspace(page);
    await page.locator('[contenteditable="true"]').first().fill('Recover an expired replay');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    if (state === 'completed') {
      await expect(page.getByText('Partial live text. Saved complete reply.', { exact: true })).toBeVisible();
      await expect(page.getByTestId('error-tail-retry')).toHaveCount(0);
    } else if (state === 'interrupted') {
      await expect(page.getByTestId('error-tail-retry')).toHaveText('▶ Resume');
      await expect(page.getByText('Turn interrupted')).toBeVisible();
      await expect(page.getByText('Check original turn')).toHaveCount(0);
      await expect(page.getByText('Partial live text.', { exact: true })).toBeVisible();
    } else {
      await expect(page.getByTestId('error-tail-retry')).toHaveText('Check original turn');
      await expect(page.getByText('Partial live text.', { exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(page.locator('.terminal-message-assistant')).toHaveCount(1);
    expect(reads).toEqual(['stream', 'saved-turn']);
    expect(posts).toHaveLength(1);
    if (state !== 'interrupted') return;

    // Resume sends a continuation prompt, never the original request again.
    await page.getByTestId('error-tail-retry').click();
    await expect(page.getByText('Carried on after the restart.', { exact: true })).toBeVisible();
    expect(posts).toHaveLength(2);
    expect(posts[1].turnId).not.toBe(posts[0].turnId);
    expect(posts[1].displayText).toBe('Resume the interrupted turn');
    expect(posts[1].text).toContain('[INTERRUPTED TURN — context restore]');
    expect(posts[1].text).toContain('Interrupted request:\nRecover an expired replay');
    expect(posts[1].text).toContain('Partial response before the interruption:\nPartial live text.');
    await expect(page.getByText('Partial live text.', { exact: true })).toBeVisible();
    await expect(page.locator('.terminal-message-assistant')).toHaveCount(2);
  });
}
