import { describe, expect, it } from 'vitest';
import {
  decodeAgentRunPaneId,
  decodePaneId,
  encodeAgentRunPaneId,
  encodePaneId,
  parseExecutionRef,
  parseInspectPaneParamsV1,
  parseListLimit,
  parsePaneLocator,
  parseReadOutputLimitBytes,
  parseWaitPaneParamsV1,
  parseWaitTimeoutMs,
  PaneInspectionError,
  PaneInspectionErrorCode,
  PANE_INSPECTION_LIMITS,
  type PaneTarget,
  type Section,
} from 'michi-shared';

function expectInvalidArgument(fn: () => unknown): void {
  expect(fn).toThrow(PaneInspectionError);
  try {
    fn();
    throw new Error('expected fn to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(PaneInspectionError);
    expect((error as PaneInspectionError).code).toBe(PaneInspectionErrorCode.InvalidArgument);
  }
}

describe('paneId codec', () => {
  it('round-trips node: targets', () => {
    const target: PaneTarget = { kind: 'node', nodeId: 'n-abc123' };
    const encoded = encodePaneId(target);
    expect(encoded).toBe('node:n-abc123');
    expect(decodePaneId(encoded)).toEqual(target);
  });

  it('round-trips run: targets, including ids containing a colon and a slash', () => {
    const target: PaneTarget = { kind: 'agent_run', runId: 'run-xyz' };
    const encoded = encodePaneId(target);
    expect(encoded).toBe('run:run-xyz');
    expect(decodePaneId(encoded)).toEqual(target);

    // decodePaneId only recovers runId (backendConnectionId is discarded by design),
    // so round-trip decodePaneId(encodeAgentRunPaneId(...)) is exercised via runId only.
    const trickyRunId = 'run:with/slash:and:colons';
    const trickyConn = 'conn:1/weird:id';
    const encodedTricky = encodeAgentRunPaneId(trickyConn, trickyRunId);
    expect(encodedTricky.startsWith('run:')).toBe(true);
    expect(decodePaneId(encodedTricky)).toEqual({ kind: 'agent_run', runId: trickyRunId });
  });

  it('round-trips surface: targets', () => {
    const target: PaneTarget = { kind: 'surface', registrationId: 'reg-456' };
    const encoded = encodePaneId(target);
    expect(encoded).toBe('surface:reg-456');
    expect(decodePaneId(encoded)).toEqual(target);
  });

  it('encodePaneId(decodePaneId(s)) === s for every canonical PaneTarget encoding', () => {
    const samples = ['node:n-1', 'run:run-xyz', 'surface:reg-456'];
    for (const s of samples) {
      expect(encodePaneId(decodePaneId(s))).toBe(s);
    }
  });

  it('decodeAgentRunPaneId recovers both source segments, percent-decoded', () => {
    const encoded = encodeAgentRunPaneId('conn:1/weird:id', 'run/with:colon');
    const decoded = decodeAgentRunPaneId(encoded);
    expect(decoded).toEqual({ backendConnectionId: 'conn:1/weird:id', runId: 'run/with:colon' });
  });

  it('rejects an unknown prefix', () => {
    expectInvalidArgument(() => decodePaneId('pane:agent-run:conn-1:run-1'));
  });

  it('rejects a missing prefix', () => {
    expectInvalidArgument(() => decodePaneId('n-abc123'));
  });

  it('rejects an empty id segment for node:', () => {
    expectInvalidArgument(() => decodePaneId('node:'));
  });

  it('rejects an empty id segment for surface:', () => {
    expectInvalidArgument(() => decodePaneId('surface:'));
  });

  it('rejects an empty id segment for run:', () => {
    expectInvalidArgument(() => decodePaneId('run:'));
  });

  it('rejects the wrong segment count for run: (too many)', () => {
    expectInvalidArgument(() => decodePaneId('run:conn-1:run-1:extra'));
  });

  it('rejects leading whitespace', () => {
    expectInvalidArgument(() => decodePaneId(' node:n-1'));
  });

  it('rejects trailing whitespace', () => {
    expectInvalidArgument(() => decodePaneId('node:n-1 '));
  });

  it('rejects an empty string', () => {
    expectInvalidArgument(() => decodePaneId(''));
  });

  it('rejects a non-string input', () => {
    expectInvalidArgument(() => decodePaneId(42 as unknown as string));
  });
});

describe('parsePaneLocator', () => {
  it('accepts exactly one of paneId, nodeId, runId', () => {
    expect(parsePaneLocator({ paneId: 'node:n-1' })).toEqual({ paneId: 'node:n-1' });
    expect(parsePaneLocator({ nodeId: 'n-1' })).toEqual({ nodeId: 'n-1' });
    expect(parsePaneLocator({ runId: 'run-1' })).toEqual({ runId: 'run-1' });
  });

  it('rejects zero locators', () => {
    expectInvalidArgument(() => parsePaneLocator({}));
  });

  it('rejects two locators', () => {
    expectInvalidArgument(() => parsePaneLocator({ paneId: 'node:n-1', nodeId: 'n-1' }));
  });

  it('rejects three locators', () => {
    expectInvalidArgument(() => parsePaneLocator({ paneId: 'node:n-1', nodeId: 'n-1', runId: 'run-1' }));
  });
});

describe('parseExecutionRef', () => {
  it('parses chat_turn refs', () => {
    expect(parseExecutionRef({ kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' }))
      .toEqual({ kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' });
  });

  it('parses agent_run refs', () => {
    expect(parseExecutionRef({ kind: 'agent_run', runId: 'run-1' }))
      .toEqual({ kind: 'agent_run', runId: 'run-1' });
  });

  it('rejects an unknown kind', () => {
    expectInvalidArgument(() => parseExecutionRef({ kind: 'bogus' }));
  });

  it('rejects a chat_turn ref missing turnId', () => {
    expectInvalidArgument(() => parseExecutionRef({ kind: 'chat_turn', nodeId: 'n-1' }));
  });
});

describe('numeric clamping', () => {
  it('parseListLimit defaults, clamps at max, and rejects non-integers', () => {
    expect(parseListLimit(undefined)).toBe(PANE_INSPECTION_LIMITS.listDefaultLimit);
    expect(parseListLimit(PANE_INSPECTION_LIMITS.listMaxLimit)).toBe(PANE_INSPECTION_LIMITS.listMaxLimit);
    expect(parseListLimit(PANE_INSPECTION_LIMITS.listMaxLimit + 1000)).toBe(PANE_INSPECTION_LIMITS.listMaxLimit);
    expect(parseListLimit(0)).toBe(1);
    expectInvalidArgument(() => parseListLimit(1.5));
    expectInvalidArgument(() => parseListLimit('20'));
  });

  it('parseReadOutputLimitBytes defaults and clamps at max', () => {
    expect(parseReadOutputLimitBytes(undefined)).toBe(PANE_INSPECTION_LIMITS.readOutputDefaultBytes);
    expect(parseReadOutputLimitBytes(PANE_INSPECTION_LIMITS.readOutputMaxBytes)).toBe(PANE_INSPECTION_LIMITS.readOutputMaxBytes);
    expect(parseReadOutputLimitBytes(PANE_INSPECTION_LIMITS.readOutputMaxBytes * 10)).toBe(PANE_INSPECTION_LIMITS.readOutputMaxBytes);
  });

  it('parseWaitTimeoutMs defaults and clamps at max', () => {
    expect(parseWaitTimeoutMs(undefined)).toBe(PANE_INSPECTION_LIMITS.waitTimeoutDefaultMs);
    expect(parseWaitTimeoutMs(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs)).toBe(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs);
    expect(parseWaitTimeoutMs(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs * 100)).toBe(PANE_INSPECTION_LIMITS.waitTimeoutMaxMs);
  });
});

describe('parseInspectPaneParamsV1', () => {
  it('parses a locator with no executionRef', () => {
    expect(parseInspectPaneParamsV1({ nodeId: 'n-1' })).toEqual({ locator: { nodeId: 'n-1' } });
  });

  it('parses a locator with an executionRef', () => {
    expect(parseInspectPaneParamsV1({ nodeId: 'n-1', executionRef: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' } }))
      .toEqual({ locator: { nodeId: 'n-1' }, executionRef: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' } });
  });

  it('rejects an inconsistent locator', () => {
    expectInvalidArgument(() => parseInspectPaneParamsV1({}));
  });
});

describe('parseWaitPaneParamsV1', () => {
  it('requires a cursor when until is "changed"', () => {
    expectInvalidArgument(() => parseWaitPaneParamsV1({ nodeId: 'n-1', until: 'changed' }));
    expect(parseWaitPaneParamsV1({ nodeId: 'n-1', until: 'changed', cursor: 'cur-1' }).cursor).toBe('cur-1');
  });

  it('requires an executionRef when until is "terminal"', () => {
    expectInvalidArgument(() => parseWaitPaneParamsV1({ nodeId: 'n-1', until: 'terminal' }));
    const parsed = parseWaitPaneParamsV1({
      nodeId: 'n-1',
      until: 'terminal',
      executionRef: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' },
    });
    expect(parsed.executionRef).toEqual({ kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' });
  });

  it('rejects an unknown until value', () => {
    expectInvalidArgument(() => parseWaitPaneParamsV1({ nodeId: 'n-1', until: 'bogus' }));
  });
});

describe('Section<T> non-ready variants require a reason', () => {
  it('cannot be constructed without a reason', () => {
    // @ts-expect-error -- non-ready Section variants require `reason`
    const missingReason: Section<number> = { status: 'unknown' };
    void missingReason;
  });

  it('ready variants do not require a reason', () => {
    const ready: Section<number> = { status: 'ready', value: 1 };
    expect(ready.status).toBe('ready');
  });
});
