export interface PaneClaim {
  chatId: string;
  ownerToken: string;
  windowId: string;
  lastHeartbeat: number;
}

export interface ClaimResult {
  owner: boolean;
  heldBy?: string;
}

export interface PaneOwnershipOptions {
  now?: () => number;
  leaseTtlMs?: number;
}

export const DEFAULT_LEASE_TTL_MS = 30_000;

export class PaneOwnershipRegistry {
  private readonly claims = new Map<string, PaneClaim>();
  private readonly now: () => number;
  private readonly leaseTtlMs: number;

  constructor(opts: PaneOwnershipOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  private isLive(claim: PaneClaim | undefined): claim is PaneClaim {
    if (!claim) return false;
    return this.now() - claim.lastHeartbeat <= this.leaseTtlMs;
  }

  claim(chatId: string, ownerToken: string, windowId: string): ClaimResult {
    const existing = this.claims.get(chatId);
    if (this.isLive(existing)) {
      if (existing.ownerToken === ownerToken) {
        existing.lastHeartbeat = this.now();
        existing.windowId = windowId;
        return { owner: true };
      }
      return { owner: false, heldBy: existing.windowId };
    }
    this.claims.set(chatId, {
      chatId,
      ownerToken,
      windowId,
      lastHeartbeat: this.now(),
    });
    return { owner: true };
  }

  heartbeat(chatId: string, ownerToken: string): boolean {
    const existing = this.claims.get(chatId);
    if (!this.isLive(existing) || existing.ownerToken !== ownerToken) return false;
    existing.lastHeartbeat = this.now();
    return true;
  }

  release(chatId: string, ownerToken: string): void {
    const existing = this.claims.get(chatId);
    if (existing && existing.ownerToken === ownerToken) {
      this.claims.delete(chatId);
    }
  }

  isHeldBy(chatId: string, ownerToken: string): boolean {
    const existing = this.claims.get(chatId);
    return this.isLive(existing) && existing.ownerToken === ownerToken;
  }

  hasLiveClaim(chatId: string): boolean {
    return this.isLive(this.claims.get(chatId));
  }

  isHeldByAnotherToken(chatId: string, ownerToken: string): boolean {
    const existing = this.claims.get(chatId);
    return this.isLive(existing) && existing.ownerToken !== ownerToken;
  }
}

export const paneOwnership = new PaneOwnershipRegistry();
