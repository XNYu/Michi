import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DigestPromptDialog from './DigestPromptDialog';

describe('DigestPromptDialog', () => {
  it('states the digest scope and default behavior', () => {
    render(<DigestPromptDialog open onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'CREATE DIGEST' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(/selected conversations into one digest/i)).toBeTruthy();
    expect(screen.getByText(/leave it blank for a balanced summary/i)).toBeTruthy();
  });

  it('submits trimmed optional guidance', () => {
    const onConfirm = vi.fn();
    render(<DigestPromptDialog open onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Digest guidance (optional)'), {
      target: { value: '  Focus on risks  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create digest' }));
    expect(onConfirm).toHaveBeenCalledWith('Focus on risks');
  });

  it('cancels from the explicit Cancel action', () => {
    const onCancel = vi.fn();
    render(<DigestPromptDialog open onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
