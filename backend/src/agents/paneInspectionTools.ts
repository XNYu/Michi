/**
 * Agent-facing tool layer for the Pane Inspection API — `inspect_pane`, `read_pane_output`,
 * `list_panes` and `wait_pane` (design §7.2 / §7.3 / §7.1 / §7.4). This module holds the SHARED,
 * runtime-agnostic pieces both registration sites (`mcpServer.ts` for Kiro/Claude/Codex,
 * `piTools.ts` for Pi) call into:
 *
 *  - `buildPaneInspectionCaller` — the ONE place a `PaneInspectionCaller` is constructed from a
 *    session-bound binding. Every field comes from the binding (or, for `backendConnectionId`,
 *    a value the runtime layer derives itself — never from a tool argument). This is the
 *    security core: getting this wrong makes every authorisation check behind it decorative
 *    (task brief, R4 §1, COMMON.md decision 10 / design §10).
 *  - `inspectPaneTool` / `readPaneOutputTool` / `waitPaneTool` — thin wrappers around the
 *    SERVICE functions (`inspect` from `paneInspection.ts`, `readOutput` from
 *    `paneInspectionOutput.ts`, `waitPane` from `paneInspectionWait.ts`) that accept only the
 *    target locator + read/wait options as arguments, call the service with the caller built
 *    from the binding, and render a `{ text }` result. Calling these directly (rather than
 *    through backend/src/routes/paneInspection.ts, which P1-8/P3-5b's route half own) matches the
 *    read_node template R4 traces end to end.
 *  - Result rendering that follows design §10: no tool outputs, thoughts, environment
 *    variables, credentials, absolute execution-environment paths, native resume tokens, or
 *    permission options ever enter the text. Section<T> states are rendered as prose that names
 *    the state (unknown / unsupported / redacted) rather than collapsed into emptiness. No raw
 *    domain object is ever JSON.stringify'd — only the already-typed descriptor/result fields.
 *
 * NOT in this file: MCP's Zod schema (mcpServer.ts hand-registers it, same as read_node) and
 * Pi's typebox schema (auto-derived from BUILTIN_TOOLS in builtinTools.ts via piTools.ts's own
 * fieldToTypebox). Both runtimes import the request-shaping helpers below so a tool call and an
 * HTTP call reject identically (brief: "Use the shared parsers").
 *
 * `wait_pane`'s tool wrapper (P3-5b, this task) calls `waitPane` from `paneInspectionWait.ts`
 * (P3-5) with no `deps` override: the service's own default (`{ clock: systemPaneSubscribeClock
 * }`) is correct for a live tool call, and this layer has no access to a shared
 * `AgentRunEventBus` instance today (neither `mcpServer.ts` nor `piTools.ts` holds one) — see
 * this task's report for why that is not plumbed through here.
 */

import {
  type ExecutionRef,
  type ExecutionSelection,
  type ListPanesRequestV1,
  type PaneDescriptorV1,
  type PaneLocator,
  type WaitPaneResultV1,
  PANE_INSPECTION_LIMITS,
  PaneInspectionError,
  parseExecutionRef,
  parseExecutionSelection,
  parseListPanesRequestV1,
  parsePaneLocator,
  parseReadOutputLimitBytes,
  parseWaitPaneRequestV1,
} from "michi-shared";
import { inspect, type PaneInspectionCaller } from "../services/paneInspection";
import { readOutput, type ReadPaneOutputResult } from "../services/paneInspectionOutput";
import { list, type ListPanesResult } from "../services/paneInspectionList";
import { waitPane } from "../services/paneInspectionWait";
import { DISABLED_MESSAGE } from "../services/globalContext";

// ---------------------------------------------------------------------------
// Caller binding — the security core (brief step 3 / design §10 / COMMON.md decision 10).
// ---------------------------------------------------------------------------

/**
 * The session-bound facts available at the point a Pane Inspection tool is invoked, regardless
 * of runtime. Mirrors `toolBridge.ts`'s `AgentRunToolSessionBinding` shape (§1 of R4): every
 * field here is either read off the runtime session itself (Kiro's `McpSlot`, Pi's
 * `BuildPiToolsOpts`) or derived by the calling registration site from data it already trusts —
 * NEVER from a tool call argument.
 */
