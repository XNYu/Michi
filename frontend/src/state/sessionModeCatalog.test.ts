import { expect, it } from 'vitest';
import { sessionModeCatalog } from './sessionModeCatalog';

const catalog = [{ id: 'vibe', name: 'Default' }];

it('uses the loaded Kiro catalog when a session temporarily reports no agents', () => {
  expect(sessionModeCatalog({ runtimeId: 'kiro', availableModes: [] }, catalog, 'kiro')).toBe(catalog);
  expect(sessionModeCatalog({ runtimeId: 'kiro', availableModes: [] }, catalog, 'crew')).toEqual([]);
});
