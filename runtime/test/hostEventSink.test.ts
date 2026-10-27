import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedEvent } from '../src/contract/events';
import { hostEventSink } from '../src/core/hostEventSink';

describe('hostEventSink', () => {
  it('pushes each report as a host_event, in order, with its payload as reported', () => {
    const pushed: NormalizedEvent[] = [];
    const sink = hostEventSink((event) => pushed.push(event));
    const topics = [{ title: 'A', prompt: 'Explore A', chatId: 'child-1' }];
    sink.emit({ type: 'spawn_branches', payload: { topics } });
    sink.emit({ type: 'image', payload: { path: 'chart.png', caption: undefined, mimeType: 'image/png', size: 16 } });
    sink.emit({ type: 'falsy', payload: 0 });
    assert.deepEqual(pushed, [
      { kind: 'host_event', type: 'spawn_branches', payload: { topics } },
      { kind: 'host_event', type: 'image', payload: { path: 'chart.png', caption: undefined, mimeType: 'image/png', size: 16 } },
      { kind: 'host_event', type: 'falsy', payload: 0 },
    ]);
    assert.equal((pushed[0] as { payload: { topics: unknown } }).payload.topics, topics, 'the payload is not copied');
  });

  it('gives a report without a payload a null one', () => {
    const pushed: NormalizedEvent[] = [];
    const sink = hostEventSink((event) => pushed.push(event));
    sink.emit({ type: 'bare' });
    sink.emit({ type: 'explicit', payload: undefined });
    sink.emit({ type: 'null', payload: null });
    assert.deepEqual(pushed, [
      { kind: 'host_event', type: 'bare', payload: null },
      { kind: 'host_event', type: 'explicit', payload: null },
      { kind: 'host_event', type: 'null', payload: null },
    ]);
  });
});
