import { randomUUID } from 'node:crypto';
import {
  LAYOUT_RULE_SECTION_LIMITS, PAGE_LAYOUT_RULE_LIMITS, PAGE_LAYOUT_PREFERENCES_LIMIT,
  type HomeSectionKey, type LayoutRuleSectionLimit, type LayoutRuleSourceMessage, type PageLayoutRule, type PageLayoutPreferences,
} from 'michi-shared';
import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { PageWriteError, invalidatePages, pagesTransaction } from './core';
import { pageRecord } from './repository';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const shortId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const SECTIONS: readonly HomeSectionKey[] = ['waiting', 'stalled', 'done'];
const inRange = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;

function storedSource(value: unknown): LayoutRuleSourceMessage | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || !shortId(value.nodeId) || !shortId(value.turnId) || !shortId(value.messageId)) return undefined;
  return { nodeId: value.nodeId, turnId: value.turnId, messageId: value.messageId };
}

/** A section limit as stored or requested; null for none, undefined when it is not valid. */
export function parseSectionLimit(value: unknown): LayoutRuleSectionLimit | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !Object.keys(value).every((key) => ['section', 'maxAgeDays', 'maxItems'].includes(key))) return undefined;
  if (!SECTIONS.includes(value.section as HomeSectionKey)) return undefined;
  const age = value.maxAgeDays;
  const items = value.maxItems;
  if (age !== undefined && !inRange(age, LAYOUT_RULE_SECTION_LIMITS.maxAgeDays)) return undefined;
  if (items !== undefined && !inRange(items, LAYOUT_RULE_SECTION_LIMITS.maxItems)) return undefined;
  if (age === undefined && items === undefined) return undefined;
  return { section: value.section as HomeSectionKey, ...(age !== undefined ? { maxAgeDays: age } : {}), ...(items !== undefined ? { maxItems: items } : {}) };
}

/** Rules as stored; an entry that does not parse is left out rather than failing the page. */
export function parseLayoutRules(raw: string | null | undefined): PageLayoutRule[] {
  let value: unknown;
  try { value = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const rules: PageLayoutRule[] = [];
  for (const entry of value) {
    if (!isObject(entry) || !shortId(entry.id) || typeof entry.text !== 'string' || !entry.text ||
      (entry.createdBy !== 'user' && entry.createdBy !== 'agent') || !Number.isSafeInteger(entry.createdAt)) continue;
    const sourceMessage = storedSource(entry.sourceMessage);
    const sectionLimit = parseSectionLimit(entry.sectionLimit);
    if (sourceMessage === undefined || sectionLimit === undefined) continue;
    rules.push({ id: entry.id, text: entry.text, sourceMessage, createdBy: entry.createdBy, createdAt: entry.createdAt as number,
      ...(sectionLimit ? { sectionLimit } : {}) });
  }
  return rules;
}

export function listLayoutRules(pageId: string, ownerUserId: string): PageLayoutRule[] {
  return parseLayoutRules(pageRecord(pageId, ownerUserId).layout_rules);
}

function readLayoutPreferences(pageId: string): PageLayoutPreferences {
  const row = getDb().prepare(`SELECT text,revision,updated_at AS updatedAt,updated_by AS updatedBy
    FROM page_layout_preferences WHERE page_id=? ORDER BY revision DESC LIMIT 1`).get(pageId) as unknown as PageLayoutPreferences | undefined;
  return row ? { text: row.text, revision: row.revision, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
    : { text: '', revision: 0, updatedAt: null, updatedBy: null };
}

/** Preferences belong only to this page; a Home document does not apply to other pages. */
export function getLayoutPreferences(pageId: string, ownerUserId: string): PageLayoutPreferences {
  pageRecord(pageId, ownerUserId);
  return readLayoutPreferences(pageId);
}

export function saveLayoutPreferences(input: {
  pageId: string; ownerUserId: string; text: unknown; expectedRevision: unknown; actor: 'user' | 'agent'; now?: number;
}): PageLayoutPreferences {
  if (typeof input.text !== 'string' || input.text.length > PAGE_LAYOUT_PREFERENCES_LIMIT) {
    throw new PageWriteError(400, 'invalid', `Layout preferences must contain at most ${PAGE_LAYOUT_PREFERENCES_LIMIT} characters`);
  }
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) {
    throw new PageWriteError(400, 'invalid', 'expectedRevision must be a non-negative integer');
  }
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || !['user', 'agent'].includes(input.actor)) {
    throw new PageWriteError(400, 'invalid', 'Invalid layout preferences attribution');
  }
  const text = input.text.trim();
  return pagesTransaction(() => {
    const page = pageRecord(input.pageId, input.ownerUserId, { write: true });
    const current = readLayoutPreferences(page.id);
    if (current.revision !== input.expectedRevision) {
      throw new PageWriteError(409, 'stale_revision', 'Layout preferences changed elsewhere. Review the latest version before saving your draft.');
    }
    if (current.text === text) return current;
    const next: PageLayoutPreferences = { text, revision: current.revision + 1, updatedAt: now, updatedBy: input.actor };
    getDb().prepare('INSERT INTO page_layout_preferences(page_id,revision,text,updated_at,updated_by) VALUES (?,?,?,?,?)')
      .run(page.id, next.revision, text, now, input.actor);
    invalidatePages([page.id], now, input.actor);
    return next;
  });
}

