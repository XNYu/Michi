// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { composerStarterKit, enterContinuesBlock } from './MentionEditor';
import { draftToDoc } from './mentionDoc';

function makeEditor(content: string | object = ''): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [composerStarterKit],
    content,
  });
}

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
