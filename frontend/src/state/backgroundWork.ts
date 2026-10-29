import {
  boundActivity,
  isBackgroundSubagentPending,
  isWorkflowRunOpen,
  mergeActivityLists,
  untrackedSubagent,
} from 'michi-shared';
import type { ChatMessage, ChatNodeState, SubagentInfo } from './chatTypes';
import { agentResourceKey } from './agentIdentity';
import type { LocatedWorkflowRun, NodeBackgroundSubagentLiveness } from './workflowDomain';
import { buildTree, type TreeEdge, type TreeNode } from './tree';

/**
 * Background work of a conversation: the subagents its turns delegated to
 * and the workflow runs its agent launched. The pane-title badge counts the
 * running items; the Background work drawer lists what `selectBackgroundWork`
 * keeps.
 */

/**
 * The conversation's background subagents a live agent process still
 * tracks (the workflow-runs feed's BackgroundSubagentsUpdateV1, see
 * selectLiveBackgroundSubagents): undefined while that is unknown, which
 * leaves every entry as its roster says. While the feed reconnects, its
 * last word (StaleBackgroundSubagents), which speaks only for agents that
 * started before it disconnected (trackedSubagentIds).
 */
export type LiveBackgroundSubagents = NodeBackgroundSubagentLiveness;

/**
 * Still running: working now, or its turn ended while it kept running in the
 * background (its outcome lands in a later turn).
 */
export function isSubagentActive(subagent: SubagentInfo): boolean {
  if (subagent.status === 'working') return true;
  return subagent.status === 'terminated' && subagent.background === true && !subagent.outcome;
}

/**
 * Running in this conversation now. A turn's end turns its `working` agents
 * into `terminated` (finalizeSubagentRoster), so a foreground `working`
 * entry only means running while the turn that holds it streams: the newest
 * copy sits in the conversation's latest assistant message and the
 * conversation streams. A foreground `working` entry in an earlier message
 * is a leftover (a legacy roster that was never closed, a turn stopped
 * before its end landed), even while a later turn streams.
 *
 * A background agent runs past its turn, so it counts like isSubagentActive
 * says, whichever message holds its newest copy: `working` until that
 * turn's end lands (which can come after the next turn started), then
 * terminated without an outcome. Its completion arrives with a later turn's
 * copy, which conversationSubagents prefers (verified with Claude Code
 * 2.1.305: the CLI starts a turn of its own on completion). When the
 * process that ran it ends first, that completion never comes: with the
 * conversation's liveness known, isSubagentUntracked takes it out.
 */
export function isSubagentRunningIn(
  node: Pick<ChatNodeState, 'status'> & Partial<Pick<ChatNodeState, 'backgroundTurnAssistantId'>>,
  entry: ConversationSubagent,
  latestAssistantId: string | undefined,
): boolean {
  if (entry.subagent.status === 'working' && !entry.subagent.background) {
    if (latestAssistantId === undefined || entry.messageId !== latestAssistantId) return false;
    // After the visible answer the node is idle while the turn's metadata
    // tail still streams; its roster is final only once `done` lands.
    return node.status === 'streaming' || node.backgroundTurnAssistantId === entry.messageId;
  }
  return isSubagentActive(entry.subagent);
}

export function latestAssistantMessageId(messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') return messages[index].id;
  }
  return undefined;
}

/**
 * The roster a transcript message shows: its durable roster, or the live
 * node roster for the tail turn (messages saved before rosters were
 * persisted). Mirrors PaneMessageList.
 */
export function messageSubagentRoster(
  node: Pick<ChatNodeState, 'subagents'>,
  message: ChatMessage,
  tailAssistantId: string | undefined,
): readonly SubagentInfo[] | undefined {
  if (message.role !== 'assistant') return undefined;
  return message.subagents ?? (message.id === tailAssistantId ? node.subagents : undefined);
}

export interface ConversationSubagent {
  /**
   * This subagent across the conversation's turns: the newest copy, with
   * what it lacks filled in from older copies (foldSubagentCopies).
   */
  subagent: SubagentInfo;
  /** Assistant message whose roster holds the newest copy. */
  messageId: string;
}

/** Fields that describe the agent's state now: the newer copy's value stands, even when absent. */
const NEWER_COPY_WINS = [
  'status', 'outcome', 'result', 'error', 'usage', 'endedAt', 'currentTool', 'statusMessage', 'background',
] as const satisfies ReadonlyArray<keyof SubagentInfo>;

