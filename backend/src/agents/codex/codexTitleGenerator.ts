import type { CodexAppServerClient } from './CodexAppServerClient';

const DEFAULT_TITLE_TIMEOUT_MS = 10_000;
const MAX_TITLE_INPUT_CHARS = 4_000;
const MAX_TITLE_CHARS = 80;

const TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
  },
  required: ['title'],
  additionalProperties: false,
} as const;

const TITLE_INSTRUCTIONS = `Create a concise title for the user's request before the main assistant begins working.
Do not answer the request, plan the work, use tools, or discuss your reasoning.
Match the user's language. Prefer 4-8 words for space-delimited languages or 8-20 characters for Chinese/Japanese.
Return only the JSON object required by the output schema.`;

export interface GenerateCodexTitleOptions {
  client: CodexAppServerClient;
  cwd: string;
  model: string | null;
  userText: string;
  timeoutMs?: number;
  onThreadStarted?: (threadId: string) => void;
}

function threadIdFrom(result: Record<string, unknown>): string | null {
  const thread = result['thread'] as Record<string, unknown> | undefined;
  return (typeof thread?.['id'] === 'string' ? thread['id'] : null)
    ?? (typeof result['threadId'] === 'string' ? result['threadId'] : null);
}

function truncateChars(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

function cleanTitle(value: string): string {
  let title = value.trim();
  const sentinel = /^\[TITLE:\s*([^\]]+)\]$/i.exec(title);
  if (sentinel) title = sentinel[1];
  title = title
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateChars(title, MAX_TITLE_CHARS).replace(/[\s:：,，;；.!?。！？-]+$/u, '').trim();
}

export function fallbackCodexTitle(userText: string): string {
  const plain = userText
    .replace(/^\s*\/(?:btw|branch)\s+/i, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#\[\]()]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const firstPhrase = plain.split(/(?<=[。！？.!?])\s*/u)[0] ?? plain;
  return cleanTitle(truncateChars(firstPhrase, 48)) || 'New Codex Request';
}

export function parseGeneratedCodexTitle(raw: string, userText: string): string {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch && objectMatch[0] !== trimmed) candidates.unshift(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed.title === 'string') {
        const title = cleanTitle(parsed.title);
        if (title) return title;
      }
    } catch {
      const title = cleanTitle(candidate);
      if (title && !title.startsWith('{')) return title;
    }
  }
  return fallbackCodexTitle(userText);
}

export async function generateCodexTitle(opts: GenerateCodexTitleOptions): Promise<string> {
  const startResult = await opts.client.request('thread/start', {
    model: opts.model || undefined,
    cwd: opts.cwd,
    developerInstructions: TITLE_INSTRUCTIONS,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
  }) as Record<string, unknown>;
  const threadId = threadIdFrom(startResult);
  if (!threadId) throw new Error('codex title thread/start did not return a threadId');
  opts.onThreadStarted?.(threadId);

  let output = '';
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe = () => {};
  const timeoutMs = opts.timeoutMs
    ?? parseInt(process.env.MICHI_CODEX_TITLE_TIMEOUT_MS ?? String(DEFAULT_TITLE_TIMEOUT_MS), 10);

  const completed = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      void opts.client.request('turn/interrupt', { threadId }).catch(() => {});
      reject(new Error(`codex title generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    unsubscribe = opts.client.onNotification(threadId, (method, params) => {
      if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
        output += params['delta'];
        return;
      }
      if (method !== 'turn/completed') return;
      const turn = (params['turn'] ?? params) as Record<string, unknown>;
      if (turn['status'] === 'failed') {
        reject(new Error('codex title generation turn failed'));
      } else {
        resolve(output);
      }
    });
  });

  try {
    const [, rawTitle] = await Promise.all([
      opts.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: truncateChars(opts.userText, MAX_TITLE_INPUT_CHARS) }],
        effort: 'low',
        summary: 'none',
        outputSchema: TITLE_OUTPUT_SCHEMA,
      }),
      completed,
    ]);
    return parseGeneratedCodexTitle(rawTitle, opts.userText);
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
  }
}
