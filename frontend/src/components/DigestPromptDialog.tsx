import React, { useState, useEffect, useRef } from 'react';

interface DigestPromptDialogProps {
  open: boolean;
  onConfirm: (customPrompt: string) => void;
  onCancel: () => void;
}

const SCRIM: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(28,25,23,0.18)',
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'fadeIn 150ms ease-out both',
};

const PANE: React.CSSProperties = {
  position: 'relative',
  width: 480,
  background: 'var(--surface)',
  border: '1px solid var(--line-strong)',
  borderRadius: 0,
  boxShadow:
    '0 1px 0 rgba(0,0,0,.02), 0 1px 2px rgba(0,0,0,.04), 0 14px 28px -12px rgba(28,25,23,.28), inset 0 0 0 1px var(--surface)',
  fontFamily: 'var(--ui-font)',
  animation: 'scaleIn 180ms cubic-bezier(.2,.8,.2,1) both',
};

const TAB_BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 30,
  padding: '0 8px 0 12px',
  background: 'var(--surface-muted)',
  borderBottom: '1px solid var(--line)',
};

const X_BTN: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--fg-subtle, var(--fg-muted))',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export default function DigestPromptDialog({ open, onConfirm, onCancel }: DigestPromptDialogProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setValue('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  // Digest role color, with accent fallback for themes that don't define it.
  const digest = 'var(--digest, var(--accent))';

  return (
    <div style={SCRIM} onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="digest-prompt-title"
        aria-describedby="digest-prompt-description"
        style={PANE}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={TAB_BAR}>
          <span
            style={{
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 10.5,
              letterSpacing: '.14em',
              textTransform: 'uppercase',
              color: digest,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span aria-hidden>⊕</span>
            <span id="digest-prompt-title">CREATE DIGEST</span>
          </span>
          <button type="button" onClick={onCancel} aria-label="Close" style={X_BTN}>×</button>
        </div>

        <div
          id="digest-prompt-description"
          style={{
            padding: '14px 16px 4px',
            fontFamily: 'var(--ui-font)',
            fontSize: 13,
            color: 'var(--fg-muted)',
            lineHeight: 1.45,
          }}
        >
          Summarize the selected conversations into one digest. Add optional guidance below, or leave it blank for a balanced summary.
        </div>

        <div style={{ padding: '8px 14px 14px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              border: '1px solid var(--line-strong)',
              background: 'var(--surface)',
              padding: '10px 12px',
            }}
          >
            <span
              aria-hidden
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 12.5,
                color: digest,
                paddingTop: 2,
                flexShrink: 0,
              }}
            >
              ›_
            </span>
            <textarea
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onConfirm(value.trim());
                }
                if (e.key === 'Escape') onCancel();
              }}
              aria-label="Digest guidance (optional)"
              placeholder="e.g. Focus on architecture decisions and summarize them as bullets…"
              rows={3}
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontFamily: 'var(--ui-font)',
                fontSize: 14,
                color: 'var(--fg)',
                resize: 'vertical',
                padding: 0,
              }}
            />
          </div>
        </div>

        <div style={{ padding: '0 14px 16px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 12,
              border: 'none',
              background: 'transparent',
              color: 'var(--fg-muted)',
              padding: '6px 10px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(value.trim())}
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 12,
              fontWeight: 600,
              border: `1px solid ${digest}`,
              background: digest,
              color: '#fff',
              padding: '6px 14px',
              cursor: 'pointer',
              borderRadius: 0,
            }}
          >
            Create digest
          </button>
        </div>
      </div>
    </div>
  );
}
