import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseSanitizedModel } from '../src/routes/agent';
import type { ModelInfo } from '../src/agents/types';

describe('chooseSanitizedModel', () => {
  const models: ModelInfo[] = [
    { id: 'claude-opus-5-5[1m]', isDefault: true },
    { id: 'claude-opus-5[1m]' },
    { id: 'claude-sonnet-5' },
  ];
  const aliases: Record<string, string> = { opus: 'claude-opus-5[1m]', haiku: 'claude-haiku-4-5' };
  const canonicalize = (id: string) => aliases[id] ?? id;

  test('maps a legacy alias onto the same model instead of the default', () => {
    assert.equal(chooseSanitizedModel(models, 'opus', canonicalize), 'claude-opus-5[1m]');
  });

  test('leaves the persisted id alone when the catalog is empty', () => {
    assert.equal(chooseSanitizedModel([], 'opus', canonicalize), null);
  });
});
