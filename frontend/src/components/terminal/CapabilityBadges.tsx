import React from 'react';
import type { CapabilityDescriptor, CapabilityKey } from 'michi-shared';

const VISIBLE_SLOTS: Array<{ key: CapabilityKey; label: string }> = [
  { key: 'steer', label: 'steer' },
  { key: 'compact', label: 'compact' },
  { key: 'permissions', label: 'permissions' },
  { key: 'usage', label: 'usage' },
];

export function capabilityBadgeText(descriptor: CapabilityDescriptor | undefined): string[] {
  if (!descriptor) return [];
  return VISIBLE_SLOTS.flatMap(({ key, label }) => {
    const slot = descriptor[key];
    if (!slot || slot.availability === 'invisible') return [];
    return [`${label}:${slot.availability}`];
  });
}

export function CapabilityBadges({
  descriptor,
}: {
  descriptor: CapabilityDescriptor | undefined;
}) {
  const badges = capabilityBadgeText(descriptor);
  if (badges.length === 0) return null;
  return (
    <span data-testid="capability-badges" style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {badges.map((badge) => (
        <span
          key={badge}
          className="t-toolbar-chip"
          style={{ fontSize: 10, opacity: badge.includes('native_unwired') ? 0.7 : 1 }}
        >
          {badge}
        </span>
      ))}
    </span>
  );
}
