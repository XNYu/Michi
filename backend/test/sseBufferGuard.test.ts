import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeSseFrame } from '../src/routes/michi';

class FakeSseResponse {
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  writes: string[] = [];
  destroyError: Error | undefined;

  write(frame: string): void {
    this.writes.push(frame);
  }

  destroy(error?: Error): void {
    this.destroyed = true;
    this.destroyError = error;
  }
}

describe('writeSseFrame', () => {
  test('disconnects an over-buffered response without throwing to the central turn', () => {
    const response = new FakeSseResponse();
    response.writableLength = 1_048_577;

    assert.doesNotThrow(() => {
      assert.equal(writeSseFrame(response, 'event: chunk\\n\\n'), false);
    });
    assert.equal(response.destroyed, true);
    assert.match(response.destroyError?.message ?? '', /buffer limit/i);
  });

  test('writes frames while the response remains below the slow-client limit', () => {
    const response = new FakeSseResponse();
    response.writableLength = 1_048_576;

    assert.equal(writeSseFrame(response, ': keepalive\\n\\n'), true);
    assert.deepEqual(response.writes, [': keepalive\\n\\n']);
    assert.equal(response.destroyed, false);
  });
});
