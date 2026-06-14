/**
 * Type-only Drizzle-style schema mirror for audit_log in audit.db.
 *
 * The actual table is created by the SQL migration runner
 * (runMigrations → src/db/auditMigrations/0000_audit_init.sql).
 * This file exists so TypeScript consumers get typed row shapes without
 * pulling in Drizzle at runtime (audit.db is accessed via DatabaseSync).
 */

export interface AuditLogRow {
  id: number;
  ts: number;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  ua: string | null;
  metadata_json: string | null;
}
