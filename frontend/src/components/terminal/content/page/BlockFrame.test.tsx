import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { MichiPageBlock } from 'michi-shared';
import { BlockFrame, type ApplyResult, type PageChrome } from './BlockFrame';
import type { MichiBlockCtx } from './blockTypes';

// Markdown rendering is MarkdownContent's own concern.
vi.mock('../../../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <div data-testid="md">{text}</div> }));

const plan: MichiPageBlock = {
  type: 'plan-actual',
  id: 'pa',
  title: 'Plan vs actual',
  items: [{ label: 'Schema', planned: 2, actual: 3, unit: 'd' }],
  sources: [
    { nodeId: 'sess-1', messageId: 'm1' },
    { nodeId: 'c0ffee99-1234', path: 'crew-mcp/tests/fixtures.ts' },
  ],
};
const note: MichiPageBlock = { type: 'markdown', id: 'md', text: 'S3 naming is snake_case.' };

function makeChrome(result: ApplyResult = 'ok', extra: Partial<PageChrome> = {}): PageChrome {
  return {
    projectId: 'p1',
    generatedAt: 100,
    ask: vi.fn(),
    branch: vi.fn(),
    apply: vi.fn(() => Promise.resolve(result)),
    notice: vi.fn(),
    copy: vi.fn(),
    copyText: vi.fn(),
    copyLink: vi.fn(),
    moving: vi.fn(() => false),
    orphan: vi.fn(),
    findBlock: vi.fn(() => null),
    sources: vi.fn(() => [
      { key: '0', kind: 'conversation' as const, label: 'KiroCrew · S7', detail: '2d', threadId: 't7' },
      { key: '1', kind: 'conversation' as const, label: 'Conversation c0ffee99' },
      { key: '1:path', kind: 'file' as const, label: 'crew-mcp/tests/fixtures.ts', path: 'crew-mcp/tests/fixtures.ts' },
    ]),
    openThread: vi.fn(),
    move: vi.fn(),
    select: vi.fn(),
    marginDown: vi.fn(),
    marginEnter: vi.fn(),
    dragStart: vi.fn(),
    takeDragged: vi.fn(() => false),
    ...extra,
  };
}

const ctx: MichiBlockCtx = { depth: 0 };

function renderFrame(block: MichiPageBlock = plan, chrome: PageChrome | null = makeChrome(), extra: Partial<React.ComponentProps<typeof BlockFrame>> = {}) {
  const props = { id: 'michi-block-0', block, ctx, chrome, index: 1, count: 3, ...extra };
  const utils = render(<BlockFrame {...props} />);
  const rerender = (next: Partial<React.ComponentProps<typeof BlockFrame>>) => utils.rerender(<BlockFrame {...props} {...next} />);
  return { ...utils, chrome, rerender };
}

const flush = () => act(async () => { await Promise.resolve(); });
/** A mouse click: browsers count it (`detail` 1); a key press on a button reports 0. */
const mouse = { detail: 1 };

describe('BlockFrame', () => {
  it('allows a native adapter to supply renderers and hide Michi-owned actions', () => {
    const renderBlock = vi.fn(() => <div data-testid="native-block">Native content</div>);
    const renderDecorations = vi.fn(() => <div data-testid="native-decoration">Native mark</div>);
    renderFrame(note, makeChrome('ok', { capabilities: { ask: false, branch: false, sources: false, copyLink: false, select: false, drag: false } }), { renderBlock, renderDecorations });
    expect(screen.getByTestId('native-block')).toBeTruthy();
    expect(screen.getByTestId('native-decoration')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Branch' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('draws the block inside an anchor for the outline, named by its title', () => {
    renderFrame();
    const group = screen.getByRole('group', { name: 'Plan vs actual' });
    expect(group.id).toBe('michi-block-0');
    expect(group.dataset.blockId).toBe('pa');
    expect(group.querySelector('[data-michi-block="plan-actual"]')).not.toBeNull();
  });

  it('draws a bare block without chrome', () => {
    renderFrame(plan, null);
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Block menu' })).toBeNull();
  });

  it('keeps sources folded until asked, then lists them; a known conversation opens its thread', () => {
    const { chrome } = renderFrame();
    expect(screen.queryByRole('dialog', { name: 'Sources for Plan vs actual' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sources 2' }));
    const pop = screen.getByRole('dialog', { name: 'Sources for Plan vs actual' });
    expect(pop.textContent).toContain('Sources · 2');
    expect(pop.textContent).toContain('KiroCrew · S7');
    expect(pop.textContent).toContain('crew-mcp/tests/fixtures.ts');
    fireEvent.click(within(pop).getByRole('button', { name: /KiroCrew · S7/ }));
    expect(chrome!.openThread).toHaveBeenCalledWith('t7');
    expect(screen.queryByRole('dialog', { name: 'Sources for Plan vs actual' })).toBeNull();
  });

  it('has no Sources and no Edit on a data block without sources', () => {
    renderFrame({ type: 'metrics', id: 'm', items: [{ label: 'Used', value: '7 days' }] });
    expect(screen.queryByRole('button', { name: /Sources/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Branch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
  });

  it('branches with the block', () => {
    const { chrome } = renderFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }));
    expect(chrome!.branch).toHaveBeenCalledWith(plan);
  });

  describe('Ask', () => {
    it('sends a typed question to the assistant with the block, and closes', () => {
      const { chrome } = renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
      const input = screen.getByRole('textbox', { name: 'Question about Plan vs actual' });
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: '  Why did schema run over?  ' } });
      fireEvent.submit(input.closest('form')!);
      expect(chrome!.ask).toHaveBeenCalledWith(plan, 'Why did schema run over?');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('sends a suggestion in one click and hands focus back to Ask', () => {
      const { chrome } = renderFrame();
      const ask = screen.getByRole('button', { name: 'Ask' });
      fireEvent.click(ask);
      fireEvent.click(screen.getByRole('button', { name: 'Why is this late?' }));
      expect(chrome!.ask).toHaveBeenCalledWith(plan, 'Why is this late?');
      expect(document.activeElement).toBe(ask);
    });

    it('closes on Escape without the page seeing it', () => {
      const onWindowKey = vi.fn();
      window.addEventListener('keydown', onWindowKey);
      renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      window.removeEventListener('keydown', onWindowKey);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(onWindowKey).not.toHaveBeenCalled();
    });

    it('opens from / on the focused block', () => {
      renderFrame();
      const group = screen.getByRole('group', { name: 'Plan vs actual' });
      group.focus();
      fireEvent.keyDown(group, { key: '/' });
      expect(screen.getByRole('dialog', { name: 'Ask about Plan vs actual' })).toBeTruthy();
    });
  });

  describe('editing', () => {
    it('edits Markdown in place and saves the whole block with the version it opened on', async () => {
      const { chrome } = renderFrame(note);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const field = screen.getByRole('textbox', { name: /^Edit / }) as HTMLTextAreaElement;
      expect(field.value).toBe('S3 naming is snake_case.');
      expect(document.activeElement).toBe(field);
      expect(screen.getByText('Save', { selector: 'button' })).toBeTruthy();
      fireEvent.change(field, { target: { value: 'S3 naming is snake_case; I’ll reply this afternoon.' } });
      fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith(
        [{ op: 'update', id: 'md', block: { type: 'markdown', id: 'md', text: 'S3 naming is snake_case; I’ll reply this afternoon.' } }],
        'Page updated',
        100,
      );
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('cancels on Esc without sending, and the page does not see that Esc', () => {
      const onWindowKey = vi.fn();
      window.addEventListener('keydown', onWindowKey);
      const { chrome } = renderFrame(note);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const field = screen.getByRole('textbox', { name: /^Edit / });
      fireEvent.change(field, { target: { value: 'changed' } });
      fireEvent.keyDown(field, { key: 'Escape' });
      window.removeEventListener('keydown', onWindowKey);
      expect(chrome!.apply).not.toHaveBeenCalled();
      expect(onWindowKey).not.toHaveBeenCalled();
      expect(screen.getByTestId('md').textContent).toBe('S3 naming is snake_case.');
    });

    it('closes without sending when nothing changed or the words were emptied', async () => {
      const { chrome } = renderFrame(note);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.click(screen.getByText('Save', { selector: 'button' }));
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: '   ' } });
      fireEvent.click(screen.getByText('Save', { selector: 'button' }));
      await flush();
      expect(chrome!.apply).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('keeps the words when Michi refuses the save because the page changed, and reapplies them to the new page', async () => {
      const chrome = makeChrome('stale');
      const { rerender } = renderFrame(note, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: 'My new words' } });
      fireEvent.click(screen.getByText('Save', { selector: 'button' }), mouse);
      await flush();
      expect((screen.getByRole('textbox', { name: /^Edit / }) as HTMLTextAreaElement).value).toBe('My new words');
      expect(screen.getByRole('status').textContent).toContain('The page changed');
      expect((screen.getByText('Save', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(chrome.copyText).toHaveBeenCalledWith('My new words', 'your text');

      // The page Michi rearranged arrives with this block as it was; Reapply sends the same change against it.
      const next = makeChrome('ok', { generatedAt: 200 });
      rerender({ chrome: next, block: { ...note } });
      fireEvent.click(screen.getByRole('button', { name: 'Reapply' }), mouse);
      await flush();
      expect(next.apply).toHaveBeenCalledWith(
        [{ op: 'update', id: 'md', block: { type: 'markdown', id: 'md', text: 'My new words' } }],
        'Page updated',
        200,
      );
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('never writes over a block the agent rewrote under the editor; shows its words and offers to add below', async () => {
      const chrome = makeChrome('stale');
      const { rerender } = renderFrame(note, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: 'My new words' } });
      fireEvent.click(screen.getByText('Save', { selector: 'button' }), mouse);
      await flush();
      // The rearranged page keeps the id but the agent wrote something else there.
      const next = makeChrome('ok', { generatedAt: 200 });
      rerender({ chrome: next, block: { ...note, text: 'The agent rewrote this.' } });
      expect(screen.queryByRole('button', { name: 'Reapply' })).toBeNull();
      // Someone elsewhere may have changed it as well as the agent: the note doesn't say who.
      expect(screen.getByText('This block changed while you were editing. It now says:')).toBeTruthy();
      expect(screen.getByLabelText('What the block says now').textContent).toBe('The agent rewrote this.');
      expect((screen.getByText('Save', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('textbox', { name: /^Edit / }) as HTMLTextAreaElement).value).toBe('My new words');
      fireEvent.keyDown(screen.getByRole('textbox', { name: /^Edit / }), { key: 'Enter', metaKey: true });
      await flush();
      expect(next.apply).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Add as new block below' }), mouse);
      await flush();
      expect(next.apply).toHaveBeenCalledWith(
        [{ op: 'insert', after: 'md', block: { type: 'markdown', text: 'My new words' } }], 'Block added', 200,
      );
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('replaces the agent’s new words only when asked to while they are shown', async () => {
      const { rerender } = renderFrame(note);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: 'Mine' } });
      const next = makeChrome('ok', { generatedAt: 200 });
      rerender({ chrome: next, block: { ...note, text: 'Theirs', sources: [{ nodeId: 's9' }] } });
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }), mouse);
      await flush();
      expect(next.apply).toHaveBeenCalledWith(
        [{ op: 'update', id: 'md', block: { type: 'markdown', id: 'md', text: 'Mine', sources: [{ nodeId: 's9' }] } }], 'Page updated', 200,
      );
    });

    it('offers no Replace when the block became another kind', () => {
      const { rerender } = renderFrame(note);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      rerender({ block: { type: 'quote', id: 'md', text: 'Now a quote' } });
      expect(screen.getByRole('button', { name: 'Add as new block below' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
      // Still the editor it opened as, with the words typed.
      expect((screen.getByRole('textbox', { name: /^Edit / }) as HTMLTextAreaElement).value).toBe('S3 naming is snake_case.');
    });

    it('does not edit another paragraph when a piece id shifts to it', async () => {
      // `intro~1` was "Second." — a paragraph added above makes `intro~1` "New first." and moves "Second." to `intro~2`.
      const piece = { type: 'markdown', id: 'intro~1', text: 'Second.' } as MichiPageBlock;
      const chrome = makeChrome('stale');
      const { rerender } = renderFrame(piece, chrome, { segmentOf: 'intro' });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: 'Second, edited.' } });
      fireEvent.click(screen.getByText('Save', { selector: 'button' }), mouse);
      await flush();
      const next = makeChrome('ok', { generatedAt: 200 });
      rerender({ chrome: next, block: { type: 'markdown', id: 'intro~1', text: 'New first.' } });
      expect(screen.queryByRole('button', { name: 'Reapply' })).toBeNull();
      expect(screen.getByLabelText('What the block says now').textContent).toBe('New first.');
      expect(next.apply).not.toHaveBeenCalled();
      // A piece of the same block with the same words still matches: an unrelated edit elsewhere in the block.
      rerender({ chrome: next, block: piece });
      expect(screen.getByRole('button', { name: 'Reapply' })).toBeTruthy();
    });

    it('keeps editing a piece that became a block of its own with the same words', async () => {
      // An edit elsewhere in `intro` cut it into one block per paragraph: `intro~1` is now a block, saying what it said.
      const piece = { type: 'markdown', id: 'intro~1', text: 'Second.' } as MichiPageBlock;
      const { rerender } = renderFrame(piece, makeChrome('ok'), { segmentOf: 'intro' });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: 'Second, edited.' } });
      const next = makeChrome('ok', { generatedAt: 200 });
      rerender({ chrome: next, block: { ...piece }, segmentOf: undefined });
      expect(screen.queryByLabelText('What the block says now')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Reapply' }), mouse);
      await flush();
      expect(next.apply).toHaveBeenCalledWith(
        [{ op: 'update', id: 'intro~1', block: { type: 'markdown', id: 'intro~1', text: 'Second, edited.' } }], 'Page updated', 200,
      );
    });

    it('adds a new block under a piece that became a block of its own, where it stands', async () => {
      const piece = { type: 'markdown', id: 'intro~1', text: 'Second.' } as MichiPageBlock;
      const chrome = makeChrome('ok');
      const { rerender } = renderFrame(piece, chrome, { segmentOf: 'intro' });
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'New text' }), { target: { value: 'After second' } });
      rerender({ block: { ...piece }, segmentOf: undefined });
      fireEvent.click(screen.getByText('Add', { selector: 'button' }), mouse);
      await flush();
      expect(chrome.findBlock).not.toHaveBeenCalled();
      expect(chrome.orphan).not.toHaveBeenCalled();
      expect(chrome.apply).toHaveBeenCalledWith(
        [{ op: 'insert', after: 'intro~1', block: { type: 'markdown', text: 'After second' } }], 'Block added', 100,
      );
    });

    it('adds a new block under the words it was opened below, wherever they went', async () => {
      const piece = { type: 'markdown', id: 'intro~1', text: 'Second.' } as MichiPageBlock;
      const findBlock = vi.fn(() => 'intro~2');
      const chrome = makeChrome('ok', { findBlock });
      const { rerender } = renderFrame(piece, chrome, { segmentOf: 'intro' });
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'New text' }), { target: { value: 'After second' } });
      rerender({ block: { type: 'markdown', id: 'intro~1', text: 'New first.' } });
      fireEvent.click(screen.getByText('Add', { selector: 'button' }), mouse);
      await flush();
      expect(findBlock).toHaveBeenCalledWith(JSON.stringify(['intro', 'markdown', 'Second.', '', null, null, null]));
      expect(chrome.apply).toHaveBeenCalledWith(
        [{ op: 'insert', after: 'intro~2', block: { type: 'markdown', text: 'After second' } }], 'Block added', 100,
      );
    });

    it('keeps a new block’s words for the page when what it went under is gone', async () => {
      const chrome = makeChrome('ok');
      const { rerender } = renderFrame(note, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.click(screen.getByRole('button', { name: 'Other blocks' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'To-do' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'New to-do list' }), { target: { value: 'Call the hotel' } });
      rerender({ block: { ...note, text: 'Rewritten.' } });
      fireEvent.click(screen.getByText('Add', { selector: 'button' }), mouse);
      await flush();
      expect(chrome.apply).not.toHaveBeenCalled();
      expect(chrome.orphan).toHaveBeenCalledWith({ label: 'New to-do list', markdown: '- [ ] Call the hotel', text: 'Call the hotel' });
      expect(screen.queryByRole('textbox', { name: 'New to-do list' })).toBeNull();
    });

    it('says the page changed as soon as a new version arrives, before Save', () => {
      const { rerender } = renderFrame(note);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: 'typing' } });
      expect(screen.queryByRole('status')).toBeNull();
      rerender({ chrome: makeChrome('ok', { generatedAt: 300 }) });
      expect(screen.getByRole('status').textContent).toContain('The page changed');
      expect((screen.getByRole('textbox', { name: /^Edit / }) as HTMLTextAreaElement).value).toBe('typing');
      expect(screen.getByRole('button', { name: 'Reapply' })).toBeTruthy();
    });

    it('stays open with the words when the save failed', async () => {
      renderFrame(note, makeChrome('failed'));
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: 'new' } });
      fireEvent.click(screen.getByText('Save', { selector: 'button' }), mouse);
      await flush();
      expect((screen.getByRole('textbox', { name: /^Edit / }) as HTMLTextAreaElement).value).toBe('new');
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('hands the words to the page when the block leaves it with its editor open', () => {
      const chrome = makeChrome();
      const { unmount } = renderFrame({ type: 'heading', id: 'h', level: 2, text: 'Progress' }, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit Progress' }), { target: { value: 'Progress, week 2' } });
      unmount();
      expect(chrome.orphan).toHaveBeenCalledWith({ label: 'Progress', markdown: '## Progress, week 2', text: 'Progress, week 2' });
    });

    it('keeps nothing when the editor held only what the block already said, or was closed', () => {
      const chrome = makeChrome();
      const first = renderFrame(note, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      first.unmount();
      const second = renderFrame(note, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.click(screen.getByRole('button', { name: 'Other blocks' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'To-do' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'New to-do list' }), { target: { value: 'Call the hotel' } });
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'New to-do list' }), { key: 'Escape' });
      second.unmount();
      expect(chrome.orphan).not.toHaveBeenCalled();
    });

    it('rescues a half-written new block too, as its Markdown', () => {
      const chrome = makeChrome();
      const { unmount } = renderFrame(note, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.click(screen.getByRole('button', { name: 'Other blocks' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'To-do' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'New to-do list' }), { target: { value: 'Call the hotel\nPack' } });
      unmount();
      expect(chrome.orphan).toHaveBeenCalledWith({ label: 'New to-do list', markdown: '- [ ] Call the hotel\n- [ ] Pack', text: 'Call the hotel\nPack' });
    });

    it('holds each field to what Michi keeps', () => {
      renderFrame({ type: 'heading', id: 'h', level: 2, text: 'Progress' });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect((screen.getByRole('textbox', { name: 'Edit Progress' }) as HTMLInputElement).maxLength).toBe(200);
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit Progress' }), { key: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.click(screen.getByRole('button', { name: 'Other blocks' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'To-do' }));
      const field = screen.getByRole('textbox', { name: 'New to-do list' }) as HTMLTextAreaElement;
      expect(field.maxLength).toBe(2000);
      // Each line gains its "- [ ] ", so these 1,990 characters come to more than one block holds.
      fireEvent.change(field, { target: { value: Array.from({ length: 199 }, () => 'abcdefghi').join('\n') } });
      expect(screen.getByText(/too long for one block/)).toBeTruthy();
      expect((screen.getByText('Add', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('stops a checklist at 50 items', () => {
      const items = Array.from({ length: 50 }, (_, i) => ({ text: `Item ${i}`, done: false }));
      renderFrame({ type: 'checklist', id: 'cl', title: 'Long', items });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect((screen.getByRole('button', { name: /Add item/ }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText('50 items at most')).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Item 50' }), { key: 'Enter' });
      expect(screen.queryByRole('textbox', { name: 'Item 51' })).toBeNull();
    });

    it('edits a heading on one line; Enter saves', async () => {
      const { chrome } = renderFrame({ type: 'heading', id: 'h', level: 2, text: 'Progress' });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const field = screen.getByRole('textbox', { name: 'Edit Progress' });
      expect(field.tagName).toBe('INPUT');
      fireEvent.change(field, { target: { value: 'Progress this week' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith(
        [{ op: 'update', id: 'h', block: { type: 'heading', id: 'h', level: 2, text: 'Progress this week' } }], 'Page updated', 100,
      );
    });

    it('edits a callout’s title on its own line above its words', async () => {
      const { chrome } = renderFrame({ type: 'callout', id: 'c1', tone: 'warn', title: 'Blockers', text: 'S3 naming' });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const title = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
      const words = screen.getByRole('textbox', { name: 'Edit Blockers' });
      expect(title.value).toBe('Blockers');
      expect(title.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The words keep the caret; Enter in the title goes on to them.
      expect(document.activeElement).toBe(words);
      fireEvent.change(title, { target: { value: 'Hard questions' } });
      fireEvent.keyDown(title, { key: 'Enter' });
      expect(document.activeElement).toBe(words);
      fireEvent.keyDown(words, { key: 'Enter', metaKey: true });
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith(
        [{ op: 'update', id: 'c1', block: { type: 'callout', id: 'c1', tone: 'warn', title: 'Hard questions', text: 'S3 naming' } }], 'Page updated', 100,
      );
    });

    it('edits and adds checklist items', async () => {
      const list: MichiPageBlock = { type: 'checklist', id: 'cl', title: 'Before leaving', items: [{ text: 'Passport', done: true }] };
      const { chrome } = renderFrame(list);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Item 1' }), { target: { value: 'Passport valid 6 months' } });
      fireEvent.click(screen.getByRole('button', { name: /Add item/ }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Item 2' }), { target: { value: 'Buy ICOCA' } });
      fireEvent.click(screen.getByText('Save', { selector: 'button' }));
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith([{
        op: 'update', id: 'cl', block: {
          type: 'checklist', id: 'cl', title: 'Before leaving',
          items: [{ text: 'Passport valid 6 months', done: true }, { text: 'Buy ICOCA', done: false }],
        },
      }], 'Page updated', 100);
    });

    it('offers no Edit for kinds Michi does not let a person rewrite', () => {
      renderFrame({ type: 'quote', id: 'q', text: 'Ship it.' });
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    });
  });

  describe('marks', () => {
    it('tags a block the person edited, and offers to hand it back', async () => {
      const { chrome } = renderFrame({ ...note, edit: { at: 5, anchor: null } });
      expect(screen.getByText('You edited')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Hand back to agent/ }));
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith([{ op: 'release', id: 'md' }], 'Handed back to the agent', undefined);
    });

    it('shows an agent note as one', () => {
      renderFrame({ type: 'markdown', id: 'n', text: 'Decided in S3 already; the block above may be outdated.', staleFor: 'md' });
      expect(screen.getByText('Agent note')).toBeTruthy();
    });

    it('has no hand-back for a block the agent wrote', () => {
      renderFrame(note);
      fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
      expect(screen.queryByRole('menuitem', { name: /Hand back/ })).toBeNull();
    });
  });

  describe('block menu', () => {
    it('lists Ask, Branch, Sources, Copy, moves and Delete', () => {
      renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
      const menu = screen.getByRole('menu', { name: 'Block menu for Plan vs actual' });
      const names = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
      expect(names).toEqual(['Ask/', 'Branch from here', 'Sources2', 'Copy text', 'Copy link', 'Move up', 'Move down', 'Delete⌫']);
    });

    it('copies, links, moves and deletes', async () => {
      const { chrome } = renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }));
      expect(chrome!.copy).toHaveBeenCalledWith([plan]);
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
      expect(chrome!.copyLink).toHaveBeenCalledWith('pa');
      fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
      expect(chrome!.move).toHaveBeenCalledWith('pa', -1);
      fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith([{ op: 'delete', id: 'pa' }], 'Deleted block', undefined);
      // Gone from reach until the page drops it: no chrome, not focusable.
      const group = screen.getByRole('group', { name: 'Plan vs actual' });
      expect(group.dataset.removing).toBe('true');
      expect(group.hasAttribute('inert')).toBe(true);
      expect(screen.queryByRole('toolbar')).toBeNull();
    });

    it('disables Move while another move is on its way', () => {
      renderFrame(plan, makeChrome('ok', { moving: vi.fn(() => true) }));
      fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
      expect(screen.getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByRole('menuitem', { name: 'Move down' }).getAttribute('aria-disabled')).toBe('true');
    });

    it('disables the move off either end', () => {
      renderFrame(plan, makeChrome(), { index: 0, count: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
      expect(screen.getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByRole('menuitem', { name: 'Move down' }).getAttribute('aria-disabled')).toBe('true');
    });

    it('opens Ask from the menu', () => {
      renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Block menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Ask/ }));
      expect(screen.getByRole('dialog', { name: 'Ask about Plan vs actual' })).toBeTruthy();
    });

    it('moves with the keyboard and closes on Escape', () => {
      const { chrome } = renderFrame();
      const handle = screen.getByRole('button', { name: 'Block menu' });
      fireEvent.click(handle);
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
      expect(chrome!.branch).toHaveBeenCalledWith(plan);
      fireEvent.click(handle);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(handle);
    });

    it('does not open after a drag of the handle', () => {
      const chrome = makeChrome();
      (chrome.takeDragged as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
      renderFrame(plan, chrome);
      const handle = screen.getByRole('button', { name: 'Block menu' });
      fireEvent.pointerDown(handle, { button: 0, clientY: 10 });
      expect(chrome.dragStart).toHaveBeenCalledWith('pa', expect.anything());
      fireEvent.click(handle);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('deletes a block reached with the keyboard on Backspace, not one that was clicked', async () => {
      const { chrome } = renderFrame();
      const group = screen.getByRole('group', { name: 'Plan vs actual' });
      fireEvent.pointerDown(group);
      group.focus();
      fireEvent.keyDown(group, { key: 'Backspace' });
      await flush();
      expect(chrome!.apply).not.toHaveBeenCalled();
      group.blur();
      group.focus();
      fireEvent.keyDown(group, { key: 'Backspace' });
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith([{ op: 'delete', id: 'pa' }], 'Deleted block', undefined);
    });
  });

  describe('⌫ and focus', () => {
    it('does not delete after a mouse Save or Cancel hands focus back to the block', async () => {
      const { chrome } = renderFrame(note);
      const group = screen.getByRole('group', { name: /S3 naming/ });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: /^Edit / }), { target: { value: 'Changed' } });
      fireEvent.pointerDown(screen.getByText('Save', { selector: 'button' }));
      fireEvent.click(screen.getByText('Save', { selector: 'button' }), mouse);
      await flush();
      expect(document.activeElement).toBe(group);
      fireEvent.keyDown(group, { key: 'Backspace' });
      await flush();
      expect(chrome!.apply).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.click(screen.getByText('Cancel', { selector: 'button' }), mouse);
      expect(document.activeElement).toBe(group);
      fireEvent.keyDown(group, { key: 'Backspace' });
      await flush();
      expect(chrome!.apply).toHaveBeenCalledTimes(1);
    });

    it('deletes after the editor was closed from the keyboard', async () => {
      const { chrome } = renderFrame(note);
      const group = screen.getByRole('group', { name: /S3 naming/ });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.keyDown(screen.getByRole('textbox', { name: /^Edit / }), { key: 'Escape' });
      expect(document.activeElement).toBe(group);
      fireEvent.keyDown(group, { key: 'Backspace' });
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith([{ op: 'delete', id: 'md' }], 'Deleted block', undefined);
    });

    it('sends one delete however often ⌫ is pressed', async () => {
      let answer: (r: ApplyResult) => void = () => {};
      const chrome = makeChrome('ok', { apply: vi.fn(() => new Promise<ApplyResult>((r) => { answer = r; })) });
      renderFrame(plan, chrome);
      const group = screen.getByRole('group', { name: 'Plan vs actual' });
      group.focus();
      fireEvent.keyDown(group, { key: 'Backspace' });
      fireEvent.keyDown(group, { key: 'Backspace' });
      fireEvent.keyDown(group, { key: 'Delete' });
      await act(async () => { answer('ok'); await Promise.resolve(); });
      fireEvent.keyDown(group, { key: 'Backspace' });
      await flush();
      expect(chrome.apply).toHaveBeenCalledTimes(1);
    });
  });

  describe('toolbar', () => {
    it('is one tab stop; the arrow keys move along it', () => {
      renderFrame();
      const toolbar = screen.getByRole('toolbar', { name: 'Actions for Plan vs actual' });
      const buttons = within(toolbar).getAllByRole('button');
      expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
      buttons[0].focus();
      fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
      expect(document.activeElement).toBe(buttons[1]);
      expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1]);
      fireEvent.keyDown(buttons[1], { key: 'End' });
      expect(document.activeElement).toBe(buttons[3]);
      fireEvent.keyDown(buttons[3], { key: 'ArrowRight' });
      expect(document.activeElement).toBe(buttons[0]);
    });
  });

  describe('adding a block', () => {
    it('keeps an existing edit draft when + is pressed and allows adding after it is saved', async () => {
      const chrome = makeChrome();
      renderFrame(note, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const field = screen.getByRole('textbox');
      fireEvent.change(field, { target: { value: 'My unsaved edit' } });
      const add = screen.getByRole('button', { name: 'Add block below' }) as HTMLButtonElement;
      expect(add.disabled).toBe(true);
      fireEvent.click(add);
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('My unsaved edit');
      expect(screen.queryByRole('textbox', { name: 'New text' })).toBeNull();
      fireEvent.click(screen.getByText('Save', { selector: 'button' }), mouse);
      await flush();
      expect(chrome.apply).toHaveBeenCalledWith([{ op: 'update', id: 'md', block: { ...note, text: 'My unsaved edit' } }], 'Page updated', 100);
      expect(add.disabled).toBe(false);
      fireEvent.click(add);
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New text' }));
    });

    it('opens text immediately, keeps the draft through repeated + and type changes, and guards other insertions', async () => {
      const insertDatabase = vi.fn();
      const chrome = makeChrome('ok', { addEntries: () => [{ id: 'db', label: 'New database', onSelect: insertDatabase }] });
      renderFrame(plan, chrome);
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      const field = screen.getByRole('textbox', { name: 'New text' });
      expect(document.activeElement).toBe(field);
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.change(field, { target: { value: 'Keep my draft' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      expect((screen.getByRole('textbox', { name: 'New text' }) as HTMLTextAreaElement).value).toBe('Keep my draft');
      fireEvent.click(screen.getByRole('button', { name: 'Other blocks' }));
      const database = screen.getByRole('menuitem', { name: 'New database' });
      expect(database.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(database);
      expect(insertDatabase).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Heading' }));
      expect((screen.getByRole('textbox', { name: 'New heading' }) as HTMLInputElement).value).toBe('Keep my draft');
      fireEvent.click(screen.getByText('Add', { selector: 'button' }));
      await flush();
      expect(chrome.apply).toHaveBeenCalledWith([{ op: 'insert', after: 'pa', block: { type: 'markdown', text: '## Keep my draft' } }], 'Block added', 100);
    });

    it('offers what the page adds besides Markdown after the built-in kinds', () => {
      const pick = vi.fn();
      renderFrame(plan, makeChrome('ok', { addEntries: (after, anchor) => [{ id: 'db', label: 'New database', onSelect: () => pick(after, anchor) }] }));
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.click(screen.getByRole('button', { name: 'Other blocks' }));
      const menu = screen.getByRole('menu', { name: 'Add below' });
      expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Text', 'Heading', 'To-do', 'Callout', 'New database']);
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'New database' }));
      expect(pick.mock.calls[0]?.[0]).toBe('pa');
      expect(pick.mock.calls[0]?.[1]?.textContent).toBe('Other blocks');
    });

    it('opens an editor below and adds what was written as Markdown after this block', async () => {
      const { chrome } = renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.click(screen.getByRole('button', { name: 'Other blocks' }));
      const menu = screen.getByRole('menu', { name: 'Add below' });
      expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Text', 'Heading', 'To-do', 'Callout']);
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Heading' }));
      const field = screen.getByRole('textbox', { name: 'New heading' });
      expect(document.activeElement).toBe(field);
      fireEvent.change(field, { target: { value: 'Open questions' } });
      fireEvent.click(screen.getByText('Add', { selector: 'button' }));
      await flush();
      expect(chrome!.apply).toHaveBeenCalledWith(
        [{ op: 'insert', after: 'pa', block: { type: 'markdown', text: '## Open questions' } }], 'Block added', 100,
      );
      expect(screen.queryByRole('textbox', { name: 'New heading' })).toBeNull();
    });

    it('adds nothing when the new block is left empty', async () => {
      const { chrome } = renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Add block below' }));
      fireEvent.click(screen.getByText('Add', { selector: 'button' }));
      await flush();
      expect(chrome!.apply).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox', { name: 'New text' })).toBeNull();
    });
  });

  describe('selection', () => {
    it('selects from the margin checkbox, extends with Shift', () => {
      const { chrome } = renderFrame();
      const box = screen.getByRole('checkbox', { name: 'Select Plan vs actual' });
      fireEvent.click(box);
      expect(chrome!.select).toHaveBeenLastCalledWith('pa', 'toggle');
      fireEvent.click(box, { shiftKey: true });
      expect(chrome!.select).toHaveBeenLastCalledWith('pa', 'extend');
    });

    it('selects on ⌘-click and Shift-click instead of acting', () => {
      const { chrome } = renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Branch' }), { metaKey: true });
      expect(chrome!.select).toHaveBeenLastCalledWith('pa', 'toggle');
      expect(chrome!.branch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('group', { name: 'Plan vs actual' }), { shiftKey: true });
      expect(chrome!.select).toHaveBeenLastCalledWith('pa', 'extend');
    });

    it('marks a selected block and starts a margin drag from the margin itself', () => {
      const { chrome } = renderFrame(plan, makeChrome(), { selected: true });
      const group = screen.getByRole('group', { name: 'Plan vs actual' });
      expect(group.dataset.selected).toBe('true');
      expect(screen.getByRole('checkbox', { name: 'Select Plan vs actual' }).getAttribute('aria-checked')).toBe('true');
      const margin = group.querySelector('.michi-doc-block__margin')!;
      fireEvent.pointerDown(margin, { button: 0 });
      expect(chrome!.marginDown).toHaveBeenCalledWith('pa');
      fireEvent.pointerEnter(margin);
      expect(chrome!.marginEnter).toHaveBeenCalledWith('pa');
    });

    it('marks a piece of an agent Markdown block with the block it came from', () => {
      renderFrame({ type: 'markdown', id: 'intro~1', text: 'Second paragraph.' }, makeChrome(), { segmentOf: 'intro' });
      const group = screen.getByRole('group', { name: 'Second paragraph.' });
      expect(group.dataset.blockId).toBe('intro~1');
      expect(group.dataset.segmentOf).toBe('intro');
    });

    it('a nested block has its chrome on the toolbar: no margin, no checkbox, no moves', () => {
      renderFrame(note, makeChrome(), { index: undefined });
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Block menu' })).toBeNull();
      const toolbar = screen.getByRole('toolbar', { name: /Actions for/ });
      expect(within(toolbar).getByRole('button', { name: 'Add block below' })).toBeTruthy();
      fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
      expect(screen.queryByRole('menuitem', { name: 'Move up' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeTruthy();
    });
  });
});
