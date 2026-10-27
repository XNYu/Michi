import React, { useEffect, useState } from 'react';
import type { PageComponentVersionSource } from 'michi-shared';

export function ComponentSourceAttribution({ source, onOpenSource }: {
  source?: PageComponentVersionSource | null;
  onOpenSource?: (source: Extract<PageComponentVersionSource, { kind: 'chat' | 'helper' }>) => void | boolean | Promise<void | boolean>;
}) {
  const [unavailable, setUnavailable] = useState(false);
  const sourceKey = !source || source.kind === 'user' ? source?.kind ?? '' : `${source.kind}:${source.nodeId}:${source.turnId}:${source.assistantId}`;
  useEffect(() => { setUnavailable(false); }, [sourceKey]);
  if (!source) return null;
  if (source.kind === 'user') return <span className="page-component-source">Saved by you</span>;
  return <span className="page-component-source">
    {source.kind === 'helper' ? 'Created with page helper' : 'Created in chat'}
    {unavailable ? <span role="status">Source unavailable</span> : onOpenSource && <button type="button" className="page-change-link" onClick={() => {
      void Promise.resolve(onOpenSource(source)).then(opened => { if (opened === false) setUnavailable(true); }).catch(() => setUnavailable(true));
    }}>Open source message</button>}
  </span>;
}
