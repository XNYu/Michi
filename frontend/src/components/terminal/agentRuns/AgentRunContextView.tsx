import React from 'react';
import type { AgentRunContextManifestV1 } from 'michi-shared';

function entryTitle(entry: AgentRunContextManifestV1['entries'][number]): string {
  if (entry.kind === 'message') return `${entry.role} message`;
  if (entry.kind === 'artifact') return entry.name;
  if (entry.kind === 'file') return entry.workspacePath;
  if (entry.kind === 'summary') return entry.label;
  return 'Workspace instructions';
}

export function AgentRunContextView({ manifest }: { manifest: AgentRunContextManifestV1 }) {
  return (
    <div>
      <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', marginBottom: 8 }}>
        {manifest.entries.length} immutable {manifest.entries.length === 1 ? 'entry' : 'entries'} · {manifest.estimatedChars.toLocaleString()} estimated chars
      </div>
      <div style={{ borderTop: '1px solid var(--term-line)' }}>
        {manifest.entries.map((entry, index) => (
          <div key={`${entry.kind}:${index}`} style={{ padding: '9px 0', borderBottom: '1px solid var(--term-line)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--term-fg)', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>{entryTitle(entry)}</span>
              <span style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', marginLeft: 'auto' }}>{entry.kind}</span>
            </div>
            {'size' in entry && <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', marginTop: 3 }}>{entry.size.toLocaleString()} bytes</div>}
            <code style={{ display: 'block', color: 'var(--term-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', marginTop: 4, overflowWrap: 'anywhere' }}>
              sha256 {entry.sha256}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}
