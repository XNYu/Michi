import React from 'react';
import type { ChatNodeState } from '../../../state/chatTypes';
import type { BranchOverviewEntry } from 'michi-shared';
import { overviewTrail } from '../../../state/mapOverviewSelectors';
import { assistantAnswerVisibleText } from '../../../state/assistantBlocks';
import { buildElasticScale, layoutChips, formatAxisLabel, formatGap } from './timeScale';
import type { ElasticScale, ChipInput } from './timeScale';

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
const CHIP_H = 56;
const ROW_GAP = 6;
const LANE_PADDING = 14;
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

/**
 * Resolve the best available timestamp for an event. Legacy entries with at=0
 * fall back to the node's last assistant time or message timestamps.
 */
function resolveEventTime(entry: BranchOverviewEntry, node: ChatNodeState, now: number): number {
  if (entry.at > 0) return entry.at;
  // Legacy at=0: try node's last message createdAt, then lastAssistantAt, then now
  const lastMsg = [...node.messages].reverse().find((m) => m.createdAt);
  if (lastMsg?.createdAt) return lastMsg.createdAt;
  if (node.lastAssistantAt) return node.lastAssistantAt;
  return now;
}

export function MapTimeline({ nodes, now, onOpenPane, onFocus, parentOf }: MapTimelineProps) {
  // Collect all event times across all lanes (with legacy fallback resolution)
  const allTimes: number[] = [];
  const laneData = nodes.map((n) => {
    const events = laneEvents(n, now);
    const resolved = events.map((e) => ({
      ...e,
      resolvedAt: resolveEventTime(e, n, now),
    }));
    resolved.forEach((r) => allTimes.push(r.resolvedAt));
    return { node: n, events: resolved };
  });

  // Build the elastic scale from tree-start to tree-end (not "now")
  const scale = buildElasticScale(allTimes);
  const span = scale.end - scale.start;

  // Determine if the latest event is "today" (within last 12h)
  const isRecent = allTimes.length > 0 && (now - Math.max(...allTimes)) < 12 * 3_600_000;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'transparent' }} className="term-scrollbar">
      <div style={{
        maxWidth: 1140, margin: '0 auto', padding: '52px 24px 48px',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {/* Axis: start label —— break markers —— end label */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          fontFamily: 'var(--message-code-font)', fontSize: 10, color: 'var(--term-muted)',
        }}>
          <span>{allTimes.length > 0 ? formatAxisLabel(scale.start, span) : ''}</span>
          <span style={{ flex: 1, height: 1, background: 'color-mix(in srgb, var(--term-line) 70%, var(--term-bg))', position: 'relative' }}>
            {/* Break markers on the axis rule */}
            {scale.breaks.map((b, i) => (
              <span
                key={i}
                title={`${formatGap(b.realGap)} idle`}
                style={{
                  position: 'absolute',
                  left: `${(b.fracStart + b.fracEnd) / 2 * 100}%`,
                  top: -7,
                  transform: 'translateX(-50%)',
                  fontFamily: 'var(--message-code-font)',
                  fontSize: 9,
                  color: 'var(--term-faint)',
                  whiteSpace: 'nowrap',
                }}
              >
                ⁄⁄ {formatGap(b.realGap)}
              </span>
            ))}
          </span>
          <span style={{ color: isRecent ? 'var(--term-accent)' : 'var(--term-muted)', fontWeight: isRecent ? 600 : 400 }}>
            {allTimes.length > 0 ? formatAxisLabel(scale.end, span) : ''}
          </span>
        </div>

        {laneData.map(({ node: n, events }) => {
          const streaming = n.status === 'streaming';
          const isRoot = !parentOf || parentOf.get(n.nodeId) == null;
          return (
            <LaneRow
              key={n.nodeId}
              node={n}
              events={events}
              streaming={streaming}
              isRoot={isRoot}
              scale={scale}
              now={now}
              onFocus={onFocus}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Lane row with chip collision layout ────────────────────────────────────────

interface ResolvedEvent extends BranchOverviewEntry {
  resolvedAt: number;
}

interface LaneRowProps {
  node: ChatNodeState;
  events: ResolvedEvent[];
  streaming: boolean;
  isRoot: boolean;
  scale: ElasticScale;
  now: number;
  onFocus: (nodeId: string) => void;
}

function LaneRow({ node, events, streaming, isRoot, scale, now, onFocus }: LaneRowProps) {
  // Measure the available track width via ref
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = React.useState(600); // sensible default

  React.useEffect(() => {
    if (!trackRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setTrackWidth(w);
    });
    obs.observe(trackRef.current);
    return () => obs.disconnect();
  }, []);

  // Compute chip layout with collision detection
  const chipInputs: ChipInput[] = events.map((e, i) => ({
    at: e.resolvedAt,
    key: `${e.resolvedAt}-${i}`,
    width: CHIP_W,
  }));

  const layouts = layoutChips(chipInputs, scale, {
    trackWidth,
    chipWidth: CHIP_W,
    gap: 6,
  });

  // Map key → layout for O(1) lookup
  const layoutMap = new Map(layouts.map((l) => [l.key, l]));
  const maxRow = layouts.length > 0 ? Math.max(...layouts.map((l) => l.row)) : 0;
  const trackHeight = Math.max(CHIP_H, (maxRow + 1) * (CHIP_H + ROW_GAP) + LANE_PADDING);

  return (
    <div
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
        }}>{node.title ?? ''}</div>
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

      {/* Right: event chips positioned by elastic scale with collision layout. */}
      <div
        ref={trackRef}
        style={{ position: 'relative', flex: 1, minWidth: CHIP_W, minHeight: trackHeight }}
      >
        {/* Break markers inside the track */}
        {scale.breaks.map((b, i) => {
          const leftPct = b.fracStart * 100;
          const widthPct = Math.max((b.fracEnd - b.fracStart) * 100, 1.5);
          return (
            <div
              key={`break-${i}`}
              title={`${formatGap(b.realGap)} idle`}
              style={{
                position: 'absolute', top: 0, bottom: 0,
                left: `${leftPct}%`, width: `${widthPct}%`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--term-faint)',
                fontFamily: 'var(--message-code-font)', fontSize: 10,
                borderLeft: '1px dashed var(--term-line)',
                borderRight: '1px dashed var(--term-line)',
                background: `repeating-linear-gradient(
                  135deg,
                  transparent, transparent 3px,
                  color-mix(in srgb, var(--term-line) 30%, transparent) 3px,
                  color-mix(in srgb, var(--term-line) 30%, transparent) 4px
                )`,
                pointerEvents: 'none',
                opacity: 0.6,
              }}
            >
              ⁄⁄
            </div>
          );
        })}

        {/* Chips */}
        {events.map((e, i) => {
          const key = `${e.resolvedAt}-${i}`;
          const layout = layoutMap.get(key);
          if (!layout) return null;

          const live = streaming && i === events.length - 1;
          const isForked = !isRoot && i === 0;

          return (
            <button
              key={key}
              type="button"
              onClick={() => onFocus(node.nodeId)}
              className="map-timeline__chip"
              style={{
                position: 'absolute',
                top: layout.row * (CHIP_H + ROW_GAP),
                left: layout.x,
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
                {live ? 'now' : `${formatAxisLabel(e.resolvedAt, scale.end - scale.start)}${isForked ? ' · forked' : ''}`}
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
}
