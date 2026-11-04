/**
 * In-memory cache of extracted documents for fetch_content, so reading a long
 * page part by part (offset paging) fetches it once. Bounded by entry count,
 * total text size and age; the least recently used entry goes first.
 */

export interface CacheLimits {
    maxEntries: number;
    /** Sum of the sizes of all entries. */
    maxTotalSize: number;
    ttlMs: number;
}

interface Entry<T> { value: T; size: number; expiresAt: number }

export class ContentCache<T> {
    private readonly entries = new Map<string, Entry<T>>();
    private totalSize = 0;

    constructor(private readonly limits: CacheLimits, private readonly now: () => number = Date.now) {}

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.now()) {
            this.delete(key);
            return undefined;
        }
        // Map order is recency order.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T, size: number): void {
        this.delete(key);
        const now = this.now();
        for (const [existing, entry] of this.entries) {
            if (entry.expiresAt <= now) this.delete(existing);
        }
        if (size > this.limits.maxTotalSize) return;
        this.entries.set(key, { value, size, expiresAt: now + this.limits.ttlMs });
        this.totalSize += size;
        for (const [oldest] of this.entries) {
            if (this.entries.size <= this.limits.maxEntries && this.totalSize <= this.limits.maxTotalSize) break;
            this.delete(oldest);
        }
    }

    private delete(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        this.totalSize -= entry.size;
    }
}
