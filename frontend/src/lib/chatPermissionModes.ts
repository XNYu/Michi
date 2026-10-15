import type { ChatPermissionMode } from 'michi-shared';

/** Legacy mode normalization. Crew's actual approval policy lives in its Gateway. */
const NO_YOLO_RUNTIME_IDS = new Set(['kiro', 'crew', 'pi']);

export function supportsChatYolo(runtimeId: string): boolean {
  return !NO_YOLO_RUNTIME_IDS.has(runtimeId);
}

/** Preserve saved choices; present legacy YOLO as its equivalent on this runtime. */
export function chatPermissionModeForRuntime(mode: ChatPermissionMode, runtimeId: string): ChatPermissionMode {
  return mode === 'yolo' && !supportsChatYolo(runtimeId) ? 'trust' : mode;
}
