/**
 * Page layout rules: storage and validation, and the Spaces Home's counted
 * sections applying the structured ones.
 */

import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAGE_LAYOUT_PREFERENCES_LIMIT, type PageLayoutRule } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import { createPage, getPage } from '../src/services/pages/repository';
import { ensureSpacesHomePageId, getSpacesHome, getWorkspaceHome } from '../src/services/pages/homePages';
import { homeSections } from '../src/services/pages/homeSections';
import { seedConversation, type SeedTurn } from './helpers/homeConversations';
import {
  addLayoutRule, deleteLayoutRule, effectiveSectionLimits, getLayoutPreferences, listLayoutRules, pageLayoutContext, parseLayoutRules, parseSectionLimit, saveLayoutPreferences,
} from '../src/services/pages/layoutRules';

const OWNER = LOCAL_AGENT_OWNER_ID;
const DAY = 24 * 60 * 60 * 1000;

function seedWorkspace(id: string, owner: string | null = null): void {
  saveWorkspace({ id, name: `Project ${id}`, cwd: `/tmp/${id}`, created_at: 1, updated_at: 1, settings: null });
  if (owner) getDb().prepare('UPDATE workspaces SET owner_user_id=? WHERE id=?').run(owner, id);
}

/** A conversation in ws-a whose latest turn is `turn`. */
function chat(nodeId: string, turn: SeedTurn): void {
  seedConversation({ nodeId, workspaceId: 'ws-a', turns: [turn] });
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-layout-rules-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  seedWorkspace('ws-a');
  seedWorkspace('ws-x', 'someone-else');
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('layout preferences document', () => {
  test('ordinary pages and both Home kinds store separate revisioned documents without changing content revisions', () => {
    const pages = [createPage({ workspaceId: 'ws-a', ownerUserId: OWNER, title: 'Plan' }), getSpacesHome(OWNER).page, getWorkspaceHome('ws-a', OWNER).page];
    for (const [index, page] of pages.entries()) {
      assert.deepEqual(getLayoutPreferences(page.id, OWNER), { text: '', revision: 0, updatedAt: null, updatedBy: null });
      const rule = addLayoutRule({ pageId: page.id, ownerUserId: OWNER, text: 'Keep the summary short', createdBy: 'agent' });
      const before = getPage(page.id, OWNER);
      const saved = saveLayoutPreferences({ pageId: page.id, ownerUserId: OWNER, text: ` Put risks first ${index}\nUse two columns `, expectedRevision: 0, actor: 'user', now: 100 });
      assert.deepEqual(saved, { text: `Put risks first ${index}\nUse two columns`, revision: 1, updatedAt: 100, updatedBy: 'user' });
      assert.deepEqual(getLayoutPreferences(page.id, OWNER), saved);
      assert.equal(getPage(page.id, OWNER).revision, before.revision);
      assert.equal(getPage(page.id, OWNER).viewVersion, before.viewVersion + 1);
      assert.deepEqual(listLayoutRules(page.id, OWNER), [rule]);
      assert.deepEqual(pageLayoutContext(page.id, OWNER).layoutPreferences, saved);
    }
  });

  test('exact revision checks retain prior snapshots, reject stale writes including ABA, and preserve deterministic filters', () => {
    const pageId = ensureSpacesHomePageId(OWNER);
    const rule = addLayoutRule({ pageId, ownerUserId: OWNER, text: 'Done: 2', sectionLimit: { section: 'done', maxItems: 2 }, createdBy: 'agent', now: 7 });
    const write = (text: string, expectedRevision: number) => saveLayoutPreferences({ pageId, ownerUserId: OWNER, text, expectedRevision, actor: 'user', now: 100 + expectedRevision });
    write('Original', 0);
    assert.throws(() => write('Stale draft', 0), (error: any) => error.code === 'stale_revision' && error.status === 409);
    write('Changed', 1);
    write('Original', 2);
    assert.throws(() => write('Stale original', 1), /changed elsewhere/);
    assert.equal(write('Original', 3).revision, 3, 'identical text at the current revision does not create a snapshot');
    const empty = write('', 3);
    assert.equal(empty.revision, 4);
    assert.equal(empty.text, '');
    const history = getDb().prepare('SELECT text,revision,updated_by FROM page_layout_preferences WHERE page_id=? ORDER BY revision').all(pageId);
    assert.deepEqual(history.map(row => ({ ...row })), [
      { text: 'Original', revision: 1, updated_by: 'user' }, { text: 'Changed', revision: 2, updated_by: 'user' },
      { text: 'Original', revision: 3, updated_by: 'user' }, { text: '', revision: 4, updated_by: 'user' },
    ]);
    assert.deepEqual(listLayoutRules(pageId, OWNER), [rule]);
    assert.deepEqual(effectiveSectionLimits(listLayoutRules(pageId, OWNER)).done, { maxAgeDays: null, maxItems: 2, ruleIds: [rule.id] });
  });

  test('validates document bounds and refuses missing or forged revisions', () => {
    const page = createPage({ workspaceId: 'ws-a', ownerUserId: OWNER, title: 'Plan' });
    const base = { pageId: page.id, ownerUserId: OWNER, text: 'Good', expectedRevision: 0, actor: 'user' as const };
    for (const text of [null, {}, 'x'.repeat(PAGE_LAYOUT_PREFERENCES_LIMIT + 1)]) {
      assert.throws(() => saveLayoutPreferences({ ...base, text }), /at most/);
    }
    for (const expectedRevision of [undefined, null, -1, 0.5, '0']) {
      assert.throws(() => saveLayoutPreferences({ ...base, expectedRevision }), /expectedRevision/);
    }
    assert.equal(getLayoutPreferences(page.id, OWNER).revision, 0);
  });

  test('enforces owner isolation, archived read-only behavior, and deleted-page isolation', () => {
    const page = createPage({ workspaceId: 'ws-a', ownerUserId: OWNER, title: 'Plan' });
    const write = (ownerUserId: string) => saveLayoutPreferences({ pageId: page.id, ownerUserId, text: 'Private', expectedRevision: 0, actor: 'user' });
    assert.throws(() => getLayoutPreferences(page.id, 'someone-else'), /Page not found/);
    assert.throws(() => write('someone-else'), /Page not found/);
    write(OWNER);
    getDb().prepare('UPDATE workspaces SET archived_at=10 WHERE id=?').run('ws-a');
    assert.equal(getLayoutPreferences(page.id, OWNER).text, 'Private');
    assert.throws(() => write(OWNER), /read-only/);
    getDb().prepare('UPDATE workspaces SET archived_at=NULL WHERE id=?').run('ws-a');
    getDb().prepare('UPDATE pages SET deleted_at=20 WHERE id=?').run(page.id);
    assert.throws(() => getLayoutPreferences(page.id, OWNER), /Page not found/);
    assert.throws(() => write(OWNER), /Page not found/);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM page_layout_preferences WHERE page_id=?').get(page.id)?.count, 1, 'soft deletion retains document history');
  });
});

describe('layout rule storage', () => {
  test('a section limit names one counted section and sets an age, a count or both, within bounds', () => {
    assert.deepEqual(parseSectionLimit({ section: 'stalled', maxAgeDays: 3 }), { section: 'stalled', maxAgeDays: 3 });
    assert.deepEqual(parseSectionLimit({ section: 'done', maxItems: 5, maxAgeDays: 7 }), { section: 'done', maxAgeDays: 7, maxItems: 5 });
    assert.equal(parseSectionLimit(undefined), null);
    assert.equal(parseSectionLimit(null), null);
    for (const bad of [{ section: 'stalled' }, { section: 'other', maxAgeDays: 3 }, { section: 'stalled', maxAgeDays: 0 },
      { section: 'stalled', maxAgeDays: 366 }, { section: 'stalled', maxItems: 9 }, { section: 'stalled', maxAgeDays: 1.5 },
      { section: 'stalled', maxAgeDays: 3, extra: 1 }, 'stalled']) {
      assert.equal(parseSectionLimit(bad), undefined, JSON.stringify(bad));
    }
  });

  test('rules keep their section limit; a stored entry with a broken limit is left out', () => {
    const home = ensureSpacesHomePageId(OWNER);
    const rule = addLayoutRule({ pageId: home, ownerUserId: OWNER, text: ' Stalled: only the last 3 days ', createdBy: 'user',
      sectionLimit: { section: 'stalled', maxAgeDays: 3 }, now: 100 });
    assert.equal(rule.text, 'Stalled: only the last 3 days');
    assert.deepEqual(listLayoutRules(home, OWNER), [rule]);
    assert.deepEqual(getSpacesHome(OWNER).layoutRules, [rule]);
    const text = addLayoutRule({ pageId: home, ownerUserId: OWNER, text: 'Lead with the release', createdBy: 'user', now: 101 });
    assert.equal('sectionLimit' in text, false);
    assert.deepEqual(parseLayoutRules(JSON.stringify([{ ...rule, id: 'r-bad', sectionLimit: { section: 'x' } }, text])), [text]);
  });

  test('a section limit is refused off the Spaces Home, and a bad one everywhere', () => {
    const page = createPage({ workspaceId: 'ws-a', ownerUserId: OWNER, title: 'Plan' });
    assert.throws(() => addLayoutRule({ pageId: page.id, ownerUserId: OWNER, text: 'Stalled 3 days', createdBy: 'user',
      sectionLimit: { section: 'stalled', maxAgeDays: 3 } }), /Only the Spaces Home has counted sections/);
    const home = ensureSpacesHomePageId(OWNER);
    assert.throws(() => addLayoutRule({ pageId: home, ownerUserId: OWNER, text: 'x', createdBy: 'user',
      sectionLimit: { section: 'stalled', maxItems: 20 } }), /section limit/);
    assert.deepEqual(listLayoutRules(home, OWNER), []);
  });

  test('another owner can neither read nor change a page\'s rules', () => {
    const page = createPage({ workspaceId: 'ws-x', ownerUserId: 'someone-else', title: 'Theirs' });
    const rule = addLayoutRule({ pageId: page.id, ownerUserId: 'someone-else', text: 'Keep it short', createdBy: 'user' });
    assert.throws(() => listLayoutRules(page.id, OWNER), /Page not found/);
    assert.throws(() => addLayoutRule({ pageId: page.id, ownerUserId: OWNER, text: 'Mine', createdBy: 'user' }), /Page not found/);
    assert.throws(() => deleteLayoutRule(page.id, OWNER, rule.id), /Page not found/);
    assert.deepEqual(listLayoutRules(page.id, 'someone-else'), [rule]);
  });

  test('per section, the newest rule that sets a limit decides it', () => {
    const rule = (id: string, limit: PageLayoutRule['sectionLimit']): PageLayoutRule =>
      ({ id, text: id, sourceMessage: null, createdBy: 'user', createdAt: 1, ...(limit ? { sectionLimit: limit } : {}) });
    const limits = effectiveSectionLimits([
      rule('old-age', { section: 'stalled', maxAgeDays: 3 }),
      rule('count', { section: 'stalled', maxItems: 4 }),
      rule('text', undefined),
      rule('new-age', { section: 'stalled', maxAgeDays: 7 }),
      rule('done', { section: 'done', maxItems: 2 }),
    ]);
    assert.deepEqual(limits.stalled, { maxAgeDays: 7, maxItems: 4, ruleIds: ['count', 'new-age'] });
    assert.deepEqual(limits.done, { maxAgeDays: null, maxItems: 2, ruleIds: ['done'] });
    assert.equal(limits.waiting, undefined);
  });
});

describe('counted sections follow the Spaces Home rules', () => {
  const now = 100 * DAY;
  // Failed last turns, quiet for 4 to 13 days: all four are Stalled.
  const seedStalled = () => {
    chat('s1', { status: 'error', error: 'x', startedAt: now - 4 * DAY - 10, completedAt: now - 4 * DAY });
    chat('s2', { status: 'error', error: 'x', startedAt: now - 6.9 * DAY - 10, completedAt: now - 6.9 * DAY });
    chat('s3', { status: 'error', error: 'x', startedAt: now - 7 * DAY - 10, completedAt: now - 8 * DAY });
    chat('s4', { status: 'error', error: 'x', startedAt: now - 13 * DAY - 10, completedAt: now - 13 * DAY });
  };
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id.replace('conversation:', ''));

  test('an age limit lists only recent items, in whole days; the total and View all still count every one', () => {
    seedStalled();
    const before = homeSections({ ownerUserId: OWNER, now });
    assert.equal(before.stalled.items.length, 4);
    assert.equal(before.stalled.ruleIds, undefined);
    const home = ensureSpacesHomePageId(OWNER);
    const rule = addLayoutRule({ pageId: home, ownerUserId: OWNER, text: 'Stalled: only the last 6 days', createdBy: 'agent',
      sectionLimit: { section: 'stalled', maxAgeDays: 6 } });
    const after = homeSections({ ownerUserId: OWNER, now });
    assert.deepEqual(ids(after.stalled.items), ['s1', 's2']);
    assert.equal(after.stalled.total, 4);
    assert.deepEqual(after.stalled.ruleIds, [rule.id]);
    assert.equal(after.done.ruleIds, undefined, 'other sections are untouched');

    deleteLayoutRule(home, OWNER, rule.id);
    const removed = homeSections({ ownerUserId: OWNER, now });
    assert.equal(removed.stalled.items.length, 4);
  });

  test('a count limit lists at most that many; an age limit applies to waiting conversations', () => {
    const home = ensureSpacesHomePageId(OWNER);
    addLayoutRule({ pageId: home, ownerUserId: OWNER, text: 'Done: at most 2', createdBy: 'user', sectionLimit: { section: 'done', maxItems: 2 } });
    addLayoutRule({ pageId: home, ownerUserId: OWNER, text: 'Waiting: the last day', createdBy: 'user', sectionLimit: { section: 'waiting', maxAgeDays: 1 } });
    for (const [i, at] of [now - 1_000, now - 2_000, now - 3_000, now - 4_000].entries()) chat(`d${i}`, { status: 'completed', reply: 'Done.', startedAt: at - 10, completedAt: at });
    chat('w-today', { status: 'completed', reply: 'Ship it?', startedAt: now - 2 * 60 * 60 * 1000 });
    chat('w-older', { status: 'completed', reply: 'Ship it?', startedAt: now - 2.5 * DAY });
    const read = homeSections({ ownerUserId: OWNER, now, since: now - DAY });
    assert.deepEqual(ids(read.done.items), ['d0', 'd1']);
    assert.equal(read.done.total, 4);
    assert.deepEqual(ids(read.waiting.items), ['w-today']);
    assert.equal(read.waiting.total, 2);
  });

  test('another owner\'s Spaces Home rules never shape these sections', () => {
    seedStalled();
    seedWorkspace('ws-y', 'someone-else');
    const theirs = ensureSpacesHomePageId('someone-else');
    addLayoutRule({ pageId: theirs, ownerUserId: 'someone-else', text: 'Stalled: 1 item', createdBy: 'user', sectionLimit: { section: 'stalled', maxItems: 1 } });
    const read = homeSections({ ownerUserId: OWNER, now });
    assert.equal(read.stalled.items.length, 4);
  });
});
