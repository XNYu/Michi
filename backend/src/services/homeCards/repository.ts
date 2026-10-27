import { getPage } from '../pages/repository';
import { PageWriteError } from '../pages/core';
import {
  HOME_CARD_KINDS, HOME_CARD_LIMITS,
  type HomeCard, type HomeCardKind, type HomeCardSet, type HomeCardSource, type HomeCardUsedDto, type HomeCardsDto,
  type HomeCardsWrite, type HomeGreeting,
} from 'michi-shared';
import { getDb, runInTransaction } from '../db';

export class HomeCardsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HomeCardsError';
  }
}

type Obj = Record<string, unknown>;
type Row = { greeting: string | null; sets: string; input_fingerprint: string | null; generated_at: number };

const invalid = (message: string) => new HomeCardsError(400, 'invalid', message);
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

function onlyKeys(value: Obj, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) throw invalid(`${what}: unknown field ${extra}`);
}

function text(value: unknown, what: string, max: number, required: boolean): string {
  if (typeof value !== 'string') throw invalid(`${what} must be a string`);
  if (required && !value.trim()) throw invalid(`${what} must not be empty`);
  if (value.length > max) throw invalid(`${what} is longer than ${max} characters`);
  return value;
}

const id = (value: unknown, what: string): string => text(value, what, HOME_CARD_LIMITS.id, true);

function greeting(value: unknown): HomeGreeting | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw invalid('greeting must be an object or null');
  onlyKeys(value, ['text', 'detail'], 'greeting');
  const detail = value.detail === undefined || value.detail === null ? null : text(value.detail, 'greeting.detail', HOME_CARD_LIMITS.greeting, false);
  return { text: text(value.text, 'greeting.text', HOME_CARD_LIMITS.greeting, true), detail: detail?.trim() ? detail : null };
}

function source(value: unknown, what: string): HomeCardSource {
  if (!isObject(value)) throw invalid(`${what}.source must be an object`);
  onlyKeys(value, ['workspaceId', 'pageId', 'threadNodeId'], `${what}.source`);
  const out: HomeCardSource = {};
  for (const key of ['workspaceId', 'pageId', 'threadNodeId'] as const) {
    if (value[key] !== undefined) out[key] = id(value[key], `${what}.source.${key}`);
  }
  return out;
}

const CARD_KEYS = ['id', 'kind', 'label', 'source', 'title', 'reason', 'buttonText', 'prompt', 'workspaceId'] as const;

function card(value: unknown, what: string): HomeCard {
  if (!isObject(value)) throw invalid(`${what} must be an object`);
  onlyKeys(value, CARD_KEYS, what);
  if (!(HOME_CARD_KINDS as readonly unknown[]).includes(value.kind)) throw invalid(`${what}.kind is not a card kind`);
  if (!('workspaceId' in value)) throw invalid(`${what}.workspaceId is required (null for none)`);
  return {
    id: id(value.id, `${what}.id`),
    kind: value.kind as HomeCardKind,
    label: text(value.label, `${what}.label`, HOME_CARD_LIMITS.label, false),
    source: source(value.source, what),
    title: text(value.title, `${what}.title`, HOME_CARD_LIMITS.title, true),
    reason: text(value.reason, `${what}.reason`, HOME_CARD_LIMITS.reason, false),
    buttonText: text(value.buttonText, `${what}.buttonText`, HOME_CARD_LIMITS.buttonText, true),
    prompt: text(value.prompt, `${what}.prompt`, HOME_CARD_LIMITS.prompt, false),
    workspaceId: value.workspaceId === null ? null : id(value.workspaceId, `${what}.workspaceId`),
  };
}

/** Validates a PUT body. Card ids are unique across the whole write; a set holds at most one tip. */
export function parseHomeCardsWrite(body: unknown): HomeCardsWrite {
  if (!isObject(body)) throw invalid('body must be an object');
  onlyKeys(body, ['greeting', 'sets', 'inputFingerprint'], 'body');
  if (!Array.isArray(body.sets)) throw invalid('sets must be an array');
  if (body.sets.length > HOME_CARD_LIMITS.sets) throw invalid(`at most ${HOME_CARD_LIMITS.sets} sets`);
  const seen = new Set<string>();
  const sets: HomeCardSet[] = body.sets.map((set: unknown, s) => {
    if (!isObject(set)) throw invalid(`sets[${s}] must be an object`);
    onlyKeys(set, ['cards'], `sets[${s}]`);
    if (!Array.isArray(set.cards) || set.cards.length === 0 || set.cards.length > HOME_CARD_LIMITS.cardsPerSet) {
      throw invalid(`sets[${s}].cards must hold 1 to ${HOME_CARD_LIMITS.cardsPerSet} cards`);
    }
    const cards = set.cards.map((value: unknown, c) => card(value, `sets[${s}].cards[${c}]`));
    if (cards.filter((entry) => entry.kind === 'tip').length > HOME_CARD_LIMITS.tipsPerSet) {
      throw new HomeCardsError(400, 'too_many_tips', `sets[${s}] holds more than ${HOME_CARD_LIMITS.tipsPerSet} tip`);
    }
    for (const entry of cards) {
      if (seen.has(entry.id)) throw new HomeCardsError(400, 'duplicate_card', `card id ${entry.id} appears twice`);
      seen.add(entry.id);
    }
    return { cards };
  });
  const fingerprint = body.inputFingerprint === undefined || body.inputFingerprint === null
    ? null : text(body.inputFingerprint, 'inputFingerprint', HOME_CARD_LIMITS.fingerprint, true);
  return { greeting: greeting(body.greeting), sets, inputFingerprint: fingerprint };
}

