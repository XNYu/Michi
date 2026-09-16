/**
 * Pane Inspection API — HTTP route layer (design §7, §11; brief P1-8).
 *
 * Thin on purpose: this file validates input with the shared parsers, builds a server-derived
 * caller context, calls the service, and maps the result/error to an HTTP response. No business
 * logic, no database access, no projection lives here — that is P1-6 (`inspect`), P1-7
 * (`readOutput`) and P2-1 (`PanePresenceRegistry`).
 *
 * Mounted now:
 *   GET    /api/panes/inspect    -> paneInspection.ts's `inspect`                        (P1-8)
 *   GET    /api/panes/output     -> paneInspectionOutput.ts's `readOutput`                (P1-8)
 *   PUT    /api/panes/presence   -> PanePresenceRegistry.submitPresence                   (P1-8)
 *   DELETE /api/panes/presence   -> PanePresenceRegistry.removePresence                   (P1-8)
 *   GET    /api/panes            -> paneInspectionList.ts's `list`                        (P2-4)
 *   GET    /api/panes/subscribe  -> paneInspectionSubscribe.ts's `PaneFeed`               (P3-2)
 *   POST   /api/panes/wait       -> paneInspectionWait.ts's `waitPane`                    (P3-5b)
 *   POST   /api/panes/presence/keepalive -> PanePresenceRegistry.keepalive               (W11)
 *   POST   /api/panes/presence/allocate  -> PanePresenceRegistry.allocateSurfaceRegistration (W11)
 *
 * `presence_keepalive` is design §9's independent semantic heartbeat (deliberately NOT the same
 * thing as a native WebSocket ping/pong — a browser cannot observe those frames at the JS layer,
 * so a keepalive that only renewed a lease on ping/pong would silently never renew from the
 * client side at all). It is an ordinary authenticated HTTP route mounted in THIS file, not a
 * bespoke WebSocket frame type: `streamTransport.ts` is a protocol-agnostic multiplexer that
 * reuses already-guarded HTTP routes over a shared WebSocket, and it has no pane-specific framing
 * of its own (see that module's own comment on `STREAM_PATH`) — teaching it a `presence_keepalive`
 * message type would put Pane-specific business logic into a transport shared by chat streams,
 * agent-run subscriptions and digests. Route ownership of this exact path is instead ADDED to
 * `streamTransport.ts`'s existing allowlist (`STREAM_PATH`) as a normal forwarded POST, so a
 * renderer reaches it either directly via `fetch` (old gateways, no WebSocket multiplexer) or
 * tunneled through the same socket as its other stream traffic (new gateways) — this route
 * handler itself is unaware of which transport carried the request; authentication is preserved
 * either way because streamTransport.ts forwards the caller's original cookie/authorization
 * headers to this same internal HTTP path rather than re-deriving identity from the socket.
 *
 * `POST /api/panes/presence/allocate` is ordinary HTTP only — it is not added to
 * `streamTransport.ts`'s allowlist, matching `PUT`/`DELETE /panes/presence` above (allocation is a
 * one-shot mutation with an immediate response, not a long-lived stream).
 *
 * Caller identity is ALWAYS server-derived (brief: "never from query parameters"). A locator
 * (paneId | nodeId | runId) carries no workspaceId, so this router resolves the target's real
 * owning workspace itself — via `getNodeWorkspaceId`/`getWorkspace` (node/surface targets) or
 * `AgentRunsRepository.getRun` (run targets), both already owner-scoped — rather than trusting a
 * client-supplied workspaceId. A request cannot use its own query string to widen its access:
 * `getWorkspace(id, ownerUserId)` returns null the moment the resolved workspace is not owned by
 * the caller, which is what actually enforces the boundary; the value handed to the service as
 * `caller.workspaceId` is only ever the value this router itself looked up.
 */

