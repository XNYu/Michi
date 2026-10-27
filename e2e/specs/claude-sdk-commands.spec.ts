import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi, sseBody } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

const claudeStatus = {
  runtime: 'claude', label: 'Claude', hasRequiredKey: true,
  capabilities: { modes: false, permissions: true, models: true, providerModels: false,
    reasoning: false, apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: true },
  availableRuntimes: [{ id: 'claude', label: 'Claude', available: true }],
};

function coldWorkspace() {
  return {
    workspace: { id: 'claude-ws', name: 'Claude history', active_tree_id: 'claude-tree', created_at: 1 },
    trees: [{ id: 'claude-tree', workspace_id: 'claude-ws', root_node_id: 'parent', name: 'Claude history', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'parent', kind: 'chat', workspace_id: 'claude-ws', tree_id: 'claude-tree',
      title: 'Claude history', status: 'idle', runtime_id: 'claude', acp_session_id: 'native-parent', created_at: 1 }],
    edges: [], contexts: [],
    messages: [
      { id: 'u1', node_id: 'parent', role: 'user', seq: 0, content: 'Remember blue', created_at: 1 },
      { id: 'a1', node_id: 'parent', role: 'assistant', seq: 1, content: 'The earlier color is blue.', created_at: 2 },
      { id: 'u2', node_id: 'parent', role: 'user', seq: 2, content: 'Now remember green', created_at: 3 },
      { id: 'a2', node_id: 'parent', role: 'assistant', seq: 3, content: 'The later color is green.', created_at: 4 },
    ],
  };
}

test('a cold Claude host command restores its session before execution without sending a model prompt', async ({ page }) => {
  const calls: string[] = [];
  await installMockApi(page, { workspaces: [coldWorkspace()], custom: async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/agent/status')) { await route.fulfill({ json: claudeStatus }); return true; }
    if (req.method() !== 'POST') return false;
    if (path.endsWith('/ensure-session')) {
      calls.push('ensure');
      expect(path).toContain('/nodes/parent/ensure-session');
      expect(req.postDataJSON()).toMatchObject({ runtimeId: 'claude' });
      await route.fulfill({ json: { chatId: 'parent', runtimeId: 'claude', resumeStrategy: 'exact',
        sessionState: { runtimeId: 'claude', nativeEngine: 'agent-sdk' } } }); return true;
    }
    if (path.endsWith('/execute-command')) {
      calls.push('command');
      await route.fulfill({ json: { success: true, message: 'Restored Claude session.' } }); return true;
    }
    if (path.endsWith('/message')) calls.push('prompt');
    return false;
  } });
  await page.goto('/');
  await page.locator('[data-sidebar-row="parent"]').click();
  const pane = page.locator('.terminal-pane[data-node-id="parent"]');
  await pane.locator('[contenteditable="true"]').fill('/status');
  await pane.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(pane.getByText('Restored Claude session.', { exact: true })).toBeVisible();
  expect(calls).toEqual(['ensure', 'command']);
  await expect(pane.locator('.terminal-message-user')).toHaveCount(2);
});

test('branch from an earlier Claude answer opens a blank child whose first command keeps the anchor', async ({ page }) => {
  const ensures: Array<{ path: string; body: any }> = [], prompts: string[] = [];
  await installMockApi(page, { workspaces: [coldWorkspace()], custom: async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/agent/status')) { await route.fulfill({ json: claudeStatus }); return true; }
    if (req.method() !== 'POST') return false;
    if (path.endsWith('/ensure-session')) {
      ensures.push({ path, body: req.postDataJSON() });
      await route.fulfill({ json: { chatId: path.split('/').at(-2), runtimeId: 'claude', resumeStrategy: 'fresh',
        resumeReason: 'native_fork', forkKind: 'native', sessionState: { runtimeId: 'claude', nativeEngine: 'agent-sdk' } } }); return true;
    }
    if (path.endsWith('/execute-command')) {
      await route.fulfill({ json: { success: true, message: 'Child Claude session is connected.' } }); return true;
    }
    if (path.endsWith('/message')) prompts.push(path);
    return false;
  } });
  await page.goto('/');
  await page.locator('[data-sidebar-row="parent"]').click();
  const parent = page.locator('.terminal-pane[data-node-id="parent"]');
  const earlier = parent.locator('.terminal-message-assistant').first();
  await earlier.hover();
  await earlier.locator('..').getByRole('button', { name: 'branch from here', exact: true }).click();
  const child = page.locator('.terminal-pane').filter({ hasNot: page.locator('[data-pane-caption-id="parent"]') }).last();
  await expect(page.locator('.terminal-pane')).toHaveCount(2);
  const childId = await child.getAttribute('data-node-id');
  expect(childId).toBeTruthy();
  expect(childId).not.toBe('parent');
  await child.locator('[contenteditable="true"]').fill('/status');
  await child.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(child.getByText('Child Claude session is connected.', { exact: true })).toBeVisible();
  expect(ensures).toHaveLength(1);
  expect(ensures[0].path).toContain(`/nodes/${childId}/ensure-session`);
  expect(ensures[0].body).toMatchObject({ runtimeId: 'claude', priorMessages: [],
    graphPrerequisite: { node: { id: childId, parentNodeId: 'parent' },
      edges: expect.arrayContaining([expect.objectContaining({ sourceNodeId: 'parent', targetNodeId: childId, anchorMessageId: 'a1' })]) } });
  expect(prompts).toEqual([]);
});

