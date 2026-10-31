import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AgentRuntimeProfileFields, { emptyRuntimeProfileDraft, type RuntimeFieldCatalog } from './AgentRuntimeProfileFields';

const catalog: RuntimeFieldCatalog = {
  runtimes: [{ id: 'claude', label: 'Claude', available: true }, { id: 'crew', label: 'Kiro Crew', available: false }],
  providersFor: {}, modelsFor: {}, request: vi.fn(),
};

describe('Agent runtime choices', () => {
  it('hides unavailable choices while preserving a saved binding', () => {
    const value = { ...emptyRuntimeProfileDraft(), runtimeId: 'crew' };
    const onChange = vi.fn();
    render(<AgentRuntimeProfileFields value={value} onChange={onChange} catalog={catalog} />);
    const picker = screen.getByRole('combobox', { name: 'runtime runtime' });
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['choose runtime…', 'Claude']);
    expect((picker as HTMLSelectElement).value).toBe('crew');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps an empty known catalog as a picker instead of offering arbitrary runtime input', () => {
    render(<AgentRuntimeProfileFields value={emptyRuntimeProfileDraft()} onChange={vi.fn()} catalog={{ ...catalog, runtimes: [] }} />);
    expect(screen.getByRole('combobox', { name: 'runtime runtime' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'runtime runtime' })).toBeNull();
  });
});
