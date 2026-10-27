import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { MessageSquare, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { LayoutRuleSectionLimit, PageChangeDto, PageLayoutRule } from 'michi-shared';
import type { ToolCallState } from '../../../../state/chatTypes';
import { Button } from '../../../ui/controls';
import { AssistantLinkChip } from '../../assistant/AssistantLinks';
import {
  normalizeToolResultEnvelope, normalizeTurnToolName, parseTurnPageReceipt, putsTaskBoard, taskBoardPageId, taskWriteLine, type TurnPageReceipt,
} from '../../../../lib/turnPageReceipt';
import { backendEntityId } from '../../../../config/backendIdentity';
import { toolPurpose } from '../../toolCallGrouping';
import { changePageChange, deletePage, fetchPage, fetchPageBatchState, listPageChanges, PageApiError, redoPageBatch, restorePage, revertPageBatch } from '../../../../services/api/pages';
import { addLayoutRule, deleteLayoutRule, fetchLayoutRules } from '../../../../services/api/spacesHome';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import { openSpacesPage } from '../../../../state/metaChat/spacesPages';
import { parseConversationStart, type ConversationStartCard } from '../../../../state/metaChat/conversationStart';
import {
  getPageCardState, setPageCardState, subscribePageCards, type PageCardState,
} from '../../../../state/metaChat/pageCardStates';
import { LayoutRulesPopover } from '../layoutRules/LayoutRulesPopover';
import { useLayoutRules } from '../layoutRules/useLayoutRules';

export interface MetaChatCardsContext {
  backendConnectionId: string;
  /** The assistant conversation's own workspace: where a receipt without one points. */
  workspaceId: string;
  /** The page on screen, so View there only scrolls. */
  currentPageId: string | null;
  runtimeLabel: (runtimeId: string) => string;
}

function receiptSummary(receipt: TurnPageReceipt, tool: ToolCallState): string {
  const labels = [...new Set(receipt.changes.filter((c) => c.proposed === (receipt.appliedCount === 0)).map((c) => c.label).filter(Boolean))] as string[];
  if (receipt.appliedCount === 0 && receipt.proposedCount > 0) {
    const what = labels.length ? `“${labels.slice(0, 2).join('”, “')}” ` : '';
    return `${what}${receipt.proposedCount} suggestion${receipt.proposedCount === 1 ? '' : 's'}`;
  }
  return toolPurpose(tool) ?? (labels.length ? labels.slice(0, 2).join(', ') : `${receipt.appliedCount} change${receipt.appliedCount === 1 ? '' : 's'}`);
}

const NO_RECEIPTS: readonly TurnPageReceipt[] = [];

/** What a page made in this reply holds: the blocks the same reply wrote into it, by name. */
function createdSummary(receipt: TurnPageReceipt, filled: readonly TurnPageReceipt[]): string {
  const applied = [receipt, ...filled].flatMap((write) => write.changes.filter((change) => !change.proposed));
  const labels = [...new Set(applied.map((change) => change.label).filter(Boolean))] as string[];
  if (labels.length) return labels.length > 2 ? `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more` : labels.join(', ');
  const count = applied.length || filled.reduce((sum, write) => sum + write.appliedCount, 0);
  if (count) return `${count} block${count === 1 ? '' : 's'}`;
  return receipt.affectedTargetIds.length ? 'added by Agent' : 'empty';
}

function initialState(receipt: TurnPageReceipt): PageCardState {
  if (receipt.created) return { kind: 'created', removed: false };
  if (receipt.appliedCount === 0 && receipt.proposedCount > 0) return { kind: 'suggestion', resolved: null };
  return { kind: 'applied', undone: false };
}

/** Reads what has happened to the write's changes since (undone, accepted, page deleted). */
async function readState(receipt: TurnPageReceipt, options: { backendConnectionId: string; workspaceId: string }): Promise<PageCardState | null> {
  if (receipt.created) {
    try {
      await fetchPage(receipt.resourceId, options);
      return { kind: 'created', removed: false };
    } catch (error) {
      return error instanceof PageApiError && error.status === 404 ? { kind: 'created', removed: true } : null;
    }
  }
  // A receipt recovered from cut-off output lists no changes, and a database's changes are not in a page's history: the batch says whether the write is still applied.
  // Mixed (a conflict left some changes applied) counts as applied, so Undo stays.
  if (receipt.batchId && receipt.appliedCount > 0 && (receipt.partial || receipt.resourceKind !== 'page')) {
    const { applied, reverted } = await fetchPageBatchState(receipt.batchId, options);
    return applied + reverted === 0 ? null : { kind: 'applied', undone: applied === 0 };
  }
  if (receipt.resourceKind !== 'page' || receipt.changes.length === 0) return null;
  const minSeq = Math.min(...receipt.changes.map((c) => c.seq));
  const { changes } = await listPageChanges(receipt.resourceId, { ...options, afterSeq: Math.max(0, minSeq - 1), direction: 'forward', limit: 100 });
  const byId = new Map<string, PageChangeDto>(changes.map((change) => [change.id, change]));
  const mine = receipt.changes.map((c) => byId.get(c.id)).filter((c): c is PageChangeDto => !!c);
  if (mine.length === 0) return null;
  if (receipt.appliedCount === 0) {
    const pending = mine.some((c) => c.proposalState === 'pending');
    const accepted = mine.some((c) => c.proposalState === 'accepted');
    return { kind: 'suggestion', resolved: pending ? null : accepted ? 'accepted' : 'dismissed' };
  }
  const applied = mine.filter((c) => receipt.changes.some((r) => r.id === c.id && !r.proposed));
  return { kind: 'applied', undone: applied.length > 0 && applied.every((c) => c.applicationState === 'reverted') };
}

function PageWriteCard({ toolId, tool, receipt, filled = NO_RECEIPTS, boardPageId = null, context }: {
  toolId: string;
  tool: ToolCallState;
  receipt: TurnPageReceipt;
  /** Writes the same reply made into the page this card created; Undo deletes the page with them. */
  filled?: readonly TurnPageReceipt[];
  /** The page this reply put a task board on: where a task write opens while no page showed its tasks yet. */
  boardPageId?: string | null;
  context: MetaChatCardsContext;
}) {
  const stored = useSyncExternalStore(subscribePageCards, () => getPageCardState(toolId));
  const state = stored ?? initialState(receipt);
  const [busy, setBusy] = useState(false);
  const workspaceId = receipt.workspaceId ?? context.workspaceId;
  const identity = useMemo(() => ({ backendConnectionId: context.backendConnectionId, workspaceId }), [context.backendConnectionId, workspaceId]);
  const pageId = receipt.resourceKind === 'page'
    ? receipt.resourceId
    : receipt.originatingPageId ?? receipt.originatingPageIds[0] ?? (receipt.tasks ? boardPageId : null);

  useEffect(() => {
    if (getPageCardState(toolId)) return undefined;
    let live = true;
    readState(receipt, identity).then((next) => { if (live && next && !getPageCardState(toolId)) setPageCardState(toolId, next); }, () => {});
    return () => { live = false; };
  }, [identity, receipt, toolId]);

  const refresh = () => notifyPageChanged({
    ...identity,
    ...(receipt.resourceKind === 'page' ? { pageId: receipt.resourceId } : { databaseId: receipt.resourceId }),
  });
  const run = async (action: () => Promise<PageCardState>, failure: string) => {
    if (busy) return;
    setBusy(true);
    try {
      setPageCardState(toolId, await action());
      refresh();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? `${failure}: ${error.message}` : failure);
    } finally {
      setBusy(false);
    }
  };
  const applied = receipt.changes.filter((c) => !c.proposed);
  const undo = () => run(async () => {
    if (state.kind === 'created') {
      await deletePage(receipt.resourceId, identity);
      return { kind: 'created', removed: true };
    }
    let conflicts = 0;
    if (receipt.batchId) conflicts = (await revertPageBatch(receipt.batchId, identity)).conflicts.length;
    else for (const change of applied) await changePageChange(change.id, 'revert', identity);
    // Conflicting changes are skipped and stay applied, so the card stays on Undo, as it reads after a reload.
    if (conflicts > 0) toast("Some changes couldn't be undone: they were edited since.");
    return { kind: 'applied', undone: conflicts === 0 };
  }, "Couldn't undo");
  const restore = () => run(async () => {
    if (state.kind === 'created') {
      await restorePage(receipt.resourceId, identity);
      return { kind: 'created', removed: false };
    }
    // Undo reverted the whole batch (including a proposal accepted since, and a cut-off receipt's unknown changes), so Restore redoes the whole batch.
    if (receipt.batchId) {
      if ((await redoPageBatch(receipt.batchId, identity)).conflicts.length > 0) toast("Some changes couldn't be restored: they were edited since.");
    } else for (const change of applied) await changePageChange(change.id, 'redo', identity);
    return { kind: 'applied', undone: false };
  }, "Couldn't restore");
  const view = () => {
    if (!pageId) return;
    if (state.kind === 'created' && state.removed) {
      toast('This page has been deleted.');
      return;
    }
    void openSpacesPage({
      pageId, workspaceId, backendConnectionId: context.backendConnectionId,
      ...(receipt.affectedTargetIds[0] && receipt.resourceKind === 'page' && !receipt.created ? { blockId: receipt.affectedTargetIds[0] } : {}),
      currentPageId: context.currentPageId,
    });
  };

  const verb = state.kind === 'created' ? 'New page' : state.kind === 'suggestion' ? 'Suggestion' : 'Updated';
  const summary = state.kind === 'created' ? createdSummary(receipt, filled) : receiptSummary(receipt, tool);
  const off = (state.kind === 'applied' && state.undone) || (state.kind === 'created' && state.removed);
  // A receipt recovered from cut-off output knows its batch but not its changes: both Undo and Restore go through the batch.
  const cutOff = receipt.partial === true && state.kind === 'applied';
  const resolved = state.kind === 'suggestion' && state.resolved ? (state.resolved === 'accepted' ? ' · accepted' : ' · ignored') : '';
  // A write to the task database says what it did to the tasks; one that put a task board on a page says so.
  const tasks = state.kind === 'applied' && receipt.tasks ? taskWriteLine(receipt.tasks) : null;
  const board = state.kind === 'applied' && putsTaskBoard(receipt);
  const more = board && receipt.appliedCount > 1 ? ` · and ${receipt.appliedCount - 1} more ${receipt.appliedCount === 2 ? 'change' : 'changes'}` : '';
  const suggestions = receipt.proposedCount ? ` · ${receipt.proposedCount} suggestion${receipt.proposedCount === 1 ? '' : 's'}` : '';
  const label = tasks ? `${tasks}${suggestions}` : board ? `Added a task board to ${receipt.title}${more}` : `${verb} ${receipt.title} · ${summary}`;
  return (
    <div className={`assistant-receipt meta-chat-card${off ? ' is-undone' : ''}`} data-page-card={state.kind} data-undone={off || undefined}>
      <span className="assistant-receipt__glyph meta-chat-card__glyph" aria-hidden="true"><Sparkles size={13} /></span>
      <span className="assistant-receipt__label meta-chat-card__label" title={label}>
        {tasks
          ? <><b>{tasks}</b>{suggestions}</>
          : board
            ? <>Added a task board to <b>{receipt.title}</b>{more}</>
            : <>{verb} <b>{receipt.title}</b> · {summary}</>}
        {resolved}
        {off && cutOff && ' · undone'}
      </span>
      {pageId && <Button variant="ghost" size="sm" className="meta-chat-card__btn" onClick={view}>View</Button>}
      {state.kind !== 'suggestion' && !(cutOff && !receipt.batchId) && (off
        ? <Button variant="ghost" size="sm" className="meta-chat-card__btn" disabled={busy} onClick={() => { void restore(); }}>Restore</Button>
        : <Button variant="ghost" size="sm" className="meta-chat-card__btn" disabled={busy} onClick={() => { void undo(); }}>Undo</Button>)}
    </div>
  );
}

