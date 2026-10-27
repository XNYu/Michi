import { describe, expect, it } from 'vitest';
import { axisLabels, timelineAxis } from './TimelineView';

// This year, so the month labels read without a year (`Sep 22`).
const YEAR = new Date().getFullYear();
const NOW = new Date(YEAR, 9, 11, 12).getTime();

describe('axisLabels', () => {
  // Sep 23 → Oct 11, as the QA axis drew it.
  const axis = timelineAxis([{ start: `${YEAR}-09-23`, end: `${YEAR}-10-10` }], NOW);
  const texts = (dayPx: number) => axisLabels(axis.labels, dayPx).map((l) => l?.text ?? null);

  it('gives a month’s first day the room it needs, leaving the next day unlabelled at the narrowest zoom', () => {
    const at22 = texts(22);
    expect(at22.slice(0, 4)).toEqual(['Sep 22', null, '24', '25']);
    const oct1 = axis.labels.findIndex((l) => l.day === `${YEAR}-10-01`);
    expect(at22.slice(oct1 - 1, oct1 + 3)).toEqual(['30', 'Oct 1', null, '3']);
  });

  it('never lets an earlier label take a month start’s room', () => {
    // Drawn from Sep 30: the first day reads as its number so Oct 1 keeps its label.
    const fromSep30 = timelineAxis([{ start: `${YEAR}-10-01`, end: `${YEAR}-10-20` }], NOW);
    expect(fromSep30.labels[0].day).toBe(`${YEAR}-09-30`);
    expect(axisLabels(fromSep30.labels, 22).slice(0, 4).map((l) => l?.text ?? null)).toEqual(['30', 'Oct 1', null, '3']);
    // Narrow days: a day number that would run into Oct 1 goes instead.
    const at8 = axisLabels(axis.labels, 8);
    const oct1 = axis.labels.findIndex((l) => l.day === `${YEAR}-10-01`);
    expect(at8[oct1]?.text).toBe('Oct 1');
  });

  it('labels every day once a day is wide enough', () => {
    expect(texts(48).every((t) => t !== null)).toBe(true);
  });

  it('thins day numbers too when days get narrower than a number', () => {
    const at8 = texts(8);
    // A day number needs ~19px: one label every third day.
    expect(at8.filter(Boolean).length).toBeLessThan(at8.length / 2);
    const shown = axisLabels(axis.labels, 8);
    let free = 0;
    shown.forEach((label, i) => {
      if (!label) return;
      expect(i).toBeGreaterThanOrEqual(free);
      free = i + label.span;
    });
  });
});
