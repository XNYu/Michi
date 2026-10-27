import { describe, expect, it } from 'vitest';
import { droppedBelow } from './BoardView';

// Carried 200px down (ghost top 220 -> 420) with the pointer from 500 to 700 (the activator event holds the start).
const pointer = { clientY: 500 } as unknown as Event;
const rect = (top: number) => ({ initial: { top: 220 }, translated: { top, height: 100 } });

describe('droppedBelow', () => {
  it('is not below the last card when let go on the heading', () => {
    expect(droppedBelow(600, { clientY: 40 } as unknown as Event, rect(-40))).toBe(false);
  });

  it('is below the last card when the pointer is under it, however deep the card was grabbed', () => {
    // The ghost top (420) is above the last card's bottom (600), the pointer (now 700) is under it.
    expect(droppedBelow(600, pointer, rect(420))).toBe(true);
  });

  it('is not below when the pointer is in the gap between cards', () => {
    expect(droppedBelow(760, pointer, rect(420))).toBe(false);
  });

  it('falls back to the ghost centre for the keyboard', () => {
    expect(droppedBelow(460, new Event('keydown'), rect(420))).toBe(true);
    expect(droppedBelow(480, new Event('keydown'), rect(420))).toBe(false);
  });
});
