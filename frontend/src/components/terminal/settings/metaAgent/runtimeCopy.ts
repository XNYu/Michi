import { META_AGENT_RUNTIMES } from 'michi-shared';

// The Meta agent's runtime names and restriction lines, shared by
// Settings › Meta agent and Scheduled › Meta agent.

export type MetaAgentRuntimeId = typeof META_AGENT_RUNTIMES[number];

const LABELS: Record<MetaAgentRuntimeId, string> = {
  claude: 'Claude', pi: 'Pi', codex: 'Codex', kiro: 'Kiro', crew: 'Crew',
};

/** How each runtime is held to the Meta agent's own tools, in plain words. */
const RESTRICTIONS: Record<MetaAgentRuntimeId, string> = {
  claude: 'Michi checks tool access; external tools are read-only',
  pi: 'Michi checks tool access; external tools are read-only',
  codex: 'Michi checks tool access; external tools are read-only',
  kiro: 'Michi checks tool access; external tools are read-only',
  crew: 'the Meta agent can’t use Kiro Crew yet',
};

/** What Pi is, for someone choosing a runtime. */
export const PI_EXPLAINED = 'Pi runs inside Michi and calls an AI provider directly with your own key, so there is nothing to install.';

export interface RuntimeUnavailableText {
  /** One plain sentence, e.g. "Codex isn’t installed on this computer." */
  text: string;
  /** Commands that install it, when the runtime said how. */
  install: string[];
  /** The runtime's own words, for "Details", when they say more than the sentence. */
  detail: string | null;
}

const MISSING = /\bnot found\b|not installed/i;
const SIGNED_OUT = /\bsigned in\b|\bsign in\b|\blogged in\b|\blog in\b|\bauth|credential|api key/i;

/**
 * Why a runtime can't be chosen, in plain words. A missing CLI ("codex binary
 * not found. Tried: … Install with: npm install -g @openai/codex, or set
 * CODEX_CLI_BIN.") becomes "Codex isn't installed on this computer" and its
 * install commands; anything else keeps the runtime's words as the detail.
 */
export function runtimeUnavailableText(id: string, reason: string | null | undefined): RuntimeUnavailableText {
  const label = metaAgentRuntimeLabel(id);
  const raw = reason?.trim() || null;
  if (raw && MISSING.test(raw)) {
    const how = /Install with:\s*(.+?)\.?\s*$/i.exec(raw)?.[1] ?? '';
    const install = how.split(/,\s*(?:or\s+)?/).map((part) => part.trim()).filter((part) => part && !/^set\s/i.test(part));
    return { text: `${label} isn’t installed on this computer.`, install, detail: install.length ? null : raw };
  }
  if (raw && SIGNED_OUT.test(raw)) return { text: `${label} isn’t signed in on this computer.`, install: [], detail: raw };
  return { text: `${label} can’t be used on this computer right now.`, install: [], detail: raw };
}

/** Runtimes listed for the Meta agent but not offered in this version. */
const UNSUPPORTED: ReadonlySet<string> = new Set(['crew']);

export function isMetaAgentRuntimeSupported(id: string): boolean {
  return !UNSUPPORTED.has(id);
}

export function isMetaAgentRuntime(id: string): id is MetaAgentRuntimeId {
  return (META_AGENT_RUNTIMES as readonly string[]).includes(id);
}

export function metaAgentRuntimeLabel(id: string): string {
  return isMetaAgentRuntime(id) ? LABELS[id] : id;
}

export function metaAgentRestriction(id: string): string | null {
  return isMetaAgentRuntime(id) ? RESTRICTIONS[id] : null;
}

export interface MetaAgentProfile { runtimeId: string; modelId: string | null; reasoning: string | null }

/** "Claude · sonnet · reasoning high": what the Meta agent runs on, worded the same in Settings and the window. */
export function metaAgentProfileText(profile: MetaAgentProfile): string {
  return [
    metaAgentRuntimeLabel(profile.runtimeId),
    profile.modelId ?? 'default model',
    profile.reasoning ? `reasoning ${profile.reasoning}` : null,
  ].filter(Boolean).join(' · ');
}

/** The same with where it comes from: "… (follows global)" or "… (custom)". */
export function metaAgentResolvedText(resolved: MetaAgentProfile & { followsGlobal: boolean }): string {
  return `${metaAgentProfileText(resolved)} (${resolved.followsGlobal ? 'follows global' : 'custom'})`;
}
