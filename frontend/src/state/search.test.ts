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
  it('finds substring matches in user and assistant messages', () => {
    const nodes = {
      n1: nodeFixture({
        nodeId: 'n1',
        projectId: 'p1',
        title: 'Pricing',
        messages: [
          msg('user', 'how should we handle tier-3 pricing?'),
          msg('assistant', 'Tier-3 enterprise SLA includes...'),
        ],
      }),
    };
    const projects = [projectFixture('p1', 'Research', ['n1'])];
    const result = searchMessages(nodes, projects, 'tier-3');
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].nodeId).toBe('n1');
    expect(result.matches[0].snippet.toLowerCase()).toContain('tier-3');
  });

  it('is case-insensitive', () => {
    const nodes = {
      n1: nodeFixture({
        nodeId: 'n1',
        projectId: 'p1',
        messages: [msg('user', 'Tier-3 PRICING')],
      }),
    };
    const projects = [projectFixture('p1', 'P1', ['n1'])];
    expect(searchMessages(nodes, projects, 'tier-3').matches.length).toBe(1);
    expect(searchMessages(nodes, projects, 'TIER-3').matches.length).toBe(1);
    expect(searchMessages(nodes, projects, 'pricing').matches.length).toBe(1);
  });

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

  it('groups matches across two projects', () => {
    const nodes = {
      a1: nodeFixture({
        nodeId: 'a1',
        projectId: 'p1',
        title: 'A1',
        messages: [msg('user', 'find tier-3 here')],
      }),
      b1: nodeFixture({
        nodeId: 'b1',
        projectId: 'p2',
        title: 'B1',
        messages: [msg('assistant', 'also tier-3 in p2')],
      }),
    };
    const projects = [
      projectFixture('p1', 'Workspace 1', ['a1']),
      projectFixture('p2', 'Workspace 2', ['b1']),
    ];
    const r = searchMessages(nodes, projects, 'tier-3');
    expect(r.matches.length).toBe(2);
    expect(new Set(r.matches.map((m) => m.workspaceId))).toEqual(new Set(['p1', 'p2']));
  });

  it('produces snippet with ~120 char window centered on match', () => {
    const longText = 'a'.repeat(500) + 'TARGET' + 'b'.repeat(500);
    const nodes = {
      n1: nodeFixture({
        nodeId: 'n1',
        projectId: 'p1',
        messages: [msg('user', longText)],
      }),
    };
    const projects = [projectFixture('p1', 'P1', ['n1'])];
    const r = searchMessages(nodes, projects, 'TARGET');
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].snippet.length).toBeLessThanOrEqual(140);
    expect(r.matches[0].snippet).toContain('TARGET');
    expect(r.matches[0].matchOffsetInSnippet[0]).toBeGreaterThanOrEqual(0);
    expect(r.matches[0].matchOffsetInSnippet[1]).toBeGreaterThan(r.matches[0].matchOffsetInSnippet[0]);
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
