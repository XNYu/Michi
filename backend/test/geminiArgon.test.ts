import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { geminiArgonModel, argonOutputLimit, GEMINI_ARGON_CONTEXT } from '../src/agents/pi/geminiArgonModel';
import { streamGeminiArgon, streamPiModel } from '../src/agents/pi/geminiArgonStream';
import { loadPiAi, loadPiGoogleHelpers } from '../src/agents/pi/piAi';
import { listPiModels, resolvePiModel, resolveProviderModel, verifyPiProviderKey } from '../src/agents/pi/piProviders';
import { mapAgentEvent, type MapperContext } from '../src/agents/pi/eventMapper';
import { invalidateOpenRouterCache } from '../src/agents/pi/openrouterModels';

afterEach(invalidateOpenRouterCache);
const context = { systemPrompt: 'Use tools when needed', messages: [{ role: 'user' as const, content: 'Solve this task', timestamp: 0 }] };
const chunk = (parts: any[] = [], finishReason?: string, token?: string, usage?: any): GenerateContentResponse => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason && { finishReason }), ...(token && { continuationToken: token }) }],
  ...(usage && { usageMetadata: usage }),
}) as GenerateContentResponse;
const usage = (prompt: number, text: number, thinking: number, cached = 0) => ({
  promptTokenCount: prompt, candidatesTokenCount: text, thoughtsTokenCount: thinking, cachedContentTokenCount: cached,
  totalTokenCount: prompt + text + thinking,
});

async function fixture(scripts: Array<(params: GenerateContentParameters) => AsyncGenerator<GenerateContentResponse>>, options: any = {}, ctx: any = context) {
  const pi = await loadPiAi();
  const requests: GenerateContentParameters[] = [];
  const stream = streamGeminiArgon(pi, geminiArgonModel(), ctx, { apiKey: 'fake', ...options }, () => ({ models: {
    generateContentStream: async (params: GenerateContentParameters) => {
      requests.push(params);
      const script = scripts[requests.length - 1];
      if (!script) assert.fail('unexpected extra provider request');
      return script(params);
    },
  } } as any));
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return { requests, events, result: await stream.result() };
}

