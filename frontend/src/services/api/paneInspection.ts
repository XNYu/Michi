/**
 * Pane Inspection API — frontend transport client (design §7; brief P1-10).
 *
 * Thin request/response layer over `GET /api/panes/inspect` and `GET /api/panes/output`
 * (`backend/src/routes/paneInspection.ts`, P1-8). No React, no store — `subscribePanes` and any
 * client-side state live in `frontend/src/state/paneInspection.ts` (P3-6), not here.
 *
 * Gateway resolution follows this codebase's existing convention (see
 * `frontend/src/services/api/agentRuns.ts`): callers resolve their own `backendConnectionId` via
 * `nodeBackendApiBase` / `workspaceBackendApiBase` from `../../config/backendConnections`, and pass
 * it in as part of the target. This module never hardcodes `API_BASE_URL` and never guesses a
 * workspace — a `paneId`/`runId` locator carries no workspace of its own, so the caller (which
 * already knows which workspace/backend the pane belongs to, having opened it) supplies the base.
 *
 * Flat-vs-nested trap (already cost this campaign a debugging cycle, see COMMON.md and
 * `backend/src/routes/paneInspection.ts`'s own comment): the route's query params are FLAT
 * (`paneId=...` or `nodeId=...` or `runId=...`, plus `executionRef` as a JSON-encoded string). The
 * shared `parse*RequestV1` helpers accept those same flat fields and return them nested under
 * `locator` — that nesting is a server-side response shape, not a request shape. This module builds
 * every query string from the flat `PaneLocator` fields directly; it never nests them.
 */

import type {
  ExecutionRef,
  ExecutionSelection,
  PaneDescriptorV1,
  PaneFeedEventV1,
  PaneInspectionErrorCode,
  PaneLocator,
  ReadPaneOutputRequestV1,
} from 'michi-shared';
import { PaneInspectionError, parseSubscribePanesRequestV1 } from 'michi-shared';
import { readSseStream } from './sseParser';
import { fetchStream } from './streamTransport';

// ---------------------------------------------------------------------------
// Typed error — callers branch on `code`, never on `message` (design §11).
// ---------------------------------------------------------------------------

/**
 * Thrown by every function in this module on a non-2xx response, and on a network/transport
 * failure (fetch rejecting, an aborted signal). `code` is always a `PaneInspectionErrorCode` or
 * `'INTERNAL'` — the same discriminator the HTTP route emits — so callers must branch on `code`,
 * never string-match `message`. `status` is the HTTP status when the failure came from a response
 * (undefined for a transport-level failure that never got a response at all, e.g. abort or a
 * network error), and is provided alongside `code` for callers that want the raw status for
 * logging without re-deriving it from a code→status table of their own.
 */
export class PaneInspectionClientError extends Error {
  constructor(
    readonly code: PaneInspectionErrorCode | 'INTERNAL',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PaneInspectionClientError';
  }
}

/** Response body shape the server sends for every error (see `backend/src/routes/paneInspection.ts`
 *  `PaneInspectionErrorBody` / `sendError`) — `{ code, message }`, nothing else. */
interface ErrorResponseBody {
  code?: unknown;
  message?: unknown;
}

const KNOWN_ERROR_CODES = new Set<PaneInspectionErrorCode | 'INTERNAL'>([
  'INVALID_ARGUMENT', 'NOT_FOUND', 'NAVIGATION_DISABLED', 'UNSUPPORTED',
  'OUTPUT_CHANGED', 'OUTPUT_UNAVAILABLE', 'SOURCE_UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL',
]);

/**
 * Builds a `PaneInspectionClientError` from a non-ok `Response`. Never throws itself: a body that
 * fails to parse as JSON, is empty, or has a `code` outside the known set still produces a typed
 * `'INTERNAL'` error rather than propagating a parse exception or leaking the raw body text into
 * the message (the brief requires both: no parse crash, and no body-fragment leakage on a plain
 * 500).
 */
