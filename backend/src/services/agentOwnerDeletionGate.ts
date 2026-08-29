import { getDb } from './db';

export const AGENT_OWNER_DELETION_LEASE_MS = 5 * 60 * 1_000;

interface DeletionLeaseRow {
  deletion_token: string;
  expires_at: number;
}

export function assertAgentOwnerWritable(ownerUserId: string, now = Date.now()): void {
  const row = getDb().prepare(`SELECT deletion_token, expires_at FROM agent_owner_deletions
    WHERE owner_user_id = ?`).get(ownerUserId) as DeletionLeaseRow | undefined;
  if (row && row.expires_at > now) {
    throw new Error('Agent owner data is being deleted');
  }
}

export function acquireAgentOwnerDeletion(input: {
  ownerUserId: string;
  deletionToken: string;
  leaseOwner: string;
  now: number;
  expiresAt: number;
}): boolean {
  const result = getDb().prepare(`INSERT INTO agent_owner_deletions
    (owner_user_id, deletion_token, lease_owner, started_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET
      deletion_token = excluded.deletion_token,
      lease_owner = excluded.lease_owner,
      started_at = excluded.started_at,
      expires_at = excluded.expires_at
    WHERE agent_owner_deletions.expires_at <= ?`).run(
    input.ownerUserId,
    input.deletionToken,
    input.leaseOwner,
    input.now,
    input.expiresAt,
    input.now,
  );
  return Number(result.changes) === 1;
}

export function requireAgentOwnerDeletion(ownerUserId: string, deletionToken: string, now = Date.now()): void {
  const row = getDb().prepare(`SELECT deletion_token, expires_at FROM agent_owner_deletions
    WHERE owner_user_id = ?`).get(ownerUserId) as DeletionLeaseRow | undefined;
  if (!row || row.deletion_token !== deletionToken || row.expires_at <= now) {
    throw new Error('Agent owner deletion lease was lost');
  }
}

export function releaseAgentOwnerDeletion(ownerUserId: string, deletionToken: string): boolean {
  return Number(getDb().prepare(`DELETE FROM agent_owner_deletions
    WHERE owner_user_id = ? AND deletion_token = ?`).run(ownerUserId, deletionToken).changes) === 1;
}
