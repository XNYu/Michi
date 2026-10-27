import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeSseFrame } from '../src/services/httpSse';

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
});