async function toClientError(response: Response): Promise<PaneInspectionClientError> {
  let body: ErrorResponseBody | null = null;
  try {
    body = (await response.json()) as ErrorResponseBody;
  } catch {
    body = null;
  }
  const code = typeof body?.code === 'string' && KNOWN_ERROR_CODES.has(body.code as PaneInspectionErrorCode | 'INTERNAL')
    ? (body.code as PaneInspectionErrorCode | 'INTERNAL')
    : 'INTERNAL';
  const message = code !== 'INTERNAL' && typeof body?.message === 'string' && body.message
    ? body.message
    : `pane inspection request failed: ${response.status}`;
  return new PaneInspectionClientError(code, message, response.status);
}

// ---------------------------------------------------------------------------
// Query construction — flat locator fields, per the trap documented above.
// ---------------------------------------------------------------------------

/** Appends the flat locator fields (`paneId` | `nodeId` | `runId`, exactly one) to `params`.
 *  Throws a client-side `PaneInspectionClientError('INVALID_ARGUMENT', ...)` before any `fetch`
 *  happens when the locator does not carry exactly one of the three fields — the brief requires
 *  this to fail before the network call, not after a 400 comes back. */
function appendLocator(params: URLSearchParams, locator: PaneLocator): void {
  const keys = (['paneId', 'nodeId', 'runId'] as const).filter(
    (key) => key in locator && (locator as Record<string, unknown>)[key] !== undefined,
  );
  if (keys.length !== 1) {
    throw new PaneInspectionClientError(
      'INVALID_ARGUMENT',
      'locator requires exactly one of paneId, nodeId, or runId',
    );
  }
  const key = keys[0];
  params.set(key, (locator as Record<string, string>)[key]);
}

/** Appends `executionRef` as a single JSON-encoded query param, matching the route's own
 *  `parseJsonQueryParam` convention (`agentRunSse.ts::parseCursors` style) — never Express's
 *  non-standard bracket nesting. */
function appendExecutionRef(params: URLSearchParams, executionRef: ExecutionRef | undefined): void {
  if (executionRef !== undefined) params.set('executionRef', JSON.stringify(executionRef));
}

// ---------------------------------------------------------------------------
// inspect_pane — GET /api/panes/inspect
// ---------------------------------------------------------------------------

export interface InspectPaneRequest {
  locator: PaneLocator;
  executionRef?: ExecutionRef;
}

/**
 * Calls `GET /api/panes/inspect` and returns the parsed `PaneDescriptorV1`.
 *
 * @param apiBase Gateway base URL for the target's backend, from `nodeBackendApiBase(nodeId)` /
 *   `workspaceBackendApiBase(workspaceId)` (never a hardcoded `API_BASE_URL`) — see this module's
 *   header comment. For a `runId`/`paneId` locator, resolve the base from whichever workspace the
 *   caller already associates with that pane (it opened it).
 * @throws {PaneInspectionClientError} before any network call when `request.locator` does not
 *   carry exactly one of `paneId`/`nodeId`/`runId`; after the call, on any non-2xx response or on
 *   an aborted/failed fetch.
 */
export async function inspectPane(
  apiBase: string,
  request: InspectPaneRequest,
  signal?: AbortSignal,
): Promise<PaneDescriptorV1> {
  const params = new URLSearchParams();
  appendLocator(params, request.locator);
  appendExecutionRef(params, request.executionRef);

  let response: Response;
  try {
    response = await fetch(`${apiBase}/panes/inspect?${params.toString()}`, { signal });
  } catch (err) {
    if (signal?.aborted) throw new PaneInspectionClientError('INTERNAL', 'inspectPane aborted');
    throw new PaneInspectionClientError('INTERNAL', `inspectPane network error: ${(err as Error).message}`);
  }
  if (!response.ok) throw await toClientError(response);
  return (await response.json()) as PaneDescriptorV1;
}

// ---------------------------------------------------------------------------
// read_pane_output — GET /api/panes/output
// ---------------------------------------------------------------------------

