import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { remoteServerId } from '../remoteAccess';
import { PageWriteError, requirePagesWorkspace } from './core';
import { getDatabase, getPage } from './repository';
import { pageComponents } from './components';
import { PAGE_COMPONENT_LIMITS, isComponentRecord, type ComponentSandboxMethod } from 'michi-shared';

export type ComponentHost =
  | { kind: 'page_block'; pageId: string; blockId: string }
  | { kind: 'database_view'; databaseId: string; viewId: string };
export interface MintComponentCapabilityInput {
  workspaceId: string; ownerUserId: string; componentId: string; version: number; host: ComponentHost; props?: unknown;
}
interface Capability {
  id: string; backendId: string; ownerUserId: string; workspaceId: string; componentId: string; version: number;
  host: ComponentHost; hostFingerprint: string; revocationEpoch: number; expiresAt: number;
  allowedDatabaseIds: Set<string>; calls: number[];
}
const capabilities = new Map<string, Capability>();
const TTL_MS = 2 * 60_000;
const MAX_CALLS_PER_MINUTE = 60;
const MAX_LIVE_CAPABILITIES = 2_000;
const db = () => getDb();
function bad(message: string, status: 400 | 404 | 409 = 400): never {
  throw new PageWriteError(status, status === 404 ? 'not_found' : status === 409 ? 'stale_revision' : 'invalid', message);
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]));
  };
  return JSON.stringify(normalize(value));
}

function getBoundReference(input: MintComponentCapabilityInput): { hostFingerprint: string; pinnedVersion: number | null; protected: boolean; props: Record<string, unknown> } {
  const { host, ownerUserId, workspaceId, componentId } = input;
  const row = host.kind === 'page_block'
    ? db().prepare(`SELECT r.pinned_version,r.protected,p.workspace_id,p.deleted_at
        FROM page_component_refs r JOIN pages p ON p.id=r.page_id
        WHERE r.owner_user_id=? AND r.workspace_id=? AND r.component_id=? AND r.host_kind='page_block' AND r.page_id=? AND r.block_id=?`)
      .get(ownerUserId, workspaceId, componentId, host.pageId, host.blockId)
    : db().prepare(`SELECT r.pinned_version,r.protected,d.workspace_id,d.deleted_at
        FROM page_component_refs r JOIN page_databases d ON d.id=r.database_id
        WHERE r.owner_user_id=? AND r.workspace_id=? AND r.component_id=? AND r.host_kind='database_view' AND r.database_id=? AND r.view_id=?`)
      .get(ownerUserId, workspaceId, componentId, host.databaseId, host.viewId);
  const ref = row as { pinned_version: number | null; protected: number; workspace_id: string; deleted_at: number | null } | undefined;
  if (!ref || ref.workspace_id !== workspaceId || ref.deleted_at !== null) bad('Component host is unavailable', 404);
  if (ref.pinned_version !== null && ref.pinned_version !== input.version) bad('Component version does not match the pinned host', 409);
  if (host.kind === 'page_block') {
    const page = getPage(host.pageId, ownerUserId);
    const block = page.blocks.find((item) => item.id === host.blockId);
    if (!block) bad('Component block binding changed', 409);
    if (block.type !== 'component' || block.componentId !== componentId || (block.pinnedVersion ?? input.version) !== input.version) bad('Component block binding changed', 409);
    const pinnedVersion = block.pinnedVersion ?? null;
    if (pinnedVersion !== ref.pinned_version) bad('Component block binding changed', 409);
    const props = block.props;
    return {
      hostFingerprint: canonicalJson({ host, componentId, pinnedVersion, protected: ref.protected === 1, block }),
      pinnedVersion, protected: ref.protected === 1, props,
    };
  } else {
    const database = getDatabase(host.databaseId, ownerUserId);
    const view = database.views.find((item) => item.id === host.viewId);
    if (!view || view.config.componentId !== componentId || (view.config.pinnedVersion ?? input.version) !== input.version) bad('Component view binding changed', 409);
    if (view.type !== 'custom') bad('Component view binding changed', 409);
    const pinnedVersion = view.config.pinnedVersion ?? null;
    if (pinnedVersion !== ref.pinned_version) bad('Component view binding changed', 409);
    const props = view.config.props ?? {};
    return {
      hostFingerprint: canonicalJson({ host, componentId, pinnedVersion, protected: ref.protected === 1, type: view.type, config: view.config, edit: view.edit }),
      pinnedVersion, protected: ref.protected === 1, props,
    };
  }
}

