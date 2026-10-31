/**
 * What the Spaces chat window tells the Meta agent with each message: the
 * page on screen, the selected block and the pages the user can see, by id
 * and title only (never page text beyond one bounded checklist item the user
 * asked about). Sent as `metaAgentContext` on
 * POST /api/chats/:chatId/message, accepted only for the Michi assistant's
 * conversation; the backend turns it into a bounded prefix of that turn.
 * The Scheduled window sends `schedule` instead, for its own conversation.
 */

export interface MetaAgentChatPageRef {
  id: string;
  title: string;
  workspaceId?: string;
}

export interface MetaAgentChatTurnContext {
  /** The page on screen; null when the window is not over a page. */
  pageId?: string | null;
  /** The block the user selected on that page ("针对：…"); needs pageId. */
  blockId?: string | null;
  /**
   * One item of a checklist in that block the user asked about: its 0-based
   * position in its checklist and its text, bounded by titleChars. Needs blockId.
   */
  blockItem?: MetaAgentChatBlockItem | null;
  /** The pages the user can see (sidebar order). */
  pages?: MetaAgentChatPageRef[];
  /** Workspaces on remote connections, by name: Spaces doesn't support them yet, so the Meta agent cannot read them. */
  remoteWorkspaces?: string[];
  /** The remote workspace the window is over, by name; the page on screen is then none. */
  remoteOnScreen?: string | null;
  /**
   * The Scheduled window's context instead of the Spaces fields: the
   * workspace a new job goes in unless the user names another (the one New
   * job would preselect). Accepted only for that window's conversation.
   */
  schedule?: MetaAgentScheduleContext;
}

export interface MetaAgentChatBlockItem {
  index: number;
  text: string;
}

export interface MetaAgentScheduleContext {
  /** Null when the user has no workspace to schedule in. */
  workspaceId: string | null;
}

/** The `metaAgentContext` field of POST /api/chats/:chatId/message. */
export interface ChatMessageMetaAgentFields {
  metaAgentContext?: MetaAgentChatTurnContext;
}

export const META_AGENT_CHAT_CONTEXT_LIMITS = Object.freeze({
  pages: 500,
  idChars: 200,
  titleChars: 300,
  remoteWorkspaces: 100,
  blockItemIndex: 1_000,
});

export class MetaAgentChatContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAgentChatContextError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ID = /^[^\s\p{Cc}]+$/u;

function id(value: unknown, field: string, nullable: boolean): string | null | undefined {
  if (value === undefined || (nullable && value === null)) return value as null | undefined;
  if (typeof value !== 'string' || !ID.test(value) || value.length > META_AGENT_CHAT_CONTEXT_LIMITS.idChars) {
    throw new MetaAgentChatContextError(`${field} must be an id of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.idChars} characters`);
  }
  return value;
}

