import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { streamDigestGeneration, type GenerationRequest } from '../src/services/digestGenerator';
import type { ChatManager } from '../src/services/chatManager';
import type { NormalizedEvent } from '../src/services/chatEvents';

const request: GenerationRequest = {
  workspace: { name: 'Test', createdAt: 1 }, rootTitle: 'Topic',
  nodes: [{ nodeId: 's1', depth: 0, messages: [{ role: 'assistant', text: 'Source notes' }] }],
  customPrompt: 'Focus on decisions', previousContent: '# Previous digest',
};

function manager(events: NormalizedEvent[]) {
  let prompt = '';
  let followUps: boolean | undefined;
  const fake = {
    async newChat(...args: Parameters<ChatManager['newChat']>) { followUps = args[5]; return 'digest-session'; },
    async *sendMessage(_id: string, text: string) { prompt = text; yield* events; },
  };
  return { chatManager: fake as unknown as ChatManager, prompt: () => prompt, followUps: () => followUps };
}

describe('streamDigestGeneration', () => {
  it('streams activity but keeps thoughts out of the final document', async () => {
    const fake = manager([
      { kind: 'thought', text: 'Compare source notes' },
      { kind: 'tool_call', toolCallId: 'tool1', title: 'Read notes', status: 'in_progress' },
      { kind: 'plan', entries: [{ content: 'Synthesize conclusions', status: 'in_progress', priority: 'high' }] },
      { kind: 'chunk', text: 'Title: Internal title\n\n# Result\n\nSummary' },
      { kind: 'turn_end' },
    ]);
    const events = [];
    for await (const event of streamDigestGeneration(fake.chatManager, request)) events.push(event);
    assert.deepEqual(events, [
      { kind: 'status', text: 'Preparing digest...' },
      { kind: 'status', text: 'Generating digest...' },
      { kind: 'thought', text: 'Compare source notes' },
      { kind: 'status', text: 'Read notes (in_progress)' },
      { kind: 'status', text: 'Synthesize conclusions' },
      { kind: 'chunk', text: 'Title: Internal title\n\n# Result\n\nSummary' },
      { kind: 'done', finalMarkdown: '# Result\n\nSummary' },
    ]);
    assert.equal(fake.followUps(), false);
    assert.match(fake.prompt(), /Focus on decisions/);
    assert.match(fake.prompt(), /# Previous digest/);
  });

  it('propagates runtime errors instead of finishing with an empty digest', async () => {
    const fake = manager([{ kind: 'thought', text: 'Thinking' }, { kind: 'runtime_error', error: 'Runtime unavailable' }]);
    await assert.rejects(async () => {
      for await (const event of streamDigestGeneration(fake.chatManager, request)) assert.notEqual(event.kind, 'done');
    }, /Runtime unavailable/);
  });

  it('rejects a thought-only response with no final output', async () => {
    const fake = manager([{ kind: 'thought', text: 'Thinking' }, { kind: 'turn_end' }]);
    await assert.rejects(async () => {
      for await (const event of streamDigestGeneration(fake.chatManager, request)) assert.notEqual(event.kind, 'done');
    }, /returned no content/);
  });
});
