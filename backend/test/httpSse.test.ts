import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseObserver, writeSseFrame } from '../src/services/httpSse';

class Response extends EventEmitter {
  writableEnded = false; destroyed = false; writableLength = 0; writes: string[] = []; destroys = 0;
  write(frame: string): void { this.writes.push(frame); }
  destroy(): void { this.destroyed = true; this.destroys++; }
}

test('writer guards closed, throwing and post-write overflowing responses', () => {
  const closed = new Response(); closed.destroyed = true; assert.equal(writeSseFrame(closed, 'frame'), false); assert.deepEqual(closed.writes, []);
  const throwing = new Response(); throwing.write = () => { throw new Error('broken peer'); }; assert.doesNotThrow(() => assert.equal(writeSseFrame(throwing, 'frame'), false)); assert.equal(throwing.destroyed, true);
  const growing = new Response(); growing.write = () => { growing.writableLength = 1_048_577; }; assert.equal(writeSseFrame(growing, 'frame'), false); assert.equal(growing.destroyed, true);
  const normal = new Response(); assert.equal(writeSseFrame(normal, 'frame'), true); assert.deepEqual(normal.writes, ['frame']);
});

test('observer disconnect/error/overflow releases subscriptions and heartbeat exactly once', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const mode of ['close', 'error', 'overflow']) {
    const response = new Response(); const observer = createSseObserver(response); let detaches = 0;
    observer.addCleanup(() => { detaches++; }); observer.heartbeat(': heartbeat\n\n', 10);
    t.mock.timers.tick(10); assert.equal(response.writes.length, 1);
    if (mode === 'overflow') { response.writableLength = 1_048_577; observer.write('frame'); }
    else response.emit(mode);
    observer.close(); observer.addCleanup(() => { detaches++; });
    t.mock.timers.tick(50); assert.equal(response.writes.length, 1); assert.equal(detaches, 2); assert.equal(observer.closed, true);
  }
});
