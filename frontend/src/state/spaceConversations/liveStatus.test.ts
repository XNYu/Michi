import { describe, expect, it } from 'vitest';
import type { ProgressCardDto } from 'michi-shared';
import type { ChatMessage, ChatNodeState } from '../chatTypes';
import { cardLiveState, progressStatusLine, replySummary, threadTitle } from './liveStatus';

const card = (patch: Partial<ProgressCardDto> = {}): ProgressCardDto => ({
  threadNodeId: 'n1', startedFromPageId: 'p1', workspaceId: 'w1', workspaceName: 'rabbitholes', treeId: 't1',
  title: '', runtimeId: 'kiro', status: 'running', summary: null, createdAt: 1, seenAt: null, dismissedAt: null, expiresAt: null,
  ...patch,
});

const user = (text: string): ChatMessage => ({ id: 'u', role: 'user', text, toolCalls: [] });
const reply = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'a', role: 'assistant', text: '', toolCalls: [], ...patch });

const node = (patch: Partial<ChatNodeState> = {}): ChatNodeState => ({
  nodeId: 'n1', kind: 'chat', chatId: 'n1', projectId: 'w1', messages: [user('把 Intel 机器手测的步骤写出来')], followUps: [],
  status: 'streaming', ...patch,
} as ChatNodeState);

describe('progress card live state', () => {
  it('names what a running conversation is doing, never what it says', () => {
    expect(progressStatusLine(node({ messages: [user('q'), reply()] }))).toBe('Starting…');
    expect(progressStatusLine(node({ messages: [user('q'), reply({ blocks: [{ id: 'b', kind: 'answer', rawText: 'Secret answer', streaming: true }] })] }))).toBe('Writing the reply…');
    expect(progressStatusLine(node({ messages: [user('q'), reply({ blocks: [{ id: 'b', kind: 'thinking', rawText: 'hmm', streaming: true }] })] }))).toBe('Thinking…');
    expect(progressStatusLine(node({ messages: [user('q'), reply({ text: 'x', toolCalls: [{ id: 't', title: 'Read src/a.ts', status: 'in_progress', kind: 'read' }] })] }))).toBe('Reading code…');
    expect(progressStatusLine(node({ messages: [user('q'), reply({ text: 'x', toolCalls: [{ id: 't', title: 'npm test', status: 'running', kind: 'execute' }] })] }))).toBe('Running tests…');
    expect(progressStatusLine(node({ pendingPermission: { toolCallId: 't' } as never }))).toBe('Waiting for your approval…');
  });

  it('prefers this window’s live thread, else the backend’s reading of it', () => {
    expect(cardLiveState(card(), undefined)).toMatchObject({ status: 'running', line: 'Working…' });
    expect(cardLiveState(card({ status: 'idle' }), node())).toMatchObject({ status: 'running', line: 'Starting…' });
    expect(cardLiveState(card(), node({ status: 'idle', messages: [user('q'), reply({ text: 'Done.' })] }))).toMatchObject({ status: 'done', line: '' });
    expect(cardLiveState(card(), node({ status: 'error' })).status).toBe('failed');
    // Hydrated without its messages: the backend still says it runs.
    expect(cardLiveState(card(), node({ status: 'idle', messages: [] })).status).toBe('running');
    expect(cardLiveState(card({ status: 'cancelled' }), node({ status: 'idle', messages: [user('q'), reply({ text: 'x' })] })).status).toBe('cancelled');
  });

  it('shows what the backend reads from a conversation this window is not streaming', () => {
    expect(cardLiveState(card({ statusLine: 'Waiting for your approval…', awaiting: 'approval', awaitingDetail: 'Run npm test' }), undefined))
      .toMatchObject({ status: 'running', line: 'Waiting for your approval…', awaiting: 'approval', waitingFor: 'Run npm test' });
    expect(cardLiveState(card({ statusLine: 'Running tests…' }), node({ status: 'idle', messages: [] })).line).toBe('Running tests…');
    // This window's own stream knows first.
    expect(cardLiveState(card({ statusLine: 'Working…' }), node({ pendingUserInput: { requestId: 1 } as never })).line).toBe('Waiting for your answer…');
  });

  it('says what a conversation in this window waits for: the approval\'s title or the question', () => {
    const permission = { requestId: 1, title: 'Run   npm test', options: [] };
    expect(cardLiveState(card(), node({ pendingPermission: permission }))).toMatchObject({ awaiting: 'approval', waitingFor: 'Run npm test' });
    const input = { requestId: 2, questions: [{ header: 'Branch', question: 'Which branch should I test?', options: [], multiSelect: false }], answers: [] };
    expect(cardLiveState(card(), node({ pendingUserInput: input }))).toMatchObject({ awaiting: 'question', waitingFor: 'Which branch should I test?' });
    expect(cardLiveState(card(), node({ pendingUserInput: { ...input, resolved: true } }))).toMatchObject({ awaiting: null, waitingFor: null });
    // Once the turn ends nothing waits, whatever the last reading said.
    expect(cardLiveState(card({ status: 'done', awaiting: 'approval', awaitingDetail: 'x' }), undefined)).toMatchObject({ awaiting: null, waitingFor: null });
  });

  it('titles the card from the thread and summarises what the newest reply concluded', () => {
    expect(threadTitle(node())).toBe('把 Intel 机器手测的步骤写出来');
    expect(threadTitle(node({ title: 'Intel 手测步骤' }))).toBe('Intel 手测步骤');
    expect(threadTitle(undefined, 'From backend')).toBe('From backend');
    const done = node({ status: 'idle', messages: [user('q'), reply({ blocks: [{ id: 'b', kind: 'answer', rawText: 'First  paragraph\nline two.\n\nSecond paragraph.' }] })] });
    expect(replySummary(done)).toBe('Second paragraph.');
    // Segments split by tool calls end where the reply ends.
    const working = node({ status: 'idle', messages: [user('q'), reply({ blocks: [
      { id: 'b1', kind: 'answer', rawText: 'I\'ll investigate.' }, { id: 't', kind: 'tool', toolCallId: 't', section: 'answer', rawOffset: 0 } as never,
      { id: 'b2', kind: 'answer', rawText: 'I could not run the rollback test: node-pty does not build.' },
    ] })] });
    expect(replySummary(working)).toBe('I could not run the rollback test: node-pty does not build.');
    const marked = node({ status: 'idle', messages: [user('q'), reply({ blocks: [
      { id: 'b1', kind: 'answer', rawText: 'The log file is missing, so I cannot tell.\n\n[BRANCH-OVERVIEW: read the log; it is missing]' },
    ] })] });
    expect(replySummary(marked)).toBe('The log file is missing, so I cannot tell.');
    // The overview entry this turn ended with is its summary; one from before the question is not.
    const asked = { ...user('q'), createdAt: 100 };
    const overview = (at: number) => node({ status: 'idle', branchOverviewEntries: [{ at, text: 'Read the log: missing, so no result.' }], messages: [asked, reply({ text: 'Long reply.\n\nWant me to search?' })] });
    expect(replySummary(overview(150))).toBe('Read the log: missing, so no result.');
    expect(replySummary(overview(50))).toBe('Long reply. Want me to search?');
    expect(replySummary(node({ messages: [user('q')] }))).toBeNull();
    expect(replySummary(node({ messages: [user('q'), reply({ text: 'x'.repeat(300) })] }))?.length).toBe(240);
  });
});
