import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultPiProvider } from "../src/services/resolveProvider";
import { PI_PROVIDERS } from "../src/agents/pi/piProviders";

describe("resolveDefaultPiProvider", () => {
  test("honors an explicit last-used provider even when it has no key", () => {
    // Settings must be able to land on Cerebras so the user can paste a key.
    // Falling back to a keyed provider (DeepSeek) makes the picker look dead.
    const result = resolveDefaultPiProvider({ pi: "cerebras" }, "deepseek");
    assert.equal(result, "cerebras");
  });

  test("ignores an unknown last-used provider id", () => {
    const result = resolveDefaultPiProvider({ pi: "not-a-real-provider" }, undefined);
    assert.notEqual(result, "not-a-real-provider");
    assert.ok(PI_PROVIDERS.some((p) => p.id === result));
  });
});
