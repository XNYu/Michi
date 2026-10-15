/**
 * `send_to_thread`: one chat thread sends a message to another chat thread in
 * the SAME workspace. The message becomes a backend-requested turn in the
 * target (ChatHub.startRequestedSelfTurn), the same mechanism Agent Run
 * `wake` Watches use to continue a Parent conversation.
 *
 * Boundaries enforced here, independent of runtime permission modes:
 *  - The caller identity (owner, workspace, node) comes from the session
 *    binding, never from tool arguments. Agent Runs have no node and are refused.
 *  - The target must be another, already-started chat in the caller's own
 *    workspace (same owner/workspace check as pane inspection), not archived.
 *  - Every message needs an explicit, single-use user approval. A runtime's
 *    Trust/YOLO mode, "always allow" grants or session trust never approve it.
 *
 * The tool only delivers. How the two threads coordinate (wait_pane,
 * inspect_pane polling, or replying with send_to_thread) is up to the agents.
 */

import {
  PaneInspectionError,
  THREAD_MESSAGE_MAX_CHARS,
  formatThreadMessage,
  sanitizeThreadTitle,
  type DurableMessageMetadata,
} from "michi-shared";
import { getDb } from "../services/db";
import { DISABLED_MESSAGE } from "../services/globalContext";
import { log } from "../services/logger";
import { authorizeCaller } from "../services/paneInspection";
import { isArchivedPaneNode } from "../services/paneInspectionProjection.chat";
import { getNode, type NodeRow } from "../services/dbRepository";
import { buildPaneInspectionCaller } from "./paneInspectionTools";
import type { StartRequestedSelfTurnArgs, StartedRequestedSelfTurn } from "./chatHub";
import type { AgentSession } from "./types";

export const SEND_TO_THREAD_TOOL = "send_to_thread";

/** Session-bound identity of the calling thread. Never sourced from tool arguments. */
export interface ThreadMessageCaller {
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
  isAgentRun: boolean;
}

export interface ThreadMessageApprovalRequest {
  targetNodeId: string;
  targetTitle: string;
  text: string;
}

export type ThreadMessageApprovalResult =
  | { approved: true }
  | { approved: false; reason: "declined" | "no_answer" | "unavailable"; note?: string };

/** Asks the user, in the calling thread, to approve exactly one message. */
export type ThreadMessageApprover = (request: ThreadMessageApprovalRequest) => Promise<ThreadMessageApprovalResult>;

export interface ThreadMessageToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

