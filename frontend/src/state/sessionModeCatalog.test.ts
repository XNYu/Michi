import { expect, it } from 'vitest';
import { sessionModeCatalog } from './sessionModeCatalog';

const catalog = [{ id: 'vibe', name: 'Default' }];

it('uses the loaded Kiro catalog when a session temporarily reports no agents', () => {
  expect(sessionModeCatalog({ runtimeId: 'kiro', availableModes: [] }, catalog, 'kiro')).toBe(catalog);
  expect(sessionModeCatalog({ runtimeId: 'kiro', availableModes: [] }, catalog, 'crew')).toEqual([]);
});

it('a Claude chat lists its own Default and Plan modes even when the workspace catalog is Kiro\'s', () => {
  const claude = [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }];
  expect(sessionModeCatalog({ runtimeId: 'claude', availableModes: claude }, catalog, 'kiro')).toBe(claude);
  // An Agent Run session reports no modes.
  expect(sessionModeCatalog({ runtimeId: 'claude', availableModes: [] }, catalog, 'claude')).toEqual([]);
});
