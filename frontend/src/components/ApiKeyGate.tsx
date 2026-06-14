import React, { useEffect, useState } from 'react';
import { fetchAgentStatus, saveAgentOptions, saveProviderKey, verifyProviderKey } from '../services/api';
import type { AgentStatus, VerifyProviderKeyResult } from '../services/api';

/**
 * Capability-driven welcome/key gate.
 *
 * Renders a modal only when the active runtime advertises `capabilities.apiKeys`
 * AND `hasRequiredKey` is false. For runtimes that don't need an API key (kiro,
 * etc.) this is always invisible.
 *
 * Behavior on submit:
 * - If the user picked a provider different from `status.provider`, persist
 *   that via `saveAgentOptions({ provider })` first.
 * - Persist the typed key via `saveProviderKey(provider, key)`.
 * - Dispatch `michi:reload-agent-status` so the chatStore (and any other
 *   listeners) re-fetch. Once `hasRequiredKey` flips true, we render null.
 *
 * Backend-unreachable handling: a small backoff loop on mount, with a manual
 * "retry" affordance once the loop gives up.
 */
export default function ApiKeyGate() {
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
    // Settings "Change API Key" button) to force the gate to re-show.
    // Callers can pass `detail.silent: true` to refresh status without
    // re-opening the modal — used by the in-Settings provider picker so
    // switching to a key-less provider just surfaces the inline reminder
    // instead of slamming the user with the welcome dialog.
    const handler = (e: Event) => {
      const silent = (e as CustomEvent).detail?.silent === true;
      if (silent) setDismissed(true);
      else setDismissed(false);
      void load();
    };
    window.addEventListener('michi:reload-agent-status', handler);
    return () => window.removeEventListener('michi:reload-agent-status', handler);
  }, []);

  // Esc closes the modal — only attached while the gate is actually visible
  // so we don't swallow Esc elsewhere in the app.
  const modalVisible =
    !backendUnreachable &&
    !loading &&
    !!status &&
    !!status.capabilities.apiKeys &&
    !status.hasRequiredKey &&
    !dismissed;
  useEffect(() => {
    if (!modalVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalVisible]);

  // Sync the local provider picker with whatever the backend currently has
  // selected. If providers exist and we don't have one yet, default to the
  // backend's choice or the first provider.
  useEffect(() => {
    if (!status) return;
    const providers = status.providers ?? [];
    if (providers.length === 0) return;
    if (!selectedProvider) {
      setSelectedProvider(status.provider ?? providers[0]!.id);
    }
  }, [status, selectedProvider]);

  // Backend persistently unreachable — show a tiny status banner so the user
  // doesn't sit looking at a blank screen.
  if (backendUnreachable) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            padding: '24px 32px',
            background: 'var(--surface)',
            border: '1px solid var(--line-strong)',
            color: 'var(--fg)',
            fontFamily: 'var(--font-sans, ui-sans-serif)',
            fontSize: 14,
            maxWidth: 420,
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Backend not reachable</div>
          <div style={{ color: 'var(--fg-muted)' }}>
            The Michi backend isn't responding. If you launched the app from
            Finder, try quitting and re-opening it.
          </div>
          <button
            onClick={() => void load()}
            style={{
              marginTop: 16,
              padding: '6px 16px',
              fontSize: 13,
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Not ready yet, runtime doesn't need an API key, or key already present —
  // render nothing.
  if (loading) return null;
  if (!status) return null;
  if (!status.capabilities.apiKeys) return null;
  if (status.hasRequiredKey) return null;
  if (dismissed) return null;

  const providers = status.providers ?? [];
  const selectedProviderInfo =
    providers.find((p) => p.id === selectedProvider) ||
    providers.find((p) => p.id === status.provider) ||
    providers[0];
  const selectedHasKey = !!selectedProviderInfo?.hasKey;
  const canSubmit = selectedHasKey || !!key.trim();
  const canVerify = selectedHasKey || !!key.trim();

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
          selectedProviderInfo.id === status.provider
            ? status.model
            : selectedProviderInfo.defaultModel,
      });
      setVerifyResult(result);
    } catch (err: any) {
      setVerifyResult({ ok: false, error: err?.message ?? 'Unable to verify API key' });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 480,
          background: 'var(--surface)',
          border: '1px solid var(--line-strong)',
          boxShadow: '0 32px 80px rgba(0,0,0,0.3)',
          padding: '32px 36px',
          animation: 'scaleIn 180ms cubic-bezier(.2,.8,.2,1) both',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: 'var(--fg)',
            fontFamily: 'var(--font-sans, ui-sans-serif)',
            marginBottom: 12,
          }}
        >
          Welcome to Michi
        </div>

        {/* Body copy */}
        <p
          style={{
            fontSize: 14,
            color: 'var(--fg-muted)',
            fontFamily: 'var(--font-sans, ui-sans-serif)',
            lineHeight: 1.6,
            margin: '0 0 8px',
          }}
        >
          Choose your AI provider and add an API key to get started. It will be
          saved locally.
        </p>
        {selectedProviderInfo && (
          <p
            style={{
              fontSize: 13,
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-sans, ui-sans-serif)',
              lineHeight: 1.5,
              margin: '0 0 20px',
            }}
          >
            Default: <strong style={{ color: 'var(--fg)' }}>{selectedProviderInfo.label}</strong>
            {' / '}
            <strong style={{ color: 'var(--fg)' }}>{selectedProviderInfo.defaultModel ?? status.model}</strong>
            . You can change provider, model, and reasoning in Settings later.
          </p>
        )}

        {providers.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <select
              value={selectedProviderInfo?.id ?? ''}
              onChange={(e) => {
                setSelectedProvider(e.target.value);
                setKey('');
                setError(null);
                setVerifyResult(null);
              }}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                fontSize: 13,
                fontFamily: 'var(--font-mono, ui-monospace)',
                background: 'var(--app-bg)',
                color: 'var(--fg)',
                border: '1px solid var(--line-strong)',
                outline: 'none',
                borderRadius: 0,
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}{(p.hasKey ?? false) ? ' - key saved' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {selectedProviderInfo?.keyUrl && (
          <div style={{ marginBottom: 20 }}>
            <a
              href={selectedProviderInfo.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 13,
                color: 'var(--accent)',
                fontFamily: 'var(--font-sans, ui-sans-serif)',
                textDecoration: 'underline',
              }}
            >
              Open {selectedProviderInfo.label} key console
            </a>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 8 }}>
            <input
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setError(null);
                setVerifyResult(null);
              }}
              placeholder={
                selectedHasKey
                  ? 'Saved key present (paste to replace)'
                  : selectedProviderInfo?.keyLabel ?? 'API key'
              }
              autoFocus
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '9px 12px',
                fontSize: 14,
                fontFamily: 'var(--font-mono, ui-monospace)',
                background: 'var(--app-bg)',
                color: 'var(--fg)',
                border: '1px solid var(--line-strong)',
                outline: 'none',
                borderRadius: 0,
              }}
            />
          </div>

          {error && (
            <div
              style={{
                fontSize: 13,
                color: 'var(--danger)',
                fontFamily: 'var(--font-sans, ui-sans-serif)',
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}

          {verifyResult && (
            <div
              style={{
                fontSize: 13,
                color: verifyResult.ok ? 'var(--accent)' : 'var(--danger)',
                fontFamily: 'var(--font-sans, ui-sans-serif)',
                marginBottom: 12,
              }}
            >
              {verifyResult.ok
                ? `Verified ${selectedProviderInfo?.label ?? selectedProviderInfo?.id ?? ''}${verifyResult.model ? ` / ${verifyResult.model}` : ''}${verifyResult.latencyMs ? ` in ${verifyResult.latencyMs}ms` : ''}.`
                : verifyResult.error ?? 'Verification failed.'}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              disabled={saving || verifying}
              style={{
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 700,
                fontFamily: 'var(--font-sans, ui-sans-serif)',
                background: 'transparent',
                color: saving || verifying ? 'var(--fg-muted)' : 'var(--fg-muted)',
                border: '1px solid var(--line-strong)',
                cursor: saving || verifying ? 'not-allowed' : 'pointer',
                borderRadius: 0,
                transition: 'background 120ms',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleVerify()}
              disabled={!canVerify || verifying || saving}
              style={{
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 700,
                fontFamily: 'var(--font-sans, ui-sans-serif)',
                background: 'transparent',
                color: !canVerify || verifying || saving ? 'var(--fg-muted)' : 'var(--fg)',
                border: '1px solid var(--line-strong)',
                cursor: !canVerify || verifying || saving ? 'not-allowed' : 'pointer',
                borderRadius: 0,
                transition: 'background 120ms',
              }}
            >
              {verifying ? 'Verifying...' : 'Verify'}
            </button>
            <button
              type="submit"
              disabled={!canSubmit || saving || verifying}
              style={{
                padding: '8px 20px',
                fontSize: 14,
                fontWeight: 700,
                fontFamily: 'var(--font-sans, ui-sans-serif)',
                background: !canSubmit || saving || verifying ? 'var(--line-strong)' : 'var(--accent)',
                color: !canSubmit || saving || verifying ? 'var(--fg-muted)' : 'var(--accent-fg)',
                border: 'none',
                cursor: !canSubmit || saving || verifying ? 'not-allowed' : 'pointer',
                borderRadius: 0,
                transition: 'background 120ms',
              }}
            >
              {saving ? 'Saving...' : selectedHasKey && !key.trim() ? 'Use Provider' : 'Get Started'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
