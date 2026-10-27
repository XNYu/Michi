import { afterEach, describe, expect, it } from 'vitest';
import {
  addAssistantAttachments,
  getAssistantComposer,
  noteAssistantContextSent,
  pendingAssistantContext,
  removeAssistantAttachment,
  requestAssistantSend,
  resetAssistantComposerForTests,
  setAssistantPage,
  takeAssistantSends,
} from './assistantComposer';

afterEach(() => resetAssistantComposerForTests());

describe('assistant composer context', () => {
  it('carries the page once, then only when the user moves', () => {
    setAssistantPage('a', { kind: 'home' });
    expect(pendingAssistantContext('a')).toBe('On screen: Home');
    noteAssistantContextSent('a');
    expect(pendingAssistantContext('a')).toBeNull();
    setAssistantPage('a', { kind: 'threads' });
    expect(pendingAssistantContext('a')).toBe('On screen: All threads');
  });

  it('sends attachments with the page and clears them after the send', () => {
    setAssistantPage('a', { kind: 'home' });
    noteAssistantContextSent('a');
    addAssistantAttachments('a', [{ kind: 'thread', id: 't1', title: 'S7' }]);
    expect(pendingAssistantContext('a')).toBe('On screen: Home\n- thread: S7 (michi://node/t1)');
    noteAssistantContextSent('a');
    expect(getAssistantComposer('a').attachments).toEqual([]);
    expect(pendingAssistantContext('a')).toBeNull();
  });

  it('removes one chip and keeps state per node', () => {
    addAssistantAttachments('a', [{ kind: 'thread', id: 't1', title: 'one' }, { kind: 'block', id: 'b1', title: 'two' }]);
    removeAssistantAttachment('a', { kind: 'thread', id: 't1' });
    expect(getAssistantComposer('a').attachments.map((i) => i.id)).toEqual(['b1']);
    expect(pendingAssistantContext('b')).toBeNull();
  });

  it('keeps the same state object when nothing changes', () => {
    setAssistantPage('a', { kind: 'home' });
    const before = getAssistantComposer('a');
    setAssistantPage('a', { kind: 'home' });
    addAssistantAttachments('a', []);
    expect(getAssistantComposer('a')).toBe(before);
  });

  it('holds requested sends until the pane takes them, once', () => {
    requestAssistantSend('a', '  Archive them  ');
    requestAssistantSend('a', '   ');
    requestAssistantSend('a', 'and then?');
    expect(getAssistantComposer('a').sends.map((s) => s.prompt)).toEqual(['Archive them', 'and then?']);
    expect(takeAssistantSends('a').map((s) => s.prompt)).toEqual(['Archive them', 'and then?']);
    expect(takeAssistantSends('a')).toEqual([]);
    expect(getAssistantComposer('a').sends).toEqual([]);
  });
});
