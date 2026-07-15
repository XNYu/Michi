/**
 * Structured follow-ups can arrive while the runtime still owes a final
 * visible answer block. `outputBoundaryPending` is driven by the existing
 * follow_ups_status SSE event and clears only after that answer boundary.
 */
export function shouldShowFollowUps(
  followUpsCount: number,
  visibleTextSmoothing: boolean,
  outputBoundaryPending: boolean,
): boolean {
  return followUpsCount > 0 && !outputBoundaryPending && !visibleTextSmoothing;
}
