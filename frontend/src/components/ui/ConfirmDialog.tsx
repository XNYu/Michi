import React from 'react';
import { ModalShell } from './ModalShell';
import { Button } from './controls';

/**
 * Themed replacement for the jarring native `window.confirm()` used across the
 * app for destructive actions (delete workspace, empty trash, move to trash,
 * clear API key, hard-reset update). Rendered once near the app root; call
 * sites open it via the imperative `confirmDialog()` promise below so even
 * non-React helpers (lib/*ContextMenu.ts) can use it without prop-threading.
 */
export interface ConfirmOptions {
  title?: string;
  /** Body message. Newlines are preserved. */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive styling (danger-filled confirm button). Default true. */
  danger?: boolean;
}

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };

let openConfirm: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

/**
 * Imperatively open the themed confirm dialog. Resolves true on confirm, false
 * on cancel / dismiss. Falls back to `window.confirm` if the provider isn't
 * mounted (e.g. in a unit test) so callers never hang.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (openConfirm) return openConfirm(opts);
  const text = typeof opts.message === 'string' ? opts.message : opts.title ?? 'Are you sure?';
  return Promise.resolve(window.confirm(text));
}

/** Mount once (App root). Registers the imperative `confirmDialog` handler. */
export function ConfirmDialogHost() {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);

  React.useEffect(() => {
    openConfirm = (opts) =>
      new Promise<boolean>((resolve) => {
        setPending((prev) => {
          // If a confirm is somehow already open, resolve it as cancelled so
          // its caller's promise never hangs, then show the new one.
          prev?.resolve(false);
          return { ...opts, resolve };
        });
      });
    return () => {
      openConfirm = null;
    };
  }, []);

  const close = React.useCallback(
    (ok: boolean) => {
      setPending((cur) => {
        cur?.resolve(ok);
        return null;
      });
    },
    [],
  );

  return (
    <ModalShell
      open={!!pending}
      onClose={() => close(false)}
      title={pending?.title ?? 'Confirm'}
      accent={pending?.danger === false ? 'var(--term-accent)' : 'var(--term-danger)'}
      width={420}
    >
      <div
        style={{
          padding: '16px 16px 8px',
          fontFamily: 'var(--ui-font)',
          fontSize: 13,
          color: 'var(--term-mid)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {pending?.message}
      </div>
      <div style={{ padding: '8px 16px 16px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="ghost" onClick={() => close(false)}>
          {pending?.cancelLabel ?? 'Cancel'}
        </Button>
        <Button variant="primary" danger={pending?.danger !== false} onClick={() => close(true)}>
          {pending?.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </ModalShell>
  );
}
