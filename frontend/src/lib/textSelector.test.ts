import { describe, expect, it } from 'vitest';
import { computeTextSelector, anchorSelector } from './textSelector';

const DOC = [
  '# Top Level',
  '',
  '## Configuration Fields',
  '',
  '### domainOwner',
  '',
  'Which team/service owns the data (Editor, Renderer, Storage, etc.).',
  '',
  '### storeType',
  '',
  'Which site types support this configuration.',
  '',
  '## API Endpoints',
  '',
  'The main endpoint for queries.',
].join('\n');

describe('computeTextSelector', () => {
  it('handles selection at the very start of the document', () => {
    const sel = computeTextSelector(DOC, 0, 11); // "# Top Level"
    expect(sel.exact).toBe('# Top Level');
    expect(sel.prefix).toBeUndefined(); // empty string → undefined
    expect(sel.suffix).toBeDefined();
    expect(sel.startOffset).toBe(0);
    expect(sel.startLine).toBe(1);
  });

  it('handles selection at the very end of the document', () => {
    const phrase = 'The main endpoint for queries.';
    const start = DOC.indexOf(phrase);
    const end = start + phrase.length;
    const sel = computeTextSelector(DOC, start, end);
    expect(sel.exact).toBe(phrase);
    expect(sel.suffix).toBeUndefined(); // end of doc → empty → undefined
  });
});

describe('anchorSelector', () => {
  it('uses startOffset for fast path when text matches', () => {
    const phrase = 'Which team/service owns the data';
    const start = DOC.indexOf(phrase);
    const result = anchorSelector(DOC, { exact: phrase, startOffset: start });
    expect(result).toBe(start);
  });

  it('falls back to text search when offset is stale', () => {
    const phrase = 'Which team/service owns the data';
    const start = DOC.indexOf(phrase);
    // Give a wrong offset
    const result = anchorSelector(DOC, { exact: phrase, startOffset: 999 });
    expect(result).toBe(start);
  });

  it('returns -1 when text is not found', () => {
    expect(anchorSelector(DOC, { exact: 'nonexistent text' })).toBe(-1);
  });

  it('uses prefix/suffix to disambiguate repeated text', () => {
    const doc = 'AAA hello BBB\nCCC hello DDD';
    // Both "hello" occurrences exist; prefix/suffix should pick the right one.
    const result1 = anchorSelector(doc, {
      exact: 'hello',
      prefix: 'AAA ',
      suffix: ' BBB',
    });
    expect(result1).toBe(doc.indexOf('hello'));

    const result2 = anchorSelector(doc, {
      exact: 'hello',
      prefix: 'CCC ',
      suffix: ' DDD',
    });
    expect(result2).toBe(doc.lastIndexOf('hello'));
  });

  it('returns the first match when no disambiguation data is available', () => {
    const doc = 'hello world hello world';
    expect(anchorSelector(doc, { exact: 'hello world' })).toBe(0);
  });
});
