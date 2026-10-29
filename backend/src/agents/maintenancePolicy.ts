import type { MaintenanceTurnContext, RuntimeToolProfile } from './types';
import { createHash } from 'node:crypto';
import { metaAgentRuntimeAvailability } from './metaAgentGuard';

/** Tool surface intentionally limited to incremental maintenance operations. */
export const MAINTENANCE_TOOL_NAMES = [
  'maintenance_read_source',
  'maintenance_list_resources',
  'maintenance_read_page',
  'maintenance_read_database',
  'maintenance_list_tasks',
  'maintenance_route_source',
  'maintenance_write_page',
  'maintenance_write_database',
  'maintenance_no_change',
] as const;

export type MaintenanceToolName = typeof MAINTENANCE_TOOL_NAMES[number];

/** Read-only history tools first-run generation uses before the incremental cursor exists. */
export const MAINTENANCE_HISTORY_TOOL_NAMES = ['list_threads', 'read_node_overview', 'read_node'] as const;

/** Reserved: reads a workspace home page for the Spaces home summary. */
export const MAINTENANCE_READ_WORKSPACE_HOME_TOOL = 'maintenance_read_workspace_home';

/** The Meta agent's closed background-maintenance toolset. */
export const MAINTENANCE_CORE_TOOL_NAMES: readonly string[] = Object.freeze([
  ...MAINTENANCE_TOOL_NAMES,
  ...MAINTENANCE_HISTORY_TOOL_NAMES,
  MAINTENANCE_READ_WORKSPACE_HOME_TOOL,
]);

/** Native adapters expose only this host-mediated entry point. The gateway
 * grants Michi state operations and verifies external read-only metadata. */
export const META_AGENT_MAINTENANCE_TOOL_NAMES: readonly string[] = Object.freeze([
  ...MAINTENANCE_CORE_TOOL_NAMES, 'maintenance_list_tools', 'maintenance_call_tool',
]);

export interface MaintenanceRuntimeAvailability {
  available: boolean;
  reason?: string;
}

/** Same answer as the chat toolset: each adapter checks its catalog at launch. */
export function maintenanceRuntimeAvailability(runtimeId: string): MaintenanceRuntimeAvailability {
  return metaAgentRuntimeAvailability(runtimeId);
}

/** Constructed by the scheduler/backend only; never from request data. */
export function maintenanceToolProfile(): RuntimeToolProfile {
  return {
    allowedToolNames: META_AGENT_MAINTENANCE_TOOL_NAMES,
    maintenance: true,
    restricted: true,
    metaAgentToolset: 'maintenance',
  };
}

export function maintenanceProfileHash(runtimeConfig: { runtimeId: string; providerId: string | null; modelId: string | null; reasoning: string | null }): string {
  return createHash('sha256').update(JSON.stringify({
    profile: 2,
    toolNames: META_AGENT_MAINTENANCE_TOOL_NAMES,
    ...runtimeConfig,
  })).digest('hex');
}

export const MAINTENANCE_BOOTSTRAP_INSTRUCTIONS = `You are processing a server-owned Pages maintenance batch. Use maintenance_list_tools and maintenance_call_tool to access Michi state operations and configured external read-only tools as needed. You may create and modify Michi content without a separate tool approval. External read-only tools are allowed automatically; other external tools require saved human approval through maintenance_call_tool. Never use arbitrary code, shell commands or other agents to bypass this policy. An approval_required, denied or unavailable result is recoverable: try permitted alternatives. If no alternative works, explain which tool needs approval in Settings → Meta agent → Tool approvals, and leave dependent work unfinished. Never repeatedly retry denied tools or record blocked work as no-change or completed. Approval is granted only by the user in Settings, never by you. For source-batch page/database decisions, use the dedicated maintenance writers below so completion receipts remain atomic. Read the original source turns fully, route only eligible resources from the trusted index, and make changes only when the source supports them. Before writing a resource, finish reading its complete content and decide the full set of related changes. Preserve unrelated content and prefer updating a matching existing block or row over inserting a duplicate. Each (source turn, Page or database) pair permits one final atomic write call: include every intended operation in that call, then treat its response as final for that resource. Protected existing content may be returned in result.proposed rather than applied; those proposals are durable handling and the final result for this run. After a successful response with applied or proposed entries, do not call the writer again or record no-change for that resource. Only an exact retry of the same operation set replays its receipt; do not add a second operation set. Page reads return at most 20 blocks per call; continue with nextOffset. Database reads return at most five rows and four selected columns per call, capped at 64 KB; use nextCursor and request specific columnIds. Row bodies are omitted unless explicitly requested. Cite source evidence through the tool arguments and stop when the tools report stale authority or incomplete source coverage. Never claim a change succeeded unless its maintenance tool reports success.`;

