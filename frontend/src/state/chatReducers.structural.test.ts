import { vi } from 'vitest';
import { reduceNodes } from './chatReducers';
import { HIGH_FREQ_ACTIONS } from './chatStore';
import type { ChatAction, ChatNodeState, ToolCallState } from './chatTypes';

// Prevent chatStore's transitive import of ../services/api → chatStreamEvents →
// michi-shared from failing in test environments where that package's
// dist/ is not built. Our test only exercises module-scope constants and pure
// reducer functions — no network/API surface needed.
vi.mock('../services/api', () => ({}));

// Fields that, if mutated by a high-frequency action, would invalidate Part B's
// structure-version optimization (these are the inputs of every selector
// migrated to useStructuralSelector). Listed explicitly so adding a new node
// field does not silently widen the invariant.
const STRUCTURAL_FIELDS = [
  'status', 'kind', 'title', 'deletedAt', 'pinnedAt',
  'markedReadAt', 'seenMessageIds', 'paneWidth', 'digest',
  'lastAssistantAt', 'viewedAt', 'deletionGroupId',
] as const;

function pickStructural(n: ChatNodeState | undefined) {
  if (!n) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of STRUCTURAL_FIELDS) out[k] = (n as unknown as Record<string, unknown>)[k];
  return out;
}

function structuralKeys(nodes: Record<string, ChatNodeState>): string[] {
  return Object.keys(nodes).sort();
}

function makeNode(id: string): ChatNodeState {
  return {
    nodeId: id,
    kind: 'chat',
    chatId: id,
    projectId: 'p1',
    title: 'old',
    status: 'streaming',
    messages: [{ id: `${id}-a0`, role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true, createdAt: 0 }],
    followUps: [],
    seenMessageIds: [],
    markedReadAt: 0,
    lastAssistantAt: 0,
    viewedAt: 0,
    deletionGroupId: undefined,
  } as unknown as ChatNodeState; // shape is verified by reducer at runtime; cast keeps test concise
}

// Sample inputs — one per high-freq action. The action.type values must match
// the HIGH_FREQ_ACTIONS set; if a new high-freq action is added, this test
// will fail to enumerate it (see the coverage assertion below).
const SAMPLE_ACTIONS: Record<string, ChatAction> = {
  chunk: { type: 'chunk', nodeId: 'n1', assistantId: 'n1-a0', text: 'hello' },
  thought: { type: 'thought', nodeId: 'n1', assistantId: 'n1-a0', text: 'mm' },
  heartbeat: { type: 'heartbeat', nodeId: 'n1', idleMs: 250 },
  'tool-call': {
    type: 'tool-call',
    nodeId: 'n1',
    assistantId: 'n1-a0',
    tool: { id: 't1', title: 'read', kind: 'read', status: 'pending' } satisfies ToolCallState,
  },
  'tool-call-update': {
    type: 'tool-call-update',
    nodeId: 'n1',
    assistantId: 'n1-a0',
    tool: { id: 't1', title: 'read', status: 'completed' } satisfies ToolCallState,
  },
  plan: { type: 'plan', nodeId: 'n1', assistantId: 'n1-a0', entries: [] as never[] } as ChatAction,
  'subagent-list-update': { type: 'subagent-list-update', nodeId: 'n1', subagents: [] } as ChatAction,
  'subagent-tool-activity': { type: 'subagent-tool-activity', nodeId: 'n1', subagentSessionId: 's1', title: 'read file', status: 'running' },
  'apply-seq': { type: 'apply-seq', nodeId: 'n1', turnId: 'T1', seq: 1 },
};

describe('HIGH_FREQ_ACTIONS structural invariant', () => {
  it('enumerates a sample for every high-freq action (no surprise additions)', () => {
    const sampled = new Set(Object.keys(SAMPLE_ACTIONS));
    for (const t of HIGH_FREQ_ACTIONS) expect(sampled.has(t)).toBe(true);
    expect(sampled.size).toBe(HIGH_FREQ_ACTIONS.size);
  });

  it.each(Array.from(HIGH_FREQ_ACTIONS))(
    '%s does not change any structural field or the nodes map shape',
    (type) => {
      const before = { n1: makeNode('n1') };
      const action = SAMPLE_ACTIONS[type];
      const after = reduceNodes(before, action);

      // Map shape unchanged (no key add/remove).
      expect(structuralKeys(after)).toEqual(structuralKeys(before));

      // Per-node structural fields unchanged.
      expect(pickStructural(after.n1)).toEqual(pickStructural(before.n1));
    },
  );
});
