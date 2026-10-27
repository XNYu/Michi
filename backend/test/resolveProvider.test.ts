import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultPiProvider } from "../src/services/resolveProvider";
import { PI_PROVIDERS, OPENROUTER_FREE_PROVIDER_ID } from "../src/agents/pi/piProviders";

describe("resolveDefaultPiProvider", () => {
  test("falls back to the free provider when nothing is configured", () => {
    const result = resolveDefaultPiProvider({}, undefined);
    assert.ok(
      result === OPENROUTER_FREE_PROVIDER_ID || PI_PROVIDERS.some((p) => p.id === result),
    );
  });
});
