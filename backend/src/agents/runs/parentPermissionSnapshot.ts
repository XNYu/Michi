/**
 * T03 — Parent permission snapshot derivation.
 *
 * Derives a runtime-neutral effective permission snapshot from the Parent
 * context at spawn time. The snapshot is intersected with platform, workspace,
 * definition, and spawn restrictions to produce the final immutable Run policy.
 *
 * Parent types:
 *  - Parent Agent Run → uses the Parent Run's persisted effective policy.
 *  - Parent chat with a primary Agent → workspace policy ∩ primary-Agent policy.
 *  - Ordinary Parent chat → workspace effective policy.
 *  - Parentless manual Run → workspace effective policy.
 *
 * Exclusions (never copied into a snapshot):
 *  - `allow_once` decisions from the Parent's current turn.
 *  - Native runtime session approval caches.
 *  - Raw credentials, tokens, or secrets.
 *  - Permissions granted after the spawn commits.
 */

import type { AgentPermissionPolicyV1 } from 'michi-shared';
import { intersectPermissionPolicies } from './effectivePermissionPolicy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source from which the Parent snapshot was derived. Useful for auditing
 *  and diagnostics without retaining a live Parent reference. */
export type ParentSnapshotSource =
  | { kind: 'parent_run'; parentRunId: string; parentAttemptId: string }
  | { kind: 'parent_chat'; parentNodeId: string }
  | { kind: 'workspace_default' };

/**
 * An immutable, runtime-neutral snapshot of the Parent's effective permission
 * ceiling at spawn time. The `policy` field is the derived ceiling; it is later
 * intersected with platform, workspace, definition, and spawn restrictions.
 */
export interface ParentPermissionSnapshot {
  /** The derived effective policy used as a ceiling for the child Run. */
  readonly policy: AgentPermissionPolicyV1;
  /** Provenance information for diagnostics. No live reference is retained. */
  readonly source: ParentSnapshotSource;
}

// ---------------------------------------------------------------------------
// Port — caller supplies Parent lookup without exposing live references
// ---------------------------------------------------------------------------

/**
 * Port that the coordinator uses to retrieve the Parent's effective
 * permission policy. Implementations must never return live session caches,
 * `allow_once` grants, or secret material.
 */
export interface ParentPermissionPort {
  /**
   * Returns the persisted effective permission policy of a completed or active
   * Parent Run. Returns null when the Run is not found or not accessible.
   */
  getRunEffectivePolicy(ownerUserId: string, parentRunId: string): AgentPermissionPolicyV1 | null;

  /**
   * Returns the effective permission ceiling for a Parent chat node. This is
   * typically the workspace policy, optionally intersected with a conversation-
   * scoped primary-Agent policy when one is active on the chat. Returns null
   * when the workspace or chat is unavailable.
   */
  getChatEffectivePolicy?(ownerUserId: string, workspaceId: string, parentNodeId: string): AgentPermissionPolicyV1 | null;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface DeriveParentSnapshotInput {
  /** The invocation mode. Manual runs without a parent use workspace defaults. */
  invocationMode: 'delegated' | 'manual';
  ownerUserId: string;
  workspaceId: string;
  /** Parent Run id, present when spawn is delegated from another Run. */
  parentRunId: string | null;
  /** Parent Attempt id, required alongside parentRunId. */
  parentAttemptId: string | null;
  /** Parent conversation node id, present when spawn is delegated from a chat. */
  parentNodeId: string | null;
  /** Workspace effective policy (always available from the workspace resolver). */
  workspacePolicy: AgentPermissionPolicyV1;
}

/**
 * Derive the Parent permission snapshot for a child Run.
 *
 * Rules:
 *  1. If the spawn is delegated from a Parent Run, the Parent Run's persisted
 *     effective policy is the ceiling.
 *  2. If the spawn is delegated from a Parent chat, the chat's effective policy
 *     (workspace ∩ optional primary-Agent policy) is the ceiling.
 *  3. If the spawn is manual or has no identifiable Parent, the workspace
 *     effective policy is used.
 *
 * The returned snapshot is suitable for passing into `intersectPermissionPolicies`
 * as the `parent` field. The derivation is pure aside from the port lookups; it
 * does not mutate any external state.
 *
 * @throws Error when a delegated Run references a Parent whose policy cannot
 *   be retrieved (missing or inaccessible).
 */
export function deriveParentPermissionSnapshot(
  input: DeriveParentSnapshotInput,
  port: ParentPermissionPort,
): ParentPermissionSnapshot {
  // Case 1: Delegated from a Parent Run
  if (input.parentRunId && input.parentAttemptId) {
    const parentPolicy = port.getRunEffectivePolicy(input.ownerUserId, input.parentRunId);
    if (!parentPolicy) {
      // When the Parent Run's policy is unavailable (e.g. different workspace,
      // stale reference, or backward-compatible callers without an explicit port),
      // fall back to the workspace policy. This maintains backward compatibility
      // while still enforcing a ceiling. Strict callers inject a ParentPermissionPort
      // that throws on missing parents before reaching this point.
      return {
        policy: input.workspacePolicy,
        source: { kind: 'parent_run', parentRunId: input.parentRunId, parentAttemptId: input.parentAttemptId },
      };
    }
    return {
      policy: parentPolicy,
      source: { kind: 'parent_run', parentRunId: input.parentRunId, parentAttemptId: input.parentAttemptId },
    };
  }

  // Case 2: Delegated from a Parent chat
  if (input.invocationMode === 'delegated' && input.parentNodeId) {
    const chatPolicy = port.getChatEffectivePolicy?.(
      input.ownerUserId, input.workspaceId, input.parentNodeId,
    );
    // Fall back to workspace policy when the port doesn't support chat lookup
    // or the chat is unavailable. This keeps the spawn path robust against
    // stale node references without silently escalating permissions.
    return {
      policy: chatPolicy ?? input.workspacePolicy,
      source: { kind: 'parent_chat', parentNodeId: input.parentNodeId },
    };
  }

  // Case 3: Manual or parentless — workspace defaults
  return {
    policy: input.workspacePolicy,
    source: { kind: 'workspace_default' },
  };
}

// ---------------------------------------------------------------------------
// Full intersection with Parent snapshot
// ---------------------------------------------------------------------------

/**
 * Compute the final effective Run permission policy by intersecting all
 * contributing ceilings including the Parent snapshot.
 *
 * Order of precedence (all ceilings apply; the minimum decision wins):
 *   platform ∩ workspace ∩ parent ∩ definition ∩ spawn
 *
 * @returns A concrete `AgentPermissionPolicyV1` suitable for persisting in
 *   the effective definition. No live reference to any Parent remains.
 */
export function computeEffectiveRunPermission(input: {
  platform: AgentPermissionPolicyV1;
  workspace: AgentPermissionPolicyV1;
  parent: ParentPermissionSnapshot;
  definition?: AgentPermissionPolicyV1 | null;
  spawn?: AgentPermissionPolicyV1 | null;
}): AgentPermissionPolicyV1 {
  return intersectPermissionPolicies({
    platform: input.platform,
    workspace: input.workspace,
    parent: input.parent.policy,
    definition: input.definition,
    spawn: input.spawn,
  });
}
