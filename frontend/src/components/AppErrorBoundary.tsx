import React from 'react';

const MAX_AUTO_RETRIES = 2;
const AUTO_RETRY_DELAY_MS = 150;

interface Props {
  /** When any resetKey changes the boundary clears its error automatically. */
  resetKeys?: ReadonlyArray<unknown>;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  retryCount: number;
  /** Snapshot of resetKeys at the time of the last error. */
  prevResetKeys: ReadonlyArray<unknown>;
}

/**
 * Top-level ErrorBoundary that wraps the entire React tree.
 *
 * Recovery strategy:
 * 1. First few crashes → silent auto-retry after a short delay.
 *    Most render-phase race conditions (e.g. render-phase setState in
 *    PanePresentationProvider during rapid workspace switching) are transient
 *    and resolve on the next mount when state is rebuilt from backend hydration.
 * 2. If the crash persists beyond MAX_AUTO_RETRIES → show a fallback UI with
 *    a manual reload button so the user is never stuck on a blank screen.
 * 3. When `resetKeys` change (e.g. workspace/tree navigation completes),
 *    the boundary auto-clears — no manual intervention needed.
 */
export default class AppErrorBoundary extends React.Component<Props, State> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  state: State = {
    error: null,
    retryCount: 0,
    prevResetKeys: this.props.resetKeys ?? [],
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const nextKeys = props.resetKeys ?? [];
    if (state.error && !keysEqual(state.prevResetKeys, nextKeys)) {
      // A parent re-rendered with new keys (e.g. workspace switch completed).
      // Clear the error — the new subtree may render fine.
      return { error: null, retryCount: 0, prevResetKeys: nextKeys };
    }
    return { prevResetKeys: nextKeys };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[AppErrorBoundary] React tree crashed', error, info.componentStack);
  }

  componentWillUnmount() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
  }

  private scheduleRetry() {
    if (this.retryTimer !== null) return; // already scheduled
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState((prev) => ({
        error: null,
        retryCount: prev.retryCount + 1,
      }));
    }, AUTO_RETRY_DELAY_MS);
  }

  render() {
    const { error, retryCount } = this.state;

    if (!error) return this.props.children;

    // Transient crash: auto-retry silently. Render nothing for a brief
    // moment — the user sees a flicker at most.
    if (retryCount < MAX_AUTO_RETRIES) {
      this.scheduleRetry();
      return null;
    }

    // Persistent crash: show a helpful fallback.
    return <CrashFallback error={error} onReload={() => window.location.reload()} />;
  }
}

function CrashFallback({ error, onReload }: { error: Error; onReload: () => void }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 32,
        background: 'var(--term-bg, #f5f2ee)',
        color: 'var(--term-fg, #333)',
        fontFamily: 'var(--ui-font, system-ui, sans-serif)',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 4 }}>⚠</div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>
        Michi ran into a problem
      </div>
      <div style={{ fontSize: 12, color: 'var(--term-muted, #888)', maxWidth: 420 }}>
        The interface crashed and couldn't recover automatically.
        Your data is safe — reloading will restore everything.
      </div>
      <pre
        style={{
          maxWidth: 480,
          maxHeight: 120,
          overflow: 'auto',
          background: 'var(--term-surface, #eee)',
          border: '1px solid var(--term-line, #ddd)',
          borderRadius: 4,
          padding: 8,
          fontSize: 11,
          whiteSpace: 'pre-wrap',
          textAlign: 'left',
          color: 'var(--term-muted, #888)',
        }}
      >
        {error.message}
      </pre>
      <button
        onClick={onReload}
        style={{
          background: 'var(--term-fg, #333)',
          color: 'var(--term-bg, #f5f2ee)',
          border: 'none',
          borderRadius: 4,
          padding: '6px 16px',
          fontFamily: 'var(--ui-font, system-ui, sans-serif)',
          fontSize: 12,
          cursor: 'pointer',
          marginTop: 4,
        }}
      >
        reload
      </button>
    </div>
  );
}

function keysEqual(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}
