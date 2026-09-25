import { describe, expect, test } from 'vitest';
import {
  decodePaneId,
  encodePaneId,
  parseClampedInt,
  parseExecutionRef,
  parseInspectPaneRequestV1,
  parseListLimit,
  parsePaneKind,
  parsePaneListScope,
  parsePaneLocator,
  parseReadOutputLimitBytes,
  parseWaitPaneRequestV1,
  parseWaitTimeoutMs,
  parseWaitUntil,
  PANE_INSPECTION_LIMITS,
  PaneInspectionError,
  type PaneTarget,
  type Section,
} from 'michi-shared';

describe('paneId codec', () => {
  const cases: Array<{ label: string; target: PaneTarget }> = [
    { label: 'node', target: { kind: 'node', nodeId: 'n-abc123' } },
    { label: 'agent_run', target: { kind: 'agent_run', runId: 'run-xyz' } },
    { label: 'agent_run with colon', target: { kind: 'agent_run', runId: 'run:with:colons' } },
    { label: 'agent_run with slash', target: { kind: 'agent_run', runId: 'run/with/slash' } },
    { label: 'surface', target: { kind: 'surface', registrationId: 'reg-456' } },
  ];

  test.each(cases)('round-trips $label', ({ target }) => {
    const encoded = encodePaneId(target);
    expect(decodePaneId(encoded)).toEqual(target);
    expect(encodePaneId(decodePaneId(encoded))).toBe(encoded);
  });

  test('encodes each prefix with the expected shape', () => {
    expect(encodePaneId({ kind: 'node', nodeId: 'n-abc123' })).toBe('node:n-abc123');
    expect(encodePaneId({ kind: 'agent_run', runId: 'run-xyz' })).toBe('run:run-xyz');
    expect(encodePaneId({ kind: 'surface', registrationId: 'reg-456' })).toBe('surface:reg-456');
  });

  describe('decodePaneId rejects', () => {
    const rejections: Array<{ label: string; input: string }> = [
      { label: 'empty string', input: '' },
      { label: 'unknown prefix', input: 'foo:bar' },
      { label: 'missing prefix (no colon at all)', input: 'nodenabc123' },
      { label: 'node: with empty id segment', input: 'node:' },
      { label: 'run: with empty id segment', input: 'run:' },
      { label: 'surface: with empty id segment', input: 'surface:' },
      { label: 'node: with wrong segment count', input: 'node:a:b' },
      { label: 'run: with wrong segment count', input: 'run:a:b' },
      { label: 'surface: with wrong segment count', input: 'surface:a:b' },
      { label: 'leading whitespace', input: ' node:n-abc123' },
      { label: 'trailing whitespace', input: 'node:n-abc123 ' },
      { label: 'run: id that is not valid percent-encoding', input: 'run:%' },
    ];

    test.each(rejections)('$label', ({ input }) => {
      expect(() => decodePaneId(input)).toThrow(PaneInspectionError);
      try {
        decodePaneId(input);
        expect.unreachable('decodePaneId should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PaneInspectionError);
        expect((err as PaneInspectionError).code).toBe('INVALID_ARGUMENT');
      }
    });

    test('non-string input', () => {
      expect(() => decodePaneId(undefined as unknown as string)).toThrow(PaneInspectionError);
      expect(() => decodePaneId(123 as unknown as string)).toThrow(PaneInspectionError);
    });
  });
});

describe('parsePaneLocator: exactly-one-locator enforcement', () => {
  test('accepts exactly one of paneId | nodeId | runId', () => {
    expect(parsePaneLocator({ paneId: 'node:n-1' })).toEqual({ paneId: 'node:n-1' });
    expect(parsePaneLocator({ nodeId: 'n-1' })).toEqual({ nodeId: 'n-1' });
    expect(parsePaneLocator({ runId: 'run-1' })).toEqual({ runId: 'run-1' });
  });

  test('rejects three locators', () => {
    expect(() => parsePaneLocator({ paneId: 'node:n-1', nodeId: 'n-1', runId: 'run-1' })).toThrow(PaneInspectionError);
  });

  test('rejects non-object input', () => {
    expect(() => parsePaneLocator(null)).toThrow(PaneInspectionError);
    expect(() => parsePaneLocator('nodeId')).toThrow(PaneInspectionError);
  });

  test('error carries INVALID_ARGUMENT code', () => {
    try {
      parsePaneLocator({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PaneInspectionError);
      expect((err as PaneInspectionError).code).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('parseExecutionRef', () => {
  test('accepts chat_turn', () => {
    expect(parseExecutionRef({ kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' })).toEqual({
      kind: 'chat_turn',
      nodeId: 'n-1',
      turnId: 't-1',
    });
  });

  test('accepts agent_run', () => {
    expect(parseExecutionRef({ kind: 'agent_run', runId: 'run-1' })).toEqual({ kind: 'agent_run', runId: 'run-1' });
  });

  test('rejects unknown kind', () => {
    expect(() => parseExecutionRef({ kind: 'bogus' })).toThrow(PaneInspectionError);
  });

  test('rejects chat_turn missing turnId', () => {
    expect(() => parseExecutionRef({ kind: 'chat_turn', nodeId: 'n-1' })).toThrow(PaneInspectionError);
  });
});

describe('enum-valued query params', () => {
  test('parsePaneListScope', () => {
    expect(parsePaneListScope('open')).toBe('open');
    expect(parsePaneListScope('all')).toBe('all');
    expect(() => parsePaneListScope('everything')).toThrow(PaneInspectionError);
  });

  test('parseWaitUntil', () => {
    expect(parseWaitUntil('changed')).toBe('changed');
    expect(parseWaitUntil('terminal')).toBe('terminal');
    expect(() => parseWaitUntil('done')).toThrow(PaneInspectionError);
  });

  test('parsePaneKind accepts all 11 kinds and rejects unknown', () => {
    for (const kind of ['chat', 'agent-run', 'digest', 'artifact', 'launcher', 'files', 'review', 'file', 'diff', 'terminal', 'browser']) {
      expect(parsePaneKind(kind)).toBe(kind);
    }
    expect(() => parsePaneKind('spreadsheet')).toThrow(PaneInspectionError);
  });
});

describe('numeric clamping', () => {
  test('parseListLimit: default when omitted', () => {
    expect(parseListLimit(undefined)).toBe(PANE_INSPECTION_LIMITS.listLimitDefault);
    expect(parseListLimit(null)).toBe(PANE_INSPECTION_LIMITS.listLimitDefault);
  });

  test('parseListLimit: clamps at the max boundary', () => {
    expect(parseListLimit(PANE_INSPECTION_LIMITS.listLimitMax)).toBe(PANE_INSPECTION_LIMITS.listLimitMax);
    expect(parseListLimit(PANE_INSPECTION_LIMITS.listLimitMax + 1)).toBe(PANE_INSPECTION_LIMITS.listLimitMax);
    expect(parseListLimit(1_000_000)).toBe(PANE_INSPECTION_LIMITS.listLimitMax);
  });

  test('parseListLimit: rejects non-integers', () => {
    expect(() => parseListLimit(1.5)).toThrow(PaneInspectionError);
    expect(() => parseListLimit('not-a-number')).toThrow(PaneInspectionError);
    expect(() => parseListLimit(Number.NaN)).toThrow(PaneInspectionError);
  });

  test('parseListLimit: rejects below minimum', () => {
    expect(() => parseListLimit(0)).toThrow(PaneInspectionError);
    expect(() => parseListLimit(-5)).toThrow(PaneInspectionError);
  });

  test('parseReadOutputLimitBytes: default and max boundary', () => {
    expect(parseReadOutputLimitBytes(undefined)).toBe(PANE_INSPECTION_LIMITS.readOutputDefaultBytes);
    expect(parseReadOutputLimitBytes(PANE_INSPECTION_LIMITS.readOutputMaxBytes)).toBe(PANE_INSPECTION_LIMITS.readOutputMaxBytes);
    expect(parseReadOutputLimitBytes(PANE_INSPECTION_LIMITS.readOutputMaxBytes * 10)).toBe(PANE_INSPECTION_LIMITS.readOutputMaxBytes);
  });

  test('parseWaitTimeoutMs: default and max boundary', () => {
    expect(parseWaitTimeoutMs(undefined)).toBe(PANE_INSPECTION_LIMITS.waitTimeoutDefaultMs);
    expect(parseWaitTimeoutMs(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs)).toBe(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs);
    expect(parseWaitTimeoutMs(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs + 5_000)).toBe(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs);
  });

  test('parseClampedInt: generic clamp helper respects min/max/fallback', () => {
    expect(parseClampedInt(undefined, 'x', 7, 100)).toBe(7);
    expect(parseClampedInt(50, 'x', 7, 100)).toBe(50);
    expect(parseClampedInt(500, 'x', 7, 100)).toBe(100);
    expect(() => parseClampedInt(-1, 'x', 7, 100, 0)).toThrow(PaneInspectionError);
    expect(() => parseClampedInt(1.1, 'x', 7, 100)).toThrow(PaneInspectionError);
  });
});

describe('parseInspectPaneRequestV1', () => {
  test('accepts an explicit executionRef', () => {
    expect(parseInspectPaneRequestV1({ nodeId: 'n-1', executionRef: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' } })).toEqual({
      version: 1,
      locator: { nodeId: 'n-1' },
      executionRef: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' },
    });
  });

  test('rejects a request with no locator', () => {
    expect(() => parseInspectPaneRequestV1({})).toThrow(PaneInspectionError);
  });
});

describe('parseWaitPaneRequestV1', () => {
  test('until=changed requires cursor', () => {
    expect(() => parseWaitPaneRequestV1({ nodeId: 'n-1', until: 'changed' })).toThrow(PaneInspectionError);
    expect(parseWaitPaneRequestV1({ nodeId: 'n-1', until: 'changed', cursor: 'cur-1' })).toMatchObject({
      until: 'changed',
      cursor: 'cur-1',
    });
  });

  test('until=terminal requires executionRef', () => {
    expect(() => parseWaitPaneRequestV1({ nodeId: 'n-1', until: 'terminal' })).toThrow(PaneInspectionError);
    expect(
      parseWaitPaneRequestV1({ nodeId: 'n-1', until: 'terminal', executionRef: { kind: 'agent_run', runId: 'run-1' } }),
    ).toMatchObject({ until: 'terminal', executionRef: { kind: 'agent_run', runId: 'run-1' } });
  });

  test('clamps timeoutMs to the max boundary', () => {
    const parsed = parseWaitPaneRequestV1({
      nodeId: 'n-1',
      until: 'changed',
      cursor: 'cur-1',
      timeoutMs: PANE_INSPECTION_LIMITS.waitTimeoutMaxMs + 1_000,
    });
    expect(parsed.timeoutMs).toBe(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs);
  });
});

describe('Section<T> type-level contract', () => {
  test('ready variant needs no reason', () => {
    const ready: Section<number> = { status: 'ready', value: 1 };
    expect(ready.status).toBe('ready');
  });

  test('non-ready variants require a reason (type-level, compile-time enforced)', () => {
    const unknown: Section<number> = { status: 'unknown', reason: 'not yet computed' };
    expect(unknown).toMatchObject({ status: 'unknown' });

    // @ts-expect-error — non-ready Section variants must carry `reason`.
    const missingReason: Section<number> = { status: 'unknown' };
    expect(missingReason).toBeDefined();
  });
});
