import type { RuntimeHost } from 'michi-runtime';
import { createMichiRuntimeHost } from '../../src/agents/michiRuntimeHost';

/**
 * The host a test hands to a runtime it constructs directly: Michi's own
 * ports, as server.ts passes them to every runtime factory. Each call
 * returns a new host; its ports call Michi's modules, so test stubs of those
 * modules still apply.
 */
export function michiTestHost(): RuntimeHost {
  return createMichiRuntimeHost();
}
