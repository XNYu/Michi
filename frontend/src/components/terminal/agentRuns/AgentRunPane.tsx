import React, { useMemo, useState } from 'react';
import { AgentRunStatus } from 'michi-shared';
import type {
  AgentRunAttemptDtoV1,
  AgentRunEventV1,
  AgentRunInputRequestV1,
  AgentRunInteractionDtoV1,
  JsonValue,
} from 'michi-shared';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import { AgentRunContextView } from './AgentRunContextView';
import { AgentRunInteractions } from './AgentRunInteractions';
import { AgentRunTimeline } from './AgentRunTimeline';
import { elapsedRunLabel, runIdentity, runtimeProfileLabel, type LocatedAgentRun } from './agentRunSelectors';
import { AgentRunActions } from './AgentRunActions';

const TERMINAL = new Set<AgentRunStatus>([AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled]);

const STATUS_COLOR: Partial<Record<AgentRunStatus, string>> = {
  [AgentRunStatus.Running]: 'var(--term-accent)',
  [AgentRunStatus.Waiting]: 'var(--term-select)',
  [AgentRunStatus.Recovering]: 'var(--term-mauve)',
  [AgentRunStatus.Failed]: 'var(--term-danger)',
  [AgentRunStatus.Cancelled]: 'var(--term-muted)',
  [AgentRunStatus.Completed]: 'var(--term-digest)',
};

export interface AgentRunPaneProps {
  run: LocatedAgentRun;
  attempts?: readonly AgentRunAttemptDtoV1[];
  events?: readonly AgentRunEventV1[];
  interactions?: readonly AgentRunInteractionDtoV1[];
  now?: number;
  onClose: (identity: AgentResourceIdentity) => void;
  onCancel?: (identity: AgentResourceIdentity) => void;
  onSendInput?: (identity: AgentResourceIdentity, request: AgentRunInputRequestV1) => void;
  onRespondInteraction?: (identity: AgentResourceIdentity, interaction: AgentRunInteractionDtoV1, response: JsonValue) => void;
  onOpenParent?: (identity: AgentResourceIdentity) => void;
}

/**
 * The Run Pane IS a conversation: a slim identity header (agent name →
 * metadata popover), the delegated task as the first message, the event
 * stream rendered as chat flow, interactions inline, and a queued-send
 * steering composer pinned at the bottom. Everything the old Overview /
 * Context / Attempts sections carried lives in the metadata popover.
 */
