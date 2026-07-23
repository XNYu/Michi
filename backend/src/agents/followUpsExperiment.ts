import { followUpReminder, type MetadataOutputMode } from './preamble';

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

/**
 * Select the per-turn reminder without leaking the legacy sentinel protocol
 * into structured tool mode. Native runtimes share this helper so Claude and
 * Codex cannot drift back into generating both metadata forms.
 */
export function followUpsTurnReminder(
  userTurnCount: number,
  hookPocEnabled: boolean,
  mode: FollowUpsExperimentMode,
  enableFollowUps: boolean = true,
): string {
  if (hookPocEnabled) {
    // The sentinel reminder only carries the follow-up sentinel protocol, so
    // dropping it when follow-ups are disabled leaves branch-overview intact.
    if (!enableFollowUps) return '';
    return mode === 'sentinel' ? FOLLOW_UPS_SENTINEL_TURN_REMINDER : '';
  }
  return followUpReminder(userTurnCount, enableFollowUps);
}

export function followUpsMetadataOutputMode(
  hookPocEnabled: boolean,
  mode: FollowUpsExperimentMode,
): MetadataOutputMode {
  if (!hookPocEnabled) return 'sentinel';
  return mode === 'hook-tool'
    ? 'structured-tool'
    : 'sentinel-followups-tool-overview';
}
