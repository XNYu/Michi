/**
 * Turns Kiro V3 starts on its own, with no `session/prompt`: when a workflow
 * a chat launched finishes, Kiro wakes the parent session and reports back
 * (`turn_start` … `agent_message_chunk` … `turn_end`; recorded with
 * kiro-cli 2.32.0 by benchmarks/workflow-observability/2026-10-16/
 * probe-kiro-wake.cjs).
 *
 * Each such turn gets its own queue, so its frames can neither be drained by
 * nor leak into the next prompt, and holds the session's turn reservation
 * until Kiro reports its end, so a prompt sent while it is shown waits.
 *
 * A turn is claimed lazily, on its first frame that shows something. Until
 * then a prompt of ours overtakes it, as Kiro itself handles a prompt that
 * arrives during a wake (kiro-wake-send-wire.jsonl): the prompt is sent
 * right away, Kiro ends the wake, and the wake's remaining frames are
 * discarded. In that recording (a wake aborted before its model request)
 * Kiro re-injected the workflow report into the prompted turn; a cancel
 * after the model request cleared it instead (kiro-wake-cancel-wire.jsonl).
 * A prompt sent at the wake's first chunk, after its model request, also
 * ended the wake and got the report (kiro-wake-send-late-wire.jsonl).
 * If the turn that announced the prompt ends without prompting,
 * or Kiro rejects the prompt, a wake that lost nothing is restored and
 * shown; one that lost frames is stopped. A turn
 * nobody claims, or whose consumer goes away, is cancelled and its frames
 * discarded. If Kiro does not end a turn after `session/cancel`, the
 * consumer's stream is closed at the cancel deadline, and the session is
 * quarantined after a further grace period: without Kiro's own end there is
 * no safe boundary for the next prompt.
 */

export type AcpAgentTurnUpdate = Record<string, any>;

/** Return a consumer to show the turn, or null to leave it unclaimed. */
export type AcpAgentTurnHandler = (sessionId: string) => ((updates: AsyncIterableIterator<AcpAgentTurnUpdate>) => void) | null;

export interface AgentTurnHooks {
    /** Hold the session's turn reservation; returns its release. */
    reserve(sessionId: string): () => void;
    /** Send `session/cancel`. */
    sendCancel(sessionId: string): void;
    cancelPermissionsForSession(sessionId: string): void;
    /** Refuse the session until it is recovered. */
    quarantine(sessionId: string): void;
    /** A turn of ours is about to prompt the session (see AcpClient.announcePrompt). */
    promptPending(sessionId: string): boolean;
    exitedError(): Error;
    cancelTimeoutMs: number;
    /** After the cancel deadline, how long to wait for Kiro's own end. */
    detachedTimeoutMs: number;
}

/** Info-only updates buffer silently; anything else makes the turn visible. */
const SILENT_UPDATES = new Set(['context_usage', 'usage_summary', '__heartbeat__']);

type Item = { update: AcpAgentTurnUpdate } | { done: true };

class Turn {
    private items: Item[] = [];
    private waiter: ((item: Item) => void) | null = null;
    /** null until the turn shows something; then whether a consumer took it. */
    claimed: boolean | null = null;
    /** Frames still reach the consumer (claimed, and its stream not closed). */
    streamOpen = false;
    cancelRequested = false;
    /** A prompt of ours overtook it: never shown, reservation already released. */
    overtaken = false;
    /** While overtaken, a frame that would have shown it was discarded. */
    lostVisible = false;
    readonly timers = new Set<ReturnType<typeof setTimeout>>();

    constructor(public release: () => void) {}

    push(item: Item): void {
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(item);
        } else this.items.push(item);
    }

    get(): Promise<Item> {
        const head = this.items.shift();
        if (head !== undefined) return Promise.resolve(head);
        return new Promise((resolve) => { this.waiter = resolve; });
    }

    clear(): void {
        this.items = [];
    }

    after(ms: number, fn: () => void): void {
        const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
        timer.unref?.();
        this.timers.add(timer);
    }

    clearTimers(): void {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }
}

export type AgentTurnDelivery = 'delivered' | 'dropped' | 'none';

export class AcpAgentTurns {
    private readonly turns = new Map<string, Turn>();
    private handler: AcpAgentTurnHandler | null = null;

    constructor(private readonly hooks: AgentTurnHooks) {}

    setHandler(handler: AcpAgentTurnHandler | null): void {
        this.handler = handler;
    }

    has(sessionId: string): boolean {
        return this.turns.has(sessionId);
    }

    /** Kiro started a turn on its own. */
    start(sessionId: string): void {
        if (this.turns.has(sessionId)) return;
        this.turns.set(sessionId, new Turn(this.hooks.reserve(sessionId)));
    }

    /**
     * Route a frame of the open turn. `none`: no turn is open (the caller
     * routes it as usual); `dropped`: discarded (a permission request must
     * then be cancelled by the caller).
     */
    deliver(sessionId: string, update: AcpAgentTurnUpdate): AgentTurnDelivery {
        const turn = this.turns.get(sessionId);
        if (!turn) return 'none';
        if (turn.claimed === false) {
            const kind = update.update?.sessionUpdate ?? update.sessionUpdate;
            if (turn.overtaken && !SILENT_UPDATES.has(kind)) turn.lostVisible = true;
            return 'dropped';
        }
        if (turn.claimed === null) {
            const kind = update.update?.sessionUpdate ?? update.sessionUpdate;
            if (SILENT_UPDATES.has(kind)) {
                turn.push({ update });
                return 'delivered';
            }
            this.claim(sessionId, turn);
        }
        if (!turn.streamOpen) {
            // The frame that would have shown it is gone: it cannot be shown whole.
            if (turn.overtaken) turn.lostVisible = true;
            return 'dropped';
        }
        turn.push({ update });
        return 'delivered';
    }