export interface ReadPaneOutputRequest {
  locator: PaneLocator;
  selection: ExecutionSelection;
  executionRef?: ExecutionRef;
  outputId?: string;
  pageCursor?: string;
  /** Clamped server-side to `PANE_INSPECTION_LIMITS.readOutputMaxBytes`; this client passes the
   *  value through as given rather than pre-clamping, so a caller who reads a clamped/undefined
   *  value back from the response sees the server's own decision, not a client-side guess. */
  limitBytes?: number;
}

/** Response shape for `read_pane_output` (design §7.3): an `OutputPreview` snapshot plus a
 *  pagination cursor. The shared package does not export a named DTO for this endpoint's response
 *  (only the request types), so this module defines the minimal shape it actually consumes —
 *  `outputPreview` fields the shared `OutputPreview` type already describes, plus the one
 *  pagination field the route adds on top. */
export interface ReadPaneOutputResult {
  outputId: string;
  execution: ExecutionRef | null;
  kind: 'answer' | 'handoff';
  text: string;
  outputRevision: string;
  updatedAt: number | null;
  partial: boolean;
  truncated: boolean;
  /** Present when more of this same output remains to be read. Pagination is the CALLER's loop
   *  (brief: "not yours") — this client never auto-follows it. An `OUTPUT_CHANGED` (409) thrown
   *  mid-loop is the caller's decision point: re-read from the newest snapshot rather than
   *  retrying the same cursor. */
  nextPageCursor?: string;
}

/**
 * Calls `GET /api/panes/output` and returns the parsed page. Does not auto-follow
 * `nextPageCursor` — see {@link ReadPaneOutputResult.nextPageCursor}.
 *
 * @param apiBase Same gateway-base convention as {@link inspectPane}.
 * @throws {PaneInspectionClientError} before any network call when `request.locator` is invalid;
 *   after the call, with `code === 'OUTPUT_CHANGED'` (409) when the underlying output moved since
 *   `pageCursor`/`outputId` was issued, `code === 'NAVIGATION_DISABLED'` (403) when the workspace's
 *   AI-navigation setting is off, or any other mapped `PaneInspectionErrorCode` / `'INTERNAL'`.
 */
export async function readPaneOutput(
  apiBase: string,
  request: ReadPaneOutputRequest,
  signal?: AbortSignal,
): Promise<ReadPaneOutputResult> {
  const params = new URLSearchParams();
  appendLocator(params, request.locator);
  params.set('selection', request.selection);
  appendExecutionRef(params, request.executionRef);
  if (request.outputId !== undefined) params.set('outputId', request.outputId);
  if (request.pageCursor !== undefined) params.set('pageCursor', request.pageCursor);
  if (request.limitBytes !== undefined) params.set('limitBytes', String(request.limitBytes));

  let response: Response;
  try {
    response = await fetch(`${apiBase}/panes/output?${params.toString()}`, { signal });
  } catch (err) {
    if (signal?.aborted) throw new PaneInspectionClientError('INTERNAL', 'readPaneOutput aborted');
    throw new PaneInspectionClientError('INTERNAL', `readPaneOutput network error: ${(err as Error).message}`);
  }
  if (!response.ok) throw await toClientError(response);
  return (await response.json()) as ReadPaneOutputResult;
}

// ---------------------------------------------------------------------------
// subscribePanes — GET /api/panes/subscribe (design §8, §11; brief P3-6)
// ---------------------------------------------------------------------------

