export type ChatPermissionMode = 'ask' | 'trust' | 'yolo';

/**
 * What a person picks for a chat: a mode, or `approve`, which is Ask with the
 * runtime's own trust classifier approving what no rule settles (Kiro V3
 * "Approve for me"). Storage and the wire keep the mode (`ask`) and carry
 * `approveForMe` beside it, so an older Backend or client reads Ask.
 */
export type ChatPermissionChoice = ChatPermissionMode | 'approve';

export interface ChatPermissionSettings {
  global: boolean;
  mode: ChatPermissionMode;
  /** Approve for me on top of `mode: 'ask'`; ignored with any other mode. */
  approveForMe?: boolean;
}

export const DEFAULT_CHAT_PERMISSION_SETTINGS: ChatPermissionSettings = { global: false, mode: 'ask' };

export function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
  return value === 'ask' || value === 'trust' || value === 'yolo';
}

export function isChatPermissionChoice(value: unknown): value is ChatPermissionChoice {
  return value === 'approve' || isChatPermissionMode(value);
}

export function isChatPermissionSettings(value: unknown): value is ChatPermissionSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Record<string, unknown>;
  return typeof settings.global === 'boolean' && isChatPermissionMode(settings.mode)
    && (settings.approveForMe === undefined || typeof settings.approveForMe === 'boolean');
}

/** The choice a stored mode and Approve for me flag describe. */
export function chatPermissionChoice(mode: ChatPermissionMode, approveForMe?: boolean | null): ChatPermissionChoice {
  return mode === 'ask' && approveForMe === true ? 'approve' : mode;
}

/** The mode and flag a choice is stored as. */
export function chatPermissionChoiceParts(choice: ChatPermissionChoice): { mode: ChatPermissionMode; approveForMe: boolean } {
  return choice === 'approve' ? { mode: 'ask', approveForMe: true } : { mode: choice, approveForMe: false };
}
