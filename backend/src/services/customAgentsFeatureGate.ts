/** The one switch for Custom Agents — Agent definitions, Agent Runs and the
 *  Agent Run tools. Off unless this variable is exactly '1'. */
export const CUSTOM_AGENTS_ENV = 'MICHI_CUSTOM_AGENTS';

export interface CustomAgentsFeatureControl {
  isEnabled(): boolean;
}

/**
 * Environment-only feature gate, read once at startup.
 *
 * There is deliberately no in-app or persisted way to turn the feature on: no
 * Settings switch, no API, and a `customAgents.enabled` left in config.json by
 * an earlier build is ignored. Enabling it is an operator decision made in the
 * backend's environment (shell, `backend/.env`, or `~/.michi/.env` for the
 * packaged app), and takes a restart.
 */
export class CustomAgentsFeatureGate implements CustomAgentsFeatureControl {
  private readonly enabled: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.enabled = env[CUSTOM_AGENTS_ENV] === '1';
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