export interface PaneInspectionToolBinding {
  ownerUserId: string | null;
  workspaceId: string | null;
  /** Present only when the CALLING session is itself an Agent Run — gates the caller's own
   *  Read policy and context policy (design §10 / COMMON.md decision 7). Absent for chat callers. */
  runOwnerRunId?: string | null;
  /** Routing identity for `PaneRef.backendConnectionId` (design §4.1). Not a model-supplied
   *  value — the registration site passes its own slot/session id (e.g. the MCP slotId). */
  backendConnectionId: string;
}

/**
 * Builds the `PaneInspectionCaller` the service layer authorises against. This is the ONLY
 * function in this module that constructs a caller — both tools funnel through it so there is
 * exactly one place that could get the security-critical field sourcing wrong.
 *
 * `ownerUserId`/`workspaceId` are required by the service's `PaneInspectionCaller` as non-null
 * strings; a binding with either missing means the calling session's own identity is not yet
 * resolved (a warm/pending slot, or a session with no bound workspace). That is reported as
 * `SOURCE_UNAVAILABLE` — not a bare throw — so the model gets an actionable message rather than
 * an unexplained tool failure, mirroring the design's discriminated-result convention.
 */
export function buildPaneInspectionCaller(binding: PaneInspectionToolBinding): PaneInspectionCaller {
  if (!binding.ownerUserId || !binding.workspaceId) {
    throw new PaneInspectionError(
      "SOURCE_UNAVAILABLE",
      "caller",
      "This session is not yet bound to a workspace; pane inspection is unavailable until it is.",
    );
  }
  return {
    ownerUserId: binding.ownerUserId,
    workspaceId: binding.workspaceId,
    backendConnectionId: binding.backendConnectionId,
    runOwner: binding.runOwnerRunId ? { runId: binding.runOwnerRunId } : null,
  };
}

// ---------------------------------------------------------------------------
// Tool-facing argument shapes — target locator + read options ONLY (brief step 3: "The tool's
// arguments carry only the target locator and read options"). No identity field is accepted
// here; if a model includes ownerUserId/workspaceId in its call, these types simply have no
// slot for it and it is silently dropped before ever reaching the service.
// ---------------------------------------------------------------------------

export interface InspectPaneToolArgs {
  paneId?: string;
  nodeId?: string;
  runId?: string;
  executionRef?: unknown;
}

export interface ReadPaneOutputToolArgs {
  paneId?: string;
  nodeId?: string;
  runId?: string;
  selection?: unknown;
  executionRef?: unknown;
  outputId?: string;
  pageCursor?: string;
  limitBytes?: unknown;
}

/**
 * `list_panes` (design §7.1). Unlike `inspect_pane`/`read_pane_output`, this tool has no locator
 * — the caller's own bound workspace is the only workspace it may ever scan (brief: "the tool's
 * default is the calling workspace, never scanning other backends or workspaces"), so
 * `workspaceId` is deliberately NOT a tool-facing argument; `buildPaneInspectionCaller`'s binding
 * supplies it, exactly as it does for `inspect_pane`/`read_pane_output`'s ownerUserId/workspaceId.
 */
export interface ListPanesToolArgs {
  treeId?: string;
  kind?: unknown;
  parentNodeId?: string;
  scope?: unknown;
  includeArchived?: boolean;
  limit?: unknown;
  cursor?: string | null;
}

/**
 * `wait_pane` (design §7.4). Locator + wait options only — no identity field, same rule as the
 * other three tools' argument shapes above. `until` selects one of two mutually exclusive modes
 * (`cursor` for `'changed'`, `executionRef` for `'terminal'`); `waitPane` itself rejects the
 * wrong combination as `INVALID_ARGUMENT` (brief), so this layer does not duplicate that check —
 * it only clamps `timeoutMs` the same way `readPaneOutputTool` clamps `limitBytes`.
 */
export interface WaitPaneToolArgs {
  paneId?: string;
  nodeId?: string;
  runId?: string;
  until?: unknown;
  cursor?: string;
  executionRef?: unknown;
  timeoutMs?: unknown;
}

export interface PaneInspectionToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

