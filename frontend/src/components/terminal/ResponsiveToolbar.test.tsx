import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('closing panel', () => {
  const actions = () => screen.getByRole('group', { hidden: true });
  const toolbar = () => actions().parentElement as HTMLElement;
  // jsdom has no AnimationEvent, so fireEvent.animationEnd drops animationName.
  const animationEnd = (target: Element, animationName: string) => {
    const event = new Event('animationend', { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: animationName });
    fireEvent(target, event);
  };
  afterEach(() => { delete document.documentElement.dataset.reduceMotion; });

  it('plays mobile-leave as an inert ghost, then hides', () => {
    vi.useFakeTimers();
    try {
      render(<ResponsiveToolbar><button>Map</button></ResponsiveToolbar>);
      const trigger = screen.getByRole('button', { name: 'Workspace views' });
      fireEvent.click(trigger);
      expect(toolbar().hasAttribute('data-leaving')).toBe(false);
      fireEvent.click(trigger);
      expect(toolbar().hasAttribute('data-open')).toBe(false);
      expect(toolbar().hasAttribute('data-leaving')).toBe(true);
      expect(actions().hasAttribute('inert')).toBe(true);
      expect(actions().getAttribute('aria-hidden')).toBe('true');
      // Only its own animation ends the phase, not one bubbling from a child.
      animationEnd(screen.getByRole('button', { name: 'Map', hidden: true }), 'mobile-leave');
      expect(toolbar().hasAttribute('data-leaving')).toBe(true);
      animationEnd(actions(), 'mobile-arrive');
      expect(toolbar().hasAttribute('data-leaving')).toBe(true);
      animationEnd(actions(), 'mobile-leave');
      expect(toolbar().hasAttribute('data-leaving')).toBe(false);
      expect(actions().hasAttribute('inert')).toBe(false);

      // Reopening mid-exit turns it around; a skipped animationend still ends it.
      fireEvent.click(trigger);
      fireEvent.click(trigger);
      fireEvent.click(trigger);
      expect(toolbar().hasAttribute('data-open')).toBe(true);
      expect(toolbar().hasAttribute('data-leaving')).toBe(false);
      fireEvent.click(trigger);
      act(() => { vi.advanceTimersByTime(160); });
      expect(toolbar().hasAttribute('data-leaving')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides at once under reduced motion, on viewport changes, and when it never opened', () => {
    document.documentElement.dataset.reduceMotion = 'on';
    render(<><ResponsiveToolbar><button>Map</button></ResponsiveToolbar><button>Outside</button></>);
    const trigger = screen.getByRole('button', { name: 'Workspace views' });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(toolbar().hasAttribute('data-leaving')).toBe(false);

    delete document.documentElement.dataset.reduceMotion;
    fireEvent.click(trigger);
    fireEvent(window, new Event('resize'));
    expect(toolbar().hasAttribute('data-open')).toBe(false);
    expect(toolbar().hasAttribute('data-leaving')).toBe(false);

    // Desktop: the controls are inline and focus moving past them is not a close.
    const map = screen.getByRole('button', { name: 'Map' });
    map.focus();
    fireEvent.blur(map, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
    expect(toolbar().hasAttribute('data-leaving')).toBe(false);
    expect(actions().hasAttribute('inert')).toBe(false);
  });
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
