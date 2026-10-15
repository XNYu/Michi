import type { ChatPermissionMode } from 'michi-shared';

/** Kiro and Pi have no separate full-access mode beyond Trust. */
export function supportsChatYolo(runtimeId: string): boolean {
  return runtimeId !== 'kiro' && runtimeId !== 'pi';
}

/** Preserve saved choices; present legacy YOLO as its equivalent on this runtime. */
export function chatPermissionModeForRuntime(mode: ChatPermissionMode, runtimeId: string): ChatPermissionMode {
  return mode === 'yolo' && !supportsChatYolo(runtimeId) ? 'trust' : mode;
}
