import React, { useState, useEffect, useRef } from 'react';
import { ModalShell } from './ui/ModalShell';
import { Button } from './ui/controls';

interface DigestPromptDialogProps {
  open: boolean;
  onConfirm: (customPrompt: string) => void;
  onCancel: () => void;
}

export default function DigestPromptDialog({ open, onConfirm, onCancel }: DigestPromptDialogProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setValue('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Digest role color, with accent fallback for themes that don't define it.
  const digest = 'var(--term-digest, var(--term-accent))';

  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      title="Create digest"
      titleGlyph="⊕"
      accent={digest}
      width={480}
      aria-label="Create digest"
    >
      <div
        style={{
          padding: '14px 16px 4px',
          fontFamily: 'var(--ui-font)',
          fontSize: 13,
          color: 'var(--term-mid)',
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
            border: '1px solid var(--term-line-s)',
            background: 'var(--term-surface)',
            padding: '10px 12px',
          }}
        >
          <span
            aria-hidden
            style={{
              fontFamily: 'var(--mono-font, ui-monospace, monospace)',
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
              color: 'var(--term-fg)',
              resize: 'vertical',
              padding: 0,
            }}
          />
        </div>
      </div>

      <div style={{ padding: '0 14px 16px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => onConfirm(value.trim())}
          style={{ borderColor: digest, background: digest }}
        >
          Create digest
        </Button>
      </div>
    </ModalShell>
  );
}
