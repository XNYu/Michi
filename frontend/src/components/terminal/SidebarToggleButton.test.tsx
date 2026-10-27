import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SidebarToggleButton from './SidebarToggleButton';

describe('SidebarToggleButton', () => {
  it('renders with aria-pressed reflecting collapsed state', () => {
    const { rerender } = render(
      <SidebarToggleButton collapsed={false} onToggle={() => {}} />,
    );
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Collapse sidebar');

    rerender(<SidebarToggleButton collapsed={true} onToggle={() => {}} />);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Open sidebar');
  });
});