/** Native agent reads keep document preferences and deterministic rules distinct. */
export function pageLayoutContext(pageId: string, ownerUserId: string): {
  layoutPreferences: PageLayoutPreferences; layoutRules: ReturnType<typeof layoutRulesForAgent>;
} {
  return { layoutPreferences: getLayoutPreferences(pageId, ownerUserId), layoutRules: layoutRulesForAgent(listLayoutRules(pageId, ownerUserId)) };
}

/** The message must be a turn's user or assistant message in a workspace the owner can read. */
function requireSourceMessage(ownerUserId: string, source: LayoutRuleSourceMessage): void {
  const row = getDb().prepare(`SELECT w.owner_user_id FROM turns t JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id
    WHERE t.turn_id=? AND n.id=? AND (t.user_message_id=? OR t.assistant_message_id=?)
      AND n.purged_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL`)
    .get(source.turnId, source.nodeId, source.messageId, source.messageId) as { owner_user_id: string | null } | undefined;
  if (!row || !workspaceOwnerMatches(row.owner_user_id, ownerUserId)) throw new PageWriteError(404, 'not_found', 'Source message not found');
}

export interface AddLayoutRuleInput {
  pageId: string;
  ownerUserId: string;
  text: unknown;
  sourceMessage?: unknown;
  sectionLimit?: unknown;
  createdBy: 'user' | 'agent';
  now?: number;
}

export function addLayoutRule(input: AddLayoutRuleInput): PageLayoutRule {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text || text.length > PAGE_LAYOUT_RULE_LIMITS.text) {
    throw new PageWriteError(400, 'invalid', `Layout rule text must contain 1 to ${PAGE_LAYOUT_RULE_LIMITS.text} characters`);
  }
  const sourceMessage = input.sourceMessage === undefined ? null : storedSource(input.sourceMessage);
  if (sourceMessage === undefined) throw new PageWriteError(400, 'invalid', 'Invalid layout rule source message');
  const sectionLimit = parseSectionLimit(input.sectionLimit);
  if (sectionLimit === undefined) {
    throw new PageWriteError(400, 'invalid', `A section limit names waiting, stalled or done and sets maxAgeDays (1-${LAYOUT_RULE_SECTION_LIMITS.maxAgeDays}), maxItems (1-${LAYOUT_RULE_SECTION_LIMITS.maxItems}) or both`);
  }
  if (input.createdBy !== 'user' && input.createdBy !== 'agent') throw new PageWriteError(400, 'invalid', 'Invalid layout rule author');
  const now = input.now ?? Date.now();
  return pagesTransaction(() => {
    const page = pageRecord(input.pageId, input.ownerUserId, { write: true });
    if (sectionLimit && page.role !== 'spaces-home') {
      throw new PageWriteError(400, 'invalid', 'Only the Spaces Home has counted sections; keep this rule as text');
    }
    if (sourceMessage) requireSourceMessage(input.ownerUserId, sourceMessage);
    const rules = parseLayoutRules(page.layout_rules);
    if (rules.length >= PAGE_LAYOUT_RULE_LIMITS.perPage) throw new PageWriteError(409, 'invalid', `A page keeps at most ${PAGE_LAYOUT_RULE_LIMITS.perPage} layout rules`);
    const rule: PageLayoutRule = { id: `rule-${randomUUID()}`, text, sourceMessage, createdBy: input.createdBy, createdAt: now,
      ...(sectionLimit ? { sectionLimit } : {}) };
    getDb().prepare('UPDATE pages SET layout_rules=? WHERE id=?').run(JSON.stringify([...rules, rule]), page.id);
    invalidatePages([page.id], now, input.createdBy);
    return rule;
  });
}

