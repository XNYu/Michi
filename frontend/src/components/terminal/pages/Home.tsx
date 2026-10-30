import React, { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import type { HomeCard } from 'michi-shared';
import { CHATS_WORKSPACE_ID, useChatStore, useStructuralSelector } from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import ManageComposer, { type ManageComposerHandle } from '../manage/ManageComposer';
import { HomeWorkspaceChip } from '../HomeWorkspaceChip';
import { buildContinueItems } from './homeContinue';
import { useMinuteClock } from '../content/home/useMinuteClock';
import { isSystemWorkspace } from '../../../state/assistant/systemWorkspace';
import { useReturnFromSystemWorkspace } from '../../../state/assistant/userWorkspace';
import { entryPageForArea } from '../../../state/shellArea';
import { useHomeCards } from '../../../state/homeCards/useHomeCards';
import { HomeGreeting } from '../home/HomeGreeting';
import { HomeCardGrid } from '../home/HomeCards';
import { useHomeRecommendations } from '../../../state/prefs';
import { ONBOARDING_CARDS } from '../home/onboardingCards';

const ChatHomeDocument = lazy(() => import('../home/ChatHomeDocument'));

interface HomeProps {
  onSubmitted: () => void;
}

/** Where Home's larger chips stop fitting on one toolbar row, with a typical
 *  workspace name and model: first the chips drop their text, then the agent
 *  chip goes. Measured on the toolbar's border box. */
const HOME_TOOLBAR_COMPACTION = { glyphsBelow: 640, hideAgentBelow: 480 };
/** Below this toolbar width one row cannot also hold the workspace and
 *  permission chips (a phone, or a narrow pane), so they move to a tray
 *  under the composer and the toolbar keeps one row. */
const HOME_TRAY_BELOW = 480;

function openSpacesHome() {
  window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: entryPageForArea('spaces', 'home') } }));
}

