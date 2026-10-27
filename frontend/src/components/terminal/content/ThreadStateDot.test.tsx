import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThreadStateDot } from './ThreadStateDot';

function dot() {
  return screen.getByRole('img');
}

/** Every painted colour in the glyph, from both fill and stroke. */
function colours(el: Element): string[] {
  return Array.from(el.querySelectorAll('circle, path')).flatMap((shape) =>
    [shape.getAttribute('fill'), shape.getAttribute('stroke')].filter((c): c is string => !!c && c !== 'none'),
  );
}

describe('ThreadStateDot', () => {
  it('draws waiting as a filled accent dot', () => {
    render(<ThreadStateDot state="waiting" />);
    expect(dot().getAttribute('data-state')).toBe('waiting');
    expect(screen.getByRole('img', { name: 'Waiting on you' })).toBeTruthy();
    const circle = dot().querySelector('circle')!;
    expect(circle.getAttribute('fill')).toBe('var(--term-accent)');
    expect(circle.getAttribute('r')).toBe('3.5');
  });

  it('draws in progress as an unfilled ring', () => {
    render(<ThreadStateDot state="doing" />);
    expect(dot().getAttribute('data-state')).toBe('doing');
    expect(screen.getByRole('img', { name: 'In progress' })).toBeTruthy();
    const circle = dot().querySelector('circle')!;
    expect(circle.getAttribute('fill')).toBe('none');
    expect(circle.getAttribute('stroke')).toBe('var(--term-mid)');
    expect(circle.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('draws stalled as a half-filled mauve ring', () => {
    render(<ThreadStateDot state="stalled" />);
    expect(dot().getAttribute('data-state')).toBe('stalled');
    expect(screen.getByRole('img', { name: 'Stalled' })).toBeTruthy();
    expect(dot().querySelector('circle')!.getAttribute('stroke')).toBe('var(--term-mauve)');
    expect(dot().querySelector('path')!.getAttribute('fill')).toBe('var(--term-mauve)');
    expect(colours(dot()).every((c) => c === 'var(--term-mauve)')).toBe(true);
  });

  it('draws done as a check mark', () => {
    render(<ThreadStateDot state="done" doneBy="user" />);
    expect(dot().getAttribute('data-state')).toBe('done');
    expect(screen.getByRole('img', { name: 'Done' })).toBeTruthy();
    expect(dot().querySelector('circle')).toBeNull();
    expect(dot().querySelector('path')!.getAttribute('stroke')).toBe('var(--term-digest)');
  });

  it('treats done without doneBy as the user’s done', () => {
    render(<ThreadStateDot state="done" />);
    expect(dot().getAttribute('data-state')).toBe('done');
  });

  it('draws agent-claimed done as a dashed ring', () => {
    render(<ThreadStateDot state="done" doneBy="agent" />);
    expect(dot().getAttribute('data-state')).toBe('agent-done');
    expect(screen.getByRole('img', { name: 'Agent says done' })).toBeTruthy();
    const circle = dot().querySelector('circle')!;
    expect(circle.getAttribute('stroke-dasharray')).toBe('1.6 1.4');
    expect(circle.getAttribute('stroke')).toBe('var(--term-digest)');
    expect(circle.getAttribute('fill')).toBe('none');
  });

  it('draws chatted only as a small faint dot', () => {
    render(<ThreadStateDot state="idea" />);
    expect(dot().getAttribute('data-state')).toBe('idea');
    expect(screen.getByRole('img', { name: 'Chatted only' })).toBeTruthy();
    const circle = dot().querySelector('circle')!;
    expect(circle.getAttribute('r')).toBe('2.5');
    expect(circle.getAttribute('fill')).toBe('var(--term-faint)');
  });

  it('sizes the glyph and carries an optional title', () => {
    render(<ThreadStateDot state="waiting" size={8} title="2 waiting" />);
    expect(dot().getAttribute('width')).toBe('8');
    expect(dot().getAttribute('height')).toBe('8');
    expect(dot().querySelector('title')?.textContent).toBe('2 waiting');
  });

  it('has a larger named size for section headers', () => {
    render(<ThreadStateDot state="stalled" size="lg" />);
    expect(dot().getAttribute('data-size')).toBe('lg');
    expect(Number(dot().getAttribute('width'))).toBeGreaterThan(10);
    expect(dot().getAttribute('width')).toBe(dot().getAttribute('height'));
  });
});

describe('ThreadStateDot — Michi’s own kinds', () => {
  it('draws a running Michi turn as a turning three-quarter arc in the streaming colour', () => {
    render(<ThreadStateDot kind="running" />);
    expect(dot().getAttribute('data-state')).toBe('running');
    expect(screen.getByRole('img', { name: 'Running now' })).toBeTruthy();
    const arc = dot().querySelector('circle')!;
    expect(arc.getAttribute('stroke')).toBe('var(--term-select)');
    expect(arc.getAttribute('fill')).toBe('none');
    expect(arc.getAttribute('stroke-dasharray')).toBe('16.5 22');
    // The turn is CSS (desk.css), so prefers-reduced-motion can stop it.
    expect(arc.getAttribute('class')).toBe('michi-state-dot__spin');
  });

  it('draws a conversation resumed here as an accent dot with a soft ring', () => {
    render(<ThreadStateDot kind="live" />);
    expect(dot().getAttribute('data-state')).toBe('live');
    expect(screen.getByRole('img', { name: 'Live in Michi' })).toBeTruthy();
    const [halo, core] = Array.from(dot().querySelectorAll('circle'));
    expect(halo.getAttribute('fill')).toBe('var(--term-accent-f)');
    expect(core.getAttribute('fill')).toBe('var(--term-accent)');
    expect(core.getAttribute('r')).toBe('3.5');
    expect(dot().getAttribute('overflow')).toBe('visible');
  });

  it('draws a conversation Michi could not read as a danger dot', () => {
    render(<ThreadStateDot kind="read-failed" />);
    expect(dot().getAttribute('data-state')).toBe('read-failed');
    expect(screen.getByRole('img', { name: "Couldn't be read" })).toBeTruthy();
    expect(colours(dot())).toEqual(['var(--term-danger)']);
  });

  it('lets kind override what state implies, without breaking state callers', () => {
    render(<ThreadStateDot state="waiting" kind="live" />);
    expect(dot().getAttribute('data-state')).toBe('live');
  });

  it('labels an overridden thread state the way the state would', () => {
    render(<ThreadStateDot kind="agent-done" />);
    expect(screen.getByRole('img', { name: 'Agent says done' })).toBeTruthy();
  });
});
