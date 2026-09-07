import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PaneMotionSurface from './PaneMotionSurface';

afterEach(cleanup);

describe('retiring pane surface', () => {
  it('retains committed content props and dimensions until reopened', () => {
    const { container, rerender } = render(<PaneMotionSurface exiting={false}><div style={{ maxWidth: 800 }}>Original</div></PaneMotionSurface>);
    const surface = container.firstElementChild as HTMLElement;
    surface.style.width = '800px'; surface.style.height = '600px';
    rerender(<PaneMotionSurface exiting><div style={{ maxWidth: 400 }}>Changed</div></PaneMotionSurface>);
    expect(surface.style.width).toBe('800px');
    expect(surface.style.height).toBe('600px');
    expect(surface.textContent).toBe('Original');
    rerender(<PaneMotionSurface exiting><div>Another update</div></PaneMotionSurface>);
    expect(surface.style.width).toBe('800px');
    expect(surface.textContent).toBe('Original');
    rerender(<PaneMotionSurface exiting={false}><div>Reopened</div></PaneMotionSurface>);
    expect(surface.style.width).toBe('100%');
    expect(surface.style.height).toBe('100%');
    expect(surface.textContent).toBe('Reopened');
  });

  it('freezes the most recently committed children and preserves scroll offsets', () => {
    const { container, rerender } = render(<PaneMotionSurface exiting={false}><div>First</div></PaneMotionSurface>);
    rerender(<PaneMotionSurface exiting={false} enterWidth={720}><div>Latest</div></PaneMotionSurface>);
    const surface = container.firstElementChild as HTMLElement;
    const child = surface.firstElementChild as HTMLElement;
    child.scrollTop = 120; child.scrollLeft = 48;
    rerender(<PaneMotionSurface exiting><div>Exit render</div></PaneMotionSurface>);
    expect(surface.style.width).toBe('720px');
    expect(surface.textContent).toBe('Latest');
    expect(child.scrollTop).toBe(120);
    expect(child.scrollLeft).toBe(48);
  });
});
