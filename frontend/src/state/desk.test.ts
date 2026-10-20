import { describe, expect, it } from 'vitest';
import {
  assembleDeskNow,
  classifyDeskThread,
  DESK_DAY_MS,
  type DeskThreadFacts,
} from 'michi-shared';

const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const DAY_AGO = 24 * 60 * 60 * 1000;

function facts(overrides: Partial<DeskThreadFacts> = {}): DeskThreadFacts {
  return {
    id: 'tree',
    projectId: 'ws',
    projectTitle: 'Michi',
    rootNodeId: 'root',
    focusNodeId: 'root',
    title: 'Schema',
    lastActivityAt: NOW - 60 * 60 * 1000,
    lastRole: 'assistant',
    userMessages: 1,
    assistantMessages: 1,
    streaming: false,
    activeTurn: false,
    followUps: [],
    stoppedAt: 'Need a decision',
    lastMessageId: 'm1',
    treeArchivedAt: null,
    mark: null,
    ...overrides,
  };
}

describe('desk classification', () => {
  it('waits on you after a recent assistant reply', () => {
    expect(classifyDeskThread(facts(), NOW).state).toBe('waiting');
  });

  it('stalls an unfinished thread after three quiet days', () => {
    const recent = classifyDeskThread(facts({ lastActivityAt: NOW - 3 * DESK_DAY_MS + 1 }), NOW);
    const quiet = classifyDeskThread(facts({ lastActivityAt: NOW - 3 * DESK_DAY_MS }), NOW);
    expect(recent.state).toBe('waiting');
    expect(quiet.state).toBe('stalled');
    expect(quiet.idleDays).toBe(3);
  });

  it('keeps a blank thread as chatted no matter how old it is', () => {
    const blank = classifyDeskThread(facts({
      lastActivityAt: NOW - 40 * DESK_DAY_MS,
      lastRole: null,
      userMessages: 0,
      assistantMessages: 0,
      stoppedAt: '',
    }), NOW);
    expect(blank.state).toBe('idea');
    expect(blank.visibility).toBe('live');
  });

  it('treats an unanswered prompt as in progress, then stalled', () => {
    expect(classifyDeskThread(facts({
      lastRole: 'user',
      assistantMessages: 0,
      lastActivityAt: NOW - 60 * 1000,
    }), NOW).state).toBe('doing');
    expect(classifyDeskThread(facts({
      lastRole: 'user',
      assistantMessages: 0,
      lastActivityAt: NOW - 5 * DESK_DAY_MS,
    }), NOW).state).toBe('stalled');
  });

  it('lets a live turn outrank a done mark', () => {
    const running = classifyDeskThread(facts({
      streaming: true,
      lastActivityAt: NOW - 10 * DESK_DAY_MS,
      mark: { disposition: 'active', doneBy: 'user', markedAt: NOW, activityAtMark: NOW - 10 * DESK_DAY_MS },
    }), NOW);
    expect(running.state).toBe('doing');
  });

  it('holds a done mark until the thread moves again', () => {
    const held = classifyDeskThread(facts({
      mark: { disposition: 'active', doneBy: 'user', markedAt: NOW, activityAtMark: NOW - 60 * 60 * 1000 },
    }), NOW);
    expect(held.state).toBe('done');
    expect(held.doneBy).toBe('user');
    const moved = classifyDeskThread(facts({
      lastActivityAt: NOW,
      mark: { disposition: 'active', doneBy: 'user', markedAt: NOW - 1000, activityAtMark: NOW - 60 * 60 * 1000 },
    }), NOW);
    expect(moved.state).toBe('waiting');
  });

  it('hides an ignore and brings an archived thread back when it moves', () => {
    const hidden = classifyDeskThread(facts({
      mark: { disposition: 'ignored', doneBy: null, markedAt: NOW, activityAtMark: NOW - 60 * 60 * 1000 },
    }), NOW);
    expect(hidden.visibility).toBe('hidden');
    const returned = classifyDeskThread(facts({
      lastActivityAt: NOW,
      mark: { disposition: 'archived', doneBy: null, markedAt: NOW - DAY_AGO, activityAtMark: NOW - 60 * 60 * 1000 },
    }), NOW);
    expect(returned.visibility).toBe('live');
    expect(returned.returned).toBe(true);
  });

  it('keeps a Michi-archived thread out of the waiting section', () => {
    const archived = classifyDeskThread(facts({ treeArchivedAt: NOW - 1000 }), NOW);
    expect(archived.visibility).toBe('archived');
    expect(archived.michiArchived).toBe(true);
    const view = assembleDeskNow([archived], 0, NOW);
    expect(view.waiting).toHaveLength(0);
    expect(view.archivedCount).toBe(1);
    expect(view.summary).toBe('Nothing is waiting.');
  });

  it('counts every waiting thread in the summary, and only eight in the section', () => {
    const threads = Array.from({ length: 9 }, (_, index) => classifyDeskThread(facts({
      id: `t${index}`,
      lastActivityAt: NOW - index * 1000,
    }), NOW));
    const view = assembleDeskNow(threads, 0, NOW);
    expect(view.waiting).toHaveLength(8);
    expect(view.more.waiting).toBe(1);
    expect(view.summary).toBe('9 waiting on you.');
    expect(view.waiting[0]).not.toHaveProperty('visibility');
  });
});
