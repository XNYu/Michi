import { randomUUID } from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, type GenerateContentParameters, type GenerateContentResponse, type GenerateContentResponseUsageMetadata, type Part } from '@google/genai';
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, TextContent, ThinkingContent, Usage } from '@earendil-works/pi-ai';
import { loadPiAi, loadPiGoogleHelpers } from './piAi';
import { argonOutputLimit, GEMINI_ARGON_CONTEXT, GEMINI_ARGON_TIMEOUT, geminiArgonModel, isGeminiArgon } from './geminiArgonModel';
import { abortable } from '../runtimeLifecycle';

type ArgonUsage = Usage & { contextTokens: number };
type GoogleStreamClient = Pick<GoogleGenAI, 'models'>;

/** Shared by ordinary turns and credential verification. Other models retain Pi's adapter. */
export function streamPiModel(pi: any, model: any, context: any, options: any): AssistantMessageEventStream {
  return isGeminiArgon(model)
    ? streamGeminiArgon(pi, model, context, options)
    : pi.streamSimple(model, context, options);
}

/** Injectable client is for isolated wire/continuation tests, never a global fetch override. */
export function streamGeminiArgon(
  pi: Pick<Awaited<ReturnType<typeof loadPiAi>>, 'createAssistantMessageEventStream'>,
  model: Model<'google-generative-ai'>,
  context: Context,
  options: Omit<SimpleStreamOptions, 'reasoning'> & { reasoning?: SimpleStreamOptions['reasoning'] | 'off' } = {},
  createClient: (apiKey: string, headers: Record<string, string>, timeout: number) => GoogleStreamClient =
    (apiKey, headers, timeout) => new GoogleGenAI({ apiKey, httpOptions: { baseUrl: model.baseUrl, apiVersion: '', headers, timeout, retryOptions: { attempts: 1 } } }),
): AssistantMessageEventStream {
  const stream = pi.createAssistantMessageEventStream();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const signal = controller.signal;
  const output: AssistantMessage = {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: 'pending', usage: emptyUsage(),
  };
  let current: TextContent | ThinkingContent | undefined;
  let currentIndex = -1;
  const closeBlock = () => {
    if (!current) return;
    if (current.type === 'text') stream.push({ type: 'text_end', contentIndex: currentIndex, content: current.text, partial: output });
    else stream.push({ type: 'thinking_end', contentIndex: currentIndex, content: current.thinking, partial: output });
    current = undefined;
  };
  const append = (part: Part) => {
    if (part.text !== undefined || (part.thoughtSignature && !part.functionCall)) {
      const thinking = part.thought === true;
      if (!current || current.type !== (thinking ? 'thinking' : 'text')) {
        closeBlock();
        current = thinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
        currentIndex = output.content.push(current) - 1;
        if (thinking) stream.push({ type: 'thinking_start', contentIndex: currentIndex, partial: output });
        else stream.push({ type: 'text_start', contentIndex: currentIndex, partial: output });
      }
      const delta = part.text ?? '';
      if (current.type === 'thinking') {
        current.thinking += delta;
        current.thinkingSignature = part.thoughtSignature;
        stream.push({ type: 'thinking_delta', contentIndex: currentIndex, delta, partial: output });
      } else {
        current.text += delta;
        current.textSignature = part.thoughtSignature;
        stream.push({ type: 'text_delta', contentIndex: currentIndex, delta, partial: output });
      }
      // A signature terminates its part. Do not merge later parts into it.
      if (part.thoughtSignature) closeBlock();
    }
    if (part.functionCall) {
      closeBlock();
      const call = part.functionCall;
      const id = call.id && !output.content.some((block) => block.type === 'toolCall' && block.id === call.id)
        ? call.id : `${call.name ?? 'tool'}_${randomUUID()}`;
      const toolCall = { type: 'toolCall' as const, id, name: call.name ?? '', arguments: call.args ?? {}, ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }) };
      const contentIndex = output.content.push(toolCall) - 1;
      stream.push({ type: 'toolcall_start', contentIndex, partial: output });
      stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
      stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
    }
  };

  void (async () => {
    let iterator: AsyncIterator<GenerateContentResponse> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      signal.throwIfAborted();
      if (!options.apiKey) throw new Error('No API key for provider: google');
      if (options.fetch && options.fetch !== globalThis.fetch) throw new Error('Custom fetch is not supported by the Gemini Argon adapter');
      const helpers = await abortable(loadPiGoogleHelpers(), signal);
      const timeout = options.timeoutMs ?? GEMINI_ARGON_TIMEOUT;
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Gemini Argon timeout must be positive');
      const headers = Object.fromEntries(Object.entries({ ...model.headers, ...options.headers }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const client = createClient(options.apiKey, headers, timeout);
      // A long-lived Pi Agent can retain its model object across the price cutoff.
      const billingRates = geminiArgonModel().cost;
      const level = options.reasoning === 'low' || options.reasoning === 'minimal' || options.reasoning === 'off'
        ? ThinkingLevel.LOW : options.reasoning === 'high' || options.reasoning === 'xhigh' || options.reasoning === 'max'
          ? ThinkingLevel.HIGH : ThinkingLevel.MEDIUM;
      const requestedLimit = options.maxTokens ?? argonOutputLimit();
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error('Gemini Argon output limit must be a positive integer');
      const maxOutputTokens = helpers.clampMaxTokensToContext(model, context, Math.min(requestedLimit, GEMINI_ARGON_CONTEXT));
      let params: GenerateContentParameters = {
        model: model.id, contents: helpers.convertMessages(model, context),
        config: {
          systemInstruction: context.systemPrompt,
          ...(context.tools?.length ? {
            tools: helpers.convertTools(context.tools, false, true),
            toolConfig: { functionCallingConfig: { mode: helpers.resolveGoogleFunctionCallingMode(context.tools, options.toolChoice, true) } },
          } : {}),
          maxOutputTokens, thinkingConfig: { thinkingLevel: level, includeThoughts: true },
          abortSignal: signal, automaticFunctionCalling: { disable: true }, automaticContinuation: false,
        },
      };
      const replacement = await abortable(Promise.resolve(options.onPayload?.(params, model)), signal);
      if (replacement !== undefined) params = replacement as GenerateContentParameters;
      // The adapter owns continuation and cancellation even when a payload hook is used.
      params.config = { ...params.config, abortSignal: signal, automaticContinuation: false, automaticFunctionCalling: { disable: true } };
      delete params.config.temperature;
      delete params.config.topP;
      delete params.config.topK;
      delete params.config.candidateCount;
      delete params.config.cachedContent;
      const configuredThinking = params.config.thinkingConfig;
      params.config.thinkingConfig = { includeThoughts: true, thinkingLevel: configuredThinking?.thinkingLevel ?? level };
      stream.push({ type: 'start', partial: output });
      let checkpoint: string | undefined;
      let checkpointRetries = 0;
      const maxCheckpointRetries = options.maxRetries ?? 2;
      let initialPromptTokens: number | undefined;
      const billed = emptyUsage();
      let finished = false;
      let contextOutputAtCheckpoint = 0;
      // Emit live until the first checkpoint. Afterwards, keep the uncommitted
      // tail private: a resumed checkpoint must not duplicate visible output/tools.
      let bufferTail = false;
      for (let hops = 0; !finished; hops++) {
        if (hops >= 128) throw new Error('Gemini Argon exceeded the continuation limit');
        signal.throwIfAborted();
        let hopUsage: GenerateContentResponseUsageMetadata | undefined;
        let finishReason: string | undefined;
        const contextOutputBeforeHop = contextOutputAtCheckpoint;
        const checkpointBeforeHop = checkpoint;
        let streamEnded = false;
        const pending: Part[] = [];
        timer = setTimeout(() => controller.abort(new Error('Gemini Argon request timed out')), timeout);
        try {
          const response = await abortable(client.models.generateContentStream({ ...params, config: { ...params.config, ...(checkpoint && { continuationToken: checkpoint }) } }), signal);
          iterator = response[Symbol.asyncIterator]();
          while (true) {
            const next = await abortable(iterator.next(), signal);
            if (next.done) break;
            const chunk = next.value;
            output.responseId ||= chunk.responseId;
            const candidate = chunk.candidates?.[0];
            if (chunk.usageMetadata) {
              hopUsage = chunk.usageMetadata;
              // Streaming prompt counts can be provisional in early chunks.
              // Keep the latest first-hop count, then freeze it across hops.
              if (hops === 0) initialPromptTokens = chunk.initialPromptTokenCount ?? hopUsage.promptTokenCount ?? 0;
              initialPromptTokens ??= hopUsage.promptTokenCount ?? 0;
              output.usage = combinedUsage(billed, hopUsage, initialPromptTokens);
              (output.usage as ArgonUsage).contextTokens = initialPromptTokens + contextOutputBeforeHop
                + (hopUsage.candidatesTokenCount ?? 0) + (hopUsage.thoughtsTokenCount ?? 0);
              calculateArgonCost(output.usage, billingRates);
            }
            const parts = candidate?.content?.parts ?? [];
            if (bufferTail) pending.push(...parts);
            else parts.forEach(append);
            if (candidate?.finishReason) finishReason = candidate.finishReason;
            if (candidate?.continuationToken) {
              if (candidate.continuationToken !== checkpoint) checkpointRetries = 0;
              checkpoint = candidate.continuationToken;
              contextOutputAtCheckpoint = (output.usage as ArgonUsage).contextTokens - (initialPromptTokens ?? 0);
              pending.splice(0).forEach(append);
              bufferTail = true;
            }
          }
          streamEnded = true;
          signal.throwIfAborted();
          if (finishReason === 'CONTINUATION') {
            if (!checkpoint || checkpoint === checkpointBeforeHop || pending.length) throw new Error('Gemini Argon continuation is missing a new committed checkpoint');
          } else {
            if (!finishReason) throw new Error('Gemini Argon stream ended without a finish reason');
            pending.splice(0).forEach(append);
            output.rawStopReason = finishReason;
            output.stopReason = helpers.mapStopReasonString(finishReason);
            if (output.stopReason === 'stop' && output.content.some((block) => block.type === 'toolCall')) output.stopReason = 'toolUse';
            if (output.stopReason === 'error' || output.stopReason === 'pending') throw new Error(`Gemini Argon stopped with: ${finishReason}`);
            finished = true;
          }
        } catch (error) {
          // Resume only from an explicit provider checkpoint. Never replay an
          // ambiguous initial request, execute a partial tool, or retry cancellation.
          const status = (error as { status?: number }).status;
          const resumable = checkpoint && !streamEnded && (!finishReason || finishReason === 'CONTINUATION')
            && (status === undefined || status === 408 || status === 429 || status >= 500);
          if (signal.aborted || !resumable || checkpointRetries++ >= maxCheckpointRetries) throw error;
        } finally {
          clearTimeout(timer);
          if (hopUsage) Object.assign(billed, combinedUsage(billed, hopUsage, initialPromptTokens ?? 0));
          if (iterator?.return) void iterator.return().catch(() => {});
          iterator = undefined;
        }
      }
      closeBlock();
      stream.push({ type: 'done', reason: output.stopReason as 'stop' | 'length' | 'toolUse', message: output });
    } catch (error) {
      closeBlock();
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      const reason = signal.aborted ? signal.reason : error;
      output.errorMessage = reason instanceof Error ? reason.message : String(reason);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      stream.end();
    }
  })();
  return stream;
}

function emptyUsage(): ArgonUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, contextTokens: 0, reasoning: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function combinedUsage(previous: Usage, hop: GenerateContentResponseUsageMetadata, initialPrompt: number): ArgonUsage {
  const cached = hop.cachedContentTokenCount ?? 0;
  const reasoning = (previous.reasoning ?? 0) + (hop.thoughtsTokenCount ?? 0);
  const output = previous.output + (hop.candidatesTokenCount ?? 0) + (hop.thoughtsTokenCount ?? 0);
  return { ...emptyUsage(), input: previous.input + Math.max(0, (hop.promptTokenCount ?? 0) - cached),
    cacheRead: previous.cacheRead + cached, output, reasoning,
    totalTokens: previous.totalTokens + (hop.totalTokenCount ?? 0), contextTokens: initialPrompt + output };
}

function calculateArgonCost(usage: Usage, rates: Model<'google-generative-ai'>['cost']) {
  usage.cost.input = usage.input * rates.input / 1_000_000;
  usage.cost.output = usage.output * rates.output / 1_000_000;
  usage.cost.cacheRead = usage.cacheRead * rates.cacheRead / 1_000_000;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead;
}
