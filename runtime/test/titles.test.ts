import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGeneratedTitle, fallbackTitleFromUserText } from '../src/core/titles';

describe('title helpers', () => {
  it('cleans the usual ways a model ignores "output only the title"', () => {
    assert.equal(cleanGeneratedTitle('[TITLE: Fixing flaky tests]'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('```\nFixing flaky tests\n```'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('### Fixing flaky tests.'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('Title: "Fixing flaky tests"'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('标题：用小模型生成标题的方案探讨。'), '用小模型生成标题的方案探讨');
    assert.equal(cleanGeneratedTitle('**Fixing flaky tests**'), 'Fixing flaky tests');
    assert.equal(cleanGeneratedTitle('Sure!\n\nFixing flaky tests\nSecond line'), 'Sure');
    assert.equal(cleanGeneratedTitle('   '), '');
  });

  it('falls back to the first sentence of the user text', () => {
    assert.equal(fallbackTitleFromUserText('/btw How do I fix this? And also that.'), 'How do I fix this');
    assert.equal(fallbackTitleFromUserText('看看 https://example.com/x 这个链接。然后呢'), '看看 这个链接');
  });
});
