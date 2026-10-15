/** Crew's catalog selects the declared agent name, not its namespaced filename. */
export const MICHI_CREW_AGENT_TEMPLATE = 'michi-crew';

/** Also covers custom templates and old resumed sessions without replacing their identity. */
export function crewTurnFormat(enableFollowUps: boolean): string {
    const followUps = enableFollowUps
        ? 'Then three separate [FOLLOW-UP 1/3: question], [FOLLOW-UP 2/3: question], [FOLLOW-UP 3/3: question] lines: questions the user would ask you next, in their language.'
        : 'Follow-ups are disabled; emit no FOLLOW-UP lines.';
    return `\n\n[Michi final-answer format: first line [TITLE: short summary]. ${followUps} Last line [BRANCH-OVERVIEW: 1-3 sentences about this turn]. Keep metadata out of commentary. No tools are needed for this metadata.]`;
}
