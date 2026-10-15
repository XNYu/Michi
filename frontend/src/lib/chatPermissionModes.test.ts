import { describe, expect, it } from 'vitest';
import { chatPermissionModeForRuntime, supportsChatYolo } from './chatPermissionModes';

describe('supportsChatYolo', () => {
  it('treats Kiro Crew like Kiro and Pi', () => {
    expect(supportsChatYolo('kiro')).toBe(false);
    expect(supportsChatYolo('crew')).toBe(false);
    expect(supportsChatYolo('pi')).toBe(false);
    expect(supportsChatYolo('claude')).toBe(true);
    expect(supportsChatYolo('codex')).toBe(true);
  });

  it('presents legacy YOLO as Trust on Kiro Crew', () => {
    expect(chatPermissionModeForRuntime('yolo', 'crew')).toBe('trust');
    expect(chatPermissionModeForRuntime('ask', 'crew')).toBe('ask');
    expect(chatPermissionModeForRuntime('yolo', 'claude')).toBe('yolo');
  });
});
