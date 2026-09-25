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
  it('matches descriptions', () => {
    expect(filterModelCatalog(models, 'CODING')).toEqual([models[0]]);
  });

  it('returns the full catalog for an empty query and no rows for a miss', () => {
    expect(filterModelCatalog(models, '   ')).toBe(models);
    expect(filterModelCatalog(models, 'not-present')).toEqual([]);
  });
});
