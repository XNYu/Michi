import React, { useEffect, useRef } from 'react';
import { permissionSourceLabel } from 'michi-shared';
import type { PermissionRequest } from '../../state/chatTypes';
import { Button } from '../ui/controls';

interface PermissionBannerProps {
  permission: PermissionRequest;
  onRespond: (optionId: string) => void;
  readOnly?: boolean;
}

export default function PermissionBanner({ permission, onRespond, readOnly = false }: PermissionBannerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const rejectOptions = permission.options.filter(
    (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
  );
  const allowOptions = permission.options.filter(
    (o) => o.kind === 'allow_once' || o.kind === 'allow_always' || o.kind === 'allow_session',
  );
  const hasTrustChoices = allowOptions.some((o) => o.kind === 'allow_session');

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      style={{
        borderTop: '1px solid var(--term-line)',
        padding: '12px 14px',
        background: 'var(--term-alt)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        outline: 'none',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontSize: 'var(--fs-md)',
          fontWeight: 600,
          color: 'var(--term-fg)',
          fontFamily: 'var(--ui-font)',
        }}
      >
        {permission.title}
        <div
          data-testid="permission-source"
          style={{ fontWeight: 400, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}
        >
          {permissionSourceLabel(permission.source)}
        </div>
      </div>
      {permission.detail && (
        <pre
          style={{
            margin: 0,
            maxHeight: 96,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            border: '1px solid var(--term-line)',
            borderRadius: 'var(--ui-radius)',
            padding: '8px 10px',
            background: 'var(--term-bg)',
            color: 'var(--term-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-sm)',
            lineHeight: 1.45,
          }}
        >
          {permission.detail}
        </pre>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {readOnly ? (
          <div
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--term-muted)',
            }}
          >
            Viewing only — another window must respond
          </div>
        ) : (
        <>
        <div style={{ display: 'flex', gap: 6 }}>
          {rejectOptions.map((o) => (
            <Button
              key={o.optionId}
              variant="secondary"
              className="t-permission-choice t-permission-choice--deny"
              disabled={o.disabled}
              onClick={() => onRespond(o.optionId)}
            >
              {o.kind === 'reject_once' ? 'Deny' : 'Never allow'}
            </Button>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {allowOptions.map((o) => {
            const isAlways = o.kind === 'allow_always';
            const isOnce = o.kind === 'allow_once';
            return (
              <Button
                key={o.optionId}
                variant="secondary"
                className="t-permission-choice"
                disabled={o.disabled}
                title={o.disabled ? 'The runtime did not provide a stable tool name. Allow this request once or trust this session.' : undefined}
                onClick={() => onRespond(o.optionId)}
              >
                {isAlways ? 'Trust this tool' : isOnce ? 'Allow Once' : 'Trust all tools for this session'}
              </Button>
            );
          })}
        </div>
        </>
        )}
      </div>
      {hasTrustChoices && <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', fontFamily: 'var(--ui-font)' }}>
        Trust applies only to this conversation. Session trust ends when the runtime session is recreated. Select Ask to clear trust.
      </div>}
    </div>
  );
}
