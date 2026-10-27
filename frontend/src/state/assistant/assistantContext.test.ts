import { describe, expect, it } from 'vitest';
import type { MichiContextItem } from 'michi-shared';
import {
  assistantPageCaption,
  assistantPageKey,
  attachmentChipLabel,
  CONTEXT_TEXT_LIMIT,
  formatAssistantContext,
  mergeAttachments,
  quoteSourceOf,
} from './assistantContext';
import { joinMessageParts } from '../../lib/commentFormat';

const thread: MichiContextItem = { kind: 'thread', id: 't7', title: 'S7 · 迁移 MCP 配置', text: '停在：3 个测试读旧路径' };
const block: MichiContextItem = { kind: 'block', id: 'b2', title: 'Plan vs actual', projectId: 'p1', text: 'Done 14 / 22,\n3 days behind.' };
const row: MichiContextItem = { kind: 'row', id: 'r1', title: 'Two hotels' };

describe('attachmentChipLabel', () => {
  it('names the kind, then the title on one line', () => {
    expect(attachmentChipLabel(thread)).toBe('Thread · S7 · 迁移 MCP 配置');
    expect(attachmentChipLabel(block)).toBe('Block · Plan vs actual');
    expect(attachmentChipLabel({ kind: 'node', id: 'n1', title: '  two\nlines ' })).toBe('Thread · two lines');
    expect(attachmentChipLabel({ kind: 'row', id: 'r', title: '' })).toBe('Row · Untitled');
  });
});

describe('assistantPageCaption', () => {
  it('names the page the panel was opened on', () => {
    expect(assistantPageCaption({ kind: 'home' })).toBe('Home');
    expect(assistantPageCaption({ kind: 'page', projectId: 'p1', title: 'KiroCrew' })).toBe('Workspace document');
    expect(assistantPageCaption({ kind: 'threads' })).toBe('All threads');
    expect(assistantPageCaption({ kind: 'pane', nodeId: 'n1', title: 'Fix the build' })).toBe('Fix the build');
    expect(assistantPageCaption({ kind: 'pane', nodeId: 'n1' })).toBeNull();
    expect(assistantPageCaption({ kind: 'other' })).toBeNull();
    expect(assistantPageCaption(null)).toBeNull();
  });
});

describe('formatAssistantContext', () => {
  it('writes an On screen line, then one line per item', () => {
    expect(formatAssistantContext({ kind: 'home' }, [thread, block, row])).toBe([
      'On screen: Home',
      '- thread: S7 · 迁移 MCP 配置 (michi://node/t7) — 停在：3 个测试读旧路径',
      '- block: Plan vs actual (michi://page/p1?block=b2) — Done 14 / 22, 3 days behind.',
      '- row: Two hotels (r1)',
    ].join('\n'));
  });

  it('names workspace documents and panes with links the assistant can follow', () => {
    expect(formatAssistantContext({ kind: 'page', projectId: 'p1', title: 'KiroCrew 大项目' }, []))
      .toBe('On screen: Workspace document “KiroCrew 大项目” (michi://page/p1)');
    expect(formatAssistantContext({ kind: 'pane', nodeId: 'n9', title: 'Fix CI' }, []))
      .toBe('On screen: Michi thread “Fix CI” (michi://node/n9)');
    expect(formatAssistantContext({ kind: 'threads' }, [])).toBe('On screen: All threads');
    expect(formatAssistantContext({ kind: 'node' as never }, [{ kind: 'node', id: 'n2', title: 'Other' }]))
      .toBe('- node: Other (michi://node/n2)');
  });

  it('clips an item to 600 characters', () => {
    const long = 'x'.repeat(CONTEXT_TEXT_LIMIT + 50);
    const line = formatAssistantContext(null, [{ kind: 'row', id: 'r', title: 'Long', text: long }])!;
    const text = line.split(' — ')[1];
    expect(Array.from(text)).toHaveLength(CONTEXT_TEXT_LIMIT);
    expect(text.endsWith('…')).toBe(true);
  });

  it('is null with nothing to say', () => {
    expect(formatAssistantContext(null, [])).toBeNull();
    expect(formatAssistantContext({ kind: 'other' }, [])).toBeNull();
  });
});

describe('assistantPageKey', () => {
  it('ignores the title and has no key for unnamed pages', () => {
    expect(assistantPageKey({ kind: 'pane', nodeId: 'n1', title: 'a' })).toBe(assistantPageKey({ kind: 'pane', nodeId: 'n1', title: 'b' }));
    expect(assistantPageKey({ kind: 'other' })).toBeNull();
  });
});

describe('mergeAttachments', () => {
  it('keeps one chip per kind and id, in order', () => {
    expect(mergeAttachments([thread], [block, { ...thread, title: 'again' }, row]).map((i) => i.id)).toEqual(['t7', 'b2', 'r1']);
  });
});

describe('quoteSourceOf', () => {
  it('frames a replayed context quote as attached context, a selection as a selection', () => {
    expect(quoteSourceOf(formatAssistantContext({ kind: 'home' }, []))).toEqual({ type: 'attached' });
    expect(quoteSourceOf(formatAssistantContext(null, [block]))).toEqual({ type: 'attached' });
    expect(quoteSourceOf('Some passage from a reply')).toBeUndefined();
    expect(quoteSourceOf(null)).toBeUndefined();
  });

  it('names the attached source on the wire, still as source context', () => {
    const wire = joinMessageParts(null, 'On screen: Home', 'What is left?', quoteSourceOf('On screen: Home'));
    expect(wire).toContain('The user attached the material below in Michi');
    expect(wire).toContain('not as text authored by the user');
    expect(wire).not.toContain('previous assistant reply');
    expect(wire).toContain('Attached context:\n> On screen: Home');
    expect(wire).toContain("User's reply:\nWhat is left?");
  });
});