export default function TerminalHome({ onSubmitted }: HomeProps) {
  const { activeProject, projects, selectProject, hydrated, enterChatsWorkspace } = useChatStore();

  const liveProjects = useMemo(
    () => projects.filter((p) => !p.deletedAt && !p.archivedAt && !isSystemWorkspace(p)),
    [projects],
  );
  // Opening the assistant as a pane makes its hidden workspace the active
  // one. Home starts threads in the active workspace, so it moves back to one
  // of the user's — a thread started here must never land out of sight.
  const homeProject = activeProject && !isSystemWorkspace(activeProject) ? activeProject : null;
  useReturnFromSystemWorkspace(true, activeProject, projects, selectProject);
  // The chip presents the folder-less Chats workspace as "no workspace", the
  // state its × leads to, rather than as one more workspace to pick.
  const chipProjects = useMemo(() => liveProjects.filter((p) => p.id !== CHATS_WORKSPACE_ID), [liveProjects]);
  const chipActive = homeProject?.id === CHATS_WORKSPACE_ID ? null : homeProject;

  const hasConversationSelector = useCallback(
    (nodesMap: Record<string, ChatNodeState>) => buildContinueItems(liveProjects, nodesMap, null, 1).length > 0,
    [liveProjects],
  );
  const hasConversation = useStructuralSelector(hasConversationSelector);
  const { cards: homeCards, loaded, markUsed } = useHomeCards();
  const clock = useMinuteClock(true);
  const [setIndex, setSetIndex] = useState(0);

  // The clock and the cards re-render Home; the composer doesn't need to follow.
  const onSubmittedRef = useRef(onSubmitted);
  onSubmittedRef.current = onSubmitted;
  const handleSubmitted = useCallback(() => onSubmittedRef.current(), []);
  const composerRef = useRef<ManageComposerHandle>(null);
  const composer = useMemo(() => (
    // Override the shared composer typography vars only on Home, so the
    // input feels like a hero element without bloating chat bubbles or
    // the workspace-page composer. MentionEditor reads both vars at
    // render time, so cascading from this wrapper is enough — no prop
    // plumbing into ManageComposer required.
    <div
      style={{
        ['--message-body-size' as string]: '17px',
        ['--message-body-leading' as string]: '1.55',
        // Open with two lines so a card's prompt doesn't start out cramped;
        // it still grows to the shared max-height cap.
        ['--composer-min-rows' as string]: '2',
        ['--composer-chrome-size' as string]: 'var(--fs-lg)',
        // Hero chips: bigger font, but tighter horizontal padding and
        // letter-spacing so the row stays compact rather than sprawling.
        // Icon-only chips track --composer-chip-height for square sizing.
        ['--composer-chip-size' as string]: 'var(--fs-lg)',
        ['--composer-chip-height' as string]: '30px',
        ['--composer-chip-h-pad' as string]: '8px',
        ['--composer-chip-gap' as string]: '5px',
        ['--composer-chip-tracking' as string]: '0',
      } as React.CSSProperties}
    >
      <ManageComposer
        ref={composerRef}
        onSubmitted={handleSubmitted}
        enableAgentSelect
        toolbarCompaction={HOME_TOOLBAR_COMPACTION}
        trayBelow={HOME_TRAY_BELOW}
        toolbarLeftPrefix={
          <HomeWorkspaceChip
            active={chipActive}
            liveProjects={chipProjects}
            onSelect={selectProject}
            onNewWorkspace={() =>
              window.dispatchEvent(new CustomEvent('michi:open-new-workspace'))
            }
            onClear={() => { void enterChatsWorkspace(); }}
          />
        }
      />
    </div>
  ), [handleSubmitted, chipActive, chipProjects, selectProject, enterChatsWorkspace]);

  const fill = useCallback((text: string) => { composerRef.current?.insert(text); }, []);

  const recommendations = useHomeRecommendations();
  const contentMode = recommendations ? homeCards.contentMode ?? 'default' : 'default';
  const sets = homeCards.sets;
  const shownSet = sets.length > 0 ? sets[setIndex % sets.length]! : null;
  const pickCard = (card: HomeCard) => {
    if (card.workspaceId && card.workspaceId !== homeProject?.id && liveProjects.some((p) => p.id === card.workspaceId)) {
      selectProject(card.workspaceId);
    }
    fill(card.prompt);
    markUsed(card);
  };

  // A new user gets the getting-started cards; otherwise the Meta agent's, when it wrote some.
  const onboarding = loaded && hydrated && !hasConversation && !homeCards.cardsCustomized;
  let grid: React.ReactNode = null;
  if (onboarding) {
    grid = (
      <HomeCardGrid
        cards={ONBOARDING_CARDS}
        canShuffle={false}
        onShuffle={() => {}}
        onOpenSpacesHome={openSpacesHome}
        onPick={(id) => {
          const action = ONBOARDING_CARDS.find((card) => card.id === id)?.action;
          if (action?.type === 'compose') fill(action.prompt);
          else if (action?.type === 'mention') composerRef.current?.startMention();
          else if (action?.type === 'spaces') openSpacesHome();
        }}
      />
    );
  } else if (shownSet) {
    grid = (
      <HomeCardGrid
        cards={shownSet.cards}
        canShuffle={sets.length > 1}
        onShuffle={() => setSetIndex((index) => (index + 1) % sets.length)}
        onOpenSpacesHome={openSpacesHome}
        onPick={(id) => {
          const card = shownSet.cards.find((entry) => entry.id === id);
          if (card) pickCard(card);
        }}
      />
    );
  }

  // Keep the original hero until Home has something to show. The composer
  // stays in the same position in the React tree so loading cannot lose a draft.
  const defaultLayout = contentMode === 'default' && (!recommendations || (!homeCards.greeting && !grid && !homeCards.cardsCustomized));

  return (
    <div
      className="home-scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        fontFamily: 'var(--ui-font)',
        color: 'var(--term-fg)',
        background: 'var(--term-page-bg, var(--term-bg))',
      }}
    >
      <div className="home-page" data-default-layout={defaultLayout || undefined}>
        {defaultLayout ? (
          <h1 className="home-default-headline">
            <span className="michi-home-headline__mark">_ </span>
            Another road diverged in a yellow wood.
          </h1>
        ) : <HomeGreeting greeting={recommendations ? homeCards.greeting : null} now={clock} />}
        <div className="home-compose">
          {composer}
        </div>
        {contentMode === 'default' ? (recommendations ? grid : null) : contentMode === 'page' ? (
          homeCards.contentPage ? <Suspense fallback={<p role="status">Loading Home content…</p>}>
            <ChatHomeDocument key={homeCards.contentPage.id} page={homeCards.contentPage} />
          </Suspense> : <p role="status">Your Home page is unavailable. Ask the agent to choose another page or restore the default Home.</p>
        ) : null}
      </div>
    </div>
  );
}
