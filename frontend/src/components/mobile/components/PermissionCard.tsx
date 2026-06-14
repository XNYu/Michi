import React from 'react';
import type { PermissionRequest } from '../../../state/chatTypes';

interface Props {
  permission: PermissionRequest;
  onAllow: (optionId: string) => void;
  onDeny: () => void;
  readOnly?: boolean;
}

export default function PermissionCard({ permission, onAllow, onDeny, readOnly = false }: Props) {
  // Find the canonical "allow once" option; fall back to the first non-deny
  // option, then the first option of any kind.
  const allowOption =
    permission.options.find((o) => /allow|approve|run/i.test(o.name)) ??
    permission.options.find((o) => !/deny|cancel|reject/i.test(o.name)) ??
    permission.options[0];

  return (
    <div className="m-perm-card">
      <div style={{ fontWeight: 600, fontSize: 13 }}>🔧 Tool authorization</div>
      <div style={{ fontSize: 13, color: 'var(--term-fg)' }}>{permission.title}</div>
      {permission.detail && (
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--term-muted)',
            fontSize: 12,
            fontFamily: 'var(--mono-font)',
          }}
        >
          {permission.detail}
        </pre>
      )}
      {readOnly ? (
        <div className="m-perm-actions" style={{ color: 'var(--term-muted)', fontSize: 12 }}>
          Viewing only — another window must respond
        </div>
      ) : (
        <div className="m-perm-actions">
          <button onClick={onDeny}>Deny</button>
          {allowOption && (
            <button data-allow="true" onClick={() => onAllow(allowOption.optionId)}>
              {allowOption.name || 'Allow'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