import express, { type Request, type Response } from 'express';
import {
  parseInspectPaneRequestV1,
  parseListPanesRequestV1,
  parsePaneLocator,
  parseReadPaneOutputRequestV1,
  parseSubscribePanesRequestV1,
  parseWaitPaneRequestV1,
  PaneInspectionError,
  type PaneInspectionErrorCode,
} from 'michi-shared';
import { inspect, resolvePaneTarget, type PaneInspectionCaller } from '../services/paneInspection';
import { readOutput } from '../services/paneInspectionOutput';
import { PaneFeed, systemPaneSubscribeClock, type PaneSubscribeClock } from '../services/paneInspectionSubscribe';
import { PaneInspectionRing, paneInspectionRing } from '../services/paneInspectionRing';
import type { AgentRunEventBus } from '../agents/runs/agentRunEventBus';
import { list } from '../services/paneInspectionList';
import { waitPane } from '../services/paneInspectionWait';
import {
  PanePresenceRegistry,
  panePresenceRegistry,
  resolvePresenceOwnerUserId,
  type PresenceCaller,
  type RemovePresenceRequest,
  type SubmitPresenceRequest,
  type PresenceKeepaliveRequest,
} from '../services/panePresence';
import { SURFACE_PANE_KINDS, type SurfacePaneKind } from '../services/paneInspectionProjection.surface';
import { getNodeWorkspaceId, getWorkspace } from '../services/dbRepository';
import { AgentRunsRepository } from '../services/agentRunsRepository';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';

// ---------------------------------------------------------------------------
// The single shared registry instance now lives in panePresence.ts, the module that owns the
// class — a service importing a singleton from routes/ would invert the dependency direction.
// Re-exported here under the same name so existing importers of this module keep working (used
// by both presence routes below and the `presence/keepalive` route added in W11).
//
// This replaces a real end-to-end break: this file and paneInspection.ts each constructed their
// own registry, so views submitted through PUT /api/panes/presence landed in one instance while
// inspect() read the other — every descriptor reported coverage: 'unknown' regardless of what a
// renderer registered, and a `surface:` locator could never resolve.
// ---------------------------------------------------------------------------

export { panePresenceRegistry };

// The single shared PaneInspectionRing instance lives in paneInspectionRing.ts, the module that
// owns the class — same rationale as panePresenceRegistry above, and the same real bug it would
// otherwise repeat: P3-3's `inspect()` boundary and this file's `subscribePanes` route BOTH mint
// and resolve cursors, and a cursor minted against one `PaneInspectionRing` instance's
// objects/cursors maps is invisible to another. Re-exported here under the same name so existing
// importers of this module (route tests, defaultDeps below) keep working.
export { paneInspectionRing };

/** Local SSE write-buffer ceiling for /panes/subscribe's direct-HTTP path (design §11 / brief:
 *  "a slow consumer has its own buffer ceiling"). streamTransport.ts's own 8 MiB WebSocket-frame
 *  ceiling is stricter and wins whenever this route is reached through that multiplexer — see
 *  the route handler's own comment. */
const SUBSCRIBE_MAX_BUFFER_BYTES = 1_048_576;

const runsRepositoryForCaller = new AgentRunsRepository();

/**
 * Injectable dependencies, defaulting to the real service/registry/repository singletons.
 * Exists so `backend/test/paneInspectionRoutes.test.ts` can stub `inspect`/`readOutput`/the
 * presence registry and assert on the exact `PaneInspectionCaller`/`PresenceCaller` this router
 * built, without needing a real ChatHub/AgentRun/DB fixture for every case in the acceptance
 * table — the same DI shape `setupAgentRunRoutes`/`setupFilesRoutes` already use in this
 * codebase (backend/src/routes/agentRuns.ts, backend/src/routes/files.ts).
 *
 * `ring`/`clock`/`agentRunEvents` are additive (P3-2): `agentRunEvents` is optional because
 * AgentRun support itself is conditional on `agentRunAssembly.enabled` at boot — a caller that
 * does not have one (AgentRun feature disabled) simply gets the coarser poll-only path for
 * AgentRun targets, which `PaneFeed` already handles (see its own doc comment).
 */
export interface PaneInspectionRouteDeps {
  inspect: typeof inspect;
  readOutput: typeof readOutput;
  list: typeof list;
  waitPane: typeof waitPane;
  presenceRegistry: PanePresenceRegistry;
  getNodeWorkspaceId: typeof getNodeWorkspaceId;
  getWorkspace: typeof getWorkspace;
  getRunForCaller: (ownerUserId: string, runId: string) => { workspaceId: string } | null;
  ring: PaneInspectionRing;
  clock: PaneSubscribeClock;
  agentRunEvents?: AgentRunEventBus;
}

const defaultDeps: PaneInspectionRouteDeps = {
  inspect,
  readOutput,
  list,
  waitPane,
  presenceRegistry: panePresenceRegistry,
  getNodeWorkspaceId,
  getWorkspace,
  getRunForCaller: (ownerUserId, runId) => runsRepositoryForCaller.getRun(ownerUserId, runId),
  ring: paneInspectionRing,
  clock: systemPaneSubscribeClock,
};

