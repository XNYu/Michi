import React, { useEffect, useRef, useState } from 'react';
import { ModalShell } from './ui/ModalShell';
import { Button } from './ui/controls';
import { useChatStore } from '../state/chatStore';
import { usePrefs } from '../state/prefs';
import { saveAgentOptions } from '../services/api';
import { useAgentModelCatalog } from '../hooks/useAgentModelCatalog';

/**
 * First-run runtime/model setup — the "Variant A" single confirmation card.
 *
 * Shown once, on a fresh install with no workspaces yet and no recorded
 * onboarding completion. It's a thin projection of `agentStatus`: the summary
 * always reflects the currently-active runtime (the backend's default = the
 * "recommended" pick), its detected model, and whether it still needs an API
 * key. Runtime and model are directly pickable inline (no disclosure). Picking
 * a different runtime persists it via `saveAgentOptions({ runtime })` + a status
 * refresh, so the whole card re-renders from the new active runtime — no
 * separate local selection state.
 *
 * Key handoff: every runtime except Pi runs without a user key. When the
 * active runtime DOES need one (Pi), the primary button marks onboarding done
 * and pokes a status reload; the (now un-gated) {@link ApiKeyGate} detects
 * `apiKeys && !hasRequiredKey` and takes over with the unified key window. We
 * deliberately don't duplicate the key form here.
 *
 * Migration: any existing user (≥1 workspace) is silently marked complete so
 * upgrading to this build never pops the wizard.
 */
type ChipKind = 'ready' | 'setup' | 'na';
function StateChip({ kind, children }: { kind: ChipKind; children: React.ReactNode }) {
  const palette: Record<ChipKind, { color: string; bg: string }> = {
    ready: { color: 'var(--term-digest)', bg: 'var(--term-digest-f)' },
    setup: { color: 'var(--term-select)', bg: 'var(--term-select-f)' },
    na: { color: 'var(--term-faint)', bg: 'var(--term-alt)' },
  };
  const { color, bg } = palette[kind];
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        letterSpacing: '.09em',
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

function RecoTag() {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '.1em',
        textTransform: 'uppercase',
        color: 'var(--term-accent)',
        background: 'var(--term-accent-f)',
        padding: '2px 7px',
      }}
    >
      recommended
    </span>
  );
}

export default function FirstRunSetup() {
  const { agentStatus, refreshAgentStatus, projects, hydrated } = useChatStore();
  const { prefs, setPref } = usePrefs();
  const [saving, setSaving] = useState(false);
  // The backend's default runtime at first paint = the "recommended" one. Keep
  // the tag pinned to it even if the user switches selection in the disclosure.
  const recommendedRef = useRef<string | null>(null);

  const status = agentStatus;
  const completed = prefs.onboardingCompletedAt != null;
  const hasModelPicker = status?.capabilities.models === true;
  const needsKey = !!status && status.capabilities.apiKeys && !status.hasRequiredKey;

  // Hooks must run every render — gate via `enabled`, not early return.
  const modelCatalog = useAgentModelCatalog({
    enabled: !!status && hasModelPicker && !needsKey && !completed,
    runtime: status?.runtime ?? null,
    provider: status?.provider ?? null,
  });

  // Existing users skip onboarding permanently (any workspace ⇒ already set up).
  useEffect(() => {
    if (!hydrated || completed) return;
    if (projects.length > 0) setPref('onboardingCompletedAt', Date.now());
  }, [hydrated, completed, projects.length, setPref]);

  useEffect(() => {
    if (recommendedRef.current == null && status?.runtime) {
      recommendedRef.current = status.runtime;
    }
  }, [status?.runtime]);

  const open = hydrated && !completed && projects.length === 0 && !!status;
  if (!open || !status) return null;

  const runtimes = status.availableRuntimes ?? [];
  const activeLabel =
    runtimes.find((r) => r.id === status.runtime)?.label ?? status.label ?? status.runtime;

  // Mark onboarding done. If the chosen runtime still needs a key, the reload
  // wakes the (now un-gated) ApiKeyGate, which surfaces the unified key window.
  const complete = () => {
    setPref('onboardingCompletedAt', Date.now());
    refreshAgentStatus();
  };

  const selectRuntime = async (id: string) => {
    if (id === status.runtime || saving) return;
    setSaving(true);
    await saveAgentOptions({ runtime: id });
    setSaving(false);
    refreshAgentStatus();
  };

  const primaryLabel = needsKey ? `Set up ${activeLabel} key →` : `Start with ${activeLabel} →`;

  return (
    <ModalShell open onClose={complete} title="Setup" titleGlyph="◆" width={480}>
      <div
        className="term-scrollbar"
        style={{ padding: '18px 18px 20px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}
      >
        <div>
          <div style={{ fontFamily: 'var(--ui-font)', fontSize: 18, fontWeight: 700, color: 'var(--term-fg)' }}>
            Welcome to Michi
          </div>
          <div style={{ fontSize: 13, color: 'var(--term-muted)', lineHeight: 1.55, marginTop: 5 }}>
            We detected your runtimes — you're ready to go. You can change any of this later.
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
                        fontSize: 14,
                        fontWeight: 500,
                        color: 'var(--term-fg)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      {r.label}
                      {recommendedRef.current === r.id && <RecoTag />}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--term-muted)', marginTop: 2, display: 'block' }}>
                      {disabled
                        ? 'Not available on this machine'
                        : rowNeedsKey
                          ? 'Bring your own provider (OpenAI, Anthropic…)'
                          : 'Ready to use — no key required'}
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

        {needsKey && (
          <div
            style={{
              display: 'flex',
              gap: 9,
              padding: '11px 13px',
              border: '1px solid color-mix(in srgb, var(--term-select) 42%, var(--term-line))',
              background: 'var(--term-select-f)',
              fontSize: 12.5,
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
        {hasModelPicker && !needsKey && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={FIELD_LABEL}>Model</label>
            <select
              className="ui-select"
              value={status.model ?? ''}
              disabled={saving || modelCatalog.loading}
              onChange={async (e) => {
                setSaving(true);
                await saveAgentOptions({ model: e.target.value });
                setSaving(false);
                refreshAgentStatus();
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
              <span style={{ fontSize: 11, color: 'var(--term-danger)' }}>{modelCatalog.error}</span>
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
        <span style={{ fontSize: 11.5, color: 'var(--term-muted)' }}>
          Change anytime in <b style={{ color: 'var(--term-mid)', fontWeight: 600 }}>Settings → Model</b>
        </span>
        <Button variant="primary" disabled={saving} onClick={complete}>
          {primaryLabel}
        </Button>
      </div>
    </ModalShell>
  );
}

const FIELD_LABEL: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--term-muted)',
};