function ConversationCard({ card, context }: { card: ConversationStartCard; context: MetaChatCardsContext }) {
  if (card.status === 'declined') {
    return (
      <div className="assistant-receipt meta-chat-card is-undone" data-conversation-card="declined">
        <span className="assistant-receipt__glyph meta-chat-card__glyph" aria-hidden="true"><MessageSquare size={13} /></span>
        <span className="assistant-receipt__label meta-chat-card__label">New conversation not started: you declined</span>
      </div>
    );
  }
  const c = card.conversation!;
  const meta = [context.runtimeLabel(c.runtimeId), c.workspaceName, card.status === 'queued' ? 'queued' : 'running'].filter(Boolean).join(' · ');
  return (
    <div className="assistant-receipt meta-chat-card meta-chat-card--conversation" data-conversation-card={card.status}>
      <span className="assistant-receipt__glyph meta-chat-card__glyph" aria-hidden="true"><MessageSquare size={13} /></span>
      <span className="meta-chat-card__label meta-chat-card__label--wrap" title={`New conversation ${c.title} · ${meta}`}>
        <span className="meta-chat-card__line">New conversation <b>{c.title}</b></span>
        <span className="meta-chat-card__line meta-chat-card__meta">{meta}</span>
      </span>
      <span className="meta-chat-card__open">
        <AssistantLinkChip link={{ kind: 'node', id: c.nodeId }}>Open conversation →</AssistantLinkChip>
      </span>
    </div>
  );
}

