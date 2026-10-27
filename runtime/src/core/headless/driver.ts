import type { JsonValue } from 'michi-shared';
import type { AgentSession } from '../../contract/types';
import type { NormalizedEvent, UserInputAnswer, UserInputQuestion } from '../../contract/events';
import type { HeadlessPermissionOptionId } from '../../contract/permissions';
import { ReportedRuntimeError } from '../../contract/errors';
import { classifyRuntimeError, type ClassifiedRuntimeError } from './errors';

// ---------------------------------------------------------------------------
// Headless session driver
// ---------------------------------------------------------------------------

/**
 * How a session takes supplemental input while it works:
 *
 * - `'native'`: same-turn steering through the session's `steer()` or
 *   `followUp()` method.
 * - `'next_turn'`: queued input waits for the current turn to end and is sent
 *   as a new user turn. Immediate input cancels the current turn first.
 * - `'none'`: supplemental input is rejected.
 */
export type HeadlessSteeringStrategy = 'native' | 'next_turn' | 'none';

export type HeadlessInputMode = 'queued' | 'immediate';

/** Supplemental input was accepted (`queued`) or delivered as a new turn (`applied`). */
export interface HeadlessSteeringEvent {
  phase: 'queued' | 'applied';
  text: string;
  mode: HeadlessInputMode;
  /** Set on immediate input that interrupts the running turn. */
  interrupted?: boolean;
}

/** Every error message the driver itself produces; hosts may use their own wording. */
export interface HeadlessDriverMessages {
  /** Input arrived once the session was finalizing or terminal. */
  inputRejected: string;
  /** Supplemental input with steering `none`. */
  steeringUnsupported(runtimeId: string): string;
  /** Native steering, but the session has neither `steer()` nor `followUp()`. */
  steerUnavailable(runtimeId: string): string;
  /** The session refused steering without giving a reason. */
  steerRejected: string;
  /** `continueAfterInput()` before the pending interaction was answered. */
  interactionUnanswered: string;
  /** The session has no method to answer the pending interaction. */
  cannotAnswerInteraction(runtimeId: string, kind: 'permission' | 'user_input'): string;
  /** A turn ended with stopReason `error`; becomes the failed outcome's message. */
  turnFailed: string;
}

export const DEFAULT_HEADLESS_DRIVER_MESSAGES: Readonly<HeadlessDriverMessages> = Object.freeze<HeadlessDriverMessages>({
  inputRejected: 'session has already completed or is finalizing; supplemental input rejected',
  steeringUnsupported: (runtimeId) => `runtime ${runtimeId} does not support supplemental input`,
  steerUnavailable: (runtimeId) => `runtime ${runtimeId} does not support session steering`,
  steerRejected: 'runtime rejected session steering',
  interactionUnanswered: 'session interaction has not been answered',
  cannotAnswerInteraction: (runtimeId, kind) => `runtime ${runtimeId} cannot answer a pending ${kind} interaction`,
  turnFailed: 'Runtime turn ended with an error',
});

/** Defaults with the host's overrides; a key set to undefined keeps its default. */
function mergeMessages(overrides: Partial<HeadlessDriverMessages> | undefined): HeadlessDriverMessages {
  const merged: HeadlessDriverMessages = { ...DEFAULT_HEADLESS_DRIVER_MESSAGES };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  return merged;
}

export interface HeadlessDriverOptions<R> {
  /** A live session; the driver sends its turns and never creates or loads one. */
  session: AgentSession;
  /** Names the runtime in error messages. Defaults to `session.runtimeId`. */
  runtimeId?: string;
  initialPrompt: string;
  steering: HeadlessSteeringStrategy;
  /** Native steering whose immediate input interrupts and continues as a new turn. */
  immediateSteering?: 'next_turn';
  /**
   * Prepended to supplemental input sent as a new turn. Defaults to the
   * empty string: under next_turn delivery the input is then sent verbatim
   * as a new turn, and the model may take it for a new task. Hosts that need
   * the model to tell it apart should provide a prefix.
   */
  supplementalPrefix?: string;
  /**
   * Every session event, in order. Return the write's promise when there is
   * one: the driver awaits it before reading the next event.
   */
  onEvent(event: NormalizedEvent): Promise<void> | void;
  /**
   * The native resume token is known for the first time or has changed.
   * The driver keeps no token itself: without this callback the token is
   * not saved and the host cannot resume the session later. Hosts that need
   * resume must provide it.
   */
  onCheckpoint?(nativeResumeToken: JsonValue): Promise<void> | void;
  /** Supplemental input was queued or applied; awaited before the driver continues. */
  onSteering?(event: HeadlessSteeringEvent): Promise<void> | void;
  /** Builds the result inside the finalizing barrier: input is rejected meanwhile. */
  finalize(assistantText: string): Promise<R> | R;
  /** Releases the session. Called at most once. */
  release(): Promise<void> | void;
  /** Maps an answer to a pending permission request onto a session option id. */
  answerPermission(text: string): HeadlessPermissionOptionId;
  /**
   * Maps an answer to a pending user_input request onto per-question answers.
   * Defaults to the same text for every question, keeping question ids.
   */
  answerUserInput?(text: string, questions: UserInputQuestion[]): UserInputAnswer[];
  /** Replaces individual default messages. */
  messages?: Partial<HeadlessDriverMessages>;
}

