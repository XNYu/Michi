import React from 'react';

/** Shape of the JSON payload inside a ```citation code fence. */
export interface CitationFencePayload {
  nodeId: string;
  title: string;
  excerpt?: string;
  messageId?: string;
}

/**
 * Try to parse citation JSON from a code fence body.
 * Returns null on any parse/validation failure — the caller falls back
 * to rendering a regular code block.
 */
export function parseCitationFence(text: string): CitationFencePayload | null {
  try {
    const raw = JSON.parse(text.trim());
    if (typeof raw?.nodeId === 'string' && typeof raw?.title === 'string') {
      return {
        nodeId: raw.nodeId,
        title: raw.title,
        excerpt: typeof raw.excerpt === 'string' ? raw.excerpt : undefined,
        messageId: typeof raw.messageId === 'string' ? raw.messageId : undefined,
      };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Renders a single citation card from a ```citation code fence embedded
 * in the assistant's markdown answer text. The TPane click delegation
 * handles the citation data attributes.
 */
export function CitationCodeFenceView({ data }: { data: CitationFencePayload }) {
  return (
    <div className="t-citation-block">
      <button
        type="button"
        className="t-citation-card"
        data-mention-kind="citation"
        data-node-id={data.nodeId}
        title={`Jump to: ${data.title}`}
      >
        <div className="t-citation-card-title">
          <span className="t-citation-arrow">↗</span>
          {data.title}
        </div>
        {data.excerpt && (
          <div className="t-citation-card-excerpt">&ldquo;{data.excerpt}&rdquo;</div>
        )}
      </button>
    </div>
  );
}

/**
 * Scan markdown text for ```citation code fences and extract a map of
 * title → nodeId. Used to identify which `@Title` inline mentions should
 * render as clickable citation chips.
 */
export function extractCitationTargets(text: string): ReadonlyArray<{ label: string; nodeId: string }> {
  const fenceRe = /```citation\s*\n([\s\S]*?)```/gi;
  const targets: Array<{ label: string; nodeId: string }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const data = parseCitationFence(m[1]);
    if (data && !seen.has(data.nodeId)) {
      seen.add(data.nodeId);
      targets.push({ label: data.title, nodeId: data.nodeId });
    }
  }
  return targets;
}

/**
 * Pre-process assistant markdown text to convert `@Title` inline mentions
 * into `<span class="mention-chip">` HTML that rehype-raw + sanitize will
 * render as clickable citation chips.
 *
 * Only converts `@Title` when the title matches a citation code fence in
 * the same text — this prevents false positives on email addresses, Twitter
 * handles, or other @ patterns.
 */
export function highlightInlineCitations(text: string): string {
  const targets = extractCitationTargets(text);
  if (targets.length === 0) return text;

  let result = text;
  // Sort longest-first to avoid partial matches
  const sorted = [...targets].sort((a, b) => b.label.length - a.label.length);
  for (const { label, nodeId } of sorted) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match @Title that's NOT inside a code fence (```...```)
    // Simple heuristic: skip matches that occur between ``` markers.
    // We process the text in segments, only replacing outside fences.
    const segments: string[] = [];
    const fenceSplit = result.split(/(```[\s\S]*?```)/g);
    for (let i = 0; i < fenceSplit.length; i++) {
      if (i % 2 === 1) {
        // Inside a code fence — preserve as-is
        segments.push(fenceSplit[i]);
      } else {
        // Outside code fence — do replacements
        const re = new RegExp(`(?:^|(?<=\\s))@(${escaped})(?=\\s|[,;:!?）)}\\]"。、，]|$)`, 'giu');
        segments.push(fenceSplit[i].replace(re, (_full, matched: string) => {
          const htmlEsc = matched
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
          const nodeIdEsc = nodeId.replace(/"/g, '&quot;');
          return `<span class="mention-chip" data-mention="${htmlEsc}" data-mention-kind="citation" data-node-id="${nodeIdEsc}">@${htmlEsc}</span>`;
        }));
      }
    }
    result = segments.join('');
  }
  return result;
}
