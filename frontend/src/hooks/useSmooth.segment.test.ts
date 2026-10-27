import { segmentGraphemes, segmentGraphemesIncremental } from './useSmooth';

describe('segmentGraphemesIncremental', () => {
  it('matches full segmentation with a long stable prefix before a split cluster (keep > 0)', () => {
    const family = '👨‍👩‍👧‍👦';
    const prevSrc = 'a'.repeat(20) + family.slice(0, 7); // 20 stable graphemes + partial cluster
    const source  = 'a'.repeat(20) + family;
    expect(
      segmentGraphemesIncremental({ source: prevSrc, boundaries: segmentGraphemes(prevSrc) }, source),
    ).toEqual(segmentGraphemes(source));
  });
});
