import type React from 'react';
import type { MichiPageBlock } from 'michi-shared';
import type { MichiMenuEntry } from './MichiMenu';

/** What every block renderer may read. */
export interface MichiBlockCtx {
  /** 0 at the top of the page; containers pass their children one level down. */
  depth: number;
  /** Hands explicit block interaction to the native Spaces Assistant. False means unavailable/busy. */
  requestAssistant?: (block: MichiPageBlock, prompt: string, title: string, send: boolean) => boolean;
  /** Draws a block inside a container with its chrome; without it children are drawn bare. */
  frame?: (block: MichiPageBlock, ctx: MichiBlockCtx) => React.ReactNode;
  /** Ticks one item of a checklist the person may edit; without it checklists are read-only. */
  toggleItem?: (block: MichiPageBlock, index: number) => void;
  /** Asks the assistant window about one checklist item (index into `items`); without it items offer no Ask. */
  askItem?: (block: MichiPageBlock, index: number) => void;
  /** Native Pages supplies workspace-scoped renderers for resource references. */
  renderNativePageLink?: (block: MichiPageBlock) => React.ReactNode;
  /** Native Markdown preserves exact per-segment provenance, including inside containers. */
  renderNativeMarkdown?: (block: MichiPageBlock) => React.ReactNode;
  renderNativeDatabaseRef?: (block: MichiPageBlock) => React.ReactNode;
  /** Native thread cards: the conversations a block names, by node id, with their live state. */
  renderNativeThreads?: (block: MichiPageBlock) => React.ReactNode;
  /** Native task boards: the page's workspace's task database in the view the block names; drawn inside containers too. */
  renderNativeTaskView?: (block: MichiPageBlock) => React.ReactNode;
  /** Starts a conversation from a next step's text; without it next steps offer none. */
  startConversation?: (text: string) => void;
  /**
   * Saves what the person decided on the page (a pick, the version kept);
   * without it those controls are read-only. `next` is the whole block.
   */
  updateBlock?: (block: MichiPageBlock, next: MichiPageBlock) => void;
  /**
   * What the "+" at the foot of a container's section offers (a task board);
   * `insert` puts the block last in that section. Without it, or without
   * `updateBlock`, sections have no "+".
   */
  slotAddEntries?: (insert: (block: MichiPageBlock) => void) => MichiMenuEntry[];
  /** Opens a Michi conversation a block names; without it the name is plain text. */
  openConversation?: (nodeId: string) => void;
  /** Pictures at https addresses on the internet load; without it a picture shows its caption and its address. */
  loadImages?: boolean;
  /** What "today" is for the blocks that place it; the clock when absent. */
  now?: number;
}

export interface BlockProps {
  block: MichiPageBlock;
  ctx: MichiBlockCtx;
}

export type BlockRenderer = (props: BlockProps) => React.ReactNode;
