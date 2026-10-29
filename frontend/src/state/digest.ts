import type { ChatNodeState, DigestState, Project } from './chatTypes';
import { digestSourceSnapshot } from '../lib/digestSource';
import { descendants, findTreeIdForNode } from './tree';

export type { DigestState };

/** Fingerprint exactly the source DTO sent to generation, excluding transient UI activity.
 * The version prefix makes older assistant-only watermarks stale once. */
export function computeSourceFingerprint(node: ChatNodeState): string {
  return `v2:${fnv1a32(JSON.stringify(digestSourceSnapshot(node)))}`;
}

function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Return the subset of `digest.sources` whose current fingerprint differs
 * from the stored one, OR whose node has been deleted. Empty = digest
 * is up-to-date.
 */
export function staleSources(
  digest: DigestState,
  nodes: Record<string, ChatNodeState>,
): string[] {
  const out: string[] = [];
  for (const sid of digest.sources) {
    const node = nodes[sid];
    if (!node || node.kind !== 'chat' || node.deletedAt) {
      out.push(sid);
      continue;
    }
    // A lazy-load placeholder's `messages` is empty but NOT authoritative — its
    // real trail is unfetched in the DB. Fingerprinting it would compare an
    // empty trail against the stored hash and report a FALSE stale (and a
    // rebuild would summarize nothing). Skip until its bodies load; the digest
    // keeps its current content. Re-evaluated once messages-loaded fires.
    if (node.messagesLoaded === false) continue;
    const fp = computeSourceFingerprint(node);
    if (fp !== digest.sourceFingerprints[sid]) out.push(sid);
  }
  return out;
}

/**
 * Live source list = every chat in the digest's originating tree, recomputed
 * from the project's current edges so chats branched after the digest was
 * generated count immediately. Falls back to the saved snapshot when the tree
 * can't be resolved (e.g. all original sources gone).
 */
export function liveDigestSources(
  digest: DigestState,
  project: Pick<Project, 'trees' | 'edges'>,
  nodes: Record<string, ChatNodeState>,
): string[] {
  const isAlive = (id: string) => {
    const n = nodes[id];
    return !!n && !n.deletedAt;
  };
  const anchor = digest.sources.find(isAlive);
  const treeId = anchor ? findTreeIdForNode(anchor, project) : null;
  const tree = treeId ? project.trees.find((t) => t.id === treeId) : null;
  if (!tree || !isAlive(tree.rootNodeId)) return digest.sources;
  const descIds = descendants(tree.rootNodeId, project.edges, isAlive);
  const ids = [tree.rootNodeId, ...descIds].filter((id) => {
    const n = nodes[id];
    return !!n && n.kind === 'chat' && !n.deletedAt;
  });
  return ids.length > 0 ? ids : digest.sources;
}

export interface ParsedDigest {
  tldr: string | null;
  sections: Array<{ title: string; sourceId: string | null; body: string }>;
  openThreads: string[];
}

/**
 * Parse Kiro's structured digest output. Tolerant: any missing marker is
 * ignored, not thrown. Input that doesn't match the schema at all returns
 * empty sections / null tldr so the caller can fall back to raw rendering.
 */
export function parseDigestStructure(md: string): ParsedDigest {
  const out: ParsedDigest = { tldr: null, sections: [], openThreads: [] };
  if (!md) return out;

  // New format: "# <title>\n<paragraph>" (any h1) or legacy "# Overview" or "TL;DR:"
  const h1Match = md.match(/^#\s+.+\s*\n([\s\S]*?)(?=\n##|$)/m);
  if (h1Match) {
    out.tldr = h1Match[1].trim();
  } else {
    const tldrMatch = md.match(/TL;DR:\s*([\s\S]*?)(?=\n\n|\n##|$)/);
    if (tldrMatch) out.tldr = tldrMatch[1].trim();
  }

  // New format: "## Open Questions & Future Directions" or legacy "Open Threads:"
  const oqMatch = md.match(/^##\s+Open Questions.*?\n([\s\S]*?)(?=\n##|$)/m);
  if (oqMatch) {
    out.openThreads = oqMatch[1]
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line.length > 0);
  } else {
    const otMatch = md.match(/Open Threads:\s*([\s\S]*?)(?=\n##|$)/);
    if (otMatch) {
      out.openThreads = otMatch[1]
        .split('\n')
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        .filter((line) => line.length > 0);
    }
  }

  // Skip known non-content sections when collecting body sections, but
  // track their positions as boundaries so they don't bleed into body text.
  const skipPattern = /^(overview|open questions|open questions & future directions)$/i;
  const sectionRegex = /^##\s+(?:§\d+\s+)?(.+)$/gm;
  const allMatches: Array<{ title: string; start: number; skip: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRegex.exec(md)) !== null) {
    allMatches.push({ title: m[1].trim(), start: m.index, skip: skipPattern.test(m[1].trim()) });
  }
  const matches = allMatches.filter((x) => !x.skip);
  for (let i = 0; i < matches.length; i++) {
    const startOfBody = md.indexOf('\n', matches[i].start) + 1;
    // End at the next section (whether skipped or not) or end of document
    const nextAny = allMatches.find((x) => x.start > matches[i].start);
    const endOfSection = nextAny ? nextAny.start : md.length;
    const rawBody = md.slice(startOfBody, endOfSection).trim();
    let body = rawBody;
    let sourceId: string | null = null;
    const sourceMatch = rawBody.match(/^source:\s*([\p{L}\p{N}_-]+)\s*\n?/u);
    if (sourceMatch) {
      sourceId = sourceMatch[1];
      body = rawBody.slice(sourceMatch[0].length).trim();
    }
    const otIdx = body.indexOf('Open Threads:');
    if (otIdx >= 0) body = body.slice(0, otIdx).trim();
    out.sections.push({ title: matches[i].title, sourceId, body });
  }

  return out;
}
