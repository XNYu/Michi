export type CapabilityAvailability =
  | 'native'
  | 'native_unwired'
  | 'michi_simulated'
  | 'inferred'
  | 'invisible'
  | 'experimental';

export type EventConfidence = 'native' | 'projected' | 'unknown' | 'unverifiable';

export type EventSource = 'native' | 'michi_simulated' | 'inferred' | 'unknown';

export type CancelPhase = 'requested' | 'acknowledged' | 'settled';

export type PermissionSource =
  | 'michi_policy'
  | 'codex_approval'
  | 'claude_prompt_tool'
  | 'acp_permission';

export interface CapabilitySlot {
  availability: CapabilityAvailability;
  confidence: EventConfidence;
  notes?: string;
}

export const CAPABILITY_KEYS = [
  'steer',
  'followUp',
  'interruptAck',
  'compact',
  'retry',
  'sessionFork',
  'nativeResume',
  'permissions',
  'sandbox',
  'subagents',
  'usage',
] as const;

export type CapabilityKey = typeof CAPABILITY_KEYS[number];

export type CapabilityDescriptor = {
  [K in CapabilityKey]: CapabilitySlot;
};

export function slot(
  availability: CapabilityAvailability,
  confidence: EventConfidence = availability === 'native' ? 'native' : 'unknown',
  notes?: string,
): CapabilitySlot {
  return notes ? { availability, confidence, notes } : { availability, confidence };
}

export function invisibleSlot(notes?: string): CapabilitySlot {
  return slot('invisible', 'unverifiable', notes);
}

export function isNativeCapability(value: CapabilitySlot | undefined): boolean {
  return value?.availability === 'native';
}

export function shouldSteerInsteadOfQueue(descriptor: CapabilityDescriptor | undefined): boolean {
  return isNativeCapability(descriptor?.steer);
}

export function permissionSourceLabel(source?: string): string {
  switch (source) {
    case 'michi_policy':
      return 'Michi policy';
    case 'codex_approval':
      return 'Codex approval';
    case 'claude_prompt_tool':
      return 'Claude permission';
    case 'acp_permission':
      return 'ACP permission';
    default:
      return 'Permission';
  }
}

export function usageIsUnverifiable(
  source: EventConfidence | EventSource | undefined,
  credits: number | undefined,
): boolean {
  if (source === 'unverifiable' || source === 'unknown') return true;
  if (source === 'native') return false;
  return credits === 0 || credits === undefined;
}
