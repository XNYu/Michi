import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentRecentRun } from 'michi-shared';
import { lastSeen, runTime, runTitle, summaryText } from './metaAgentCopy';
import { useZhCnDefaultLocale } from '../../../../test/zhCnLocale';

const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(23, 10, 45);
const row = (since: number, time: number) => ({ since, at: time }) as MetaAgentRecentRun;

describe('Scheduled › Meta agent times', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('are written in English whatever the browser locale', () => {
    useZhCnDefaultLocale();
    expect(lastSeen(at(23, 10, 42), NOW)).toBe('10:42');
    expect(lastSeen(at(22, 20, 0), NOW)).toBe('Yesterday');
    expect(lastSeen(at(17, 9, 0), NOW)).toBe('6 days ago');
    expect(lastSeen(at(9, 17, 20), NOW)).toBe('Oct 9');
    expect(runTime(row(at(23, 9, 30), at(23, 9, 59)), NOW)).toBe('09:30–09:59');
    expect(runTime(row(at(22, 23, 5), at(22, 23, 5)), NOW)).toBe('yesterday 23:05');
    expect(runTime(row(at(9, 17, 20), at(9, 17, 20)), NOW)).toBe('Oct 9, 17:20');
  });
});

describe('Scheduled › Meta agent summary rows', () => {
  const summary = (patch: Partial<MetaAgentRecentRun>) => ({ kind: 'summary', state: 'done', workspaceCount: 0, changedHomes: [], rewroteBlocks: [], ...patch }) as MetaAgentRecentRun;

  it('name the Home and how many workspace homes changed, then what was rewritten', () => {
    expect(runTitle(summary({ workspaceCount: 1, changedHomes: ['个人'] }))).toBe('Home (all workspaces) · 1 workspace home changed');
    expect(runTitle(summary({}))).toBe('Home (all workspaces)');
    expect(summaryText(summary({ changedHomes: ['a', 'b', 'c'], rewroteBlocks: ['Focus'] }))).toBe('New in a, b and c → rewrote “Focus”. It reads pages, not conversations.');
    expect(summaryText(summary({}))).toBe('Nothing to change. It reads pages, not conversations.');
    expect(summaryText(summary({ state: 'failed' }))).toBe('Failed: the summary stopped before writing');
  });
});