export interface SubscribePanesOptions {
  /** Up to `PANE_INSPECTION_LIMITS.subscribeMaxPanes` (32) paneIds, same backend/workspace —
   *  the server rejects a mixed-workspace set with INVALID_ARGUMENT (design §8). */
  paneIds: string[];
  /** Most recently received observation cursor per paneId, if any — omit an entry (or pass
   *  `undefined`) for a paneId being subscribed for the first time. */
  cursors: Record<string, string | undefined>;
  /** Called once per parsed `PaneFeedEventV1` frame, in wire order. */
  onEvent: (event: PaneFeedEventV1) => void;
  /**
   * Called at most once, on a non-2xx response, a transport failure, or a frame that fails to
   * parse as a `PaneFeedEventV1` (design: HTTP and event parsing share one typed-error surface;
   * callers branch on `code`, never on `message` — see {@link PaneInspectionClientError}).
   * NOT called when the stream ends because `unsubscribe()` was invoked or `signal` was aborted
   * — intentional cancellation is not a delivery failure (mirrors `subscribeAgentRuns`'s
   * `onDisconnect` contract in `agentRuns.ts`, and `AGENTS.md`'s "explicit cancellation ... is
   * not a user-facing error").
   */
  onError?: (error: PaneInspectionClientError) => void;
  /** Optional external abort signal, composed with the AbortController this function creates
   *  internally for the returned `unsubscribe`. Either one tears the stream down. */
  signal?: AbortSignal;
}

/**
 * Opens `GET /api/panes/subscribe` via `fetchStream` (this codebase's shared WebSocket-with-
 * HTTP-SSE-fallback gateway, `frontend/src/services/api/streamTransport.ts` — never bare `fetch`
 * or `EventSource`, matching `subscribeAgentRuns` in `agentRuns.ts` and `useArtifactWatch`'s
 * `connect()`), parses each SSE frame as a `PaneFeedEventV1`, and dispatches it to `onEvent`.
 *
 * Design §11: "subscribePanes 使用现有 fetchStream + readSseStream；升级 gateway 下走共享
 * WebSocket，旧 gateway 仅按已协商能力使用 HTTP SSE" — `fetchStream` itself is what performs that
 * negotiation (see its own doc comment: it multiplexes onto the shared per-gateway WebSocket
 * once the boot capability probe resolves `true`, and falls back to plain `fetch` — i.e. HTTP
 * SSE — otherwise). This function does not duplicate that negotiation; it only ever calls
 * `fetchStream`, so it automatically gets whichever transport the gateway/probe currently
 * supports, exactly like every other persistent feed in this codebase.
 *
 * @returns An `unsubscribe` function. Calling it aborts the underlying request and guarantees no
 *   further `onEvent`/`onError` calls. Safe to call more than once (idempotent).
 * @throws {PaneInspectionClientError} synchronously, before any network call, when `paneIds`/
 *   `cursors` fail the shared `parseSubscribePanesRequestV1` validation (empty, over the
 *   `subscribeMaxPanes` limit, or containing a duplicate paneId) — the exact same rules the
 *   server enforces (`backend/src/routes/paneInspection.ts`'s `/panes/subscribe` handler calls
 *   the same parser), so an invalid call never opens a connection just to have the server reject
 *   it, and the two layers can never disagree on what counts as valid.
 */
