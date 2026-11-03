import { describe, expect, it } from 'vitest';
import { approveForMeRuntimeIds, chatPermissionChoiceForRuntime, chatPermissionModeForRuntime, supportsChatYolo } from './chatPermissionModes';
import { chatPermissionChoice, chatPermissionChoiceParts, isChatPermissionSettings } from 'michi-shared';

describe('supportsChatYolo', () => {
  it('treats Kiro Crew and Antigravity like Kiro and Pi', () => {
    expect(supportsChatYolo('kiro')).toBe(false);
    expect(supportsChatYolo('crew')).toBe(false);
    expect(supportsChatYolo('pi')).toBe(false);
    expect(supportsChatYolo('antigravity')).toBe(false);
    expect(supportsChatYolo('claude')).toBe(true);
    expect(supportsChatYolo('codex')).toBe(true);
  });

  it('presents legacy YOLO as Trust on Kiro Crew and Antigravity', () => {
    expect(chatPermissionModeForRuntime('yolo', 'crew')).toBe('trust');
    expect(chatPermissionModeForRuntime('ask', 'crew')).toBe('ask');
    expect(chatPermissionModeForRuntime('yolo', 'antigravity')).toBe('trust');
    expect(chatPermissionModeForRuntime('yolo', 'claude')).toBe('yolo');
  });
});

describe('Approve for me', () => {
  it('is offered only on runtimes whose Backend reports it', () => {
    expect(approveForMeRuntimeIds({ availableRuntimes: [
      { id: 'kiro', label: 'Kiro', available: true, approveForMe: true },
      { id: 'crew', label: 'Crew', available: true },
    ] })).toEqual(['kiro']);
    expect(approveForMeRuntimeIds(null)).toEqual([]);
  });

  it('runs as Ask where it is unsupported', () => {
    expect(chatPermissionChoiceForRuntime('approve', 'kiro', true)).toBe('approve');
    expect(chatPermissionChoiceForRuntime('approve', 'claude', false)).toBe('ask');
    expect(chatPermissionChoiceForRuntime('yolo', 'kiro', true)).toBe('trust');
  });

  it('is stored as Ask plus a flag, so older Backends read Ask', () => {
    expect(chatPermissionChoiceParts('approve')).toEqual({ mode: 'ask', approveForMe: true });
    expect(chatPermissionChoiceParts('trust')).toEqual({ mode: 'trust', approveForMe: false });
    expect(chatPermissionChoice('ask', true)).toBe('approve');
    expect(chatPermissionChoice('trust', true)).toBe('trust');
    expect(isChatPermissionSettings({ global: true, mode: 'ask' })).toBe(true);
    expect(isChatPermissionSettings({ global: true, mode: 'ask', approveForMe: true })).toBe(true);
    expect(isChatPermissionSettings({ global: true, mode: 'ask', approveForMe: 'yes' })).toBe(false);
  });
});
