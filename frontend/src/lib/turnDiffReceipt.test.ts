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
  it('returns null when there are no tool calls', () => {
    expect(deriveDiffReceipt(msg([]))).toBeNull();
  });

  it('returns null for read-only / bash-only turns', () => {
    const m = msg([
      tool('read', { path: 'a.ts' }),
      tool('bash', { command: 'rm -rf build' }),
      tool('grep', { pattern: 'foo' }),
    ]);
    expect(deriveDiffReceipt(m)).toBeNull();
  });

  it('write tool produces a file entry with added = content line count', () => {
    const m = msg([tool('write', { path: 'src/a.ts', content: 'one\ntwo\nthree' })]);
    const r = deriveDiffReceipt(m);
    expect(r).not.toBeNull();
    expect(r!.files).toEqual([{ path: 'src/a.ts', added: 3, removed: 0, kind: 'write' }]);
    expect(r!.totalAdded).toBe(3);
    expect(r!.totalRemoved).toBe(0);
  });

  it('write accepts file_path as the path key', () => {
    const m = msg([tool('write', { file_path: 'b.md', content: 'x\ny\n' })]);
    const r = deriveDiffReceipt(m);
    expect(r!.files[0].path).toBe('b.md');
    // trailing newline does not count as an extra line
    expect(r!.files[0].added).toBe(2);
  });

  it('edit tool counts old/new string lines as removed/added', () => {
    const m = msg([
      tool('edit', { path: 'c.ts', old_string: 'a\nb\nc\nd', new_string: 'a\nz' }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r!.files).toEqual([{ path: 'c.ts', added: 2, removed: 4, kind: 'edit' }]);
  });

  it('edits to the same path accumulate', () => {
    const m = msg([
      tool('edit', { path: 'c.ts', old_string: 'a', new_string: 'a\nb' }),
      tool('edit', { path: 'c.ts', old_string: 'x\ny', new_string: 'z' }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r!.files).toEqual([{ path: 'c.ts', added: 3, removed: 3, kind: 'edit' }]);
  });

  it('a later write to the same path supersedes earlier counts (latest write wins)', () => {
    const m = msg([
      tool('edit', { path: 'd.ts', old_string: 'a\nb', new_string: 'c' }),
      tool('write', { path: 'd.ts', content: 'full\nnew\nfile' }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r!.files).toEqual([{ path: 'd.ts', added: 3, removed: 0, kind: 'write' }]);
  });

  it('an edit after a write on the same path accumulates but keeps write kind', () => {
    const m = msg([
      tool('write', { path: 'e.ts', content: 'a\nb' }),
      tool('edit', { path: 'e.ts', old_string: 'a', new_string: 'a\nc' }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r!.files).toEqual([{ path: 'e.ts', added: 4, removed: 1, kind: 'write' }]);
  });

  it('aggregates totals across multiple files', () => {
    const m = msg([
      tool('write', { path: 'a.ts', content: 'l1\nl2' }),
      tool('edit', { path: 'b.ts', old_string: 'x', new_string: 'y\nz' }),
    ]);
    const r = deriveDiffReceipt(m);
    expect(r!.files).toHaveLength(2);
    expect(r!.totalAdded).toBe(4);
    expect(r!.totalRemoved).toBe(1);
  });

  it('skips failed tool calls', () => {
    const m = msg([
      tool('write', { path: 'a.ts', content: 'x' }, { status: 'failed' }),
      tool('edit', { path: 'b.ts', old_string: 'x', new_string: 'y' }, { status: 'error' }),
    ]);
    expect(deriveDiffReceipt(m)).toBeNull();
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
  });

  it('skips tools with missing or malformed inputJson', () => {
    const m = msg([
      tool('write', {}, { inputJson: undefined }),
      tool('write', {}, { inputJson: '{"path": "trunc' }),
      tool('write', { content: 'no path here' }),
    ]);
    expect(deriveDiffReceipt(m)).toBeNull();
  });

  it('empty content write counts as 0 added', () => {
    const m = msg([tool('write', { path: 'empty.txt', content: '' })]);
    const r = deriveDiffReceipt(m);
    expect(r!.files).toEqual([{ path: 'empty.txt', added: 0, removed: 0, kind: 'write' }]);
  });

  it('handles messages without a toolCalls array', () => {
    const m = { id: 'a', role: 'assistant', text: '' } as unknown as ChatMessage;
    expect(deriveDiffReceipt(m)).toBeNull();
  });
});
