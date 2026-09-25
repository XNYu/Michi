import { describe, expect, it } from 'vitest';
import { resolveReasoningOptions, sanitizeReasoningLevels } from 'michi-shared';

const runtime = { reasoning: true, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] as const };
const caps = { ...runtime, supportedReasoningLevels: [...runtime.supportedReasoningLevels] };

describe('reasoning capability resolution', () => {
  it('does not invent levels for unknown or empty capability lists', () => {
    expect(resolveReasoningOptions({ reasoning: true }).levels).toEqual([]);
    expect(resolveReasoningOptions({ reasoning: true, supportedReasoningLevels: [] }).adjustable).toBe(false);
    expect(resolveReasoningOptions(caps, { supportedReasoningLevels: [] }).levels).toEqual([]);
  });

  it('honors runtime, provider and model opt-outs', () => {
    expect(resolveReasoningOptions({ ...caps, reasoning: false }).levels).toEqual([]);
    expect(resolveReasoningOptions(caps, { supportsReasoning: false }).levels).toEqual([]);
    expect(resolveReasoningOptions(caps, { supportedReasoningLevels: ['low', 'high'] }, { supportsReasoning: false }).levels).toEqual([]);
  });

  it('uses model-specific levels and defaults instead of stale runtime values', () => {
    expect(resolveReasoningOptions(caps, { supportedReasoningLevels: ['low', 'high', 'max'], defaultReasoning: 'high' }, undefined, 'xhigh'))
      .toEqual({ levels: ['low', 'high', 'max'], value: 'high', adjustable: true });
    expect(resolveReasoningOptions(caps, { supportedReasoningLevels: ['low', 'high', 'max'], defaultReasoning: 'high' }, undefined, 'max').value).toBe('max');
  });

  it('falls back to advertised provider or runtime capabilities for older catalogs', () => {
    expect(resolveReasoningOptions(caps, {}, { supportedReasoningLevels: ['low', 'high'], defaultReasoning: 'high' }).value).toBe('high');
    expect(resolveReasoningOptions(caps, {}).levels).toEqual(caps.supportedReasoningLevels);
  });

  it('deduplicates valid levels without reordering or accepting unsupported identifiers', () => {
    expect(sanitizeReasoningLevels(['high', 'low', 'high', 'unknown', 5])).toEqual(['high', 'low']);
    expect(sanitizeReasoningLevels(undefined)).toBeUndefined();
  });
});
