import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import * as streamTransport from './streamTransport';
import { subscribeWorkflowRuns } from './workflowRuns';

function run(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'kiro', nativeId: 'wf', workspaceId: 'ws', nodeId: 'n1', parentToolCallId: null,
    name: 'probe', status: 'running', nodes: [], log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
    ...patch,
  };
}

function sseResponse(frames: Array<{ event: string; data: unknown }>): Response {
  const body = frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join('');
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe('subscribeWorkflowRuns', () => {
  it('hands runs and background-subagent updates to their callbacks', async () => {
    vi.spyOn(streamTransport, 'fetchStream').mockResolvedValueOnce(sseResponse([
      { event: 'background_subagents', data: { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot: true, nodes: { n1: ['bg-1', 'bg-1', 'bg-2'] } }, emittedAt: 1 } },
      { event: 'workflow_run', data: { version: 1, event: 'workflow_run', run: run(), emittedAt: 2 } },
      { event: 'heartbeat', data: { version: 1, event: 'heartbeat', run: null, emittedAt: 3 } },
      // Malformed: neither callback hears of it.
      { event: 'background_subagents', data: { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { nodes: {} }, emittedAt: 4 } },
      { event: 'background_subagents', data: { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot: false, nodes: { n1: [] } }, emittedAt: 5 } },
    ]));
    const onRun = vi.fn();
    const onBackgroundSubagents = vi.fn();
    const onDisconnect = vi.fn();
    subscribeWorkflowRuns('ws', { onRun, onBackgroundSubagents, onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls.map(([value]) => (value as WorkflowRunDtoV1).id)).toEqual(['wfr_1']);
    expect(onBackgroundSubagents.mock.calls.map(([update]) => update)).toEqual([
      { snapshot: true, nodes: { n1: ['bg-1', 'bg-2'] } },
      { snapshot: false, nodes: { n1: [] } },
    ]);
    // The stream ended on its own: a disconnect without an error.
    expect(onDisconnect).toHaveBeenCalledWith(undefined);
  });

  it('hands ended background subagents to their callback, validated', async () => {
    const ended = (backgroundSubagentsEnded: unknown) => ({
      event: 'background_subagents_ended',
      data: { version: 1, event: 'background_subagents_ended', run: null, backgroundSubagentsEnded, emittedAt: 1 },
    });
    vi.spyOn(streamTransport, 'fetchStream').mockResolvedValueOnce(sseResponse([
      ended({ nodeId: 'n1', subagents: [{ sessionId: 'bg-1', outcome: 'cancelled', endedAt: 9, error: 'gone', status: 'working' }] }),
      // Malformed: no valid end, no node.
      ended({ nodeId: 'n1', subagents: [{ sessionId: 'bg-2' }] }),
      ended({ subagents: [{ sessionId: 'bg-3', outcome: 'cancelled' }] }),
      { event: 'workflow_run', data: { version: 1, event: 'workflow_run', run: run(), emittedAt: 2 } },
    ]));
    const onRun = vi.fn();
    const onBackgroundSubagents = vi.fn();
    const onBackgroundSubagentsEnded = vi.fn();
    const onDisconnect = vi.fn();
    subscribeWorkflowRuns('ws', { onRun, onBackgroundSubagents, onBackgroundSubagentsEnded, onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onBackgroundSubagentsEnded.mock.calls.map(([value]) => value)).toEqual([
      { nodeId: 'n1', subagents: [{ sessionId: 'bg-1', outcome: 'cancelled', endedAt: 9, error: 'gone' }] },
    ]);
    expect(onBackgroundSubagents).not.toHaveBeenCalled();
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('ignores background-subagent updates when no callback wants them', async () => {
    vi.spyOn(streamTransport, 'fetchStream').mockResolvedValueOnce(sseResponse([
      { event: 'background_subagents', data: { version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot: true, nodes: {} }, emittedAt: 1 } },
      { event: 'background_subagents_ended', data: { version: 1, event: 'background_subagents_ended', run: null, backgroundSubagentsEnded: { nodeId: 'n1', subagents: [{ sessionId: 'bg-1', outcome: 'cancelled' }] }, emittedAt: 1 } },
      { event: 'workflow_run', data: { version: 1, event: 'workflow_run', run: run(), emittedAt: 2 } },
    ]));
    const onRun = vi.fn();
    const onDisconnect = vi.fn();
    subscribeWorkflowRuns('ws', { onRun, onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(undefined);
  });
});
