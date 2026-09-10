import React, { useCallback, useEffect, useState } from 'react';
import type { AgentProviderInfo, VerifyProviderKeyResult, BedrockCredentialSource, BedrockConfigSanitized, BedrockConfigInput } from '../../../../services/api';
import { getBedrockConfig, saveBedrockConfig as saveBedrock, clearBedrockConfig, verifyBedrockConfig } from '../../../../services/api';
import { BorderBtn } from '../../primitives';
import { confirmDialog } from '../../../ui/ConfirmDialog';

const BEDROCK_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'sa-east-1',
  'ca-central-1',
];

const fieldStyle: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 12,
  padding: '6px 8px',
  border: '1px solid var(--term-line)',
  background: 'var(--term-surface-glass)',
  color: 'var(--term-fg)',
  minWidth: 320,
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--term-muted)',
  marginBottom: 4,
  fontFamily: 'var(--ui-font)',
};

export function BedrockConfigPanel({
  provider,
  onChanged,
}: {
  provider: AgentProviderInfo;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState<BedrockConfigSanitized | null>(null);
  const [region, setRegion] = useState('us-east-1');
  const [credentialSource, setCredentialSource] = useState<BedrockCredentialSource>('profile');
  const [profile, setProfile] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [authRefreshCommand, setAuthRefreshCommand] = useState('');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyProviderKeyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const cfg = await getBedrockConfig();
      setConfig(cfg);
      if (cfg.region) setRegion(cfg.region);
      if (cfg.credentialSource && cfg.credentialSource !== 'env') {
        setCredentialSource(cfg.credentialSource);
      }
      // Don't populate secret fields from backend — they are never returned.
    } catch {
      // Ignore load errors; defaults are fine.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setVerifyResult(null);
    const body: BedrockConfigInput = {
      region,
      credentialSource,
      authRefreshCommand: authRefreshCommand.trim() || undefined,
    };
    if (credentialSource === 'profile') body.profile = profile.trim();
    if (credentialSource === 'bearer-token') body.bearerToken = bearerToken.trim();
    if (credentialSource === 'access-keys') {
      body.accessKeyId = accessKeyId.trim();
      body.secretAccessKey = secretAccessKey.trim();
    }
    const result = await saveBedrock(body);
    setSaving(false);
    if (!result.ok) {
      setError('error' in result ? result.error : 'Failed to save');
    } else {
      await load();
      onChanged();
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    setError(null);
    setVerifyResult(null);
    try {
      const result = await verifyBedrockConfig();
      setVerifyResult(result);
    } catch (err: any) {
      setVerifyResult({ ok: false, error: err?.message ?? 'Verification failed' });
    } finally {
      setVerifying(false);
    }
  };

  const handleClear = async () => {
    if (!(await confirmDialog({
      title: 'Clear Bedrock config',
      message: 'Clear all saved Bedrock credentials?',
      confirmLabel: 'Clear',
    }))) return;
    await clearBedrockConfig();
    setProfile('');
    setBearerToken('');
    setAccessKeyId('');
    setSecretAccessKey('');
    setAuthRefreshCommand('');
    setVerifyResult(null);
    await load();
    onChanged();
  };

  const envDetected = config?.envDetected ?? false;

  return (
    <div
      style={{
        fontFamily: 'var(--ui-font)',
        fontSize: 13,
        color: 'var(--term-fg)',
        marginTop: 18,
        paddingTop: 14,
        borderTop: '1px solid var(--term-line)',
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: 'var(--term-muted)',
          letterSpacing: '.14em',
          marginBottom: 12,
          fontFamily: 'var(--ui-font)',
        }}
      >
        ▸ AMAZON BEDROCK
      </div>

      {envDetected && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--term-accent)',
            marginBottom: 14,
            padding: '8px 10px',
            background: 'var(--term-alt)',
            lineHeight: 1.5,
          }}
        >
          Using environment variables
          {config?.envProfile ? ` (AWS_PROFILE=${config.envProfile})` : ''}
          {config?.envRegion ? ` in ${config.envRegion}` : ''}
          . Settings below are overridden by env.
        </div>
      )}

      {/* Region */}
      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>region</div>
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          style={fieldStyle}
        >
          {BEDROCK_REGIONS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      {/* Credential source */}
      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>credential source</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(
            [
              { value: 'profile' as const, label: 'AWS Profile' },
              { value: 'bearer-token' as const, label: 'Bearer Token' },
              { value: 'access-keys' as const, label: 'Access Keys' },
              { value: 'auto' as const, label: 'Auto (SDK default chain)' },
            ] as const
          ).map((opt) => (
            <label
              key={opt.value}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="bedrock-cred-source"
                value={opt.value}
                checked={credentialSource === opt.value}
                onChange={() => setCredentialSource(opt.value)}
                style={{ marginTop: 2 }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <span>{opt.label}</span>
                {credentialSource === opt.value && opt.value === 'profile' && (
                  <input
                    type="text"
                    value={profile}
                    onChange={(e) => setProfile(e.target.value)}
                    placeholder="Profile name (e.g. claude)"
                    style={{ ...fieldStyle, minWidth: 280 }}
                  />
                )}
                {credentialSource === opt.value && opt.value === 'bearer-token' && (
                  <input
                    type="password"
                    value={bearerToken}
                    onChange={(e) => setBearerToken(e.target.value)}
                    placeholder="Bearer token"
                    style={{ ...fieldStyle, minWidth: 280 }}
                  />
                )}
                {credentialSource === opt.value && opt.value === 'access-keys' && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={accessKeyId}
                      onChange={(e) => setAccessKeyId(e.target.value)}
                      placeholder="Access Key ID"
                      style={{ ...fieldStyle, minWidth: 180 }}
                    />
                    <input
                      type="password"
                      value={secretAccessKey}
                      onChange={(e) => setSecretAccessKey(e.target.value)}
                      placeholder="Secret Access Key"
                      style={{ ...fieldStyle, minWidth: 180 }}
                    />
                  </div>
                )}
                {credentialSource === opt.value && opt.value === 'auto' && (
                  <span style={{ fontSize: 10.5, color: 'var(--term-muted)' }}>
                    Uses the AWS SDK default credential chain (IAM role, ~/.aws/credentials, etc.)
                  </span>
                )}
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Auth refresh command */}
      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>auto-refresh command (optional)</div>
        <input
          type="text"
          value={authRefreshCommand}
          onChange={(e) => setAuthRefreshCommand(e.target.value)}
          placeholder="e.g. aws sso login --profile my-profile"
          style={{ ...fieldStyle, minWidth: 480, width: '100%', maxWidth: 600 }}
        />
        <div style={{ fontSize: 10.5, color: 'var(--term-muted)', marginTop: 4, lineHeight: 1.5 }}>
          Runs automatically when credentials expire. Similar to Claude Code's awsAuthRefresh.
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 12,
            padding: '6px 12px',
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface-glass)',
            color: 'var(--term-fg)',
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.55 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={() => void handleVerify()}
          disabled={verifying}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 12,
            padding: '6px 12px',
            border: '1px solid var(--term-line)',
            background: verifyResult?.ok ? 'var(--term-alt)' : 'var(--term-surface-glass)',
            color: verifyResult?.ok ? 'var(--term-accent)' : 'var(--term-fg)',
            cursor: verifying ? 'default' : 'pointer',
            opacity: verifying ? 0.55 : 1,
          }}
        >
          {verifying ? 'Verifying...' : 'Verify connection'}
        </button>
        <button
          onClick={() => void handleClear()}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 12,
            padding: '6px 12px',
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface-glass)',
            color: 'var(--term-mid)',
            cursor: 'pointer',
          }}
        >
          Clear
        </button>
      </div>

      {/* Status */}
      {verifyResult && (
        <div
          style={{
            fontSize: 11,
            color: verifyResult.ok ? 'var(--term-accent)' : 'var(--term-danger)',
            marginTop: 8,
          }}
        >
          {verifyResult.ok
            ? `✅ Verified${verifyResult.model ? ` — ${verifyResult.model}` : ''}${verifyResult.latencyMs ? ` in ${verifyResult.latencyMs}ms` : ''}`
            : `❌ ${verifyResult.error ?? 'Verification failed'}`}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 11, color: 'var(--term-danger)', marginTop: 6 }}>{error}</div>
      )}
      {config?.configured && !verifyResult && (
        <div style={{ fontSize: 11, color: 'var(--term-muted)', marginTop: 8 }}>
          {config.envDetected
            ? 'Credentials detected from environment.'
            : `Credentials saved (${config.credentialSource}).`}
          {config.hasAuthRefresh ? ' Auto-refresh enabled.' : ''}
        </div>
      )}
    </div>
  );
}
