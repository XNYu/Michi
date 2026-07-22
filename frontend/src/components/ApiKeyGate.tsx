import React, { useEffect, useState } from 'react';
import { fetchAgentStatus, saveAgentOptions, saveProviderKey, verifyProviderKey } from '../services/api';
import type { AgentStatus, VerifyProviderKeyResult } from '../services/api';
import { providerOptionSuffix, providerRequiresUserKey } from '../lib/providerCapabilities';
import { ModalShell } from './ui/ModalShell';
import { Button } from './ui/controls';
import { usePrefs } from '../state/prefs';

/**
 * Capability-driven key gate — the unified Pi (or any BYOK runtime) key window.
 *
 * Renders a {@link ModalShell} only when the active runtime advertises
 * `capabilities.apiKeys` AND `hasRequiredKey` is false. Runtimes that don't
 * need a key (Kiro, Claude, …) never surface this. It shares the same shell,
 * `.term-glass` material, `--term-*` tokens, and `.ui-input`/`.ui-select`/
 * `.ui-btn` primitives as every other dialog — it used to be a one-off on the
 * legacy `--fg`/`--accent` token family with hand-rolled scrim + inline styles.
 *
 * First-run ordering: while onboarding is incomplete, {@link FirstRunSetup}
 * owns the experience, so the key modal stays suppressed until onboarding is
 * marked complete (its "Set up … key" action flips that flag, then this takes
 * over). The backend-unreachable notice is NOT gated — it's useful cold-start
 * feedback regardless of onboarding state.
 *
 * Behavior on submit:
 * - If the user picked a provider different from `status.provider`, persist
 *   that via `saveAgentOptions({ provider })` first.
 * - Persist the typed key via `saveProviderKey(provider, key)`.
 * - Re-fetch status; once `hasRequiredKey` flips true, we render null.
 */