function authorizedDatabases(input: MintComponentCapabilityInput, props: Record<string, unknown>): Set<string> {
  if (input.host.kind === 'database_view') return new Set([input.host.databaseId]);
  const requested = [props.databaseId, ...(Array.isArray(props.databaseIds) ? props.databaseIds : [])]
    .filter((value): value is string => typeof value === 'string');
  if (requested.length > 20) bad('Too many component data bindings');
  const linked = db().prepare(`SELECT r.database_id FROM page_database_refs r
    JOIN pages p ON p.id=r.page_id JOIN page_databases d ON d.id=r.database_id
    WHERE r.page_id=? AND p.owner_user_id=? AND p.workspace_id=? AND p.deleted_at IS NULL
      AND d.owner_user_id=? AND d.workspace_id=? AND d.deleted_at IS NULL`)
    .all(input.host.pageId, input.ownerUserId, input.workspaceId, input.ownerUserId, input.workspaceId) as Array<{ database_id: string }>;
  const linkedIds = new Set(linked.map((row) => row.database_id));
  if (requested.some((id) => !linkedIds.has(id))) bad('Component data binding is outside the host page', 404);
  return new Set(requested);
}

function validateCurrent(cap: Capability): void {
  if (Date.now() >= cap.expiresAt) { capabilities.delete(cap.id); bad('Component capability expired', 404); }
  if (cap.backendId !== remoteServerId()) bad('Component capability backend changed', 404);
  requirePagesWorkspace(cap.workspaceId, cap.ownerUserId);
  const current = db().prepare(`SELECT enabled,deleted_at,active_version,revocation_epoch FROM page_components
    WHERE id=? AND owner_user_id=? AND workspace_id=?`).get(cap.componentId, cap.ownerUserId, cap.workspaceId) as {
      enabled: number; deleted_at: number | null; active_version: number; revocation_epoch: number;
    } | undefined;
  if (!current || current.enabled !== 1 || current.deleted_at !== null || current.revocation_epoch !== cap.revocationEpoch) bad('Component capability was revoked', 404);
  const reference = getBoundReference({ workspaceId: cap.workspaceId, ownerUserId: cap.ownerUserId, componentId: cap.componentId, version: cap.version, host: cap.host, props: {} });
  if (reference.hostFingerprint !== cap.hostFingerprint) bad('Component host changed', 409);
  if (reference.pinnedVersion === null && current.active_version !== cap.version) bad('Component version changed', 409);
}

export function mintPageComponentCapability(input: MintComponentCapabilityInput): {
  capability: string; expiresAt: number; componentId: string; version: number; host: ComponentHost; props: Record<string, unknown>;
} {
  requirePagesWorkspace(input.workspaceId, input.ownerUserId);
  if (!isComponentRecord(input.host) || (input.host.kind !== 'page_block' && input.host.kind !== 'database_view')) bad('Invalid component host');
  if (input.host.kind === 'page_block' && (Object.keys(input.host).some((key) => !['kind', 'pageId', 'blockId'].includes(key)) || typeof input.host.pageId !== 'string' || typeof input.host.blockId !== 'string')) bad('Invalid component host');
  if (input.host.kind === 'database_view' && (Object.keys(input.host).some((key) => !['kind', 'databaseId', 'viewId'].includes(key)) || typeof input.host.databaseId !== 'string' || typeof input.host.viewId !== 'string')) bad('Invalid component host');
  const version = pageComponents.read(input.workspaceId, input.ownerUserId, input.componentId, input.version);
  const binding = getBoundReference(input);
  // Props are host-owned persisted configuration. The caller cannot expand its resource scope by
  // supplying a different object when minting a capability.
  const props = pageComponents.validateProps(input.workspaceId, input.ownerUserId, input.componentId, input.version, binding.props);
  if (props === null) bad('Invalid component props');
  for (const [token, cap] of capabilities) if (Date.now() >= cap.expiresAt) capabilities.delete(token);
  if (capabilities.size >= MAX_LIVE_CAPABILITIES) bad('Component capability service is busy', 409);
  const versionState = db().prepare('SELECT active_version FROM page_components WHERE id=? AND workspace_id=? AND owner_user_id=?')
    .get(input.componentId, input.workspaceId, input.ownerUserId) as { active_version: number } | undefined;
  if (binding.pinnedVersion === null && versionState?.active_version !== input.version) bad('Component version is not active for this host', 409);
  const token = randomUUID() + randomUUID();
  const expiresAt = Date.now() + TTL_MS;
  const row = db().prepare('SELECT revocation_epoch FROM page_components WHERE id=? AND workspace_id=? AND owner_user_id=?').get(input.componentId, input.workspaceId, input.ownerUserId) as { revocation_epoch: number } | undefined;
  if (!row) return bad('Component unavailable', 404);
  capabilities.set(token, {
    id: token, backendId: remoteServerId(), ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, componentId: version.componentId,
    version: input.version, host: { ...input.host }, hostFingerprint: binding.hostFingerprint, revocationEpoch: row.revocation_epoch,
    expiresAt, allowedDatabaseIds: authorizedDatabases(input, props), calls: [],
  });
  return { capability: token, expiresAt, componentId: version.componentId, version: version.version, host: { ...input.host }, props };
}

