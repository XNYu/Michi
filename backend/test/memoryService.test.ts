import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { deleteWorkspace } from '../src/services/dbRepository';
import {
  MemoryError,
  approveMemory,
  createMemory,
  deleteMemory,
  getMemorySettings,
  listMemories,
  memoryEvents,
  memoryVersion,
  onMemoryRemoved,
  pinnedPreferences,
  rejectMemory,
  searchMemories,
  setMemorySettings,
  supersedeMemory,
  updateMemory,
  type CreateMemoryInput,
} from '../src/services/memory/memoryService';
import { purgeOwnerMemories } from '../src/services/memory/memoryRepository';

const alice = { ownerUserId: 'alice' };
const bob = { ownerUserId: 'bob' };

let dataDir: string;

function seedWorkspace(id: string, name: string, ownerUserId: string | null): void {
  getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
    .run(id, name, ownerUserId);
}

function save(caller: { ownerUserId: string }, body: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return createMemory(caller, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'explicit', ...extra });
}

function inWorkspace(workspaceId: string) {
  return { scope: { kind: 'workspace' as const, workspaceId } };
}

function bodies(records: MemoryRecord[]): string[] {
  return records.map((record) => record.body);
}

function memoryError(code: MemoryError['code']) {
  return (error: unknown) => error instanceof MemoryError && error.code === code;
}

function ftsMatches(text: string): number {
  return (getDb().prepare('SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?').get(`"${text}"`) as { n: number }).n;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-'));
  process.env.MICHI_DATA_DIR = dataDir;
  process.env.MICHI_CLOUD = '1';
  closeDb();
  initDb();
  seedWorkspace('ws-alice-1', 'Project', 'alice');
  seedWorkspace('ws-alice-2', 'Project', 'alice');
  seedWorkspace('ws-bob', 'Project', 'bob');
});

afterEach(() => {
  closeDb();
  delete process.env.MICHI_CLOUD;
  delete process.env.MICHI_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('migration 0059_memories', () => {
  test('applies on a fresh database with a trigram index kept in sync', () => {
    const db = getDb();
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version = '0059_memories'").get());
    for (const name of ['memories', 'memories_fts', 'memory_scope_versions', 'memory_settings']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name), name);
    }
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as { sql: string };
    assert.match(fts.sql, /tokenize='trigram'/);

    const kept = save(alice, 'keeps the index consistent');
    const edited = save(alice, 'original wording');
    const gone = save(alice, 'removed later');
    updateMemory(alice, edited.id, { body: 'edited wording' });
    deleteMemory(alice, gone.id);
    assert.equal(ftsMatches('consistent'), 1);
    assert.equal(ftsMatches('original'), 0);
    assert.equal(ftsMatches('edited'), 1);
    assert.equal(ftsMatches('removed'), 0);
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')");
    assert.ok(kept.id.startsWith('mem-'));
  });

  test('constraints reject a workspace scope without a workspace and unknown kinds', () => {
    const insert = (scope: string, workspaceId: string | null, kind: string) => getDb().prepare(`INSERT INTO memories
      (id, owner_user_id, scope, workspace_id, kind, body, status, origin, created_at, updated_at)
      VALUES (?, 'alice', ?, ?, ?, 'x', 'active', 'explicit', 1, 1)`).run(`raw-${scope}-${kind}`, scope, workspaceId, kind);
    assert.throws(() => insert('workspace', null, 'fact'), /CHECK constraint/);
    assert.throws(() => insert('user', 'ws-alice-1', 'fact'), /CHECK constraint/);
    assert.throws(() => insert('user', null, 'rumor'), /CHECK constraint/);
  });
});

