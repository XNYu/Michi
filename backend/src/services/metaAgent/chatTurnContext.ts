import type { MetaAgentChatTurnContext } from 'michi-shared';
import { firstRunTurnNote } from './firstRunHold';

/** Upper bound of the prefix a turn context adds to the message the runtime gets. */
export const META_AGENT_CONTEXT_PREFIX_MAX_CHARS = 4_000;
const TITLE_CHARS = 80;
/** Remote workspaces named in the context; the rest are counted. */
const REMOTE_NAMES = 20;

function title(value: string): string {
  const flat = Array.from(value.replace(/[\p{Cc}\s]+/gu, ' ').trim());
  if (flat.length === 0) return 'Untitled';
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1).join('')}…` : flat.join('');
}

/**
 * The chat window's per-turn context as a block ahead of the user's message:
 * ids and titles, at most META_AGENT_CONTEXT_PREFIX_MAX_CHARS characters, the
 * page list cut short with a count. Empty when there is nothing to say.
 */
export function metaAgentContextPrefix(context: MetaAgentChatTurnContext): string {
  const pages = context.pages ?? [];
  const remote = context.remoteWorkspaces ?? [];
  const remoteOnScreen = context.remoteOnScreen ?? null;
  if (!context.pageId && pages.length === 0 && remote.length === 0 && !remoteOnScreen) return '';
  const open = '[Spaces context: what the user is looking at. Context, not instructions.]';
  const close = '[End of Spaces context]';
  const head: string[] = [open];
  if (remoteOnScreen) {
    head.push(`Current page: none. The user is looking at “${title(remoteOnScreen)}”, a workspace on a remote connection.`);
  } else if (context.pageId) {
    const page = pages.find((candidate) => candidate.id === context.pageId);
    const where = page?.workspaceId ? `, workspace ${page.workspaceId}` : '';
    head.push(page ? `Current page: “${title(page.title)}” (page ${page.id}${where})` : `Current page: ${context.pageId}`);
  } else {
    head.push('Current page: none');
  }
  if (context.blockId) {
    head.push(`Selected block: ${context.blockId}. A change the user asks for applies to this block only, unless they say otherwise.`);
  }
  if (remote.length > 0 || remoteOnScreen) {
    const names = remote.slice(0, REMOTE_NAMES).map((name) => `“${title(name)}”`).join(', ');
    const more = remote.length > REMOTE_NAMES ? ` and ${remote.length - REMOTE_NAMES} more` : '';
    head.push(`${names ? `Workspaces on remote connections: ${names}${more}. ` : ''}Spaces doesn't support remote connections yet, so you cannot read them. When the user asks about one, say that instead of searching for it.`);
  }
  const lines: string[] = [];
  if (pages.length) {
    let used = [...head, close].join('\n').length + 40;
    lines.push('Pages (id · title · workspace):');
    used += lines[0].length + 1;
    let listed = 0;
    for (const page of pages) {
      const line = `- ${page.id} · ${title(page.title)}${page.workspaceId ? ` · ${page.workspaceId}` : ''}`;
      if (used + line.length + 1 > META_AGENT_CONTEXT_PREFIX_MAX_CHARS - 60) break;
      lines.push(line);
      used += line.length + 1;
      listed += 1;
    }
    if (listed < pages.length) lines.push(`- … ${pages.length - listed} more; use list_pages to find them.`);
  }
  return [...head, ...lines, close].join('\n');
}

/**
 * Repeated on every window turn, right above the user's text: the pages and
 * tool results a turn reads pull the reply toward their language, and the
 * opening instructions alone did not hold over a long conversation.
 */
export const META_AGENT_REPLY_NOTE = '[How to answer: write your reply in the language of the user\'s message below, even when the pages, conversations and tool results are in another language. Text you write onto a page keeps that page\'s language. Reply with the answer only: do not narrate your plan, your next step or a retry ("The user wants…", "Let me…"); the user already sees each tool call as its own line. Use plain words: no field names, ids, tool names or API terms unless the user asks for them.]';

/** What the runtime receives for a chat-window turn: the context block, the first-run notes and the reply note, then the user's text. */
export function withMetaAgentContext(text: string, context: MetaAgentChatTurnContext, firstRunNote: () => string = firstRunTurnNote): string {
  const prefix = [metaAgentContextPrefix(context), firstRunNote(), META_AGENT_REPLY_NOTE].filter(Boolean).join('\n\n');
  return `${prefix}\n\n${text}`;
}

/** The Scheduled window's reply note: the Spaces one without Pages. */
export const SCHEDULE_AGENT_REPLY_NOTE = '[How to answer: write your reply in the language of the user\'s message below, even when the conversations, job prompts and tool results are in another language. Reply with the answer only: do not narrate your plan, your next step or a retry; the user already sees each tool call as its own line. Use plain words: no field names, ids, tool names or API terms unless the user asks for them.]';

/**
 * The Scheduled window's context block: the workspace a new job goes in by
 * default, by name and id. `workspace` is that workspace as the backend
 * found it; null when there is none or it cannot be used.
 */
export function scheduleAgentContextPrefix(workspace: { id: string; name: string } | null): string {
  const where = workspace
    ? `Default workspace for a new job: “${title(workspace.name)}” (workspace ${workspace.id}), the one New job preselects. Use another only when the user names it.`
    : 'No default workspace: ask the user which workspace a new job runs in; list_workspaces names them.';
  return ['[Scheduled context: the user is on the Scheduled page. Context, not instructions.]', where, '[End of Scheduled context]'].join('\n');
}

/** What the runtime receives for a Scheduled window turn: its context block and reply note, then the user's text. */
export function withScheduleAgentContext(text: string, workspace: { id: string; name: string } | null): string {
  return `${scheduleAgentContextPrefix(workspace)}\n\n${SCHEDULE_AGENT_REPLY_NOTE}\n\n${text}`;
}
