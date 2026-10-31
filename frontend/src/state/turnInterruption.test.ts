import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './chatTypes';
import { buildResumePrompt } from './turnInterruption';

const user = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'user', text, toolCalls: [], ...extra });
const assistant = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', text, toolCalls: [], ...extra });

describe('buildResumePrompt', () => {
  it('restores the interrupted request, its partial output and its tool calls, then asks for a continuation', () => {
    const prompt = buildResumePrompt([
      user('u0', 'Earlier request'),
      assistant('a0', 'Earlier answer'),
      user('u1', 'Sync the composer with the keyboard'),
      assistant('a1', 'Starting with the morph helper.', {
        toolCalls: [
          { id: 't1', title: 'Read file', status: 'completed', inputJson: '{"path":"composerMorph.ts"}' },
          { id: 't2', title: 'Run command', status: 'in_progress', inputJson: '{"command":"git stash push -q -- frontend/src"}' },
        ],
      }),
    ])!;
    expect(prompt.displayText).toBe('Resume the interrupted turn');
    expect(prompt.text).toContain('[INTERRUPTED TURN — context restore]');
    expect(prompt.text).toContain('Interrupted request:\nSync the composer with the keyboard');
    expect(prompt.text).not.toContain('Earlier request');
    expect(prompt.text).toContain('Partial response before the interruption:\nStarting with the morph helper.');
    expect(prompt.text).toContain('- Read file [completed]: {"path":"composerMorph.ts"}');
    expect(prompt.text).toContain('- Run command [in_progress]: {"command":"git stash push -q -- frontend/src"}');
    expect(prompt.text).toContain('[END INTERRUPTED TURN]');
    expect(prompt.text).toMatch(/Do NOT re-run steps or tools that already completed successfully/);
    expect(prompt.text.indexOf('[END INTERRUPTED TURN]')).toBeLessThan(prompt.text.indexOf('The user pressed Resume'));
  });

  it('walks past mid-turn steering to the request and carries the steer in order', () => {
    const prompt = buildResumePrompt([
      user('u1', 'Refactor the drawer'),
      assistant('a1', 'Looking at the drawer.'),
      user('s1', 'Keep the swipe gesture', { steered: true }),
      assistant('a2', 'Keeping the gesture.'),
    ])!;
    expect(prompt.text).toContain('Interrupted request:\nRefactor the drawer');
    expect(prompt.text).toContain('Looking at the drawer.\n[Steered mid-turn] Keep the swipe gesture\nKeeping the gesture.');
  });

  it('omits sections that have nothing to say and bounds long content', () => {
    const bare = buildResumePrompt([user('u1', 'Just start'), assistant('a1', '')])!;
    expect(bare.text).not.toContain('Partial response');
    expect(bare.text).not.toContain('Tool calls recorded');

    const many = buildResumePrompt([
      user('u1', 'x'.repeat(9_000)),
      assistant('a1', 'y'.repeat(5_000), {
        toolCalls: Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, title: `Tool ${i}`, status: 'completed' })),
      }),
    ])!;
    expect(many.text).toContain(`${'x'.repeat(8_000)}… [truncated]`);
    expect(many.text).toContain(`${'y'.repeat(4_000)}… [truncated]`);
    expect(many.text).toContain('- … 3 earlier tool calls omitted');
    expect(many.text).not.toContain('- Tool 2 [');
    expect(many.text).toContain('- Tool 3 [completed]');
    expect(many.text).toContain('- Tool 14 [completed]');
  });

  it('has nothing to resume without a user request', () => {
    expect(buildResumePrompt([])).toBeNull();
    expect(buildResumePrompt([assistant('a1', 'orphan')])).toBeNull();
    expect(buildResumePrompt([user('u1', '   ')])).toBeNull();
  });
});
