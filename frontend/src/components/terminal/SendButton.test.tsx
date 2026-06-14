import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SendButton } from './SendButton';

describe('SendButton', () => {
  it('fires onClick when enabled', () => {
    const onClick = vi.fn();
    render(<SendButton onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(<SendButton onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows the kbd hint by default', () => {
    render(<SendButton onClick={() => {}} />);
    expect(screen.getByText('Send')).toBeTruthy();
    expect(screen.getByText('↵')).toBeTruthy();
  });
});
