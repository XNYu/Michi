import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiffReceipt } from './DiffReceipt';
import type { ChatMessage, ToolCallState } from '../../state/chatTypes';

function tool(title: string, input: unknown, overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    title,
    status: 'completed',
    inputJson: JSON.stringify(input),
    ...overrides,
  };
}

function msg(toolCalls: ToolCallState[]): ChatMessage {
  return { id: 'a1', role: 'assistant', text: 'done', toolCalls };
}

describe('DiffReceipt', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ diff: 'diff --git a/x b/x\n+added line\n-removed line', truncated: false }),
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing when the message has no file mutations', () => {
    const { container } = render(
      <DiffReceipt message={msg([tool('bash', { command: 'ls' })])} workspaceId="ws1" />,
    );
    expect(container.querySelector('[data-testid="diff-receipt"]')).toBeNull();
  });

  it('renders the collapsed chip with counts', () => {
    const m = msg([
      tool('write', { path: 'src/a.ts', content: 'l1\nl2\nl3' }),
      tool('edit', { path: 'src/b.ts', old_string: 'x\ny', new_string: 'z' }),
    ]);
    render(<DiffReceipt message={m} workspaceId="ws1" />);
    const header = screen.getByTestId('diff-receipt-header');
    expect(header.textContent).toContain('2 files changed');
    expect(header.textContent).toContain('+4');
    expect(header.textContent).toContain('−2');
    // Collapsed: no file rows yet.
    expect(screen.queryAllByTestId('diff-receipt-file')).toHaveLength(0);
  });

  it('uses singular "file" for a single file', () => {
    const m = msg([tool('write', { path: 'only.ts', content: 'x' })]);
    render(<DiffReceipt message={m} workspaceId="ws1" />);
    expect(screen.getByTestId('diff-receipt-header').textContent).toContain('1 file changed');
  });

  it('expands on click and shows per-file rows', () => {
    const m = msg([
      tool('write', { path: 'src/a.ts', content: 'l1\nl2' }),
      tool('edit', { path: 'src/b.ts', old_string: 'x', new_string: 'y\nz' }),
    ]);
    render(<DiffReceipt message={m} workspaceId="ws1" />);
    fireEvent.click(screen.getByTestId('diff-receipt-header'));
    const rows = screen.getAllByTestId('diff-receipt-file');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('src/a.ts');
    expect(rows[0].textContent).toContain('+2');
    expect(rows[1].textContent).toContain('src/b.ts');
    expect(rows[1].textContent).toContain('−1');
    // Collapse again.
    fireEvent.click(screen.getByTestId('diff-receipt-header'));
    expect(screen.queryAllByTestId('diff-receipt-file')).toHaveLength(0);
  });

  it('clicking a file opens the diff modal and fetches the diff', async () => {
    const m = msg([tool('write', { path: 'src/a.ts', content: 'x' })]);
    render(<DiffReceipt message={m} workspaceId="ws-42" />);
    fireEvent.click(screen.getByTestId('diff-receipt-header'));
    fireEvent.click(screen.getByTestId('diff-receipt-file'));

    // Modal is portaled to body with the file path as its accessible name.
    expect(screen.getByRole('dialog', { name: 'diff: src/a.ts' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('+added line')).toBeTruthy();
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/workspaces/ws-42/diff?path=src%2Fa.ts');
  });

  it('closes the modal on Escape', async () => {
    const m = msg([tool('write', { path: 'src/a.ts', content: 'x' })]);
    render(<DiffReceipt message={m} workspaceId="ws1" />);
    fireEvent.click(screen.getByTestId('diff-receipt-header'));
    fireEvent.click(screen.getByTestId('diff-receipt-file'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('consumes Escape exclusively — other window keydown listeners must not fire', async () => {
    // TerminalShell's global Escape handler clears selection / leaves
    // fullscreen pages. The modal's capture-phase handler must suppress it.
    const shellSpy = vi.fn();
    const shellListener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shellSpy();
    };
    window.addEventListener('keydown', shellListener);
    try {
      const m = msg([tool('write', { path: 'src/a.ts', content: 'x' })]);
      render(<DiffReceipt message={m} workspaceId="ws1" />);
      fireEvent.click(screen.getByTestId('diff-receipt-header'));
      fireEvent.click(screen.getByTestId('diff-receipt-file'));
      expect(screen.getByRole('dialog')).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(shellSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', shellListener);
    }
  });

  it('shows an error message when the diff endpoint 404s', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const m = msg([tool('write', { path: 'src/a.ts', content: 'x' })]);
    render(<DiffReceipt message={m} workspaceId="ws1" />);
    fireEvent.click(screen.getByTestId('diff-receipt-header'));
    fireEvent.click(screen.getByTestId('diff-receipt-file'));
    await waitFor(() => {
      expect(screen.getByText(/no diff available/)).toBeTruthy();
    });
  });
});
