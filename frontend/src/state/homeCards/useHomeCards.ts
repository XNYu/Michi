import { useCallback, useEffect, useState } from 'react';
import type { HomeCard, HomeCardsDto } from 'michi-shared';
import { useBackendScope } from '../../hooks/useBackendScope';
import { BACKEND_CONNECTION_UNAVAILABLE } from '../../config/backendConnectionState';
import { EMPTY_HOME_CARDS, fetchHomeCards, markHomeCardUsed } from '../../services/api/homeCards';

export interface HomeCardsState {
  cards: HomeCardsDto;
  /** False until the first answer (or failure) for the current backend. */
  loaded: boolean;
  markUsed: (card: HomeCard) => void;
}

type Answer = { key: string; cards: HomeCardsDto };

/**
 * The last successful answer per connection, so coming back to Home shows it
 * at once instead of the default hero, while a fresh read replaces it. An
 * entry is reused only for the same backend scope key (connection and its
 * generation). Memory only: remote content stays out of localStorage, and
 * an unavailable connection drops its entry.
 */
const lastAnswers = new Map<string, Answer>();
let listening = false;

function remember(connectionId: string, answer: Answer): void {
  lastAnswers.set(connectionId, answer);
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(BACKEND_CONNECTION_UNAVAILABLE, (event) => {
    const id = (event as CustomEvent<{ connectionId?: string }>).detail?.connectionId;
    if (id) lastAnswers.delete(id);
  });
}

function remembered(connectionId: string, key: string): Answer | null {
  const entry = lastAnswers.get(connectionId);
  return entry?.key === key ? entry : null;
}

/** The backend leaves a clicked card out of its next answer; so does the remembered one. */
function withoutCard(cards: HomeCardsDto, cardId: string): HomeCardsDto {
  const sets = cards.sets
    .map((set) => ({ cards: set.cards.filter((entry) => entry.id !== cardId) }))
    .filter((set) => set.cards.length > 0);
  return { ...cards, sets };
}

export function __resetHomeCardsCacheForTests(): void {
  lastAnswers.clear();
}

/**
 * The active backend's greeting and card sets, read each time Home mounts.
 * The last answer for the same backend shows until the read finishes. A
 * failed read shows no cards rather than an error: Home works without them.
 */
export function useHomeCards(): HomeCardsState {
  const { base, connectionId, key } = useBackendScope();
  const [state, setState] = useState<Answer | null>(() => remembered(connectionId, key));

  useEffect(() => {
    const controller = new AbortController();
    fetchHomeCards(base, controller.signal)
      .then((cards) => {
        if (controller.signal.aborted) return;
        remember(connectionId, { key, cards });
        setState({ key, cards });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (lastAnswers.get(connectionId)?.key === key) lastAnswers.delete(connectionId);
        setState({ key, cards: EMPTY_HOME_CARDS });
      });
    return () => controller.abort();
  }, [base, connectionId, key]);

  // A clicked card stays on screen until the next read; the backend leaves it out from then on.
  const markUsed = useCallback((card: HomeCard) => {
    const entry = lastAnswers.get(connectionId);
    if (entry?.key === key) lastAnswers.set(connectionId, { key, cards: withoutCard(entry.cards, card.id) });
    void markHomeCardUsed(card.id, base).catch(() => {});
  }, [base, connectionId, key]);

  const current = state?.key === key ? state : remembered(connectionId, key);
  return { cards: current?.cards ?? EMPTY_HOME_CARDS, loaded: current !== null, markUsed };
}
