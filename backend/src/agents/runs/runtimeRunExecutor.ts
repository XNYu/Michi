import { createHash } from 'node:crypto';
import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunEventType,
  type JsonValue,
  type ResultBundleV1,
  type RuntimeProfileV1,
  type StructuredRunErrorV1,
} from 'michi-shared';
import {
  startHeadlessSession,
  type HeadlessDriverMessages,
  type HeadlessOutcome,
} from 'michi-runtime/internal/core/headless/driver';
import { classifyRuntimeError, type ClassifiedRuntimeError } from 'michi-runtime/internal/core/headless/errors';
import { decisionToOptionId } from 'michi-runtime/internal/contract/permissions';
import { getRuntime } from '../registry';
import { assertModelReasoningCompatible } from '../modelReasoning';
import type {
  AgentReasoning,
  AgentRuntime,
  AgentSession,
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimeSessionOwner,
} from '../types';
import type { NormalizedEvent } from '../../services/chatEvents';
import { decodeMichiHostEvent, type MichiHostEvent } from '../hostEvents';
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
import { isRunOwner, runOwner, sameHostOwner } from '../ownerMapping';

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

/**
 * System-neutral prefix prepended to supplemental input when delivered as a
 * new user turn (next_turn steering). Explains to the agent that this is not
 * a fresh task but additional guidance for the same ongoing Attempt.
 */
const SUPPLEMENTAL_INPUT_PREFIX =
  '[Supplemental instruction for the current task — do not treat this as a new task.]\n\n';

/** Headless driver messages in the wording Agent Run callers already receive. */
const RUN_DRIVER_MESSAGES: HeadlessDriverMessages = {
  inputRejected: 'Attempt has already completed or is finalizing; supplemental input rejected',
  steeringUnsupported: (runtimeId) => `runtime ${runtimeId} does not support supplemental input`,
  steerUnavailable: (runtimeId) => `runtime ${runtimeId} does not support Attempt steering`,
  steerRejected: 'runtime rejected Attempt steering',
  interactionUnanswered: 'Attempt interaction has not been answered',
  cannotAnswerInteraction: (runtimeId, kind) => `runtime ${runtimeId} cannot answer a pending ${kind} interaction`,
  turnFailed: 'Runtime turn ended with an error',
};

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

function runError(error: ClassifiedRuntimeError): StructuredRunErrorV1 {
  return { version: 1, code: `runtime_${error.category}`,
    category: error.category === 'auth' ? 'auth_permission' : error.category,
    message: error.message, retryable: error.retryable };
}

function classifyError(error: unknown): StructuredRunErrorV1 {
  return runError(classifyRuntimeError(error));
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
    case 'permission_request': return { type: AgentRunEventType.InteractionRequested, payload: { version: 1, kind: 'permission', request: json(event) } };
    case 'user_input_request': return { type: AgentRunEventType.InteractionRequested, payload: { version: 1, kind: 'user_input', request: json(event) } };
    case 'runtime_error': return { type: AgentRunEventType.ToolCallUpdate, payload: { version: 1, runtimeError: event.error } };
    default: return null;
  }
}

type ArtifactEvent = Extract<MichiHostEvent, { type: 'artifact_saved' | 'artifact_updated' }>;

/** The artifact a runtime reported saving or updating, if this event reports one. */
function reportedArtifact(event: NormalizedEvent): ArtifactEvent | null {
  if (event.kind !== 'host_event') return null;
  const product = decodeMichiHostEvent(event);
  return product?.type === 'artifact_saved' || product?.type === 'artifact_updated' ? product : null;
}

/** Persisted Run events keep the artifact event's original form, its kind included. */
function artifactEventFor(artifact: ArtifactEvent): AgentRunExecutionEvent {
  return { type: AgentRunEventType.ResultBundleUpdated, payload: { version: 1, artifact: json({ kind: artifact.type, ...artifact.payload }) } };
}

function permissionDecision(text: string): Exclude<RuntimePermissionDecision, 'ask'> {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'allow_always') return 'allow_always';
  if (['allow', 'approve', 'allow_once', 'yes'].includes(normalized)) return 'allow_once';
  return 'deny';
}

