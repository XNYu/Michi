import type { ParentContinuationSink } from './runs/ports';

export interface ParentContinuationDeliveryInput {
  deliveryId: string;
  requestedTurnId: string;
  ownerUserId: string;
  workspaceId: string;
  parentRunId: string | null;
  parentNodeId: string | null;
  parentTurnId: string | null;
  runIds: string[];
  handoff: string;
}

export type ParentDeliveryState = 'pending' | 'delivering' | 'delivered' | 'undeliverable';

export interface ParentDeliveryRecord {
  deliveryId: string;
  requestedTurnId: string;
  state: ParentDeliveryState;
}

/** Durable store implemented by the T16 integration. createPending and state
 * transitions must be compare-and-set/idempotent for a deliveryId. */
export interface ParentDeliveryRecordStore {
  get(deliveryId: string): ParentDeliveryRecord | null;
  createPending(input: ParentContinuationDeliveryInput): ParentDeliveryRecord;
  markDelivering(deliveryId: string): ParentDeliveryRecord;
  markTerminal(deliveryId: string, state: 'delivered' | 'undeliverable'): ParentDeliveryRecord;
}

export interface ParentContinuationTarget {
  continueParent(input: ParentContinuationDeliveryInput): Promise<'delivered' | 'undeliverable'>;
}

/** Idempotent ParentContinuationSink. A retry after a crash may call the
 * target again, so requestedTurnId is stable and the target must return the
 * existing durable continuation rather than create a second turn. */
export class AgentRunParentDelivery implements ParentContinuationSink {
  private readonly inFlight = new Map<string, Promise<'delivered' | 'undeliverable'>>();

  constructor(
    private readonly records: ParentDeliveryRecordStore,
    private readonly target: ParentContinuationTarget,
  ) {}

  deliver(input: ParentContinuationDeliveryInput): Promise<'delivered' | 'undeliverable'> {
    const existing = this.inFlight.get(input.deliveryId);
    if (existing) return existing;
    const delivery = this.deliverOnce(input).finally(() => this.inFlight.delete(input.deliveryId));
    this.inFlight.set(input.deliveryId, delivery);
    return delivery;
  }

  private async deliverOnce(input: ParentContinuationDeliveryInput): Promise<'delivered' | 'undeliverable'> {
    let record = this.records.get(input.deliveryId) ?? this.records.createPending(input);
    if (record.requestedTurnId !== input.requestedTurnId) {
      throw new Error('Parent delivery id was reused with a different requested turn');
    }
    if (record.state === 'delivered' || record.state === 'undeliverable') return record.state;
    record = this.records.markDelivering(input.deliveryId);
    if (record.state === 'delivered' || record.state === 'undeliverable') return record.state;
    const result = await this.target.continueParent(input);
    this.records.markTerminal(input.deliveryId, result);
    return result;
  }
}
