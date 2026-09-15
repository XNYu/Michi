/** Pane Presence — frontend transport client (design §9; brief P1-10/W11).
 *
 * Thin request/response layer implementing `usePanePresenceReporter`'s `PanePresenceTransport`
 * seam against the real backend contract (`backend/src/services/panePresence.ts` /
 * `backend/src/routes/paneInspection.ts`):
 *
 *   PUT    /api/panes/presence            -> submit
 *   DELETE /api/panes/presence            -> remove
 *   POST   /api/panes/presence/keepalive  -> keepalive
 *   POST   /api/panes/presence/allocate   -> allocateSurfaceRegistration
 *
 * Every body includes `workspaceId` (the backend route resolves and authorises it from the body,
 * not from a route param — see `resolvePresenceWorkspaceId`'s doc comment in
 * `backend/src/routes/paneInspection.ts`), so every method here takes `workspaceId` explicitly
 * alongside `backendConnectionId` rather than resolving it from some ambient/global state.
 *
 * Gateway resolution follows this codebase's existing convention (see
 * `frontend/src/services/api/agentRuns.ts` and `paneInspection.ts`): callers pass the
 * `backendConnectionId` they already know (from the pane's own project/workspace), and this
 * module resolves the base URL itself via `backendApiBase(backendConnectionId)` — never a
 * hardcoded `API_BASE_URL`.
 *
 * Keepalive is the one call that MUST go through `fetchStream` (this codebase's shared
 * WebSocket-with-HTTP-SSE-fallback gateway, `./streamTransport.ts`) rather than bare `fetch`, so
 * an upgraded gateway carries it over the existing shared per-window WebSocket instead of opening
 * a new HTTP request every interval, while an older gateway transparently falls back to plain
 * HTTP. `fetchStream` performs that negotiation itself (see its own doc comment); this module
 * does not duplicate it. Submit/remove/allocate are ordinary one-shot request/response calls with
 * no persistent-feed benefit from the shared socket, so they use plain `fetch` — matching
 * `agentRunActions.ts`'s POST-body convention in this codebase. No custom WebSocket frame logic
 * lives here; `fetchStream`/`StreamTransport` (in `./streamTransport.ts`) already own that.
 */

import { encodePaneId } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { fetchStream } from './streamTransport';
import type {
  PanePresenceTransport,
  PresenceKeepaliveRequest,
  PresenceKeepaliveResult,
  RemovePresenceRequest,
  RemovePresenceResult,
  SubmitPresenceRequest,
  SubmitPresenceResult,
} from '../../state/usePanePresenceReporter';

/** The seven surface pane kinds `PanePresenceRegistry.allocateSurfaceRegistration` accepts
 *  (`backend/src/services/paneInspectionProjection.surface.ts`'s `SurfacePaneKind`). Re-declared
 *  here rather than imported for the same reason `usePanePresenceReporter.ts` re-declares the
 *  backend's wire types: that module is backend-only and this client must not pull backend code
 *  into the frontend bundle. */
export type SurfacePaneKind = 'launcher' | 'files' | 'review' | 'file' | 'diff' | 'terminal' | 'browser';

export interface AllocateSurfaceRegistrationResult {
  registrationId: string;
  paneId: string;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// Runtime parsers — every network response is validated against its expected wire shape
// before this client hands it to the reporter hook. A malformed or mismatched-status body
// (e.g. an HTTP 200 that isn't actually `{ ok: true, ... }`, or a shape missing a required
// field) must REJECT the call rather than silently becoming a no-op the caller can't
// distinguish from a real, empty-but-valid result — the reporter hook's generation/lease
// bookkeeping depends on knowing whether a response was actually usable.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRejectedTargets(value: unknown): value is Array<{ paneId: string; reason: string }> {
  return Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && isNonEmptyString(entry.paneId) && typeof entry.reason === 'string');
}

function malformed(operation: string): never {
  throw new Error(`${operation}: malformed response body`);
}

/** Validates a PUT response and couples every result variant to its documented HTTP status. */
function parseSubmitPresenceResult(status: number, body: unknown): SubmitPresenceResult {
  if (status === 200 && isRecord(body) && body.ok === true
    && isNonEmptyString(body.rendererLeaseId)
    && isNonNegativeInteger(body.accepted)
    && isRejectedTargets(body.rejectedTargets)) {
    return {
      ok: true,
      rendererLeaseId: body.rendererLeaseId,
      accepted: body.accepted,
      rejectedTargets: body.rejectedTargets,
    };
  }
  if (status === 409 && isRecord(body) && body.ok === false
    && body.code === 'STALE_REVISION' && isNonNegativeInteger(body.currentRevision)) {
    return { ok: false, code: 'STALE_REVISION', currentRevision: body.currentRevision };
  }
  if (status === 403 && isRecord(body) && body.ok === false && body.code === 'WRONG_WINDOW') {
    return { ok: false, code: 'WRONG_WINDOW' };
  }
  if (status === 200 && isRecord(body) && body.ok === false
    && body.code === 'EMPTY_SNAPSHOT_IGNORED' && isNonEmptyString(body.rendererLeaseId)) {
    return { ok: false, code: 'EMPTY_SNAPSHOT_IGNORED', rendererLeaseId: body.rendererLeaseId };
  }
  return malformed('submitPresence');
}

