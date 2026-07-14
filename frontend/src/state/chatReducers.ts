import type { ChatAction, ChatNodeState, ComposerDraft, ContextEntry, Project, ProjectAction, Tree } from './chatTypes';
import { computeTranscriptFingerprint } from './transcriptFingerprint';
import {
  appendAnswerBlockText,
  appendImageBlock,
  appendThinkingBlockText,
  appendToolBlock,
  assistantMetadata,
  finalizeAssistantBlocks,
  nextToolBlockPlacement,
} from './assistantBlocks';

export const NODE_ACTIVITY_ACTIONS = new Set<ChatAction['type']>([
  'user-send',
  'done',
  'error',
  'set-title',
  'set-follow-ups',
  'agent-spawn',
  'image-block',
  'permission-request',
  'observer-turn-start',
]);

export function reduceProject(p: Project, a: ProjectAction): Project {
  switch (a.type) {
    case 'create-tree': {
      const tree: Tree = {
        id: a.treeId,
        rootNodeId: a.rootNodeId,
        createdAt: a.now,
        lastActiveAt: a.now,
        ...(a.kind ? { kind: a.kind } : {}),
      };
      return {
        ...p,
        chatIds: p.chatIds.includes(a.rootNodeId) ? p.chatIds : [...p.chatIds, a.rootNodeId],
        trees: [...p.trees, tree],
        activeTreeId: tree.id,
      };
    }
    case 'archive-tree': {
      const trees = p.trees.map((t) => (t.id === a.treeId ? { ...t, archivedAt: a.now } : t));
      let nextActive = p.activeTreeId;
      if (p.activeTreeId === a.treeId) {
        const candidate = [...trees]
          .filter((t) => t.id !== a.treeId && !t.archivedAt)
          .sort((x, y) => y.lastActiveAt - x.lastActiveAt)[0];
        nextActive = candidate ? candidate.id : null;
      }
      return { ...p, trees, activeTreeId: nextActive };
    }
    case 'unarchive-tree': {
      const trees = p.trees.map((t) =>
        t.id === a.treeId ? { ...t, archivedAt: undefined, lastActiveAt: a.now } : t,
      );
      return { ...p, trees };
    }
    case 'pin-tree': {
      const trees = p.trees.map((t) =>
        t.id === a.treeId ? { ...t, pinnedAt: a.now } : t,
      );
      return { ...p, trees };
    }
    case 'unpin-tree': {
      const trees = p.trees.map((t) => {
        if (t.id !== a.treeId) return t;
        const { pinnedAt, ...rest } = t;
        return rest as Tree;
      });
      return { ...p, trees };
    }
    case 'rename-tree': {
      const trees = p.trees.map((t) => (t.id === a.treeId ? { ...t, name: a.name } : t));
      return { ...p, trees };
    }
    case 'activate-tree': {
      // Reject tree ids that don't belong to this project. Without this guard
      // a stale-closure caller (e.g. cross-workspace navigation that reads
      // activeProjectId before setActiveProjectId flushes) can write another
      // workspace's tree id here, which then makes the project look empty
      // until reload because activeTreeRootNodeId / paneKey can't resolve it.
      if (a.treeId !== null && !p.trees.some((t) => t.id === a.treeId)) return p;
      return { ...p, activeTreeId: a.treeId };
    }
    case 'touch-tree': {
      const trees = p.trees.map((t) => (t.id === a.treeId ? { ...t, lastActiveAt: a.now } : t));
      return { ...p, trees };
    }
    case 'upsert-context': {
      const contexts = p.contexts ?? [];
      const now = Date.now();
      if (a.context.id) {
        const idx = contexts.findIndex((c) => c.id === a.context.id);
        if (idx >= 0) {
          const updated = contexts.map((c, i) =>
            i === idx
              ? {
                  ...c,
                  name: a.context.name,
                  filePath: a.context.filePath,
                  size: a.context.size ?? c.size,
                  autoInject: a.context.autoInject ?? c.autoInject,
                  kind: a.context.kind ?? c.kind,
                  updatedAt: now,
                }
              : c,
          );
          return { ...p, contexts: updated };
        }
      }
      let name = a.context.name;
      const names = new Set(contexts.map((c) => c.name.toLowerCase()));
      if (names.has(name.toLowerCase())) {
        let suffix = 2;
        while (names.has(`${a.context.name}-${suffix}`.toLowerCase())) suffix++;
        name = `${a.context.name}-${suffix}`;
      }
      const entry: ContextEntry = {
        id: `ctx-${now}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        filePath: a.context.filePath,
        size: a.context.size,
        autoInject: a.context.autoInject,
        source: a.context.source ?? 'user',
        kind: a.context.kind,
        createdAt: now,
        updatedAt: now,
      };
      return { ...p, contexts: [...contexts, entry] };
    }
    case 'update-context-by-name': {
      const contexts = p.contexts ?? [];
      const now = Date.now();
      const idx = contexts.findIndex((c) => c.name.toLowerCase() === a.context.name.toLowerCase());
      if (idx >= 0) {
        return {
          ...p,
          contexts: contexts.map((c, i) =>
            i === idx
              ? {
                  ...c,
                  name: a.context.name,
                  filePath: a.context.filePath,
                  size: a.context.size ?? c.size,
                  kind: a.context.kind ?? c.kind,
                  updatedAt: now,
                }
              : c,
          ),
        };
      }
      const entry: ContextEntry = {
        id: `ctx-${now}-${Math.random().toString(36).slice(2, 6)}`,
        name: a.context.name,
        filePath: a.context.filePath,
        size: a.context.size,
        source: a.context.source ?? 'agent',
        kind: a.context.kind,
        createdAt: now,
        updatedAt: now,
      };
      return { ...p, contexts: [...contexts, entry] };
    }
    case 'delete-context': {
      return { ...p, contexts: (p.contexts ?? []).filter((c) => c.id !== a.contextId) };
    }
    case 'toggle-auto-inject': {
      const contexts = (p.contexts ?? []).map((c) =>
        c.id === a.contextId ? { ...c, autoInject: !c.autoInject, updatedAt: Date.now() } : c,
      );
      return { ...p, contexts };
    }
    case 'rename-context': {
      if (!/^[\p{L}\p{N}_-]+$/u.test(a.newName)) return p;
      const contexts = p.contexts ?? [];
      const collision = contexts.some(
        (c) => c.id !== a.contextId && c.name.toLowerCase() === a.newName.toLowerCase(),
      );
      if (collision) return p;
      return {
        ...p,
        contexts: contexts.map((c) =>
          c.id === a.contextId ? { ...c, name: a.newName, updatedAt: Date.now() } : c,
        ),
      };
    }
  }
}

function normalizeComposerDraft(draft: ComposerDraft | null): ComposerDraft | null {
  if (!draft) return null;
  const value = draft.value ?? '';
  const mentions = Array.isArray(draft.mentions) ? draft.mentions : [];
  const quotedText = draft.quotedText?.trim() ? draft.quotedText : undefined;
  if (!value && mentions.length === 0 && !quotedText) return null;
  return { value, mentions, quotedText };
}

function composerDraftEqual(a: ComposerDraft | undefined, b: ComposerDraft | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.value !== b.value || (a.quotedText ?? '') !== (b.quotedText ?? '')) return false;
  if (a.mentions.length !== b.mentions.length) return false;
  return a.mentions.every((m, i) => {
    const n = b.mentions[i];
    return (
      m.start === n.start &&
      m.end === n.end &&
      m.kind === n.kind &&
      m.refId === n.refId &&
      m.label === n.label
    );
  });
}

export function reduceNodes(
  nodes: Record<string, ChatNodeState>,
  action: ChatAction,
): Record<string, ChatNodeState> {
  switch (action.type) {
    case 'create': {
      return {
        ...nodes,
        [action.nodeId]: {
          nodeId: action.nodeId,
          kind: 'chat',
          chatId: null,
          projectId: action.projectId,
          parentNodeId: action.parentNodeId,
          mergeSources: action.mergeSources,
          messages: [],
          followUps: [],
          status: 'idle',
          // Desired agent picked before the session exists (e.g. Home composer).
          // Carried as currentModeId so startStream can request it at ensure-session
          // time; bind-chat overwrites it with the runtime's actual mode once bound.
          currentModeId: action.modeId,
          viewedAt: Date.now(),
        },
      };
    }
    case 'bind-chat': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          chatId: action.chatId,
          runtimeId: action.runtimeId ?? n.runtimeId,
          providerId: action.providerId !== undefined ? action.providerId : n.providerId,
          modelId: action.modelId !== undefined ? action.modelId : n.modelId,
          reasoning: action.reasoning !== undefined ? action.reasoning : n.reasoning,
          resumeFingerprint: action.resumeFingerprint !== undefined ? action.resumeFingerprint : n.resumeFingerprint,
          // Preserve the persisted agent across re-bind: a resumed kiro session
          // reports no mode (currentModeId null), so `?? n.currentModeId` keeps
          // the restored value instead of wiping it back to the generic chip.
          // A non-null value (explicit switch) still overwrites.
          currentModeId: action.currentModeId ?? n.currentModeId,
        },
      };
    }
    case 'unbind-chat': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, chatId: null } };
    }
    case 'user-send': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const { composerDraft: _composerDraft, ...draftless } = n;
      return {
        ...nodes,
        [action.nodeId]: {
          ...draftless,
          status: 'streaming',
          streamingStartedAt: Date.now(),
          error: undefined,
          followUps: [],
          followUpsGenerating: false,
          subagents: undefined,
          usageSummary: undefined,
          mcpServerError: undefined,
          messages: [
            ...n.messages,
            {
              id: `u-${action.assistantId}`,
              role: 'user',
              text: action.userText,
              toolCalls: [],
              createdAt: Date.now(),
              quotedText: action.quotedText,
              attachments: action.attachments,
              comments: action.comments,
            },
            { id: action.assistantId, role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true, createdAt: Date.now() },
          ],
        },
      };
    }
    case 'observer-turn-start': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      if (n.messages.some((m) => m.id === action.assistantId)) {
        return {
          ...nodes,
          [action.nodeId]: {
            ...n,
            status: 'streaming',
            streamingStartedAt: n.streamingStartedAt ?? Date.now(),
            error: undefined,
            lastAppliedTurnId: action.turnId,
            lastAppliedSeq: Math.max(n.lastAppliedSeq ?? 0, 0),
          },
        };
      }
      const now = Date.now();
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          status: 'streaming',
          streamingStartedAt: now,
          error: undefined,
          followUps: [],
          followUpsGenerating: false,
          subagents: undefined,
          usageSummary: undefined,
          mcpServerError: undefined,
          lastAppliedTurnId: action.turnId,
          lastAppliedSeq: 0,
          messages: [
            ...n.messages,
            {
              id: `u-${action.assistantId}`,
              role: 'user',
              text: action.userText,
              toolCalls: [],
              createdAt: now,
            },
            {
              id: action.assistantId,
              role: 'assistant',
              text: '',
              toolCalls: [],
              blocks: [],
              streaming: true,
              createdAt: now,
            },
          ],
        },
      };
    }
    case 'apply-seq': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const sameTurn = n.lastAppliedTurnId === action.turnId;
      const prev = sameTurn ? n.lastAppliedSeq ?? -1 : -1;
      if (action.seq <= prev) return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          lastAppliedTurnId: action.turnId,
          lastAppliedSeq: action.seq,
        },
      };
    }
    case 'block-reset': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const msgs = n.messages.map((m) =>
        m.id === action.assistantId
          ? { ...m, text: '', blocks: [], toolCalls: [], streaming: true }
          : m,
      );
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          messages: msgs,
          lastAppliedTurnId: undefined,
          lastAppliedSeq: undefined,
        },
      };
    }
    case 'chunk': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const msgs = n.messages.map((m) =>
        m.id === action.assistantId ? appendAnswerBlockText(m, action.text) : m,
      );
      return { ...nodes, [action.nodeId]: { ...n, messages: msgs, streamingIdleMs: undefined } };
    }
    case 'thought': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const msgs = n.messages.map((m) =>
        m.id === action.assistantId
          ? appendThinkingBlockText(m, action.text)
          : m,
      );
      return { ...nodes, [action.nodeId]: { ...n, messages: msgs, streamingIdleMs: undefined } };
    }
    case 'plan': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const msgs = n.messages.map((m) =>
        m.id === action.assistantId ? { ...m, plan: action.entries } : m,
      );
      return { ...nodes, [action.nodeId]: { ...n, messages: msgs, streamingIdleMs: undefined } };
    }
    case 'tool-call': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const msgs = n.messages.map((m) => {
        if (m.id !== action.assistantId) return m;
        const placement = nextToolBlockPlacement(m);
        const tool = { ...action.tool, textOffset: placement.rawOffset };
        return appendToolBlock({ ...m, toolCalls: [...m.toolCalls, tool] }, tool.id);
      });
      return { ...nodes, [action.nodeId]: { ...n, messages: msgs, streamingIdleMs: undefined } };
    }
    case 'image-block': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const msgs = n.messages.map((m) =>
        m.id === action.assistantId
          ? appendImageBlock(m, {
              // workspaceId is the node's project id (derived here, not passed
              // by the caller — the stream handler only knows nodeId + the
              // retargeted assistantId).
              workspaceId: n.projectId,
              path: action.path,
              caption: action.caption,
              mimeType: action.mimeType,
              size: action.size,
            })
          : m,
      );
      return { ...nodes, [action.nodeId]: { ...n, messages: msgs, streamingIdleMs: undefined } };
    }
    case 'tool-call-update': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const msgs = n.messages.map((m) => {
        if (m.id !== action.assistantId) return m;
        const tcs = m.toolCalls.map((t) => {
          if (t.id !== action.tool.id) return t;
          // Only overwrite fields that have non-empty values — ACP sends
          // tool_call_update with empty title/kind that would clobber
          // values already set by the initial tool_call event.
          const merged = { ...t };
          if (action.tool.title) merged.title = action.tool.title;
          if (action.tool.status) merged.status = action.tool.status;
          if (action.tool.kind) merged.kind = action.tool.kind;
          if (action.tool.detail) merged.detail = action.tool.detail;
          if (action.tool.inputJson) merged.inputJson = action.tool.inputJson;
          if (action.tool.output) merged.output = action.tool.output;
          return merged;
        });
        const exists = tcs.some((t) => t.id === action.tool.id);
        if (exists) return { ...m, toolCalls: tcs };
        const placement = nextToolBlockPlacement(m);
        const addition = { ...action.tool, textOffset: placement.rawOffset };
        return appendToolBlock({ ...m, toolCalls: [...tcs, addition] }, addition.id);
      });
      return { ...nodes, [action.nodeId]: { ...n, messages: msgs, streamingIdleMs: undefined } };
    }
    case 'done': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      let extractedTitle: string | null = null;
      let extractedBranchOverview: string | null = null;
      let extractedFollowUps: string[] = [];
      const msgs = n.messages.map((m) => {
        if (m.id !== action.assistantId) return m;
        const meta = assistantMetadata(m);
        extractedTitle = meta.title;
        extractedBranchOverview = meta.branchOverview;
        extractedFollowUps = meta.followUps;
        // Finalize stuck tool call statuses. The agent's turn has ended, so
        // any tool call still in a non-terminal state must have completed —
        // kiro just didn't send a closing tool_call_update (or sent one with
        // empty status, which the update reducer ignores by design). Without
        // this, chips display "running" forever after the conversation ends.
        const toolCalls = m.toolCalls.map((t) => {
          const stuck =
            !t.status ||
            t.status === 'running' ||
            t.status === 'in_progress' ||
            t.status === 'pending';
          return stuck ? { ...t, status: 'completed' as const } : t;
        });
        return finalizeAssistantBlocks({ ...m, toolCalls });
      });
      // Lock the title once it exists — only fill it in if this is the
      // first turn (no title yet). See `set-title` for the same rule on
      // mid-stream title updates.
      const lockedTitle =
        n.title && n.title.trim().length > 0 ? n.title : extractedTitle ?? n.title;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          status: 'idle',
          streamingStartedAt: undefined,
          error: undefined,
          streamingIdleMs: undefined,
          pendingPermission: null,
          messages: msgs,
          lastAssistantAt: Date.now(),
          followUps: extractedFollowUps.length > 0 ? extractedFollowUps : n.followUps,
          followUpsGenerating: false,
          // Preserve previous source when this turn produced no follow-ups (kept in sync
          // with the followUps preservation above).
          followUpsSourceMessageId:
            extractedFollowUps.length > 0 ? action.assistantId : n.followUpsSourceMessageId,
          title: lockedTitle,
          // A structured branch_overview SSE frame is canonical. Parsing the
          // rendered text remains only for older servers / stored replies.
          branchOverview:
            n.branchOverviewSourceMessageId === action.assistantId
              ? n.branchOverview
              : extractedBranchOverview ?? n.branchOverview,
          resumeFingerprint: computeTranscriptFingerprint(msgs),
        },
      };
    }
    case 'error': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const msgs = n.messages.map((m) =>
        m.id === action.assistantId ? finalizeAssistantBlocks(m) : m,
      );
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          status: 'error',
          streamingStartedAt: undefined,
          error: action.message,
          messages: msgs,
          streamingIdleMs: undefined,
          pendingPermission: null,
          followUpsGenerating: false,
        },
      };
    }
    case 'realign-assistant-id': {
      const n = nodes[action.nodeId];
      if (!n || action.fromId === action.toId) return nodes;
      if (n.messages.some((m) => m.id === action.toId)) return nodes;
      let changed = false;
      const msgs = n.messages.map((m) => {
        if (m.id === action.fromId) {
          changed = true;
          return { ...m, id: action.toId };
        }
        if (m.id === `u-${action.fromId}`) {
          changed = true;
          return { ...m, id: `u-${action.toId}` };
        }
        return m;
      });
      if (!changed) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, messages: msgs } };
    }
    case 'retry-trim': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      let msgs = n.messages;
      if (action.fromIndex != null) {
        // Trim from a specific user message index (keep messages before it).
        msgs = msgs.slice(0, action.fromIndex);
      } else {
        const len = msgs.length;
        if (len >= 2 && msgs[len - 1].role === 'assistant' && msgs[len - 2].role === 'user') {
          msgs = msgs.slice(0, len - 2);
        } else if (len >= 1 && msgs[len - 1].role === 'assistant') {
          msgs = msgs.slice(0, len - 1);
        }
      }
      const liveIds = new Set(msgs.map((m) => m.id));
      const nextFollowUpsSrc =
        n.followUpsSourceMessageId && liveIds.has(n.followUpsSourceMessageId)
          ? n.followUpsSourceMessageId
          : undefined;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          status: 'idle',
          streamingStartedAt: undefined,
          error: undefined,
          streamingIdleMs: undefined,
          messages: msgs,
          followUpsSourceMessageId: nextFollowUpsSrc,
        },
      };
    }
    case 'heartbeat': {
      const n = nodes[action.nodeId];
      if (!n || n.status !== 'streaming') return nodes;
      return { ...nodes, [action.nodeId]: { ...n, streamingIdleMs: action.idleMs } };
    }
    case 'permission-request': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, pendingPermission: action.permission } };
    }
    case 'permission-resolved': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, pendingPermission: null } };
    }
    case 'set-minimized': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, minimized: action.minimized } };
    }
    case 'set-position': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const cur = n.position;
      if (cur && cur.x === action.position.x && cur.y === action.position.y) {
        return nodes;
      }
      return { ...nodes, [action.nodeId]: { ...n, position: action.position } };
    }
    case 'clear-positions': {
      const copy = { ...nodes };
      for (const id of action.nodeIds) {
        const n = copy[id];
        if (n && n.position) {
          const { position, ...rest } = n;
          copy[id] = rest;
        }
      }
      return copy;
    }
    case 'consume-links': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const prev = n.consumedLinks ?? [];
      const merged = Array.from(new Set([...prev, ...action.peerIds]));
      if (merged.length === prev.length) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, consumedLinks: merged } };
    }
    case 'forget-consumed-link': {
      const n = nodes[action.nodeId];
      if (!n || !n.consumedLinks) return nodes;
      const next = n.consumedLinks.filter((id) => id !== action.peerId);
      if (next.length === n.consumedLinks.length) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, consumedLinks: next } };
    }
    case 'create-digest': {
      return {
        ...nodes,
        [action.nodeId]: {
          nodeId: action.nodeId,
          kind: 'digest',
          chatId: null,
          projectId: action.projectId,
          messages: [],
          followUps: [],
          status: 'idle',
          digest: {
            sources: action.sources,
            sourceFingerprints: {},
            content: '',
            generatedAt: 0,
            viewedAt: 0,
            status: 'idle',
          },
        },
      };
    }
    case 'digest-started': {
      const n = nodes[action.nodeId];
      if (!n || n.kind !== 'digest' || !n.digest) return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          digest: { ...n.digest, status: 'streaming', error: undefined, content: '' },
        },
      };
    }
    case 'digest-chunk': {
      const n = nodes[action.nodeId];
      if (!n || n.kind !== 'digest' || !n.digest) return nodes;
      if (n.digest.status !== 'streaming') return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          digest: { ...n.digest, content: n.digest.content + action.text },
        },
      };
    }
    case 'digest-generated': {
      const n = nodes[action.nodeId];
      if (!n || n.kind !== 'digest' || !n.digest) return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          digest: {
            ...n.digest,
            status: 'idle',
            error: undefined,
            content: action.content,
            sourceFingerprints: action.sourceFingerprints,
            generatedAt: action.generatedAt,
            sources: action.sources ?? n.digest.sources,
          },
        },
      };
    }
    case 'digest-error': {
      const n = nodes[action.nodeId];
      if (!n || n.kind !== 'digest' || !n.digest) return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          digest: { ...n.digest, status: 'error', error: action.message },
        },
      };
    }
    case 'digest-set-prompt': {
      const n = nodes[action.nodeId];
      if (!n || n.kind !== 'digest' || !n.digest) return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          digest: { ...n.digest, customPrompt: action.customPrompt || undefined },
        },
      };
    }
    case 'digest-viewed': {
      const n = nodes[action.nodeId];
      if (!n || n.kind !== 'digest' || !n.digest) return nodes;
      if (n.digest.viewedAt >= action.viewedAt) return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          digest: { ...n.digest, viewedAt: action.viewedAt },
        },
      };
    }
    case 'node-viewed': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, viewedAt: action.viewedAt } };
    }
    case 'mark-all-read': {
      // Clear unread on every chat node whose last assistant reply post-dates
      // its last view (mirrors isNodeUnread). Digest nodes track their own
      // read model (digest.viewedAt) and are left alone. Returns the same
      // reference when nothing was unread so consumers skip a re-render.
      let next: Record<string, ChatNodeState> | null = null;
      for (const id in nodes) {
        const n = nodes[id];
        if (n.kind === 'digest') continue;
        if ((n.lastAssistantAt ?? 0) <= (n.viewedAt ?? 0)) continue;
        if (!next) next = { ...nodes };
        next[id] = { ...n, viewedAt: action.viewedAt };
      }
      return next ?? nodes;
    }
    case 'set-title': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const next = action.title.trim();
      if (!next || n.title === next) return nodes;
      // Once a chat node has a title, lock it. Subsequent turns must not
      // rewrite the sidebar label out from under the user. Digest nodes are
      // exempt — their title is derived from regenerated content.
      if (n.kind === 'chat' && n.title && n.title.trim().length > 0) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, title: next } };
    }
    case 'set-branch-overview': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const next = action.overview.trim();
      // Empty / malformed markers must not erase the last useful branch state.
      if (!next || n.branchOverview === next) return nodes;
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          branchOverview: next,
          ...(action.assistantId ? { branchOverviewSourceMessageId: action.assistantId } : {}),
        },
      };
    }
    case 'rename-node': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const next = action.title.trim();
      if (!next || n.title === next) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, title: next } };
    }
    case 'set-follow-ups': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const cleaned = action.followUps
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 3);
      const lastAssistant = [...n.messages].reverse().find((m) => m.role === 'assistant');
      return {
        ...nodes,
        [action.nodeId]: {
          ...n,
          followUps: cleaned,
          followUpsGenerating: false,
          followUpsSourceMessageId: lastAssistant?.id,
        },
      };
    }
    case 'follow-ups-status': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      // `in_progress` is the only interesting transient state — once
      // follow-ups arrive via `set-follow-ups` the flag is cleared there.
      // Terminal statuses (completed/failed) also clear the skeleton, in
      // case follow-ups never actually arrive (e.g. tool errored out).
      const next = action.status === 'in_progress';
      if ((n.followUpsGenerating ?? false) === next) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, followUpsGenerating: next } };
    }
    case 'set-commands': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, agentCommands: action.commands } };
    }
    case 'add-comment': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const existing = n.pendingComments ?? [];
      // Idempotency guard: skip if this exact id is already present. Prevents
      // double-submit from the selection composer from creating dupes.
      if (existing.some((c) => c.id === action.comment.id)) return nodes;
      return {
        ...nodes,
        [action.nodeId]: { ...n, pendingComments: [...existing, action.comment] },
      };
    }
    case 'edit-comment': {
      const n = nodes[action.nodeId];
      if (!n || !n.pendingComments || n.pendingComments.length === 0) return nodes;
      const idx = n.pendingComments.findIndex((c) => c.id === action.commentId);
      if (idx === -1) return nodes;
      const trimmed = action.body.trim();
      if (!trimmed || trimmed === n.pendingComments[idx].body) return nodes;
      const next = [...n.pendingComments];
      next[idx] = { ...next[idx], body: trimmed };
      return { ...nodes, [action.nodeId]: { ...n, pendingComments: next } };
    }
    case 'remove-comment': {
      const n = nodes[action.nodeId];
      if (!n || !n.pendingComments || n.pendingComments.length === 0) return nodes;
      const next = n.pendingComments.filter((c) => c.id !== action.commentId);
      if (next.length === n.pendingComments.length) return nodes;
      const updated = { ...n };
      if (next.length === 0) delete updated.pendingComments;
      else updated.pendingComments = next;
      return { ...nodes, [action.nodeId]: updated };
    }
    case 'clear-comments': {
      const n = nodes[action.nodeId];
      if (!n || !n.pendingComments) return nodes;
      const updated = { ...n };
      delete updated.pendingComments;
      return { ...nodes, [action.nodeId]: updated };
    }
    case 'queue-message': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const existing = n.pendingQueued ?? [];
      // Idempotency guard mirroring add-comment: skip on duplicate id.
      if (existing.some((q) => q.id === action.message.id)) return nodes;
      return {
        ...nodes,
        [action.nodeId]: { ...n, pendingQueued: [...existing, action.message] },
      };
    }
    case 'dequeue-message': {
      const n = nodes[action.nodeId];
      if (!n || !n.pendingQueued || n.pendingQueued.length === 0) return nodes;
      const next = n.pendingQueued.filter((q) => q.id !== action.messageId);
      if (next.length === n.pendingQueued.length) return nodes;
      const updated = { ...n };
      if (next.length === 0) delete updated.pendingQueued;
      else updated.pendingQueued = next;
      return { ...nodes, [action.nodeId]: updated };
    }
    case 'flush-queue': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      if (!n.pendingQueued && !n.queueErrored) return nodes;
      const updated = { ...n };
      delete updated.pendingQueued;
      delete updated.queueErrored;
      return { ...nodes, [action.nodeId]: updated };
    }
    case 'mark-queue-errored': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      // Only mark errored when there's actually a queue to pause; matching
      // the spec's "error preserves a non-empty queue" semantics.
      if (!n.pendingQueued || n.pendingQueued.length === 0) return nodes;
      if (n.queueErrored) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, queueErrored: true } };
    }
    case 'set-current-mode': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, currentModeId: action.currentModeId } };
    }
    case 'set-pane-width': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const updated = { ...n };
      if (action.width === undefined) delete updated.paneWidth;
      else updated.paneWidth = action.width;
      return { ...nodes, [action.nodeId]: updated };
    }
    case 'agent-spawn': {
      const copy = { ...nodes };
      for (const spawned of action.nodes) {
        copy[spawned.nodeId] = {
          nodeId: spawned.nodeId,
          kind: 'chat',
          chatId: spawned.chatId,
          runtimeId: spawned.runtimeId,
          projectId: action.projectId,
          parentNodeId: action.parentNodeId,
          messages: [
            { id: `u-${spawned.nodeId}-0`, role: 'user', text: spawned.prompt, toolCalls: [], createdAt: Date.now() },
            { id: `a-${spawned.nodeId}-0`, role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true, createdAt: Date.now() },
          ],
          followUps: [],
          title: spawned.title,
          status: 'streaming',
          streamingStartedAt: Date.now(),
          spawnedByAgent: true,
        };
      }
      const parent = copy[action.parentNodeId] ?? nodes[action.parentNodeId];
      if (parent) {
        const msgs = parent.messages.map((m, i, arr) => {
          if (i !== arr.length - 1) return m;
          if (m.role !== 'assistant') return m;
          const placement = nextToolBlockPlacement(m);
          const tool = {
            id: `spawn-${Date.now()}-${action.nodes[0]?.nodeId ?? 'na'}`,
            title: `Spawned ${action.nodes.length} branch${action.nodes.length === 1 ? '' : 'es'}: ${action.nodes.map((n) => n.title).join(', ')}`,
            status: 'completed',
            kind: 'spawn_branches',
            textOffset: placement.rawOffset,
          };
          return appendToolBlock({ ...m, toolCalls: [...m.toolCalls, tool] }, tool.id);
        });
        copy[action.parentNodeId] = { ...parent, messages: msgs };
      }
      return copy;
    }
    case 'subagent-list-update': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, subagents: action.subagents } };
    }
    case 'subagent-tool-activity': {
      const n = nodes[action.nodeId];
      if (!n || !n.subagents) return nodes;
      const subagents = n.subagents.map(s =>
        s.sessionId === action.subagentSessionId
          ? { ...s, currentTool: action.title || s.currentTool }
          : s
      );
      return { ...nodes, [action.nodeId]: { ...n, subagents } };
    }
    case 'context-usage': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n, contextUsagePercentage: action.contextUsagePercentage } };
    }
    case 'usage-summary': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n,
        contextUsagePercentage: action.contextUsagePercentage,
        usageSummary: { totalCredits: action.totalCredits, turnDurationMs: action.turnDurationMs },
      } };
    }
    case 'mcp-server-error': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      return { ...nodes, [action.nodeId]: { ...n,
        mcpServerError: { serverName: action.serverName, error: action.error },
      } };
    }
    case 'set-composer-draft': {
      const n = nodes[action.nodeId];
      if (!n) return nodes;
      const draft = normalizeComposerDraft(action.draft);
      if (composerDraftEqual(n.composerDraft, draft)) return nodes;
      const updated = { ...n };
      if (draft) updated.composerDraft = draft;
      else delete updated.composerDraft;
      return { ...nodes, [action.nodeId]: updated };
    }
  }
}