function locatorFromArgs(args: { paneId?: string; nodeId?: string; runId?: string }): PaneLocator {
  // parsePaneLocator enforces "exactly one of paneId | nodeId | runId" (shared/src/paneInspection.ts)
  // — the same runtime parser the HTTP route will use, so a tool call and an HTTP call reject
  // identically (brief: "Use the shared parsers so a tool call and an HTTP call reject
  // identically").
  const raw: Record<string, unknown> = {};
  if (args.paneId !== undefined) raw.paneId = args.paneId;
  if (args.nodeId !== undefined) raw.nodeId = args.nodeId;
  if (args.runId !== undefined) raw.runId = args.runId;
  return parsePaneLocator(raw);
}

function optionalExecutionRef(value: unknown): ExecutionRef | undefined {
  if (value === undefined || value === null) return undefined;
  return parseExecutionRef(value);
}

// ---------------------------------------------------------------------------
// Result rendering — design §10: never leak tool outputs, thoughts, env vars, credentials,
// absolute execution-environment paths, native resume tokens, or permission options. Never
// JSON.stringify a raw domain object — only the typed descriptor/result fields below.
// ---------------------------------------------------------------------------

function renderSection<T>(
  label: string,
  section: { status: "ready"; value: T } | { status: "unknown" | "unsupported" | "redacted"; reason: string },
  renderValue: (value: T) => string,
): string {
  if (section.status === "ready") return renderValue(section.value);
  // Per COMMON.md decision 8 / brief: say so in the text rather than rendering it empty, so the
  // model does not conclude the wrong thing (e.g. "unsupported" collapsed to "" reads as "no
  // lineage" rather than "this pane kind has no lineage concept").
  return `${label}: ${section.status} (${section.reason})`;
}

function renderExecutionRef(ref: ExecutionRef): string {
  return ref.kind === "chat_turn" ? `chat_turn ${ref.turnId} on node ${ref.nodeId}` : `agent_run ${ref.runId}`;
}

/** Renders a `PaneDescriptorV1` into compact, model-readable text. Only the fields the DTO
 *  already exposes are surfaced — no raw domain rows, no JSON.stringify of the descriptor
 *  itself (a future field addition to PaneDescriptorV1 must be reviewed here before it reaches
 *  the model, rather than silently appearing via a generic stringify). */
function renderDescriptor(descriptor: PaneDescriptorV1): string {
  const lines: string[] = [];
  lines.push(`paneId: ${descriptor.ref.paneId}`);
  lines.push(`kind: ${descriptor.kind}`);
  lines.push(`title: ${descriptor.title || "(untitled)"}`);
  lines.push(`activity: ${descriptor.activity}`);
  lines.push(`archived: ${descriptor.archived}`);
  lines.push(`observation: freshness=${descriptor.observation.freshness} cursor=${descriptor.observation.cursor}`);
  lines.push(
    `capabilities: readOutput=${descriptor.capabilities.readOutput} subscribe=${descriptor.capabilities.subscribe} waitForTerminal=${descriptor.capabilities.waitForTerminal}`,
  );

  lines.push(
    renderSection("execution", descriptor.execution, (value) =>
      value === null
        ? "execution: none yet"
        : `execution: ${renderExecutionRef(value.ref)} status=${value.status} commitState=${value.commitState}` +
          (value.error ? ` error=${value.error.code}: ${value.error.message}` : ""),
    ),
  );

  lines.push(
    `timeline: resourceCreatedAt=${descriptor.timeline.resourceCreatedAt ?? "unknown"} firstExecutionStartedAt=${descriptor.timeline.firstExecutionStartedAt ?? "unknown"}`,
  );

  lines.push(
    renderSection("conversation", descriptor.conversation, (value) =>
      `conversation: messages=${value.messageCount} (user=${value.userMessageCount}, assistant=${value.assistantMessageCount}) completedTurns=${value.completedTurnCount ?? "unknown"} coverage=${value.turnHistoryCoverage}`,
    ),
  );

  lines.push(
    renderSection("lineage", descriptor.lineage, (value) =>
      `lineage: parentNodeId=${value.parentNodeId ?? "none"} treeRootNodeId=${value.treeRootNodeId ?? "none"} children=${value.childNodeIds.length}${value.childrenTruncated ? " (truncated)" : ""}`,
    ),
  );

  lines.push(
    renderSection("runtime", descriptor.runtime, (value) =>
      `runtime: runtimeId=${value.runtimeId ?? "unknown"} modelId=${value.modelId ?? "unknown"}`,
    ),
  );

  lines.push(
    renderSection("latestOutput", descriptor.latestOutput, (value) =>
      value === null
        ? "latestOutput: none yet"
        : `latestOutput (${value.kind}${value.partial ? ", partial" : ""}${value.truncated ? ", truncated" : ""}): ${value.text}`,
    ),
  );

  if (descriptor.truncatedFields.length > 0) {
    lines.push(`truncatedFields: ${descriptor.truncatedFields.join(", ")}`);
  }

  return lines.join("\n");
}