/** How the agent ended: kept from the older copy once it knows the outcome (foldSubagentCopies). */
const END_FIELDS: ReadonlySet<keyof SubagentInfo> = new Set(['outcome', 'result', 'error', 'usage', 'endedAt']);

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Both copies' steps. Each message records only its own turn's steps, and
 * counts only the ones it dropped, so the lists are merged by id (the older
 * order, the newer copy updating a step both hold, new steps appended),
 * bounded to SUBAGENT_LIMITS.activity, and the drop counts summed with the
 * overflow. A copy without steps leaves the other's list as it is.
 */
function foldActivity(older: SubagentInfo, newer: SubagentInfo): Pick<SubagentInfo, 'activity' | 'activityDropped'> {
  const dropped = ((older.activityDropped ?? 0) + (newer.activityDropped ?? 0)) || undefined;
  if (!newer.activity?.length) return { activity: older.activity, activityDropped: dropped };
  if (!older.activity?.length) return { activity: newer.activity, activityDropped: dropped };
  // `now` only stamps a time a step lacks, as the live fold does.
  return boundActivity(mergeActivityLists(older.activity, newer.activity, Date.now()), dropped);
}

const foldCache = new WeakMap<SubagentInfo, WeakMap<SubagentInfo, SubagentInfo>>();

/**
 * One subagent from two copies in different turns' rosters (a background
 * agent's launch copy and the completion a later turn carries). The newer
 * copy says how it stands now (NEWER_COPY_WINS); what it lacks (prompt,
 * description, model, startedAt, names…) comes from the older copy.
 *
 * A known outcome is final, as in mergeSubagentEntry: a newer copy that is
 * not `working` and has no outcome (a Codex child closed after it
 * completed reports a bare terminated state) keeps the older copy's
 * outcome, result, error, usage and endedAt (the newer copy's value only
 * fills one the older lacks). Only a `working` copy (the agent runs again)
 * clears them; a newer outcome replaces them all.
 *
 * Activity is the union of both copies' steps (foldActivity): the Claude
 * tracker and the Codex republish carry no steps, and each turn records
 * its own.
 *
 * Not shared mergeSubagentEntry: its first-end-time-wins rule would keep
 * the launch turn's endedAt (finalizeSubagentRoster stamps it).
 *
 * Memoized per pair, so unchanged copies fold to the same object and
 * reference-equality selectors stay quiet.
 */
export function foldSubagentCopies(older: SubagentInfo, newer: SubagentInfo): SubagentInfo {
  let byNewer = foldCache.get(older);
  const cached = byNewer?.get(newer);
  if (cached) return cached;
  const folded: Record<string, unknown> = { ...older };
  for (const [key, value] of Object.entries(newer)) {
    if (hasValue(value)) folded[key] = value;
  }
  const keepEnd = !!older.outcome && !newer.outcome && newer.status !== 'working';
  for (const key of NEWER_COPY_WINS) {
    const value = keepEnd && END_FIELDS.has(key) && hasValue(older[key]) ? older[key] : newer[key];
    if (value === undefined) delete folded[key];
    else folded[key] = value;
  }
  const activity = foldActivity(older, newer);
  for (const key of ['activity', 'activityDropped'] as const) {
    if (activity[key] === undefined) delete folded[key];
    else folded[key] = activity[key];
  }
  const value = folded as unknown as SubagentInfo;
  if (!byNewer) {
    byNewer = new WeakMap();
    foldCache.set(older, byNewer);
  }
  byNewer.set(newer, value);
  return value;
}

interface ConversationSubagentIndex {
  entries: ConversationSubagent[];
  bySession: Map<string, ConversationSubagent>;
}

const conversationSubagentCache = new WeakMap<ChatNodeState, ConversationSubagentIndex>();

function conversationSubagentIndex(node: ChatNodeState): ConversationSubagentIndex {
  const cached = conversationSubagentCache.get(node);
  if (cached) return cached;
  const tailAssistantId = latestAssistantMessageId(node.messages);
  const bySession = new Map<string, ConversationSubagent>();
  for (const message of node.messages) {
    const roster = messageSubagentRoster(node, message, tailAssistantId);
    if (!roster) continue;
    for (const subagent of roster) {
      const previous = bySession.get(subagent.sessionId);
      // Map keeps the first insertion position; set() replaces the value.
      bySession.set(subagent.sessionId, {
        subagent: previous ? foldSubagentCopies(previous.subagent, subagent) : subagent,
        messageId: message.id,
      });
    }
  }
  const index = { entries: [...bySession.values()], bySession };
  conversationSubagentCache.set(node, index);
  return index;
}

