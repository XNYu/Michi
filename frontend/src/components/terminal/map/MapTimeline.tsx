// frontend/src/components/terminal/map/MapTimeline.tsx
import React from 'react';
import type { ChatNodeState } from '../../../state/chatTypes';
import { overviewTrail } from '../../../state/mapOverviewSelectors';
import { layoutTimelineX } from './timelineLayout';
import { relativeTime } from '../../../lib/relativeTime';

export interface MapTimelineProps {
  nodes: ChatNodeState[];
  now: number;
  onOpenPane: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
}

const LANE_LABEL_W = 158;
const LANE_H = 74;

export function MapTimeline({ nodes, now, onOpenPane, onFocus }: MapTimelineProps) {
  // Collect all entries across nodes to build a shared non-linear x axis.
  const allEvents = nodes.flatMap((n) => overviewTrail(n).map((e) => ({ at: e.at })));
  const layout = layoutTimelineX(allEvents);
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ position: 'relative', minWidth: LANE_LABEL_W + layout.totalWidth }}>
        {/* seams spanning all lanes */}
        {layout.seams.map((s, i) => (
          <div key={i} data-timeline-seam style={{
            position: 'absolute', top: 0, bottom: 0, left: LANE_LABEL_W + s.x, width: s.width,
            background: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--term-fg) 3%, transparent) 0 5px, transparent 5px 6px)',
            borderLeft: '1px dashed var(--term-line-s)', borderRight: '1px dashed var(--term-line-s)',
          }} />
        ))}
        {nodes.map((n) => (
          <div key={n.nodeId} style={{ display: 'flex', borderBottom: '1px solid var(--term-line)', minHeight: LANE_H }}>
            <div style={{ flex: `0 0 ${LANE_LABEL_W}px`, padding: '10px', borderRight: '1px solid var(--term-line)',
              borderLeft: '3px solid var(--term-accent)', fontFamily: 'var(--message-code-font)',
              fontSize: 11, fontWeight: 600, color: 'var(--term-fg)' }}>{n.title ?? ''}</div>
            <div style={{ position: 'relative', flex: 1 }}>
              {overviewTrail(n).map((e, i) => (
                <div key={e.at} onClick={() => { onFocus(n.nodeId); }}
                  style={{ position: 'absolute', top: 9, left: layout.xForEvent(e.at, i) - 75, width: 150,
                    background: 'var(--term-alt)', border: '1px solid var(--term-line)', borderRadius: 5,
                    padding: '5px 8px 6px', cursor: 'pointer' }}>
                  <div style={{ fontFamily: 'var(--message-code-font)', fontSize: 8, color: 'var(--term-faint)' }}>
                    {relativeTime(e.at, now)}</div>
                  <div style={{ marginTop: 2, fontSize: 10.5, lineHeight: 1.4, color: 'var(--term-fg)',
                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {e.text}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
