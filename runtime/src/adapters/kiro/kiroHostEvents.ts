import type { NormalizedEvent } from '../../contract/events';
import type { AcpUpdate } from '../acp/types';

/** Key of the host event an injected update carries. */
const HOST_EVENT = Symbol('kiro.hostEvent');

/**
 * The session/update that carries a host event (core/hostEventSink) into a
 * Kiro session (AcpClient.injectUpdate), so the session reports it in order
 * with the agent's own updates. An update parsed from the agent's output has
 * no symbol keys, so the agent cannot pass one off as a host event.
 */
export function hostEventUpdate(event: NormalizedEvent): AcpUpdate {
    return { sessionUpdate: 'host_event', [HOST_EVENT]: event };
}

/** The event an update made by hostEventUpdate carries; undefined for any other update. */
export function injectedHostEvent(update: AcpUpdate): NormalizedEvent | undefined {
    return (update as { [HOST_EVENT]?: NormalizedEvent })[HOST_EVENT];
}
