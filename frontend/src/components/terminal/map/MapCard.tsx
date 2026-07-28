import React from 'react';
import type { ChatNodeState } from '../../../state/chatTypes';
import { latestOverviewFirstSentence, nodeHeat, overviewTrail, type NodeHeat } from '../../../state/mapOverviewSelectors';
import { relativeTime } from '../../../lib/relativeTime';

export interface MapCardProps {
  node: ChatNodeState;
  ribbon: string | null;
  now: number;
  expanded: boolean;
  /** Deprecated: the Map wrapper owns expand/select clicks now. Kept optional
   *  so existing callers/tests still type-check. */
  onToggle?: () => void;
  onOpenPane: () => void;
  unread?: boolean;
  /** This card is on the hovered node's ancestor chain — light it up. */
  anc?: boolean;
  /** Some other node's chain is lit and this card isn't on it — recede. */
  dim?: boolean;
  /** Freshly spawned this frame — play the rise-in animation once. */
  grow?: boolean;
  /** Root of its tree — show the MAIN chip. */
  isMain?: boolean;
  /** This card is a merge source of the currently hovered merge node — accent border. */
  mergeSource?: boolean;
}

// Darkened accent used for the small ASKED / MAIN labels (the references render
// this at ~#a03d1b — a browner, quieter terracotta than the live accent).
const ACCENT_DARK = 'color-mix(in srgb, var(--term-accent) 80%, var(--term-fg))';
// Neutral ASKED strip fill (references: #f2efe8).
const ASKED_BG = 'color-mix(in srgb, var(--term-alt) 55%, var(--term-surface))';
// Trail container hairlines (references: #f2efe8).
const TRAIL_LINE = 'color-mix(in srgb, var(--term-alt) 70%, var(--term-surface))';