describe('ownership', () => {
  test('another owner can neither see nor change a memory', () => {
    const own = save(alice, 'alice prefers dark mode', { kind: 'preference' });
    const pending = save(alice, 'alice pending note', { status: 'pending' });

    assert.throws(() => updateMemory(bob, own.id, { body: 'hijacked' }), memoryError('not_found'));
    assert.throws(() => deleteMemory(bob, own.id), memoryError('not_found'));
    assert.throws(() => approveMemory(bob, pending.id), memoryError('not_found'));
    assert.throws(() => rejectMemory(bob, pending.id), memoryError('not_found'));
    assert.throws(() => supersedeMemory(bob, own.id, { body: 'x', status: 'active', origin: 'explicit' }), memoryError('not_found'));
    assert.throws(() => save(bob, 'correction', { supersedesId: own.id }), memoryError('not_found'));
    assert.deepEqual(listMemories(bob).items, []);
    assert.deepEqual(searchMemories(bob, { query: 'dark mode' }), []);

    assert.equal(listMemories(alice).items.length, 2);
    assert.equal(updateMemory(alice, own.id, {}).body, 'alice prefers dark mode');
  });

  test('a workspace scope must be a workspace the caller owns', () => {
    assert.throws(() => save(bob, 'into alice workspace', inWorkspace('ws-alice-1')), memoryError('not_found'));
    assert.throws(() => save(bob, 'into a missing workspace', inWorkspace('ws-missing')), memoryError('not_found'));
    assert.throws(() => listMemories(bob, { workspaceId: 'ws-alice-1' }), memoryError('not_found'));
    assert.throws(() => searchMemories(bob, { query: 'anything', workspaceId: 'ws-alice-1' }), memoryError('not_found'));

    const own = save(bob, 'bob note', inWorkspace('ws-bob'));
    assert.throws(() => updateMemory(bob, own.id, { scope: { kind: 'workspace', workspaceId: 'ws-alice-1' } }), memoryError('not_found'));
    assert.deepEqual(updateMemory(bob, own.id, { scope: { kind: 'user' } }).scope, { kind: 'user' });
  });

  test('a permanently deleted workspace takes its memories with it and accepts no new ones', () => {
    const kept = save(alice, 'user scoped survives');
    save(alice, 'workspace scoped goes', inWorkspace('ws-alice-1'));
    deleteWorkspace('ws-alice-1', 'alice');
    assert.deepEqual(bodies(listMemories(alice).items), [kept.body]);
    assert.equal(ftsMatches('scoped goes'), 0);
    assert.throws(() => save(alice, 'too late', inWorkspace('ws-alice-1')), memoryError('not_found'));
  });

  test('deleting an account purges its memories, counters and settings only', () => {
    save(alice, 'alice user note');
    save(alice, 'alice workspace note', inWorkspace('ws-alice-1'));
    setMemorySettings('alice', { mode: 'off' });
    const bobs = save(bob, 'bob note');
    purgeOwnerMemories('alice');
    assert.deepEqual(listMemories(alice, { status: ['active', 'pending', 'superseded'] }).items, []);
    assert.deepEqual(getMemorySettings('alice'), { mode: 'explicit' });
    assert.equal(memoryVersion(alice, 'ws-alice-1'), 0);
    assert.equal(ftsMatches('alice'), 0);
    assert.deepEqual(listMemories(bob).items.map((record) => record.id), [bobs.id]);
  });

  test('on the desktop the local user owns legacy workspaces without an owner', () => {
    delete process.env.MICHI_CLOUD;
    seedWorkspace('ws-legacy', 'Legacy', null);
    const local = { ownerUserId: 'local-user' };
    const record = save(local, 'legacy workspace note', inWorkspace('ws-legacy'));
    assert.deepEqual(record.scope, { kind: 'workspace', workspaceId: 'ws-legacy' });
    assert.throws(() => save(alice, 'not alice workspace', inWorkspace('ws-legacy')), memoryError('not_found'));
  });

  test('two workspaces with the same name stay isolated', () => {
    save(alice, 'deploys with the blue pipeline', inWorkspace('ws-alice-1'));
    save(alice, 'deploys with the green pipeline', inWorkspace('ws-alice-2'));
    save(bob, 'deploys with the red pipeline', inWorkspace('ws-bob'));

    assert.deepEqual(bodies(searchMemories(alice, { query: 'pipeline', workspaceId: 'ws-alice-1' })), ['deploys with the blue pipeline']);
    assert.deepEqual(bodies(searchMemories(alice, { query: 'pipeline', workspaceId: 'ws-alice-2' })), ['deploys with the green pipeline']);
    assert.deepEqual(bodies(listMemories(alice, { scope: 'workspace', workspaceId: 'ws-alice-2' }).items), ['deploys with the green pipeline']);
    assert.deepEqual(bodies(listMemories(alice, { scope: 'workspace' }).items).sort(),
      ['deploys with the blue pipeline', 'deploys with the green pipeline']);
    // Without a workspace only the user scope is searched.
    assert.deepEqual(searchMemories(alice, { query: 'pipeline' }), []);
  });
});