    /**
     * A prompt of ours is coming. A turn that has shown nothing yet gives
     * way: it is never shown, its reservation is released so the prompt
     * goes out at once, and its remaining frames are discarded until Kiro
     * ends it (Kiro does when the prompt arrives) or the prompt's own turn
     * starts. A turn already shown keeps running; the chat holds new
     * messages back while it does.
     */
    overtake(sessionId: string): void {
        const turn = this.turns.get(sessionId);
        if (turn && turn.claimed === null) this.giveWay(turn);
    }

    /** The overtaken turn open now, if any (an opaque handle for endOvertaken). */
    overtakenTurn(sessionId: string): object | undefined {
        const turn = this.turns.get(sessionId);
        return turn?.overtaken ? turn : undefined;
    }

    /**
     * The prompt that overtook a turn has its own turn now (or has ended):
     * the overtaken turn is over, even if Kiro never reported its end. With
     * `which`, only that turn is ended.
     */
    endOvertaken(sessionId: string, which?: object): void {
        const turn = this.turns.get(sessionId);
        if (!turn?.overtaken || (which !== undefined && which !== turn)) return;
        this.finish(sessionId, turn, { stopReason: 'cancelled' });
    }

    /**
     * The prompt it gave way to never went out, or Kiro refused it. A turn
     * that lost nothing while it gave way is restored (it reserves the
     * session again and is shown on its next visible frame), so its report
     * is not lost. One whose frames were already discarded is stopped: it
     * cannot be shown whole, and must not run unseen.
     */
    abandonOvertaken(sessionId: string, which?: object): void {
        const turn = this.turns.get(sessionId);
        if (!turn?.overtaken || (which !== undefined && which !== turn)) return;
        if (turn.lostVisible || turn.cancelRequested) {
            this.cancel(sessionId);
            return;
        }
        turn.overtaken = false;
        turn.claimed = null;
        turn.release = this.hooks.reserve(sessionId);
    }

    /** Kiro reported the turn's end. */
    end(sessionId: string, stopReason: string): void {
        const turn = this.turns.get(sessionId);
        if (turn) this.finish(sessionId, turn, { stopReason });
    }

    /** End the turn here (session released or quarantined). */
    close(sessionId: string, stopReason: string): void {
        this.end(sessionId, stopReason);
    }

    /** The process exited: every open turn fails. */
    exited(): void {
        for (const [sessionId, turn] of [...this.turns]) this.finish(sessionId, turn, { exited: true });
    }

    /** Stop the turn (the user's Stop, or nobody shows it). */
    cancel(sessionId: string): boolean {
        const turn = this.turns.get(sessionId);
        if (!turn) return false;
        this.hooks.cancelPermissionsForSession(sessionId);
        if (turn.cancelRequested) return true;
        turn.cancelRequested = true;
        this.hooks.sendCancel(sessionId);
        turn.after(this.hooks.cancelTimeoutMs, () => {
            if (this.turns.get(sessionId) !== turn) return;
            // Kiro has not ended it: close what the user sees now, discard
            // what follows, and give Kiro a last chance to end it cleanly.
            this.closeStream(turn, { sessionUpdate: 'turn_end', stopReason: 'cancelled' });
            this.hooks.cancelPermissionsForSession(sessionId);
            turn.after(this.hooks.detachedTimeoutMs, () => {
                if (this.turns.get(sessionId) !== turn) return;
                this.hooks.quarantine(sessionId);
                this.finish(sessionId, turn, { stopReason: 'cancelled' });
            });
        });
        return true;
    }

    /** The consumer stopped reading before the turn ended. */
    release(sessionId: string): void {
        const turn = this.turns.get(sessionId);
        if (!turn) return;
        turn.streamOpen = false;
        turn.clear();
        this.cancel(sessionId);
    }

    private giveWay(turn: Turn): void {
        turn.claimed = false;
        turn.overtaken = true;
        turn.clear();
        turn.release();
    }

    private claim(sessionId: string, turn: Turn): void {
        // A turn of ours is on its way: showing this one now would queue it
        // behind that turn while that turn's prompt waits for this one.
        if (this.hooks.promptPending(sessionId)) {
            this.giveWay(turn);
            return;
        }
        const consume = this.handler?.(sessionId) ?? null;
        if (!consume) {
            turn.claimed = false;
            turn.clear();
            // Nobody shows it, so do not let it run (and hold the session).
            this.cancel(sessionId);
            return;
        }
        turn.claimed = true;
        turn.streamOpen = true;
        const exitedError = () => this.hooks.exitedError();
        consume((async function* (): AsyncIterableIterator<AcpAgentTurnUpdate> {
            while (true) {
                const item = await turn.get();
                if ('done' in item) throw exitedError();
                const update = item.update.update || item.update;
                yield update;
                if (update?.sessionUpdate === 'turn_end') return;
            }
        })());
    }

    private closeStream(turn: Turn, last: AcpAgentTurnUpdate | null): void {
        if (!turn.streamOpen) return;
        turn.streamOpen = false;
        turn.push(last ? { update: last } : { done: true });
    }

    private finish(sessionId: string, turn: Turn, outcome: { stopReason: string } | { exited: true }): void {
        if (this.turns.get(sessionId) !== turn) return;
        this.turns.delete(sessionId);
        turn.clearTimers();
        this.closeStream(turn, 'exited' in outcome ? null : { sessionUpdate: 'turn_end', stopReason: outcome.stopReason });
        turn.release();
    }
}
