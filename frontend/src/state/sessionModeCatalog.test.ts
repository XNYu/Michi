import { expect, it } from 'vitest';
import { sessionModeCatalog } from './sessionModeCatalog';

const catalog = [{ id: 'vibe', name: 'Default' }];

it('uses the loaded Kiro catalog when a session temporarily reports no agents', () => {
  expect(sessionModeCatalog({ runtimeId: 'kiro', availableModes: [] }, catalog, 'kiro')).toBe(catalog);
  expect(sessionModeCatalog({ runtimeId: 'kiro', availableModes: [] }, catalog, 'crew')).toEqual([]);
});

it('keeps nonempty session catalogs and explicit empty catalogs from other runtimes', () => {
  const session = [{ id: 'plan', name: 'Plan' }];
  expect(sessionModeCatalog({ runtimeId: 'kiro', availableModes: session }, catalog)).toBe(session);
  expect(sessionModeCatalog({ runtimeId: 'crew', availableModes: [] }, catalog)).toEqual([]);
  expect(sessionModeCatalog(undefined, catalog)).toBe(catalog);
});
