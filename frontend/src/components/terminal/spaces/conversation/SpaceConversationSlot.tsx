import React from 'react';
import type { ProgressCardDto } from 'michi-shared';
import { dismissProgressCard } from '../../../../services/api/spacesHome';
import { useProgressCards } from '../../../../state/pages/useSpacesHome';
import {
  registerSpaceScope,
  useSpaceConversationState,
  type PendingStart,
  type SpaceConversationScope,
} from '../../../../state/spaceConversations/store';
import { useMinuteClock } from '../../content/home/useMinuteClock';
import { NewChatSheet } from './NewChatSheet';
import { SpaceProgressCard } from './SpaceProgressCard';
import { useOpenSpaceConversation } from './openConversation';
import './conversation.css';

function pendingCard(start: PendingStart & { nodeId: string }): ProgressCardDto {
  return {
    threadNodeId: start.nodeId, startedFromPageId: start.startedFromPageId,
    workspaceId: start.workspaceId, workspaceName: start.workspaceName, treeId: null,
    title: '', runtimeId: null, status: 'running', summary: null,
    createdAt: start.requestedAt, seenAt: null, dismissedAt: null, expiresAt: null,
  };
}

/** Makes this page the one the topbar's "Start a task" opens the sheet on, while it is mounted. */
function useRegisteredScope(scope: SpaceConversationScope): number | null {
  const [id, setId] = React.useState<number | null>(null);
  const handleRef = React.useRef<ReturnType<typeof registerSpaceScope> | null>(null);
  const scopeRef = React.useRef(scope);
  scopeRef.current = scope;
  React.useEffect(() => {
    const handle = registerSpaceScope(scopeRef.current);
    handleRef.current = handle;
    setId(handle.id);
    return () => { handle.release(); handleRef.current = null; };
  }, []);
  const { backendConnectionId, pageId, workspaceId, workspaceName, pageTitle } = scope;
  React.useEffect(() => {
    handleRef.current?.update({ backendConnectionId, pageId, workspaceId, workspaceName, pageTitle });
  }, [backendConnectionId, pageId, pageTitle, workspaceId, workspaceName]);
  return id;
}

/** Where the new-chat sheet opens on this page: place it at the top of the page. */
export function NewChatSheetSlot({ scope }: { scope: SpaceConversationScope }) {
  const id = useRegisteredScope(scope);
  const { sheet } = useSpaceConversationState();
  if (id === null || !sheet || sheet.scopeId !== id) return null;
  return <NewChatSheet sheet={sheet} scope={scope} />;
}

/** Progress cards, newest first, with the ones just started that the backend has not listed yet. */
export function SpaceProgressCardList({ scope, cards, everyPage = false, onChanged }: {
  scope: SpaceConversationScope;
  cards: readonly ProgressCardDto[];
  /** The Spaces Home lists the cards of every page. */
  everyPage?: boolean;
  onChanged?: () => void;
}) {
  const { pending } = useSpaceConversationState();
  const open = useOpenSpaceConversation();
  const clock = useMinuteClock(true);
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
  const listed = new Set(cards.map((card) => card.threadNodeId));
  const fresh = pending
    .filter((start): start is PendingStart & { nodeId: string } => Boolean(start.nodeId) && !listed.has(start.nodeId!))
    .filter((start) => start.backendConnectionId === scope.backendConnectionId && (everyPage || start.startedFromPageId === scope.pageId))
    .map(pendingCard)
    .reverse();
  // The backend stops listing a card 24 hours after it was seen; a list read before then may still hold it.
  const shown = [...fresh, ...cards].filter((card) => card.dismissedAt === null && !dismissed.has(card.threadNodeId)
    && (card.expiresAt === null || card.expiresAt > clock));
  if (!shown.length) return null;

  const dismiss = (card: ProgressCardDto) => {
    setDismissed((current) => new Set(current).add(card.threadNodeId));
    dismissProgressCard(card.threadNodeId, scope.backendConnectionId).then(
      () => onChanged?.(),
      () => setDismissed((current) => { const next = new Set(current); next.delete(card.threadNodeId); return next; }),
    );
  };

  return (
    <div className="space-live-cards" aria-label="Chats started from Pages">
      {shown.map((card) => (
        <SpaceProgressCard
          key={card.threadNodeId}
          card={card}
          clock={clock}
          onOpen={(target, { continueChat, pending }) => { void open(target, { continueChat, from: scope, pending }); }}
          onDismiss={listed.has(card.threadNodeId) ? dismiss : undefined}
        />
      ))}
    </div>
  );
}

/** The cards of conversations started from this page. */
export function PageProgressCards({ scope }: { scope: SpaceConversationScope }) {
  const cards = useProgressCards(scope.backendConnectionId);
  const mine = React.useMemo(
    () => (cards.data ?? []).filter((card) => card.startedFromPageId === scope.pageId),
    [cards.data, scope.pageId],
  );
  return <SpaceProgressCardList scope={scope} cards={mine} onChanged={cards.refresh} />;
}

/** One mount for a page that has a single slot: the sheet, then the cards it passes in. */
export function SpaceConversationSlot({ scope, cards, onCardsChanged }: {
  scope: SpaceConversationScope;
  cards: readonly ProgressCardDto[];
  onCardsChanged?: () => void;
}) {
  return <>
    <NewChatSheetSlot scope={scope} />
    <SpaceProgressCardList scope={scope} cards={cards} everyPage onChanged={onCardsChanged} />
  </>;
}
