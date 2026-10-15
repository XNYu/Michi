import { beforeEach, expect, it, vi } from 'vitest';
import { parseChatCommand, nextQueuedBatch, executeComposerCommand } from './chatCommands';
import { executeChatCommand } from '../services/api/sessions';
import { compactChat } from '../services/api';
import type { PendingQueuedMessage } from './chatTypes';
vi.mock('../services/api/sessions', () => ({ executeChatCommand: vi.fn() }));
vi.mock('../services/api', () => ({ compactChat: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const queued = (value: string): PendingQueuedMessage => ({ id: value, value, mentions: [], attachments: [], queuedAt: 0 });

it('routes idle and queued Kiro commands through the same execution path and displays data', async () => {
  vi.mocked(executeChatCommand).mockResolvedValue({ success: true, data: { tokens: 123 } });
  const commands = ['context', 'tools', 'mcp', 'effort high', 'clear', 'unknown'];
  for (const text of commands) {
    const idle = parseChatCommand(`/${text}`, 'kiro')!;
    const batch = nextQueuedBatch([queued(`/${text}`), queued('ordinary message')], 'kiro');
    expect(batch.map((entry) => entry.value)).toEqual([`/${text}`]);
    expect(parseChatCommand(batch[0].value, 'kiro')).toEqual(idle);
    const result = await executeComposerCommand('node', idle);
    expect(result.message).toContain('123');
    expect(executeChatCommand).toHaveBeenLastCalledWith('node', idle.name, idle.value ? { value: idle.value } : undefined);
  }
});

it('preserves ordering between messages and command boundaries', () => {
  const queue = [queued('one'), queued('two'), queued('/clear'), queued('three')];
  expect(nextQueuedBatch(queue, 'kiro')).toEqual(queue.slice(0, 2));
  expect(nextQueuedBatch(queue.slice(2), 'kiro')).toEqual(queue.slice(2, 3));
  expect(parseChatCommand('/tmp/file', 'kiro')).toBeNull();
  expect(parseChatCommand('/tools\nexplain this', 'kiro')).toBeNull();
  expect(parseChatCommand('/branch topic', 'kiro')).toBeNull();
  expect(parseChatCommand('/tools', 'claude')).toBeNull();
});

it('compact stays runtime agnostic and unsupported commands return visible failures', async () => {
  vi.mocked(compactChat).mockResolvedValue({ started: true, detail: 'Completed' });
  expect(await executeComposerCommand('node', parseChatCommand('/compact keep decisions', 'codex')!)).toEqual({ success: true, message: 'Completed' });
  expect(compactChat).toHaveBeenCalledWith('node', 'keep decisions');
  vi.mocked(executeChatCommand).mockResolvedValue({ success: false, message: 'Unsupported by server' });
  expect((await executeComposerCommand('node', { name: 'unknown' })).message).toBe('Unsupported by server');
});
