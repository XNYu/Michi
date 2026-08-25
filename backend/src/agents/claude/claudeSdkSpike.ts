export const CLAUDE_AGENT_SDK_ENV = "MICHI_CLAUDE_AGENT_SDK";
export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export function isClaudeAgentSdkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[CLAUDE_AGENT_SDK_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export interface ClaudeSdkSpikeStatus {
  enabled: boolean;
  replacesClaudeRuntime: false;
  teamsAvailable: false;
  packageLoaded: boolean;
  notes: string;
}

export async function tryLoadClaudeAgentSdk(): Promise<object | null> {
  if (!isClaudeAgentSdkEnabled()) return null;
  try {
    return await import(CLAUDE_AGENT_SDK_PACKAGE);
  } catch {
    return null;
  }
}

export async function describeClaudeSdkSpike(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeSdkSpikeStatus> {
  const enabled = isClaudeAgentSdkEnabled(env);
  if (!enabled) {
    return {
      enabled: false,
      replacesClaudeRuntime: false,
      teamsAvailable: false,
      packageLoaded: false,
      notes: "Default Claude path remains ClaudeRuntime stream-json. SDK spike is off.",
    };
  }
  const loaded = await tryLoadClaudeAgentSdk();
  return {
    enabled: true,
    replacesClaudeRuntime: false,
    teamsAvailable: false,
    packageLoaded: loaded !== null,
    notes: loaded
      ? "Claude Agent SDK loaded for spike only. Teams do not spawn in Agent SDK / -p. Do not advertise Teams."
      : "MICHI_CLAUDE_AGENT_SDK=1 but @anthropic-ai/claude-agent-sdk is not installed. ClaudeRuntime remains the runner.",
  };
}
