import { pageSegmentSources, parsePageBlockInput, retainUserPageSegmentSources, type ChangeEvidence } from 'michi-shared';
import { getDb } from '../db';
import { PageWriteError } from '../pages/core';

/**
 * What each home run read, so a block can cite only that. A home run lives
 * inside one scheduler run of this process (a restart supersedes it), so the
 * record is kept in memory and bounded.
 */
const RUNS_KEPT = 64;
const readMessages = new Map<string, Map<string, string>>();
const readHomes = new Map<string, Set<string>>();

export const MAX_BLOCK_SOURCES = 5;
const MAX_NAMED_SOURCES = 10;

function entry<T>(map: Map<string, T>, runId: string, create: () => T): T {
  let value = map.get(runId);
  if (!value) {
    value = create();
    map.set(runId, value);
    while (map.size > RUNS_KEPT) map.delete(map.keys().next().value!);
  }
  return value;
}

/** Message lines of a read_node answer, as `globalContext.readNode` writes them with message ids. */
const MESSAGE_LINE = /^(?:user|assistant) \[message ([^\]\s]+)\]: /gm;

/** Records the messages a read_node answer showed this run. */
export function noteReadMessages(runId: string, nodeId: string, text: string): void {
  const messages = entry(readMessages, runId, () => new Map<string, string>());
  for (const match of text.matchAll(MESSAGE_LINE)) messages.set(match[1]!, nodeId);
}

export function noteReadHome(runId: string, workspaceId: string): void {
  entry(readHomes, runId, () => new Set<string>()).add(workspaceId);
}

export function readHomeCount(runId: string): number {
  return readHomes.get(runId)?.size ?? 0;
}

export function forgetHomeRunReads(runId: string): void {
  readMessages.delete(runId);
  readHomes.delete(runId);
}

export interface DroppedSource { op: number; nodeId: unknown; messageId: unknown; reason: string }

export interface CitedOps {
  /** The operations without their `sources`, as the page writer parses them. */
  ops: unknown;
  /** Per operation index: the messages it cites that the run read. */
  evidence: ChangeEvidence[][];
  dropped: DroppedSource[];
}

type MessageRow = { role: string };
type TurnRow = { turn_id: string; user_message_id: string | null; assistant_message_id: string };

/**
 * Takes each operation's `sources` (conversation and message ids the agent
 * names) and keeps those this run read with read_node, from a conversation in
 * its range. Anything else is dropped, never replaced: a block whose sources
 * are all dropped cites no message.
 */
export function citedOps(input: { runId: string; rawOps: unknown; nodeIds: ReadonlySet<string> }): CitedOps {
  if (!Array.isArray(input.rawOps)) return { ops: input.rawOps, evidence: [], dropped: [] };
  const read = readMessages.get(input.runId);
  const message = getDb().prepare("SELECT role FROM messages WHERE id=? AND node_id=? AND role IN ('user','assistant')");
  const turn = getDb().prepare('SELECT turn_id,user_message_id,assistant_message_id FROM turns WHERE node_id=? AND (assistant_message_id=? OR user_message_id=?) ORDER BY started_at DESC LIMIT 1');
  const dropped: DroppedSource[] = [];
  const evidence: ChangeEvidence[][] = [];
  const ops = input.rawOps.map((raw, index) => {
    evidence[index] = [];
    // Per-passage citations may only name the exact assistant messages this run read.
    // Unlike a best-effort block-level source note, a wrong passage citation must never be published.
    const content = raw && typeof raw === 'object' && 'block' in raw ? parsePageBlockInput(raw.block) : null;
    for (const source of content ? pageSegmentSources(content) : []) {
      const owner = turn.get(source.nodeId, source.assistantId, source.assistantId) as TurnRow | undefined;
      if (!input.nodeIds.has(source.nodeId) || read?.get(source.assistantId) !== source.nodeId || !owner ||
        owner.turn_id !== source.turnId || owner.assistant_message_id !== source.assistantId) {
        throw new PageWriteError(400, 'invalid', 'Segment sources must cite exact assistant messages read_node showed this run');
      }
      if (!evidence[index]!.some(prior => prior.assistantId === source.assistantId)) evidence[index]!.push(source);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('sources' in raw)) return raw;
    const { sources, ...op } = raw as Record<string, unknown>;
    const named = Array.isArray(sources) ? sources.slice(0, MAX_NAMED_SOURCES) : [];
    if (!Array.isArray(sources)) dropped.push({ op: index, nodeId: null, messageId: null, reason: 'sources must be a list of {nodeId, messageId}' });
    const seen = new Set(evidence[index]!.map(source => source.messageId ?? source.assistantId));
    for (const item of named) {
      const nodeId = (item as { nodeId?: unknown } | null)?.nodeId;
      const messageId = (item as { messageId?: unknown } | null)?.messageId;
      const drop = (reason: string) => { dropped.push({ op: index, nodeId, messageId, reason }); };
      if (typeof nodeId !== 'string' || typeof messageId !== 'string') { drop('each source needs nodeId and messageId'); continue; }
      if (!input.nodeIds.has(nodeId)) { drop('not a conversation this run read'); continue; }
      if (read?.get(messageId) !== nodeId) { drop('not a message read_node showed this run for that conversation'); continue; }
      const row = message.get(messageId, nodeId) as MessageRow | undefined;
      if (!row) { drop('no such message in that conversation'); continue; }
      const owner = turn.get(nodeId, messageId, messageId) as TurnRow | undefined;
      if (!owner) { drop('message is not part of a turn'); continue; }
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      if (evidence[index]!.length >= MAX_BLOCK_SOURCES) { drop(`at most ${MAX_BLOCK_SOURCES} sources per block`); continue; }
      evidence[index]!.push(owner.assistant_message_id === messageId
        ? { nodeId, turnId: owner.turn_id, assistantId: messageId }
        : { nodeId, turnId: owner.turn_id, assistantId: owner.assistant_message_id, messageId });
    }
    return op;
  });
  return { ops, evidence, dropped };
}

/** Removes operation-level first-run sources. Global summaries also strip conversation citations from content. */
export function withoutSources(rawOps: unknown, stripSegmentSources = false): { ops: unknown; dropped: number } {
  if (!Array.isArray(rawOps)) return { ops: rawOps, dropped: 0 };
  let dropped = 0;
  const ops = rawOps.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    if ('sources' in raw) dropped += 1;
    const { sources: _sources, ...op } = raw as Record<string, unknown>;
    const content = parsePageBlockInput(op.block);
    if (stripSegmentSources && content && pageSegmentSources(content).length) {
      dropped += 1;
      op.block = retainUserPageSegmentSources(content);
    }
    return op;
  });
  return { ops, dropped };
}
