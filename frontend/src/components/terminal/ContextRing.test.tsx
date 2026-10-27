import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextRing } from './ContextRing';

describe('ContextRing', () => {
  it('clamps out-of-range percentages to the meter maximum', () => {
    render(<ContextRing percentage={159.2} />);
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(meter.getAttribute('aria-label')).toBe('Context usage: 100%');

    fireEvent.mouseEnter(meter);
    expect(screen.getByRole('tooltip').textContent).toContain('100.0%');
  });

  it('shows token details in tooltip when usageSummary is provided', () => {
    render(
      <ContextRing
        percentage={50}
        usageSummary={{
          totalTokens: 79500,
          inputTokens: 60000,
          outputTokens: 19500,
          cachedInputTokens: 12000,
        }}
      />,
    );
    const meter = screen.getByRole('meter');
    fireEvent.mouseEnter(meter);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('79.5K tokens');
    expect(tooltip.textContent).toContain('in 60.0K');
    expect(tooltip.textContent).toContain('out 19.5K');
    expect(tooltip.textContent).toContain('cached 12.0K');
  });

  it('shows no token details for Kiro (percentage only)', () => {
    render(<ContextRing percentage={75} />);
    const meter = screen.getByRole('meter');
    fireEvent.mouseEnter(meter);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('75.0%');
    // No token breakdown when usageSummary is absent
    expect(screen.queryByTestId('context-ring-tooltip-details')).toBeNull();
  });

  it('has reduced opacity for low percentages', () => {
    render(<ContextRing percentage={5} />);
    const meter = screen.getByRole('meter');
    expect(meter.style.opacity).toBe('0.5');
  });
});
