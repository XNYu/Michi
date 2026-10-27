import { AgentRunCompletionMode, AgentRunInvocationMode, AgentRunStatus, parseAgentRunDtoV1, type AgentRunDtoV1 } from 'michi-shared';

/** Compact deterministic history: counts are per pane, with fixed CJK/Markdown/tool mix. */
export function longConversationMessages(pane: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const assistant = index % 2 === 1;
    const id = `${assistant ? 'a' : 'u'}-n${pane}-${index}`;
    return {
      id, role: assistant ? 'assistant' : 'user',
      text: assistant ? `回答 ${index}: **stable history** · 日本語と中文 · \`item-${index}\`.` : `Question ${index}: inspect deterministic fixture.`,
      toolCalls: [], streaming: false, createdAt: 1_780_000_000_000 + index,
    };
  });
}

export function longConversationRuns(panes: number, messages: number, count: number): AgentRunDtoV1[] {
  return Array.from({ length: count }, (_, index) => parseAgentRunDtoV1({
    version: 1, id: `perf-run-${index}`, ownerUserId: 'local-user', workspaceId: 'perf-workspace',
    definitionId: null, definitionRevision: null,
    parentMessageId: `a-n${index % panes}-${(Math.floor(index / panes) * 2 + 1) % messages}`,
    parentNodeId: `n${index % panes}`, parentToolCallId: `tool-${index % 3}`,
    parentRunId: null, parentAttemptId: null, parentTurnId: 'perf-turn',
    invocationMode: AgentRunInvocationMode.Delegated, completionMode: AgentRunCompletionMode.Detach,
    createdAt: 1_780_000_000_000 + count - index, startedAt: 1_780_000_001_000, completedAt: 1_780_000_002_000,
    effectiveDefinition: {
      version: 1, name: `Fixture ${index}`, description: 'Fixture', instructions: 'Fixture', runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] },
      permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 1000, maxAttempts: 1 },
      contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100 },
    },
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/mock', sourceWorkspaceId: 'perf-workspace', snapshotHash: 'a'.repeat(64), createdAt: 1 },
    task: 'Deterministic run fixture', status: AgentRunStatus.Completed, waitingReason: null, activeAttemptId: null,
    resultBundle: null, latestEventSeq: 0, archivedAt: null, expiresAt: null,
  }));
}
