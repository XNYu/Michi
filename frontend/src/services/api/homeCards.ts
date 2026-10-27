import type { HomeCard, HomeCardsDto } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId, connectionIdFromApiUrl } from '../../config/backendIdentity';
import { backendFetch } from './backendRequest';

export const EMPTY_HOME_CARDS: HomeCardsDto = { greeting: null, sets: [], generatedAt: null, inputFingerprint: null };

/** backendFetch maps workspaceId and pageId; a thread node id needs the same connection scope. */
function scopedCard(card: HomeCard, connectionId: string): HomeCard {
  const threadNodeId = card.source.threadNodeId;
  return threadNodeId ? { ...card, source: { ...card.source, threadNodeId: backendEntityId(connectionId, threadNodeId) } } : card;
}

export async function fetchHomeCards(base = backendApiBase(), signal?: AbortSignal): Promise<HomeCardsDto> {
  const response = await backendFetch(`${base}/home/cards`, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Home cards: HTTP ${response.status}`);
  const body = await response.json() as HomeCardsDto;
  const connectionId = connectionIdFromApiUrl(base);
  return { ...body, sets: body.sets.map((set) => ({ cards: set.cards.map((card) => scopedCard(card, connectionId)) })) };
}

export async function markHomeCardUsed(cardId: string, base = backendApiBase()): Promise<void> {
  const response = await backendFetch(`${base}/home/cards/${encodeURIComponent(cardId)}/used`, { method: 'POST' });
  if (!response.ok) throw new Error(`Home card used: HTTP ${response.status}`);
}
