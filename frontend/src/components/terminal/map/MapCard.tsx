import React from 'react';
import type { ChatNodeState } from '../../../state/chatTypes';
import { latestOverviewFirstSentence, nodeHeat, overviewTrail } from '../../../state/mapOverviewSelectors';
import { assistantAnswerVisibleText } from '../../../state/assistantBlocks';
import { relativeTime } from '../../../lib/relativeTime';

export interface MapCardProps {
  node: ChatNodeState;
  ribbon: string | null;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenPane: () => void;
  unread?: boolean;
}

export function MapCard({ node, ribbon, now, expanded, onToggle, onOpenPane, unread }: MapCardProps) {
  const heat = nodeHeat(node, now);
  const body = latestOverviewFirstSentence(node);
  const streaming = node.status === 'streaming';
  return (
    <div
      data-map-node={node.nodeId}
      data-heat={heat}
      data-unread={unread ? 'true' : 'false'}
      className={streaming ? 'map-card--breathe' : undefined}
      onClick={onToggle}
      style={{
        position: 'relative',
        width: expanded ? 420 : 230,
        background: 'var(--term-surface)',
        border: '1px solid var(--term-line)',
        borderLeft: `3px solid ${heatColor(heat)}`,
        borderRadius: 7,
        cursor: 'pointer',
        opacity: heat === 'cold' ? 0.62 : 1,
      }}
    >
      {ribbon && (
        <div data-map-ribbon style={{
          padding: '5px 11px', background: 'var(--term-accent-f)',
          borderBottom: '1px solid var(--term-line)', fontSize: 10.5, fontStyle: 'italic',
          color: 'var(--term-accent)', lineHeight: 1.4, whiteSpace: 'normal',
        }}>↳ {ribbon}</div>
      )}
      <div style={{ padding: '8px 11px 8px 12px' }}>
        {unread && <span className="map-card__unread-dot" />}
        <div style={{ fontFamily: 'var(--message-code-font)', fontSize: 12, fontWeight: 600,
          color: 'var(--term-fg)' }}>{node.title ?? ''}</div>
        {body && <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.5, color: 'var(--term-mid)',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{body}</div>}
        <div style={{ marginTop: 6, fontFamily: 'var(--message-code-font)', fontSize: 9.5,
          color: 'var(--term-faint)' }}>
          {node.lastAssistantAt ? relativeTime(node.lastAssistantAt, now) : ''}
          {streaming && <span style={{ color: 'var(--term-accent)', marginLeft: 8 }}>● streaming</span>}
        </div>
      </div>
      {expanded && (
        <div style={{ borderTop: '1px dashed var(--term-line)' }}>
          <div style={{ padding: '9px 11px 9px 12px', borderBottom: '1px solid var(--term-line)' }}>
            <div style={{ fontFamily: 'var(--message-code-font)', fontSize: 9,
              letterSpacing: '.05em', color: 'var(--term-faint)', textTransform: 'uppercase',
              marginBottom: 4 }}>Overview · 轨迹</div>
            {overviewTrail(node).map((e, i, arr) => {
              const isLast = i === arr.length - 1;
              return (
                <div key={e.at} data-latest={isLast ? 'true' : 'false'}
                  style={{ marginBottom: 5, fontSize: 11, lineHeight: 1.55,
                    color: isLast ? 'var(--term-fg)' : 'var(--term-mid)' }}>
                  <span style={{ fontFamily: 'var(--message-code-font)', fontSize: 8.5,
                    color: 'var(--term-faint)', marginRight: 5 }}>
                    {relativeTime(e.at, now)}</span>{e.text}
                </div>
              );
            })}
          </div>
          {lastReply(node) && (
            <div style={{ padding: '9px 11px 9px 12px', borderBottom: '1px solid var(--term-line)',
              fontSize: 11, lineHeight: 1.55, color: 'var(--term-muted)', fontStyle: 'italic',
              borderLeft: '2px solid var(--term-line)' }}>{lastReply(node)}</div>
          )}
          <div style={{ padding: '9px 11px 10px 12px' }}>
            <button onClick={(ev) => { ev.stopPropagation(); onOpenPane(); }}
              style={{ fontFamily: 'var(--message-code-font)', fontSize: 10, padding: '4px 10px',
                border: '1px solid var(--term-accent)', color: 'var(--term-accent)',
                background: 'var(--term-accent-f)', cursor: 'pointer' }}>↗ 打开 pane</button>
          </div>
        </div>
      )}
    </div>
  );
}

function lastReply(node: ChatNodeState): string {
  const msg = [...node.messages].reverse().find((m) => m.role === 'assistant');
  if (!msg) return '';
  const t = assistantAnswerVisibleText(msg).trim();
  return t.length > 220 ? t.slice(0, 220) + '…' : t;
}

function heatColor(heat: string): string {
  switch (heat) {
    case 'streaming': case 'hot': return 'var(--term-accent)';
    case 'warm': return 'var(--term-line-s)';
    case 'cool': return 'var(--term-line)';
    default: return 'var(--term-line)';
  }
}