describe('search', () => {
  test('recalls Chinese with two-character (LIKE) and three-or-more-character (trigram) queries', () => {
    save(alice, '回答请使用中文，并保持简洁', { kind: 'preference' });
    save(alice, '提交信息用英文写');
    assert.deepEqual(bodies(searchMemories(alice, { query: '中文' })), ['回答请使用中文，并保持简洁']);
    assert.deepEqual(bodies(searchMemories(alice, { query: '用中文' })), ['回答请使用中文，并保持简洁']);
    assert.deepEqual(bodies(searchMemories(alice, { query: '使用中文' })), ['回答请使用中文，并保持简洁']);
    assert.deepEqual(bodies(searchMemories(alice, { query: '英文' })), ['提交信息用英文写']);
    assert.deepEqual(searchMemories(alice, { query: '日文' }), []);
  });

  test('recalls English case-insensitively and ranks rows matching more terms first', () => {
    save(alice, 'Prefer pnpm over npm in this repository');
    save(alice, 'Run the linter before pushing');
    save(alice, 'The repository uses pnpm workspaces and the linter config lives at the root');
    assert.deepEqual(bodies(searchMemories(alice, { query: 'PNPM' })).sort(), [
      'Prefer pnpm over npm in this repository',
      'The repository uses pnpm workspaces and the linter config lives at the root',
    ]);
    const ranked = bodies(searchMemories(alice, { query: 'pnpm linter repository' }));
    assert.equal(ranked[0], 'The repository uses pnpm workspaces and the linter config lives at the root');
    assert.equal(ranked.length, 3);
    assert.deepEqual(bodies(searchMemories(alice, { query: 'pnpm linter', limit: 1 })),
      ['The repository uses pnpm workspaces and the linter config lives at the root']);
  });

  test('treats FTS and LIKE syntax in a query literally', () => {
    save(alice, 'coverage goal is 100% of src_dir');
    save(alice, 'cobalt theme');
    save(alice, 'cod liver oil');
    save(alice, 'say "hello" AND NEAR(x)');
    assert.deepEqual(bodies(searchMemories(alice, { query: '100%' })), ['coverage goal is 100% of src_dir']);
    assert.deepEqual(bodies(searchMemories(alice, { query: '%' })), ['coverage goal is 100% of src_dir']);
    // `_` is not a wildcard: "o_" is not in "cobalt" or "cod", and "c_d" is only in "src_dir".
    assert.deepEqual(searchMemories(alice, { query: 'o_' }), []);
    assert.deepEqual(bodies(searchMemories(alice, { query: 'c_d' })), ['coverage goal is 100% of src_dir']);
    assert.deepEqual(bodies(searchMemories(alice, { query: '"hello"' })), ['say "hello" AND NEAR(x)']);
    assert.deepEqual(bodies(searchMemories(alice, { query: 'NEAR(' })), ['say "hello" AND NEAR(x)']);
    assert.deepEqual(searchMemories(alice, { query: '* OR ^' }), []);
    assert.throws(() => searchMemories(alice, { query: '   ' }), memoryError('invalid_argument'));
  });

  test('searches a workspace together with the user scope unless includeUser is false', () => {
    save(alice, 'shared style rule');
    save(alice, 'workspace style rule', inWorkspace('ws-alice-1'));
    assert.deepEqual(bodies(searchMemories(alice, { query: 'style', workspaceId: 'ws-alice-1' })).sort(),
      ['shared style rule', 'workspace style rule']);
    assert.deepEqual(bodies(searchMemories(alice, { query: 'style', workspaceId: 'ws-alice-1', includeUser: false })),
      ['workspace style rule']);
  });

  test('list filters by every term and pages with an opaque cursor', () => {
    for (let i = 1; i <= 5; i++) save(alice, `note ${i} about 部署`);
    save(alice, 'unrelated');
    const first = listMemories(alice, { limit: 2, query: 'note 部署' });
    assert.deepEqual(bodies(first.items), ['note 5 about 部署', 'note 4 about 部署']);
    assert.ok(first.nextCursor);
    const second = listMemories(alice, { limit: 2, query: 'note 部署', cursor: first.nextCursor });
    assert.deepEqual(bodies(second.items), ['note 3 about 部署', 'note 2 about 部署']);
    const third = listMemories(alice, { limit: 2, query: 'note 部署', cursor: second.nextCursor });
    assert.deepEqual(bodies(third.items), ['note 1 about 部署']);
    assert.equal(third.nextCursor, null);
    assert.throws(() => listMemories(alice, { cursor: 'not-a-cursor' }), memoryError('invalid_argument'));
    assert.throws(() => listMemories(alice, { scope: 'user', workspaceId: 'ws-alice-1' }), memoryError('invalid_argument'));
  });
});

