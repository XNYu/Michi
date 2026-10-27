import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeModelCatalog } from '../src/core/modelCatalog';
import type { ModelInfo } from '../src/contract/types';

test('catalog coalesces probes and only publishes and persists nonempty normalized results', async () => {
  const initial = [{ id: 'cached' }];
  const saved: ModelInfo[][] = [];
  const updated: ModelInfo[][] = [];
  let probes = 0;
  let resolveProbe!: (models: string[]) => void;
  const catalog = new RuntimeModelCatalog({
    initial,
    probe: () => { probes++; return new Promise<string[]>((resolve) => { resolveProbe = resolve; }); },
    normalize: (ids) => ids.filter(Boolean).map((id) => ({ id })),
    persist: (models) => { saved.push(models); },
    onUpdate: (models) => { updated.push(models); },
  });
  const first = catalog.refresh();
  assert.equal(catalog.refresh(), first);
  assert.equal(probes, 1);
  assert.equal(catalog.cached, initial);
  resolveProbe(['fresh', '']);
  assert.deepEqual(await first, [{ id: 'fresh' }]);
  assert.deepEqual(saved, [[{ id: 'fresh' }]]);
  const empty = catalog.refresh();
  resolveProbe([]);
  assert.deepEqual(await empty, [{ id: 'fresh' }]);
  assert.equal(saved.length, 1);
  assert.deepEqual(updated, [initial, [{ id: 'fresh' }]]);
});

test('probe failure leaves snapshot usable, propagates failure, and permits explicit retry', async () => {
  let probes = 0;
  const catalog = new RuntimeModelCatalog({
    initial: [{ id: 'cached' }],
    probe: () => { probes++; if (probes === 1) throw new Error('offline'); return Promise.resolve([{ id: 'retry' }]); },
    normalize: (models) => models,
  });
  await assert.rejects(catalog.refresh(), /offline/);
  assert.deepEqual(catalog.current(), [{ id: 'cached' }]);
  assert.deepEqual(await catalog.refresh(), [{ id: 'retry' }]);
});

test('empty initial and probe use fallback, while incidental native catalogs use the same guard', async () => {
  const saved: ModelInfo[][] = [];
  const catalog = new RuntimeModelCatalog<ModelInfo[]>({
    initial: [],
    probe: async () => [],
    normalize: (models: ModelInfo[]) => models,
    persist: (models) => { saved.push(models); },
    fallback: () => [{ id: 'static' }],
  });
  assert.equal(catalog.cached, null);
  assert.deepEqual(await catalog.refresh(), [{ id: 'static' }]);
  assert.equal(saved.length, 0);
  assert.deepEqual(catalog.replace([{ id: 'native-session-model' }]), [{ id: 'native-session-model' }]);
  assert.deepEqual(catalog.replace([]), [{ id: 'native-session-model' }]);
  assert.equal(saved.length, 1);
});
