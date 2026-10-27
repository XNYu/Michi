import { getDb } from '../db';
import { listWorkspaceHomes } from '../pages/homePages';
import { getHomeState, updateHomeState } from './firstRunStore';

/** Mirrors the home-cards storage contract (shared/src/homeCards.ts once it lands). */
export const HOME_CARD_KINDS = ['continue', 'try', 'from-space', 'review', 'stalled', 'discover', 'tip'] as const;
export type HomeCardKind = (typeof HOME_CARD_KINDS)[number];
const LIMITS = { sets: 8, cardsPerSet: 6, id: 200, label: 80, title: 200, reason: 500, buttonText: 40, prompt: 4000, greeting: 300 } as const;
const MODEL_SETS = 3;

export interface HomeCard {
  id: string; kind: HomeCardKind; label: string;
  source: { workspaceId?: string; pageId?: string; threadNodeId?: string };
  title: string; reason: string; buttonText: string; prompt: string; workspaceId: string | null;
}
export interface HomeCardsWrite {
  greeting: { text: string; detail: string | null } | null;
  sets: Array<{ cards: HomeCard[] }>;
  inputFingerprint: string | null;
}

/** Where generated cards are stored. Until the home-cards storage is wired, cards stay in the Meta agent state. */
export interface HomeCardsSink { write(ownerUserId: string, cards: HomeCardsWrite, now: number): void }
let sink: HomeCardsSink | null = null;
export function configureHomeCardsSink(next: HomeCardsSink | null): void { sink = next; }

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;

/** The last ```json block of a reply. */
export function extractCardsJson(reply: string): unknown {
  const blocks = [...reply.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return null;
  try { return JSON.parse(last); } catch { return null; }
}

function knownRefs(ownerUserId: string) {
  const workspaces = new Set(listWorkspaceHomes(ownerUserId).map((home) => home.workspaceId));
  const page = getDb().prepare('SELECT workspace_id FROM pages WHERE id=? AND owner_user_id=? AND deleted_at IS NULL');
  const node = getDb().prepare("SELECT workspace_id FROM nodes WHERE id=? AND kind='chat' AND deleted_at IS NULL AND maintenance_job_id IS NULL");
  return {
    workspace: (id: unknown) => typeof id === 'string' && workspaces.has(id),
    page: (id: unknown) => typeof id === 'string' && !!page.get(id, ownerUserId),
    node: (id: unknown) => typeof id === 'string' && workspaces.has(((node.get(id) as { workspace_id: string } | undefined)?.workspace_id) ?? ''),
  };
}

function card(value: unknown, refs: ReturnType<typeof knownRefs>): HomeCard | null {
  if (!isObject(value)) return null;
  const id = text(value.id, LIMITS.id);
  const kind = HOME_CARD_KINDS.find((entry) => entry === value.kind);
  const label = text(value.label, LIMITS.label);
  const title = text(value.title, LIMITS.title);
  const reason = text(value.reason, LIMITS.reason);
  const buttonText = text(value.buttonText, LIMITS.buttonText);
  const prompt = text(value.prompt, LIMITS.prompt);
  if (!id || !kind || !label || !title || !reason || !buttonText || !prompt) return null;
  const workspaceId = value.workspaceId === null || value.workspaceId === undefined ? null : value.workspaceId;
  if (workspaceId !== null && !refs.workspace(workspaceId)) return null;
  const rawSource = isObject(value.source) ? value.source : {};
  const source: HomeCard['source'] = {};
  const present = (field: unknown) => field !== undefined && field !== null;
  if (present(rawSource.workspaceId)) { if (!refs.workspace(rawSource.workspaceId)) return null; source.workspaceId = rawSource.workspaceId as string; }
  if (present(rawSource.pageId)) { if (!refs.page(rawSource.pageId)) return null; source.pageId = rawSource.pageId as string; }
  if (present(rawSource.threadNodeId)) { if (!refs.node(rawSource.threadNodeId)) return null; source.threadNodeId = rawSource.threadNodeId as string; }
  return { id, kind, label, source, title, reason, buttonText, prompt, workspaceId: workspaceId as string | null };
}

/**
 * Keeps only cards that name things the owner has: unknown ids, a second tip
 * in a set and a repeated subject are dropped rather than failing the batch.
 */
export function parseCardTemplates(value: unknown, ownerUserId: string, inputFingerprint: string): HomeCardsWrite | null {
  if (!isObject(value) || !Array.isArray(value.sets)) return null;
  const refs = knownRefs(ownerUserId);
  const greetingText = isObject(value.greeting) ? text(value.greeting.text, LIMITS.greeting) : null;
  const greeting = greetingText && isObject(value.greeting)
    ? { text: greetingText, detail: text(value.greeting.detail, LIMITS.greeting) } : null;
  const ids = new Set<string>();
  const sets: HomeCardsWrite['sets'] = [];
  for (const rawSet of value.sets.slice(0, Math.min(MODEL_SETS, LIMITS.sets))) {
    const raw = isObject(rawSet) && Array.isArray(rawSet.cards) ? rawSet.cards : [];
    const cards: HomeCard[] = [];
    for (const entry of raw) {
      const parsed = card(entry, refs);
      if (!parsed || ids.has(parsed.id) || (parsed.kind === 'tip' && cards.some((other) => other.kind === 'tip'))) continue;
      ids.add(parsed.id);
      cards.push(parsed);
      if (cards.length === LIMITS.cardsPerSet) break;
    }
    if (cards.length) sets.push({ cards });
  }
  if (!sets.length && !greeting) return null;
  return { greeting, sets, inputFingerprint };
}

const DAY_MS = 86_400_000;
const startOfDay = (ms: number) => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };

/** Replaces {{days:<ms>}} with the whole days since then, so date wording changes without a model call. */
export function renderDateWording(value: string, now: number): string {
  return value.replace(/\{\{days:(\d{1,15})\}\}/g, (_match, ms: string) =>
    String(Math.max(0, Math.round((startOfDay(now) - startOfDay(Number(ms))) / DAY_MS))));
}

export function renderCards(templates: HomeCardsWrite, now: number): HomeCardsWrite {
  const render = (value: string) => renderDateWording(value, now);
  return {
    greeting: templates.greeting ? { text: render(templates.greeting.text), detail: templates.greeting.detail ? render(templates.greeting.detail) : null } : null,
    sets: templates.sets.map((set) => ({ cards: set.cards.map((entry) => ({ ...entry, label: render(entry.label), title: render(entry.title),
      reason: render(entry.reason), buttonText: render(entry.buttonText), prompt: render(entry.prompt) })) })),
    inputFingerprint: templates.inputFingerprint,
  };
}

function publish(ownerUserId: string, templates: HomeCardsWrite, now: number): void {
  const rendered = JSON.stringify(renderCards(templates, now));
  const state = getHomeState(ownerUserId);
  if (!sink || state?.cardsRendered === rendered) return;
  sink.write(ownerUserId, JSON.parse(rendered) as HomeCardsWrite, now);
  updateHomeState(ownerUserId, { cards_rendered: rendered }, now);
}

/** Stores the cards a summary turn ended its reply with. Returns false when the reply had none that hold. */
export function generateHomeCards(ownerUserId: string, assistantMessageId: string | null, inputFingerprint: string, now: number): boolean {
  if (!assistantMessageId) return false;
  const row = getDb().prepare('SELECT content FROM messages WHERE id=?').get(assistantMessageId) as { content: string } | undefined;
  const templates = row ? parseCardTemplates(extractCardsJson(row.content), ownerUserId, inputFingerprint) : null;
  if (!templates) return false;
  updateHomeState(ownerUserId, { cards_json: JSON.stringify(templates), cards_fingerprint: inputFingerprint }, now);
  publish(ownerUserId, templates, now);
  return true;
}

/** Re-renders the stored cards for today; never calls a model. */
export function refreshHomeCards(ownerUserId: string, now: number): void {
  const state = getHomeState(ownerUserId);
  if (!state?.cardsJson) return;
  publish(ownerUserId, JSON.parse(state.cardsJson) as HomeCardsWrite, now);
}