describe('corrections and approval', () => {
  test('an active correction supersedes the old value, which default search and list no longer return', () => {
    const old = save(alice, 'indent with tabs', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    const correction = supersedeMemory(alice, old.id, { body: 'indent with two spaces', status: 'active', origin: 'explicit' });
    assert.equal(correction.supersedesId, old.id);
    assert.equal(correction.kind, 'convention');
    assert.deepEqual(correction.scope, { kind: 'workspace', workspaceId: 'ws-alice-1' });

    assert.deepEqual(bodies(searchMemories(alice, { query: 'indent', workspaceId: 'ws-alice-1' })), ['indent with two spaces']);
    assert.deepEqual(bodies(listMemories(alice).items), ['indent with two spaces']);
    const history = searchMemories(alice, { query: 'indent', workspaceId: 'ws-alice-1', status: ['active', 'superseded'] });
    const superseded = history.find((record) => record.id === old.id);
    assert.equal(superseded?.status, 'superseded');
    assert.equal(superseded?.version, 2);

    assert.throws(() => supersedeMemory(alice, old.id, { body: 'indent with four spaces', status: 'active', origin: 'explicit' }),
      memoryError('invalid_state'));
    assert.throws(() => updateMemory(alice, old.id, { body: 'rewrite history' }), memoryError('invalid_state'));
  });

  test('a pending correction leaves the old value active until it is approved', () => {
    const old = save(alice, 'release on Fridays', { kind: 'decision' });
    const pending = supersedeMemory(alice, old.id, {
      body: 'release on Tuesdays', status: 'pending', origin: 'extracted', sourceRisk: 'untrusted', source: { turnId: 'turn-1', nodeId: 'node-1' },
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.sourceRisk, 'untrusted');
    assert.deepEqual(pending.source, { turnId: 'turn-1', nodeId: 'node-1' });
    assert.deepEqual(bodies(searchMemories(alice, { query: 'release' })), ['release on Fridays']);
    assert.deepEqual(bodies(listMemories(alice, { status: ['pending'] }).items), ['release on Tuesdays']);

    const approved = approveMemory(alice, pending.id);
    assert.equal(approved.status, 'active');
    assert.equal(approved.version, 2);
    assert.deepEqual(bodies(searchMemories(alice, { query: 'release' })), ['release on Tuesdays']);
    assert.equal(listMemories(alice, { status: ['superseded'] }).items[0]?.id, old.id);
    assert.throws(() => approveMemory(alice, pending.id), memoryError('invalid_state'));
  });

  test('rejecting removes a pending memory and only a pending one', () => {
    const old = save(alice, 'use yarn');
    const pending = supersedeMemory(alice, old.id, { body: 'use bun', status: 'pending', origin: 'extracted' });
    assert.throws(() => rejectMemory(alice, old.id), memoryError('invalid_state'));
    rejectMemory(alice, pending.id);
    assert.throws(() => approveMemory(alice, pending.id), memoryError('not_found'));
    assert.deepEqual(bodies(listMemories(alice, { status: ['active', 'pending', 'superseded'] }).items), ['use yarn']);
    assert.equal(ftsMatches('use bun'), 0);
  });

  test('approving after the corrected memory was deleted just activates the correction', () => {
    const old = save(alice, 'old fact');
    const pending = supersedeMemory(alice, old.id, { body: 'new fact', status: 'pending', origin: 'explicit' });
    deleteMemory(alice, old.id);
    const approved = approveMemory(alice, pending.id);
    assert.equal(approved.status, 'active');
    assert.equal(approved.supersedesId, null);
  });
});

describe('delete, versions and events', () => {
  test('a deleted memory is gone from search, list and the index, and removal hooks run in its transaction', () => {
    const record = save(alice, 'secret project codename');
    const removals: string[] = [];
    const off = onMemoryRemoved(({ record: removed, reason }) => {
      removals.push(`${reason}:${removed.id}`);
      assert.equal(getDb().prepare('SELECT 1 FROM memories WHERE id = ?').get(removed.id), undefined);
    });
    try {
      deleteMemory(alice, record.id);
    } finally {
      off();
    }
    assert.deepEqual(removals, [`deleted:${record.id}`]);
    assert.deepEqual(searchMemories(alice, { query: 'codename' }), []);
    assert.deepEqual(listMemories(alice, { status: ['active', 'pending', 'superseded'] }).items, []);
    assert.equal(ftsMatches('codename'), 0);
    assert.throws(() => deleteMemory(alice, record.id), memoryError('not_found'));
  });

  test('a throwing removal hook rolls the deletion back', () => {
    const record = save(alice, 'survives a failed hook');
    const off = onMemoryRemoved(() => { throw new Error('tombstone write failed'); });
    try {
      assert.throws(() => deleteMemory(alice, record.id), /tombstone write failed/);
    } finally {
      off();
    }
    assert.deepEqual(bodies(searchMemories(alice, { query: 'failed hook' })), ['survives a failed hook']);
  });

  test('a stale expectedVersion is a version conflict carrying the stored version', () => {
    const record = save(alice, 'first draft');
    const edited = updateMemory(alice, record.id, { body: 'second draft' }, 1);
    assert.equal(edited.version, 2);
    assert.throws(() => updateMemory(alice, record.id, { body: 'stale edit' }, 1), (error: unknown) =>
      error instanceof MemoryError && error.code === 'version_conflict' && error.currentVersion === 2);
    assert.equal(updateMemory(alice, record.id, { kind: 'decision' }, 2).version, 3);
  });

  test('memoryVersion grows with the user scope or the given workspace only', () => {
    const start = memoryVersion(alice, 'ws-alice-1');
    save(alice, 'user scope change');
    const afterUser = memoryVersion(alice, 'ws-alice-1');
    assert.ok(afterUser > start);
    save(alice, 'other workspace change', inWorkspace('ws-alice-2'));
    assert.equal(memoryVersion(alice, 'ws-alice-1'), afterUser);
    const record = save(alice, 'this workspace change', inWorkspace('ws-alice-1'));
    const afterWorkspace = memoryVersion(alice, 'ws-alice-1');
    assert.ok(afterWorkspace > afterUser);
    deleteMemory(alice, record.id);
    assert.ok(memoryVersion(alice, 'ws-alice-1') > afterWorkspace);
    assert.equal(memoryVersion(bob, 'ws-alice-1'), 0);
  });

  test('changes are announced after they commit', () => {
    const events: MemoryChangedEvent[] = [];
    const listener = (event: MemoryChangedEvent) => { events.push(event); };
    memoryEvents.on('changed', listener);
    try {
      const old = save(alice, 'event body', { ...inWorkspace('ws-alice-1'), source: { nodeId: 'node-7' } });
      const correction = supersedeMemory(alice, old.id, { body: 'event body corrected', status: 'active', origin: 'explicit' });
      deleteMemory(alice, correction.id);
      assert.deepEqual(events.map((event) => [event.action, event.memoryId, event.status]), [
        ['created', old.id, 'active'],
        ['created', correction.id, 'active'],
        ['superseded', old.id, 'superseded'],
        ['deleted', correction.id, 'active'],
      ]);
      assert.deepEqual(events[0], {
        ownerUserId: 'alice', workspaceId: 'ws-alice-1', memoryId: old.id, action: 'created', status: 'active',
        body: 'event body', origin: 'explicit', nodeId: 'node-7', supersedesId: null,
      });
      assert.equal(events[1].supersedesId, old.id);
    } finally {
      memoryEvents.off('changed', listener);
    }
  });
});

describe('settings, pinned preferences and validation', () => {
  test('mode off refuses create and search but still lists, edits and deletes', () => {
    assert.deepEqual(getMemorySettings('alice'), { mode: 'explicit' });
    const existing = save(alice, 'kept while off', { kind: 'preference' });
    const versionBefore = memoryVersion(alice, null);
    setMemorySettings('alice', { mode: 'off' });
    assert.deepEqual(getMemorySettings('alice'), { mode: 'off' });
    assert.deepEqual(getMemorySettings('bob'), { mode: 'explicit' });
    assert.ok(memoryVersion(alice, null) > versionBefore);

    assert.throws(() => save(alice, 'new while off'), memoryError('memory_disabled'));
    assert.throws(() => supersedeMemory(alice, existing.id, { body: 'x', status: 'active', origin: 'explicit' }), memoryError('memory_disabled'));
    assert.throws(() => searchMemories(alice, { query: 'kept' }), memoryError('memory_disabled'));
    assert.deepEqual(pinnedPreferences(alice, null, 1000), []);
    assert.deepEqual(bodies(listMemories(alice).items), ['kept while off']);
    assert.equal(updateMemory(alice, existing.id, { body: 'edited while off' }).body, 'edited while off');
    deleteMemory(alice, existing.id);
    assert.deepEqual(listMemories(alice).items, []);

    save(bob, 'bob is unaffected');
    setMemorySettings('alice', { mode: 'auto' });
    assert.equal(save(alice, 'back on').status, 'active');
    assert.throws(() => setMemorySettings('alice', { mode: 'sometimes' as never }), memoryError('invalid_argument'));
  });

  test('pinned preferences take active preferences and conventions, user scope first, within the budget', () => {
    save(alice, 'aaaa', { kind: 'preference' });
    save(alice, 'a fact is not pinned', { kind: 'fact' });
    save(alice, 'pending is not pinned', { kind: 'preference', status: 'pending' });
    save(alice, 'bbbbbbbbbb', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    save(alice, 'cc', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    save(alice, 'other workspace', { kind: 'convention', ...inWorkspace('ws-alice-2') });
    save(alice, 'dddddddd', { kind: 'preference' });

    assert.deepEqual(bodies(pinnedPreferences(alice, 'ws-alice-1', 100)), ['dddddddd', 'aaaa', 'cc', 'bbbbbbbbbb']);
    assert.deepEqual(bodies(pinnedPreferences(alice, 'ws-alice-1', 14)), ['dddddddd', 'aaaa', 'cc']);
    assert.deepEqual(bodies(pinnedPreferences(alice, null, 100)), ['dddddddd', 'aaaa']);
    assert.deepEqual(pinnedPreferences(alice, 'ws-alice-1', 0), []);
    assert.deepEqual(pinnedPreferences(bob, 'ws-alice-1', 100), []);
  });

  test('rejects malformed input', () => {
    assert.throws(() => save(alice, '   '), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'x'.repeat(2001)), memoryError('invalid_argument'));
    assert.equal(save(alice, `  ${'x'.repeat(2000)}  `).body.length, 2000);
    assert.throws(() => save(alice, 'bad kind', { kind: 'rumor' as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad status', { status: 'superseded' as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad origin', { origin: 'guessed' as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad risk', { sourceRisk: 'risky' as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad source', { source: { ownerUserId: 'bob' } as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad scope', { scope: { kind: 'user', workspaceId: 'ws-alice-1' } as never }), memoryError('invalid_argument'));
    assert.throws(() => save(alice, 'bad scope', { scope: { kind: 'global' } as never }), memoryError('invalid_argument'));
    assert.throws(() => save({ ownerUserId: ' ' }, 'no owner'), memoryError('invalid_argument'));
    assert.throws(() => searchMemories(alice, { query: 'x', limit: 0 }), memoryError('invalid_argument'));
    assert.throws(() => listMemories(alice, { status: ['deleted' as never] }), memoryError('invalid_argument'));
  });
});
