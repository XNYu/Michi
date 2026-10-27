import { describe, it, expect } from 'vitest';
import { deriveDiffReceipt } from './turnDiffReceipt';
import type { ChatMessage, ToolCallState } from '../state/chatTypes';

function msg(toolCalls: ToolCallState[]): ChatMessage {
  return { id: 'a1', role: 'assistant', text: '', toolCalls };
}

function tool(
  title: string,
  input: unknown,
  overrides: Partial<ToolCallState> = {},
): ToolCallState {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    title,
    status: 'completed',
    inputJson: JSON.stringify(input),
    ...overrides,
  };
}

describe('deriveDiffReceipt', () => {
  it('an edit after a write on the same path accumulates but keeps write kind', () => {
    const m = msg([
      tool('write', { path: 'e.ts', content: 'a\nb' }),
      tool('edit', { path: 'e.ts', old_string: 'a', new_string: 'a\nc' }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r!.files).toEqual([{ path: 'e.ts', added: 4, removed: 1, kind: 'write', countsKnown: true }]);
  });

  it('skips interrupted tool calls (turn cancelled/errored mid-flight)', () => {
    // finalizeMessage stamps still-active tools 'interrupted' on cancel/error;
    // the tool may never have executed, so no receipt.
    const m = msg([
      tool('write', { path: 'a.ts', content: 'x\ny' }, { status: 'interrupted' }),
    ]);
    expect(deriveDiffReceipt(m)).toBeNull();
  });

  it('parses Codex fileChange tool calls (Edit <basename> title + changes array)', () => {
    const m = msg([
      tool('Edit turnDiffReceipt.ts', {
        id: 'item-1',
        type: 'fileChange',
        changes: [{ path: 'src/lib/turnDiffReceipt.ts', kind: 'update' }],
      }),
      tool('Edit 2 files', {
        id: 'item-2',
        type: 'fileChange',
        changes: [
          { path: 'src/a.ts', kind: 'update' },
          { path: 'src/b.ts', kind: 'add' },
        ],
      }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r).not.toBeNull();
    expect(r!.files.map((f) => f.path).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/lib/turnDiffReceipt.ts',
    ]);
    // Codex carries no old/new strings — deltas stay 0; the modal shows the real diff.
    expect(r!.totalAdded).toBe(0);
    expect(r!.totalRemoved).toBe(0);
    // Counts are not locally derivable — the receipt hides the misleading +0 −0.
    expect(r!.files.every((f) => f.countsKnown)).toBe(false);
  });

  it('skips tools with missing or malformed inputJson', () => {
    const m = msg([
      tool('write', {}, { inputJson: undefined }),
      tool('write', {}, { inputJson: '{"path": "trunc' }),
      tool('write', { content: 'no path here' }),
    ]);
    expect(deriveDiffReceipt(m)).toBeNull();
  });

  it('extracts path from "Writing <filename>" title (Kiro runtime)', () => {
    const m = msg([
      tool('Writing quicksort.py', { content: 'def qs(arr):\n    pass\n' }, { inputJson: JSON.stringify({ content: 'def qs(arr):\n    pass\n' }) }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r).not.toBeNull();
    expect(r!.files[0].path).toBe('quicksort.py');
    expect(r!.files[0].added).toBe(2);
  });

  it('extracts path from output field (Kiro JSON items format)', () => {
    const m = msg([
      tool('Editing foo.ts', {}, {
        inputJson: undefined,
        output: '{"items":[{"Text":"Successfully replaced 1 occurrence(s) in /Users/x/rabbitholes/frontend/src/foo.ts."}]}',
      }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r).not.toBeNull();
    expect(r!.files[0].path).toBe('/Users/x/rabbitholes/frontend/src/foo.ts');
  });

  it('extracts path from output "The file X has been updated" format', () => {
    const m = msg([
      tool('Edit', {}, {
        inputJson: undefined,
        output: 'The file /Users/x/rabbitholes/state/chatTypes.ts has been updated successfully. (file state is current)',
      }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r).not.toBeNull();
    expect(r!.files[0].path).toBe('/Users/x/rabbitholes/state/chatTypes.ts');
  });
});