export function MapCard({
  node, ribbon, now, expanded, onOpenPane, unread, anc, dim, grow, isMain, mergeSource,
}: MapCardProps) {
  const heat = nodeHeat(node, now);
  const body = latestOverviewFirstSentence(node);
  const streaming = node.status === 'streaming';
  const msgCount = node.messages.length || node.messageCount || 0;
  const classNames = ['map-card',
    streaming ? 'map-card--breathe' : '',
    grow ? 'map-card--in' : '',
    anc ? 'map-card--anc' : '',
    mergeSource ? 'map-card--merge-source' : '',
  ].filter(Boolean).join(' ');
  return (
    <div
      data-map-node={node.nodeId}
      data-heat={heat}
      data-unread={unread ? 'true' : 'false'}
      className={classNames}
      style={{
        position: 'relative',
        width: '100%',
        background: 'var(--term-surface)',
        border: '1px solid color-mix(in srgb, var(--term-fg) 9%, transparent)',
        // Sharp corners everywhere — this is paper, not a chip.
        borderRadius: 0,
        overflow: 'hidden',
        cursor: 'pointer',
        opacity: dim ? 0.45 : 1,
        boxShadow: '0 2px 6px color-mix(in srgb, var(--term-fg) 5%, transparent), 0 16px 40px -20px color-mix(in srgb, var(--term-fg) 22%, transparent)',
      }}
    >
      {unread && <span className="map-card__unread-dot" />}

      {/* Heat bar — a 3px top strip whose warmth tracks recency. */}
      <div style={{ height: 3, width: '100%', background: heatBar(heat) }} />

      {/* ASKED strip — the question this branch was opened to answer. */}
      {ribbon && (
        <div data-map-ribbon style={{
          display: 'flex', gap: 8, alignItems: 'baseline',
          padding: '6px 13px', background: ASKED_BG,
          borderBottom: '1px solid var(--term-line)', whiteSpace: 'normal',
        }}>
          <span style={{
            fontFamily: 'var(--message-code-font)', fontSize: 8.5, letterSpacing: '.14em',
            color: ACCENT_DARK, flexShrink: 0,
          }}>ASKED</span>
          <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--term-mid)' }}>{ribbon}</span>
        </div>
      )}

      {/* Body — title, collapsed summary, meta chips. */}
      <div style={{ padding: '10px 13px 10px 14px' }}>
        <div style={{
          fontFamily: 'var(--message-code-font)', fontSize: 13, fontWeight: 650,
          lineHeight: 1.4, color: 'var(--term-fg)',
        }}>
          <span style={{ float: 'right', fontSize: 11, color: 'var(--term-faint)', fontWeight: 400, marginLeft: 6 }}>
            {expanded ? '▴' : '▾'}
          </span>
          {node.title ?? ''}
        </div>
        {!expanded && body && (
          <div style={{
            marginTop: 5, fontSize: 11, lineHeight: 1.55, color: 'var(--term-mid)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{body}</div>
        )}
        <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {isMain && <span style={chipStyle(ACCENT_DARK, 'var(--term-accent-f)')}>MAIN</span>}
          {msgCount > 0 && <span style={chipStyle('var(--term-muted)', 'var(--term-alt)')}>{msgCount} msgs</span>}
          {streaming ? (
            <span style={{ fontFamily: 'var(--message-code-font)', fontSize: 9.5, color: 'var(--term-accent)' }}>
              <span className="map-card__live-dot">●</span> streaming
            </span>
          ) : node.lastAssistantAt ? (
            <span style={{ fontFamily: 'var(--message-code-font)', fontSize: 9.5, color: 'var(--term-faint)' }}>
              {relativeTime(node.lastAssistantAt, now)}
            </span>
          ) : null}
        </div>
      </div>

      {/* Expanded — overview trail + hairline footer. Always mounted; the
          grid-rows 0fr→1fr trick animates the height smoothly both ways
          (auto-height, no content measuring). */}
      <div className="map-card__expand-wrap" data-expanded={expanded ? 'true' : 'false'}>
        <div className="map-card__expand-inner">
          <div style={{
            padding: '10px 14px',
            borderTop: `1px solid ${TRAIL_LINE}`,
            borderBottom: `1px solid ${TRAIL_LINE}`,
          }}>
            {overviewTrail(node).map((e, i, arr) => {
              const isLast = i === arr.length - 1;
              return (
                <div key={e.at} data-latest={isLast ? 'true' : 'false'}
                  style={{
                    marginBottom: i === arr.length - 1 ? 0 : 6, fontSize: 11, lineHeight: 1.55,
                    color: isLast ? 'var(--term-fg)' : 'var(--term-muted)',
                  }}>
                  <span style={{ fontFamily: 'var(--message-code-font)', fontSize: 8.5,
                    color: 'var(--term-faint)', marginRight: 5 }}>
                    {relativeTime(e.at, now)}</span>{e.text}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="map-card__footer"
            tabIndex={expanded ? 0 : -1}
            onClick={(ev) => { ev.stopPropagation(); onOpenPane(); }}
            style={{
              width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 13px', border: 'none', borderTop: '1px dashed var(--term-line)',
              fontFamily: 'var(--message-code-font)', fontSize: 10, letterSpacing: '.06em',
              color: 'var(--term-muted)', background: 'transparent', cursor: 'pointer',
            }}
          >
            <span>Open in pane</span>
            <span>↗</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function chipStyle(color: string, bg: string): React.CSSProperties {
  return {
    fontFamily: 'var(--message-code-font)', fontSize: 9.5, padding: '2px 8px',
    color, background: bg,
  };
}

/** Heat bar fill: warm gradient for recent nodes, plain cool line for old ones. */
function heatBar(heat: NodeHeat): string {
  switch (heat) {
    case 'streaming':
      return 'linear-gradient(90deg, var(--term-accent), color-mix(in srgb, var(--term-accent) 50%, var(--term-surface)), var(--term-accent))';
    case 'hot':
      return 'linear-gradient(90deg, var(--term-accent), color-mix(in srgb, var(--term-accent) 55%, var(--term-bg)))';
    case 'warm':
      return 'linear-gradient(90deg, color-mix(in srgb, var(--term-accent) 70%, var(--term-bg)), color-mix(in srgb, var(--term-accent) 30%, var(--term-line)))';
    case 'cool':
      return 'color-mix(in srgb, var(--term-line) 80%, var(--term-bg))';
    default: // cold
      return 'color-mix(in srgb, var(--term-line) 60%, var(--term-bg))';
  }
}
