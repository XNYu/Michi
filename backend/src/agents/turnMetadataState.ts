import type { FollowUpsExperimentMode } from './followUpsExperiment';

type MetadataTool = 'set_branch_overview' | 'set_follow_ups';

export interface MetadataValidation {
  status: 'inactive' | 'complete' | 'repair' | 'fail_open';
  missingTools: MetadataTool[];
  response: Record<string, unknown>;
}

/**
 * Per-turn Michi metadata policy. Adapters retain their native stop hooks and
 * completion boundaries; this state contains no SDK, transport or queue work.
 */
export class TurnMetadataState {
  private active = false;
  private followUpsSet = false;
  private overviewSet = false;
  private stopBlocked = false;
  private repairing = false;
  private suppressedChunks = 0;
  private suppressedThoughts = 0;
  private outputBoundaryPending = false;
  private sentinelTail = '';
  private sentinelsComplete = false;
  private silentOverviewTail = false;

  constructor(private readonly mode: FollowUpsExperimentMode) {}

  get validationActive(): boolean { return this.active; }

  acceptsFollowUps(enabled: boolean): boolean {
    return enabled && this.mode === 'hook-tool';
  }

  begin(): void {
    this.reset();
    this.active = true;
  }

  setFollowUps(values: readonly string[], enabled: boolean): string[] | null {
    if (!this.acceptsFollowUps(enabled)) return null;
    const cleaned = values.map((value) => value.trim()).filter(Boolean).slice(0, 3);
    if (!cleaned.length) return null;
    if (this.active) this.followUpsSet = true;
    this.outputBoundaryPending = true;
    return cleaned;
  }

  setOverview(value: string): { overview: string; beforeSentinelsComplete: boolean } | null {
    const overview = value.trim();
    if (!overview) return null;
    if (this.active) this.overviewSet = true;
    const beforeSentinelsComplete = this.mode === 'sentinel' && !this.sentinelsComplete;
    if (this.mode === 'sentinel' && this.sentinelsComplete) this.silentOverviewTail = true;
    return { overview, beforeSentinelsComplete };
  }

  validate(enableFollowUps: boolean): MetadataValidation {
    if (!this.active) return { status: 'inactive', missingTools: [], response: {} };
    const missingTools: MetadataTool[] = [];
    if (!this.overviewSet) missingTools.push('set_branch_overview');
    if (this.acceptsFollowUps(enableFollowUps) && !this.followUpsSet) missingTools.push('set_follow_ups');
    if (!missingTools.length) return { status: 'complete', missingTools, response: {} };
    if (this.stopBlocked) return { status: 'fail_open', missingTools, response: {} };
    this.stopBlocked = true;
    this.repairing = true;
    const instructions = missingTools.map((tool) => tool === 'set_branch_overview'
      ? 'For set_branch_overview, provide 1-3 concise sentences about what this turn did.'
      : 'For set_follow_ups, provide exactly three user-voice questions.');
    return {
      status: 'repair', missingTools,
      response: {
        decision: 'block',
        reason: `Before finishing, call the missing Michi metadata tools: ${missingTools.join(', ')}. `
          + `${instructions.join(' ')} Do not repeat the user-facing answer.`,
      },
    };
  }

  observeChunk(text: string, enableFollowUps: boolean): void {
    if (!enableFollowUps || this.mode !== 'sentinel' || this.sentinelsComplete) return;
    this.sentinelTail = `${this.sentinelTail}${text}`.slice(-12_000);
    this.sentinelsComplete = /\[FOLLOW-UP\s+3\s*\/\s*3\s*:\s*[^\]\r\n]*\]/i.test(this.sentinelTail);
  }

  suppressOutput(kind: string): boolean {
    if (!this.repairing && !this.silentOverviewTail) return false;
    if (kind === 'chunk') { this.suppressedChunks++; return true; }
    if (kind === 'thought') { this.suppressedThoughts++; return true; }
    return false;
  }

  completeOutputBoundary(): boolean {
    if (!this.outputBoundaryPending) return false;
    this.outputBoundaryPending = false;
    return true;
  }

  finish(): { chunks: number; thoughts: number } {
    const suppressed = { chunks: this.suppressedChunks, thoughts: this.suppressedThoughts };
    this.reset();
    return suppressed;
  }

  private reset(): void {
    this.active = false;
    this.followUpsSet = false;
    this.overviewSet = false;
    this.stopBlocked = false;
    this.repairing = false;
    this.suppressedChunks = 0;
    this.suppressedThoughts = 0;
    this.outputBoundaryPending = false;
    this.sentinelTail = '';
    this.sentinelsComplete = false;
    this.silentOverviewTail = false;
  }
}
