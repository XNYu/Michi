import type { ChatNodeState } from './chatTypes';
import type { BranchOverviewEntry } from 'michi-shared';

/** First sentence: split on 。！？.!? keeping the delimiter. */
function firstSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/^[\s\S]*?[。！？.!?]/);
  return (m ? m[0] : t).trim();
}

/** Card body text: first sentence of the LATEST overview entry, with fallbacks. */
export function latestOverviewFirstSentence(node: ChatNodeState): string {
  const entries = node.branchOverviewEntries;
  if (entries && entries.length > 0) {
    const last = entries[entries.length - 1];
    if (last?.text?.trim()) return firstSentence(last.text);
  }
  if (node.title?.trim()) return node.title.trim();
  const firstUser = node.messages.find((m) => m.role === 'user');
  if (firstUser?.text?.trim()) return firstUser.text.trim();
  return '';
}

/** All overview entries, ascending by timestamp. Never mutates the source. */
export function overviewTrail(node: ChatNodeState): BranchOverviewEntry[] {
  const entries = node.branchOverviewEntries;
  if (!entries || entries.length === 0) return [];
  return [...entries].sort((a, b) => a.at - b.at);
}

/**
 * Ribbon text = "what this branch was opened to answer".
 * quotedText (manual selection) > pendingSpawnPrompt (fanout) > first user msg > null.
 */
export function branchRibbonText(node: ChatNodeState): string | null {
  const firstUser = node.messages.find((m) => m.role === 'user');
  const quoted = firstUser?.quotedText?.trim();
  if (quoted) return quoted;
  const spawn = node.pendingSpawnPrompt?.trim();
  if (spawn) return spawn;
  const userText = firstUser?.text?.trim();
  if (userText) return userText;
  return null;
}

export type NodeHeat = 'streaming' | 'hot' | 'warm' | 'cool' | 'cold';

const HOT_MS = 6 * 3600_000;       // 6h
const WARM_MS = 24 * 3600_000;     // 1d
const COOL_MS = 3 * 24 * 3600_000; // 3d

/** Visual heat tier from recency. Streaming overrides everything. */
export function nodeHeat(node: ChatNodeState, now: number): NodeHeat {
  if (node.status === 'streaming') return 'streaming';
  const last = node.lastAssistantAt ?? 0;
  if (!last) return 'cold';
  const age = now - last;
  if (age <= HOT_MS) return 'hot';
  if (age <= WARM_MS) return 'warm';
  if (age <= COOL_MS) return 'cool';
  return 'cold';
}
