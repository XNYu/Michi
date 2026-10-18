import { getDb } from './db';
import { getNode, listEdges, listMessages, type EdgeRow, type MessageRow } from './dbRepository';
import { buildCompatibleResumeContext, type TranscriptMessage } from './resumeStrategy';

export type BranchBoundaryKind = 'exact' | 'approx' | 'legacy';

export type BranchBoundaryErrorCode =
  | 'BRANCH_ANCHOR_UNAVAILABLE'
  | 'BRANCH_PARENT_UNAVAILABLE';

/** A typed branch-resolution failure the ensure-session route can map to a code. */
export class BranchBoundaryError extends Error {
  readonly code: BranchBoundaryErrorCode;

  constructor(code: BranchBoundaryErrorCode, message: string) {
    super(message);
    this.name = 'BranchBoundaryError';
    this.code = code;
  }
}

export interface BranchBoundary {
  childNodeId: string;
  parentNodeId: string;
  edgeId: string;
  kind: BranchBoundaryKind;
  /** Parent message selected as the cut. Undefined for legacy edges without provenance. */
  boundaryMessageId?: string;
  /** Whether the cut is the parent's current tail (native fork is then equivalent). */
  atTail: boolean;
  /** Parent messages through the cut, in parent order. */
  messages: MessageRow[];
  /** Model-facing note about an incomplete parent tail or an approximate cut. */
  note?: string;
}

export interface ResolveBranchBoundaryInput {
  childNodeId: string;
  parentNodeId?: string;
  userId?: string;
}

function hasActiveTurn(nodeId: string): boolean {
  try {
    return !!getDb()
      .prepare("SELECT 1 FROM turns WHERE node_id = ? AND status = 'active'")
      .get(nodeId);
  } catch {
    return false;
  }
}

function findBranchEdge(childNodeId: string, parentNodeId: string | undefined, userId?: string): {
  edge: EdgeRow;
} | undefined {
  const child = getNode(childNodeId);
  if (!child?.parent_node_id) return undefined;
  const edges = listEdges(child.workspace_id, userId).filter(
    (candidate) => candidate.kind === 'branch' && candidate.target_node_id === childNodeId,
  );
  const edge = parentNodeId
    ? edges.find((candidate) => candidate.source_node_id === parentNodeId)
    : edges[0];
  if (!edge) return undefined;
  return { edge };
}

/**
 * Resolve one branch edge to the exact parent-message prefix the child should
 * inherit. An explicit anchor (persisted fork boundary, or the legacy anchor)
 * is strict: a missing anchor is rejected instead of silently inheriting the
 * whole parent. A pre-provenance edge falls back to its creation time.
 */
export function resolveBranchBoundary(input: ResolveBranchBoundaryInput): BranchBoundary | undefined {
  const located = findBranchEdge(input.childNodeId, input.parentNodeId, input.userId);
  if (!located) return undefined;
  const { edge } = located;
  const parent = getNode(edge.source_node_id);
  if (!parent) {
    throw new BranchBoundaryError(
      'BRANCH_PARENT_UNAVAILABLE',
      `branch parent "${edge.source_node_id}" is unavailable`,
    );
  }
  const rows = listMessages(parent.id, input.userId);
  const boundaryId = edge.fork_boundary_message_id ?? edge.anchor_message_id ?? undefined;
  let kind: BranchBoundaryKind;
  let messages: MessageRow[];
  let boundaryMessageId: string | undefined;

  if (boundaryId) {
    const index = rows.findIndex((message) => message.id === boundaryId);
    if (index < 0) {
      throw new BranchBoundaryError(
        'BRANCH_ANCHOR_UNAVAILABLE',
        `the message this branch was cut from no longer exists in "${parent.id}"`,
      );
    }
    kind = 'exact';
    boundaryMessageId = boundaryId;
    messages = rows.slice(0, index + 1);
  } else if (edge.created_at != null) {
    kind = 'approx';
    messages = rows.filter((message) => message.created_at <= edge.created_at!);
    boundaryMessageId = messages.at(-1)?.id;
  } else {
    kind = 'legacy';
    messages = rows;
    boundaryMessageId = rows.at(-1)?.id;
  }

  const atTail = messages.length === rows.length;
  const tail = messages.at(-1);
  const notes: string[] = [];
  if (kind === 'approx') {
    notes.push('The branch predates exact branch provenance; its context was reconstructed from the branch creation time.');
  }
  if (hasActiveTurn(parent.id)) {
    notes.push('The parent conversation was still running when this branch was created. Its later output is not included.');
  } else if (tail?.role === 'user') {
    notes.push('At the branch point the parent had not yet answered the final user message. Its later answer is not included.');
  } else if (tail?.role === 'assistant' && tail.content.trim().length === 0) {
    notes.push('The parent conversation ended with an unfinished assistant reply. That reply is not included.');
  }

  return {
    childNodeId: input.childNodeId,
    parentNodeId: parent.id,
    edgeId: edge.id,
    kind,
    ...(boundaryMessageId === undefined ? {} : { boundaryMessageId }),
    atTail,
    messages,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

/** Model-visible transcript rows only, with empty placeholders removed. */
export function branchBoundaryTranscript(boundary: BranchBoundary): TranscriptMessage[] {
  return boundary.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }))
    .filter((message) => message.content.trim().length > 0);
}

/** Render the inherited branch prefix as one preamble/merge-context block. */
export function renderBranchBoundary(
  boundary: BranchBoundary,
  parentTitle?: string | null,
): string | null {
  const transcript = branchBoundaryTranscript(boundary);
  if (transcript.length === 0 && boundary.note === undefined) return null;
  return buildCompatibleResumeContext(transcript, {
    nodeId: boundary.parentNodeId,
    ...(parentTitle === undefined ? {} : { title: parentTitle }),
  }, {
    heading: 'Inherited branch transcript',
    intro: 'The following is the visible parent conversation up to the branch point. Messages after the branch point are not included. Treat it as prior conversation context and continue naturally; do not mention the branch mechanics unless the user asks.',
    ...(boundary.note === undefined ? {} : { note: boundary.note }),
  });
}

/** Convert the durable boundary to the runtime-facing inherited-prefix shape. */
export function toBranchContext(boundary: BranchBoundary): import('../agents/types').BranchContext {
  return {
    parentNodeId: boundary.parentNodeId,
    kind: boundary.kind,
    ...(boundary.boundaryMessageId === undefined ? {} : { boundaryMessageId: boundary.boundaryMessageId }),
    messages: branchBoundaryTranscript(boundary),
    ...(boundary.note === undefined ? {} : { note: boundary.note }),
  };
}

/** Render a runtime-facing BranchContext as one model preamble block. */
export function renderBranchContext(
  context: import('../agents/types').BranchContext,
  parentTitle?: string | null,
): string | null {
  if (context.messages.length === 0 && context.note === undefined) return null;
  return buildCompatibleResumeContext(context.messages, {
    nodeId: context.parentNodeId,
    ...(parentTitle === undefined ? {} : { title: parentTitle }),
  }, {
    heading: 'Inherited branch transcript',
    intro: 'The following is the visible parent conversation up to the branch point. Messages after the branch point are not included. Treat it as prior conversation context and continue naturally; do not mention the branch mechanics unless the user asks.',
    ...(context.note === undefined ? {} : { note: context.note }),
  });
}
