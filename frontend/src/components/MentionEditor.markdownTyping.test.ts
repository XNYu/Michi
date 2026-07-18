// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { composerStarterKit, enterContinuesBlock } from './MentionEditor';
import { docToDraft, draftToDoc } from './mentionDoc';

/**
 * Submit-fidelity invariant: the characters a user TYPES into the composer are
 * exactly the characters that get submitted. Markdown syntax (`**bold**`,
 * `*italic*`, `` `code` ``, `~~strike~~`) must never be silently consumed —
 * StarterKit's mark input rules eat the markers while docToDraft used to drop
 * the marks, so the model received de-emphasized plain text (regression: the
 * "swallowed asterisks" bug, 2026-06).
 *
 * This invariant holds whichever way it's implemented: marks disabled (text
 * stays literal) or marks enabled + markdown-aware serialization (markers
 * restored on serialize).
 */

// Simulate real typing char-by-char. Input rules hook ProseMirror's
// handleTextInput; someProp routes through every plugin's handler the same way
// the browser beforeinput path does. Unhandled chars are inserted literally.
function typeText(editor: Editor, text: string) {
  for (const ch of text) {
    const view = editor.view;
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) {
      view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  }
}

function makeEditor(content: string | object = ''): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [composerStarterKit],
    content,
  });
}

const draftValue = (editor: Editor) =>
  docToDraft(editor.getJSON() as Parameters<typeof docToDraft>[0]).value;

describe('composer submit fidelity: typed markdown syntax survives to the draft value', () => {
  const cases = [
    'hello **bold** world',
    'hello *italic* world',
    'hello `code` world',
    'hello ~~strike~~ world',
    'mixed **bold** and `rm -rf /tmp` then *it*',
  ];

  for (const typed of cases) {
    it(JSON.stringify(typed), () => {
      const editor = makeEditor();
      typeText(editor, typed);
      const value = draftValue(editor);
      editor.destroy();
      expect(value).toBe(typed);
    });
  }
});

describe('block input rules render WYSIWYG and keep the markdown wire format', () => {
  const cases: Array<[typed: string, nodeType: string, expectedValue?: string]> = [
    ['- item', 'bulletList'],
    ['1. first', 'orderedList'],
    ['# heading', 'heading'],
    ['> quoted', 'blockquote'],
    // The fence rule completes the block: the trigger space becomes the line
    // break and the serializer emits the closing fence.
    ['```js code', 'codeBlock', '```js\ncode\n```'],
  ];

  for (const [typed, nodeType, expectedValue] of cases) {
    it(`${JSON.stringify(typed)} -> ${nodeType}`, () => {
      const editor = makeEditor();
      typeText(editor, typed);
      const doc = editor.getJSON() as { content?: Array<{ type: string }> };
      const value = draftValue(editor);
      editor.destroy();
      expect(doc.content?.[0]?.type).toBe(nodeType);
      expect(value).toBe(expectedValue ?? typed);
    });
  }
});

describe('enterContinuesBlock: Shift+Enter runs block-native Enter inside formatted blocks', () => {
  const atEnd = (editor: Editor) => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    return editor.state;
  };

  const cases: Array<[name: string, value: string, expected: boolean]> = [
    ['plain paragraph', 'hello', false],
    ['empty composer', '', false],
    ['inside a code block', '```\ncode\n```', true],
    ['inside a list item', '- item', true],
    ['inside an ordered item', '1. item', true],
    ['inside a blockquote', '> quote', true],
    ['inside a heading', '# title', true],
    ['paragraph after a list', '- a\ndone', false],
  ];

  for (const [name, value, expected] of cases) {
    it(name, () => {
      const editor = makeEditor(draftToDoc(value, []));
      const state = atEnd(editor);
      const got = enterContinuesBlock(state);
      editor.destroy();
      expect(got).toBe(expected);
    });
  }
});

describe('Shift+Enter block continuation commands', () => {
  it('splitListItem continues an ordered list with the next item', () => {
    const editor = makeEditor(draftToDoc('1. first', []));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const handled = editor.commands.first(({ commands }) => [
      () => commands.newlineInCode(),
      () => commands.splitListItem('listItem'),
      () => commands.createParagraphNear(),
      () => commands.liftEmptyBlock(),
      () => commands.splitBlock(),
    ]);
    expect(handled).toBe(true);
    typeText(editor, 'second');
    const value = draftValue(editor);
    editor.destroy();
    expect(value).toBe('1. first\n2. second');
  });

  it('lifts out of the list when the current item is empty', () => {
    const editor = makeEditor(draftToDoc('1. first', []));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const continueBlock = () =>
      editor.commands.first(({ commands }) => [
        () => commands.newlineInCode(),
        () => commands.splitListItem('listItem'),
        () => commands.createParagraphNear(),
        () => commands.liftEmptyBlock(),
        () => commands.splitBlock(),
      ]);
    continueBlock(); // → empty item 2.
    continueBlock(); // empty item lifts out of the list
    expect(enterContinuesBlock(editor.state)).toBe(false);
    editor.destroy();
  });
});
