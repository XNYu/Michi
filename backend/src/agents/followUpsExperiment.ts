export const FOLLOW_UPS_EXPERIMENT_MODE_ENV = 'MICHI_FOLLOW_UPS_EXPERIMENT_MODE';

export type FollowUpsExperimentMode = 'sentinel' | 'hook-tool';

/**
 * Sentinel is the experiment default: the Stop Hook guarantees only Branch
 * Overview, while follow-ups rely on a near-turn reminder plus the existing
 * text parser. Set `MICHI_FOLLOW_UPS_EXPERIMENT_MODE=hook-tool` to run the
 * previous structured Tool + Hook enforcement as the control group.
 */
export function resolveFollowUpsExperimentMode(
  env: NodeJS.ProcessEnv = process.env,
): FollowUpsExperimentMode {
  const raw = (env[FOLLOW_UPS_EXPERIMENT_MODE_ENV] ?? '').trim().toLowerCase();
  return raw === 'hook-tool' || raw === 'tool' || raw === 'hook'
    ? 'hook-tool'
    : 'sentinel';
}

/** Appended to every real user transport turn in sentinel mode. It stays out
 * of Michi history, so branches and resume transcripts do not accumulate it. */
export const FOLLOW_UPS_SENTINEL_TURN_REMINDER = `

[Follow-up metadata reminder for this turn: do not call set_follow_ups. At the absolute end of the final answer, emit exactly these three standalone sentinel lines, numbered in order and each closed with "]":
[FOLLOW-UP 1/3: a concise next question written in the user's voice and language]
[FOLLOW-UP 2/3: a concise next question written in the user's voice and language]
[FOLLOW-UP 3/3: a concise next question written in the user's voice and language]
The questions are what the user would ask you next, not questions you ask the user. Do not omit the closing brackets.]`;
