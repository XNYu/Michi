import React, { useEffect, useState } from 'react';
import { ModalShell } from './ui/ModalShell';
import { Button } from './ui/controls';
import { useChatStore } from '../state/chatStore';
import { usePrefs } from '../state/prefs';
import { saveAgentOptions } from '../services/api';
import { useAgentModelCatalog } from '../hooks/useAgentModelCatalog';
import { filterVisibleRuntimes } from '../lib/runtimeVisibility';

/** First-run setup reflects an explicit runtime choice. Existing workspaces skip it. */
type ChipKind = 'ready' | 'setup' | 'na';
function StateChip({ kind, children }: { kind: ChipKind; children: React.ReactNode }) {
  const palette: Record<ChipKind, { color: string; bg: string }> = {
    ready: { color: 'var(--term-digest)', bg: 'var(--term-digest-f)' },
    setup: { color: 'var(--term-select)', bg: 'var(--term-select-f)' },
    na: { color: 'var(--term-muted)', bg: 'var(--term-alt)' },
  };
  const { color, bg } = palette[kind];
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-xs)',
        letterSpacing: 'var(--ls-caps)',
        textTransform: 'uppercase',
        padding: '2px 7px',
        color,
        background: bg,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }}
      />
      {children}
    </span>
  );
}

export default function FirstRunSetup() {
  const { agentStatus, refreshAgentStatus, projects, hydrated } = useChatStore();
  const { prefs, setPref } = usePrefs();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedRuntime, setRequestedRuntime] = useState<string | null>(null);

  const status = agentStatus;
  const completed = prefs.onboardingCompletedAt != null;
  const runtimes = filterVisibleRuntimes(status?.availableRuntimes ?? []);
  const activeRuntime = runtimes.find((r) => r.id === status?.runtime);
  const hasModelPicker = status?.capabilities.models === true;
  const needsKey = !!status && status.capabilities.apiKeys && !status.hasRequiredKey;

  // Hooks must run every render — gate via `enabled`, not early return.
  const modelCatalog = useAgentModelCatalog({
    enabled: !!activeRuntime && hasModelPicker && !needsKey && !completed,
    runtime: status?.runtime ?? null,
    provider: status?.provider ?? null,
  });

  // Existing users skip onboarding permanently (any workspace ⇒ already set up).
  useEffect(() => {
    if (!hydrated || completed) return;
    if (projects.length > 0) setPref('onboardingCompletedAt', Date.now());
  }, [hydrated, completed, projects.length, setPref]);

  useEffect(() => {
    if (requestedRuntime === status?.runtime) setRequestedRuntime(null);
  }, [requestedRuntime, status?.runtime]);

  const open = hydrated && !completed && projects.length === 0 && !!status;
  // Closed, the shell stays mounted: it fades out what it last showed and
  // hands the scrim to the next first-run window (key, then New workspace).
  if (!open || !status) return <ModalShell open={false} onClose={() => {}}>{null}</ModalShell>;

  const activeLabel = activeRuntime?.label ?? 'runtime';
  const waitingForStatus = requestedRuntime !== null && requestedRuntime !== status.runtime;
  const canContinue = !!activeRuntime && !saving && !waitingForStatus;

  // Mark onboarding done. If the chosen runtime still needs a key, the reload
  // wakes the (now un-gated) ApiKeyGate, which surfaces the unified key window.
  const complete = () => {
    if (!canContinue) return;
    setPref('onboardingCompletedAt', Date.now());
    refreshAgentStatus();
  };

  const selectRuntime = async (id: string) => {
    if (id === status.runtime || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveAgentOptions({ runtime: id });
      if (!result.ok) throw new Error(result.error);
      setRequestedRuntime(id);
      refreshAgentStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to select runtime. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const primaryLabel = !activeRuntime ? 'Choose a runtime' : needsKey ? `Set up ${activeLabel} key →` : `Start with ${activeLabel} →`;

  return (
    <ModalShell open dismissible={canContinue} onClose={complete} title="Setup" titleGlyph="◆" width={480}>
      <div
        className="term-scrollbar"
        style={{ padding: '18px 18px 20px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}
      >
        <div>
          <div style={{ fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-3xl)', fontWeight: 700, color: 'var(--term-fg)' }}>
            Welcome to Michi
          </div>
          <div style={{ fontSize: 'var(--fs-lg)', color: 'var(--term-muted)', lineHeight: 1.55, marginTop: 5 }}>
            Choose a runtime to get started. You can change it later in Settings.
          </div>
        </div>

        {/* Runtime — directly pickable, no disclosure. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={FIELD_LABEL}>Runtime</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {runtimes.map((r) => {
              const selected = r.id === status.runtime;
              const disabled = r.available === false;
              const rowNeedsKey = !!r.requiresApiKey;
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={disabled || saving}
                  onClick={() => void selectRuntime(r.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    textAlign: 'left',
                    fontFamily: 'var(--ui-font)',
                    border: selected ? '1px solid var(--term-accent)' : '1px solid var(--term-line)',
                    background: selected
                      ? 'color-mix(in srgb, var(--term-accent) 6%, var(--term-surface))'
                      : 'transparent',
                    padding: '11px 13px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.6 : 1,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 15,
                      height: 15,
                      borderRadius: '50%',
                      flexShrink: 0,
                      border: `2px solid ${selected ? 'var(--term-accent)' : 'var(--term-line-s)'}`,
                      background: selected ? 'var(--term-accent)' : 'transparent',
                      boxShadow: selected ? 'inset 0 0 0 2.5px var(--term-surface)' : 'none',
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 'var(--fs-xl)',
                        fontWeight: 500,
                        color: 'var(--term-fg)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      {r.label}
                    </span>
                    <span style={{ fontSize: 'var(--fs-md)', color: 'var(--term-muted)', marginTop: 2, display: 'block' }}>
                      {disabled
                        ? (r.unavailableReason ?? 'Not available on this machine')
                        : rowNeedsKey
                          ? 'Bring your own provider (OpenAI, Anthropic…)'
                          : 'Uses your CLI sign-in'}
                    </span>
                  </span>
                  <StateChip kind={disabled ? 'na' : rowNeedsKey ? 'setup' : 'ready'}>
                    {disabled ? 'unavailable' : rowNeedsKey ? 'needs API key' : 'ready'}
                  </StateChip>
                </button>
              );
            })}
          </div>
        </div>

        {runtimes.length === 0 && (
          <div role="status">
            No runtimes are available yet. Configure a supported runtime, then refresh.
            <Button onClick={refreshAgentStatus}>Refresh runtimes</Button>
          </div>
        )}
        {waitingForStatus && <Button onClick={refreshAgentStatus}>Refresh selection</Button>}
        {error && <div role="alert" style={{ color: 'var(--term-danger)' }}>{error}</div>}

        {activeRuntime && needsKey && (
          <div
            style={{
              display: 'flex',
              gap: 9,
              padding: '11px 13px',
              border: '1px solid color-mix(in srgb, var(--term-select) 42%, var(--term-line))',
              background: 'var(--term-select-f)',
              fontSize: 'var(--fs-lg)',
              color: 'var(--term-fg)',
              lineHeight: 1.5,
            }}
          >
            <span aria-hidden style={{ color: 'var(--term-select)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
              ▲
            </span>
            <span>
              <b>{activeLabel} runs on your own AI provider.</b> Add an API key to continue — we'll walk you
              through it. Stored locally on this device.
            </span>
          </div>
        )}

        {/* Model — directly pickable dropdown (hidden while a key is still needed). */}
        {activeRuntime && hasModelPicker && !needsKey && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={FIELD_LABEL}>Model</label>
            <select
              className="ui-select"
              value={status.model ?? ''}
              disabled={saving || modelCatalog.loading}
              onChange={async (e) => {
                setSaving(true);
                setError(null);
                try {
                  const result = await saveAgentOptions({ model: e.target.value, expectedRuntime: status.runtime });
                  if (!result.ok) throw new Error(result.error);
                  refreshAgentStatus();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Unable to save model. Please try again.');
                } finally {
                  setSaving(false);
                }
              }}
            >
              {modelCatalog.models.length === 0 && status.model && (
                <option value={status.model}>{status.model}</option>
              )}
              {modelCatalog.models.length === 0 && !status.model && (
                <option value="">{modelCatalog.loading ? 'Loading models…' : 'No models available'}</option>
              )}
              {modelCatalog.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label || m.id}
                </option>
              ))}
            </select>
            {modelCatalog.error && (
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger)' }}>{modelCatalog.error}</span>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 18px',
          borderTop: '1px solid var(--term-line)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 'var(--fs-md)', color: 'var(--term-muted)' }}>
          Change anytime in <b style={{ color: 'var(--term-mid)', fontWeight: 600 }}>Settings → Runtime & model</b>
        </span>
        <Button variant="primary" disabled={!canContinue} onClick={complete}>
          {primaryLabel}
        </Button>
      </div>
    </ModalShell>
  );
}

const FIELD_LABEL: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
  letterSpacing: 'var(--ls-caps)',
  textTransform: 'uppercase',
  color: 'var(--term-muted)',
};
