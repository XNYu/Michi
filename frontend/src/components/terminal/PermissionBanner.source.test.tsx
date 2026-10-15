import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PermissionBanner from './PermissionBanner';

describe('PermissionBanner source label', () => {
  it('offers all four choices without approval shortcuts', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner permission={{ requestId: 4, title: 'shell', options: [
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      { optionId: 'once', kind: 'allow_once', name: 'Allow Once' },
      { optionId: 'tool', kind: 'allow_always', name: 'Trust this tool' },
      { optionId: 'session', kind: 'allow_session', name: 'Trust all tools for this session' },
    ] }} onRespond={onRespond} />);
    for (const [name, id] of [['Deny', 'deny'], ['Allow Once', 'once'], ['Trust this tool', 'tool'], ['Trust all tools for this session', 'session']]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onRespond).toHaveBeenLastCalledWith(id);
    }
    onRespond.mockClear();
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('does not allow tool trust when no stable tool identity is available', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner permission={{ requestId: 4, title: 'Run command', options: [
      { optionId: 'tool', kind: 'allow_always', name: 'Trust this tool', disabled: true },
    ] }} onRespond={onRespond} />);
    expect((screen.getByRole('button', { name: /^Trust this tool/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Trust this tool' }));
    expect(onRespond).not.toHaveBeenCalled();
  });
  it('renders Codex approval source', () => {
    render(
      <PermissionBanner
        permission={{
          requestId: 1,
          title: 'Approve bash?',
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
          source: 'codex_approval',
        }}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByTestId('permission-source').textContent).toBe('Codex approval');
  });
});
