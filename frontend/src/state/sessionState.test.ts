import { expect, it } from 'vitest';
import { parseChatStreamEvent, dispatchChatStreamEvent } from '../services/chatStreamEvents';
import { createBackgroundTurnBinding } from './observeChatStream';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';

it('reconnection installs session settings and clears recovered MCP errors without moving turn watermarks', () => {
  let nodes: Record<string, ChatNodeState> = { n: { nodeId: 'n', kind: 'chat', chatId: 'n', projectId: 'p', runtimeId: 'kiro',
    messages: [], followUps: [], status: 'idle', modelId: 'old', reasoning: 'low', mcpServerError: { serverName: 'test', error: 'offline' } } };
  const lastTurnRef = { current: 'turn-old' }, lastSeqRef = { current: 42 };
  const handlers = createBackgroundTurnBinding({ chatId: 'n', nodeId: 'n', lastTurnRef, lastSeqRef,
    dispatch: (action) => { nodes = reduceNodes(nodes, action); },
  }).createHandlers();
  const state = { runtimeId: 'kiro', modelId: 'new', currentModeId: 'plan', reasoning: 'high',
    commands: [{ name: 'context' }], availableModes: [{ id: 'plan', name: 'Plan' }], mcpErrors: [] };
  const event = parseChatStreamEvent('session_state', JSON.stringify({ ...state, nodeId: 'n', chatId: 'n' }));
  expect(event).not.toBeNull(); dispatchChatStreamEvent(event!, handlers);
  expect(nodes.n).toMatchObject({ modelId: 'new', currentModeId: 'plan', reasoning: 'high', agentCommands: [{ name: 'context' }], status: 'idle', messages: [] });
  expect(nodes.n.mcpServerError).toBeUndefined();
  expect(nodes.n.sessionState?.availableModes).toEqual(state.availableModes);
  expect(lastTurnRef.current).toBe('turn-old'); expect(lastSeqRef.current).toBe(42);
});

it('rejects invalid reasoning values and ignores late state from a different runtime', () => {
  const event = parseChatStreamEvent('session_state', JSON.stringify({ runtimeId: 'kiro', reasoning: 'invented', modelId: 'new' }));
  expect(event?.data).not.toHaveProperty('reasoning');
  const nodes: Record<string, ChatNodeState> = { n: { nodeId: 'n', kind: 'chat', chatId: 'n', projectId: 'p', runtimeId: 'codex', messages: [], followUps: [], status: 'idle' } };
  expect(reduceNodes(nodes, { type: 'session-state', nodeId: 'n', state: { runtimeId: 'kiro', modelId: 'new' } })).toBe(nodes);
});

it('an older turn replay cannot roll back newer session settings', () => {
  const nodes: Record<string, ChatNodeState> = { n: { nodeId: 'n', kind: 'chat', chatId: 'n', projectId: 'p', runtimeId: 'kiro', messages: [], followUps: [], status: 'idle',
    modelId: 'latest', sessionState: { runtimeId: 'kiro', version: 20, modelId: 'latest' } } };
  expect(reduceNodes(nodes, { type: 'session-state', nodeId: 'n', state: { runtimeId: 'kiro', version: 19, modelId: 'old' } })).toBe(nodes);
});