export type HeadlessOutcome<R> =
  | { status: 'completed'; result: R }
  | { status: 'waiting'; kind: 'permission' | 'user_input'; request: JsonValue }
  | { status: 'cancelled'; error?: ClassifiedRuntimeError }
  | { status: 'failed'; error: ClassifiedRuntimeError };

export interface HeadlessSessionHandle<R> {
  completion: Promise<HeadlessOutcome<R>>;
  /**
   * Continues the same event iterator after a `waiting` outcome was answered.
   * Throws synchronously while the interaction is still unanswered.
   */
  continueAfterInput(): Promise<HeadlessOutcome<R>>;
  /**
   * While a permission or user_input interaction is pending, `text` is its
   * answer and `mode` is ignored: a permission answer goes through
   * `answerPermission` to an option id, a user_input answer through
   * `answerUserInput`. Otherwise `text` is supplemental input, delivered by
   * the steering strategy.
   */
  input(text: string, mode?: HeadlessInputMode): Promise<void>;
  cancel(): Promise<void>;
}

type PendingInteraction =
  | { kind: 'permission'; requestId: number }
  | { kind: 'user_input'; requestId: number; questions: UserInputQuestion[] };

/**
 * Queued supplemental input waiting for the current turn to end.
 *
 * The driver holds at most one queued entry. Submitting a second queued
 * input while one is already pending replaces the pending entry (last-write
 * wins). Immediate input always cancels the current turn first.
 */
interface QueuedInput {
  text: string;
  mode: HeadlessInputMode;
}

/**
 * Terminalization phase of the supplemental input barrier.
 *
 * - `'active'`     — the session is running; input is accepted.
 * - `'finalizing'` — the last turn ended and the driver is building the
 *                     result. Input accepted *before* this transition
 *                     prevents the driver from reaching this state. Input
 *                     that arrives *during* finalization is rejected.
 * - `'terminal'`   — completed, failed or cancelled. All further input is
 *                     rejected deterministically.
 */
type TerminalizationPhase = 'active' | 'finalizing' | 'terminal';

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function broadcastAnswer(text: string, questions: UserInputQuestion[]): UserInputAnswer[] {
  return questions.map((question) => ({
    ...(question.id !== undefined ? { id: question.id } : {}),
    question: question.question,
    answer: text,
  }));
}

/**
 * Drives one session unattended: runs the initial turn, pauses on durable
 * interactions (permission, user_input) and continues on the same iterator,
 * delivers supplemental input by the session's steering strategy, checkpoints
 * native resume tokens, cancels and releases the session once.
 */
