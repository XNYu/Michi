import type { HomeSectionKey, PageLayoutRule } from 'michi-shared';
import type { ChatMessage, ToolCallState } from '../chatTypes';
import { normalizeToolResultEnvelope, normalizeTurnToolName, parseTurnPageReceipt } from '../../lib/turnPageReceipt';
import { pageCardStands } from './pageCardStates';

/** The section limit a layout-rule suggestion asks for. */
export interface MetaChatRuleAsk {
  section: HomeSectionKey;
  maxAgeDays: number;
}

export interface MetaChatSuggestion {
  id: string;
  label: string;
  /** Asks for a change to a page: hidden once applied and not undone. */
  edit?: boolean;
  /** Asks for a layout rule: hidden while the page on screen has it. */
  rule?: MetaChatRuleAsk;
}

export type MetaChatPageKind = 'home' | 'workspace' | 'page';

export const SPACES_SUGGESTIONS: Record<MetaChatPageKind, readonly MetaChatSuggestion[]> = {
  home: [
    { id: 'home-waiting', label: 'Who is waiting on me?' },
    { id: 'home-stalled-rule', label: 'Stalled: only the last 3 days', edit: true, rule: { section: 'stalled', maxAgeDays: 3 } },
    { id: 'home-countdown', label: 'Add a block: release countdown', edit: true },
    { id: 'home-mine', label: 'Add “mobile” to what I wrote', edit: true },
    { id: 'home-trim', label: 'Trim a workspace’s progress to 3', edit: true },
    { id: 'home-quiet', label: 'Why did a workspace stall?' },
  ],
  workspace: [
    { id: 'workspace-start', label: 'Start a conversation for the next step' },
    { id: 'workspace-top', label: 'Trim progress to the top 3', edit: true },
    { id: 'workspace-subpage', label: 'Add a “Performance” page', edit: true },
    { id: 'workspace-tests', label: 'Who is running the tests?' },
  ],
  page: [
    { id: 'page-risk', label: 'What is the biggest risk right now?' },
    { id: 'page-short', label: 'Summarize this page in 3 lines' },
    { id: 'page-questions', label: 'Add a block for open questions', edit: true },
    { id: 'page-author', label: 'Who wrote this page?' },
  ],
};

/** A layout_rules call that stored a rule. */
function addedLayoutRule(tool: ToolCallState): boolean {
  if (tool.status !== 'completed' || normalizeTurnToolName(tool.title, ['layout_rules']) !== 'layout_rules') return false;
  return normalizeToolResultEnvelope(tool.output).some((value) =>
    !!value && typeof value === 'object' && !Array.isArray(value) && 'added' in value && 'layoutRules' in value);
}

/** Whether `reply` wrote a page change or a layout rule, or left a suggestion, that still stands. */
function replyWroteStanding(reply: ChatMessage): boolean {
  return reply.toolCalls.some((tool) => {
    if (addedLayoutRule(tool)) return true;
    const receipt = parseTurnPageReceipt(tool, 'local');
    if (!receipt) return false;
    if (receipt.created) return pageCardStands(tool.id, { kind: 'created', removed: false });
    if (receipt.appliedCount > 0) return pageCardStands(tool.id, { kind: 'applied', undone: false });
    return receipt.proposedCount > 0 && pageCardStands(tool.id, { kind: 'suggestion', resolved: null });
  });
}

/** Follow-up rows are a full line each: past three, they squeeze the conversation out of a 520px window. */
export const MAX_SUGGESTIONS = 3;

const plain = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Whether `rules` already holds what `suggestion` asks for: the same section limit, or a rule worded like the suggestion. */
export function pageHasRule(suggestion: MetaChatSuggestion, rules: readonly PageLayoutRule[]): boolean {
  const ask = suggestion.rule;
  if (!ask) return false;
  return rules.some((rule) => (rule.sectionLimit?.section === ask.section && rule.sectionLimit.maxAgeDays === ask.maxAgeDays)
    || plain(rule.text) === plain(suggestion.label));
}

/**
 * The suggestions to show: an edit suggestion the conversation already carried
 * out drops out, until its change is undone (or its suggestion ignored). A
 * layout-rule suggestion follows the page instead once its rules are known
 * (`layoutRules` non-null): hidden while the rule is there, back when it is deleted.
 */
export function visibleSuggestions(
  suggestions: readonly MetaChatSuggestion[],
  messages: readonly ChatMessage[],
  layoutRules: readonly PageLayoutRule[] | null = null,
): MetaChatSuggestion[] {
  const done = new Set<string>();
  messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    const reply = messages.slice(index + 1).find((m) => m.role === 'assistant');
    if (reply && replyWroteStanding(reply)) done.add(message.text.trim());
  });
  return suggestions.filter((suggestion) => {
    if (suggestion.rule && layoutRules) return !pageHasRule(suggestion, layoutRules);
    return !suggestion.edit || !done.has(suggestion.label);
  }).slice(0, MAX_SUGGESTIONS);
}
