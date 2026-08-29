import React from 'react';
import { AgentRunEventType } from 'michi-shared';
import type { AgentRunEventV1 } from 'michi-shared';

function payloadText(event: AgentRunEventV1): string {
  if (typeof event.payload === 'string') return event.payload;
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return JSON.stringify(event.payload);
  for (const key of ['text', 'content', 'message', 'summary', 'detail', 'title', 'name']) {
    const value = event.payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return JSON.stringify(event.payload);
}

/** Lifecycle noise that a conversation reader does not need per-row. */
const HIDDEN = new Set<AgentRunEventType>([
  AgentRunEventType.RunStatusChanged,
  AgentRunEventType.AttemptStatusChanged,
  AgentRunEventType.Checkpoint,
  AgentRunEventType.Usage,
  AgentRunEventType.WatchMembershipUpdated,
  AgentRunEventType.WatchFired,
  AgentRunEventType.ParentDeliveryUpdated,
  AgentRunEventType.ResultBundleUpdated,
]);

const CHIP_LABEL: Partial<Record<AgentRunEventType, string>> = {
  [AgentRunEventType.ToolCall]: 'tool',
  [AgentRunEventType.ToolCallUpdate]: 'tool update',
  [AgentRunEventType.Plan]: 'plan',
  [AgentRunEventType.ContextRequested]: 'context requested',
  [AgentRunEventType.ContextSupplied]: 'context supplied',
  [AgentRunEventType.InteractionRequested]: 'needs you',
  [AgentRunEventType.InteractionResolved]: 'resolved',
  [AgentRunEventType.SteeringQueued]: 'queued input',
  [AgentRunEventType.SteeringApplied]: 'input applied',
  [AgentRunEventType.CancellationRequested]: 'cancel requested',
  [AgentRunEventType.CancellationAcknowledged]: 'cancel acknowledged',
  [AgentRunEventType.CancellationSettled]: 'cancelled',
};

/**
 * Renders Run events as conversation flow: assistant text reads as prose,
 * thoughts read muted, tool activity reads as the app's plain activity rows,
 * and runtime recovery surfaces as an inline mono system-event line.
 */
export function AgentRunTimeline({ events }: { events: readonly AgentRunEventV1[] }) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq).filter((event) => !HIDDEN.has(event.type));
  if (ordered.length === 0) return <div style={{ color: 'var(--term-muted)', fontSize: 11 }}>No activity yet.</div>;
  return (
    <ol aria-label="Run activity" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ordered.map((event) => {
        if (event.type === AgentRunEventType.Assistant) {
          return (
            <li key={event.seq} data-testid="run-transcript-entry"
              style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--term-fg)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '64ch' }}>
              {payloadText(event)}
            </li>
          );
        }
        if (event.type === AgentRunEventType.Thought) {
          return (
            <li key={event.seq} data-testid="run-transcript-entry"
              style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--term-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '64ch' }}>
              {payloadText(event)}
            </li>
          );
        }
        if (event.type === AgentRunEventType.RecoveryStarted) {
          // Runtime fallback is an inline system event, not a kv row.
          return (
            <li key={event.seq} style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--term-muted)' }}>
              <span aria-hidden style={{ color: 'var(--term-select)' }}>⚠</span>
              <span>{payloadText(event)}</span>
              <span style={{ color: 'var(--term-faint)' }}>· recovering</span>
            </li>
          );
        }
        const label = CHIP_LABEL[event.type] ?? event.type.replaceAll('_', ' ');
        return (
          <li key={event.seq} style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: 10.5, color: 'var(--term-muted)' }}>
            <span aria-hidden style={{ fontSize: 9, color: 'var(--term-faint)', width: 8, flexShrink: 0 }}>▸</span>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 9.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--term-faint)', marginRight: 7 }}>{label}</span>
              {payloadText(event)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
