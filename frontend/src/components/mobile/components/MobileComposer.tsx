import React from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  streaming: boolean;
  readOnly?: boolean;
  budgetChars: number;
  /** Soft warn threshold (yellow) */
  warnThreshold?: number;
  /** Hard block threshold (red, send disabled) */
  blockThreshold?: number;
}

const DEFAULT_WARN = 8000;
const DEFAULT_BLOCK = 32000;

/**
 * Mobile composer: textarea (auto-grow 1-5 rows), slash pills, send/stop.
 *
 * @-mention picker is intentionally out-of-scope here; mobile keyboards already
 * surface autocompletion, and the desktop @-popup is wired to a portal that
 * doesn't translate well to a soft-keyboard environment. Slash commands are
 * pillared below the textarea so the user can tap to insert a prefix.
 */
export default function MobileComposer({
  value,
  onChange,
  onSend,
  onCancel,
  streaming,
  readOnly = false,
  budgetChars,
  warnThreshold = DEFAULT_WARN,
  blockThreshold = DEFAULT_BLOCK,
}: Props) {
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea between 1 and 5 lines.
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(120, ta.scrollHeight)}px`;
  }, [value]);

  const overBlock = budgetChars > blockThreshold;
  const overWarn = budgetChars > warnThreshold;
  const trimmed = value.trim();
  const sendDisabled = readOnly || (streaming ? false : !trimmed || overBlock);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter sends. Plain Enter inserts newline (mobile soft keyboards
    // typically have a Send key but we don't want to fight onChange).
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!sendDisabled && !readOnly) onSend();
    }
  };

  const insertSlash = (prefix: string) => {
    const next = value.startsWith(prefix) ? value : `${prefix}${value}`;
    if (readOnly) return;
    onChange(next);
    taRef.current?.focus();
  };

  return (
    <div className="m-composer">
      <div className="m-composer-row">
        <textarea
          ref={taRef}
          className="m-composer-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={readOnly ? 'Viewing — another window is editing' : streaming ? 'streaming…' : 'Message kiro'}
          rows={1}
          disabled={streaming || readOnly}
          autoCapitalize="sentences"
        />
        {budgetChars > 0 && (
          <BudgetRing
            chars={budgetChars}
            warn={warnThreshold}
            block={blockThreshold}
          />
        )}
        {streaming && !readOnly ? (
          <button
            className="m-composer-btn"
            data-stop="true"
            onClick={onCancel}
            aria-label="Stop"
          >
            ■
          </button>
        ) : (
          <button
            className="m-composer-btn"
            data-primary="true"
            onClick={onSend}
            disabled={sendDisabled}
            aria-label="Send"
          >
            ▲
          </button>
        )}
      </div>
      <div className="m-slash-pills">
        <button className="m-slash-pill" onClick={() => insertSlash('/branch ')} disabled={readOnly}>/branch</button>
        <button className="m-slash-pill" onClick={() => insertSlash('/fanout ')} disabled={readOnly}>/fanout</button>
        <button className="m-slash-pill" onClick={() => insertSlash('/btw ')} disabled={readOnly}>/btw</button>
        {overBlock && (
          <span style={{ color: '#dc2626', fontSize: 10.5, marginLeft: 'auto' }}>
            over budget
          </span>
        )}
      </div>
    </div>
  );
}

function BudgetRing({ chars, warn, block }: { chars: number; warn: number; block: number }) {
  const pct = Math.min(1, chars / block);
  const color = chars > block ? '#dc2626' : chars > warn ? '#f59e0b' : 'var(--term-muted)';
  const r = 10;
  const c = 2 * Math.PI * r;
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      style={{ flexShrink: 0 }}
      aria-label={`${chars} characters`}
    >
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--term-line)" strokeWidth="2" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}