type CardItem =
  | { kind: 'page'; tool: ToolCallState; receipt: TurnPageReceipt; filled?: TurnPageReceipt[] }
  | { kind: 'rule'; tool: ToolCallState; rule: LayoutRuleAdded }
  | { kind: 'conversation'; tool: ToolCallState; start: ConversationStartCard };

/** The rule a completed `layout_rules` add stored, as its result names it. */
interface LayoutRuleAdded {
  pageId: string;
  pageTitle: string;
  id: string;
  text: string;
  sectionLimit: LayoutRuleSectionLimit | null;
}

const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function parseLayoutRuleAdded(tool: ToolCallState, backendConnectionId: string): LayoutRuleAdded | null {
  if (tool.status !== 'completed' || !normalizeTurnToolName(tool.title, ['layout_rules'])) return null;
  for (const value of normalizeToolResultEnvelope(tool.output)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const { added, page } = value as { added?: Record<string, unknown>; page?: Record<string, unknown> };
    if (!added || !page || !str(added.id) || !str(added.text) || !str(page.id)) continue;
    const limit = added.sectionLimit as LayoutRuleSectionLimit | undefined;
    return { pageId: backendEntityId(backendConnectionId, page.id), pageTitle: str(page.title) ? page.title : 'this page', id: added.id, text: added.text,
      sectionLimit: limit && typeof limit === 'object' && str(limit.section) ? limit : null };
  }
  return null;
}