/**
 * Every subagent a conversation's turns spawned, deduped by sessionId. The
 * copies of one agent are folded with the later turn's copy winning (a
 * background agent's completion arrives with a later reply); order is
 * first-seen.
 */
export function conversationSubagents(node: ChatNodeState): ConversationSubagent[] {
  return conversationSubagentIndex(node).entries;
}

/** When this renderer first saw each (node, agent) pending in the background (Date.now()). */
const firstSeenPending = new Map<string, number>();
const FIRST_SEEN_LIMIT = 5_000;

function pendingSeenAt(nodeId: string, sessionId: string): number {
  const key = `${nodeId}\u0000${sessionId}`;
  let at = firstSeenPending.get(key);
  if (at === undefined) {
    at = Date.now();
    if (firstSeenPending.size >= FIRST_SEEN_LIMIT) firstSeenPending.delete(firstSeenPending.keys().next().value!);
    firstSeenPending.set(key, at);
  }
  return at;
}

/**
 * The ids one pending background agent is judged by: current liveness as
 * it is. A disconnected feed's last word only for an agent this renderer
 * already saw pending in the background before the disconnect: the backend
 * listed it before it published that copy, so the last word covers it, and
 * a process that had ended by then cannot bring it back. A stopped agent
 * therefore does not light up again while the feed reconnects. One first
 * seen pending since (launched, or backgrounded at a turn's end, during the
 * outage) is unknown (undefined). One clock: no backend time is compared.
 */
function trackedSubagentIds(live: LiveBackgroundSubagents, nodeId: string, subagent: SubagentInfo): ReadonlySet<string> | undefined {
  const seenAt = pendingSeenAt(nodeId, subagent.sessionId);
  if (!live || !('staleSince' in live)) return live;
  return seenAt < live.staleSince ? live.ids : undefined;
}

/** Tests: forget when agents were first seen pending. */
export function resetPendingSightingsForTest(): void {
  firstSeenPending.clear();
}

/**
 * Whether a background agent waiting for its outcome ran in an agent
 * process that has ended (restart, quit, Stop, model switch, crash, idle
 * session release): its liveness is known and no live process tracks it,
 * so its completion will never arrive. Unknown liveness says nothing.
 *
 * Not while the conversation streams and its latest assistant message
 * holds the newest copy: the stream can mark an agent background just
 * before the feed names it live.
 */
function isSubagentUntracked(
  node: Pick<ChatNodeState, 'status' | 'nodeId'>,
  entry: ConversationSubagent,
  latestAssistantId: string | undefined,
  live: LiveBackgroundSubagents,
): boolean {
  if (!isBackgroundSubagentPending(entry.subagent)) return false;
  const tracked = trackedSubagentIds(live, node.nodeId, entry.subagent);
  if (!tracked || tracked.has(entry.subagent.sessionId)) return false;
  return !(node.status === 'streaming' && latestAssistantId !== undefined && entry.messageId === latestAssistantId);
}

const untrackedCache = new WeakMap<SubagentInfo, SubagentInfo>();

/** untrackedSubagent, one object per source copy, so reference-equality selectors stay quiet. */
function untrackedCopy(subagent: SubagentInfo): SubagentInfo {
  let value = untrackedCache.get(subagent);
  if (!value) {
    value = untrackedSubagent(subagent);
    untrackedCache.set(subagent, value);
  }
  return value;
}

export interface ConversationSubagentState extends ConversationSubagent {
  /**
   * Running now (isSubagentRunningIn). An untracked agent (no live process
   * tracks it) is not, and its `subagent` reads stopped (untrackedSubagent).
   */
  active: boolean;
}

/**
 * The agent as the conversation shows it now: an untracked one stopped,
 * any other as folded, with whether it runs. Applied after the per-node
 * caches, so liveness changes need no new node objects.
 */
function presentConversationSubagent(
  node: Pick<ChatNodeState, 'status' | 'nodeId' | 'backgroundTurnAssistantId'>,
  entry: ConversationSubagent,
  latestAssistantId: string | undefined,
  live: LiveBackgroundSubagents,
): ConversationSubagentState {
  if (isSubagentUntracked(node, entry, latestAssistantId, live)) {
    return { subagent: untrackedCopy(entry.subagent), messageId: entry.messageId, active: false };
  }
  return { ...entry, active: isSubagentRunningIn(node, entry, latestAssistantId) };
}

