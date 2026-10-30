import React from 'react';
import type { HomeGreeting as Greeting } from 'michi-shared';
import { michiHomeEyebrow } from '../content/home/michiHomeFormat';
import '../content/home/michiHome.css';
import './homeCards.css';

/** Today's date, then the Meta agent's greeting and its second line when it wrote one. */
export function HomeGreeting({ greeting, now }: { greeting: Greeting | null; now: number }) {
  return (
    <div className="michi-home-hero home-greeting">
      <div className="michi-home-eyebrow">{michiHomeEyebrow(now, null)}</div>
      {greeting && (
        <h1 className="home-greeting__text">
          <span className="michi-home-headline__mark">_ </span>
          {greeting.text}
          {greeting.detail && <small className="home-greeting__detail">{greeting.detail}</small>}
        </h1>
      )}
    </div>
  );
}