export interface ThreadMessagingDeps {
  /** Restores or reuses the target's runtime session (ChatManager.ensureParentSession). */
  ensureSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<AgentSession | null>;
  /** ChatHub.startRequestedSelfTurn. */
  startTurn(args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn>;
  /** nativeResume.acquireSessionRestoreLock; serializes with POST /message. */
  acquireRestoreLock(nodeId: string): Promise<() => void>;
  newTurnId(): string;
  /** How long to wait for the target turn to begin before reporting `queued`. */
  startWaitMs: number;
}

let configuredDeps: ThreadMessagingDeps | null = null;

/** Wired once at boot (server.ts). Tests pass deps explicitly instead. */
export function configureThreadMessaging(deps: ThreadMessagingDeps | null): void {
  configuredDeps = deps;
}

export interface SendToThreadArgs {
  nodeId?: unknown;
  text?: unknown;
}

class ThreadMessageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function errorResult(code: string, message: string): ThreadMessageToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

function jsonResult(value: Record<string, unknown>): ThreadMessageToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function parseArgs(args: SendToThreadArgs): { targetNodeId: string; text: string } {
  const targetNodeId = typeof args.nodeId === "string" ? args.nodeId.trim() : "";
  if (!targetNodeId) throw new ThreadMessageError("INVALID_ARGUMENT", "nodeId is required");
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new ThreadMessageError("INVALID_ARGUMENT", "text is required");
  if (text.length > THREAD_MESSAGE_MAX_CHARS) {
    throw new ThreadMessageError("INVALID_ARGUMENT", `text exceeds ${THREAD_MESSAGE_MAX_CHARS} characters`);
  }
  return { targetNodeId, text };
}

function treeArchived(node: NodeRow): boolean {
  if (!node.tree_id) return false;
  const row = getDb().prepare("SELECT archived_at FROM trees WHERE id = ?").get(node.tree_id) as
    { archived_at: number | null } | undefined;
  return row?.archived_at != null;
}

interface ResolvedTarget {
  ownerUserId: string;
  workspaceId: string;
  callerNodeId: string;
  node: NodeRow;
}

/** All authorization and target checks. Run before asking the user and again after. */
function resolveTarget(caller: ThreadMessageCaller, targetNodeId: string): ResolvedTarget {
  if (caller.isAgentRun) {
    throw new ThreadMessageError("UNSUPPORTED", "send_to_thread is only available in chat threads, not Agent Runs");
  }
  if (!caller.nodeId) {
    throw new ThreadMessageError("SOURCE_UNAVAILABLE", "this session is not yet bound to a chat thread");
  }
  if (targetNodeId === caller.nodeId) {
    throw new ThreadMessageError("INVALID_TARGET", "cannot send a message to the current thread");
  }
  const paneCaller = buildPaneInspectionCaller({
    ownerUserId: caller.ownerUserId,
    workspaceId: caller.workspaceId,
    runOwnerRunId: null,
    backendConnectionId: "local",
  });
  // Same gate and same-workspace/owner rule as inspect_pane: another
  // workspace's node is indistinguishable from a missing one.
  const authorized = authorizeCaller(paneCaller, { kind: "node", nodeId: targetNodeId });
  if (authorized.kind !== "node") throw new ThreadMessageError("INVALID_TARGET", "target is not a chat thread");
  const node = authorized.node;
  if (node.deleted_at != null) throw new ThreadMessageError("NOT_FOUND", "target not found");
  if (node.kind !== "chat") throw new ThreadMessageError("INVALID_TARGET", "target is not a chat thread");
  if (isArchivedPaneNode(node) || treeArchived(node)) {
    throw new ThreadMessageError("READ_ONLY", "target thread is archived");
  }
  if (!node.acp_session_id && !node.external_session_id) {
    throw new ThreadMessageError("NOT_STARTED", "target thread has no conversation yet; the user must start it first");
  }
  return {
    ownerUserId: paneCaller.ownerUserId,
    workspaceId: paneCaller.workspaceId,
    callerNodeId: caller.nodeId,
    node,
  };
}

function toolError(error: unknown): ThreadMessageToolResult {
  if (error instanceof ThreadMessageError) return errorResult(error.code, error.message);
  if (error instanceof PaneInspectionError) {
    return error.code === "NAVIGATION_DISABLED"
      ? { content: [{ type: "text", text: DISABLED_MESSAGE }], isError: true }
      : errorResult(error.code, error.message);
  }
  throw error;
}

type StartOutcome =
  | { kind: "started"; started: StartedRequestedSelfTurn }
  | { kind: "queued" }
  | { kind: "failed"; error: unknown };

function waitForStart(start: Promise<StartedRequestedSelfTurn>, waitMs: number): Promise<StartOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "queued" }), waitMs);
    timer.unref?.();
    start.then(
      (started) => { clearTimeout(timer); resolve({ kind: "started", started }); },
      (error) => { clearTimeout(timer); resolve({ kind: "failed", error }); },
    );
  });
}

