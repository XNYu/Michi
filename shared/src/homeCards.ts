import type { PageDto } from './pages/types';

/**
 * Michi Home inspiration cards: a greeting and a few sets of six cards that
 * the Meta agent writes when it has new input. "换一批" rotates the sets on the
 * client; a clicked card is marked used and not shown again.
 *
 * Backend routes (mounted under /api):
 *   GET  /home/cards                 -> HomeCardsDto
 *   PUT  /home/cards                 HomeCardsWrite -> HomeCardsDto (local-only writer)
 *   POST /home/cards/:cardId/used    -> HomeCardUsedDto
 */

export const HOME_CARD_KINDS = ['continue', 'try', 'from-space', 'review', 'stalled', 'discover', 'tip'] as const;
export type HomeCardKind = (typeof HOME_CARD_KINDS)[number];

export const HOME_CARD_LIMITS = {
  sets: 8,
  cardsPerSet: 6,
  tipsPerSet: 1,
  id: 200,
  label: 80,
  title: 200,
  reason: 500,
  buttonText: 40,
  prompt: 4000,
  greeting: 300,
  fingerprint: 200,
} as const;

/** What a card is about. Every field is optional: a tip has no source. */
export interface HomeCardSource {
  workspaceId?: string;
  pageId?: string;
  threadNodeId?: string;
}

export interface HomeCard {
  /** Chosen by the writer; reusing an id for the same suggestion keeps it hidden once used. */
  id: string;
  kind: HomeCardKind;
  /** The tag line above the title, in the user's language, e.g. "接着做 · rabbitholes". `kind` picks its icon and colour. */
  label: string;
  source: HomeCardSource;
  title: string;
  reason: string;
  buttonText: string;
  /** Put into the composer when the card is clicked; never sent by itself. */
  prompt: string;
  /** Where the conversation should start; null leaves the composer's workspace as it is. */
  workspaceId: string | null;
}

export interface HomeCardSet {
  cards: HomeCard[];
}

export interface HomeGreeting {
  text: string;
  detail: string | null;
}

/** GET /api/home/cards. Used cards are already left out of `sets`; empty sets are dropped. */
export interface HomeCardsDto {
  /** The complete area below the composer, replacing the recommendation cards. */
  contentMode?: 'default' | 'page' | 'hidden';
  contentPage?: PageDto | null;
  /** User selected custom/hidden cards; do not substitute onboarding recommendations. */
  cardsCustomized?: boolean;
  greeting: HomeGreeting | null;
  sets: HomeCardSet[];
  generatedAt: number | null;
  inputFingerprint: string | null;
}

/** PUT /api/home/cards: replaces the owner's greeting and sets. */
export interface HomeCardsWrite {
  greeting: HomeGreeting | null;
  sets: HomeCardSet[];
  /** What the writer read, so a later run can tell whether anything is new. */
  inputFingerprint: string | null;
}

export interface HomeCardUsedDto {
  cardId: string;
  usedAt: number;
}
