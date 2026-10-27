import React from 'react';
import type { HomeGreeting as Greeting } from 'michi-shared';
import { Button } from '../../ui/controls';
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

export const HOME_STARTERS: readonly { label: string; prompt: string }[] = [
  {
    label: 'Recap today',
    prompt: "Review today's conversations and page updates in this workspace and give me a concise daily recap. Summarize completed work, key decisions, unresolved blockers, and the next steps. Distinguish confirmed progress from plans or assumptions, and link to the relevant threads or pages so I can follow up. If there is no activity today or some sources are unavailable, say so clearly.",
  },
  {
    label: 'Draft release notes',
    prompt: 'Draft release notes for this workspace based on completed changes since the latest release. Identify the previous release and the sources you used; if the release boundary is unclear, state the date range you are using. Group the notes into new features, improvements, fixes, and any breaking changes or migration steps, focusing on the impact for users. Link to supporting threads, pages, or commits, and flag anything that still needs verification before publication. Only describe changes as released or deployed when the sources confirm that status.',
  },
  {
    label: 'Find threads stalled 3+ days',
    prompt: 'Find unfinished threads in this workspace that have made no meaningful progress for at least 3 days. Read their latest messages and distinguish stalled work from completed, archived, or intentionally paused work. For each stalled thread, include a link, its last meaningful update, the unresolved task or blocker, and one concrete next action. Prioritize the threads that most need attention, and mark uncertain status rather than inferring a blocker from inactivity alone.',
  },
  {
    label: 'Plan tomorrow',
    prompt: "Review recent conversations, page updates, and open tasks in this workspace, then propose a practical plan for tomorrow. Recommend up to three main priorities based on urgency, impact, and dependencies. For each priority, explain why it matters, define a concrete outcome, and suggest the first action. Call out blockers or decisions I need to resolve, link to the relevant threads or pages, and state any assumptions about deadlines or available time. Keep the plan realistic and leave it for me to review.",
  },
];

/** Keep labels short while inserting a complete, editable task into the composer. */
export function HomeStarters({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="home-starters" role="group" aria-label="Quick starts">
      {HOME_STARTERS.map(({ label, prompt }) => (
        <Button key={label} className="home-starter" onClick={() => onPick(prompt)}>{label}</Button>
      ))}
    </div>
  );
}