function renderReadOutputResult(result: ReadPaneOutputResult): string {
  const lines: string[] = [];
  lines.push(`outputId: ${result.outputId}`);
  lines.push(`execution: ${result.execution ? renderExecutionRef(result.execution) : "none"}`);
  lines.push(`kind: ${result.kind}`);
  lines.push(`partial: ${result.partial}`);
  lines.push(`nextPageCursor: ${result.nextPageCursor ?? "(none — end of output)"}`);
  lines.push("---");
  lines.push(result.text);
  return lines.join("\n");
}

/** Renders a `ListPanesResult` — summaries ONLY, no output body (design §7.1: "list is cheap").
 *  `presenceCoverage` is spelled out in prose so the model does not read an empty `scope=open`
 *  result as certainty that nothing is open (see paneInspectionList.ts's own doc comment). */
function renderListPanesResult(result: ListPanesResult): string {
  const lines: string[] = [];
  lines.push(
    result.presenceCoverage === "unknown"
      ? "presenceCoverage: unknown — no live presence signal for anything in this page; this does NOT mean nothing is open, only that no renderer has reported it (or every lease has expired)."
      : "presenceCoverage: reported — at least one row below reflects a live, currently-open view.",
  );
  lines.push(`count: ${result.summaries.length}`);
  lines.push(`nextCursor: ${result.nextCursor ?? "(none — end of list)"}`);
  lines.push("---");
  if (result.summaries.length === 0) {
    lines.push("(no panes matched)");
  }
  for (const summary of result.summaries) {
    const latest = summary.latestExecution
      ? `${renderExecutionRef(summary.latestExecution.ref)} outcome=${summary.latestExecution.outcome ?? "in progress"}`
      : "none yet";
    lines.push(
      `paneId=${summary.ref.paneId} kind=${summary.kind} title=${summary.title || "(untitled)"} ` +
        `activity=${summary.activity} latestExecution=(${latest}) openedInViews=${summary.openedInViews} updatedAt=${summary.updatedAt}`,
    );
  }
  return lines.join("\n");
}

/** Renders a `WaitPaneResultV1`. `descriptor` reuses `renderDescriptor` so a wait's result is
 *  never a second, divergent rendering of the same DTO `inspect_pane` already renders — only
 *  `reason`/`outcome`/`cursor` are wait-specific. `descriptor: null` (the `unavailable` path,
 *  design §7.4) is stated in prose rather than omitted, so the model does not read a missing
 *  section as "nothing changed" when the object actually became inaccessible mid-wait. */
function renderWaitPaneResult(result: WaitPaneResultV1): string {
  const lines: string[] = [];
  lines.push(`reason: ${result.reason}`);
  lines.push(`outcome: ${result.outcome ?? "(none)"}`);
  lines.push(`cursor: ${result.cursor || "(none)"}`);
  lines.push("---");
  lines.push(result.descriptor ? renderDescriptor(result.descriptor) : "descriptor: unavailable — the pane became inaccessible or was removed during the wait.");
  return lines.join("\n");
}

function errorResult(error: unknown): PaneInspectionToolResult {
  if (error instanceof PaneInspectionError) {
    // NAVIGATION_DISABLED gets the exact existing DISABLED_MESSAGE wording (brief: "so the user
    // sees one consistent instruction") rather than this module's own phrasing.
    const text = error.code === "NAVIGATION_DISABLED" ? DISABLED_MESSAGE : `${error.code}: ${error.message}`;
    return { content: [{ type: "text", text }], isError: true };
  }
  throw error;
}