test('Google lists and resolves Argon without changing an explicitly selected existing model', async () => {
  const models = await listPiModels('google');
  const argon = models.filter((model) => model.model_id === 'gemini-4-argon');
  assert.equal(argon.length, 1);
  assert.equal(argon[0].model_name, 'Gemini 4 Argon');
  assert.equal(argon[0].context_window_tokens, GEMINI_ARGON_CONTEXT);
  assert.deepEqual(argon[0].supportedReasoningLevels, ['low', 'medium', 'high']);
  assert.equal(argon[0].defaultReasoning, 'medium');
  assert.equal(await resolveProviderModel('google'), 'gemini-4-argon');
  assert.equal(await resolveProviderModel('google', 'gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
  assert.equal((await resolvePiModel('google', 'gemini-4-argon')).api, 'google-generative-ai');
});

test('Argon pricing changes at the published cutoff and long-decode cap is configurable', () => {
  assert.deepEqual(geminiArgonModel(Date.UTC(2026, 10, 30, 23, 59, 59)).cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(geminiArgonModel(Date.UTC(2026, 11, 1)).cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
  assert.equal(argonOutputLimit({}), 262_144);
  assert.equal(argonOutputLimit({ MICHI_GEMINI_ARGON_MAX_OUTPUT_TOKENS: '1048576' }), 1_048_576);
  for (const value of ['0', '-1', '1.5', 'NaN', '1048577']) assert.throws(() => argonOutputLimit({ MICHI_GEMINI_ARGON_MAX_OUTPUT_TOKENS: value }));
});

for (const [reasoning, expected] of [[undefined, 'MEDIUM'], ['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH'], ['off', 'LOW'], ['minimal', 'LOW'], ['xhigh', 'HIGH'], ['max', 'HIGH']] as const) {
  test(`Argon maps ${reasoning ?? 'default'} to thinking_level ${expected}`, async () => {
    const f = await fixture([async function* () { yield chunk([{ text: 'OK' }], 'STOP', undefined, usage(10, 2, 1)); }], { reasoning });
    assert.equal(f.requests[0].config?.thinkingConfig?.thinkingLevel, expected);
    assert.equal(f.requests[0].config?.thinkingConfig?.thinkingBudget, undefined);
    assert.equal(f.requests[0].config?.maxOutputTokens, 262_144);
    assert.equal(f.requests[0].config?.automaticContinuation, false);
    assert.equal(f.result.stopReason, 'stop');
  });
}

test('continuation remains one assistant turn, keeps the original payload, and sums billing once', async () => {
  const f = await fixture([
    async function* () { yield chunk([{ text: 'Think', thought: true, thoughtSignature: 'dGhvdWdodA==' }], 'CONTINUATION', 'token-1', usage(100, 0, 65_536, 20)); },
    async function* () { yield chunk([{ text: 'Answer' }], 'STOP', undefined, usage(200, 5, 10, 100)); },
  ]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].contents, f.requests[0].contents);
  assert.equal(f.requests[1].config?.continuationToken, 'token-1');
  assert.equal(f.requests[1].config?.maxOutputTokens, f.requests[0].config?.maxOutputTokens);
  assert.equal(f.events.filter((event) => event.type === 'start').length, 1);
  assert.equal(f.events.filter((event) => event.type === 'done').length, 1);
  assert.equal(f.result.usage.input, 180);
  assert.equal(f.result.usage.cacheRead, 120);
  assert.equal(f.result.usage.output, 65_551);
  assert.equal(f.result.usage.totalTokens, 65_851);
  assert.equal((f.result.usage as any).contextTokens, 65_651);
  const rates = geminiArgonModel().cost;
  assert.ok(Math.abs(f.result.usage.cost.total - (180 * rates.input + 120 * rates.cacheRead + 65_551 * rates.output) / 1_000_000) < 1e-12);
});

test('checkpoint recovery discards uncommitted text and tool calls before resuming', async () => {
  const f = await fixture([
    async function* () {
      yield chunk([{ text: 'Committed' }], undefined, 'checkpoint', usage(10, 10, 30));
      yield chunk([{ text: 'discard me' }, { functionCall: { id: 'discarded', name: 'read', args: {} } }], undefined, undefined, usage(10, 20, 30));
      throw new TypeError('connection dropped');
    },
    async function* () { yield chunk([{ text: ' tail' }], 'STOP', undefined, usage(50, 5, 1)); },
  ]);
  assert.equal(f.requests[1].config?.continuationToken, 'checkpoint');
  assert.equal(f.events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''), 'Committed tail');
  assert.equal(f.events.filter((e) => e.type === 'toolcall_end').length, 0);
  assert.equal((f.result.usage as any).contextTokens, 56);
  assert.equal(f.result.usage.output, 56, 'bill the generated but discarded tail too');
});

test('thought-only checkpoints can continue and separate signed response parts survive replay', async () => {
  const f = await fixture([
    async function* () { yield chunk([], 'CONTINUATION', 'thinking-only', usage(10, 0, 65_536)); },
    async function* () { yield chunk([
      { text: 'First', thoughtSignature: 'c2lnbmF0dXJlMQ==' },
      { text: 'Second', thoughtSignature: 'c2lnbmF0dXJlMg==' },
      { text: '', thought: true, thoughtSignature: 'c2lnbmF0dXJlMw==' },
      { functionCall: { id: 'call-1', name: 'read', args: { path: 'README.md' } }, thoughtSignature: 'c2lnbmF0dXJlNA==' },
    ], 'STOP', undefined, usage(20, 5, 1)); },
  ]);
  assert.equal(f.result.stopReason, 'toolUse');
  const helpers = await loadPiGoogleHelpers();
  const replay = helpers.convertMessages(geminiArgonModel(), { messages: [...context.messages, f.result,
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'file' }], isError: false, timestamp: 1 }],
  });
  const parts = replay[1].parts;
  assert.deepEqual(parts.map((p: any) => p.thoughtSignature), ['c2lnbmF0dXJlMQ==', 'c2lnbmF0dXJlMg==', 'c2lnbmF0dXJlMw==', 'c2lnbmF0dXJlNA==']);
  assert.equal(parts[3].functionCall.id, 'call-1');
  assert.equal(replay[2].parts[0].functionResponse.id, 'call-1');
});

