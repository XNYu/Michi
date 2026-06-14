import type { AgentCommand, SessionMode } from '../services/api';

/** One entry in the autocomplete list. */
export interface SlashItem {
  /** The command name WITHOUT the leading slash. */
  name: string;
  /** Optional one-line description. */
  description?: string;
  /** 'local' = client-side (branch/fanout); 'kiro' = agent-advertised;
   *  'agent' = an agent/mode pick surfaced under /agent. */
  source: 'local' | 'kiro' | 'agent';
  /** When present, the popup inserts `/<name> ` and keeps the cursor at the end
   *  (so the user can type arguments). When false, we insert `/<name>`. */
  takesArgs: boolean;
  /** Only set for source='agent' — the ACP modeId to pass to session/set_mode. */
  modeId?: string;
}

/** Local commands the client handles directly. Merged with node.agentCommands. */
const LOCAL_COMMANDS: SlashItem[] = [
  {
    name: 'agent',
    description: 'Switch the active agent (kiro mode) for this chat.',
    source: 'local',
    takesArgs: true,
  },
  {
    name: 'branch',
    description: 'Open this message as a new child thread.',
    source: 'local',
    takesArgs: true,
  },
  {
    name: 'btw',
    description: 'Alias for /branch.',
    source: 'local',
    takesArgs: true,
  },
  {
    name: 'fanout',
    description: 'Spawn N parallel child branches: /fanout A; B; C',
    source: 'local',
    takesArgs: true,
  },
  {
    name: 'fan-out',
    description: 'Alias for /fanout.',
    source: 'local',
    takesArgs: true,
  },
  {
    name: 'explore',
    description: 'Alias for /fanout.',
    source: 'local',
    takesArgs: true,
  },
];

/** Does the current input put us "in a slash command"? Matches `/…` at the
 *  very start of the value, before any whitespace or newline. Returns the
 *  query (text after the slash) or null. Only triggers at position 0 so
 *  mid-paragraph slashes (like URLs) don't pop the menu. */
export function matchSlashContext(
  value: string,
  selectionStart: number | null,
): { query: string; command?: string } | null {
  if (!value.startsWith('/')) return null;
  // Pass 1: bare slash command being typed (no args yet).
  const head = value.match(/^\/([\w-]*)$/);
  if (head) {
    if (selectionStart !== null && selectionStart > value.length) return null;
    return { query: head[1] };
  }
  // Pass 2: `/agent <query>` — second-level picker for agent/mode selection.
  // Only trigger for known sub-picker commands so normal slash-prefixed args
  // (e.g. `/branch foo bar`) still close the popup.
  const sub = value.match(/^\/(agent)\s+([\w-]*)$/);
  if (sub) {
    if (selectionStart !== null && selectionStart > value.length) return null;
    return { query: sub[2], command: sub[1] };
  }
  return null;
}

/** Build agent picker items from the global agent list + the node's current mode. */
export function buildAgentItems(
  availableModes: SessionMode[] | undefined,
  currentModeId: string | null | undefined,
  query: string,
): SlashItem[] {
  if (!availableModes || availableModes.length === 0) return [];
  const q = query.toLowerCase();
  const items: SlashItem[] = availableModes.map((m) => ({
    name: m.name,
    description:
      m.id === currentModeId
        ? `✓ current · ${(m.description ?? '').slice(0, 120)}`
        : (m.description ?? '').slice(0, 120),
    source: 'agent',
    takesArgs: false,
    modeId: m.id,
  }));
  if (!q) return items;
  const prefix: SlashItem[] = [];
  const rest: SlashItem[] = [];
  for (const it of items) {
    const lower = it.name.toLowerCase();
    if (lower.startsWith(q)) prefix.push(it);
    else if (lower.includes(q)) rest.push(it);
  }
  return [...prefix, ...rest];
}

/** Merge local + kiro commands and filter by prefix (case-insensitive on name). */
export function buildSlashItems(
  agentCommands: AgentCommand[] | undefined,
  query: string,
): SlashItem[] {
  const kiroItems: SlashItem[] = (agentCommands ?? []).map((c) => ({
    name: c.name,
    description: c.description,
    source: 'kiro',
    // AvailableCommandInput.type === 'unstructured' means free text after the
    // command. Absent `input` means no args. Either way we insert a trailing
    // space so the user can type args if they want; it's a no-op if they don't.
    takesArgs: !!c.input,
  }));
  // Dedupe: if kiro publishes a command with the same name as a local one, the
  // local version wins (we own its semantics). This is rare but possible.
  const seen = new Set(LOCAL_COMMANDS.map((c) => c.name));
  const merged = [
    ...LOCAL_COMMANDS,
    ...kiroItems.filter((c) => !seen.has(c.name)),
  ];
  const q = query.toLowerCase();
  if (!q) return merged;
  // Prefer prefix matches, then substring matches for typos.
  const prefix: SlashItem[] = [];
  const rest: SlashItem[] = [];
  for (const it of merged) {
    const lower = it.name.toLowerCase();
    if (lower.startsWith(q)) prefix.push(it);
    else if (lower.includes(q)) rest.push(it);
  }
  return [...prefix, ...rest];
}
