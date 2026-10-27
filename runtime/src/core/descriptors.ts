import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type { RuntimeDescriptor } from '../contract/descriptor';

/** Capability slots of a runtime that declares none: forks fall back to the host's own branch copy. */
export const UNKNOWN_HARNESS: CapabilityDescriptor = {
  steer: invisibleSlot(),
  followUp: invisibleSlot(),
  interruptAck: invisibleSlot(),
  compact: invisibleSlot(),
  retry: invisibleSlot(),
  sessionFork: slot('michi_simulated', 'projected'),
  nativeResume: invisibleSlot(),
  permissions: invisibleSlot(),
  sandbox: invisibleSlot(),
  subagents: invisibleSlot(),
  usage: invisibleSlot(),
};

/**
 * What a host may assume about a runtime that does not describe itself: no
 * native identity, ack, title or background work, no host tools, and
 * history replayed as preamble text. No Agent Runs.
 */
export const UNKNOWN_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  spec: 1,
  harness: UNKNOWN_HARNESS,
  topology: {
    identityTiming: 'none',
    cancel: 'inferred-keep-session',
    toolDelivery: [],
    historyReplay: 'preamble',
    backgroundTurns: false,
    titles: 'none',
  },
  run: null,
};

/**
 * The instance's descriptor; the unknown descriptor for an untyped runtime
 * that has none. `capabilities` is not consulted: it says nothing about
 * topology.
 */
export function descriptorOf(runtime: { readonly descriptor?: RuntimeDescriptor | null }): RuntimeDescriptor {
  return runtime.descriptor ?? UNKNOWN_RUNTIME_DESCRIPTOR;
}