export function subscribePanes(apiBase: string, options: SubscribePanesOptions): () => void {
  const { paneIds, cursors, onEvent, onError, signal: externalSignal } = options;

  // Validate through the same parser the server uses (design/brief: "duplicate pane IDs and all
  // limits match server semantics"). `parseSubscribePanesRequestV1` throws a shared `PaneError`
  // (a plain `{ code, message }` shape, not this module's `PaneInspectionClientError`) on
  // failure — normalize it here so callers only ever see `PaneInspectionClientError`, and so this
  // still throws synchronously, before any network call, exactly like the pre-existing contract.
  let request: ReturnType<typeof parseSubscribePanesRequestV1>;
  try {
    request = parseSubscribePanesRequestV1({ paneIds, cursors });
  } catch (err) {
    if (err instanceof PaneInspectionError) {
      throw new PaneInspectionClientError(err.code, err.message);
    }
    throw new PaneInspectionClientError('INTERNAL', `subscribePanes: invalid request: ${(err as Error).message}`);
  }
  // A `Set` of the server-accepted (deduplicated) paneIds — used below to reject any frame whose
  // `paneId` was not part of this subscription (finding: "reject a frame whose paneId is not in
  // the requested set"). Built from `request.paneIds`, not the raw `paneIds` argument, so it
  // reflects exactly what the server was asked to subscribe to.
  const requestedPaneIds = new Set(request.paneIds);

  const controller = new AbortController();
  // `stopped` covers all forms of intentional termination (unsubscribe() and external-signal
  // abort); `protocolFailed` is set once on a terminal protocol violation (malformed JSON, a
  // frame that fails PaneFeedEventV1 validation, or a frame naming a paneId outside the
  // subscription) so the SSE reader stops after reporting it exactly once, per finding (2):
  // "report exactly once, abort/stop the stream, never dispatch later frames" — even when the
  // failing frame is not the last one already buffered in the current chunk.
  let stopped = false;
  let protocolFailed = false;
  const onExternalAbort = () => {
    // An externally-aborted signal is intentional cancellation, not a delivery failure — must
    // not fire onError (finding 1) even though the in-flight fetchStream call will now reject.
    stopped = true;
    controller.abort();
  };
  // Finding (1): an *already*-aborted external signal must short-circuit before any network
  // call (zero fetchStream calls), and still leave no listener registered to clean up.
  if (externalSignal?.aborted) {
    stopped = true;
    controller.abort();
    return () => {};
  }
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  // Finding (1): the listener registered above must be removed once its purpose is over,
  // regardless of which path ends the subscription — deliberate unsubscribe(), an external
  // abort (the listener already fired and `{ once: true }` self-removes, but detaching here too
  // keeps this idempotent and explicit), or the stream ending/erroring on its own account. Every
  // exit path below funnels through this so no path leaks the listener.
  const detachExternalAbort = () => externalSignal?.removeEventListener('abort', onExternalAbort);

  const params = new URLSearchParams();
  params.set('paneIds', JSON.stringify(request.paneIds));
  params.set('cursors', JSON.stringify(request.cursors));

  void (async () => {
    let response: Response;
    try {
      response = await fetchStream(`${apiBase}/panes/subscribe?${params.toString()}`, { signal: controller.signal });
    } catch (err) {
      if (!stopped) {
        onError?.(controller.signal.aborted
          ? new PaneInspectionClientError('INTERNAL', 'subscribePanes aborted')
          : new PaneInspectionClientError('INTERNAL', `subscribePanes network error: ${(err as Error).message}`));
      }
      detachExternalAbort();
      return;
    }
    if (stopped) {
      detachExternalAbort();
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) {
      onError?.(await toClientError(response));
      detachExternalAbort();
      return;
    }
    if (!response.body) {
      onError?.(new PaneInspectionClientError('INTERNAL', 'subscribePanes response has no body'));
      detachExternalAbort();
      return;
    }

    try {
      await readSseStream(response.body.getReader(), (_event, data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch (err) {
          protocolFailed = true;
          onError?.(new PaneInspectionClientError('INTERNAL', `subscribePanes malformed frame: ${(err as Error).message}`));
          return;
        }
        if (!isPaneFeedEventV1(parsed)) {
          protocolFailed = true;
          onError?.(new PaneInspectionClientError('INTERNAL', 'subscribePanes received a frame that is not a valid PaneFeedEventV1'));
          return;
        }
        // Finding (4): a frame naming a paneId this call never subscribed to is the same class
        // of terminal protocol failure as a malformed frame — the server's per-connection filter
        // and this client's requested set must never diverge silently. Report once, stop, and
        // never dispatch it (or anything after it) to onEvent.
        if (!requestedPaneIds.has(parsed.paneId)) {
          protocolFailed = true;
          onError?.(new PaneInspectionClientError(
            'INTERNAL',
            `subscribePanes received a frame for paneId "${parsed.paneId}", which was not in the requested set`,
          ));
          return;
        }
        onEvent(parsed);
      }, { shouldStop: () => stopped || protocolFailed });
    } catch (err) {
      if (!stopped && !protocolFailed) {
        onError?.(new PaneInspectionClientError('INTERNAL', `subscribePanes stream error: ${(err as Error).message}`));
      }
    } finally {
      detachExternalAbort();
    }
  })();

  return () => {
    if (stopped) return;
    stopped = true;
    detachExternalAbort();
    controller.abort();
  };
}

