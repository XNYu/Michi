import { describe, expect, it } from 'vitest';
import { buildTranscriptMarkdown, runSelectionTranscript } from './exportWorkspace';
import type { ChatNodeState, Project } from '../state/chatTypes';

function message(role: 'user' | 'assistant', text: string) {
  return {
    id: `${role}-${text}`,
    role,
    text,
    toolCalls: [],
  };
}

function node(partial: Partial<ChatNodeState> & Pick<ChatNodeState, 'nodeId'>): ChatNodeState {
  return {
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...partial,
  };
}

const project: Project = {
  id: 'p1',
  name: 'Export Lab',
  cwd: '/tmp/export-lab',
  chatIds: ['root', 'child'],
  edges: [{ source: 'root', target: 'child', kind: 'branch' }],
  createdAt: Date.UTC(2026, 0, 1),
  trees: [{ id: 'tree-1', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: 'tree-1',
};

describe('buildTranscriptMarkdown', () => {
  it('exports the original thread transcript without summarizing', () => {
    const nodes = {
      root: node({
        nodeId: 'root',
        title: 'Root Title',
        messages: [
          message('user', 'What is export?'),
          message('assistant', 'It preserves **markdown**.'),
        ],
      }),
      child: node({
        nodeId: 'child',
        parentNodeId: 'root',
        title: 'Child Title',
        messages: [
          message('user', 'Go deeper'),
          message('assistant', 'Raw details stay here.'),
        ],
      }),
    };

    const markdown = buildTranscriptMarkdown(project, 'root', nodes);

    expect(markdown).toContain('# Root Title');
    expect(markdown).toContain('- Root Title');
    expect(markdown).toContain('  - Child Title');
    expect(markdown).toContain('## Root Title');
    expect(markdown).toContain('### Child Title');
    expect(markdown).toContain('What is export?');
    expect(markdown).toContain('It preserves **markdown**.');
    expect(markdown).not.toContain('## Overview');
  });

  it('can export only the selected nodes', () => {
    const nodes = {
      root: node({
        nodeId: 'root',
        title: 'Root Title',
        messages: [message('user', 'Root-only text')],
      }),
      child: node({
        nodeId: 'child',
        parentNodeId: 'root',
        title: 'Child Title',
        messages: [message('assistant', 'Selected child text')],
      }),
    };

    const { markdown, suggestedFilename } = runSelectionTranscript(project, 'root', nodes, ['child']);

    expect(markdown).toContain('Selected child text');
    expect(markdown).not.toContain('Root-only text');
    expect(suggestedFilename).toMatch(/root-title-selection-\d{4}-\d{2}-\d{2}\.md/);
  });

  it('includes structured user-message context in the transcript', () => {
    const nodes = {
      root: node({
        nodeId: 'root',
        title: 'Root Title',
        messages: [
          {
            ...message('user', 'Please respond to the quote.'),
            quotedText: 'Important quoted line',
            attachments: [{ name: 'notes.md', absPath: '/tmp/notes.md' }],
            comments: [{
              id: 'c1',
              quotedText: 'Earlier assistant text',
              body: 'This needs a caveat.',
              createdAt: 1,
            }],
          },
        ],
      }),
    };

    const markdown = buildTranscriptMarkdown({ ...project, chatIds: ['root'], edges: [] }, 'root', nodes);

    expect(markdown).toContain('_Quoted selection:_');
    expect(markdown).toContain('> Important quoted line');
    expect(markdown).toContain('- notes.md (/tmp/notes.md)');
    expect(markdown).toContain('_Comments on previous reply:_');
    expect(markdown).toContain('This needs a caveat.');
  });
});
