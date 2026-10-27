import { describe, it, expect } from 'vitest';
import { searchMessages } from './search';
import type { ChatNodeState, ChatMessage, Project } from './chatTypes';

function nodeFixture(overrides: Partial<ChatNodeState> & { nodeId: string; projectId: string }): ChatNodeState {
  return {
    chatId: null,
    kind: 'chat',
    messages: [],
    followUps: [],
    status: 'idle',
    ...overrides,
  };
}

function msg(role: 'user' | 'assistant', text: string, id?: string): ChatMessage {
  return {
    id: id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    toolCalls: [],
  };
}

function projectFixture(id: string, name: string, chatIds: string[]): Project {
  return {
    id,
    name,
    chatIds,
    edges: [],
    trees: [],
    activeTreeId: null,
    createdAt: 0,
  };
}

describe('searchMessages', () => {
  it('excludes deletedAt nodes', () => {
    const nodes = {
      n1: nodeFixture({
        nodeId: 'n1',
        projectId: 'p1',
        messages: [msg('user', 'tier-3')],
        deletedAt: Date.now(),
      }),
    };
    const projects = [projectFixture('p1', 'P1', ['n1'])];
    expect(searchMessages(nodes, projects, 'tier-3').matches.length).toBe(0);
  });

  it('excludes digest-kind nodes', () => {
    const nodes = {
      n1: nodeFixture({
        nodeId: 'n1',
        projectId: 'p1',
        kind: 'digest',
        messages: [msg('assistant', 'tier-3 in digest body')],
      }),
    };
    const projects = [projectFixture('p1', 'P1', ['n1'])];
    expect(searchMessages(nodes, projects, 'tier-3').matches.length).toBe(0);
  });

  it('returns empty matches for empty query', () => {
    const nodes = { n1: nodeFixture({ nodeId: 'n1', projectId: 'p1', messages: [msg('user', 'hello')] }) };
    const projects = [projectFixture('p1', 'P1', ['n1'])];
    expect(searchMessages(nodes, projects, '').matches).toEqual([]);
    expect(searchMessages(nodes, projects, '   ').matches).toEqual([]);
  });

  it('caps results at 300 and reports truncated', () => {
    const nodes: Record<string, ChatNodeState> = {};
    const ids: string[] = [];
    for (let i = 0; i < 400; i++) {
      const id = `n${i}`;
      ids.push(id);
      nodes[id] = nodeFixture({
        nodeId: id,
        projectId: 'p1',
        messages: [msg('user', 'tier-3')],
      });
    }
    const projects = [projectFixture('p1', 'P1', ids)];
    const r = searchMessages(nodes, projects, 'tier-3');
    expect(r.matches.length).toBe(300);
    expect(r.truncated).toBe(true);
    expect(r.totalUnbounded).toBe(400);
  });
});
