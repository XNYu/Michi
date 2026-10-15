/** Opt-in wording for the isolated Node summary benchmark. */
export function fullNodeSummaryExperimentEnabled(): boolean {
  return process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE === 'full';
}

export const FULL_NODE_SUMMARY_INSTRUCTION =
  "Summarize this node's full conversation as its CURRENT state in 1-3 concise sentences: active goal, still-valid decisions and constraints, and unresolved work. Include earlier facts only when they still matter. Never present superseded decisions as current. Match the user's language.";
