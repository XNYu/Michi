import { afterEach, describe, expect, it } from 'vitest';
import { backendNow, recordBackendObservation, resetBackendClocksForTest } from './backendClock';

afterEach(() => resetBackendClocksForTest());

describe('backendNow', () => {
  it('assumes agreeing clocks before any confirmed sample', () => {
    expect(backendNow('a1', 50_000)).toBe(50_000);
    recordBackendObservation('a1', 10_000, 70_000);
    expect(backendNow('a1', 70_500)).toBe(70_500);
  });

  it('confirms a remote clock offset from live frames about a second apart', () => {
    // Renderer is 60s ahead of the backend; frames arrive 5-20ms after stamping.
    recordBackendObservation('a1', 1_000, 61_010);
    recordBackendObservation('a1', 1_500, 61_505);
    expect(backendNow('a1', 61_600)).toBe(61_600);
    recordBackendObservation('a1', 2_000, 62_020);
    expect(backendNow('a1', 62_100)).toBe(62_100 - 60_005);
  });

  it('handles a backend clock that runs ahead of the renderer', () => {
    recordBackendObservation('a1', 90_000, 30_010);
    recordBackendObservation('a1', 91_000, 31_010);
    expect(backendNow('a1', 31_100)).toBe(31_100 + 59_990);
  });

  it('does not trust a stale replay burst on its own', () => {
    // Same clocks; frames observed 9s..3s ago are replayed at once on reload.
    for (const observedAt of [91_000, 94_000, 97_000]) recordBackendObservation('a1', observedAt, 100_000);
    expect(backendNow('a1', 100_200)).toBe(100_200);
  });

  it('does not confirm a replayed frame with its own later re-delivery', () => {
    recordBackendObservation('a1', 97_000, 100_000);
    recordBackendObservation('a1', 97_000, 101_000);
    recordBackendObservation('a1', 97_000, 102_500);
    expect(backendNow('a1', 103_000)).toBe(103_000);
  });

  it('confirms from live frames after a stale replay without keeping the staleness', () => {
    recordBackendObservation('a1', 97_000, 100_000); // 3s stale replay
    recordBackendObservation('a1', 100_995, 101_000); // live
    expect(backendNow('a1', 101_100)).toBe(101_100);
    recordBackendObservation('a1', 101_993, 102_000); // live, a second later
    expect(backendNow('a1', 102_100)).toBe(102_100 - 5);
  });

  it('keeps clocks separate per key and ignores unusable samples', () => {
    recordBackendObservation('remote', 0, 60_000);
    recordBackendObservation('remote', 1_000, 61_000);
    recordBackendObservation('local', undefined, 61_000);
    recordBackendObservation(undefined, 1_000, 61_000);
    recordBackendObservation('local', Number.NaN, 61_000);
    expect(backendNow('remote', 62_000)).toBe(2_000);
    expect(backendNow('local', 62_000)).toBe(62_000);
    expect(backendNow(undefined, 62_000)).toBe(62_000);
  });
});
