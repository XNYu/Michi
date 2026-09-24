import { createHash } from 'node:crypto';
import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunEventType,
  type JsonValue,
  type RuntimeProfileV1,
  type StructuredRunErrorV1,
} from 'michi-shared';
import { getRuntime } from '../registry';
import type {
  AgentReasoning,
  AgentRuntime,
  AgentSession,
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimeSessionOwner,
} from '../types';
import type { NormalizedEvent, UserInputQuestion } from '../../services/chatEvents';
import type {
  AgentRunExecutionEvent,
  AgentRunExecutionOutcome,
  AgentRunExecutor,
  AgentRunHandle,
  AgentRunSpec,
} from './ports';
import type { RuntimeRunAdapter } from './runtimeRunAdapter';
import { RuntimeRunAdapterRegistry } from './runtimeRunAdapterRegistry';
import { createRunResultCollector } from './runWorkerTools';

export interface RuntimeRunExecutorDeps {
  resolveRuntime?: (runtimeId: string) => AgentRuntime | undefined;
  /** Preferred: supply a shared registry so Executor, readiness, and catalog
   * all consult the same adapter set. Falls back to `adapters` for backward
   * compatibility. */
  registry?: RuntimeRunAdapterRegistry;
  /** @deprecated Use `registry` instead. Kept for backward compatibility with
   * tests that inject an explicit adapter array. */
  adapters?: readonly RuntimeRunAdapter[];
  createPermissionBroker?: (input: {
    spec: AgentRunSpec;
    owner: RuntimeSessionOwner;
    emit: (event: AgentRunExecutionEvent) => Promise<void>;
  }) => RuntimePermissionBroker;
}

type PendingInteraction =
  | { kind: 'permission'; requestId: number }
  | { kind: 'user_input'; requestId: number; questions: UserInputQuestion[] };

// ---------------------------------------------------------------------------
// Supplemental input types
// ---------------------------------------------------------------------------

/**
 * Queued supplemental input waiting for the current turn to end.
 *
 * The Executor holds at most one queued entry. Submitting a second queued
 * input while one is already pending replaces the pending entry (last-write
 * wins). Immediate input always cancels the current turn first.
 */
interface QueuedInput {
  text: string;
  mode: 'queued' | 'immediate';
}

/**
 * Terminalization phase of the supplemental input barrier.
 *
 * - `'active'`     — the Attempt is running; input is accepted.
 * - `'finalizing'` — the last turn ended and the Executor is building the
 *                     Result Bundle. Input accepted *before* this transition
 *                     prevents the Executor from reaching this state. Input
 *                     that arrives *during* finalization is rejected.
 * - `'terminal'`   — the Attempt is complete (completed/failed/cancelled).
 *                     All further input is rejected deterministically.
 */
type TerminalizationPhase = 'active' | 'finalizing' | 'terminal';

/**
 * System-neutral prefix prepended to supplemental input when delivered as a
 * new user turn (next_turn steering). Explains to the agent that this is not
 * a fresh task but additional guidance for the same ongoing Attempt.
 */
const SUPPLEMENTAL_INPUT_PREFIX =
  '[Supplemental instruction for the current task — do not treat this as a new task.]\n\n';