// ---------------------------------------------------------------------------
// Error mapping — one helper, shared by every route (brief: "map them once, in one helper").
// ---------------------------------------------------------------------------

const ERROR_STATUS: Record<PaneInspectionErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  NAVIGATION_DISABLED: 403,
  // UNSUPPORTED: chosen as 400 rather than 501. 501 (Not Implemented) is a statement about the
  // SERVER — this route/method isn't implemented anywhere. That is false here: the route exists,
  // is fully implemented, and answers deterministically that a given caller-supplied locator
  // resolves to a pane kind whose readOutput capability is `unsupported` (design §5.1 — e.g.
  // surface panes, Digest, Artifact). That is a fact about the REQUEST's target, which is what
  // 400 means. Consistency requirement (brief): both PaneInspectionError('UNSUPPORTED', ...)
  // throw sites (paneInspectionOutput.ts) map through this same table, so every UNSUPPORTED
  // response is 400 everywhere, never a mix of 400 and 501.
  UNSUPPORTED: 400,
  OUTPUT_CHANGED: 409,
  OUTPUT_UNAVAILABLE: 410,
  SOURCE_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
};

/** Response body shape for every PaneInspectionError and for the unexpected-error fallback.
 *  `code` is the machine-readable discriminator (design §11: HTTP and the agent tools share
 *  error codes; callers must not parse natural language). `message` is human-readable detail for
 *  the KNOWN PaneInspectionError case only — the unexpected-error fallback below never places
 *  internal detail (no stack, no SQL, no filesystem path) into this field. */
interface PaneInspectionErrorBody {
  code: PaneInspectionErrorCode | 'INTERNAL';
  message: string;
}

/** Maps a thrown error to an HTTP response. A `PaneInspectionError` maps via the table above,
 *  with its own `code`+message (the message is server-authored, from a fixed set of literals in
 *  the service/shared layer — never request-echoed content or a raw exception message). Any
 *  other thrown value becomes a 500 with a fixed, generic body: no `err.message`, no `err.stack`,
 *  nothing derived from the caught value at all, so nothing internal (SQL, a filesystem path, a
 *  stack frame) can leak through this path by accident.
 *
 * `NOT_FOUND` byte-identity requirement (brief / P1-11): every `PaneInspectionError('NOT_FOUND',
 * path, 'target not found')` throw site in the service layer already uses the exact same message
 * literal ('target not found') regardless of *why* — wrong owner, wrong workspace, truly absent
 * row, or an unresolvable surface registration. This handler does not special-case any of them:
 * it reads `code` + `message` off the caught error and serializes them verbatim, so it cannot
 * reintroduce a difference the service layer deliberately erased.
 */
function sendError(res: Response, err: unknown): void {
  if (err instanceof PaneInspectionError) {
    const status = ERROR_STATUS[err.code];
    const body: PaneInspectionErrorBody = { code: err.code, message: err.message };
    res.status(status).json(body);
    return;
  }
  const body: PaneInspectionErrorBody = { code: 'INTERNAL', message: 'internal error' };
  res.status(500).json(body);
}

// ---------------------------------------------------------------------------
// Caller resolution — server-derived only, shared by inspect/output/presence.
// ---------------------------------------------------------------------------

/** Cloud mode: `req.user.id`. Desktop mode: the fixed local identity — matches every other route
 *  in this codebase (`process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined` /
 *  `LOCAL_AGENT_OWNER_ID`), rather than inventing a third convention here. */
function resolveOwnerUserId(req: Request): string {
  if (process.env.MICHI_CLOUD === '1') return req.user?.id ?? '';
  return LOCAL_AGENT_OWNER_ID;
}

/**
 * Resolves the REAL owning workspaceId for a locator's target, scoped to `ownerUserId`, without
 * trusting anything from the request beyond the locator itself. Returns null when the target
 * cannot be resolved to a workspace this caller owns — the caller maps that to NOT_FOUND (via
 * `authorizeCaller` inside the service, once it re-resolves the same target) rather than this
 * function inventing its own NOT_FOUND response, so there is exactly one place that decides the
 * NOT_FOUND message/shape.
 *
 * `surface` targets have no database row to resolve a workspace from at all — `authorizeCaller`
 * resolves those via the presence registry itself using ONLY the caller's ownerUserId, so this
 * function returns a sentinel workspaceId ('') for that case and lets the service's own
 * authorisation (which checks presence-registry-reported workspaceId, not this field) do the real
 * check. `PaneInspectionCaller.workspaceId` is still required to be a string by its own type, and
 * an empty string can never equal a real workspaceId, so this sentinel can never accidentally
 * authorise a node/agent_run target.
 */
