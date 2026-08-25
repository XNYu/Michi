import React, { useEffect, useRef } from 'react';
import { permissionSourceLabel } from 'michi-shared';
import type { PermissionRequest } from '../../state/chatTypes';
import { KBD } from './primitives';
import { Button } from '../ui/controls';
import { kbd } from '../../lib/platform';

interface PermissionBannerProps {
  permission: PermissionRequest;
  onRespond: (optionId: string) => void;
  onCancel: () => void;
  readOnly?: boolean;
}

export default function PermissionBanner({ permission, onRespond, onCancel, readOnly = false }: PermissionBannerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (readOnly) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        const reject = permission.options.find((o) => o.kind === 'reject_once');
        if (reject) onRespond(reject.optionId);
        else onCancel();
      } else if (e.key === 'Enter' && e.metaKey && e.shiftKey) {
        e.preventDefault();
        const opt = permission.options.find((o) => o.kind === 'allow_once');
        if (opt) onRespond(opt.optionId);
      } else if (e.key === 'Enter' && e.metaKey && !e.shiftKey) {
        e.preventDefault();
        const opt = permission.options.find((o) => o.kind === 'allow_always');
        if (opt) onRespond(opt.optionId);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [permission, onRespond, onCancel, readOnly]);

  const rejectOptions = permission.options.filter(
    (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
  );
  const allowOptions = permission.options.filter(
    (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
  );

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
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--term-fg)',
          fontFamily: 'var(--ui-font)',
        }}
      >
        {permission.title}
        <div
          data-testid="permission-source"
          style={{ fontWeight: 400, color: 'var(--term-muted)', fontSize: 11, marginTop: 4 }}
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
            borderRadius: 4,
            padding: '8px 10px',
            background: 'var(--term-bg)',
            color: 'var(--term-muted)',
            fontFamily: 'var(--mono-font)',
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          {permission.detail}
        </pre>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {readOnly ? (
          <div
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 11,
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
              danger
              onClick={() => onRespond(o.optionId)}
            >
              {o.kind === 'reject_once' ? 'Deny' : 'Never allow'}
              {o.kind === 'reject_once' && <KBD>esc</KBD>}
            </Button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {allowOptions.map((o) => {
            const isAlways = o.kind === 'allow_always';
            return (
              <Button
                key={o.optionId}
                variant={isAlways ? 'primary' : 'secondary'}
                onClick={() => onRespond(o.optionId)}
                style={isAlways ? undefined : { color: 'var(--term-accent)', borderColor: 'var(--term-accent)' }}
              >
                {isAlways ? 'Always allow' : 'Allow once'}
                <KBD>{isAlways ? kbd('mod', 'enter') : kbd('mod', 'shift', 'enter')}</KBD>
              </Button>
            );
          })}
        </div>
        </>
        )}
      </div>
    </div>
  );
}