export async function sendToThreadTool(
  caller: ThreadMessageCaller,
  args: SendToThreadArgs,
  approve: ThreadMessageApprover,
  deps: ThreadMessagingDeps | null = configuredDeps,
): Promise<ThreadMessageToolResult> {
  let request: { targetNodeId: string; text: string };
  let target: ResolvedTarget;
  try {
    request = parseArgs(args);
    target = resolveTarget(caller, request.targetNodeId);
  } catch (error) {
    return toolError(error);
  }
  if (!deps) return errorResult("UNAVAILABLE", "cross-thread messaging is not configured on this backend");

  const targetTitle = sanitizeThreadTitle(target.node.title);
  const approval = await approve({ targetNodeId: target.node.id, targetTitle, text: request.text });
  if (!approval.approved) {
    if (approval.reason === "unavailable") {
      return errorResult("APPROVAL_UNAVAILABLE", "this runtime cannot ask the user for approval; the message was not sent");
    }
    return jsonResult({
      status: "declined",
      target: { nodeId: target.node.id, title: targetTitle },
      ...(approval.note ? { userNote: approval.note } : {}),
      next: approval.reason === "no_answer"
        ? "The user did not answer; nothing was sent. Do not retry unless the user asks."
        : "The user declined; nothing was sent. Do not retry unless the user asks.",
    });
  }

  // The approval may have waited minutes: re-check that the target is still a
  // valid destination before touching its runtime.
  let current: ResolvedTarget;
  try {
    current = resolveTarget(caller, request.targetNodeId);
  } catch (error) {
    return toolError(error);
  }

  let session: AgentSession | null;
  try {
    session = await deps.ensureSession({
      ownerUserId: current.ownerUserId,
      workspaceId: current.workspaceId,
      nodeId: current.node.id,
    });
  } catch (error) {
    return errorResult("TARGET_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  }
  if (!session) return errorResult("TARGET_UNAVAILABLE", "could not open the target thread's session");

  const sourceTitle = getNode(current.callerNodeId)?.title ?? null;
  const wireText = formatThreadMessage({ fromNodeId: current.callerNodeId, fromTitle: sourceTitle, text: request.text });
  const userMetadata: DurableMessageMetadata = {
    threadMessage: { fromNodeId: current.callerNodeId, fromTitle: sanitizeThreadTitle(sourceTitle) },
  };
  const turnId = deps.newTurnId();

  // Holding the restore lock while ChatHub registers the pending self-turn
  // keeps a concurrent POST /message from starting a second turn in between.
  let start: Promise<StartedRequestedSelfTurn>;
  const release = await deps.acquireRestoreLock(current.node.id);
  try {
    start = deps.startTurn({
      chatId: session.id,
      nodeId: current.node.id,
      ownerUserId: caller.ownerUserId,
      turnId,
      text: wireText,
      displayText: wireText,
      userMetadata,
      session,
    });
  } finally {
    release();
  }
  start.then((started) => { void started.done.catch(() => {}); }, (error) => {
    log.warn("chat", "cross-thread message turn failed to begin", {
      nodeId: current.node.id,
      turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const outcome = await waitForStart(start, deps.startWaitMs);
  if (outcome.kind === "failed") {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return errorResult("TARGET_UNAVAILABLE", message);
  }
  return jsonResult(deliveryResult(outcome.kind, { nodeId: current.node.id, title: targetTitle }, turnId));
}

/**
 * The follow-up calls are returned as complete argument objects for the model to pass
 * unchanged, instead of prose it has to turn into arguments.
 */
export function deliveryResult(
  status: "started" | "queued",
  target: { nodeId: string; title: string },
  turnId: string,
): Record<string, unknown> {
  const executionRef = { kind: "chat_turn", nodeId: target.nodeId, turnId };
  const waitPaneArgs = { nodeId: target.nodeId, until: "terminal", executionRef, timeoutMs: 30_000 };
  const readPaneOutputArgs = { nodeId: target.nodeId, selection: "execution", executionRef };
  if (status === "queued") {
    return {
      status,
      target,
      turnId,
      executionRef,
      inspectPaneArgs: { nodeId: target.nodeId },
      waitPaneArgs,
      readPaneOutputArgs,
      next: "The target thread is busy; your message starts after its current turn, and waitPaneArgs works "
        + "only once it has started. Call inspect_pane with inspectPaneArgs; while its execution is not this "
        + "turnId, call wait_pane with {nodeId, until:'changed', cursor} (cursor from the last result). Then "
        + "pass waitPaneArgs and readPaneOutputArgs unchanged.",
    };
  }
  return {
    status,
    target,
    turnId,
    executionRef,
    waitPaneArgs,
    readPaneOutputArgs,
    next: "The target thread is answering. Call wait_pane with waitPaneArgs exactly as given (again while "
      + "reason is 'timed_out'), then read_pane_output with readPaneOutputArgs to get its reply. It may also "
      + "reply with send_to_thread.",
  };
}

const APPROVE_LABEL = "Send";
const DECLINE_LABEL = "Don't send";
const PREVIEW_CHARS = 280;

function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

type AskUser = (questions: Array<{
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}>) => Promise<Record<string, string> | null>;

/**
 * Approval through the runtime's Michi-owned ask_user channel (Kiro, Claude,
 * Codex). Only the exact approve option counts; any other answer, including a
 * typed one, is a decline and is passed back to the agent as the user's note.
 */
export function askUserThreadMessageApprover(askUser: AskUser | undefined): ThreadMessageApprover {
  return async (request) => {
    if (!askUser) return { approved: false, reason: "unavailable" };
    const question = `Send this message to "${request.targetTitle}"? “${previewText(request.text)}”`;
    const answers = await askUser([{
      question,
      header: "Send msg",
      options: [
        { label: APPROVE_LABEL, description: "Deliver this one message. The other thread will answer it in its own turn." },
        { label: DECLINE_LABEL, description: "Nothing is sent; the agent is told you declined." },
      ],
      multiSelect: false,
    }]);
    if (!answers) return { approved: false, reason: "no_answer" };
    const answer = (answers[question] ?? Object.values(answers)[0] ?? "").trim();
    if (answer === APPROVE_LABEL) return { approved: true };
    if (!answer || answer === DECLINE_LABEL) return { approved: false, reason: "declined" };
    return { approved: false, reason: "declined", note: answer.slice(0, 500) };
  };
}

/** Title for single-use permission prompts (Pi). */
export function threadMessageApprovalTitle(request: ThreadMessageApprovalRequest): { title: string; detail: string } {
  return {
    title: `Send a message to "${request.targetTitle}"?`,
    detail: previewText(request.text),
  };
}
