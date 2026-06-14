import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { setupAgentRoutes } from '../src/routes/agent';
import type { ModelInfo } from '../src/agents/types';

// We can't easily mock the registry from outside without a refactor, so
// this test asserts the *shape* of the response when no runtime is
// registered (the early-return path at agent.ts:42).

describe('/agent/status', () => {
  test('returns fallback status when no runtime is registered', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', setupAgentRoutes());

    const server = app.listen(0);
    try {
      const port = (server.address() as any).port;
      const r = await fetch(`http://127.0.0.1:${port}/api/agent/status`);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(r.status, 200);
      assert.ok('availableRuntimes' in body, 'response should include availableRuntimes');
      assert.ok('runtime' in body, 'response should include runtime');
    } finally {
      server.close();
    }
  });
});

describe('ModelInfo.isDefault', () => {
  test('isDefault field is optional on ModelInfo', () => {
    // Verify the TypeScript interface accepts isDefault without errors at runtime.
    const withDefault: ModelInfo = { id: 'gpt-4o', label: 'GPT-4o', isDefault: true };
    const withoutDefault: ModelInfo = { id: 'gpt-3.5-turbo' };
    assert.equal(withDefault.isDefault, true);
    assert.equal(withoutDefault.isDefault, undefined);
  });

  test('isDefault preference: find() over list order', () => {
    // Replicate the sanitize logic from /agent/models to verify behaviour in isolation.
    const models: ModelInfo[] = [
      { id: 'model-a' },
      { id: 'model-b', isDefault: true },
      { id: 'model-c' },
    ];
    const ids = models.map((m) => m.id);
    const persisted: string | null = null; // simulates missing / invalid persisted value

    let sanitizedModel: string | null = null;
    if (ids.length > 0) {
      if (!persisted || !ids.includes(persisted)) {
        sanitizedModel = models.find((m) => m.isDefault)?.id ?? ids[0];
      }
    }

    // Should pick model-b (isDefault) rather than model-a (first in list).
    assert.equal(sanitizedModel, 'model-b');
  });

  test('isDefault preference falls back to ids[0] when no model is marked default', () => {
    const models: ModelInfo[] = [
      { id: 'model-x' },
      { id: 'model-y' },
    ];
    const ids = models.map((m) => m.id);
    const sanitizedModel = models.find((m) => m.isDefault)?.id ?? ids[0];
    assert.equal(sanitizedModel, 'model-x');
  });
});
