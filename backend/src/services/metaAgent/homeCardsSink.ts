import { log } from '../logger';
import { parseHomeCardsWrite, writeHomeCards } from '../homeCards/repository';
import type { HomeCardsSink } from './homeCardsGenerator';

/**
 * Stores generated Home cards with the same validation as a client write. A
 * set that fails it is logged and the previous cards stay.
 */
export const repositoryHomeCardsSink: HomeCardsSink = {
  write(ownerUserId, cards, now) {
    try {
      writeHomeCards(ownerUserId, parseHomeCardsWrite(cards), now);
    } catch (err) {
      log.warn('scheduler', 'generated Home cards rejected', { error: err instanceof Error ? err.message : String(err) });
    }
  },
};
