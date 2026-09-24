import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SteeringReports } from './SteeringReports';

describe('SteeringReports', () => {
  it('defaults to a collapsed, keyboard-native disclosure without the internal ID', () => {
    const { container, getByText } = render(<SteeringReports reports={[{ messageId: 'steer-internal', text: 'Used cobalt.', complete: true }]} />);
    expect(container.querySelector('details')?.open).toBe(false);
    expect(getByText('Model-reported')).toBeTruthy();
    expect(getByText('Used cobalt.')).toBeTruthy();
    expect(container.textContent).not.toContain('steer-internal');
    expect(container.textContent).not.toContain('success');
  });
  it('renders untrusted descriptions as text and distinguishes incomplete output', () => {
    const { container, getByText } = render(<SteeringReports reports={[{ messageId: 'x', text: '<img src=x onerror=alert(1)>', complete: false }]} />);
    expect(getByText('Incomplete note')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img');
  });
  it('renders nothing without reports', () => {
    expect(render(<SteeringReports />).container.textContent).toBe('');
  });
});
