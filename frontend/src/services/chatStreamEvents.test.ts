import { encodeChatStreamEvent, type ChatStreamEvent } from 'michi-shared';
import { vi } from 'vitest';
import {
  CHAT_STREAM_EVENTS,
  dispatchChatStreamEvent,
  parseChatStreamEvent,
} from './chatStreamEvents';

const sampleEvents: ChatStreamEvent[] = [
  { event: CHAT_STREAM_EVENTS.chunk, data: { text: 'hello' } },
  { event: CHAT_STREAM_EVENTS.thought, data: { text: 'thinking' } },
  {
    event: CHAT_STREAM_EVENTS.plan,
    data: { entries: [{ content: 'Check parser', priority: 'high', status: 'pending' }] },
  },
  {
    event: CHAT_STREAM_EVENTS.toolCall,
    data: {
      toolCallId: 'tc_1',
      title: 'Read files',
      status: 'pending',
      kind: 'read',
      detail: 'src/index.ts',
    },
  },
  {
    event: CHAT_STREAM_EVENTS.toolCallUpdate,
    data: {
      toolCallId: 'tc_1',
      title: 'Read files',
      status: 'completed',
      kind: 'read',
      detail: 'done',
    },
  },
  { event: CHAT_STREAM_EVENTS.heartbeat, data: { idleMs: 1200 } },
  {
    event: CHAT_STREAM_EVENTS.spawnBranches,
    data: { topics: [{ title: 'Branch', prompt: 'Explore branch', chatId: 'chat-child' }] },
  },
  { event: CHAT_STREAM_EVENTS.title, data: { title: 'Shared schema' } },
  { event: CHAT_STREAM_EVENTS.branchOverview, data: { overview: 'The schema update is ready to ship.' } },
  { event: CHAT_STREAM_EVENTS.followUps, data: { followUps: ['What next?'] } },
  { event: CHAT_STREAM_EVENTS.followUpsStatus, data: { status: 'completed' } },
  {
    event: CHAT_STREAM_EVENTS.commands,
    data: {
      commands: [{ name: 'search', description: 'Search repo', input: { type: 'object' } }],
    },
  },
  {
    event: CHAT_STREAM_EVENTS.contextSaved,
    data: { name: 'repo_notes', filePath: '.contexts/repo_notes.md', size: 42 },
  },
  {
    event: CHAT_STREAM_EVENTS.contextUpdated,
    data: { name: 'repo_notes', filePath: '.contexts/repo_notes.md', size: 84 },
  },
  {
    event: CHAT_STREAM_EVENTS.image,
    data: { path: '.shot.png', caption: 'a screenshot', mimeType: 'image/png', size: 53248 },
  },
  {
    event: CHAT_STREAM_EVENTS.permissionRequest,
    data: {
      requestId: 7,
      toolCallId: 'tc_1',
      title: 'Allow write?',
      detail: 'File: src/index.ts',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }],
    },
  },
  {
    event: CHAT_STREAM_EVENTS.subagentListUpdate,
    data: {
      subagents: [{
        sessionId: 'sub-1',
        sessionName: 'review',
        agentName: 'Reviewer',
        initialQuery: 'Check schema',
        status: 'working',
        statusMessage: 'reading',
        group: 'default',
        dependsOn: [],
      }],
    },
  },
  {
    event: CHAT_STREAM_EVENTS.subagentToolActivity,
    data: { subagentSessionId: 'sub-1', title: 'Read file', status: 'completed' },
  },
  { event: CHAT_STREAM_EVENTS.contextUsage, data: { contextUsagePercentage: 33 } },
  {
    event: CHAT_STREAM_EVENTS.usageSummary,
    data: { contextUsagePercentage: 44, totalCredits: 12, turnDurationMs: 3456 },
  },
  {
    event: CHAT_STREAM_EVENTS.mcpServerError,
    data: { serverName: 'michi-tools', error: 'connection closed' },
  },
  { event: CHAT_STREAM_EVENTS.done, data: { stopReason: 'end_turn' } },
  { event: CHAT_STREAM_EVENTS.error, data: { message: 'boom' } },
  {
    event: CHAT_STREAM_EVENTS.turnStart,
    data: { turnId: 'T1', assistantId: 'a-n1-T1', nodeId: 'n1', userText: 'hello' },
  },
];

function parseEncodedFrame(frame: string): ChatStreamEvent | null {
  const event = frame.match(/^event: (.+)$/m)?.[1];
  const data = frame.match(/^data: (.+)$/m)?.[1];
  return event && data ? parseChatStreamEvent(event, data) : null;
}

describe('parseChatStreamEvent', () => {
  it('roundtrips every known event through the shared SSE codec', () => {
    expect(sampleEvents.map((event) => event.event).sort()).toEqual(
      Object.values(CHAT_STREAM_EVENTS).sort(),
    );

    for (const event of sampleEvents) {
      expect(parseEncodedFrame(encodeChatStreamEvent(event))).toEqual(event);
    }
  });

  it('normalizes missing list payloads to empty arrays', () => {
    const event = parseChatStreamEvent(CHAT_STREAM_EVENTS.followUps, '{}');

    expect(event).toEqual({
      event: CHAT_STREAM_EVENTS.followUps,
      data: { followUps: [] },
    });
  });

  it('ignores malformed or unknown events', () => {
    expect(parseChatStreamEvent('unknown', '{}')).toBeNull();
    expect(parseChatStreamEvent(CHAT_STREAM_EVENTS.chunk, '{')).toBeNull();
  });

  it('dispatches typed events to matching handlers', () => {
    const onContextSaved = vi.fn();
    const onContextUpdated = vi.fn();
    const onBranchOverview = vi.fn();

    dispatchChatStreamEvent(
      {
        event: CHAT_STREAM_EVENTS.contextSaved,
        data: { name: 'repo_notes', filePath: '.contexts/repo_notes.md', size: 42 },
      },
      { onContextSaved },
    );

    dispatchChatStreamEvent(
      {
        event: CHAT_STREAM_EVENTS.contextUpdated,
        data: { name: 'repo_notes', filePath: '.contexts/repo_notes.md', size: 84 },
      },
      { onContextUpdated },
    );

    dispatchChatStreamEvent(
      {
        event: CHAT_STREAM_EVENTS.branchOverview,
        data: {
          overview: 'The schema update is ready to ship.',
          seq: 3,
          assistantId: 'a-n1-T1',
          turnId: 'T1',
        },
      },
      { onBranchOverview },
    );

    expect(onContextSaved).toHaveBeenCalledWith(
      'repo_notes',
      '.contexts/repo_notes.md',
      42,
    );
    expect(onContextUpdated).toHaveBeenCalledWith(
      'repo_notes',
      '.contexts/repo_notes.md',
      84,
    );
    expect(onBranchOverview).toHaveBeenCalledWith(
      'The schema update is ready to ship.',
      3,
      'a-n1-T1',
      'T1',
    );
  });
});