test('native Claude AskUserQuestion uses the shared question card and posts the selected answer', async ({ page }) => {
  const answers: unknown[] = [];
  await installMockApi(page, {
    custom: async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path.endsWith('/agent/status')) { await route.fulfill({ json: claudeStatus }); return true; }
      if (req.method() === 'POST' && path.endsWith('/user-input-response')) {
        answers.push(req.postDataJSON()); await route.fulfill({ json: { ok: true } }); return true;
      }
      return false;
    },
  });
  await page.addInitScript((initialFrames) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (init?.method === 'POST' && /^\/api\/chats\/[^/]+\/message$/.test(url.pathname)) {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          (window as any).__claudeQuestionStream = controller;
          controller.enqueue(new TextEncoder().encode(initialFrames));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  }, sseBody([
    { event: 'tool_call', data: { toolCallId: 'ask-native', title: 'AskUserQuestion', status: 'in_progress' } },
    { event: 'user_input_request', data: { requestId: 42, questions: [{ question: 'Which color?', header: 'Color',
      options: [{ label: 'Blue', description: 'Use blue' }, { label: 'Green', description: 'Use green' }], multiSelect: false }] } },
  ]));
  await bootWithWorkspace(page, 'Claude questions');
  await page.locator(COMPOSER_EDITOR).first().fill('Ask me a color');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  const card = page.locator('.ask-card');
  await expect(card.getByRole('radiogroup', { name: 'Which color?' })).toBeVisible();
  await card.getByRole('radio', { name: /Blue/ }).click();
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => answers).toEqual([{
    requestId: 42,
    answers: [{
      id: expect.stringMatching(/^frontend-.+:input:42:q:0$/),
      question: 'Which color?',
      answer: 'Blue',
    }],
  }]);
  await expect(card.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0);
  await page.evaluate((frames) => {
    const stream = (window as any).__claudeQuestionStream as ReadableStreamDefaultController<Uint8Array>;
    stream.enqueue(new TextEncoder().encode(frames)); stream.close();
  }, sseBody([{ event: 'chunk', data: { text: 'The selected color is Blue.' } }, { event: 'done', data: { stopReason: 'end_turn' } }]));
  await expect(page.getByText('The selected color is Blue.', { exact: true })).toBeVisible();
});

test('Claude SDK host commands show results and queued model changes stay out of prompts', async ({ page }) => {
  const prompts: string[] = [], commands: Array<{ command: string; args?: { value: string } }> = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await installMockApi(page, { custom: async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/agent/status')) {
      await route.fulfill({ json: { runtime: 'claude', label: 'Claude', hasRequiredKey: true,
        capabilities: { modes: false, permissions: true, models: true, providerModels: false, reasoning: false, apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: true },
        availableRuntimes: [{ id: 'claude', label: 'Claude', available: true }],
      } }); return true;
    }
    if (req.method() !== 'POST') return false;
    if (path.endsWith('/ensure-session')) {
      await route.fulfill({ json: { chatId: path.split('/').at(-2), runtimeId: 'claude', resumeStrategy: 'live',
        sessionState: { runtimeId: 'claude', nativeEngine: 'agent-sdk', modelId: 'claude-sonnet-5', commands: [{ name: 'status' }, { name: 'model' }] },
      } }); return true;
    }
    if (path.endsWith('/execute-command')) {
      const data = req.postDataJSON(); commands.push(data);
      await route.fulfill({ json: { success: true,
        message: data.command === 'status' ? 'Claude SDK is connected.' : 'Model changed to claude-sonnet-4-6.',
        sessionState: { runtimeId: 'claude', nativeEngine: 'agent-sdk', modelId: data.command === 'model' ? 'claude-sonnet-4-6' : 'claude-sonnet-5' },
      } }); return true;
    }
    if (path.endsWith('/message')) {
      prompts.push(req.postDataJSON().text);
      if (prompts.length === 2) await blocked;
    }
    return false;
  } });
  await bootWithWorkspace(page);
  const editor = page.locator(COMPOSER_EDITOR).first();
  await editor.fill('Start'); await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  await editor.fill('/status'); await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('Claude SDK is connected.', { exact: true })).toBeVisible();
  expect(prompts).toHaveLength(1);
  await editor.fill('Keep working'); await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByRole('button', { name: 'Stop stream', exact: true })).toBeVisible();
  await editor.fill('/model claude-sonnet-4-6'); await page.getByRole('button', { name: /^Send next/ }).click();
  expect(commands).toHaveLength(1); release();
  await expect(page.getByText('Model changed to claude-sonnet-4-6.', { exact: true })).toBeVisible();
  expect(commands[1]).toEqual({ command: 'model', args: { value: 'claude-sonnet-4-6' } });
  expect(prompts).toHaveLength(2);
});