test('Argon context meter uses the current prompt and output, while run billing remains cumulative', () => {
  const mapper: MapperContext = { cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 }, runStartMs: Date.now(), contextWindow: 1000 };
  for (const contextTokens of [500, 600]) [...mapAgentEvent({ type: 'message_end', message: { role: 'assistant',
    usage: { input: 1000, output: 200, contextTokens, cost: { total: 1 } } } }, mapper)];
  const events = [...mapAgentEvent({ type: 'agent_end' }, mapper)];
  assert.deepEqual(events[0], { kind: 'context_usage', contextUsagePercentage: 60 });
  assert.equal(mapper.cumulative.totalCost, 2);
});

test('streaming replaces provisional first-hop prompt usage with the final native count', async () => {
  const f = await fixture([async function* () {
    yield chunk([{ text: 'O' }], undefined, undefined, usage(5, 1, 0));
    yield chunk([{ text: 'K' }], 'STOP', undefined, usage(36, 5, 0));
  }]);
  assert.equal(f.result.usage.input, 36);
  assert.equal((f.result.usage as any).contextTokens, 41);
});

test('near-full contexts clamp output, and payload hooks cannot reintroduce deprecated controls', async () => {
  const f = await fixture([async function* () { yield chunk([{ text: 'OK' }], 'STOP'); }], {
    maxTokens: 1_048_576,
    onPayload: (params: any) => ({ ...params, config: { ...params.config, temperature: 0, topP: 0.8, topK: 10, candidateCount: 2, cachedContent: 'bad-cache', thinkingConfig: { thinkingBudget: 10, thinkingLevel: 'HIGH' } } }),
  }, { messages: [{ role: 'user', content: 'a'.repeat(3_800_000), timestamp: 0 }] });
  assert.ok(f.requests[0].config!.maxOutputTokens! < 120_000);
  for (const field of ['temperature', 'topP', 'topK', 'candidateCount', 'cachedContent']) assert.equal((f.requests[0].config as any)[field], undefined);
  assert.deepEqual(f.requests[0].config!.thinkingConfig, { includeThoughts: true, thinkingLevel: 'HIGH' });
});

test('non-Argon models still use the existing Pi stream without creating a Google client', () => {
  const sentinel = {};
  const actual = streamPiModel({ streamSimple: () => sentinel }, { provider: 'google', id: 'gemini-3.1-pro-preview' }, {}, {});
  assert.equal(actual, sentinel);
});

test('aborted and failed streams settle result without retrying an ambiguous initial request', async () => {
  const abort = new AbortController();
  abort.abort();
  const cancelled = await fixture([], { signal: abort.signal });
  assert.equal(cancelled.result.stopReason, 'aborted');
  assert.equal(cancelled.requests.length, 0);
  const failed = await fixture([async function* () { yield chunk([{ text: 'partial' }]); throw new TypeError('lost connection'); }]);
  assert.equal(failed.result.stopReason, 'error');
  assert.equal(failed.requests.length, 1);
  const incomplete = await fixture([async function* () { yield chunk([{ text: 'partial' }]); }]);
  assert.match(incomplete.result.errorMessage!, /without a finish reason/);
});

test('cancellation during a checkpointed stream stops continuation and drops the uncommitted tail', async () => {
  const abort = new AbortController();
  const f = await fixture([async function* () {
    yield chunk([{ text: 'Committed' }], undefined, 'checkpoint');
    yield chunk([{ text: 'tail' }]);
    abort.abort();
    await new Promise(() => {});
  }], { signal: abort.signal });
  assert.equal(f.requests.length, 1);
  assert.equal(f.result.stopReason, 'aborted');
  assert.equal(f.events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''), 'Committed');
});

test('MAX_TOKENS completes as length and a safety finish is an error without retrying', async () => {
  const limited = await fixture([async function* () { yield chunk([{ text: 'partial' }], 'MAX_TOKENS', 'resume-later'); }]);
  assert.equal(limited.result.stopReason, 'length');
  const safety = await fixture([async function* () { yield chunk([], 'SAFETY', 'checkpoint'); }]);
  assert.equal(safety.result.stopReason, 'error');
  assert.equal(safety.requests.length, 1);
});

test('timeouts, malformed continuation and stalled checkpoints terminate without replaying', async () => {
  const timedOut = await fixture([async function* () { await new Promise(() => {}); }], { timeoutMs: 10 });
  assert.equal(timedOut.result.stopReason, 'error');
  assert.match(timedOut.result.errorMessage!, /timed out/);
  const malformed = await fixture([async function* () { yield chunk([], 'CONTINUATION'); }]);
  assert.equal(malformed.requests.length, 1);
  assert.match(malformed.result.errorMessage!, /checkpoint/);
  const stalled = await fixture([
    async function* () { yield chunk([], 'CONTINUATION', 'same-token'); },
    async function* () { yield chunk([], 'CONTINUATION', 'same-token'); },
  ]);
  assert.equal(stalled.requests.length, 2);
  assert.equal(stalled.result.stopReason, 'error');
});