function resolveCallerWorkspaceId(
  deps: PaneInspectionRouteDeps,
  ownerUserId: string,
  locator: { paneId: string } | { nodeId: string } | { runId: string },
): string | null {
  const target = resolvePaneTarget(locator);

  if (target.kind === 'surface') return '';

  if (target.kind === 'node') {
    const workspaceId = deps.getNodeWorkspaceId(target.nodeId);
    if (!workspaceId) return null;
    const workspace = deps.getWorkspace(workspaceId, process.env.MICHI_CLOUD === '1' ? ownerUserId : undefined);
    return workspace ? workspace.id : null;
  }

  // target.kind === 'agent_run'
  const run = deps.getRunForCaller(ownerUserId, target.runId);
  return run ? run.workspaceId : null;
}

/** Builds the session-bound PaneInspectionCaller for inspect/readOutput. `backendConnectionId`
 *  is always 'local' here: these routes are only ever reached directly (this process's own
 *  Express app), never through the `/backend-connections/:id/proxy` remote-connection path — a
 *  remote caller reaching this route already went through that proxy's own request rewriting
 *  upstream, so by the time a request lands in this handler it is always local from this
 *  process's point of view. `runOwner` is left unset: these HTTP routes are the RENDERER'S own
 *  session, not an agent-run-bound tool caller (COMMON.md decision 7 applies to the agent tools
 *  layer, P1-9, not here). */
function buildInspectionCaller(ownerUserId: string, workspaceId: string): PaneInspectionCaller {
  return { ownerUserId, workspaceId, backendConnectionId: 'local' };
}

/** Builds the session-bound PresenceCaller for the two presence routes (panePresence.ts's own
 *  `PresenceCaller` shape — a smaller, presence-specific type, not `PaneInspectionCaller`).
 *  `connectionId` is 'local' for the same reason as `backendConnectionId` above. Uses
 *  panePresence.ts's own `resolvePresenceOwnerUserId` rather than `resolveOwnerUserId` above so
 *  presence's desktop/cloud identity resolution stays byte-identical to what that module's doc
 *  comment specifies, even though the two helpers currently compute the same value. */
function buildPresenceCaller(req: Request, workspaceId: string): PresenceCaller {
  return {
    ownerUserId: resolvePresenceOwnerUserId(process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined),
    workspaceId,
    connectionId: 'local',
  };
}

/**
 * Resolves and authorises the workspaceId a presence PUT/DELETE is scoped to. Per
 * panePresence.ts's own mounting note ("workspaceId: <from body or route, validated the same way
 * other workspace-scoped routes do>"), presence's workspaceId travels in the REQUEST BODY (there
 * is no `:workspaceId` route param for these two flat `/panes/presence` paths) — mirroring
 * `requireWorkspaceOwner`'s own `req.body.workspaceId` fallback (backend/src/routes/middleware
 * /ownership.ts) rather than trying to derive a workspace from view paneIds, which would leave a
 * brand-new lease's first (legitimately empty) submission with nothing to resolve from.
 *
 * Ownership is checked exactly like `requireWorkspaceOwner`: `getWorkspace(id, ownerUserId)`
 * returns null the moment the resolved row is not owned by this caller (or does not exist),
 * which is what actually enforces the boundary — never inferred from anything else in the body.
 */
function resolvePresenceWorkspaceId(deps: PaneInspectionRouteDeps, req: Request, ownerUserId: string): string | null {
  const raw = req.body && typeof req.body === 'object' ? (req.body as { workspaceId?: unknown }).workspaceId : undefined;
  if (typeof raw !== 'string' || !raw) return null;
  const workspace = deps.getWorkspace(raw, process.env.MICHI_CLOUD === '1' ? ownerUserId : undefined);
  return workspace ? workspace.id : null;
}

