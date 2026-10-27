import type { RuntimePermissionDecision } from './types';

// ---------------------------------------------------------------------------
// Permission vocabulary
//
// The option ids a session accepts in `AgentSession.respondToPermission`.
// Chat approvals offer all four; a headless owner (an Agent Run) never gets
// `allow_session`, and its `allow_always` approves only the one request.
// ---------------------------------------------------------------------------

/** Every permission option id, in the order chat approvals present them. */
export const CHAT_APPROVAL_OPTION_IDS = ['reject_once', 'allow_once', 'allow_always', 'allow_session'] as const;

export type PermissionOptionId = typeof CHAT_APPROVAL_OPTION_IDS[number];

/** The option ids a headless owner may answer with: every session rejects allow_session for it. */
export type HeadlessPermissionOptionId = Exclude<PermissionOptionId, 'allow_session'>;

export function isPermissionOptionId(value: unknown): value is PermissionOptionId {
  return typeof value === 'string' && (CHAT_APPROVAL_OPTION_IDS as readonly string[]).includes(value);
}

/**
 * Maps a resolved broker decision to the option id every runtime session
 * accepts. A denial is sent as `reject_once`, never as the decision name.
 */
export function decisionToOptionId(decision: Exclude<RuntimePermissionDecision, 'ask'>): HeadlessPermissionOptionId {
  switch (decision) {
    case 'allow_once': return 'allow_once';
    case 'allow_always': return 'allow_always';
    case 'deny': return 'reject_once';
  }
}
