import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Switch } from './controls';

describe('Switch', () => {
  it('toggles and reports the flipped value, stopping propagation', () => {
    const onChange = vi.fn();
    const parentClick = vi.fn();
    cleanup();
    render(
      <div onClick={parentClick}>
        <Switch on={false} onChange={onChange} aria-label="Feature" />
      </div>,
    );
    const sw = screen.getByRole('switch', { name: 'Feature' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    // stopPropagation → the wrapping row's handler must not also fire.
    expect(parentClick).not.toHaveBeenCalled();
  });
});
