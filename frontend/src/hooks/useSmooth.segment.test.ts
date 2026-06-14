import { segmentGraphemes, segmentGraphemesIncremental } from './useSmooth';

const fromScratch = (prevSource: string, source: string) =>
  segmentGraphemesIncremental({ source: prevSource, boundaries: segmentGraphemes(prevSource) }, source);

describe('segmentGraphemesIncremental', () => {
  it('matches full segmentation for ASCII prefix growth', () => {
    expect(fromScratch('hel', 'hello')).toEqual(segmentGraphemes('hello'));
  });

  it('matches full segmentation for CJK growth', () => {
    expect(fromScratch('你好', '你好世界')).toEqual(segmentGraphemes('你好世界'));
  });

  it('is correct when a ZWJ emoji cluster is split across the prev/tail boundary', () => {
    const family = '👨‍👩‍👧‍👦'; // single grapheme cluster
    const prevSrc = 'a' + family.slice(0, 3);   // boundary lands mid-cluster
    const full = segmentGraphemes('a' + family);
    expect(
      segmentGraphemesIncremental({ source: prevSrc, boundaries: segmentGraphemes(prevSrc) }, 'a' + family),
    ).toEqual(full);
  });

  it('matches full segmentation with a long stable prefix before a split cluster (keep > 0)', () => {
    const family = '👨‍👩‍👧‍👦';
    const prevSrc = 'a'.repeat(20) + family.slice(0, 7); // 20 stable graphemes + partial cluster
    const source  = 'a'.repeat(20) + family;
    expect(
      segmentGraphemesIncremental({ source: prevSrc, boundaries: segmentGraphemes(prevSrc) }, source),
    ).toEqual(segmentGraphemes(source));
  });

  it('falls back to full segmentation on a non-prefix change', () => {
    expect(fromScratch('xyz', 'abc')).toEqual(segmentGraphemes('abc'));
  });

  it('handles empty prev', () => {
    expect(segmentGraphemesIncremental({ source: '', boundaries: [] }, 'hello'))
      .toEqual(segmentGraphemes('hello'));
  });
});