function stableHash(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
    return item;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function profileFor(spec: AgentRunSpec): RuntimeProfileV1 {
  return spec.effectiveDefinition.runtimeProfile;
}

function bootstrap(spec: AgentRunSpec): string {
  return [
    'You are executing a durable Michi Agent Run. Do not assume any Parent conversation history.',
    `Agent instructions:\n${spec.effectiveDefinition.instructions}`,
    `Task:\n${spec.task}`,
    `Context manifest (immutable snapshots and inline context):\n${JSON.stringify(spec.contextManifest)}`,
    `Expected result contract:\n${JSON.stringify(spec.expectedResult)}`,
    `Recovery envelope:\n${JSON.stringify(spec.recoveryEnvelope)}`,
    'Before finishing, call submit_agent_result with a version 1 Result Bundle. If unavailable, give a concise final answer for fallback inference.',
  ].join('\n\n');
}

function allowedTools(spec: AgentRunSpec): string[] {
  return spec.effectiveDefinition.capabilitySnapshot.entries
    .filter((entry) => entry.kind === 'tool').map((entry) => entry.id);
}

function replayHistory(spec: AgentRunSpec): Array<{ role: 'user' | 'assistant'; content: string }> | undefined {
  const recovery = spec.recoveryEnvelope;
  if (!recovery) return undefined;
  const summary = [recovery.completedWork, recovery.outstandingWork].filter(Boolean).join('\n');
  return summary ? [{ role: 'assistant', content: `Recovery handoff:\n${summary}` }] : undefined;
}

function classifyError(error: unknown): StructuredRunErrorV1 {
  const message = error instanceof Error ? error.message : String(error);
  const text = `${error instanceof Error ? error.name : ''} ${message}`.toLowerCase();
  if (/api.?key|credential|unauthori[sz]ed|forbidden|auth/.test(text)) {
    return { version: 1, code: 'runtime_auth', category: 'auth_permission', message, retryable: false };
  }
  if (/unsupported|not supported|unknown model|invalid model|incompatible/.test(text)) {
    return { version: 1, code: 'runtime_incompatible', category: 'incompatible', message, retryable: false };
  }
  if (/capacity|concurren|rate.?limit|too many/.test(text)) {
    return { version: 1, code: 'runtime_capacity', category: 'capacity', message, retryable: true };
  }
  if (/timeout|timed out|econn|socket|process exited|temporar/.test(text)) {
    return { version: 1, code: 'runtime_transient', category: 'transient', message, retryable: true };
  }
  return { version: 1, code: 'runtime_terminal', category: 'terminal', message, retryable: false };
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function eventFor(event: NormalizedEvent): AgentRunExecutionEvent | null {
  switch (event.kind) {
    case 'chunk': return { type: AgentRunEventType.Assistant, payload: { version: 1, text: event.text } };
    case 'thought': return { type: AgentRunEventType.Thought, payload: { version: 1, text: event.text } };
    case 'plan': return { type: AgentRunEventType.Plan, payload: { version: 1, entries: json(event.entries) } };
    case 'tool_call': return { type: AgentRunEventType.ToolCall, payload: { version: 1, ...json(event) as object } as JsonValue };
    case 'tool_call_update': return { type: AgentRunEventType.ToolCallUpdate, payload: { version: 1, ...json(event) as object } as JsonValue };
    case 'usage_summary': return { type: AgentRunEventType.Usage, payload: { version: 1, ...json(event) as object } as JsonValue };
    case 'artifact_saved':
    case 'artifact_updated': return { type: AgentRunEventType.ResultBundleUpdated, payload: { version: 1, artifact: json(event) } };
    case 'permission_request': return { type: AgentRunEventType.InteractionRequested, payload: { version: 1, kind: 'permission', request: json(event) } };
    case 'user_input_request': return { type: AgentRunEventType.InteractionRequested, payload: { version: 1, kind: 'user_input', request: json(event) } };
    case 'runtime_error': return { type: AgentRunEventType.ToolCallUpdate, payload: { version: 1, runtimeError: event.error } };
    default: return null;
  }
}

function permissionDecision(text: string): RuntimePermissionDecision {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'allow_always') return 'allow_always';
  if (['allow', 'approve', 'allow_once', 'yes'].includes(normalized)) return 'allow_once';
  return 'deny';
}

export class RuntimeRunExecutor implements AgentRunExecutor {
  private readonly resolveRuntime: (runtimeId: string) => AgentRuntime | undefined;
  private readonly registry: RuntimeRunAdapterRegistry;
  private readonly createPermissionBroker: NonNullable<RuntimeRunExecutorDeps['createPermissionBroker']>;

  constructor(deps: RuntimeRunExecutorDeps = {}) {
    this.resolveRuntime = deps.resolveRuntime ?? getRuntime;
    this.registry = deps.registry
      ?? new RuntimeRunAdapterRegistry(deps.adapters);
    this.createPermissionBroker = deps.createPermissionBroker ?? (({ spec }) => ({
      requestPermission: async ({ toolName }) => permissionDecisionForTool(spec, toolName),
    }));
  }

  start(spec: AgentRunSpec, emit: (event: AgentRunExecutionEvent) => Promise<void>): Promise<AgentRunHandle> {
    return this.open(spec, null, emit);
  }

  resume(spec: AgentRunSpec, nativeResumeToken: JsonValue,
    emit: (event: AgentRunExecutionEvent) => Promise<void>): Promise<AgentRunHandle> {
    return this.open(spec, nativeResumeToken, emit);
  }

  private async open(spec: AgentRunSpec, nativeResumeToken: JsonValue | null,
    emit: (event: AgentRunExecutionEvent) => Promise<void>): Promise<AgentRunHandle> {
    const profile = profileFor(spec);
    const adapter = this.registry.get(profile.runtimeId);
    if (!adapter) {
      const supported = this.registry.supportedRuntimeIds();
      const list = supported.length > 0 ? supported.join(', ') : '(none)';
      return this.failedHandle({ version: 1, code: 'runtime_unsupported', category: 'incompatible',
        message: `Agent Run runtime ${profile.runtimeId} is unsupported; supported runtimes are ${list}`, retryable: false }, spec.recoveryEnvelope);
    }
    const runtime = this.resolveRuntime(profile.runtimeId);
    if (!runtime) return this.failedHandle({ version: 1, code: 'runtime_unavailable', category: 'incompatible',
      message: `Agent Run runtime ${profile.runtimeId} is not registered`, retryable: false }, spec.recoveryEnvelope);
    try { adapter.assertCompatible(runtime); }
    catch (error) { return this.failedHandle(classifyError(error), spec.recoveryEnvelope); }
    if (profile.reasoning && !runtime.capabilities.supportedReasoningLevels.includes(profile.reasoning as AgentReasoning)) {
      return this.failedHandle({ version: 1, code: 'reasoning_unsupported', category: 'incompatible',
        message: `Runtime ${runtime.id} does not support reasoning level ${profile.reasoning}`, retryable: false }, spec.recoveryEnvelope);
    }
    const owner: RuntimeSessionOwner = { kind: 'agent_run', runId: spec.runId, attemptId: spec.attemptId };
    const instructions = bootstrap(spec);
    const collector = createRunResultCollector(owner);
    const toolProfile = collector.createToolProfile(allowedTools(spec), json(spec.effectiveDefinition.capabilitySnapshot));
    const permissionBroker = this.createPermissionBroker({ spec, owner, emit });
    const profileHash = stableHash({ profile, cwd: spec.executionEnvironment.cwd,
      environment: spec.executionEnvironment, instructions, capabilitySnapshot: spec.effectiveDefinition.capabilitySnapshot });
    const common = {
      sessionId: spec.attemptId,
      owner,
      cwd: spec.executionEnvironment.cwd,
      workspaceId: spec.workspaceId,
      ownerUserId: spec.ownerUserId,
      bootstrapInstructions: instructions,
      replayHistory: replayHistory(spec),
      toolProfile,
      permissionBroker,
      profileHash,
      model: profile.modelId ?? null,
      provider: profile.providerId ?? null,
      reasoning: (profile.reasoning ?? null) as AgentReasoning | null,
      enableFollowUps: false,
    };
    let session: AgentSession;
    try {
      if (nativeResumeToken !== null && adapter.supportsNativeResume && runtime.capabilities.nativeResume && runtime.loadSession) {
        session = await runtime.loadSession({ ...common, nativeResumeToken });
      } else {
        await runtime.warm(spec.executionEnvironment.cwd, { model: profile.modelId ?? null });
        session = await runtime.newSession(common);
      }
      if (profile.modeId) {
        if (!session.setMode) throw new Error(`runtime ${runtime.id} does not support requested mode ${profile.modeId}`);
        await session.setMode(profile.modeId);
      }
      if (session.id !== spec.attemptId || session.owner?.kind !== 'agent_run'
        || session.owner.runId !== spec.runId || session.owner.attemptId !== spec.attemptId) {
        throw new Error('runtime returned a session with the wrong Agent Run Attempt owner');
      }
      if (session.runtimeProfileHash != null && session.runtimeProfileHash !== profileHash) {
        throw new Error('runtime returned a session with an incompatible profile hash');
      }
    } catch (error) {
      return this.failedHandle(classifyError(error), spec.recoveryEnvelope);
    }

    // -----------------------------------------------------------------------
    // Supplemental input state machine
    // -----------------------------------------------------------------------

    let cancelled = false;
    let pending: PendingInteraction | null = null;
    let iterator: AsyncIterableIterator<NormalizedEvent> | null = null;
    let assistantText = '';
    let consuming: Promise<AgentRunExecutionOutcome> | null = null;

    // Terminalization barrier — prevents races between input acceptance and
    // Result Bundle finalization.
    let phase: TerminalizationPhase = 'active';

    // Queued supplemental input waiting for the current turn to end. Only
    // meaningful for `next_turn` adapters; `native` adapters deliver input
    // synchronously via steer/followUp.
    let queuedInput: QueuedInput | null = null;

    // Track whether a session release has already been performed to prevent
    // double-release across cancel + turn completion.
    let released = false;

    const useNextTurnLoop = adapter.steering === 'next_turn';

    const releaseOnce = async () => {
      if (released) return;
      released = true;
      await runtime.releaseSession(spec.attemptId, owner);
    };

    /**
     * Drain the current event iterator until it yields turn_end, a durable
     * interaction (permission/user_input), an error, or stream exhaustion.
     *
     * Returns:
     * - `'turn_ended'` when the turn completed normally.
     * - A `waiting` outcome when the stream pauses on a durable interaction.
     * - Throws on runtime errors.
     *
     * This function reads from `iterator` which is set by the caller. It is
     * the lowest-level building block and does NOT start new turns.
     */
    const drainIterator = async (): Promise<AgentRunExecutionOutcome | 'turn_ended'> => {
      while (true) {
        const next = await iterator!.next();
        if (next.done) break;
        const event = next.value;
        if (event.kind === 'chunk') assistantText += event.text;
        if (event.kind === 'usage_summary') collector.recordUsage({
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          ...(event.cachedInputTokens === undefined ? {} : { cachedTokens: event.cachedInputTokens }),
        });
        if (event.kind === 'artifact_saved' || event.kind === 'artifact_updated') {
          collector.recordArtifact({ id: event.contextId ?? `${spec.attemptId}:${event.name}`, name: event.name,
            kind: 'runtime_artifact', uri: event.filePath, sha256: null, size: event.size ?? null });
        }
        const mapped = eventFor(event);
        if (mapped) await emit(mapped);
        if (event.kind === 'permission_request') {
          pending = { kind: 'permission', requestId: event.requestId };
          return { status: 'waiting', kind: 'permission', request: json(event) };
        }
        if (event.kind === 'user_input_request') {
          pending = { kind: 'user_input', requestId: event.requestId, questions: event.questions };
          return { status: 'waiting', kind: 'user_input', request: json(event) };
        }
        if (event.kind === 'runtime_error') throw new Error(event.error);
        if (event.kind === 'turn_end') {
          await iterator!.return?.();
          break;
        }
      }
      return 'turn_ended';
    };

    /**
     * Core execution loop. For `native` adapters this runs a single turn and
     * finalizes. For `next_turn` adapters this runs a multi-turn loop,
     * checking for queued supplemental input after each turn.
     *
     * The loop is re-entered after a durable interaction (permission/user_input)
     * is resolved via `continueAfterInput()` — the existing iterator continues
     * from where it paused.
     */
    const consume = (): Promise<AgentRunExecutionOutcome> => {
      if (consuming) return consuming;
      consuming = (async () => {
        try {
          // Emit checkpoint before the first turn
          if (!iterator) {
            if (session.nativeSessionId != null) {
              await emit({ type: AgentRunEventType.Checkpoint, payload: { version: 1, runtimeId: runtime.id }, nativeResumeToken: session.getNativeResumeToken?.() ?? session.nativeSessionId });
            }
            iterator = session.send(spec.task);
          }

          // Drain the current iterator (may be a resumed iterator after interaction)
          let turnResult = await drainIterator();

          // If the stream paused on a durable interaction, return it
          if (turnResult !== 'turn_ended') return turnResult;

          // For native adapters, the single turn is done — finalize
          if (!useNextTurnLoop && adapter.immediateSteering !== 'next_turn') {
            if (cancelled) return { status: 'cancelled' };
            phase = 'finalizing';
            const resultBundle = collector.finalize(assistantText);
            await emit({ type: AgentRunEventType.ResultBundleUpdated, payload: json(resultBundle) });
            phase = 'terminal';
            return { status: 'completed', resultBundle };
          }

          // Multi-turn loop for next_turn adapters: check for queued input
          // after each turn and start a new turn if present
          while (true) {
            if (cancelled) return { status: 'cancelled' };

            // Atomically check and consume queued input
            const nextInput = queuedInput;
            queuedInput = null;

            if (!nextInput) {
              // No queued input — enter the terminalization barrier
              phase = 'finalizing';
              const resultBundle = collector.finalize(assistantText);
              await emit({ type: AgentRunEventType.ResultBundleUpdated, payload: json(resultBundle) });
              phase = 'terminal';
              return { status: 'completed', resultBundle };
            }

            // Emit input-applied event
            await emit({
              type: AgentRunEventType.SteeringApplied,
              payload: { version: 1, text: nextInput.text, mode: nextInput.mode },
            });

            // Start the next turn with the supplemental prefix
            const supplementalText = SUPPLEMENTAL_INPUT_PREFIX + nextInput.text;
            iterator = session.send(supplementalText);
            turnResult = await drainIterator();

            // If the new turn paused on a durable interaction, return it
            if (turnResult !== 'turn_ended') return turnResult;
          }
        } catch (error) {
          phase = 'terminal';
          if (cancelled) return { status: 'cancelled', error: classifyError(error) };
          return { status: 'failed', error: classifyError(error), recoveryEnvelope: spec.recoveryEnvelope };
        } finally {
          if (!pending) await releaseOnce();
          consuming = null;
        }
      })();
      return consuming;
    };

    const completion = consume();

    return {
      completion,
      continueAfterInput: () => {
        if (pending) throw new Error('Attempt interaction has not been answered');
        return consume();
      },

      /**
       * Submit supplemental input to the running Attempt.
       *
       * Behavior depends on the adapter's steering strategy:
       *
       * - **Pending interaction** (any adapter): resolves the pending
       *   permission or user_input interaction directly.
       *
       * - **`native` steering** (Codex, Pi, Kiro): delegates to the
       *   session's `steer()` or `followUp()` method for same-turn delivery.
       *   Immediate mode cancels the current turn first.
       *
       * - **`next_turn` steering**: queued input is held until the
       *   current turn ends, then sent as a new user turn. Immediate input
       *   cancels the current turn, then the queued input is sent as the
       *   next turn.
       *
       * - **`none` steering**: rejects input with a structured error.
       *
       * The terminalization barrier prevents input after the Attempt has
       * begun finalization or is already terminal.
       */
      input: async (text, mode = 'queued') => {
        // Resolve pending durable interactions first (any adapter)
        if (pending?.kind === 'permission') {
          session.respondToPermission?.(pending.requestId, permissionDecision(text));
          pending = null;
          return;
        }
        if (pending?.kind === 'user_input') {
          const answers = pending.questions.map((question) => ({
            ...(question.id !== undefined ? { id: question.id } : {}),
            question: question.question,
            answer: text,
          }));
          session.respondToUserInput?.(pending.requestId, answers);
          pending = null;
          return;
        }

        // Terminalization barrier: reject input once the Attempt is finalizing
        // or terminal. This prevents races where input arrives between the last
        // turn ending and the Result Bundle being built.
        if (phase !== 'active') {
          throw new Error('Attempt has already completed or is finalizing; supplemental input rejected');
        }

        if (adapter.steering === 'none') {
          throw new Error(`runtime ${runtime.id} does not support supplemental input`);
        }

        if (useNextTurnLoop || (mode === 'immediate' && adapter.immediateSteering === 'next_turn')) {
          // next_turn steering: enqueue the input for delivery after the
          // current turn ends. Immediate mode cancels the running turn first.
          // Publish before awaiting cancel: the prompt may settle immediately.
          queuedInput = { text, mode };
          if (mode === 'immediate') {
            // Emit a turn-interrupted event so observers know the current
            // turn was cut short for supplemental input.
            await emit({
              type: AgentRunEventType.SteeringQueued,
              payload: { version: 1, text, mode: 'immediate', interrupted: true },
            });
            await session.cancel();
          } else {
            await emit({
              type: AgentRunEventType.SteeringQueued,
              payload: { version: 1, text, mode: 'queued' },
            });
          }
        } else {
          // native steering: delegate to the session's steer/followUp method
          if (mode === 'immediate') await session.cancel();
          const steer = session.steer ?? session.followUp;
          if (!steer) throw new Error(`runtime ${runtime.id} does not support Attempt steering`);
          const result = await steer.call(session, text);
          if (!result.accepted) throw new Error(result.reason ?? 'runtime rejected Attempt steering');
        }
      },

      cancel: async (_reason: string | null = null) => {
        cancelled = true;
        // Clear any queued supplemental input — it will never be delivered
        queuedInput = null;
        phase = 'terminal';
        if (pending?.kind === 'permission') session.cancelPermission?.(pending.requestId);
        if (pending?.kind === 'user_input') session.skipUserInput?.(pending.requestId);
        pending = null;
        await session.cancel();
        await releaseOnce();
        await iterator?.return?.();
      },
    };
  }

  private failedHandle(error: StructuredRunErrorV1, recoveryEnvelope: AgentRunSpec['recoveryEnvelope']): AgentRunHandle {
    return {
      completion: Promise.resolve({ status: 'failed', error, recoveryEnvelope }),
      input: async () => { throw new Error('cannot steer a failed Agent Run Attempt'); },
      cancel: async () => {},
    };
  }
}

export { classifyError as classifyRuntimeRunError };

function permissionDecisionForTool(spec: AgentRunSpec, toolName: string): RuntimePermissionDecision {
  if (toolName === 'submit_agent_result') return 'allow_once';
  const canonical = toolName === 'Bash' ? 'bash'
    : ['Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName) ? 'edit'
      : toolName === 'Write' ? 'write' : toolName;
  const category = (() => {
    if (canonical === 'spawn_agent') return AgentPolicyCategory.SpawnAgent;
    if (['bash'].includes(canonical)) return AgentPolicyCategory.ShellExec;
    if (['write', 'edit'].includes(canonical)) return AgentPolicyCategory.FilesystemWrite;
    if (['save_artifact', 'update_artifact', 'spawn_branches'].includes(canonical)) return AgentPolicyCategory.ArtifactWrite;
    if (canonical === 'web_search') return AgentPolicyCategory.Browse;
    if (['grep', 'find', 'search_messages'].includes(canonical)) return AgentPolicyCategory.Search;
    if (['read', 'ls', 'read_node', 'read_node_overview', 'list_threads', 'show_image', 'list_agents', 'check_agent', 'wait_agent'].includes(canonical)) {
      return AgentPolicyCategory.Read;
    }
    return AgentPolicyCategory.ExternalAction;
  })();
  const decision = spec.effectiveDefinition.permissionPolicy.categories[category] ?? AgentPolicyDecision.Deny;
  if (decision === AgentPolicyDecision.Allow) return 'allow_once';
  if (decision === AgentPolicyDecision.Ask) return 'ask';
  return 'deny';
}
