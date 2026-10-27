import type { HomeCardView } from './HomeCards';

/** What a new-user card does when clicked. */
export type OnboardingAction =
  | { type: 'compose'; prompt: string }
  | { type: 'mention' }
  | { type: 'spaces' };

export interface OnboardingCard extends HomeCardView {
  action: OnboardingAction;
}

/** Shown instead of the inspiration cards while there is no conversation yet. */
export const ONBOARDING_CARDS: readonly OnboardingCard[] = [
  {
    id: 'onboarding:conversation', kind: 'continue', label: 'Get started · Chat',
    title: 'Start a conversation',
    reason: 'Ask anything. Michi starts a thread in the workspace shown under the box.',
    buttonText: 'Write one',
    action: { type: 'compose', prompt: 'Help me plan what to work on today.' },
  },
  {
    id: 'onboarding:branch', kind: 'try', label: 'Worth a try · Branches',
    title: 'Try branching',
    reason: 'After a reply, branch a follow-up into its own pane and try two directions side by side.',
    buttonText: 'Try it',
    action: { type: 'compose', prompt: 'Give me two different ways to approach my next task, so I can branch and try both.' },
  },
  {
    id: 'onboarding:mention', kind: 'tip', label: 'Tip',
    title: '@ a page',
    reason: 'Type @ in the box to bring a page, a file or an earlier reply into the conversation.',
    buttonText: 'Type @',
    action: { type: 'mention' },
  },
  {
    id: 'onboarding:spaces', kind: 'from-space', label: 'Pages',
    title: 'Open Pages',
    reason: 'Pages keeps a home page for each workspace, written from your conversations.',
    buttonText: 'Open Pages',
    action: { type: 'spaces' },
  },
];
