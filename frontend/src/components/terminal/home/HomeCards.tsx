import React from 'react';
import { Calendar, CirclePause, Lightbulb } from 'lucide-react';
import type { HomeCardKind } from 'michi-shared';
import { Button } from '../../ui/controls';
import { BranchIcon, ChevronRightIcon, DocIcon, RetryIcon } from '../icons';
import './homeCards.css';

/** What a card shows; both stored cards and the new-user cards fit it. */
export interface HomeCardView {
  id: string;
  kind: HomeCardKind;
  label: string;
  title: string;
  reason: string;
  buttonText: string;
}

const ICON_SIZE = 12;

const KIND_LOOK: Record<HomeCardKind, { tone: string; icon: React.ReactNode }> = {
  continue: { tone: 'accent', icon: <ChevronRightIcon size={ICON_SIZE} /> },
  try: { tone: 'mauve', icon: <BranchIcon size={ICON_SIZE} /> },
  'from-space': { tone: 'select', icon: <DocIcon size={ICON_SIZE} /> },
  review: { tone: 'digest', icon: <Calendar size={ICON_SIZE} strokeWidth={1.6} aria-hidden="true" /> },
  stalled: { tone: 'muted', icon: <CirclePause size={ICON_SIZE} strokeWidth={1.6} aria-hidden="true" /> },
  discover: { tone: 'muted', icon: <RetryIcon size={ICON_SIZE} /> },
  tip: { tone: 'muted', icon: <Lightbulb size={ICON_SIZE} strokeWidth={1.6} aria-hidden="true" /> },
};

function HomeCardButton({ card, onPick }: { card: HomeCardView; onPick: (id: string) => void }) {
  const look = KIND_LOOK[card.kind];
  return (
    <button type="button" className="home-card" data-tone={look.tone} data-testid="home-card" onClick={() => onPick(card.id)}>
      <span className="home-card__kind">{look.icon}<span className="home-card__label">{card.label}</span></span>
      <span className="home-card__title">{card.title}</span>
      <span className="home-card__reason">{card.reason}</span>
      <span className="home-card__go">{card.buttonText}<ChevronRightIcon size={ICON_SIZE} /></span>
    </button>
  );
}

/**
 * "Start here": six cards in a grid under the composer, with "Shuffle" to
 * show the next set (only when there is one) and a way to the Spaces Home.
 */
export function HomeCardGrid({
  cards,
  canShuffle,
  onShuffle,
  onOpenSpacesHome,
  onPick,
}: {
  cards: readonly HomeCardView[];
  canShuffle: boolean;
  onShuffle: () => void;
  onOpenSpacesHome: () => void;
  onPick: (id: string) => void;
}) {
  return (
    <section className="home-cards" aria-label="Start here">
      <div className="home-cards__head">
        <span className="michi-home-caption">Start here</span>
        <span className="home-cards__links">
          {canShuffle && (
            <Button variant="ghost" size="sm" className="home-cards__link" onClick={onShuffle}>
              <RetryIcon size={ICON_SIZE} />Shuffle
            </Button>
          )}
          <Button variant="ghost" size="sm" className="home-cards__link" onClick={onOpenSpacesHome}>
            Full summary on Pages Home<ChevronRightIcon size={ICON_SIZE} />
          </Button>
        </span>
      </div>
      <div className="home-cards__grid" data-count={cards.length}>
        {cards.map((card) => <HomeCardButton key={card.id} card={card} onPick={onPick} />)}
      </div>
    </section>
  );
}
