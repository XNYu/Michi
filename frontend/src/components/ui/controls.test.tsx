import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Button, Switch } from './controls';

describe('Button', () => {
  it('applies the variant + danger classes and fires onClick', () => {
    const onClick = vi.fn();
    render(<Button variant="primary" danger onClick={onClick}>Delete</Button>);
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn.className).toContain('ui-btn');
    expect(btn.className).toContain('ui-btn--primary');
    expect(btn.getAttribute('data-danger')).toBe('true');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

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
