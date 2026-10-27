import type { ChatPermissionMode, PermissionOption } from 'michi-shared';
import { ownerMode, type RuntimeSessionOwner } from '../contract/types';
import type { HostPermissionDecision, PermissionPolicyPort } from '../contract/host';

// ---------------------------------------------------------------------------
// Chat approvals
//
// The approval state machine every session shares: single-use approvals,
// trust for the rest of a session, always-allow grants kept by the host, and
// whether one approval also answers another pending request. Policy and
// grants come from the host's PermissionPolicyPort. The coordinator knows no
// runtime's tool names: an adapter passes its own canonical form.
// ---------------------------------------------------------------------------

/** The name two tool names share when one always-allow grant covers both. */
export type ToolNameCanonicalizer = (toolName: string) => string;

const sameName: ToolNameCanonicalizer = (toolName) => toolName;

/**
 * Whether approving `approvedTool` with `choice` also answers a pending
 * request for `pendingTool`: trust for the session covers every tool, an
 * always-allow grant covers the same canonical tool.
 */
export function approvalCoversTool(
  choice: string | null,
  approvedTool?: string,
  pendingTool?: string,
  canonicalize: ToolNameCanonicalizer = sameName,
): boolean {
  return choice === 'allow_session' || (choice === 'allow_always' && !!approvedTool && !!pendingTool
    && canonicalize(approvedTool) === canonicalize(pendingTool));
}

/** The host keeps grants; providers receive only single-use approvals. A request without a tool name cannot be granted. */
export function chatApprovalOptions(toolName?: string): PermissionOption[] {
  return [
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Trust this tool', kind: 'allow_always', ...(!toolName ? { disabled: true } : {}) },
    { optionId: 'allow_session', name: 'Trust all tools for this session', kind: 'allow_session' },
  ];
}

export interface ApprovalCoordinatorOptions {
  permissions: PermissionPolicyPort;
  /**
   * Used only by covers(): whether answering one request also answers a
   * pending request for another tool name. Defaults to the name itself.
   * policy() and accept() pass the port the raw tool name, and the port
   * decides the grant key; for covers() to agree with decide(), the port
   * must key grants by the same canonical form.
   */
  canonicalize?: ToolNameCanonicalizer;
}

/** The key session trust is held under: an interactive owner's; a headless owner holds none. */
function trustKey(owner: RuntimeSessionOwner): string | undefined {
  return ownerMode(owner) === 'interactive' ? owner.key : undefined;
}

/**
 * One instance per runtime session. Recreating a session drops its trust for
 * all tools; an explicit permission change (the port's reset token) revokes
 * it even during the current turn. Only interactive owners acquire trust or
 * grants; a headless owner's approvals are single-use.
 */
export class ApprovalCoordinator {
  private sessionTrust: { ownerKey: string | undefined; ownerUserId: string | null; resetToken: string | undefined } | undefined;
  private readonly permissions: PermissionPolicyPort;
  private readonly canonicalize: ToolNameCanonicalizer;

  constructor(options: ApprovalCoordinatorOptions) {
    this.permissions = options.permissions;
    this.canonicalize = options.canonicalize ?? sameName;
  }

  /** A reset token that cannot be read counts as none. */
  private resetToken(owner: RuntimeSessionOwner, ownerUserId?: string | null): string | undefined {
    if (ownerMode(owner) !== 'interactive') return undefined;
    try { return this.permissions.resetToken?.(owner, ownerUserId); }
    catch { return undefined; }
  }

  /** Session trust while it holds for this owner and user, otherwise the host's policy. */
  policy(owner: RuntimeSessionOwner, ownerUserId: string | null, toolName: string, nativeRequest: boolean,
    mode?: ChatPermissionMode): HostPermissionDecision {
    if (this.sessionTrust && (ownerMode(owner) !== 'interactive' || this.sessionTrust.ownerKey !== trustKey(owner)
      || this.sessionTrust.ownerUserId !== (this.permissions.resolveOwnerUserId(owner, ownerUserId) ?? null)
      || this.sessionTrust.resetToken !== this.resetToken(owner, ownerUserId))) this.sessionTrust = undefined;
    if (ownerMode(owner) === 'interactive' && this.sessionTrust) return 'allow';
    return this.permissions.decide({ owner, ownerUserId, toolName, nativeRequest, mode });
  }

  /**
   * Records an answer and returns whether it approves the request. Always
   * allow writes a host grant for `toolName`; trust for the session lasts
   * until the session or its reset token changes.
   */
  accept(optionId: string | null, owner: RuntimeSessionOwner, toolName: string | undefined, ownerUserId?: string | null): boolean {
    if (optionId === 'allow_once') return true;
    if (ownerMode(owner) !== 'interactive') return false;
    if (optionId === 'allow_always' && toolName) {
      this.permissions.grant({ owner, toolName, ownerUserId });
      return true;
    }
    if (optionId === 'allow_session') {
      this.sessionTrust = { ownerKey: trustKey(owner), ownerUserId: this.permissions.resolveOwnerUserId(owner, ownerUserId) ?? null,
        resetToken: this.resetToken(owner, ownerUserId) };
      return true;
    }
    return false;
  }

  /** approvalCoversTool with this coordinator's canonical names. */
  covers(choice: string | null, approvedTool?: string, pendingTool?: string): boolean {
    return approvalCoversTool(choice, approvedTool, pendingTool, this.canonicalize);
  }
}
