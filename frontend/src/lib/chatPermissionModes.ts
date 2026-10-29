import type { AgentStatus, ChatPermissionChoice, ChatPermissionMode } from 'michi-shared';

/** Legacy mode normalization. Crew's actual approval policy lives in its Gateway. */
const NO_YOLO_RUNTIME_IDS = new Set(['kiro', 'crew', 'pi']);

export function supportsChatYolo(runtimeId: string): boolean {
  return !NO_YOLO_RUNTIME_IDS.has(runtimeId);
}

/** Preserve saved choices; present legacy YOLO as its equivalent on this runtime. */
export function chatPermissionModeForRuntime(mode: ChatPermissionMode, runtimeId: string): ChatPermissionMode {
  return mode === 'yolo' && !supportsChatYolo(runtimeId) ? 'trust' : mode;
}

/** Runtimes whose Backend reports Approve for me (Kiro V3). */
export function approveForMeRuntimeIds(status: Pick<AgentStatus, 'availableRuntimes'> | null | undefined): string[] {
  return (status?.availableRuntimes ?? []).filter((runtime) => runtime.approveForMe === true).map((runtime) => runtime.id);
}

/**
 * The choice a chat shows and runs with on its runtime. Approve for me is
 * Ask with Kiro's classifier, so a runtime without it shows (and is) Ask.
 */
export function chatPermissionChoiceForRuntime(choice: ChatPermissionChoice, runtimeId: string, approveForMe: boolean): ChatPermissionChoice {
  if (choice === 'approve') return approveForMe ? 'approve' : 'ask';
  return chatPermissionModeForRuntime(choice, runtimeId);
}
