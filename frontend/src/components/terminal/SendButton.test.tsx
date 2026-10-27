import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SendButton } from './SendButton';

describe('SendButton', () => {
  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(<SendButton onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
