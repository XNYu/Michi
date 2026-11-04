import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_ARGON_MAX_OUTPUT, geminiArgonModel } from '../src/agents/pi/geminiArgonModel';
import { loadPiAi, loadPiTypebox } from '../src/agents/pi/piAi';
import { verifyPiProviderKey } from '../src/agents/pi/piProviders';
import { invalidateOpenRouterCache } from '../src/agents/pi/openrouterModels';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; invalidateOpenRouterCache(); });

/** Pi's Google provider talks to the real @google/genai SDK; only the network is replaced. */
function captureGoogle(finishReason = 'STOP') {
  const requests: Array<{ url: string; key: string | null; body: any }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), key: headers.get('x-goog-api-key'), body: JSON.parse(String(init?.body)) });
    const chunk = { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 2, totalTokenCount: 13 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return requests;
}

async function run(context: any, options: any = {}) {
  const pi: any = await loadPiAi();
  const stream = pi.streamSimple(geminiArgonModel(), context, { apiKey: 'fake-key', ...options });
  for await (const _event of stream) { /* drain */ }
  return stream.result();
}

test('Argon pricing changes at the published cutoff and output stays within Google\'s per-request limit', () => {
  assert.deepEqual(geminiArgonModel(Date.UTC(2026, 10, 30, 23, 59, 59)).cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(geminiArgonModel(Date.UTC(2026, 11, 1)).cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
  assert.equal(geminiArgonModel().maxTokens, GEMINI_ARGON_MAX_OUTPUT);
  assert.equal(GEMINI_ARGON_MAX_OUTPUT, 32_768);
});

test('Pi\'s Google provider sends the 1.4+ transcript prompt and tools to Argon', async () => {
  const { Type } = await loadPiTypebox();
  const requests = captureGoogle();
  const tool = { name: 'read_node', description: 'Read a node', parameters: Type.Object({ nodeId: Type.String() }) };
  const result = await run({ messages: [
    { role: 'system', content: '', sections: { preamble: 'HOST PREAMBLE', cwd: '<cwd>/w</cwd>' }, toolsAdded: [tool], timestamp: 0 },
    { role: 'user', content: 'Read the referenced node', timestamp: 1 },
  ] }, { reasoning: 'medium' });
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(requests.length, 1);
  const { url, key, body } = requests[0];
  assert.match(url, /models\/gemini-4-argon:streamGenerateContent/);
  assert.equal(key, 'fake-key');
  assert.match(JSON.stringify(body.systemInstruction), /HOST PREAMBLE[\s\S]*<cwd>\/w<\/cwd>/);
  assert.deepEqual(body.tools[0].functionDeclarations.map((d: any) => d.name), ['read_node']);
  assert.ok(!body.contents.some((c: any) => c.role === 'system'));
  assert.equal(body.generationConfig.maxOutputTokens, GEMINI_ARGON_MAX_OUTPUT);
});

for (const [reasoning, expected] of [['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH'], ['off', 'LOW'], ['minimal', 'LOW'], ['xhigh', 'HIGH'], ['max', 'HIGH']] as const) {
  test(`Argon ${reasoning} effort uses thinkingLevel ${expected}`, async () => {
    const pi: any = await loadPiAi();
    const requests = captureGoogle();
    // PiSession clamps the requested effort before the provider sees it.
    await run({ messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] }, { reasoning: pi.clampThinkingLevel(geminiArgonModel(), reasoning) });
    assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, expected);
    assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingBudget, undefined);
  });
}

test('MAX_TOKENS completes as length and a malformed call is an error', async () => {
  captureGoogle('MAX_TOKENS');
  assert.equal((await run({ messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] }, { reasoning: 'low' })).stopReason, 'length');
  captureGoogle('MALFORMED_FUNCTION_CALL');
  const failed = await run({ messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] }, { reasoning: 'low' });
  assert.equal(failed.stopReason, 'error');
  assert.match(failed.errorMessage!, /MALFORMED_FUNCTION_CALL/);
});

test('credential verification gives Argon a sufficient budget and leaves other providers unchanged', async () => {
  const requests = captureGoogle();
  assert.equal((await verifyPiProviderKey({ provider: 'google', key: 'fake' })).ok, true);
  assert.match(requests[0].url, /gemini-4-argon/);
  assert.equal(requests[0].body.generationConfig.maxOutputTokens, GEMINI_ARGON_MAX_OUTPUT);
  assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal((await verifyPiProviderKey({ provider: 'google', model: 'gemini-3.1-pro-preview', key: 'fake' })).ok, true);
  assert.match(requests[1].url, /gemini-3\.1-pro-preview/);
  assert.equal(requests[1].body.generationConfig.maxOutputTokens, 16);
});