test('Pi agent executes a continued tool call once and replays its signature in the next generation', async () => {
  const nativeImport = new Function('name', 'return import(name)') as (name: string) => Promise<any>;
  const { Agent } = await nativeImport('@earendil-works/pi-agent-core');
  const pi = await loadPiAi();
  const requests: GenerateContentParameters[] = [];
  let executions = 0;
  const agent = new Agent({ initialState: {
    model: geminiArgonModel(), thinkingLevel: 'medium', systemPrompt: '', messages: [],
    tools: [{ name: 'read', label: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => { executions++; return { content: [{ type: 'text', text: 'file contents' }] }; } }],
  }, streamFn: (model: any, ctx: any, options: any) => streamGeminiArgon(pi, model, ctx, { ...options, apiKey: 'fake' }, () => ({ models: {
    generateContentStream: async (params: GenerateContentParameters) => {
      requests.push(params);
      return (async function* () {
        if (requests.length === 1) yield chunk([], 'CONTINUATION', 'checkpoint', usage(10, 0, 65_536));
        else if (requests.length === 2) yield chunk([{ functionCall: { id: 'read-1', name: 'read', args: { path: 'README.md' } }, thoughtSignature: 'c2lnbmF0dXJl' }], 'STOP', undefined, usage(10, 5, 1));
        else yield chunk([{ text: 'Finished' }], 'STOP', undefined, usage(50, 1, 1));
      })();
    },
  } } as any)) });
  await agent.prompt('Read README.md');
  assert.equal(executions, 1);
  assert.equal(requests.length, 3);
  const contents = requests[2].contents as any[];
  const callPart = contents.find((c) => c.role === 'model').parts[0];
  assert.equal(callPart.thoughtSignature, 'c2lnbmF0dXJl');
  assert.equal(callPart.functionCall.id, 'read-1');
  assert.equal(contents.at(-1).parts[0].functionResponse.id, 'read-1');
  assert.equal(agent.state.messages.at(-1).content[0].text, 'Finished');
});

test('wire integration uses the new SDK and flattens continuation tokens into REST payloads', async (t) => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const data of req) body += data;
    requests.push({ url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(requests.length === 1
      ? chunk([{ text: 'A' }], 'CONTINUATION', 'wire-token', usage(10, 1, 1))
      : chunk([{ text: 'B' }], 'STOP', undefined, usage(12, 1, 1)))}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const model = { ...geminiArgonModel(), baseUrl: `http://127.0.0.1:${address.port}/v1beta` };
  const stream = streamGeminiArgon(await loadPiAi(), model, context, { apiKey: 'fake-wire-key' });
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /models\/gemini-4-argon:streamGenerateContent/);
  assert.equal(requests[0].key, 'fake-wire-key');
  assert.equal(requests[1].body.continuationToken, 'wire-token');
  assert.deepEqual(requests[1].body.contents, requests[0].body.contents);
  assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'MEDIUM' });
  assert.equal(events.filter((event) => event.type === 'text_delta').map((event: any) => event.delta).join(''), 'AB');
});

test('credential verification gives Argon a sufficient budget and leaves other providers unchanged', async (t) => {
  let captured: any;
  t.mock.method(require('../src/agents/pi/geminiArgonStream'), 'streamPiModel', (pi: any, model: any, ctx: any, options: any) => {
    captured = { model, options };
    const stream = pi.createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: { stopReason: 'stop' } });
    return stream;
  });
  assert.equal((await verifyPiProviderKey({ provider: 'google', key: 'fake' })).ok, true);
  assert.equal(captured.model.id, 'gemini-4-argon');
  assert.equal(captured.options.timeoutMs, 60_000);
  assert.equal(captured.options.maxTokens, 32_768);
  assert.equal(captured.options.reasoning, 'low');
  assert.equal((await verifyPiProviderKey({ provider: 'google', model: 'gemini-3.1-pro-preview', key: 'fake' })).ok, true);
  assert.equal(captured.options.timeoutMs, 15_000);
  assert.equal(captured.options.maxTokens, 16);
});
