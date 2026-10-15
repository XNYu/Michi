export type ChatPermissionMode = 'ask' | 'trust' | 'yolo';

export interface ChatPermissionSettings {
  global: boolean;
  mode: ChatPermissionMode;
}

export const DEFAULT_CHAT_PERMISSION_SETTINGS: ChatPermissionSettings = { global: false, mode: 'ask' };

export function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
  return value === 'ask' || value === 'trust' || value === 'yolo';
}

export function isChatPermissionSettings(value: unknown): value is ChatPermissionSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Record<string, unknown>;
  return typeof settings.global === 'boolean' && isChatPermissionMode(settings.mode);
}