const db = () => getDb();

function row(ownerUserId: string): Row | undefined {
  return db().prepare('SELECT greeting,sets,input_fingerprint,generated_at FROM home_cards WHERE owner_user_id=?')
    .get(ownerUserId) as Row | undefined;
}

function usedIds(ownerUserId: string): Set<string> {
  const rows = db().prepare('SELECT card_id FROM home_card_uses WHERE owner_user_id=?').all(ownerUserId) as Array<{ card_id: string }>;
  return new Set(rows.map((entry) => entry.card_id));
}

const storedSets = (stored: Row): HomeCardSet[] => JSON.parse(stored.sets) as HomeCardSet[];

/** The owner's greeting and sets, without the cards the owner already clicked. */
function readGeneratedHomeCards(ownerUserId: string): HomeCardsDto {
  const stored = row(ownerUserId);
  if (!stored) return { greeting: null, sets: [], generatedAt: null, inputFingerprint: null };
  const used = usedIds(ownerUserId);
  const sets = storedSets(stored)
    .map((set) => ({ cards: set.cards.filter((entry) => !used.has(entry.id)) }))
    .filter((set) => set.cards.length > 0);
  return {
    greeting: stored.greeting === null ? null : JSON.parse(stored.greeting) as HomeGreeting,
    sets,
    generatedAt: stored.generated_at,
    inputFingerprint: stored.input_fingerprint,
  };
}

/** Replaces the owner's greeting and sets. Clicked cards stay remembered. */
export function writeHomeCards(ownerUserId: string, write: HomeCardsWrite, now = Date.now()): HomeCardsDto {
  db().prepare(`INSERT INTO home_cards(owner_user_id,greeting,sets,input_fingerprint,generated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(owner_user_id) DO UPDATE SET greeting=excluded.greeting,sets=excluded.sets,
      input_fingerprint=excluded.input_fingerprint,generated_at=excluded.generated_at`)
    .run(ownerUserId, write.greeting === null ? null : JSON.stringify(write.greeting), JSON.stringify(write.sets), write.inputFingerprint, now);
  return readHomeCards(ownerUserId);
}

