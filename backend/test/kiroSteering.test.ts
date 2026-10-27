import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contentFromIncomingMessage } from '../src/services/messageSerialization';

const id = 'steer-c3999cf6ce9f462cb72019fcc3fb5368';
const idV3 = 'steer-3fc25d3d-a0d5-469e-a60e-e063001188d2';
const marker = (text = 'Changed the recommendation to cobalt.', messageId = id) => `[STEERING ${messageId}: ${text}]`;

for (const ending of ['done', 'cancel', 'error', 'eof'] as const) {
}

test('legacy serialization removes metadata from answers but not user examples', () => {
  assert.equal(contentFromIncomingMessage({ role: 'assistant', blocks: [{ kind: 'answer', rawText: `Answer\n${marker()}` }] }).trim(), 'Answer');
  assert.equal(contentFromIncomingMessage({ role: 'user', content: marker() }), marker());
});
