import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ResponsiveToolbar } from './ResponsiveToolbar';

afterEach(cleanup);

it('opens from the keyboard and Escape restores the trigger focus', () => {
  render(<ResponsiveToolbar><button>Map</button></ResponsiveToolbar>);
  const trigger = screen.getByRole('button', { name: 'Workspace views' });
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const map = screen.getByRole('button', { name: 'Map' });
  map.focus();
  fireEvent.keyDown(map, { key: 'Escape' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

it('keeps launcher behavior and closes after choosing a view', () => {
  const openMap = vi.fn();
  render(<ResponsiveToolbar><button onClick={openMap}>Map</button></ResponsiveToolbar>);
  const trigger = screen.getByRole('button', { name: 'Workspace views' });
  fireEvent.click(trigger);
  const map = screen.getByRole('button', { name: 'Map' });
  map.focus();
  fireEvent.click(map);
  expect(openMap).toHaveBeenCalledTimes(1);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

it('dismisses on outside pointer input, focus leaving, and viewport changes', () => {
  render(<><ResponsiveToolbar><button>Map</button></ResponsiveToolbar><button>Outside</button></>);
  const trigger = screen.getByRole('button', { name: 'Workspace views' });
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  fireEvent.blur(trigger, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  fireEvent(window, new Event('resize'));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
