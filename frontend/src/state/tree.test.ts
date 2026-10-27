import { descendants } from './tree';

describe('descendants', () => {
  it('does not loop forever on cyclic edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    const d = descendants('a', edges);
    expect(d).toEqual(new Set(['b']));
  });
});