export interface ComponentCapabilityCall { method: ComponentSandboxMethod; resourceId?: string; args?: unknown[] }
export function callPageComponentCapability(token: string, callerUserId: string, call: ComponentCapabilityCall): unknown {
  const cap = capabilities.get(token);
  if (!cap) return bad('Component capability unavailable', 404);
  if (callerUserId !== cap.ownerUserId) return bad('Component capability unavailable', 404);
  validateCurrent(cap);
  const now = Date.now();
  cap.calls = cap.calls.filter((time) => now - time < 60_000);
  if (cap.calls.length >= MAX_CALLS_PER_MINUTE) bad('Component capability rate limit exceeded', 409);
  cap.calls.push(now);
  const args = call.args ?? [];
  let serialized: string;
  try { serialized = JSON.stringify(args); } catch { return bad('Invalid component request'); }
  if (!Array.isArray(args) || new TextEncoder().encode(serialized).byteLength > 64_000) bad('Invalid component request');
  switch (call.method) {
    case 'read.host': {
      if (args.length) bad('Invalid read.host arguments');
      const host = cap.host;
      if (host.kind === 'page_block') {
        const page = getPage(host.pageId, cap.ownerUserId);
        return { page: { id: page.id, title: page.title, revision: page.revision }, block: page.blocks.find((item) => item.id === host.blockId) };
      }
      const database = getDatabase(host.databaseId, cap.ownerUserId);
      const view = database.views.find((item) => item.id === host.viewId);
      return { databaseId: database.id, view };
    }
    case 'read.database': {
      if (args.length) bad('Invalid read.database arguments');
      const resourceId = call.resourceId ?? (cap.host.kind === 'database_view' ? cap.host.databaseId : undefined);
      if (!resourceId || !cap.allowedDatabaseIds.has(resourceId)) bad('Database is outside this component host scope', 404);
      if (cap.host.kind === 'page_block') {
        const linked = db().prepare(`SELECT 1 FROM page_database_refs r JOIN pages p ON p.id=r.page_id JOIN page_databases d ON d.id=r.database_id
          WHERE r.page_id=? AND r.database_id=? AND p.owner_user_id=? AND p.workspace_id=? AND p.deleted_at IS NULL
            AND d.owner_user_id=? AND d.workspace_id=? AND d.deleted_at IS NULL`)
          .get(cap.host.pageId, resourceId, cap.ownerUserId, cap.workspaceId, cap.ownerUserId, cap.workspaceId);
        if (!linked) bad('Component database binding changed', 404);
      }
      const database = getDatabase(resourceId, cap.ownerUserId);
      if (database.workspaceId !== cap.workspaceId) bad('Database is outside this component workspace', 404);
      return database;
    }
    case 'resize': {
      if (args.length !== 1) bad('Invalid resize arguments');
      const height = args[0];
      if (!Number.isSafeInteger(height) || (height as number) < PAGE_COMPONENT_LIMITS.heightMin || (height as number) > PAGE_COMPONENT_LIMITS.heightMax) bad('Invalid component height');
      return { height };
    }
    case 'navigate.page': {
      if (args.length !== 1) bad('Invalid navigate.page arguments');
      const pageId = args[0];
      if (typeof pageId !== 'string') bad('Invalid page navigation');
      const page = getPage(pageId, cap.ownerUserId);
      if (page.workspaceId !== cap.workspaceId) bad('Page is outside this component workspace', 404);
      return { pageId: page.id };
    }
    case 'ask.draft': {
      if (args.length !== 1) bad('Invalid ask.draft arguments');
      const text = args[0];
      if (typeof text !== 'string' || text.length > PAGE_COMPONENT_LIMITS.draftChars) bad('Invalid draft request');
      return { text };
    }
    case 'write.rows': {
      if (args.length !== 1) bad('Invalid write.rows arguments');
      const resourceId = call.resourceId ?? (cap.host.kind === 'database_view' ? cap.host.databaseId : undefined);
      if (!resourceId || !cap.allowedDatabaseIds.has(resourceId)) bad('Database is outside this component host scope', 404);
      if (cap.host.kind !== 'database_view') bad('This component host cannot write database rows');
      const ops = args[0];
      if (!Array.isArray(ops) || ops.length > 200) bad('Invalid row write batch');
      // Adapter is deliberately loaded only after authority and shape checks. It enforces row-only
      // operations, human ownership/proposal rules, and component provenance transactionally.
      const { applyComponentDbEdits } = require('./databaseWrites') as typeof import('./databaseWrites');
      if (cap.host.kind !== 'database_view') bad('This component host cannot write database rows');
      return applyComponentDbEdits({
        databaseId: resourceId, workspaceId: cap.workspaceId, ownerUserId: cap.ownerUserId,
        componentId: cap.componentId, version: cap.version, host: cap.host, ops,
        authorize: () => validateCurrent(cap),
      });
    }
  }
}

/** Test-only lifecycle helper; production revocation also follows library epoch and host checks. */
export function clearPageComponentCapabilitiesForTests(): void { capabilities.clear(); }
export function revokePageComponentCapability(token: string, callerUserId: string): void {
  const cap = capabilities.get(token);
  if (cap?.ownerUserId === callerUserId) capabilities.delete(token);
}
