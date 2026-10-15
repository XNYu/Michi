import { setTimeout as delay } from 'node:timers/promises';
import type { CrewGateway, CrewPendingApproval } from './gatewayTypes';

/** Poll while this local turn lives; match exact native transcript cards. */
export async function watchCrewApprovals(options: {
    gateway: CrewGateway;
    sessionId: string;
    signal: AbortSignal;
    request: (approval: CrewPendingApproval, signal: AbortSignal) => Promise<boolean>;
    report: (error: unknown) => void;
}): Promise<void> {
    const { gateway, sessionId, signal } = options;
    if (!gateway.pendingApprovals || !gateway.approve) return;
    const pending = new Map<string, AbortController>();
    const handled = new Set<string>();
    const inFlight = new Set<Promise<void>>();
    let pollFailed = false;
    try {
        while (!signal.aborted) {
            let requests;
            try {
                requests = await gateway.pendingApprovals(sessionId);
                pollFailed = false;
            } catch (error) {
                // A transient failure must not strand this or later requests.
                // Report once per outage and keep the watcher alive until abort.
                if (!signal.aborted && !pollFailed) options.report(error);
                pollFailed = true;
                await delay(1000, undefined, { signal });
                continue;
            }
            if (signal.aborted) break;
            const live = new Set(requests.map((request) => request.request_mid));
            for (const id of handled) if (!live.has(id)) handled.delete(id);
            for (const [id, controller] of pending) if (!live.has(id)) { controller.abort(); pending.delete(id); }
            for (const approval of requests) {
                if (handled.has(approval.request_mid) || pending.size >= 64) continue;
                handled.add(approval.request_mid);
                const controller = new AbortController();
                pending.set(approval.request_mid, controller);
                const work = options.request(approval, controller.signal).then(async (allow) => {
                    if (!signal.aborted && !controller.signal.aborted) await gateway.approve!(sessionId, approval, allow, controller.signal);
                }).catch((error) => {
                    if (!signal.aborted && !controller.signal.aborted) {
                        options.report(error);
                        // Retry only if the exact request is still pending in
                        // the next authoritative snapshot, never another turn.
                        handled.delete(approval.request_mid);
                    }
                }).finally(() => { pending.delete(approval.request_mid); inFlight.delete(work); });
                inFlight.add(work);
            }
            await delay(400, undefined, { signal });
        }
    } catch (error) {
        if (!signal.aborted) options.report(error);
    } finally {
        for (const controller of pending.values()) controller.abort();
        await Promise.allSettled(inFlight);
    }
}