/** Validates the field; throws MetaAgentChatContextError with a message for the client. */
export function parseMetaAgentChatTurnContext(value: unknown): MetaAgentChatTurnContext {
  if (!isRecord(value)) throw new MetaAgentChatContextError('metaAgentContext must be an object');
  const unknown = Object.keys(value).filter((key) => !['pageId', 'blockId', 'blockItem', 'pages', 'remoteWorkspaces', 'remoteOnScreen', 'schedule'].includes(key));
  if (unknown.length) throw new MetaAgentChatContextError(`metaAgentContext has an unknown field: ${unknown[0]}`);
  let schedule: MetaAgentScheduleContext | undefined;
  if (value.schedule !== undefined) {
    if (!isRecord(value.schedule) || Object.keys(value.schedule).some((key) => key !== 'workspaceId')) {
      throw new MetaAgentChatContextError('schedule must be {workspaceId}');
    }
    schedule = { workspaceId: id(value.schedule.workspaceId, 'schedule.workspaceId', true) ?? null };
  }
  const pageId = id(value.pageId, 'pageId', true);
  const blockId = id(value.blockId, 'blockId', true);
  if (blockId && !pageId) throw new MetaAgentChatContextError('blockId needs pageId');
  let blockItem: MetaAgentChatBlockItem | null | undefined;
  if (value.blockItem === null) blockItem = null;
  else if (value.blockItem !== undefined) {
    const item = value.blockItem;
    if (!isRecord(item) || Object.keys(item).some((key) => key !== 'index' && key !== 'text')
      || !Number.isInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= META_AGENT_CHAT_CONTEXT_LIMITS.blockItemIndex
      || typeof item.text !== 'string' || item.text.length > META_AGENT_CHAT_CONTEXT_LIMITS.titleChars) {
      throw new MetaAgentChatContextError(`blockItem must be {index, text} with an index below ${META_AGENT_CHAT_CONTEXT_LIMITS.blockItemIndex} and text of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.titleChars} characters`);
    }
    if (!blockId) throw new MetaAgentChatContextError('blockItem needs blockId');
    blockItem = { index: item.index as number, text: item.text };
  }
  let pages: MetaAgentChatPageRef[] | undefined;
  if (value.pages !== undefined) {
    if (!Array.isArray(value.pages) || value.pages.length > META_AGENT_CHAT_CONTEXT_LIMITS.pages) {
      throw new MetaAgentChatContextError(`pages must be an array of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.pages} pages`);
    }
    pages = value.pages.map((page, index) => {
      if (!isRecord(page) || Object.keys(page).some((key) => !['id', 'title', 'workspaceId'].includes(key))) {
        throw new MetaAgentChatContextError(`pages[${index}] must be {id, title, workspaceId?}`);
      }
      if (typeof page.title !== 'string' || page.title.length > META_AGENT_CHAT_CONTEXT_LIMITS.titleChars) {
        throw new MetaAgentChatContextError(`pages[${index}].title must be a string of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.titleChars} characters`);
      }
      const workspaceId = id(page.workspaceId, `pages[${index}].workspaceId`, false);
      return { id: id(page.id, `pages[${index}].id`, false)!, title: page.title, ...(workspaceId ? { workspaceId } : {}) };
    });
  }
  const name = (item: unknown, field: string): string => {
    if (typeof item !== 'string' || item.length > META_AGENT_CHAT_CONTEXT_LIMITS.titleChars) {
      throw new MetaAgentChatContextError(`${field} must be a name of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.titleChars} characters`);
    }
    return item;
  };
  let remoteWorkspaces: string[] | undefined;
  if (value.remoteWorkspaces !== undefined) {
    if (!Array.isArray(value.remoteWorkspaces) || value.remoteWorkspaces.length > META_AGENT_CHAT_CONTEXT_LIMITS.remoteWorkspaces) {
      throw new MetaAgentChatContextError(`remoteWorkspaces must be an array of at most ${META_AGENT_CHAT_CONTEXT_LIMITS.remoteWorkspaces} names`);
    }
    remoteWorkspaces = value.remoteWorkspaces.map((item, index) => name(item, `remoteWorkspaces[${index}]`));
  }
  const remoteOnScreen = value.remoteOnScreen === undefined || value.remoteOnScreen === null ? value.remoteOnScreen : name(value.remoteOnScreen, 'remoteOnScreen');
  return {
    ...(pageId !== undefined ? { pageId } : {}),
    ...(blockId !== undefined ? { blockId } : {}),
    ...(blockItem !== undefined ? { blockItem } : {}),
    ...(pages ? { pages } : {}),
    ...(remoteWorkspaces ? { remoteWorkspaces } : {}),
    ...(remoteOnScreen !== undefined ? { remoteOnScreen } : {}),
    ...(schedule ? { schedule } : {}),
  };
}

/** True when the context carries any of the Spaces window's fields. */
export function hasSpacesTurnContext(context: MetaAgentChatTurnContext): boolean {
  return context.pageId !== undefined || context.blockId !== undefined || context.blockItem !== undefined || context.pages !== undefined
    || context.remoteWorkspaces !== undefined || context.remoteOnScreen !== undefined;
}
