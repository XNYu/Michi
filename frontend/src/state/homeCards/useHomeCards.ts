import { useCallback, useEffect, useState } from 'react';
import type { HomeCard, HomeCardsDto } from 'michi-shared';
import { useBackendScope } from '../../hooks/useBackendScope';
import { EMPTY_HOME_CARDS, fetchHomeCards, markHomeCardUsed } from '../../services/api/homeCards';

export interface HomeCardsState {
  cards: HomeCardsDto;
  /** False until the first answer (or failure) for the current backend. */
  loaded: boolean;
  markUsed: (card: HomeCard) => void;
}

/**
 * The active backend's greeting and card sets, read once per backend. A
 * failed read shows no cards rather than an error: Home works without them.
 */
export function useHomeCards(): HomeCardsState {
  const { base, key } = useBackendScope();
  const [state, setState] = useState<{ key: string; cards: HomeCardsDto } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchHomeCards(base, controller.signal)
      .then((cards) => { if (!controller.signal.aborted) setState({ key, cards }); })
      .catch(() => { if (!controller.signal.aborted) setState({ key, cards: EMPTY_HOME_CARDS }); });
    return () => controller.abort();
  }, [base, key]);

  // A clicked card stays on screen until the next read; the backend leaves it out from then on.
  const markUsed = useCallback((card: HomeCard) => {
    void markHomeCardUsed(card.id, base).catch(() => {});
  }, [base]);

  const current = state?.key === key ? state : null;
  return { cards: current?.cards ?? EMPTY_HOME_CARDS, loaded: current !== null, markUsed };
}