export function isMaintenanceProfile(profile: RuntimeToolProfile | null | undefined): boolean {
  return profile?.maintenance === true;
}

/** How maintenance keeps a workspace's task database. The maintenance agent reads no documents, so every batch's prompt carries it. */
const TASK_RULES = 'A resource whose role is "tasks" is the workspace\'s task database: one row per task, a goal rather than a conversation. For a source that works on a goal, call maintenance_route_source once with every resource the source should change, including the task database (routing is final, and maintenance_list_tasks fails until the task database is routed), then call maintenance_list_tasks with the source\'s nodeId (and words of its goal), then write the tasks with maintenance_write_database: update the tasks that link the source, link the source to a task it works on, and add a task only for a goal no task covers. Core columns: task (the goal), status (todo, doing, waiting or done; leave statuses a person added alone), threads (the conversations a task links, at most 20, all from this workspace) and next (one line). Use waiting (Waiting on you) only when the user must decide, reply or confirm. A finished turn does not make a task done: done needs evidence that the goal is reached. Unlink the conversations in goneConversationIds. Never invent tasks, next steps or links. A status or cell the user set comes back as a suggestion. Do not route the task database for a source that works on no goal.';

/** Model-only routing index; the maintenance tools re-check every choice against the durable plan. */
export function maintenanceContextPrompt(context: MaintenanceTurnContext): string {
  if (context.sources.length > 100) throw new Error('Maintenance batch exceeds the bounded source limit');
  // A home run (first read, Spaces Home summary) reads no batch: its prompt says what to read.
  if (context.sources.length === 0) return '';
  const sources = context.sources.map((source) => {
    return {
      sourceTurnId: source.sourceTurnId,
      evidence: source.evidence,
    };
  });
  const json = JSON.stringify(sources);
  if (json.length > 512_000) throw new Error('Maintenance routing context exceeds the bounded prompt size');
  return `Trusted maintenance source index (eligible turn IDs only):\n${json}\n\nFor each source in completion order, finish reading its source messages, then enumerate the entire eligible resource manifest with maintenance_list_resources using offset/limit pages until nextOffset is null. Decide relevant resources only after reviewing the complete manifest. Call maintenance_route_source once for that source, then read each routed resource completely before planning its full set of related changes. A page read includes layoutPreferences.text, the user's instruction document for this page only, alongside layoutRules. Follow both when writing this page: they come before the block-shape guidance in this prompt, and only program-applied sectionLimit rules override them. Never add, change or drop these preferences or rules. Preserve unrelated content and prefer updating a matching existing block or row over inserting a duplicate. When a source changes a block, keep the block in shape instead of only appending to it: a summary callout stays at most two sentences, a timeline entry's detail stays one sentence, and finished or superseded steps leave next-steps. When the content no longer fits its block type (for example open steps that became checks with states), replace that block in the same write: an update keeps the block type, so delete it and insert one of a fitting type in its place. Replace only blocks no person edited (blocks without an edit field); a block a person edited is updated in place, which becomes a suggestion. Make one final atomic write call per (source turn, resource), with all intended operations included. Protected parts of edits appear in result.proposed, and those protected values/content remain unchanged; the proposal is durable handling and completes that resource decision. After a successful applied/proposed response, make no further write or no-change call for that resource. Only an exact retry of the same operation set replays its receipt; never add a second operation set. A recovered run may find a source already routed: routing is final, so do not route it again. maintenance_list_resources then returns that source's routed resources with each decision and changes nothing; continue from those. Reading a routed resource again from its first page (offset 0, no cursor) refreshes its revision, so a resource that changed after routing, or a write refused because its target changed, is recovered by reading it again from the start and then writing or recording no change from what you read. A resource listed with available:false left its routed pages and cannot be written: read it once from its first page and the system records it as skipped; do this for each such entry or the source stays unfinished. The workspace task database stays available when its board route changed: reading it adopts the new route. Complete that source's durable decisions before starting the next source. The list is not write authority; tools validate every choice against the active plan. ${TASK_RULES}`;
}

/** What goes before a maintenance turn's text: the source index and a separator, or nothing when there is no index. */
export function maintenancePromptPrefix(context: MaintenanceTurnContext | null | undefined): string {
  const prompt = context ? maintenanceContextPrompt(context) : '';
  return prompt ? `${prompt}\n\n---\n\n` : '';
}

/** Thrown by adapters that cannot host the Meta agent's maintenance toolset (Crew). */
export class MaintenanceRuntimeUnsupportedError extends Error {
  constructor(runtimeId: string) {
    super(maintenanceRuntimeAvailability(runtimeId).reason ?? `Runtime "${runtimeId}" cannot host unattended maintenance.`);
    this.name = 'MaintenanceRuntimeUnsupportedError';
  }
}
