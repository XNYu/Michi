import { describe, expect, it } from 'vitest';
import { capabilityBadgeText } from './CapabilityBadges';
import { shouldSteerInsteadOfQueue, invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';

const claude: CapabilityDescriptor = {
  steer: invisibleSlot('stream-json'),
  followUp: invisibleSlot(),
  interruptAck: slot('inferred'),
  compact: invisibleSlot(),
  retry: invisibleSlot(),
  sessionFork: slot('michi_simulated', 'projected'),
  nativeResume: slot('native'),
  permissions: slot('native'),
  sandbox: invisibleSlot(),
  subagents: slot('inferred', 'projected'),
  usage: invisibleSlot(),
};

const antigravity: CapabilityDescriptor = {
  ...claude,
  permissions: invisibleSlot(),
  nativeResume: slot('native'),
};

const codex: CapabilityDescriptor = {
  ...claude,
  steer: slot('native'),
  compact: slot('native'),
  permissions: slot('native'),
  usage: slot('native'),
};

describe('capability badges', () => {
  it('hides invisible slots so Claude/Antigravity do not look supported', () => {
    expect(capabilityBadgeText(claude).some((b) => b.startsWith('steer:'))).toBe(false);
    expect(capabilityBadgeText(antigravity)).toEqual([]);
    expect(shouldSteerInsteadOfQueue(claude)).toBe(false);
  });

  it('shows native Codex steer/compact', () => {
    expect(capabilityBadgeText(codex)).toContain('steer:native');
    expect(capabilityBadgeText(codex)).toContain('compact:native');
    expect(shouldSteerInsteadOfQueue(codex)).toBe(true);
  });
});
