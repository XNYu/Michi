const PURPOSE_KEY = '__tool_use_purpose';
const WRAPPERS = ['arguments', 'args', 'input', 'rawInput', 'parameters'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function compact(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function readPurposeKey(obj: Record<string, unknown>): string | undefined {
  return typeof obj[PURPOSE_KEY] === 'string' ? compact(obj[PURPOSE_KEY]) : undefined;
}

function regexPurpose(raw: string): string | undefined {
  const match = raw.match(/"__tool_use_purpose"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) return undefined;
  try {
    return compact(JSON.parse(`"${match[1]}"`));
  } catch {
    return compact(match[1]);
  }
}

/**
 * The agent's stated why-string for a tool call. Only `__tool_use_purpose`
 * counts — paths, commands, and result dumps are row detail, not purpose.
 * Accepts a parsed object, a JSON string, or common arg wrappers.
 */
export function extractToolUsePurpose(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      const fromObj = extractToolUsePurpose(JSON.parse(trimmed));
      if (fromObj) return fromObj;
    } catch {
      // truncated / invalid JSON — the regex still finds a leading key
    }
    return regexPurpose(trimmed);
  }
  const obj = asRecord(input);
  if (!obj) return undefined;
  const direct = readPurposeKey(obj);
  if (direct) return direct;
  for (const key of WRAPPERS) {
    const nested = extractToolUsePurpose(obj[key]);
    if (nested) return nested;
  }
  return undefined;
}
