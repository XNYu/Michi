import React, { useState } from 'react';
import type { BlockSource } from 'michi-shared';
import type { ChangeSource } from 'michi-shared';

export interface ExactPageSource extends BlockSource {
  kind: 'chat' | 'helper';
}

export interface SourceTraceProps {
  source: ChangeSource;
  onOpenSource: (source: ExactPageSource) => void | boolean | Promise<void | boolean>;
}

/** Source links carry the complete trusted tuple so the caller can navigate to
 * the exact assistant message in its owning backend/workspace. */
export function SourceTrace({ source, onOpenSource }: SourceTraceProps) {
  const [unavailable, setUnavailable] = useState<Set<string>>(() => new Set());
  const open = (item: ExactPageSource) => {
    const key = `${item.nodeId}:${item.turnId}:${item.assistantId}`;
    void Promise.resolve(onOpenSource(item)).then((opened) => {
      if (opened === false) setUnavailable((current) => new Set(current).add(key));
    }).catch(() => setUnavailable((current) => new Set(current).add(key)));
  };
  if (source.kind === 'user') return null;

  if (source.kind === 'chat' || source.kind === 'helper') {
    return (
      <div className="page-change-source">
        <span>Source · {source.kind === 'helper' ? 'Page helper' : 'Chat'}</span>
        {unavailable.has(`${source.nodeId}:${source.turnId}:${source.assistantId}`)
          ? <span role="status">Source unavailable</span>
          : <button type="button" className="page-change-link" onClick={() => open(source)}>Open exact message</button>}
      </div>
    );
  }

  if (source.kind === 'maintenance') {
    const runSource: ExactPageSource = { kind: 'chat', nodeId: source.nodeId, turnId: source.turnId, assistantId: source.assistantId };
    const runKey = `${runSource.nodeId}:${runSource.turnId}:${runSource.assistantId}`;
    return (
      <div className="page-change-source">
        <span>Maintenance run</span>
        {unavailable.has(runKey)
          ? <span role="status">Run unavailable</span>
          : <button type="button" className="page-change-link" onClick={() => open(runSource)}>Open maintenance run</button>}
        {source.evidence.map((evidence) => (
          unavailable.has(`${evidence.nodeId}:${evidence.turnId}:${evidence.assistantId}`) ? <span key={`${evidence.nodeId}:${evidence.turnId}:${evidence.assistantId}`} role="status">Source unavailable</span> : <button
            key={`${evidence.nodeId}:${evidence.turnId}:${evidence.assistantId}`}
            type="button"
            className="page-change-link"
            onClick={() => open({ kind: 'chat', nodeId: evidence.nodeId, turnId: evidence.turnId, assistantId: evidence.messageId ?? evidence.assistantId })}
          >
            Source · Open exact message
          </button>
        ))}
      </div>
    );
  }

  if (source.kind === 'component') {
    return (
      <div className="page-change-source">
        <span>Component · v{source.version}</span>
        {'pageId' in source
          ? <span>Page component</span>
          : <span>Custom database view</span>}
      </div>
    );
  }
  return null;
}
