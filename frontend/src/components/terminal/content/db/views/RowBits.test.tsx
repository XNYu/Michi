import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RollingCount } from './RowBits';
import { TaskStatusGlyph } from '../TaskStatusGlyph';

describe('a board column’s count', () => {
  it('is drawn settled, and rolls to a new value, the old one hidden from screen readers on its way out', async () => {
    const { container, rerender } = render(<RollingCount className="count" value={3} />);
    const count = container.querySelector('.count')!;
    expect(count.textContent).toBe('3');
    rerender(<RollingCount className="count" value={4} />);
    const leaving = Array.from(count.children).find((el) => el.textContent === '3');
    if (leaving) expect(leaving.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(count.textContent).toBe('4'));
  });
});

describe('a task status glyph', () => {
  const check = (container: HTMLElement) => container.querySelector('svg[data-status="done"]');

  it('settles a Done check again when a task arrives in its column, and only then', async () => {
    const { container, rerender } = render(<TaskStatusGlyph status="done" />);
    const first = check(container);
    expect(first).not.toBeNull();
    rerender(<TaskStatusGlyph status="done" />);
    expect(check(container)).toBe(first);
    rerender(<TaskStatusGlyph status="done" cheer="t1" />);
    await waitFor(() => expect(container.querySelectorAll('svg').length).toBe(1));
    expect(check(container)).not.toBe(first);
  });

  it('does not replay another status when tasks arrive', () => {
    const { container, rerender } = render(<TaskStatusGlyph status="doing" />);
    const ring = container.querySelector('svg');
    rerender(<TaskStatusGlyph status="doing" cheer="t1" />);
    expect(container.querySelector('svg')).toBe(ring);
  });
});
