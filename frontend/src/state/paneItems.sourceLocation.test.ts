import { describe, expect, it } from 'vitest';
import { isPaneItem, parseSourceLocation } from './paneItems';

describe('parseSourceLocation', () => {
  it('preserves Windows drive-letter paths without location', () => {
    const result = parseSourceLocation('C:\\Users\\me\\file.ts');
    expect(result).toEqual({ filePath: 'C:\\Users\\me\\file.ts' });
  });

  it('does not strip column zero', () => {
    const result = parseSourceLocation('/repo/foo.ts:10:0');
    expect(result).toEqual({ filePath: '/repo/foo.ts:10:0' });
  });

  it('does not strip malformed triple-colon', () => {
    const result = parseSourceLocation('/repo/foo.ts:10:5:3');
    expect(result).toEqual({ filePath: '/repo/foo.ts:10:5:3' });
  });

  it('does not parse integers outside the safe range', () => {
    expect(parseSourceLocation('/repo/foo.ts:9007199254740992')).toEqual({
      filePath: '/repo/foo.ts:9007199254740992',
    });
  });
});

describe('isPaneItem accepts sourceLocation on file items', () => {
  const base = {
    id: 'pane:file:1',
    kind: 'file' as const,
    projectId: 'p1',
    treeId: 't1',
    title: 'foo.ts',
    createdAt: 1,
    filePath: 'foo.ts',
    viewMode: 'source' as const,
  };

  it('accepts a string source-reference candidate path', () => {
    expect(isPaneItem({
      ...base,
      sourceLocation: { line: 42 },
      sourceReferencePath: 'foo.ts:42',
    })).toBe(true);
  });

  it('rejects a non-string source-reference candidate path', () => {
    expect(isPaneItem({ ...base, sourceReferencePath: 42 })).toBe(false);
  });

  it('rejects file item with non-object sourceLocation', () => {
    expect(isPaneItem({ ...base, sourceLocation: 'bad' })).toBe(false);
  });

  it('rejects invalid numeric locations', () => {
    expect(isPaneItem({ ...base, sourceLocation: { line: 0 } })).toBe(false);
    expect(isPaneItem({ ...base, sourceLocation: { line: -1 } })).toBe(false);
    expect(isPaneItem({ ...base, sourceLocation: { line: 1.5 } })).toBe(false);
    expect(isPaneItem({ ...base, sourceLocation: { line: Number.NaN } })).toBe(false);
    expect(isPaneItem({ ...base, sourceLocation: { line: Number.POSITIVE_INFINITY } })).toBe(false);
    expect(isPaneItem({ ...base, sourceLocation: { line: 1, column: 0 } })).toBe(false);
  });
});
