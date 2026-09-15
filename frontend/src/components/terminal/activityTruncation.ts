// Truncation for the Activity view: show only the most recent N trees by
// default, with a "Show more" toggle. Activity is a "what's moving lately"
// lens, not an archive — anything older belongs to Structure view / search.

/** Trees rendered before the first "Show more". */
export const ACTIVITY_PREVIEW_LIMIT = 20;
/** Trees revealed per "Show more" click. */
export const ACTIVITY_PAGE_SIZE = 20;

export interface TruncatedBuckets<K extends string, T> {
  /** Buckets in `order`, each holding only the items that survived the cap. Empty buckets are omitted. */
  visible: Map<K, T[]>;
  /** Items removed by the cap across all non-exempt buckets. */
  hidden: number;
}

/**
 * Walk buckets in `order`, keeping the first `limit` items across all
 * non-exempt buckets. Exempt buckets (e.g. `now`) are passed through whole and
 * never count toward the cap — a streaming tree must always be visible.
 *
 * `groups` is expected to already be sorted (bucket priority, then recency),
 * so keeping the head of the walk equals keeping the most recent trees.
 */
export function truncateActivityBuckets<K extends string, T>(
  groups: ReadonlyMap<K, readonly T[]>,
  order: readonly K[],
  limit: number,
  exempt: ReadonlySet<K>,
): TruncatedBuckets<K, T> {
  const visible = new Map<K, T[]>();
  let counted = 0;
  let hidden = 0;
  for (const bucket of order) {
    const items = groups.get(bucket);
    if (!items || items.length === 0) continue;
    if (exempt.has(bucket)) {
      visible.set(bucket, [...items]);
      continue;
    }
    const room = Math.max(0, limit - counted);
    const kept = items.slice(0, room);
    counted += kept.length;
    hidden += items.length - kept.length;
    if (kept.length > 0) visible.set(bucket, kept);
  }
  return { visible, hidden };
}
