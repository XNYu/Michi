import { describe, expect, it } from 'vitest';
import {
  computeTextSelector,
  findNearestHeadingPath,
  anchorSelector,
} from './textSelector';

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
  it('computes exact, prefix, suffix, and line numbers for a mid-document selection', () => {
    const start = DOC.indexOf('Which team/service');
    const end = start + 'Which team/service owns the data'.length;
    const sel = computeTextSelector(DOC, start, end);

    expect(sel.exact).toBe('Which team/service owns the data');
    expect(sel.prefix).toBeDefined();
    expect(sel.suffix).toBeDefined();
    // prefix should end right before the selection
    expect(DOC.slice(start - sel.prefix!.length, start)).toBe(sel.prefix);
    // suffix should start right after the selection
    expect(DOC.slice(end, end + sel.suffix!.length)).toBe(sel.suffix);
    expect(sel.startOffset).toBe(start);
    expect(sel.endOffset).toBe(end);
    // Line numbers are 1-based
    expect(sel.startLine).toBeGreaterThan(1);
    expect(sel.endLine).toBeGreaterThanOrEqual(sel.startLine!);
  });

  it('computes section heading ancestry', () => {
    const start = DOC.indexOf('Which team/service');
    const end = start + 'Which team/service'.length;
    const sel = computeTextSelector(DOC, start, end);

    expect(sel.section).toContain('# Top Level');
    expect(sel.section).toContain('## Configuration Fields');
    expect(sel.section).toContain('### domainOwner');
  });

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

  it('caps prefix/suffix at 50 characters', () => {
    const longDoc = 'a'.repeat(200) + 'TARGET' + 'b'.repeat(200);
    const start = 200;
    const end = 206;
    const sel = computeTextSelector(longDoc, start, end);
    expect(sel.prefix!.length).toBe(50);
    expect(sel.suffix!.length).toBe(50);
  });
});

describe('findNearestHeadingPath', () => {
  it('returns the full heading ancestry for a deeply nested position', () => {
    const offset = DOC.indexOf('Which team/service');
    const path = findNearestHeadingPath(DOC, offset);
    expect(path).toBe('# Top Level > ## Configuration Fields > ### domainOwner');
  });

  it('returns just the nearest heading when only one level exists', () => {
    const simpleDoc = '# Only Heading\n\nSome text here.';
    const path = findNearestHeadingPath(simpleDoc, simpleDoc.indexOf('Some text'));
    expect(path).toBe('# Only Heading');
  });

  it('returns empty string for text with no headings', () => {
    expect(findNearestHeadingPath('No headings here.\nJust text.', 10)).toBe('');
  });

  it('picks the nearest heading at each level, not an earlier one', () => {
    const offset = DOC.indexOf('Which site types');
    const path = findNearestHeadingPath(DOC, offset);
    // Should reference storeType, not domainOwner
    expect(path).toContain('### storeType');
    expect(path).not.toContain('### domainOwner');
  });

  it('stops ascending once a level-1 heading is found', () => {
    const path = findNearestHeadingPath(DOC, DOC.indexOf('The main endpoint'));
    // Should include the # Top Level but pick ## API Endpoints, not ## Configuration Fields
    expect(path).toContain('## API Endpoints');
    expect(path).not.toContain('## Configuration Fields');
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
