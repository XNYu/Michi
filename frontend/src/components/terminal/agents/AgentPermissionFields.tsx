import React from 'react';
import { AgentPolicyCategory, AgentPolicyDecision } from 'michi-shared';
import { agentFieldStyle } from './AgentRuntimeProfileFields';

export interface PermissionPolicyDraft {
  preset: 'research' | 'build' | 'custom';
  categories: Partial<Record<AgentPolicyCategory, AgentPolicyDecision>>;
  maxDelegationDepth: string;
  maxConcurrentRuns: string;
  maxWallTimeMinutes: string;
  maxAttempts: string;
}

export const defaultPermissionPolicyDraft = (): PermissionPolicyDraft => ({
  preset: 'research', categories: {}, maxDelegationDepth: '0', maxConcurrentRuns: '1', maxWallTimeMinutes: '60', maxAttempts: '1',
});

interface Props {
  value: PermissionPolicyDraft;
  onChange: (value: PermissionPolicyDraft) => void;
  errors?: Partial<Record<'maxDelegationDepth' | 'maxConcurrentRuns' | 'maxWallTimeMinutes' | 'maxAttempts', string>>;
}

const categories = [
  AgentPolicyCategory.Read, AgentPolicyCategory.Search, AgentPolicyCategory.Browse,
  AgentPolicyCategory.ArtifactWrite, AgentPolicyCategory.FilesystemWrite,
  AgentPolicyCategory.ShellExec, AgentPolicyCategory.ExternalAction, AgentPolicyCategory.SpawnAgent,
];

export default function AgentPermissionFields({ value, onChange, errors = {} }: Props) {
  const set = <K extends keyof PermissionPolicyDraft>(key: K, next: PermissionPolicyDraft[K]) => onChange({ ...value, [key]: next });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <label style={labelStyle}>
        Preset
        <select aria-label="permission preset" value={value.preset} onChange={(event) => set('preset', event.target.value as PermissionPolicyDraft['preset'])} style={agentFieldStyle}>
          <option value="research">Research — read/search only</option>
          <option value="build">Build — isolated worktree write/exec</option>
          <option value="custom">Custom — explicit decisions</option>
        </select>
      </label>
      {value.preset === 'custom' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', border: '1px solid var(--term-line)' }}>
          {categories.map((category) => (
            <label key={category} style={{ ...labelStyle, padding: 9, borderBottom: '1px solid var(--term-line)' }}>
              {category.replaceAll('_', ' ')}
              <select aria-label={`permission ${category}`} value={value.categories[category] ?? AgentPolicyDecision.Deny} onChange={(event) => onChange({ ...value, categories: { ...value.categories, [category]: event.target.value as AgentPolicyDecision } })} style={agentFieldStyle}>
                <option value={AgentPolicyDecision.Allow}>allow</option>
                <option value={AgentPolicyDecision.Ask}>ask</option>
                <option value={AgentPolicyDecision.Deny}>deny</option>
              </select>
            </label>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <NumberField label="Delegation depth" aria="max delegation depth" value={value.maxDelegationDepth} error={errors.maxDelegationDepth} onChange={(next) => set('maxDelegationDepth', next)} />
        <NumberField label="Concurrent runs" aria="max concurrent runs" value={value.maxConcurrentRuns} error={errors.maxConcurrentRuns} onChange={(next) => set('maxConcurrentRuns', next)} />
        <NumberField label="Wall time (min)" aria="max wall time minutes" value={value.maxWallTimeMinutes} error={errors.maxWallTimeMinutes} onChange={(next) => set('maxWallTimeMinutes', next)} />
        <NumberField label="Attempts" aria="max attempts" value={value.maxAttempts} error={errors.maxAttempts} onChange={(next) => set('maxAttempts', next)} />
      </div>
    </div>
  );
}

function NumberField({ label, aria, value, onChange, error }: { label: string; aria: string; value: string; onChange: (value: string) => void; error?: string }) {
  return <label style={labelStyle}>{label}<input aria-label={aria} inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value)} style={agentFieldStyle} />{error && <span role="alert" style={{ color: 'var(--danger, var(--term-error))', fontSize: 10, letterSpacing: 0, textTransform: 'none' }}>{error}</span>}</label>;
}

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase' };
