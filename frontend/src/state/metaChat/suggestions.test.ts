import { afterEach, describe, expect, it } from 'vitest';
import type { PageLayoutRule } from 'michi-shared';
import type { ChatMessage, ToolCallState } from '../chatTypes';
import { MAX_SUGGESTIONS, SPACES_SUGGESTIONS, pageHasRule, visibleSuggestions } from './suggestions';
import { resetPageCardStatesForTests, setPageCardState } from './pageCardStates';

const write = (id: string, appliedCount: number, proposedCount = 0): ToolCallState => ({
  id, title: 'Running: @michi/edit_page', status: 'completed', kind: 'other',
  output: JSON.stringify({ michiPageWrite: { kind: 'michiPageWrite', resourceKind: 'page', resourceId: 'pg', title: 'rabbitholes', appliedCount, proposedCount, affectedTargetIds: [] } }),
} as ToolCallState);
const user = (text: string): ChatMessage => ({ id: `u-${text}`, role: 'user', text, toolCalls: [] } as unknown as ChatMessage);
const reply = (...tools: ToolCallState[]): ChatMessage => ({ id: `a-${tools[0]?.id ?? 'x'}`, role: 'assistant', text: 'ok', toolCalls: tools } as unknown as ChatMessage);

const trim = SPACES_SUGGESTIONS.workspace.find((s) => s.id === 'workspace-top')!;
const labels = (messages: ChatMessage[]) => visibleSuggestions(SPACES_SUGGESTIONS.workspace, messages).map((s) => s.id);

afterEach(resetPageCardStatesForTests);

describe('visibleSuggestions', () => {
  it('drops an edit suggestion once its change was applied, and brings it back when undone', () => {
    expect(labels([])).toContain('workspace-top');
    const messages = [user(trim.label), reply(write('t1', 1))];
    expect(labels(messages)).not.toContain('workspace-top');
    setPageCardState('t1', { kind: 'applied', undone: true });
    expect(labels(messages)).toContain('workspace-top');
  });

  it('counts a suggestion left on the page until it is ignored, and keeps questions after they were asked', () => {
    const proposed = [user(trim.label), reply(write('t2', 0, 1))];
    expect(labels(proposed)).not.toContain('workspace-top');
    setPageCardState('t2', { kind: 'suggestion', resolved: 'dismissed' });
    expect(labels(proposed)).toContain('workspace-top');
    const question = SPACES_SUGGESTIONS.workspace.find((s) => !s.edit)!;
    expect(labels([user(question.label), reply(write('t3', 1))])).toContain(question.id);
  });

  it('has a set per page type and shows three at most, the next one moving up once an edit is done', () => {
    expect(Object.keys(SPACES_SUGGESTIONS)).toEqual(['home', 'workspace', 'page']);
    for (const list of Object.values(SPACES_SUGGESTIONS)) expect(list.length).toBeGreaterThan(MAX_SUGGESTIONS);
    expect(labels([])).toEqual(['workspace-start', 'workspace-top', 'workspace-subpage']);
    expect(labels([user(trim.label), reply(write('t4', 1))])).toEqual(['workspace-start', 'workspace-subpage', 'workspace-tests']);
  });

  it('drops “Stalled: only the last 3 days” once the reply stored it as a layout rule', () => {
    const stalled = SPACES_SUGGESTIONS.home.find((s) => s.id === 'home-stalled-rule')!;
    expect(stalled).toMatchObject({ label: 'Stalled: only the last 3 days', edit: true });
    const homeIds = (messages: ChatMessage[]) => visibleSuggestions(SPACES_SUGGESTIONS.home, messages).map((s) => s.id);
    const rule = (status: string, output: unknown): ToolCallState => ({
      id: `rule-${status}`, title: 'Running: @michi/layout_rules', status, kind: 'other', output: JSON.stringify(output),
    } as ToolCallState);
    expect(homeIds([])).toContain('home-stalled-rule');
    const stored = { added: { id: 'r1', text: stalled.label }, page: { id: 'pg', title: 'Home' }, layoutRules: [{ id: 'r1', text: stalled.label }] };
    expect(homeIds([user(stalled.label), reply(rule('completed', stored))])).not.toContain('home-stalled-rule');
    expect(homeIds([user(stalled.label), reply(rule('failed', { error: 'Page not found' }))])).toContain('home-stalled-rule');
    expect(homeIds([user(stalled.label), reply(rule('completed', { page: { id: 'pg', title: 'Home' }, layoutRules: [] }))])).toContain('home-stalled-rule');
  });

  it('follows the page once its layout rules are known: hidden while the rule is there, back when it is deleted', () => {
    const homeIds = (messages: ChatMessage[], rules: PageLayoutRule[] | null) => visibleSuggestions(SPACES_SUGGESTIONS.home, messages, rules).map((s) => s.id);
    const ruleOf = (patch: Partial<PageLayoutRule>): PageLayoutRule => ({ id: 'r1', text: 'Keep it short', sourceMessage: null, createdBy: 'agent', createdAt: 1, ...patch });
    const stalledLimit = ruleOf({ text: 'Stalled shows only items that moved in the last 3 days', sectionLimit: { section: 'stalled', maxAgeDays: 3 } });

    // Stored outside this conversation (another session, or the user typed it differently).
    expect(homeIds([], [stalledLimit])).not.toContain('home-stalled-rule');
    expect(homeIds([], [ruleOf({ text: '  stalled: ONLY the last 3 days ' })])).not.toContain('home-stalled-rule');
    // A different limit or section is not what the suggestion asks for.
    expect(homeIds([], [ruleOf({ sectionLimit: { section: 'stalled', maxAgeDays: 7 } })])).toContain('home-stalled-rule');
    expect(homeIds([], [ruleOf({ sectionLimit: { section: 'done', maxAgeDays: 3 } })])).toContain('home-stalled-rule');

    // Stored in this conversation, then deleted from the page's layout rules menu.
    const stored = { id: 'rule-ok', title: 'Running: @michi/layout_rules', status: 'completed', kind: 'other',
      output: JSON.stringify({ added: { id: 'r1' }, page: { id: 'pg', title: 'Home' }, layoutRules: [{ id: 'r1' }] }) } as ToolCallState;
    const asked = [user('Stalled: only the last 3 days'), reply(stored)];
    expect(homeIds(asked, null)).not.toContain('home-stalled-rule');
    expect(homeIds(asked, [stalledLimit])).not.toContain('home-stalled-rule');
    expect(homeIds(asked, [])).toContain('home-stalled-rule');
  });

  it('matches a rule by section limit or by wording', () => {
    const stalled = SPACES_SUGGESTIONS.home.find((s) => s.id === 'home-stalled-rule')!;
    const base = { id: 'r', sourceMessage: null, createdBy: 'user' as const, createdAt: 1 };
    expect(pageHasRule(stalled, [{ ...base, text: 'x', sectionLimit: { section: 'stalled', maxAgeDays: 3, maxItems: 5 } }])).toBe(true);
    expect(pageHasRule(stalled, [{ ...base, text: 'Stalled:\u00a0only the last 3 days' }])).toBe(true);
    expect(pageHasRule(SPACES_SUGGESTIONS.home[0]!, [{ ...base, text: 'Who is waiting on me?' }])).toBe(false);
  });
});
