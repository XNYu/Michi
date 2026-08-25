import { describe, expect, it } from 'vitest';
import { filterModelCatalog } from './modelCatalogFilter';

const models = [
  {
    id: 'stealth/ox-alpha',
    label: 'Ox Alpha',
    description: 'Reasoning model for coding',
  },
  {
    id: 'anthropic/claude-sonnet',
    label: 'Claude Sonnet',
    description: 'General purpose model',
  },
];

describe('filterModelCatalog', () => {
  it('matches model labels and ids case-insensitively', () => {
    expect(filterModelCatalog(models, ' OX ')).toEqual([models[0]]);
    expect(filterModelCatalog(models, 'anthropic/')).toEqual([models[1]]);
  });

  it('matches descriptions', () => {
    expect(filterModelCatalog(models, 'CODING')).toEqual([models[0]]);
  });

  it('returns the full catalog for an empty query and no rows for a miss', () => {
    expect(filterModelCatalog(models, '   ')).toBe(models);
    expect(filterModelCatalog(models, 'not-present')).toEqual([]);
  });
});