export function startHeadlessSession<R>(options: HeadlessDriverOptions<R>): HeadlessSessionHandle<R> {
  const { session, steering, immediateSteering } = options;
  const runtimeId = options.runtimeId ?? session.runtimeId;
  const supplementalPrefix = options.supplementalPrefix ?? '';
  const messages = mergeMessages(options.messages);

  let cancelled = false;
  let pending: PendingInteraction | null = null;
  let iterator: AsyncIterableIterator<NormalizedEvent> | null = null;
  let assistantText = '';
  let consuming: Promise<HeadlessOutcome<R>> | null = null;

  // Terminalization barrier — prevents races between input acceptance and
  // result finalization.
  let phase: TerminalizationPhase = 'active';

  // Queued supplemental input waiting for the current turn to end. Only
  // meaningful for `next_turn` delivery; `native` steering delivers input
  // synchronously via steer/followUp.
  let queuedInput: QueuedInput | null = null;
  let interruptionBarrier: Promise<void> | null = null;
  let turnSequence = 0;
  let activeTurn: number | null = null;

  const beginTurn = (text: string) => {
    activeTurn = ++turnSequence;
    return session.send(text);
  };

  // Track whether a session release has already been performed to prevent
  // double-release across cancel + turn completion.
  let released = false;

  const useNextTurnLoop = steering === 'next_turn';

  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await options.release();
  };

  // Serialized native resume token of the last checkpoint. A fresh session
  // may only learn its native id during the first turn (Claude reports it in
  // system/init), so every drain that ends a turn or pauses on a durable
  // interaction re-checks the token and checkpoints when it is new or has
  // changed.
  let lastCheckpointToken: string | null = null;

  const checkpointIfChanged = async () => {
    if (cancelled || session.nativeSessionId == null) return;
    const nativeResumeToken = session.getNativeResumeToken?.() ?? session.nativeSessionId;
    const serialized = JSON.stringify(nativeResumeToken);
    if (serialized === lastCheckpointToken) return;
    await options.onCheckpoint?.(nativeResumeToken);
    lastCheckpointToken = serialized;
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
  const drainIterator = async (): Promise<HeadlessOutcome<R> | 'turn_ended'> => {
    while (true) {
      const next = await iterator!.next();
      if (next.done) break;
      const event = next.value;
      if (event.kind === 'chunk') assistantText += event.text;
      const write = options.onEvent(event);
      if (write) await write;
      if (event.kind === 'permission_request') {
        pending = { kind: 'permission', requestId: event.requestId };
        return { status: 'waiting', kind: 'permission', request: json(event) };
      }
      if (event.kind === 'user_input_request') {
        pending = { kind: 'user_input', requestId: event.requestId, questions: event.questions };
        return { status: 'waiting', kind: 'user_input', request: json(event) };
      }
      if (event.kind === 'runtime_error') throw new ReportedRuntimeError(event);
      if (event.kind === 'turn_end') {
        activeTurn = null;
        await iterator!.return?.();
        if (event.stopReason === 'error') throw new Error(messages.turnFailed);
        break;
      }
    }
    activeTurn = null;
    return 'turn_ended';
  };

  /**
   * Core execution loop. For `native` steering this runs a single turn and
   * finalizes. For `next_turn` delivery this runs a multi-turn loop, checking
   * for queued supplemental input after each turn.
   *
   * The loop is re-entered after a durable interaction (permission/user_input)
   * is resolved via `continueAfterInput()` — the existing iterator continues
   * from where it paused.
   */
  const consume = (): Promise<HeadlessOutcome<R>> => {
    if (consuming) return consuming;
    consuming = (async (): Promise<HeadlessOutcome<R>> => {
      try {
        // Emit checkpoint before the first turn when the native id is known
        if (!iterator) {
          await checkpointIfChanged();
          iterator = beginTurn(options.initialPrompt);
        }

        // Drain the current iterator (may be a resumed iterator after interaction)
        let turnResult = await drainIterator();
        // Checkpoint both a finished turn and one paused on a durable
        // interaction, so a session waiting on its first approval is
        // already resumable. Runtime errors throw past this point.
        await checkpointIfChanged();

        // If the stream paused on a durable interaction, return it
        if (turnResult !== 'turn_ended') return turnResult;

        // For native steering, the single turn is done — finalize
        if (!useNextTurnLoop && immediateSteering !== 'next_turn') {
          if (cancelled) return { status: 'cancelled' };
          phase = 'finalizing';
          const result = await options.finalize(assistantText);
          phase = 'terminal';
          return { status: 'completed', result };
        }

        // Multi-turn loop for next_turn delivery: check for queued input
        // after each turn and start a new turn if present
        while (true) {
          if (cancelled) return { status: 'cancelled' };

          // Persistence and native cancellation may settle after turn_end.
          // Do not let a later turn start until every accepted interruption
          // has retired its own cancellation request.
          while (interruptionBarrier) {
            const barrier = interruptionBarrier;
            await barrier;
            if (interruptionBarrier === barrier) interruptionBarrier = null;
          }
          if (cancelled) return { status: 'cancelled' };

          // Atomically check and consume queued input
          const nextInput = queuedInput;
          queuedInput = null;

          if (!nextInput) {
            // No queued input — enter the terminalization barrier
            phase = 'finalizing';
            const result = await options.finalize(assistantText);
            phase = 'terminal';
            return { status: 'completed', result };
          }

          await options.onSteering?.({ phase: 'applied', text: nextInput.text, mode: nextInput.mode });

          // Start the next turn with the supplemental prefix
          iterator = beginTurn(supplementalPrefix + nextInput.text);
          turnResult = await drainIterator();
          await checkpointIfChanged();

          // If the new turn paused on a durable interaction, return it
          if (turnResult !== 'turn_ended') return turnResult;
        }
      } catch (error) {
        phase = 'terminal';
        if (cancelled) return { status: 'cancelled', error: classifyRuntimeError(error) };
        return { status: 'failed', error: classifyRuntimeError(error) };
      } finally {
        try { if (!pending) await releaseOnce(); }
        catch (error) {
          phase = 'terminal';
          return { status: 'failed', error: classifyRuntimeError(error) };
        } finally { consuming = null; }
      }
    })();
    return consuming;
  };

  const completion = consume();

  return {
    completion,
    continueAfterInput: () => {
      if (pending) throw new Error(messages.interactionUnanswered);
      return consume();
    },

    /**
     * Submit input to the running session.
     *
     * - **Pending interaction** (any strategy): answers the pending
     *   permission or user_input interaction directly.
     * - **`native` steering**: delegates to the session's `steer()` or
     *   `followUp()` method for same-turn delivery. Immediate mode cancels
     *   the current turn first, unless `immediateSteering` is `next_turn`.
     * - **`next_turn` delivery**: queued input is held until the current
     *   turn ends, then sent as a new user turn. Immediate input cancels the
     *   turn it targets, then the input is sent as the next turn.
     * - **`none` steering**: rejects input.
     *
     * The terminalization barrier rejects input once the session has begun
     * finalization or is already terminal.
     */
    input: async (text, mode = 'queued') => {
      // Resolve pending durable interactions first (any strategy)
      if (pending?.kind === 'permission') {
        // Clear the interaction only after the runtime accepted the answer;
        // a rejected or unanswerable answer leaves it pending so the caller
        // can retry or cancel.
        if (!session.respondToPermission) {
          throw new Error(messages.cannotAnswerInteraction(runtimeId, 'permission'));
        }
        session.respondToPermission(pending.requestId, options.answerPermission(text));
        pending = null;
        return;
      }
      if (pending?.kind === 'user_input') {
        if (!session.respondToUserInput) {
          throw new Error(messages.cannotAnswerInteraction(runtimeId, 'user_input'));
        }
        const answers = options.answerUserInput
          ? options.answerUserInput(text, pending.questions)
          : broadcastAnswer(text, pending.questions);
        // Same contract as permissions: clear only after the runtime
        // accepted the answer, so a rejected answer can be retried.
        session.respondToUserInput(pending.requestId, answers);
        pending = null;
        return;
      }

      // Terminalization barrier: reject input once the session is finalizing
      // or terminal. This prevents races where input arrives between the last
      // turn ending and the result being built.
      if (phase !== 'active') {
        throw new Error(messages.inputRejected);
      }

      if (steering === 'none') {
        throw new Error(messages.steeringUnsupported(runtimeId));
      }

      if (useNextTurnLoop || (mode === 'immediate' && immediateSteering === 'next_turn')) {
        // next_turn delivery: enqueue the input for delivery after the
        // current turn ends. Immediate mode cancels the running turn first.
        if (mode === 'immediate') {
          const targetTurn = activeTurn;
          const previous = interruptionBarrier;
          const interruption = Promise.resolve(previous).then(async () => {
            await options.onSteering?.({ phase: 'queued', text, mode: 'immediate', interrupted: true });
            // A naturally completed turn no longer needs cancellation.
            // Never interrupt a newer turn after an awaited event write.
            if (targetTurn !== null && activeTurn === targetTurn) await session.cancel();
          });
          interruptionBarrier = interruption;
          queuedInput = { text, mode };
          await interruption;
        } else {
          queuedInput = { text, mode };
          await options.onSteering?.({ phase: 'queued', text, mode: 'queued' });
        }
      } else {
        // native steering: delegate to the session's steer/followUp method
        const steer = session.steer ?? session.followUp;
        if (!steer) throw new Error(messages.steerUnavailable(runtimeId));
        if (mode === 'immediate') await session.cancel();
        const result = await steer.call(session, text);
        if (!result.accepted) throw new Error(result.reason ?? messages.steerRejected);
      }
    },

    cancel: async () => {
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