export function AgentRunPane({
  run: resource, attempts = [], events = [], interactions = [], now,
  onClose, onCancel, onSendInput, onRespondInteraction, onOpenParent,
}: AgentRunPaneProps) {
  const run = resource.value;
  const identity = runIdentity(resource);
  const [input, setInput] = useState('');
  const [metaOpen, setMetaOpen] = useState(false);
  const activeAttempt = attempts.find((attempt) => attempt.id === run.activeAttemptId) ?? attempts.at(-1);
  const terminal = TERMINAL.has(run.status);
  const submit = (mode: AgentRunInputRequestV1['mode']) => {
    const text = input.trim();
    if (!text || !onSendInput) return;
    onSendInput(identity, { version: 1, text, mode, expectedAttemptId: run.activeAttemptId });
    setInput('');
  };
  const result = run.resultBundle;
  const attemptRows = useMemo(() => [...attempts].sort((a, b) => a.attemptIndex - b.attemptIndex), [attempts]);
  const fallbacks = attemptRows.length > 1 ? attemptRows.length - 1 : 0;
  const statusColor = STATUS_COLOR[run.status] ?? 'var(--term-muted)';
  return (
    <section data-testid="agent-run-pane" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', background: 'var(--term-bg)', color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', position: 'relative' }}>
      {/* Boxless identity header: plain text + status dot, no chips. */}
      <header style={{ height: 36, display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--term-line)', padding: '0 12px', background: 'var(--term-surface)', flexShrink: 0 }}>
        <button type="button" aria-label="Agent metadata" aria-expanded={metaOpen} onClick={() => setMetaOpen((open) => !open)}
          style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', color: 'var(--term-fg)', fontSize: 13, fontWeight: 650, borderBottom: '1px dotted var(--term-line-s)' }}>
          {run.effectiveDefinition.name}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono-font)', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: statusColor, fontWeight: 600 }}>
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: 99, background: statusColor }} />
          {run.status} · {elapsedRunLabel(run, now)}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10.5, color: 'var(--term-muted)' }}>{runtimeProfileLabel(run)}</span>
        {onCancel && !terminal && (
          <button type="button" onClick={() => onCancel(identity)}
            style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--term-mid)', fontSize: 11.5, cursor: 'pointer' }}>Cancel Run</button>
        )}
        <button type="button" aria-label="Close Run Pane" onClick={() => onClose(identity)}
          style={{ border: 0, background: 'transparent', color: 'var(--term-muted)', cursor: 'pointer', fontSize: 14 }}>×</button>
      </header>

      {/* Metadata popover — everything the old kv sections carried. */}
      {metaOpen && (
        <div data-testid="run-metadata-popover" style={{ position: 'absolute', left: 14, top: 36, width: 340, zIndex: 6, background: 'var(--term-surface)', border: '1px solid var(--term-line-s)', boxShadow: 'var(--term-float-shadow, 0 12px 34px rgba(0,0,0,.14))' }}>
          <div style={{ padding: '7px 12px 6px', borderBottom: '1px solid var(--term-line)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono-font)', fontSize: 9.5, fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--term-faint)' }}>Agent metadata</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--term-faint)' }}>run {run.id.slice(0, 8)}</span>
          </div>
          <dl style={{ margin: 0, padding: '5px 0', fontSize: 11.5 }}>
            <MetaRow label="definition" value={run.definitionId ? `snapshotted at spawn · r${run.definitionRevision}` : 'ephemeral snapshot'} />
            <MetaRow label="runtime" value={runtimeProfileLabel(run)} />
            {fallbacks > 0 && <MetaRow label="fallback" value={`${fallbacks} fallback${fallbacks === 1 ? '' : 's'} · now ${activeAttempt ? [activeAttempt.runtimeProfile.runtimeId, activeAttempt.runtimeProfile.modelId].filter(Boolean).join(' · ') : '—'}`} />}
            <MetaRow label="environment" value={run.executionEnvironment.kind.replace('_', ' ')} />
            <MetaRow label="permissions" value={`${run.effectiveDefinition.permissionPolicy.preset} preset`} />
            {run.waitingReason && <MetaRow label="waiting on" value={run.waitingReason} tone="var(--term-select)" />}
            <MetaRow label="completion" value={run.completionMode} />
          </dl>
          <details style={{ borderTop: '1px solid var(--term-line)', padding: '6px 12px' }}>
            <summary style={{ cursor: 'pointer', fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--term-muted)' }}>
              context · {run.contextManifest.entries.length} items · immutable
            </summary>
            <div style={{ paddingTop: 6 }}><AgentRunContextView manifest={run.contextManifest} /></div>
          </details>
          {onOpenParent && (run.parentRunId || run.parentNodeId) && (
            <div style={{ borderTop: '1px solid var(--term-line)', padding: '6px 12px' }}>
              <button type="button" onClick={() => onOpenParent(identity)} style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--term-accent)', fontSize: 11, cursor: 'pointer' }}>↰ Open parent</button>
            </div>
          )}
        </div>
      )}

      {/* Conversation body: task bubble → event flow → interactions → result. */}
      <div style={{ overflowY: 'auto', padding: '16px 16px 0', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div data-testid="run-task" style={{
            maxWidth: '84%', padding: '10px 14px 11px',
            background: 'color-mix(in srgb, var(--term-accent) 4%, var(--term-surface))',
            borderRight: '2px solid var(--term-accent)',
            boxShadow: '0 1px 2px rgba(0,0,0,.03)',
          }}>
            <span style={{ display: 'block', fontFamily: 'var(--mono-font)', fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: 4, color: 'var(--term-accent)', fontWeight: 500, lineHeight: 1 }}>
              $ delegated
            </span>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{run.task}</div>
          </div>
        </div>

        <AgentRunTimeline events={events} />

        {/* Failed attempts surface as inline system events — the fallback
            story ("rate limited → switched") belongs in the flow. */}
        {attemptRows.filter((attempt) => attempt.error).map((attempt) => {
          const next = attemptRows.find((candidate) => candidate.attemptIndex === attempt.attemptIndex + 1);
          const nextLabel = next ? [next.runtimeProfile.runtimeId, next.runtimeProfile.modelId].filter(Boolean).join(' · ') : null;
          return (
            <div key={attempt.id} data-testid="run-attempt-fallback" style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--term-muted)' }}>
              <span aria-hidden style={{ color: 'var(--term-select)' }}>⚠</span>
              <span>{attempt.error?.message}</span>
              {nextLabel && <span style={{ color: 'var(--term-faint)' }}>→ switched to {nextLabel}</span>}
            </div>
          );
        })}

        <AgentRunInteractions interactions={interactions}
          onRespond={onRespondInteraction ? (interaction, response) => onRespondInteraction(identity, interaction, response) : undefined} />

        {result && (
          <div data-testid="run-result" style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)', padding: 10, display: 'grid', gap: 8, fontSize: 11 }}>
            {result.source === 'inferred' && <span style={{ color: 'var(--term-select)' }}>Inferred from final output</span>}
            <strong>{result.handoff.conclusion}</strong>
            <div>{result.handoff.artifactsOrChanges}</div>
            {result.handoff.unresolvedIssues && <div style={{ color: 'var(--term-select)' }}>Unresolved: {result.handoff.unresolvedIssues}</div>}
            {result.changeSet && (
              <div style={{ border: '1px solid var(--term-line)', padding: 9 }}>
                <div style={{ fontWeight: 600 }}>Change Set · {result.changeSet.changedFiles.length} files</div>
                <div style={{ color: 'var(--term-muted)', marginTop: 3 }}>{result.changeSet.summary}</div>
                <div style={{ color: 'var(--term-faint)', marginTop: 3 }}>Base {result.changeSet.baseCommit} · changes have not been merged automatically</div>
              </div>
            )}
          </div>
        )}
        {terminal && <AgentRunActions run={resource} events={events} />}
        <div style={{ flexShrink: 0, height: 2 }} />
      </div>

      {/* Steering composer — sending during a run is queued-send semantics. */}
      {!terminal && (
        <footer style={{ flexShrink: 0, padding: '10px 14px 12px' }}>
          <div style={{ border: 'var(--term-composer-border, 1px solid var(--term-line))', background: 'var(--term-composer-bg, var(--term-surface))', boxShadow: 'var(--term-composer-shadow-muted, none)' }}>
            <textarea aria-label="Steer Agent Run" value={input} onChange={(event) => setInput(event.target.value)}
              placeholder={`Message ${run.effectiveDefinition.name}…`}
              style={{ width: '100%', minHeight: 44, boxSizing: 'border-box', resize: 'vertical', border: 0, outline: 'none', background: 'transparent', color: 'var(--term-fg)', padding: '9px 11px 0', fontFamily: 'var(--ui-font)', fontSize: 12 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px 9px' }}>
              <button type="button" aria-label="Queue input" onClick={() => submit('queued')} disabled={!input.trim()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 9px', border: '1px solid var(--term-line)', background: 'var(--term-alt)', color: 'var(--term-fg)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--term-muted)', fontWeight: 400 }}>⏎</span>Queue input
              </button>
              <button type="button" aria-label="Stop & redirect" onClick={() => submit('immediate')} disabled={!input.trim() || !activeAttempt}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 9px', border: '1px solid var(--term-line)', background: 'var(--term-surface)', color: 'var(--term-mid)', fontSize: 11, cursor: 'pointer' }}>
                <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--term-faint)' }}>⌥⏎</span>Stop &amp; redirect
              </button>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10.5, color: 'var(--term-muted)' }}>Enter never cancels active work.</span>
            </div>
          </div>
        </footer>
      )}
    </section>
  );
}

function MetaRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '4px 12px' }}>
      <dt style={{ width: 84, flexShrink: 0, fontFamily: 'var(--mono-font)', fontSize: 10, color: tone ?? 'var(--term-faint)', margin: 0 }}>{label}</dt>
      <dd style={{ flex: 1, minWidth: 0, margin: 0, lineHeight: 1.45, color: 'var(--term-fg)' }}>{value}</dd>
    </div>
  );
}
