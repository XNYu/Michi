import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DigestPromptDialog from './DigestPromptDialog';

describe('DigestPromptDialog', () => {
  it('submits trimmed optional guidance', () => {
    const onConfirm = vi.fn();
    render(<DigestPromptDialog open onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Digest guidance (optional)'), {
      target: { value: '  Focus on risks  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create digest' }));
    expect(onConfirm).toHaveBeenCalledWith('Focus on risks');
  });
});