/** Query-string convention for a structured (non-flat) parameter, matching the existing
 *  `agentRunSse.ts::parseCursors` pattern in this codebase: the client JSON-encodes the object
 *  and sends it as a single query param value (`URLSearchParams.set('executionRef',
 *  JSON.stringify(ref))`), rather than relying on Express's non-standard bracket-notation nested
 *  query parsing (`executionRef[kind]=...`), which the brief's "URLSearchParams semantics"
 *  requirement does not guarantee round-trips identically across query-parsing configurations.
 *  Returns `undefined` when the param is absent so the shared parsers' own
 *  `raw.executionRef !== undefined` checks behave exactly as they do for a JSON request body. */
function parseJsonQueryParam(value: unknown, path: string): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) {
    throw new PaneInspectionError('INVALID_ARGUMENT', path, 'must be a JSON-encoded string');
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new PaneInspectionError('INVALID_ARGUMENT', path, 'must be valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function setupPaneInspectionRoutes(overrides: Partial<PaneInspectionRouteDeps> = {}): express.Router {
  const deps: PaneInspectionRouteDeps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  // GET /api/panes/inspect — design §7.2. Query params: paneId | nodeId | runId (exactly one),
  // and an optional executionRef (JSON-encoded — see parseJsonQueryParam).
  router.get('/panes/inspect', (req, res) => {
    try {
      const ownerUserId = resolveOwnerUserId(req);
      const locator = parsePaneLocator(req.query);
      const workspaceId = resolveCallerWorkspaceId(deps, ownerUserId, locator);
      if (workspaceId === null) {
        // Mirrors the service's own NOT_FOUND message/shape exactly (see sendError's doc
        // comment) — this is the same "does not exist or is not owned by this caller" case
        // `authorizeCaller` would reach if it could resolve any workspace at all to compare
        // against; returning it here (rather than calling into inspect() with a workspaceId of
        // null) avoids passing a non-string into PaneInspectionCaller.
        throw new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found');
      }
      const executionRef = parseJsonQueryParam(req.query.executionRef, 'request.executionRef');
      // parseInspectPaneRequestV1 takes the locator fields FLAT (query params are flat) and
      // RETURNS them nested under `locator`. Passing an already-nested { locator } made it see
      // zero of paneId/nodeId/runId and reject every otherwise-valid request as INVALID_ARGUMENT.
      const parsed = parseInspectPaneRequestV1({ ...locator, executionRef });
      const caller = buildInspectionCaller(ownerUserId, workspaceId);
      const descriptor = deps.inspect(caller, { locator: parsed.locator, executionRef: parsed.executionRef });
      res.status(200).json(descriptor);
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/panes/output — design §7.3. Query params: same locator, plus selection
  // (latest|last_completed|execution), optional executionRef (JSON-encoded)/outputId/pageCursor,
  // limitBytes.
  router.get('/panes/output', (req, res) => {
    try {
      const ownerUserId = resolveOwnerUserId(req);
      const locator = parsePaneLocator(req.query);
      const workspaceId = resolveCallerWorkspaceId(deps, ownerUserId, locator);
      if (workspaceId === null) {
        throw new PaneInspectionError('NOT_FOUND', 'output', 'target not found');
      }
      const executionRef = parseJsonQueryParam(req.query.executionRef, 'request.executionRef');
      const parsed = parseReadPaneOutputRequestV1({
        ...locator,
        executionRef,
        selection: req.query.selection,
        outputId: req.query.outputId,
        pageCursor: req.query.pageCursor,
        limitBytes: req.query.limitBytes,
      });
      const caller = buildInspectionCaller(ownerUserId, workspaceId);
      const result = deps.readOutput(caller, {
        locator: parsed.locator,
        selection: parsed.selection,
        executionRef: parsed.executionRef,
        outputId: parsed.outputId,
        pageCursor: parsed.pageCursor,
        limitBytes: parsed.limitBytes,
      });
      res.status(200).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /api/panes/subscribe — design §8, §11; brief P3-2. Query params: paneIds (JSON-encoded
  // string array, max 32 — see parseSubscribePanesRequestV1), cursors (JSON-encoded object,
  // paneId -> last-received observation cursor). SSE response: one `PaneFeedEventV1` per `data:`
  // frame. This block is self-contained (own handler, own helpers below) so P2-4's parallel
  // `GET /api/panes` addition to this file does not collide with it.
  router.get('/panes/subscribe', (req, res) => {
    let parsed: ReturnType<typeof parseSubscribePanesRequestV1>;
    try {
      const paneIds = parseJsonQueryParam(req.query.paneIds, 'request.paneIds');
      const cursors = parseJsonQueryParam(req.query.cursors, 'request.cursors');
      parsed = parseSubscribePanesRequestV1({ paneIds, cursors });
    } catch (err) {
      sendError(res, err);
      return;
    }

    const ownerUserId = resolveOwnerUserId(req);
    // Each paneId may resolve to a different workspace in principle (design §8 scopes
    // subscribePanes to "同一 backend/workspace 内最多 32 个 paneId" — same backend, same
    // workspace). This router resolves and authorises EVERY paneId's owning workspace up front,
    // exactly like inspect/output above, and requires them all to agree before opening the
    // stream — a request spanning two workspaces is rejected rather than silently scoped to
    // whichever workspace happened to resolve first.
    let workspaceId: string | null = null;
    for (const paneId of parsed.paneIds) {
      let locator: { paneId: string };
      try {
        locator = { paneId };
        resolvePaneTarget(locator);
      } catch (err) {
        sendError(res, err);
        return;
      }
      const resolved = resolveCallerWorkspaceId(deps, ownerUserId, locator);
      if (resolved === null) {
        sendError(res, new PaneInspectionError('NOT_FOUND', 'subscribe', 'target not found'));
        return;
      }
      if (workspaceId === null) workspaceId = resolved;
      else if (workspaceId !== resolved) {
        sendError(res, new PaneInspectionError('INVALID_ARGUMENT', 'request.paneIds', 'must all belong to the same workspace'));
        return;
      }
    }
    if (workspaceId === null) {
      // Unreachable in practice (parseSubscribePanesRequestV1 already rejects an empty
      // paneIds array), kept as a defensive guard rather than asserting.
      sendError(res, new PaneInspectionError('INVALID_ARGUMENT', 'request.paneIds', 'must not be empty'));
      return;
    }
    const caller = buildInspectionCaller(ownerUserId, workspaceId);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const feed = new PaneFeed({ clock: deps.clock, ring: deps.ring, agentRunEvents: deps.agentRunEvents });
    let closed = false;
    const emitter = {
      emit(event: import('michi-shared').PaneFeedEventV1) {
        if (closed || res.destroyed || res.writableEnded) return;
        // Slow-consumer buffer ceiling (design §11 / brief acceptance: "a slow consumer hitting
        // the buffer ceiling is disconnected, and nothing is cancelled"). streamTransport.ts's
        // own MAX_BUFFER_BYTES (8 MiB, checked on the WebSocket frame) is stricter and wins when
        // this route is reached through that multiplexer per the brief's "where streamTransport's
        // own limits are stricter, they win" — this local ceiling exists for the direct-HTTP path
        // (no WebSocket in front) so a slow consumer is bounded either way.
        if (res.writableLength > SUBSCRIBE_MAX_BUFFER_BYTES) {
          close();
          res.destroy(new Error('Pane subscribe client exceeded buffer limit'));
          return;
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      feed.stop();
    };
    for (const paneId of parsed.paneIds) {
      feed.subscribe(caller, paneId, parsed.cursors[paneId], emitter);
    }
    // res.on('close'), never req.on('close') — req fires as soon as the request body has been
    // consumed (there is none, for a GET, but the convention is load-bearing elsewhere in this
    // codebase per AGENTS.md/COMMON.md) and would tear the feed down before the client actually
    // disconnects. A disconnect here only detaches observers (feed.stop() -> unsubscribe() ->
    // ring.releaseSubscriber) — it never cancels a turn or a Run.
    res.on('close', close);
    res.on('error', close);
  });

  // POST /api/panes/wait — design §7.4; brief P3-5b. Body: locator fields (flat) + until +
  // cursor/executionRef + timeoutMs, matching parseWaitPaneRequestV1's shape (same
  // flat-locator/nested-result convention as parseInspectPaneRequestV1 above). Caller identity is
  // server-derived exactly like inspect/output/subscribe: never taken from the body. A client
  // disconnect aborts only this observer's wait and releases its listeners and owner slot;
  // it never cancels the underlying chat turn or Run.
  router.post('/panes/wait', (req, res) => {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on('close', onClose);
    void (async () => {
      try {
        const ownerUserId = resolveOwnerUserId(req);
        const locator = parsePaneLocator(req.body);
        const workspaceId = resolveCallerWorkspaceId(deps, ownerUserId, locator);
        if (workspaceId === null) {
          throw new PaneInspectionError('NOT_FOUND', 'wait', 'target not found');
        }
        // parseWaitPaneRequestV1 takes the locator fields FLAT (mirrors parseInspectPaneRequestV1
        // above — see that handler's comment) and returns them nested under `locator`.
        const parsed = parseWaitPaneRequestV1(req.body);
        const caller = buildInspectionCaller(ownerUserId, workspaceId);
        const outcome = await deps.waitPane(caller, {
          locator: parsed.locator,
          until: parsed.until,
          cursor: parsed.cursor,
          executionRef: parsed.executionRef,
          timeoutMs: parsed.timeoutMs,
          signal: controller.signal,
        }, { clock: deps.clock, agentRunEvents: deps.agentRunEvents });
        if (res.writableEnded || res.destroyed) return;
        res.status(200).json(outcome);
      } catch (err) {
        if (res.writableEnded || res.destroyed) return;
        sendError(res, err);
      } finally {
        res.off('close', onClose);
      }
    })();
  });


  // GET /api/panes — design §7.1 (brief P2-4). Query params: workspaceId (required — never
  // defaults to a locator-resolved workspace like inspect/output above, because list has no
  // locator to resolve one from; the caller names its OWN workspace directly), optional
  // treeId/kind/parentNodeId, scope (open|all, default open), includeArchived (default false),
  // limit (default 20, max 100), cursor. Caller identity is server-derived exactly like the
  // routes above; workspaceId is still validated against that identity via getWorkspace before
  // being handed to the service, so a query string cannot widen access to another owner's
  // workspace by naming it directly (COMMON.md decision 9: NOT_FOUND, not a scoped 403, for a
  // workspace the caller does not own — indistinguishable from one that does not exist).
  //
  // Self-contained block — P3-2 (GET /api/panes/subscribe) is added elsewhere in this same file;
  // nothing above or below this block is touched for that task to land without a merge conflict.
  router.get('/panes', (req, res) => {
    try {
      const ownerUserId = resolveOwnerUserId(req);
      const rawWorkspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
      if (!rawWorkspaceId) {
        throw new PaneInspectionError('INVALID_ARGUMENT', 'request.workspaceId', 'is required');
      }
      const workspace = deps.getWorkspace(rawWorkspaceId, process.env.MICHI_CLOUD === '1' ? ownerUserId : undefined);
      if (!workspace) {
        throw new PaneInspectionError('NOT_FOUND', 'list', 'target not found');
      }
      const parsed = parseListPanesRequestV1({
        workspaceId: workspace.id,
        treeId: req.query.treeId,
        kind: req.query.kind,
        parentNodeId: req.query.parentNodeId,
        scope: req.query.scope,
        includeArchived: req.query.includeArchived === undefined ? undefined : req.query.includeArchived === 'true',
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      const caller = buildInspectionCaller(ownerUserId, workspace.id);
      const result = deps.list(caller, parsed);
      res.status(200).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // PUT /api/panes/presence — design §9. Renderer-only; never exposed to the agent tools layer.
  // Body: SubmitPresenceRequest & { workspaceId: string }. workspaceId travels in the body (see
  // resolvePresenceWorkspaceId's doc comment) and is validated server-side against the session's
  // ownerUserId before anything is handed to the registry — never trusted verbatim.
  router.put('/panes/presence', (req, res) => {
    try {
      const body = req.body as SubmitPresenceRequest | undefined;
      if (!body || typeof body !== 'object' || !Array.isArray(body.views)) {
        res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'views must be an array' } satisfies PaneInspectionErrorBody);
        return;
      }
      const ownerUserId = resolveOwnerUserId(req);
      const workspaceId = resolvePresenceWorkspaceId(deps, req, ownerUserId);
      if (workspaceId === null) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
        return;
      }
      const caller = buildPresenceCaller(req, workspaceId);
      const result = deps.presenceRegistry.submitPresence(caller, body);
      if (result.ok) {
        res.status(200).json(result);
        return;
      }
      if (result.code === 'STALE_REVISION') { res.status(409).json(result); return; }
      if (result.code === 'WRONG_WINDOW') { res.status(403).json(result); return; }
      res.status(200).json(result); // EMPTY_SNAPSHOT_IGNORED — not an error, a no-op.
    } catch (err) {
      sendError(res, err);
    }
  });

  // DELETE /api/panes/presence — design §9. Body: RemovePresenceRequest & { workspaceId: string }.
  router.delete('/panes/presence', (req, res) => {
    try {
      const body = req.body as RemovePresenceRequest | undefined;
      if (!body || typeof body !== 'object' || typeof body.rendererLeaseId !== 'string' || !body.rendererLeaseId) {
        res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'rendererLeaseId is required' } satisfies PaneInspectionErrorBody);
        return;
      }
      const ownerUserId = resolveOwnerUserId(req);
      const workspaceId = resolvePresenceWorkspaceId(deps, req, ownerUserId);
      if (workspaceId === null) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
        return;
      }
      const caller = buildPresenceCaller(req, workspaceId);
      const result = deps.presenceRegistry.removePresence(caller, body);
      if (result.ok) { res.status(200).json(result); return; }
      if (result.code === 'WRONG_WINDOW') { res.status(403).json(result); return; }
      res.status(404).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/panes/presence/keepalive — design §9's independent semantic heartbeat (see this
  // file's own header comment for why it is HTTP, tunneled through streamTransport.ts's allowlist,
  // rather than a WebSocket message type). Body: PresenceKeepaliveRequest & { workspaceId: string
  // }. Caller identity is server-derived exactly like PUT/DELETE presence above — never trusted
  // from the body beyond the workspaceId used to resolve+authorise the target workspace.
  //
  // NOT_FOUND without leaking ownership (brief requirement): `PanePresenceRegistry.keepalive`
  // already folds "no such lease" and "lease exists but belongs to a different
  // owner/workspace/connection" into the exact same `{ ok: false, code: 'NOT_FOUND' }` shape (see
  // that method's own guard) — this handler does not add a distinguishing branch on top of it, so
  // a caller cannot probe for the existence of someone else's lease by comparing 403 vs. 404.
  router.post('/panes/presence/keepalive', (req, res) => {
    try {
      const body = req.body as PresenceKeepaliveRequest | undefined;
      if (!body || typeof body !== 'object' || typeof body.rendererLeaseId !== 'string' || !body.rendererLeaseId) {
        res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'rendererLeaseId is required' } satisfies PaneInspectionErrorBody);
        return;
      }
      const ownerUserId = resolveOwnerUserId(req);
      const workspaceId = resolvePresenceWorkspaceId(deps, req, ownerUserId);
      if (workspaceId === null) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
        return;
      }
      const caller = buildPresenceCaller(req, workspaceId);
      const result = deps.presenceRegistry.keepalive(caller, body);
      if (result.ok) { res.status(200).json(result); return; }
      res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
    } catch (err) {
      sendError(res, err);
    }
  });

  // POST /api/panes/presence/allocate — allocates a surface pane registration (design §9's
  // `allocateSurfaceRegistration`). Body: { workspaceId: string; kind: string }. Ordinary HTTP
  // only — not added to streamTransport.ts's allowlist (see this file's header comment): a
  // one-shot allocation with an immediate response has no reason to ride the long-lived stream
  // multiplexer. `kind` is validated against `SURFACE_PANE_KINDS` BEFORE calling into the
  // registry, so an unsupported kind never reaches (and never pollutes) the registry's
  // `registrations` map with a value nothing can ever satisfy.
  //
  // Caller identity is server-derived exactly like PUT/DELETE presence and keepalive above (never
  // trusted from the body beyond the workspaceId used to resolve+authorise the target workspace):
  // the resulting `PresenceCaller` is what the registration is BOUND to (panePresence.ts's own
  // `allocateSurfaceRegistration` doc comment), so a submit/resolve from a different
  // owner/workspace/connection can never claim or inspect it later. A `RATE_LIMITED`
  // `PaneInspectionError` thrown once this caller's scope is at capacity falls through to the
  // shared `sendError` helper below, which already maps it to 429 via `ERROR_STATUS` — no
  // special-casing needed here.
  router.post('/panes/presence/allocate', (req, res) => {
    try {
      const body = req.body as { kind?: unknown } | undefined;
      const kind = body && typeof body === 'object' ? body.kind : undefined;
      if (typeof kind !== 'string' || !SURFACE_PANE_KINDS.includes(kind as SurfacePaneKind)) {
        res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'kind must be one of the supported surface pane kinds' } satisfies PaneInspectionErrorBody);
        return;
      }
      const ownerUserId = resolveOwnerUserId(req);
      const workspaceId = resolvePresenceWorkspaceId(deps, req, ownerUserId);
      if (workspaceId === null) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'target not found' } satisfies PaneInspectionErrorBody);
        return;
      }
      const caller = buildPresenceCaller(req, workspaceId);
      const result = deps.presenceRegistry.allocateSurfaceRegistration(caller, kind);
      res.status(200).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