// ---------------------------------------------------------------------------
// §7.2 inspect_pane
// ---------------------------------------------------------------------------

export function inspectPaneTool(
  binding: PaneInspectionToolBinding,
  args: InspectPaneToolArgs,
): PaneInspectionToolResult {
  try {
    const caller = buildPaneInspectionCaller(binding);
    const locator = locatorFromArgs(args);
    const executionRef = optionalExecutionRef(args.executionRef);
    const descriptor = inspect(caller, { locator, executionRef });
    return { content: [{ type: "text", text: renderDescriptor(descriptor) }] };
  } catch (error) {
    return errorResult(error);
  }
}

// ---------------------------------------------------------------------------
// §7.3 read_pane_output
// ---------------------------------------------------------------------------

export function readPaneOutputTool(
  binding: PaneInspectionToolBinding,
  args: ReadPaneOutputToolArgs,
): PaneInspectionToolResult {
  try {
    const caller = buildPaneInspectionCaller(binding);
    const locator = locatorFromArgs(args);
    const selection: ExecutionSelection = args.selection !== undefined
      ? parseExecutionSelection(args.selection)
      : "latest";
    const executionRef = optionalExecutionRef(args.executionRef);
    const limitBytes = args.limitBytes !== undefined
      ? parseReadOutputLimitBytes(args.limitBytes)
      : PANE_INSPECTION_LIMITS.readOutputDefaultBytes;
    const result = readOutput(caller, {
      locator,
      selection,
      executionRef,
      outputId: args.outputId,
      pageCursor: args.pageCursor,
      limitBytes,
    });
    return { content: [{ type: "text", text: renderReadOutputResult(result) }] };
  } catch (error) {
    return errorResult(error);
  }
}

// ---------------------------------------------------------------------------
// §7.1 list_panes
// ---------------------------------------------------------------------------

export function listPanesTool(
  binding: PaneInspectionToolBinding,
  args: ListPanesToolArgs,
): PaneInspectionToolResult {
  try {
    const caller = buildPaneInspectionCaller(binding);
    // list_panes has no locator; the request's workspaceId comes from the CALLER binding, never
    // from a tool argument — mirrors the security invariant `buildPaneInspectionCaller` already
    // enforces for ownerUserId/workspaceId on the other two tools (this module's own security
    // core note at the top of the file).
    const request: ListPanesRequestV1 = parseListPanesRequestV1({
      workspaceId: caller.workspaceId,
      treeId: args.treeId,
      kind: args.kind,
      parentNodeId: args.parentNodeId,
      scope: args.scope,
      includeArchived: args.includeArchived,
      limit: args.limit,
      cursor: args.cursor,
    });
    const result = list(caller, request);
    return { content: [{ type: "text", text: renderListPanesResult(result) }] };
  } catch (error) {
    return errorResult(error);
  }
}

// ---------------------------------------------------------------------------
// §7.4 wait_pane
// ---------------------------------------------------------------------------

/**
 * `wait_pane` (design §7.4). Async because `waitPane` itself is: it resolves once the object
 * satisfies `until` or `timeoutMs` elapses, never earlier — this wrapper does not add its own
 * timeout or retry logic, it only shapes the tool's `unknown` arguments into `waitPane`'s typed
 * `WaitPaneInput` (brief step 3: "tool args contain only locator/wait options, never identity")
 * and calls the service with the caller built from the binding, exactly like the other three
 * tools above.
 */
export async function waitPaneTool(
  binding: PaneInspectionToolBinding,
  args: WaitPaneToolArgs,
): Promise<PaneInspectionToolResult> {
  try {
    const caller = buildPaneInspectionCaller(binding);
    const parsed = parseWaitPaneRequestV1({
      paneId: args.paneId,
      nodeId: args.nodeId,
      runId: args.runId,
      until: args.until,
      cursor: args.cursor,
      executionRef: args.executionRef,
      timeoutMs: args.timeoutMs,
    });
    const result = await waitPane(caller, {
      locator: parsed.locator,
      until: parsed.until,
      cursor: parsed.cursor,
      executionRef: parsed.executionRef,
      timeoutMs: parsed.timeoutMs,
    });
    return { content: [{ type: "text", text: renderWaitPaneResult(result) }] };
  } catch (error) {
    return errorResult(error);
  }
}