/** One subagent of a conversation by sessionId, for the transcript line. */
export function conversationSubagentState(
  node: ChatNodeState,
  sessionId: string,
  live?: LiveBackgroundSubagents,
): ConversationSubagentState | undefined {
  const entry = conversationSubagentIndex(node).bySession.get(sessionId);
  if (!entry) return undefined;
  return presentConversationSubagent(node, entry, latestAssistantMessageId(node.messages), live);
}

/** Running subagents of one conversation (the pane-title badge); untracked agents do not count. */
export function countActiveSubagents(node: ChatNodeState, live?: LiveBackgroundSubagents): number {
  const latestId = latestAssistantMessageId(node.messages);
  let count = 0;
  for (const entry of conversationSubagents(node)) {
    if (!isSubagentUntracked(node, entry, latestId, live) && isSubagentRunningIn(node, entry, latestId)) count += 1;
  }
  return count;
}

/** Where a workflow run was launched, as far as placement needs to know. */
export interface WorkflowLaunchSite {
  parentToolCallId: string | null;
  startedAt: number;
}

/**
 * Resolves the assistant message a workflow run belongs to: the message whose
 * tool call launched it, else the last assistant message that existed when it
 * started. PaneMessageList places the run's card under that message.
 */
export function workflowMessageResolver(messages: readonly ChatMessage[]): (site: WorkflowLaunchSite) => string | undefined {
  let messageByTool: Map<string, string> | undefined;
  const anchorFor = (startedAt: number): string | undefined => {
    let anchor: string | undefined;
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (anchor && message.createdAt !== undefined && message.createdAt > startedAt) break;
      anchor = message.id;
    }
    return anchor;
  };
  return (site) => {
    if (site.parentToolCallId) {
      if (!messageByTool) {
        messageByTool = new Map();
        for (const message of messages) {
          if (message.role !== 'assistant') continue;
          for (const tool of message.toolCalls) messageByTool.set(tool.id, message.id);
        }
      }
      const owner = messageByTool.get(site.parentToolCallId);
      if (owner) return owner;
    }
    return anchorFor(site.startedAt);
  };
}

export interface BackgroundSubagentItem {
  subagent: SubagentInfo;
  messageId: string;
  active: boolean;
  /** Spawned (or last reported) by the conversation's latest assistant turn. */
  latestTurn: boolean;
}

export interface BackgroundWorkflowItem {
  run: LocatedWorkflowRun;
  runKey: string;
  /** Assistant message the run belongs to, when the transcript has one. */
  messageId?: string;
  active: boolean;
  latestTurn: boolean;
}

export interface BackgroundWork {
  subagents: BackgroundSubagentItem[];
  workflows: BackgroundWorkflowItem[];
}

/**
 * Items shown even when the history rule would hide them: the item the
 * drawer was opened on and every item it has shown since.
 */
export interface BackgroundWorkKeep {
  subagentIds?: ReadonlySet<string>;
  runKeys?: ReadonlySet<string>;
}

function activeFirst<T extends { active: boolean }>(items: T[]): T[] {
  // Array.prototype.sort is stable: chronological order holds within groups.
  return items.sort((a, b) => Number(b.active) - Number(a.active));
}

/**
 * The history rule: what the Background work drawer lists for one
 * conversation.
 *
 * - every subagent and workflow run that is still running (a workflow that
 *   is running or paused), whichever turn started it;
 * - everything the conversation's latest assistant turn started, finished
 *   or not;
 * - items in `keep` (the item the drawer was opened on, and what it has
 *   shown since, so nothing leaves the list while it stays open).
 *
 * Finished work from earlier turns is hidden: the transcript still shows it
 * where it happened. Running items come first, then chronological order.
 * `runs` may hold any runs; only this node's are considered. With `live`
 * known, a background agent no live process tracks reads stopped and does
 * not run (presentConversationSubagent).
 */