export function deleteLayoutRule(pageId: string, ownerUserId: string, ruleId: string, now = Date.now(), actor: 'user' | 'agent' = 'user'): PageLayoutRule[] {
  return pagesTransaction(() => {
    const page = pageRecord(pageId, ownerUserId, { write: true });
    const rules = parseLayoutRules(page.layout_rules);
    const kept = rules.filter((rule) => rule.id !== ruleId);
    if (kept.length === rules.length) throw new PageWriteError(404, 'not_found', 'Layout rule not found');
    getDb().prepare('UPDATE pages SET layout_rules=? WHERE id=?').run(JSON.stringify(kept), page.id);
    invalidatePages([page.id], now, actor);
    return kept;
  });
}

/** What the program applies to one counted section, and the rules it came from. */
export interface EffectiveSectionLimit {
  maxAgeDays: number | null;
  maxItems: number | null;
  ruleIds: string[];
}

/**
 * Per section, the newest rule that sets a limit decides it, so "only the
 * last 7 days" after "only the last 3 days" means 7 days. A section no rule
 * limits is absent.
 */
export function effectiveSectionLimits(rules: readonly PageLayoutRule[]): Partial<Record<HomeSectionKey, EffectiveSectionLimit>> {
  const age = new Map<HomeSectionKey, PageLayoutRule>();
  const items = new Map<HomeSectionKey, PageLayoutRule>();
  // Rules are stored in the order they were added: the last match is the newest.
  for (const rule of rules) {
    const limit = rule.sectionLimit;
    if (limit?.maxAgeDays !== undefined) age.set(limit.section, rule);
    if (limit?.maxItems !== undefined) items.set(limit.section, rule);
  }
  const out: Partial<Record<HomeSectionKey, EffectiveSectionLimit>> = {};
  for (const section of SECTIONS) {
    const byAge = age.get(section);
    const byItems = items.get(section);
    if (!byAge && !byItems) continue;
    out[section] = {
      maxAgeDays: byAge?.sectionLimit?.maxAgeDays ?? null,
      maxItems: byItems?.sectionLimit?.maxItems ?? null,
      ruleIds: rules.filter((rule) => rule === byAge || rule === byItems).map((rule) => rule.id),
    };
  }
  return out;
}

/** The section limits of the owner's Spaces Home, read without creating the page. */
export function spacesHomeSectionLimits(ownerUserId: string): Partial<Record<HomeSectionKey, EffectiveSectionLimit>> {
  const row = getDb().prepare("SELECT layout_rules FROM pages WHERE owner_user_id=? AND role='spaces-home' AND deleted_at IS NULL")
    .get(ownerUserId) as { layout_rules: string } | undefined;
  return row ? effectiveSectionLimits(parseLayoutRules(row.layout_rules)) : {};
}

/** A rule as an agent reads it: its text, and the program-applied limit when it has one. */
export function layoutRulesForAgent(rules: readonly PageLayoutRule[]): Array<{ id: string; text: string; sectionLimit?: LayoutRuleSectionLimit }> {
  return rules.map((rule) => ({ id: rule.id, text: rule.text, ...(rule.sectionLimit ? { sectionLimit: rule.sectionLimit } : {}) }));
}
