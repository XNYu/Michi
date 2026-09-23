import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PopoverSurface } from './Popover';

describe('menu surface isolation', () => {
  it('combines menu geometry with the shared glass material when requested', () => {
    render(<PopoverSurface menuKind="context" glass role="menu">Actions</PopoverSurface>);
    const menu = screen.getByRole('menu');
    expect(menu.classList.contains('michi-menu')).toBe(true);
    expect(menu.classList.contains('term-glass')).toBe(true);
    expect(menu.style.background).toBe('');
    expect(menu.style.boxShadow).toBe('');
  });

  it('frosts every tuned menu except the solid right-click menu', () => {
    render(<>
      <PopoverSurface menuKind="workspace" role="menu" aria-label="Workspaces">Workspace options</PopoverSurface>
      <PopoverSurface menuKind="slash" role="listbox">Slash commands</PopoverSurface>
      <PopoverSurface menuKind="context" role="menu" aria-label="Actions">Actions</PopoverSurface>
    </>);
    expect(screen.getByRole('menu', { name: 'Workspaces' }).classList.contains('term-glass')).toBe(true);
    expect(screen.getByRole('listbox').classList.contains('term-glass')).toBe(true);
    expect(screen.getByRole('menu', { name: 'Actions' }).classList.contains('term-glass')).toBe(false);
  });

  it('only opts the requested surface into the exported menu tokens', () => {
    render(<>
      <PopoverSurface menuKind="workspace" role="menu">Workspace options</PopoverSurface>
      <PopoverSurface variant="tooltip" role="tooltip">Original icon hint</PopoverSurface>
      <PopoverSurface role="dialog">Original unrelated panel</PopoverSurface>
    </>);
    expect(screen.getByRole('menu').classList.contains('michi-menu')).toBe(true);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.classList.contains('michi-menu')).toBe(false);
    expect(tooltip.style.borderRadius).toBe('var(--ui-tooltip-radius)');
    expect(tooltip.style.fontSize).toBe('11px');
    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('michi-menu')).toBe(false);
    expect(dialog.style.borderRadius).toBe('var(--ui-popover-radius)');
  });
});
