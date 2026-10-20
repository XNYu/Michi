import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StatusMark } from './StatusMark';

describe('StatusMark', () => {
  it('uses a different shape for each state, with amber reserved for stalled', () => {
    const { container, rerender } = render(<StatusMark state="waiting" />);
    expect(container.querySelector('[data-shape="solid"]')).toBeTruthy();

    rerender(<StatusMark state="doing" />);
    expect(container.querySelector('[data-shape="ring"]')).toBeTruthy();

    rerender(<StatusMark state="stalled" />);
    const stalled = container.querySelector('[data-shape="half"]') as HTMLElement;
    expect(stalled).toBeTruthy();
    expect(stalled.getAttribute('aria-label')).toBe('Stalled');

    rerender(<StatusMark state="done" />);
    expect(container.querySelector('[data-shape="check"]')).toBeTruthy();

    rerender(<StatusMark state="done" doneBy="agent" />);
    expect(container.querySelector('[data-shape="dashed"]')).toBeTruthy();
    expect(container.textContent).toContain('Agent says');

    rerender(<StatusMark state="idea" />);
    expect(container.querySelector('[data-shape="square"]')).toBeTruthy();
  });
});