const sameLimit = (a: LayoutRuleSectionLimit | null | undefined, b: LayoutRuleSectionLimit | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The stored rule this card stands for: the one it added, or the one Restore added again. */
function findRule(rules: readonly PageLayoutRule[], rule: LayoutRuleAdded): PageLayoutRule | undefined {
  return rules.find((candidate) => candidate.id === rule.id)
    ?? rules.find((candidate) => candidate.text === rule.text && sameLimit(candidate.sectionLimit, rule.sectionLimit));
}

/** The page's Layout rules list, read when it opens, hung from the card's View. */
function LayoutRuleList({ pageId, backendConnectionId, anchor, onClose }: { pageId: string; backendConnectionId: string; anchor: HTMLElement; onClose: () => void }) {
  const state = useLayoutRules(pageId, backendConnectionId);
  return <LayoutRulesPopover anchor={anchor} rules={state.rules} error={state.error} onDelete={(rule) => state.remove(rule.id)}
    onClose={(restore) => { onClose(); if (restore) anchor.focus({ preventScroll: true }); }} />;
}

/** "Updated Home · saved as a layout rule: “…”": Undo deletes the rule, Restore adds it back. */
function LayoutRuleCard({ toolId, rule, context }: { toolId: string; rule: LayoutRuleAdded; context: MetaChatCardsContext }) {
  const stored = useSyncExternalStore(subscribePageCards, () => getPageCardState(toolId));
  const undone = stored?.kind === 'applied' && stored.undone;
  const [busy, setBusy] = useState(false);
  const [listAnchor, setListAnchor] = useState<HTMLElement | null>(null);
  const removed = React.useRef<PageLayoutRule | null>(null);
  const connection = context.backendConnectionId;

  useEffect(() => {
    if (getPageCardState(toolId)) return undefined;
    let live = true;
    fetchLayoutRules(rule.pageId, connection).then((rules) => {
      if (live && !getPageCardState(toolId)) setPageCardState(toolId, { kind: 'applied', undone: !findRule(rules, rule) });
    }, () => {});
    return () => { live = false; };
  }, [connection, rule, toolId]);

  const run = async (action: () => Promise<boolean>, failure: string) => {
    if (busy) return;
    setBusy(true);
    try {
      setPageCardState(toolId, { kind: 'applied', undone: await action() });
      notifyPageChanged({ backendConnectionId: connection, pageId: rule.pageId });
    } catch (error) {
      toast.error(error instanceof Error && error.message ? `${failure}: ${error.message}` : failure);
    } finally {
      setBusy(false);
    }
  };
  const undo = () => run(async () => {
    const current = findRule(await fetchLayoutRules(rule.pageId, connection), rule);
    if (current) {
      removed.current = current;
      await deleteLayoutRule(rule.pageId, current.id, connection);
    }
    return true;
  }, "Couldn't undo");
  const restore = () => run(async () => {
    await addLayoutRule(rule.pageId, { text: rule.text, sourceMessage: removed.current?.sourceMessage ?? null, sectionLimit: rule.sectionLimit }, connection);
    return false;
  }, "Couldn't restore");

  return (
    <div className={`assistant-receipt meta-chat-card${undone ? ' is-undone' : ''}`} data-rule-card={undone ? 'undone' : 'saved'} data-undone={undone || undefined}>
      <span className="assistant-receipt__glyph meta-chat-card__glyph" aria-hidden="true"><Sparkles size={13} /></span>
      <span className="assistant-receipt__label meta-chat-card__label" title={`Updated ${rule.pageTitle} · saved as a layout rule: “${rule.text}”`}>
        Updated <b>{rule.pageTitle}</b> · saved as a layout rule: “{rule.text}”
      </span>
      <Button variant="ghost" size="sm" className="meta-chat-card__btn" aria-haspopup="dialog" aria-expanded={Boolean(listAnchor)}
        onClick={(event) => {
          const anchor = event.currentTarget;
          if (listAnchor) { setListAnchor(null); return; }
          void openSpacesPage({ pageId: rule.pageId, backendConnectionId: connection, currentPageId: context.currentPageId });
          setListAnchor(anchor);
        }}>View</Button>
      {undone
        ? <Button variant="ghost" size="sm" className="meta-chat-card__btn" disabled={busy} onClick={() => { void restore(); }}>Restore</Button>
        : <Button variant="ghost" size="sm" className="meta-chat-card__btn" disabled={busy} onClick={() => { void undo(); }}>Undo</Button>}
      {listAnchor && <LayoutRuleList pageId={rule.pageId} backendConnectionId={connection} anchor={listAnchor} onClose={() => setListAnchor(null)} />}
    </div>
  );
}

/**
 * A page the reply created and then wrote into is one card, "New page", with
 * what it now holds: the later writes fold into it. A write that only
 * suggests keeps its own card.
 */
function foldCreatedPages(cards: CardItem[]): CardItem[] {
  const created = new Map<string, Extract<CardItem, { kind: 'page' }>>();
  const out: CardItem[] = [];
  for (const card of cards) {
    if (card.kind === 'page' && card.receipt.resourceKind === 'page') {
      const target = created.get(card.receipt.resourceId);
      if (!card.receipt.created && target && card.receipt.proposedCount === 0) {
        target.filled = [...(target.filled ?? []), card.receipt];
        continue;
      }
      if (card.receipt.created) {
        const own = { ...card };
        created.set(card.receipt.resourceId, own);
        out.push(own);
        continue;
      }
    }
    out.push(card);
  }
  return out;
}

/** The window's cards for one reply: page changes (Updated / Suggestion / New page), stored layout rules and started conversations. */
export function MetaChatCards({ tools, context }: { tools: readonly ToolCallState[]; context: MetaChatCardsContext }) {
  const cards = useMemo(() => foldCreatedPages(tools.flatMap((tool): CardItem[] => {
    const receipt = parseTurnPageReceipt(tool, context.backendConnectionId);
    if (receipt && (receipt.appliedCount > 0 || receipt.proposedCount > 0 || receipt.created)) return [{ kind: 'page', tool, receipt }];
    const rule = parseLayoutRuleAdded(tool, context.backendConnectionId);
    if (rule) return [{ kind: 'rule', tool, rule }];
    const start = parseConversationStart(tool);
    return start ? [{ kind: 'conversation', tool, start }] : [];
  })), [context.backendConnectionId, tools]);
  const boards = useMemo(() => cards.flatMap((card) => (card.kind === 'page' ? [card.receipt, ...(card.filled ?? [])] : [])), [cards]);
  if (cards.length === 0) return null;
  return (
    <div className="meta-chat-cards">
      {cards.map((card) => (card.kind === 'page'
        ? <PageWriteCard key={card.tool.id} toolId={card.tool.id} tool={card.tool} receipt={card.receipt} filled={card.filled} boardPageId={taskBoardPageId(boards, card.receipt.workspaceId)} context={context} />
        : card.kind === 'rule'
          ? <LayoutRuleCard key={card.tool.id} toolId={card.tool.id} rule={card.rule} context={context} />
          : <ConversationCard key={card.tool.id} card={card.start} context={context} />))}
    </div>
  );
}