/** Validates a DELETE response and couples every result variant to its documented HTTP status. */
function parseRemovePresenceResult(status: number, body: unknown): RemovePresenceResult {
  if (status === 200 && isRecord(body) && body.ok === true && isNonNegativeInteger(body.removed)) {
    return { ok: true, removed: body.removed };
  }
  if (status === 403 && isRecord(body) && body.ok === false && body.code === 'WRONG_WINDOW') {
    return { ok: false, code: 'WRONG_WINDOW' };
  }
  if (status === 404 && isRecord(body) && body.ok === false && body.code === 'NOT_FOUND') {
    return { ok: false, code: 'NOT_FOUND' };
  }
  return malformed('removePresence');
}

/** Validates a keepalive response and couples success/not-found to HTTP 200/404. */
function parsePresenceKeepaliveResult(status: number, body: unknown): PresenceKeepaliveResult {
  if (status === 200 && isRecord(body) && body.ok === true && isNonNegativeInteger(body.renewedViews)) {
    return { ok: true, renewedViews: body.renewedViews };
  }
  if (status === 404 && isRecord(body) && body.ok === false && body.code === 'NOT_FOUND') {
    return { ok: false, code: 'NOT_FOUND' };
  }
  return malformed('presenceKeepalive');
}

/** Validates allocation fields and requires paneId to be the canonical encoding of registrationId. */
function parseAllocateSurfaceRegistrationResult(status: number, body: unknown): AllocateSurfaceRegistrationResult {
  if (status === 200 && isRecord(body) && isNonEmptyString(body.registrationId)
    && body.paneId === encodePaneId({ kind: 'surface', registrationId: body.registrationId })) {
    return { registrationId: body.registrationId, paneId: body.paneId };
  }
  return malformed('allocateSurfaceRegistration');
}

/** PUT /api/panes/presence. `workspaceId` travels in the body per the route's own contract. */
async function submit(
  backendConnectionId: string,
  workspaceId: string,
  req: SubmitPresenceRequest,
): Promise<SubmitPresenceResult> {
  const response = await fetch(`${backendApiBase(backendConnectionId)}/panes/presence`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, workspaceId }),
  });
  if (!response.ok && response.status !== 409 && response.status !== 403) {
    throw new Error(`submitPresence failed: ${response.status}`);
  }
  const body = await parseJsonBody(response);
  return parseSubmitPresenceResult(response.status, body);
}

/** DELETE /api/panes/presence. */
async function remove(
  backendConnectionId: string,
  workspaceId: string,
  req: RemovePresenceRequest,
): Promise<RemovePresenceResult> {
  const response = await fetch(`${backendApiBase(backendConnectionId)}/panes/presence`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, workspaceId }),
  });
  if (!response.ok && response.status !== 403 && response.status !== 404) {
    throw new Error(`removePresence failed: ${response.status}`);
  }
  const body = await parseJsonBody(response);
  return parseRemovePresenceResult(response.status, body);
}

/** POST /api/panes/presence/keepalive. Uses `fetchStream` so an upgraded gateway carries this
 *  over the existing shared per-window WebSocket instead of a fresh HTTP request every interval;
 *  an older gateway (or an isolated test harness with no negotiated socket) transparently falls
 *  back to plain HTTP via `fetchStream`'s own fallback path. */
async function keepalive(
  backendConnectionId: string,
  workspaceId: string,
  req: PresenceKeepaliveRequest,
): Promise<PresenceKeepaliveResult> {
  const response = await fetchStream(`${backendApiBase(backendConnectionId)}/panes/presence/keepalive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, workspaceId }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`presenceKeepalive failed: ${response.status}`);
  }
  const body = await parseJsonBody(response);
  return parsePresenceKeepaliveResult(response.status, body);
}

/** POST /api/panes/presence/allocate. Allocates a new surface registration (terminal, browser,
 *  launcher, files, review, file, diff — the pane kinds with no persistent node/run object of
 *  their own). Not part of `PanePresenceTransport` — the reporter hook never allocates on its
 *  own behalf (per its own doc comment: "the caller is responsible for allocating one... before
 *  this pane can be reported"); this stays a standalone export so production mounting code, which
 *  already owns the decision of when a not-yet-registered surface pane needs an id, can call it
 *  directly without threading it through the hook's narrower transport seam. */
export async function allocateSurfaceRegistration(
  backendConnectionId: string,
  workspaceId: string,
  kind: SurfacePaneKind,
): Promise<AllocateSurfaceRegistrationResult> {
  const response = await fetch(`${backendApiBase(backendConnectionId)}/panes/presence/allocate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, kind }),
  });
  if (!response.ok) throw new Error(`allocateSurfaceRegistration failed: ${response.status}`);
  const body = await parseJsonBody(response);
  return parseAllocateSurfaceRegistrationResult(response.status, body);
}

/** The one real `PanePresenceTransport` implementation. Every method takes an explicit
 *  `workspaceId` alongside `backendConnectionId` (per the reporter hook's updated contract — a
 *  window may hold leases against several backends/workspaces at once, and the backend route
 *  authorises `workspaceId` from the body on every call, never inferring it). */
export const panePresenceTransport: PanePresenceTransport = {
  submit,
  remove,
  keepalive,
};
