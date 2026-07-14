import { describe, expect, it } from 'vitest';
import { centeredPaneScrollLeft } from './Dashboard';

describe('centeredPaneScrollLeft', () => {
  it('centers a target pane using viewport geometry', () => {
    expect(centeredPaneScrollLeft({
      paneLeft: 1_050,
      paneWidth: 600,
      stripLeft: 200,
      stripWidth: 900,
      currentScrollLeft: 300,
      maxScrollLeft: 2_000,
    })).toBe(1_000);
  });

  it('clamps a target at the beginning or end of the strip', () => {
    expect(centeredPaneScrollLeft({
      paneLeft: 220,
      paneWidth: 600,
      stripLeft: 200,
      stripWidth: 900,
      currentScrollLeft: 0,
      maxScrollLeft: 2_000,
    })).toBe(0);
    expect(centeredPaneScrollLeft({
      paneLeft: 1_500,
      paneWidth: 600,
      stripLeft: 200,
      stripWidth: 900,
      currentScrollLeft: 1_900,
      maxScrollLeft: 2_000,
    })).toBe(2_000);
  });
});