// Moved to the runtime contract; re-exported for existing callers.
export { decisionToOptionId };

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
    try {
      await assertModelReasoningCompatible(runtime, profile.modelId, profile.providerId,
        profile.reasoning as AgentReasoning | null);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'model_unsupported' || code === 'reasoning_unsupported') {
        return this.failedHandle({ version: 1, code, category: 'incompatible',
          message: (error as Error).message, retryable: false }, spec.recoveryEnvelope);
      }
      return this.failedHandle({ version: 1, code: 'model_capabilities_unavailable', category: 'transient',
        message: `Unable to verify Agent Run model capabilities: ${(error as Error).message}`, retryable: true }, spec.recoveryEnvelope);
    }
    const owner: RuntimeSessionOwner = runOwner(spec.runId, spec.attemptId);
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
      if (session.id !== spec.attemptId || !session.owner || !isRunOwner(session.owner)
        || !sameHostOwner(session.owner, owner)) {
        throw new Error('runtime returned a session with the wrong Agent Run Attempt owner');
      }
      if (session.runtimeProfileHash != null && session.runtimeProfileHash !== profileHash) {
        throw new Error('runtime returned a session with an incompatible profile hash');
      }
    } catch (error) {
      return this.failedHandle(classifyError(error), spec.recoveryEnvelope);
    }

    // The package driver owns the turn loop, durable interactions,
    // supplemental input, cancellation, release and checkpoints; the
    // callbacks below record the Run's events and Result Bundle.
    const run = startHeadlessSession<ResultBundleV1>({
      session,
      runtimeId: runtime.id,
      initialPrompt: spec.task,
      steering: adapter.steering,
      immediateSteering: adapter.immediateSteering,
      supplementalPrefix: SUPPLEMENTAL_INPUT_PREFIX,
      onEvent: (event) => {
        if (event.kind === 'usage_summary') collector.recordUsage({
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          ...(event.cachedInputTokens === undefined ? {} : { cachedTokens: event.cachedInputTokens }),
        });
        const artifact = reportedArtifact(event);
        if (artifact) {
          const { contextId, name, filePath, size } = artifact.payload;
          collector.recordArtifact({ id: contextId ?? `${spec.attemptId}:${name}`, name,
            kind: 'runtime_artifact', uri: filePath, sha256: null, size: size ?? null });
        }
        const mapped = artifact ? artifactEventFor(artifact) : eventFor(event);
        return mapped ? emit(mapped) : undefined;
      },
      onCheckpoint: (token) => emit({ type: AgentRunEventType.Checkpoint,
        payload: { version: 1, runtimeId: runtime.id }, nativeResumeToken: token }),
      onSteering: ({ phase, text, mode, interrupted }) => emit(phase === 'applied'
        ? { type: AgentRunEventType.SteeringApplied, payload: { version: 1, text, mode } }
        : { type: AgentRunEventType.SteeringQueued,
          payload: interrupted ? { version: 1, text, mode, interrupted } : { version: 1, text, mode } }),
      finalize: (assistantText) => {
        const resultBundle = collector.finalize(assistantText);
        return emit({ type: AgentRunEventType.ResultBundleUpdated, payload: json(resultBundle) }).then(() => resultBundle);
      },
      release: () => runtime.releaseSession(spec.attemptId, owner),
      answerPermission: (text) => decisionToOptionId(permissionDecision(text)),
      messages: RUN_DRIVER_MESSAGES,
    });

    const outcomeFor = (outcome: HeadlessOutcome<ResultBundleV1>): AgentRunExecutionOutcome => {
      switch (outcome.status) {
        case 'completed': return { status: 'completed', resultBundle: outcome.result };
        case 'waiting': return outcome;
        case 'cancelled': return outcome.error ? { status: 'cancelled', error: runError(outcome.error) } : { status: 'cancelled' };
        case 'failed': return { status: 'failed', error: runError(outcome.error), recoveryEnvelope: spec.recoveryEnvelope };
      }
    };

    return {
      completion: run.completion.then(outcomeFor),
      // Throws synchronously while the interaction is unanswered.
      continueAfterInput: () => run.continueAfterInput().then(outcomeFor),
      input: (text, mode) => run.input(text, mode),
      cancel: () => run.cancel(),
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

/** Adapters send canonical tool names (bash, edit, write, read, ...). */
function permissionDecisionForTool(spec: AgentRunSpec, canonical: string): RuntimePermissionDecision {
  if (canonical === 'submit_agent_result') return 'allow_once';
  const category = (() => {
    if (canonical === 'spawn_agent') return AgentPolicyCategory.SpawnAgent;
    if (['bash'].includes(canonical)) return AgentPolicyCategory.ShellExec;
    if (['write', 'edit'].includes(canonical)) return AgentPolicyCategory.FilesystemWrite;
    if (['save_artifact', 'update_artifact', 'spawn_branches'].includes(canonical)) return AgentPolicyCategory.ArtifactWrite;
    if (canonical === 'web_search' || canonical === 'fetch_content') return AgentPolicyCategory.Browse;
    if (['grep', 'find', 'search_messages'].includes(canonical)) return AgentPolicyCategory.Search;
    if (['read', 'ls', 'read_node', 'read_node_overview', 'read_conversation_updates', 'list_threads', 'show_image', 'list_agents', 'check_agent', 'wait_agent'].includes(canonical)) {
      return AgentPolicyCategory.Read;
    }
    return AgentPolicyCategory.ExternalAction;
  })();
  const decision = spec.effectiveDefinition.permissionPolicy.categories[category] ?? AgentPolicyDecision.Deny;
  if (decision === AgentPolicyDecision.Allow) return 'allow_once';
  if (decision === AgentPolicyDecision.Ask) return 'ask';
  return 'deny';
}
