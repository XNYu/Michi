import { getDb } from '../db';
import { PageWriteError, pagesTransaction } from './core';

/**
 * Page edit leases: while one chat turn edits a page, another chat turn's
 * edit_page is refused and maintenance leaves the page for a later run.
 *
 * A lease is live only while it has not expired AND its turn is still active.
 * Validity is derived, never released: a turn that ends, is cancelled
 * (including the forced finish after CANCEL_TIMEOUT_MS) or is interrupted by a
 * restart (recoverInterruptedTurns) stops holding its leases at once.
 * People are never blocked: user edits do not consult leases.
 */
export const PAGE_EDIT_LEASE_IDLE_MS = 5 * 60_000;
export const PAGE_EDIT_LEASE_MAX_MS = 30 * 60_000;

export interface PageEditLeaseHolder { nodeId: string; turnId: string }

export interface PageEditLease {
  pageId: string;
  nodeId: string;
  turnId: string;
  acquiredAt: number;
  expiresAt: number;
}

type LeaseRow = { page_id: string; node_id: string; turn_id: string; acquired_at: number; expires_at: number };

const toLease = (row: LeaseRow): PageEditLease => ({
  pageId: row.page_id, nodeId: row.node_id, turnId: row.turn_id, acquiredAt: row.acquired_at, expiresAt: row.expires_at,
});

function liveRow(pageId: string, now: number): LeaseRow | undefined {
  return getDb().prepare(`SELECT l.page_id,l.node_id,l.turn_id,l.acquired_at,l.expires_at FROM page_edit_leases l
    WHERE l.page_id=? AND l.expires_at>?
    AND EXISTS(SELECT 1 FROM turns t WHERE t.turn_id=l.turn_id AND t.node_id=l.node_id AND t.status='active')`)
    .get(pageId, now) as LeaseRow | undefined;
}

/** The live lease on a page, if a chat turn is editing it now. */
export function livePageEditLease(pageId: string, now = Date.now()): PageEditLease | null {
  const row = liveRow(pageId, now);
  return row ? toLease(row) : null;
}

export type AcquirePageEditLeaseResult =
  | { acquired: true; lease: PageEditLease }
  | { acquired: false; lease: PageEditLease };

/**
 * Take or renew the page's lease for this turn. Renewal moves the idle expiry
 * forward but never past acquiredAt + PAGE_EDIT_LEASE_MAX_MS. A lease past
 * either limit is free to anyone, its former holder included, from a fresh
 * acquiredAt. Runs in its own savepoint, so it also composes inside a write.
 */
export function acquirePageEditLease(args: {
  pageId: string; ownerUserId: string; workspaceId: string; holder: PageEditLeaseHolder; now: number;
}): AcquirePageEditLeaseResult {
  const { pageId, holder, now } = args;
  return pagesTransaction(() => {
    const db = getDb();
    db.prepare('DELETE FROM page_edit_leases WHERE expires_at<=?').run(now);
    const live = liveRow(pageId, now);
    if (live && (live.turn_id !== holder.turnId || live.node_id !== holder.nodeId)) {
      return { acquired: false as const, lease: toLease(live) };
    }
    const acquiredAt = live ? live.acquired_at : now;
    const expiresAt = Math.min(now + PAGE_EDIT_LEASE_IDLE_MS, acquiredAt + PAGE_EDIT_LEASE_MAX_MS);
    db.prepare(`INSERT INTO page_edit_leases(page_id,owner_user_id,workspace_id,node_id,turn_id,acquired_at,touched_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(page_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,workspace_id=excluded.workspace_id,
        node_id=excluded.node_id,turn_id=excluded.turn_id,acquired_at=excluded.acquired_at,
        touched_at=excluded.touched_at,expires_at=excluded.expires_at`)
      .run(pageId, args.ownerUserId, args.workspaceId, holder.nodeId, holder.turnId, acquiredAt, now, expiresAt);
    return { acquired: true as const, lease: { pageId, nodeId: holder.nodeId, turnId: holder.turnId, acquiredAt, expiresAt } };
  });
}

function holderTitle(nodeId: string): string | null {
  const row = getDb().prepare('SELECT title FROM nodes WHERE id=?').get(nodeId) as { title: string | null } | undefined;
  const title = row?.title?.trim();
  return title ? title.slice(0, 160) : null;
}

/** What a reader is told about someone else's live lease. */
export function describeOtherLease(lease: PageEditLease, now: number) {
  return {
    status: 'busy' as const,
    holderNodeId: lease.nodeId,
    holderTitle: holderTitle(lease.nodeId),
    expiresAt: lease.expiresAt,
    retryAfterSeconds: Math.max(1, Math.ceil((lease.expiresAt - now) / 1000)),
  };
}

/** Refuse a chat write to a page another chat turn is editing. */
export class PageEditBusyError extends PageWriteError {
  constructor(public readonly lease: PageEditLease, message: string) {
    super(409, 'page_busy', message);
    this.name = 'PageEditBusyError';
  }
}

export function chatBusyError(lease: PageEditLease, now: number): PageEditBusyError {
  const other = describeOtherLease(lease, now);
  const who = other.holderTitle ? `conversation "${other.holderTitle}" (${other.holderNodeId})` : `conversation ${other.holderNodeId}`;
  return new PageEditBusyError(lease, `PAGE_BUSY: ${who} is editing this page. Nothing was saved. `
    + `Its edit lease ends when that turn finishes, or within ${other.retryAfterSeconds}s at the latest. `
    + 'Tell the user, or read the page again later before editing it.');
}

/** Message for maintenance, which leaves the page pending instead of racing the conversation. */
export function maintenanceBusyError(lease: PageEditLease): PageEditBusyError {
  return new PageEditBusyError(lease, 'PAGE_BUSY: a conversation is editing this page right now. '
    + 'Do not write it and do not record maintenance_no_change for it: leave it pending. '
    + 'Michi resumes this source after that conversation finishes. Continue with the source\'s other resources.');
}
