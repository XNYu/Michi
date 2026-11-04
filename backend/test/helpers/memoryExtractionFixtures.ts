import fs from 'node:fs';
import path from 'node:path';
import { isMemoryKind, type MemoryKind } from 'michi-shared';

/**
 * Typed loader and validator for the memory extraction fixtures in
 * test/fixtures/memoryExtraction/. Each file is an array of cases:
 *   { id, description, turns: [{ role, text, untrusted? }],
 *     expected: { candidates: [{ kind, scopeHint, bodyIncludes }], correction?: { pattern } } }
 * `untrusted` marks a turn whose content came from a web page, tool or file;
 * only tool and assistant turns may carry it. `correction.pattern` is the
 * detectCorrection pattern id expected for the case's last user turn.
 */

export type ExtractionFixtureRole = 'user' | 'assistant' | 'tool';
export type ExtractionScopeHint = 'workspace' | 'maybe_global';

export interface ExtractionFixtureTurn {
  role: ExtractionFixtureRole;
  text: string;
  untrusted?: boolean;
}

export interface ExtractionFixtureCandidate {
  kind: MemoryKind;
  scopeHint: ExtractionScopeHint;
  bodyIncludes: string[];
}

export interface ExtractionFixtureCase {
  id: string;
  description: string;
  turns: ExtractionFixtureTurn[];
  expected: {
    candidates: ExtractionFixtureCandidate[];
    correction?: { pattern: string };
  };
}

export type ExtractionFixtureSet = 'positive' | 'negative' | 'correction';

const ROLES: readonly string[] = ['user', 'assistant', 'tool'];
const SCOPE_HINTS: readonly string[] = ['workspace', 'maybe_global'];
const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATTERN_ID = /^(?:zh|en)_[a-z_]+$/;

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'memoryExtraction');

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function record(value: unknown, where: string, keys: { required: string[]; optional?: string[] }): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where, 'must be an object');
  const allowed = new Set([...keys.required, ...(keys.optional ?? [])]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(where, `unexpected key "${key}"`);
  for (const key of keys.required) if (!(key in value)) fail(where, `missing "${key}"`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(where, 'must be a non-empty string');
  return value;
}

function array(value: unknown, where: string, { nonEmpty }: { nonEmpty: boolean }): unknown[] {
  if (!Array.isArray(value)) fail(where, 'must be an array');
  if (nonEmpty && value.length === 0) fail(where, 'must not be empty');
  return value;
}

function turn(value: unknown, where: string): ExtractionFixtureTurn {
  const raw = record(value, where, { required: ['role', 'text'], optional: ['untrusted'] });
  if (typeof raw.role !== 'string' || !ROLES.includes(raw.role)) fail(`${where}.role`, `must be one of ${ROLES.join(', ')}`);
  const role = raw.role as ExtractionFixtureRole;
  const result: ExtractionFixtureTurn = { role, text: text(raw.text, `${where}.text`) };
  if ('untrusted' in raw) {
    if (typeof raw.untrusted !== 'boolean') fail(`${where}.untrusted`, 'must be a boolean');
    if (role === 'user') fail(`${where}.untrusted`, 'user turns are the user\'s own words and cannot be untrusted');
    result.untrusted = raw.untrusted;
  }
  return result;
}

function candidate(value: unknown, where: string): ExtractionFixtureCandidate {
  const raw = record(value, where, { required: ['kind', 'scopeHint', 'bodyIncludes'] });
  if (!isMemoryKind(raw.kind)) fail(`${where}.kind`, 'must be a MemoryKind');
  if (typeof raw.scopeHint !== 'string' || !SCOPE_HINTS.includes(raw.scopeHint)) fail(`${where}.scopeHint`, `must be one of ${SCOPE_HINTS.join(', ')}`);
  const bodyIncludes = array(raw.bodyIncludes, `${where}.bodyIncludes`, { nonEmpty: true })
    .map((item, index) => text(item, `${where}.bodyIncludes[${index}]`));
  return { kind: raw.kind, scopeHint: raw.scopeHint as ExtractionScopeHint, bodyIncludes };
}

function fixtureCase(value: unknown, where: string): ExtractionFixtureCase {
  const raw = record(value, where, { required: ['id', 'description', 'turns', 'expected'] });
  const id = text(raw.id, `${where}.id`);
  if (!CASE_ID.test(id)) fail(`${where}.id`, 'must be lower-case kebab-case');
  const turns = array(raw.turns, `${where}.turns`, { nonEmpty: true }).map((item, index) => turn(item, `${where}.turns[${index}]`));
  if (!turns.some((item) => item.role === 'user')) fail(`${where}.turns`, 'needs at least one user turn');
  const expected = record(raw.expected, `${where}.expected`, { required: ['candidates'], optional: ['correction'] });
  const candidates = array(expected.candidates, `${where}.expected.candidates`, { nonEmpty: false })
    .map((item, index) => candidate(item, `${where}.expected.candidates[${index}]`));
  const result: ExtractionFixtureCase = { id, description: text(raw.description, `${where}.description`), turns, expected: { candidates } };
  if ('correction' in expected) {
    const correction = record(expected.correction, `${where}.expected.correction`, { required: ['pattern'] });
    const pattern = text(correction.pattern, `${where}.expected.correction.pattern`);
    if (!PATTERN_ID.test(pattern)) fail(`${where}.expected.correction.pattern`, 'must look like zh_… or en_…');
    result.expected.correction = { pattern };
  }
  return result;
}

/** Validates one parsed fixture file; throws with the path of the first problem. */
export function validateExtractionFixtures(value: unknown, source: string): ExtractionFixtureCase[] {
  const cases = array(value, source, { nonEmpty: true }).map((item, index) => fixtureCase(item, `${source}[${index}]`));
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) fail(source, `duplicate id "${item.id}"`);
    seen.add(item.id);
  }
  return cases;
}

export function loadExtractionFixtures(set: ExtractionFixtureSet): ExtractionFixtureCase[] {
  const file = path.join(FIXTURE_DIR, `${set}.json`);
  return validateExtractionFixtures(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, `${set}.json`);
}

/** The text detectCorrection is expected to flag in a correction case. */
export function lastUserText(item: ExtractionFixtureCase): string {
  const users = item.turns.filter((entry) => entry.role === 'user');
  return users[users.length - 1].text;
}
