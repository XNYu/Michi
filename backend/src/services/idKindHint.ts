/**
 * Text appended to a "workspace not found" error when the id the agent passed is a
 * thread ("t-...") or node ("n-...") id, which models often hand to workspaceId.
 * Empty for any other id.
 */
export function workspaceIdKindHint(id: unknown): string {
  return typeof id === 'string' && /^[tn]-/.test(id.trim())
    ? ' That looks like a thread or node id, not a workspace id.'
    : '';
}
