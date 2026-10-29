import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextRing } from './ContextRing';

// jsdom has no PointerEvent, so fireEvent would drop pointerType.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

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

  it('toggles on tap and closes on the next tap outside, on a touch screen', () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    render(<><ContextRing percentage={42} /><button type="button">elsewhere</button></>);
    const meter = screen.getByRole('meter');
    try {
      fireEvent.pointerOver(meter, { pointerType: 'touch' });
      fireEvent.pointerDown(meter, { pointerType: 'touch' });
      fireEvent.mouseEnter(meter);
      fireEvent.click(meter);
      expect(screen.getByRole('tooltip').textContent).toContain('42.0%');

      fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }), { pointerType: 'touch' });
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      fireEvent.pointerOver(document.body, { pointerType: 'mouse' });
      vi.unstubAllGlobals();
    }
  });

  it('has reduced opacity for low percentages', () => {
    render(<ContextRing percentage={5} />);
    const meter = screen.getByRole('meter');
    expect(meter.style.opacity).toBe('0.5');
  });
});