export default function ApiKeyGate() {
  const { prefs } = usePrefs();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [backendUnreachable, setBackendUnreachable] = useState(false);
  const [key, setKey] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyProviderKeyResult | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Backoff schedule for cold backend startup. Caps at ~5s between retries
  // so the user sees a "loading" state instead of a stuck blank screen.
  const load = async () => {
    setLoading(true);
    setBackendUnreachable(false);
    const delays = [0, 250, 500, 1000, 2000, 5000, 5000];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
      try {
        const s = await fetchAgentStatus();
        setStatus(s);
        setLoading(false);
        return;
      } catch {
        // Try again
      }
    }
    setBackendUnreachable(true);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // Allow other parts of the app (chatStreamRunner on auth errors, the
    // Settings "Change API Key" button, FirstRunSetup's "Set up key" action)
    // to force the gate to re-show. `detail.silent: true` refreshes status
    // without re-opening the modal — used by the in-Settings provider picker
    // so switching to a key-less provider just surfaces the inline reminder.
    const handler = (e: Event) => {
      const silent = (e as CustomEvent).detail?.silent === true;
      if (silent) setDismissed(true);
      else setDismissed(false);
      void load();
    };
    window.addEventListener('michi:reload-agent-status', handler);
    return () => window.removeEventListener('michi:reload-agent-status', handler);
  }, []);

  // Sync the local provider picker with whatever the backend currently has
  // selected. If providers exist and we don't have one yet, default to the
  // backend's choice or the first provider.
  useEffect(() => {
    if (!status) return;
    const providers = (status.providers ?? []).filter(providerRequiresUserKey);
    if (providers.length === 0) return;
    if (!selectedProvider) {
      setSelectedProvider(status.provider ?? providers[0]!.id);
    }
  }, [status, selectedProvider]);

  // Backend persistently unreachable — a hard-blocking notice with a retry.
  // Not gated on onboarding: it's useful cold-start feedback either way.
  if (backendUnreachable) {
    return (
      <ModalShell open onClose={() => {}} title="Michi" titleGlyph="◆" width={420} dismissible={false}>
        <div style={{ padding: '18px 18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontFamily: 'var(--ui-font)', fontSize: 16, fontWeight: 700, color: 'var(--term-fg)' }}>
              Backend not reachable
            </div>
            <div style={{ fontSize: 13, color: 'var(--term-muted)', lineHeight: 1.55, marginTop: 5 }}>
              The Michi backend isn't responding. If you launched the app from Finder, try quitting and
              re-opening it.
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </div>
      </ModalShell>
    );
  }

  // Not ready yet, runtime doesn't need an API key, key already present,
  // dismissed, or onboarding still owns the flow — render nothing.
  if (loading || !status) return null;
  if (prefs.onboardingCompletedAt == null) return null;
  if (!status.capabilities.apiKeys) return null;
  if (status.hasRequiredKey) return null;
  if (dismissed) return null;

  const providers = (status.providers ?? []).filter(providerRequiresUserKey);
  const selectedProviderInfo =
    providers.find((p) => p.id === selectedProvider) ||
    providers.find((p) => p.id === status.provider) ||
    providers[0];
  const selectedHasKey = !!selectedProviderInfo?.hasKey;
  const canSubmit = selectedHasKey || !!key.trim();
  const canVerify = selectedHasKey || !!key.trim();
  const defaultModel = selectedProviderInfo?.defaultModel || status.model || '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || saving || !selectedProviderInfo) return;
    setSaving(true);
    setError(null);
    try {
      if (selectedProviderInfo.id !== status.provider) {
        await saveAgentOptions({ provider: selectedProviderInfo.id });
      }
      if (key.trim()) {
        const result = await saveProviderKey(selectedProviderInfo.id, key.trim());
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
      // Re-fetch status; if hasRequiredKey is now true the modal will unmount.
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async () => {
    if (!canVerify || verifying || !selectedProviderInfo) return;
    setVerifying(true);
    setError(null);
    setVerifyResult(null);
    try {
      const result = await verifyProviderKey(selectedProviderInfo.id, {
        key: key.trim() || undefined,
        model:
          selectedProviderInfo.id === status.provider ? status.model : selectedProviderInfo.defaultModel,
      });
      setVerifyResult(result);
    } catch (err: any) {
      setVerifyResult({ ok: false, error: err?.message ?? 'Unable to verify API key' });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <ModalShell
      open
      onClose={() => setDismissed(true)}
      title={`Set up ${status.label}`}
      titleGlyph="◆"
      width={480}
    >
      <form onSubmit={handleSubmit}>
        <div
          className="term-scrollbar"
          style={{ padding: '18px 18px 20px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}
        >
          <div>
            <div style={{ fontFamily: 'var(--ui-font)', fontSize: 18, fontWeight: 700, color: 'var(--term-fg)' }}>
              Add a provider key
            </div>
            <div style={{ fontSize: 13, color: 'var(--term-muted)', lineHeight: 1.55, marginTop: 5 }}>
              {status.label} runs on your own AI provider. Pick one and paste a key — it's saved locally and
              never leaves this device.
            </div>
          </div>

          {providers.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <label style={FIELD_LABEL}>Provider</label>
              <select
                className="ui-select"
                value={selectedProviderInfo?.id ?? ''}
                onChange={(e) => {
                  setSelectedProvider(e.target.value);
                  setKey('');
                  setError(null);
                  setVerifyResult(null);
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {providerOptionSuffix(p)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedProviderInfo?.keyUrl && (
            <a
              href={selectedProviderInfo.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 12.5,
                color: 'var(--term-accent)',
                textDecoration: 'none',
                width: 'fit-content',
              }}
            >
              Open {selectedProviderInfo.label} key console ↗
            </a>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label style={FIELD_LABEL}>API key</label>
            <input
              className="ui-input"
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setError(null);
                setVerifyResult(null);
              }}
              placeholder={
                selectedHasKey ? 'Saved key present (paste to replace)' : selectedProviderInfo?.keyLabel ?? 'API key'
              }
              autoFocus
            />
          </div>

          {error && <div style={{ fontSize: 12.5, color: 'var(--term-danger)' }}>{error}</div>}

          {verifyResult && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: verifyResult.ok ? 'var(--term-digest)' : 'var(--term-danger)',
              }}
            >
              {verifyResult.ok
                ? `✓ Verified · ${selectedProviderInfo?.label ?? selectedProviderInfo?.id ?? ''}${verifyResult.model ? ` · ${verifyResult.model}` : ''}${verifyResult.latencyMs ? ` · ${verifyResult.latencyMs}ms` : ''}`
                : verifyResult.error ?? 'Verification failed.'}
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
          <span style={{ fontSize: 11.5, color: 'var(--term-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {defaultModel && (
              <>
                Default model: <b style={{ color: 'var(--term-mid)', fontWeight: 600 }}>{defaultModel}</b>
              </>
            )}
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <Button variant="ghost" onClick={() => setDismissed(true)} disabled={saving || verifying}>
              Cancel
            </Button>
            <Button onClick={() => void handleVerify()} disabled={!canVerify || verifying || saving}>
              {verifying ? 'Verifying…' : 'Verify'}
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit || saving || verifying}>
              {saving ? 'Saving…' : selectedHasKey && !key.trim() ? 'Use provider' : 'Get Started'}
            </Button>
          </div>
        </div>
      </form>
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