const PANE_FEED_EVENT_TYPES = new Set([
  'snapshot', 'changed', 'output_changed', 'execution_settled',
  'removed', 'access_revoked', 'resync_required', 'heartbeat',
]);

/**
 * Minimal runtime shape check for a `PaneFeedEventV1` frame — never a bare type assertion on
 * untrusted network input (project convention, `COMMON.md`: "Runtime parsers, not bare type
 * assertions, for anything crossing a trust boundary"). Checks only the base envelope
 * (`version`/`type`/`paneId`/`cursor`/`emittedAt`) plus each variant's own discriminating field
 * (`descriptor`/`outputId`+`preview`/`execution`+`outcome`) rather than deep-validating every
 * nested `PaneDescriptorV1`/`OutputPreview` field — those are already server-authored DTOs the
 * shared package defines and the server-side route/service layer is what validates their
 * internal shape; this client-side guard exists to catch a genuinely malformed/truncated frame
 * (design §11: slow-consumer disconnects, resync races) rather than to re-implement that
 * validation.
 */
function isPaneFeedEventV1(value: unknown): value is PaneFeedEventV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.type !== 'string' || !PANE_FEED_EVENT_TYPES.has(v.type)) return false;
  if (typeof v.paneId !== 'string' || typeof v.cursor !== 'string' || typeof v.emittedAt !== 'number') return false;
  switch (v.type) {
    case 'snapshot':
    case 'changed':
      return !!v.descriptor && typeof v.descriptor === 'object';
    case 'output_changed':
      return typeof v.outputId === 'string' && typeof v.outputRevision === 'string' && !!v.preview && typeof v.preview === 'object';
    case 'execution_settled':
      return !!v.execution && typeof v.execution === 'object' && typeof v.outcome === 'string' && typeof v.commitState === 'string';
    default:
      // removed / access_revoked / resync_required / heartbeat carry no extra fields.
      return true;
  }
}

// Re-export the shared codec so consumers of this module (the Inspector UI, P3-6) build/parse
// public paneIds through one shared implementation rather than string-building — per the brief
// ("use the shared encodePaneId/decodePaneId rather than string-building").
export { decodePaneId, encodePaneId, type PaneTarget } from 'michi-shared';

// ---------------------------------------------------------------------------
// Note for callers building a `PaneLocator` from a `PaneItem`
// (`frontend/src/state/paneItems.ts`, design §4.1.1) — documentation only, since this module is
// scoped to `inspectPane`/`readPaneOutput`:
//
// - A chat pane's own id IS its bare `nodeId` (chat panes have no `pane:` prefix in this
//   codebase) -> `{ nodeId }`, or equivalently `encodePaneId({ kind: 'node', nodeId })`.
// - An `AgentRunPaneItem`'s id is `pane:agent-run:{encConnId}:{encRunId}` (from
//   `agentRunPaneId()`) -> decode that with `paneItems.ts`'s own codec to get `runId`, then use
//   `{ runId }` here, or `encodePaneId({ kind: 'agent_run', runId })`.
// - Every other `pane:*` kind (launcher, files, review, file, diff, terminal, browser) has no
//   persistent server-side object of its own; the public API instead needs a `surface:{id}` pane
//   that the SERVER allocated via presence registration. This module deliberately does NOT invent
//   a `surface:` id client-side — a caller must obtain `registrationId` from the presence
//   reporter (`frontend/src/state/usePanePresenceReporter.ts`, P2-2, which calls
//   `PUT /api/panes/presence` and receives the id back), then build `{ paneId: encodePaneId({
//   kind: 'surface', registrationId }) }`. Until P2-2 exists, there is no way for this campaign's
//   frontend to inspect a launcher/files/review/file/diff/terminal/browser pane.
// ---------------------------------------------------------------------------
