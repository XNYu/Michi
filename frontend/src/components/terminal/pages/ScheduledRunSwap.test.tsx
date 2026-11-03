import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunSwap } from './ScheduledRunSwap';

describe('a scheduled run’s state in place', () => {
  it('is drawn settled, then the finished state takes over, the running one out of reach on its way out', async () => {
    const { container, rerender } = render(<RunSwap id="running" className="state">Running</RunSwap>);
    expect(container.textContent).toBe('Running');
    expect(container.querySelector('[aria-hidden]')).toBeNull();
    rerender(<RunSwap id="success" className="state">Succeeded</RunSwap>);
    const leaving = [...container.querySelectorAll('.state')].find((el) => el.textContent === 'Running');
    if (leaving) expect(leaving.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(container.textContent).toBe('Succeeded'));
  });
});