/** Marks one of the owner's current cards as clicked. Repeating it keeps the first time. */
export function markHomeCardUsed(ownerUserId: string, cardId: string, now = Date.now()): HomeCardUsedDto {
  return runInTransaction(() => {
    const stored = row(ownerUserId);
    const custom = readHomeCustomization(ownerUserId).preferences.sets ?? [];
    if (![...(stored ? storedSets(stored) : []), ...custom].some((set) => set.cards.some((entry) => entry.id === cardId))) {
      throw new HomeCardsError(404, 'not_found', 'Card not found');
    }
    db().prepare('INSERT INTO home_card_uses(owner_user_id,card_id,used_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(ownerUserId, cardId, now);
    const used = db().prepare('SELECT used_at FROM home_card_uses WHERE owner_user_id=? AND card_id=?').get(ownerUserId, cardId) as { used_at: number };
    return { cardId, usedAt: used.used_at };
  });
}


type HomeCustomization = {
  contentMode?: 'default' | 'page' | 'hidden';
  pageId?: string;
  greetingMode?: 'auto' | 'hidden' | 'custom';
  greeting?: HomeGreeting;
  cardsMode?: 'auto' | 'hidden' | 'custom';
  sets?: HomeCardSet[];
};

export function readHomeCustomization(ownerUserId: string): { revision: number; preferences: HomeCustomization } {
  const stored = db().prepare('SELECT revision,preferences FROM home_customization WHERE owner_user_id=?')
    .get(ownerUserId) as { revision: number; preferences: string } | undefined;
  return stored ? { revision: stored.revision, preferences: JSON.parse(stored.preferences) as HomeCustomization }
    : { revision: 0, preferences: {} };
}

/** Generated content continues updating underneath user-directed overrides. */
export function readHomeCards(ownerUserId: string): HomeCardsDto {
  const generated = readGeneratedHomeCards(ownerUserId);
  const { preferences } = readHomeCustomization(ownerUserId);
  const used = usedIds(ownerUserId);
  let contentPage: import('michi-shared').PageDto | null = null;
  if (preferences.contentMode === 'page' && preferences.pageId) {
    try { contentPage = getPage(preferences.pageId, ownerUserId); }
    catch (error) { if (!(error instanceof PageWriteError && error.status === 404)) throw error; }
  }
  return {
    ...(preferences.contentMode ? { contentMode: preferences.contentMode, contentPage } : {}),
    ...generated,
    ...(preferences.cardsMode && preferences.cardsMode !== 'auto' ? { cardsCustomized: true } : {}),
    greeting: preferences.greetingMode === 'hidden' ? null
      : preferences.greetingMode === 'custom' ? preferences.greeting! : generated.greeting,
    sets: preferences.cardsMode === 'hidden' ? []
      : preferences.cardsMode === 'custom' ? preferences.sets!.map(set => ({ cards: set.cards.filter(card => !used.has(card.id)) })).filter(set => set.cards.length > 0)
        : generated.sets,
  };
}

/** Atomic partial update, guarded against another chat changing the same Home. */
export function editHomeCustomization(ownerUserId: string, args: Obj) {
  onlyKeys(args, ['expectedRevision', 'greetingMode', 'greetingText', 'greetingDetail', 'cardsMode', 'setsJson', 'contentMode', 'pageId'], 'body');
  if (!Number.isSafeInteger(args.expectedRevision) || (args.expectedRevision as number) < 0) throw invalid('expectedRevision must be a non-negative integer');
  for (const key of ['greetingMode', 'cardsMode'] as const) {
    if (args[key] !== undefined && !['auto', 'hidden', 'custom'].includes(args[key] as string)) throw invalid(`Invalid ${key}`);
  }
  if (args.contentMode !== undefined && !['default', 'page', 'hidden'].includes(args.contentMode as string)) throw invalid('Invalid contentMode');
  if (args.pageId !== undefined && args.contentMode !== 'page') throw invalid('pageId requires contentMode page');
  if (args.greetingMode === undefined && args.cardsMode === undefined && args.contentMode === undefined) throw invalid('Provide greetingMode, cardsMode or contentMode');
  if ((args.greetingText !== undefined || args.greetingDetail !== undefined) && args.greetingMode !== 'custom') throw invalid('Greeting text requires greetingMode custom');
  if (args.setsJson !== undefined && args.cardsMode !== 'custom') throw invalid('setsJson requires cardsMode custom');
  return runInTransaction(() => {
    const current = readHomeCustomization(ownerUserId);
    if (current.revision !== args.expectedRevision) throw new HomeCardsError(409, 'conflict', 'Home changed; read_home and retry');
    const next = { ...current.preferences };
    if (args.contentMode !== undefined) {
      next.contentMode = args.contentMode as HomeCustomization['contentMode'];
      if (args.contentMode === 'page') {
        const pageId = id(args.pageId ?? next.pageId, 'pageId');
        // Validate ownership and liveness before changing any preferences.
        getPage(pageId, ownerUserId, { write: true });
        next.pageId = pageId;
      }
    }
    if (args.greetingMode !== undefined) {
      next.greetingMode = args.greetingMode as HomeCustomization['greetingMode'];
      delete next.greeting;
      if (args.greetingMode === 'custom') next.greeting = greeting({ text: args.greetingText, detail: args.greetingDetail })!;
    }
    if (args.cardsMode !== undefined) {
      next.cardsMode = args.cardsMode as HomeCustomization['cardsMode'];
      delete next.sets;
      if (args.cardsMode === 'custom') {
        if (typeof args.setsJson !== 'string' || args.setsJson.length > 300_000) throw invalid('setsJson must be a JSON string up to 300000 characters');
        next.sets = parseHomeCardsWrite({ sets: JSON.parse(args.setsJson) }).sets;
      }
    }
    db().prepare(`INSERT INTO home_customization(owner_user_id,revision,preferences) VALUES(?,?,?)
      ON CONFLICT(owner_user_id) DO UPDATE SET revision=excluded.revision,preferences=excluded.preferences`)
      .run(ownerUserId, current.revision + 1, JSON.stringify(next));
    return { ...readHomeCustomization(ownerUserId), content: readHomeCards(ownerUserId) };
  });
}
