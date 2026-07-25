// frontend/src/components/terminal/map/MapTimeline.tsx
import React from 'react';
import type { ChatNodeState } from '../../../state/chatTypes';
import type { BranchOverviewEntry } from 'michi-shared';
import { overviewTrail } from '../../../state/mapOverviewSelectors';
import { assistantAnswerVisibleText } from '../../../state/assistantBlocks';
import { relativeTime } from '../../../lib/relativeTime';

export interface MapTimelineProps {
  nodes: ChatNodeState[];
  now: number;
  onOpenPane: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
  /** child nodeId -> parent nodeId (branch edges). A non-root lane's first
   *  event is its fork point, labelled "· forked". Optional so unit tests can
   *  render lanes without topology. */
  parentOf?: Map<string, string>;
}

const RAIL_W = 200;
const CHIP_W = 240;
const ACCENT_DARK = 'color-mix(in srgb, var(--term-accent) 80%, var(--term-fg))';

/**
 * Events shown for one lane. Prefer the agent-authored overview trail; when a
 * branch has none (older chats, or a branch that never produced overview
 * metadata) synthesize a single entry from its latest answer so the lane is
 * never blank — every branch reads as a row on the timeline.
 */
/** First sentence: split on 。！？.!? keeping the delimiter, capped for chips. */
function firstSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/^[\s\S]*?[。！？.!?]/);
  const s = (m ? m[0] : t).trim();
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

function laneEvents(node: ChatNodeState, now: number): BranchOverviewEntry[] {
  const trail = overviewTrail(node);
  if (trail.length > 0) return trail;
  // No agent-authored overview: synthesize one entry from the conversation so
  // the lane still shows something. Prefer the latest answer (real content),
  // then the first question. Skip empty nodes rather than echo the title.
  const lastAssistant = [...node.messages].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant) {
    const text = assistantAnswerVisibleText(lastAssistant).trim();
    if (text) return [{ at: node.lastAssistantAt ?? now, text: firstSentence(text) }];
  }
  const firstUser = node.messages.find((m) => m.role === 'user');
  const prompt = firstUser?.text?.trim();
  if (prompt) return [{ at: node.lastAssistantAt ?? now, text: firstSentence(prompt) }];
  return [];
}

/** M/D from an epoch-ms timestamp (local). */
function monthDay(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function MapTimeline({ nodes, now, onOpenPane, onFocus, parentOf }: MapTimelineProps) {
  // Shared linear time axis across every lane: earliest event → left, now → right.
  const allTimes = nodes.flatMap((n) => laneEvents(n, now).map((e) => e.at));
  const minT = allTimes.length ? Math.min(...allTimes) : now;
  const span = Math.max(1, now - minT);
  // Fraction along the track [0,1] for a timestamp (clamped).
  const frac = (at: number) => Math.min(1, Math.max(0, (at - minT) / span));

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'transparent' }} className="term-scrollbar">
      <div style={{
        maxWidth: 1140, margin: '0 auto', padding: '52px 24px 48px',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {/* Date rule: earliest date ——— today */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          fontFamily: 'var(--message-code-font)', fontSize: 10, color: 'var(--term-muted)',
        }}>
          <span>{monthDay(minT)}</span>
          <span style={{ flex: 1, height: 1, background: 'color-mix(in srgb, var(--term-line) 70%, var(--term-bg))' }} />
          <span style={{ color: 'var(--term-accent)', fontWeight: 600 }}>today</span>
        </div>

        {nodes.map((n) => {
          const trail = laneEvents(n, now);
          const streaming = n.status === 'streaming';
          const isRoot = !parentOf || parentOf.get(n.nodeId) == null;
          return (
            <div
              key={n.nodeId}
              className={streaming ? 'map-card map-card--breathe' : 'map-card'}
              style={{
                display: 'flex', gap: 18, alignItems: 'flex-start',
                background: 'var(--term-surface)',
                border: `1px solid ${streaming
                  ? 'color-mix(in srgb, var(--term-accent) 25%, transparent)'
                  : 'color-mix(in srgb, var(--term-fg) 7%, transparent)'}`,
                borderRadius: 0,
                padding: '14px 18px',
                boxShadow: '0 2px 6px color-mix(in srgb, var(--term-fg) 4%, transparent), 0 14px 34px -22px color-mix(in srgb, var(--term-fg) 20%, transparent)',
              }}
            >
              {/* Left rail: branch title + status chip. */}
              <div style={{ flex: `0 0 ${RAIL_W}px`, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--message-code-font)', fontSize: 12.5, fontWeight: 650, lineHeight: 1.35,
                  color: isRoot ? ACCENT_DARK : 'var(--term-fg)',
                }}>{n.title ?? ''}</div>
                {(streaming || isRoot) && (
                  <span style={{
                    display: 'inline-block', marginTop: 7,
                    fontFamily: 'var(--message-code-font)', fontSize: 9.5, padding: '2px 8px',
                    color: streaming ? 'var(--term-accent)' : ACCENT_DARK,
                    background: 'var(--term-accent-f)',
                  }}>
                    {streaming
                      ? <><span className="map-card__live-dot">●</span> LIVE</>
                      : 'MAIN'}
                  </span>
                )}
              </div>

              {/* Right: event chips placed by time along the shared axis. */}
              <div style={{ position: 'relative', flex: 1, minWidth: CHIP_W, minHeight: 56 }}>
                {trail.map((e, i) => {
                  const live = streaming && i === trail.length - 1;
                  const forked = !isRoot && i === 0;
                  return (
                    <button
                      key={e.at}
                      type="button"
                      onClick={() => onFocus(n.nodeId)}
                      className="map-timeline__chip"
                      style={{
                        position: 'absolute', top: 0,
                        left: `calc(${frac(e.at)} * (100% - ${CHIP_W}px))`,
                        width: CHIP_W, textAlign: 'left', cursor: 'pointer', border: '1px solid',
                        borderColor: live
                          ? 'color-mix(in srgb, var(--term-accent) 30%, transparent)'
                          : 'color-mix(in srgb, var(--term-line) 70%, var(--term-bg))',
                        background: live
                          ? 'color-mix(in srgb, var(--term-accent-f) 40%, var(--term-surface))'
                          : 'var(--term-bg)',
                        padding: '7px 10px', borderRadius: 0,
                      }}
                    >
                      <div style={{
                        fontFamily: 'var(--message-code-font)', fontSize: 8.5,
                        color: live ? 'var(--term-accent)' : 'var(--term-faint)',
                      }}>
                        {live && <span className="map-card__live-dot">● </span>}
                        {live ? 'now' : `${relativeTime(e.at, now)}${forked ? ' · forked' : ''}`}
                      </div>
                      <div style={{
                        marginTop: 2, fontSize: 10.5, lineHeight: 1.4, color: 'var(--term-fg)',
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                      }}>{e.text}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
