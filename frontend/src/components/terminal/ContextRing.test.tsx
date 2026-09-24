import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextRing } from './ContextRing';

describe('ContextRing', () => {
  it('renders nothing when percentage is undefined', () => {
    const { container } = render(<ContextRing percentage={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when percentage is null', () => {
    const { container } = render(<ContextRing percentage={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when percentage is 0', () => {
    const { container } = render(<ContextRing percentage={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a meter element for a positive percentage', () => {
    render(<ContextRing percentage={31.2} />);
    const meter = screen.getByRole('meter');
    expect(meter).toBeTruthy();
    expect(meter.getAttribute('aria-valuenow')).toBe('31.2');
    expect(meter.getAttribute('aria-label')).toBe('Context usage: 31%');
  });

  it('shows styled tooltip on hover with percentage', () => {
    render(<ContextRing percentage={50} />);
    const meter = screen.getByRole('meter');
    fireEvent.mouseEnter(meter);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeTruthy();
    expect(tooltip.textContent).toContain('50.0%');
  });

  it('clamps out-of-range percentages to the meter maximum', () => {
    render(<ContextRing percentage={159.2} />);
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(meter.getAttribute('aria-label')).toBe('Context usage: 100%');

    fireEvent.mouseEnter(meter);
    expect(screen.getByRole('tooltip').textContent).toContain('100.0%');
  });

  it('hides invalid or negative percentages', () => {
    const { container, rerender } = render(<ContextRing percentage={Number.NaN} />);
    expect(container.firstChild).toBeNull();

    rerender(<ContextRing percentage={-10} />);
    expect(container.firstChild).toBeNull();
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

  it('hides tooltip on mouse leave', () => {
    render(<ContextRing percentage={50} />);
    const meter = screen.getByRole('meter');
    fireEvent.mouseEnter(meter);
    expect(screen.queryByRole('tooltip')).toBeTruthy();
    fireEvent.mouseLeave(meter);
    expect(screen.queryByRole('tooltip')).toBeNull();
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

  it('has full opacity for high percentages', () => {
    render(<ContextRing percentage={50} />);
    const meter = screen.getByRole('meter');
    expect(meter.style.opacity).toBe('1');
  });
});
