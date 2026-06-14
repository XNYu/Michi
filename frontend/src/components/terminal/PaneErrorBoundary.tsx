import React from 'react';

interface Props {
  paneId: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class PaneErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[PaneErrorBoundary:${this.props.paneId}]`, error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.paneId !== this.props.paneId && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 20,
          background: 'var(--term-surface)',
          color: 'var(--term-muted)',
          fontFamily: 'var(--ui-font)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        <div style={{ color: 'var(--term-fg)', fontSize: 13 }}>
          this pane crashed
        </div>
        <pre
          style={{
            maxWidth: '100%',
            maxHeight: 160,
            overflow: 'auto',
            background: 'var(--term-bg)',
            border: '1px solid var(--term-line)',
            padding: 8,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            textAlign: 'left',
          }}
        >
          {error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          style={{
            background: 'transparent',
            border: '1px solid var(--term-line)',
            color: 'var(--term-fg)',
            padding: '4px 10px',
            fontFamily: 'var(--ui-font)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          retry
        </button>
      </div>
    );
  }
}