export function selectBackgroundWork(
  node: ChatNodeState,
  runs: readonly LocatedWorkflowRun[],
  keep: BackgroundWorkKeep = {},
  live?: LiveBackgroundSubagents,
): BackgroundWork {
  const latestId = latestAssistantMessageId(node.messages);
  const subagents: BackgroundSubagentItem[] = [];
  for (const entry of conversationSubagents(node)) {
    const { subagent, messageId, active } = presentConversationSubagent(node, entry, latestId, live);
    const latestTurn = latestId !== undefined && messageId === latestId;
    if (active || latestTurn || keep.subagentIds?.has(subagent.sessionId)) {
      subagents.push({ subagent, messageId, active, latestTurn });
    }
  }

  const resolve = workflowMessageResolver(node.messages);
  const workflows: BackgroundWorkflowItem[] = [];
  const own = runs
    .filter((resource) => resource.value.nodeId === node.nodeId)
    .sort((a, b) => a.value.startedAt - b.value.startedAt);
  for (const run of own) {
    const runKey = agentResourceKey({ backendConnectionId: run.backendConnectionId, id: run.value.id });
    const messageId = resolve(run.value);
    const active = isWorkflowRunOpen(run.value);
    const latestTurn = latestId !== undefined && messageId === latestId;
    if (active || latestTurn || keep.runKeys?.has(runKey)) {
      workflows.push({ run, runKey, messageId, active, latestTurn });
    }
  }
  return { subagents: activeFirst(subagents), workflows: activeFirst(workflows) };
}

export interface RunningWorkCounts {
  subagents: number;
  workflows: number;
}

/** "2 subagents · 1 workflow running"; undefined when nothing runs. */
export function describeRunningWork({ subagents, workflows }: RunningWorkCounts): string | undefined {
  const parts = [
    subagents > 0 ? `${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}` : undefined,
    workflows > 0 ? `${workflows} ${workflows === 1 ? 'workflow' : 'workflows'}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' · ')} running` : undefined;
}

/** What the top-bar background work button shows, for one conversation. */
export interface BackgroundWorkIndicator {
  /** The conversation its click opens the Background work drawer on. */
  nodeId: string;
  running: RunningWorkCounts;
  /** Items the drawer lists for it now (selectBackgroundWork), running or not. */
  total: number;
  /** Work runs while the conversation waits for the user's approval. */
  waiting: boolean;
}

/**
 * The conversation the top-bar button speaks for, among open chat panes:
 * the focused one when the drawer has anything to list for it (work that
 * runs, or what its latest turn started, finished or not), else the first
 * one with work running. Null when there is none, and the button hides.
 * `liveness` is the workflow domain's (a background agent no live process
 * tracks reads stopped).
 */
export function selectBackgroundWorkIndicator(
  nodes: Readonly<Record<string, ChatNodeState>>,
  paneIds: readonly string[],
  focusedId: string | null | undefined,
  runs: readonly LocatedWorkflowRun[],
  liveness?: (workspaceId: string, nodeId: string) => LiveBackgroundSubagents,
): BackgroundWorkIndicator | null {
  const summarize = (id: string): BackgroundWorkIndicator | null => {
    const node = nodes[id];
    if (node?.kind !== 'chat' || node.deletedAt) return null;
    const work = selectBackgroundWork(node, runs, {}, liveness?.(node.projectId, node.nodeId));
    const total = work.subagents.length + work.workflows.length;
    if (total === 0) return null;
    const running = {
      subagents: work.subagents.filter((item) => item.active).length,
      workflows: work.workflows.filter((item) => item.active).length,
    };
    const busy = running.subagents + running.workflows > 0;
    return { nodeId: id, running, total, waiting: busy && !!node.pendingPermission };
  };
  if (focusedId && paneIds.includes(focusedId)) {
    const focused = summarize(focusedId);
    if (focused) return focused;
  }
  for (const id of paneIds) {
    if (id === focusedId) continue;
    const other = summarize(id);
    if (other && other.running.subagents + other.running.workflows > 0) return other;
  }
  return null;
}

export function sameBackgroundWorkIndicator(a: BackgroundWorkIndicator | null, b: BackgroundWorkIndicator | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.nodeId === b.nodeId && a.total === b.total && a.waiting === b.waiting
    && a.running.subagents === b.running.subagents && a.running.workflows === b.running.workflows;
}

/**
 * Chat nodes of a thread in tree order (root first, depth-first), skipping
 * deleted nodes and non-chat nodes (digests, artifacts).
 */
export function threadConversationIds(
  rootNodeId: string | null | undefined,
  edges: readonly TreeEdge[],
  nodes: Record<string, ChatNodeState>,
): string[] {
  if (!rootNodeId) return [];
  const alive = (id: string) => !!nodes[id] && !nodes[id].deletedAt;
  if (!alive(rootNodeId)) return [];
  const ids: string[] = [];
  const walk = (tree: TreeNode) => {
    if (nodes[tree.nodeId]?.kind === 'chat') ids.push(tree.nodeId);
    for (const child of tree.children) walk(child);
  };
  walk(buildTree(rootNodeId, edges, alive));
  return ids;
}
