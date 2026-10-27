import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

const node: ChatNodeState = {
  nodeId: 'node', kind: 'chat', chatId: 'chat', projectId: 'workspace', status: 'error', followUps: [],
  errorKind: 'turn_persistence_failed', errorTurnId: 'original-turn', error: 'Final save failed',
  messages: [
    { id: 'user', role: 'user', text: 'Update the file', toolCalls: [] },
    { id: 'assistant', role: 'assistant', text: 'The file was updated.', toolCalls: [] },
  ],
};

function list(value: ChatNodeState, onCheck = vi.fn(), onRunAgain = vi.fn()) {
  return <PaneMessageList node={value} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={false}
    viewportHeight={800} onRetryTurn={onCheck} onRunAgain={onRunAgain}
    onEditUserMessage={vi.fn()} onContinueFollowUp={vi.fn()} onBranchFollowUp={vi.fn()} />;
}

describe('uncertain turn recovery actions', () => {
  it('checks the original task and requires an explicit second action to run it again', () => {
    const check = vi.fn();
    const rerun = vi.fn();
    render(list(node, check, rerun));
    fireEvent.click(screen.getByRole('button', { name: 'Check original turn' }));
    expect(check).toHaveBeenCalledExactlyOnceWith(0);
    expect(rerun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Run again$/ }));
    expect(rerun).not.toHaveBeenCalled();
    expect(screen.getByText(/may repeat file changes/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run again anyway' }));
    expect(rerun).toHaveBeenCalledExactlyOnceWith(0);
    expect(screen.getByText('The file was updated.')).not.toBeNull();
  });

  it('updates the memoized error tail while checking and leaves an unavailable result visible', () => {
    const check = vi.fn();
    const rerun = vi.fn();
    const view = render(list(node, check, rerun));
    view.rerender(list({ ...node, errorRecovery: 'checking' }, check, rerun));
    expect((screen.getByRole('button', { name: 'Checking original turn…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^Run again$/ }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(list({ ...node, errorRecovery: 'unavailable' }, check, rerun));
    expect(screen.getByText(/original result could not be confirmed/)).not.toBeNull();
    expect(screen.getByText('The file was updated.')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Run again$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep current result' }));
    expect(rerun).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run again anyway' })).toBeNull();
  });

  it('does not turn an ordinary rejected request into an unknown-outcome warning', () => {
    const check = vi.fn();
    render(list({ ...node, errorKind: 'invalid_request' }, check));
    fireEvent.click(screen.getByTestId('error-tail-retry'));
    expect(check).toHaveBeenCalledExactlyOnceWith(0);
    expect(screen.queryByRole('button', { name: 'Check original turn' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Run again$/ })).toBeNull();
  });
});
