import React from 'react';

/**
 * Shared interactive-control primitives. Before these existed, ghost /
 * secondary / primary buttons, toggle switches, and text inputs were
 * re-inlined per call site (~7 button copies, 3 toggle copies, ~13 input
 * copies), which is why the same control looked subtly different depending on
 * which drawer / modal it lived in. All visual state (hover, focus, disabled,
 * danger) is CSS-driven via `.ui-btn` / `.ui-input` in index.css so callers
 * stop sprinkling inline style objects.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'action';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. Defaults to 'secondary' (bordered, transparent fill). */
  variant?: ButtonVariant;
  /** Compact padding + smaller text. Pairs with any variant. */
  size?: 'sm';
  /** Recolor to the danger token (fill for primary, text for the rest). */
  danger?: boolean;
}

/** Text button. `<Button variant="primary">Save</Button>`. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size, danger, className, children, type = 'button', ...rest },
  ref,
) {
  const cls = [
    'ui-btn',
    variant !== 'secondary' && `ui-btn--${variant}`,
    size === 'sm' && 'ui-btn--sm',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} data-danger={danger ? 'true' : undefined} {...rest}>
      {children}
    </button>
  );
});

export interface SwitchProps {
  on: boolean;
  onChange: (next: boolean) => void;
  'aria-label'?: string;
  disabled?: boolean;
}

/**
 * The 28×16 sliding toggle switch. Its markup was written verbatim three times
 * in Settings alone; this is the single source. Purely presentational — wrap it
 * in a ClickableRow / label for the tappable text.
 */
export function Switch({ on, onChange, disabled, ...rest }: SwitchProps) {
  const ariaLabel = rest['aria-label'];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      style={{
        width: 28,
        height: 16,
        padding: 0,
        border: '1px solid var(--term-line-s)',
        background: on ? 'var(--term-accent)' : 'var(--term-surface)',
        position: 'relative',
        display: 'inline-block',
        flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background var(--t-soft) var(--t-ease)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: on ? 13 : 1,
          width: 12,
          height: 12,
          background: on ? 'var(--term-surface)' : 'var(--term-line-s)',
          transition: 'left var(--t-soft) var(--t-ease)',
        }}
      />
    </button>
  );
}
