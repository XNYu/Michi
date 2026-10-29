import { hydrateBackendWorkspaces, recoverPendingUserInput } from './chatHydration';
import { remoteEntityIdentity } from '../config/backendIdentity';
import type { ChatMessage, ChatNodeState, ArtifactEntry, Project, ProjectEdge, Tree } from './chatTypes';

export interface BackgroundReplayGap {
  chatId: string;
  nodeId?: string;
  turnId: string;
  seq: number;
}

export interface BackgroundGapReconcileInput {
  currentProjects: Project[];
  currentNodes: Record<string, ChatNodeState>;
  rawWorkspace: unknown;
  gap: BackgroundReplayGap;
}

export interface BackgroundGapReconcileResult {
  projects: Project[];
  nodes: Record<string, ChatNodeState>;
  nodeId: string;
}

function edgeKey(edge: ProjectEdge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind ?? 'branch'}`;
}

function mergeById<T extends { id: string }>(server: T[], local: T[]): T[] {
  const result = server.slice();
  const seen = new Set(server.map((item) => item.id));
  for (const item of local) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function mergeContexts(server: ArtifactEntry[] = [], local: ArtifactEntry[] = []): ArtifactEntry[] {
  const result = server.slice();
  const indexById = new Map(result.map((context, index) => [context.id, index] as const));
  const indexByName = new Map(result.map((context, index) => [context.name.toLocaleLowerCase(), index] as const));
  for (const context of local) {
    const index = indexById.get(context.id) ?? indexByName.get(context.name.toLocaleLowerCase());
    if (index !== undefined) {
      if (context.updatedAt >= result[index].updatedAt) result[index] = { ...result[index], ...context };
      continue;
    }
    indexById.set(context.id, result.length);
    indexByName.set(context.name.toLocaleLowerCase(), result.length);
    result.push(context);
  }
  return result;
}

function mergeProject(server: Project, local: Project): Project {
  const trees = mergeById<Tree>(server.trees, local.trees);
  const serverEdges = new Set(server.edges.map(edgeKey));
  const edges = [
    ...server.edges,
    ...local.edges.filter((edge) => !serverEdges.has(edgeKey(edge))),
  ];
  const chatIds = [...server.chatIds];
  const knownChatIds = new Set(chatIds);
  for (const nodeId of local.chatIds) {
    if (knownChatIds.has(nodeId)) continue;
    knownChatIds.add(nodeId);
    chatIds.push(nodeId);
  }
  const localActiveStillExists = local.activeTreeId
    && trees.some((tree) => tree.id === local.activeTreeId);
  return {
    ...server,
    backendConnectionId: local.backendConnectionId,
    chatIds,
    edges,
    trees,
    artifacts: mergeContexts(server.artifacts, local.artifacts),
    activeTreeId: localActiveStillExists ? local.activeTreeId : server.activeTreeId,
  };
}

function rawNodeStatus(rawWorkspace: unknown, nodeId: string): ChatNodeState['status'] {
  if (!rawWorkspace || typeof rawWorkspace !== 'object') return 'idle';
  const rows = (rawWorkspace as { nodes?: unknown }).nodes;
  if (!Array.isArray(rows)) return 'idle';
  const row = rows.find((candidate) =>
    candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === nodeId,
  ) as { status?: unknown } | undefined;
  if (row?.status === 'streaming' || row?.status === 'error') return row.status;
  return 'idle';
}

function markLastAssistantStreaming(messages: ChatMessage[]): ChatMessage[] {
  const index = messages.findLastIndex((message) => message.role === 'assistant');
  if (index < 0) return messages;
  const next = messages.slice();
  const message = next[index];
  next[index] = {
    ...message,
    streaming: true,
    blocks: message.blocks?.map((block, blockIndex, blocks) => {
      if (block.kind !== 'answer' && block.kind !== 'thinking') return block;
      const laterTextBlock = blocks.slice(blockIndex + 1).some(
        (candidate) => candidate.kind === 'answer' || candidate.kind === 'thinking',
      );
      return laterTextBlock ? block : { ...block, streaming: true };
    }),
  };
  return next;
}

function mergeGapNode(
  server: ChatNodeState,
  local: ChatNodeState | undefined,
  gap: BackgroundReplayGap,
  status: ChatNodeState['status'],
): ChatNodeState {
  const messages = status === 'streaming'
    ? markLastAssistantStreaming(server.messages)
    : server.messages;
  return recoverPendingUserInput({
    ...server,
    chatId: server.chatId ?? local?.chatId ?? gap.chatId,
    status,
    pendingUserInput: status === 'streaming' ? server.pendingUserInput : undefined,
    messages,
    messagesLoaded: true,
    messageCount: messages.length,
    lastAppliedBackgroundTurnId: gap.turnId,
    lastAppliedBackgroundSeq: gap.seq,
    // A direct foreground replay may have advanced while the shared feed was
    // disconnected. Its durable cursor is a separate authority and must not
    // be rolled back by this background-only snapshot.
    lastAppliedTurnId: local?.lastAppliedTurnId ?? server.lastAppliedTurnId,
    lastAppliedSeq: local?.lastAppliedSeq ?? server.lastAppliedSeq,
    title: local?.titleNeedsPersistence ? local.title : server.title,
    titleNeedsPersistence: local?.titleNeedsPersistence,
    deletedAt: local?.deletedAt ?? server.deletedAt,
    deletionGroupId: local?.deletionGroupId ?? server.deletionGroupId,
    // The workspace snapshot is canonical for turn output and graph state,
    // but these fields may contain unsent user work newer than the server.
    composerDraft: local ? local.composerDraft : server.composerDraft,
    pendingComments: local?.pendingComments,
    pendingQueued: local?.pendingQueued,
    queueErrored: local?.queueErrored,
    viewedAt: local?.viewedAt ?? server.viewedAt,
    lastAssistantAt: Math.max(local?.lastAssistantAt ?? 0, server.lastAssistantAt ?? 0) || undefined,
    agentCommands: local?.agentCommands,
    // Workspace rows do not include the native session catalog or the result
    // of a host command. Retain them while the binding still uses that runtime.
    sessionState: local?.runtimeId === server.runtimeId ? local?.sessionState : undefined,
    commandResult: local?.commandResult,
  });
}

export interface BackendNodeInstallInput {
  currentProjects: Project[];
  currentNodes: Record<string, ChatNodeState>;
  rawWorkspace: unknown;
  nodeId: string;
}

/**
 * Install or refresh a thread the backend created without this renderer (a
 * scheduled run). Unknown trees/nodes are added; the target node takes the
 * server's messages and durable cursor, so later background frames continue
 * from there. Local-only fields (drafts, queue, view state) are kept.
 */
export function installBackendWorkspaceNode({
  currentProjects,
  currentNodes,
  rawWorkspace,
  nodeId,
}: BackendNodeInstallInput): { projects: Project[]; nodes: Record<string, ChatNodeState> } | null {
  const hydrated = hydrateBackendWorkspaces([rawWorkspace]);
  const serverProject = hydrated.projects[0];
  if (!serverProject) return null;
  const localProject = currentProjects.find((project) => project.id === serverProject.id);
  if (!localProject) return null;
  const serverNode = hydrated.nodes[nodeId];
  if (!serverNode) return null;
  const projects = currentProjects.map((project) =>
    project.id === serverProject.id ? mergeProject(serverProject, localProject) : project,
  );
  const nodes = { ...currentNodes };
  for (const [serverNodeId, node] of Object.entries(hydrated.nodes)) {
    if (!nodes[serverNodeId]) nodes[serverNodeId] = node;
  }
  nodes[nodeId] = mergeGapNode(serverNode, currentNodes[nodeId], {
    chatId: serverNode.chatId ?? currentNodes[nodeId]?.chatId ?? nodeId,
    nodeId,
    turnId: serverNode.lastAppliedBackgroundTurnId ?? '',
    seq: serverNode.lastAppliedBackgroundSeq ?? -1,
  }, rawNodeStatus(rawWorkspace, nodeId));
  return { projects, nodes };
}

/**
 * Install one authoritative full-workspace snapshot after a background replay
 * cursor falls out of the in-memory ring. Existing nodes outside the affected
 * workspace are untouched. Existing sibling nodes are kept live (a foreground
 * turn may be streaming on them); newly discovered server nodes are added.
 */
export function reconcileBackgroundWorkspaceSnapshot({
  currentProjects,
  currentNodes,
  rawWorkspace,
  gap,
}: BackgroundGapReconcileInput): BackgroundGapReconcileResult | null {
  const owner = currentProjects.find(project => project.chatIds.includes(gap.nodeId ?? gap.chatId));
  const connectionId = owner ? remoteEntityIdentity(owner.id)?.connectionId ?? owner.backendConnectionId ?? 'local' : 'local';
  const hydrated = hydrateBackendWorkspaces([rawWorkspace], null, connectionId);
  const serverProject = hydrated.projects[0];
  if (!serverProject) return null;
  const localProject = currentProjects.find((project) => project.id === serverProject.id);
  if (!localProject) return null;

  const nodeId = gap.nodeId
    ?? Object.values(hydrated.nodes).find((node) => node.chatId === gap.chatId)?.nodeId
    ?? Object.values(currentNodes).find((node) => node.chatId === gap.chatId)?.nodeId;
  if (!nodeId) return null;
  const serverGapNode = hydrated.nodes[nodeId];
  if (!serverGapNode) return null;

  const projects = currentProjects.map((project) =>
    project.id === serverProject.id ? mergeProject(serverProject, localProject) : project,
  );
  const nodes = { ...currentNodes };
  for (const [serverNodeId, serverNode] of Object.entries(hydrated.nodes)) {
    if (serverNodeId === nodeId) continue;
    if (!nodes[serverNodeId]) nodes[serverNodeId] = serverNode;
  }
  nodes[nodeId] = mergeGapNode(
    serverGapNode,
    currentNodes[nodeId],
    gap,
    rawNodeStatus(rawWorkspace, nodeId),
  );
  return { projects, nodes, nodeId };
}
