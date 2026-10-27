import type { RuntimeHost } from '../contract/host';
import type { RuntimeToolProfile } from '../contract/types';
type Violation = { runtimeId: string; toolset: string; unexpectedTools: string[]; detail?: string };
export function guardError(host: RuntimeHost, violation: Violation): Error {
  return host.profile.guardError?.(violation) ?? new Error(`Restricted tool catalog check failed on ${violation.runtimeId}: ${violation.unexpectedTools.join(', ')} ${violation.detail ?? ''}`);
}
export function catalogUnavailable(host: RuntimeHost, runtimeId: string, toolset: string, detail: string): Error {
  return host.profile.catalogUnavailable?.(runtimeId, toolset, detail) ?? guardError(host, { runtimeId, toolset, unexpectedTools: [], detail });
}
export function assertToolCatalog(host: RuntimeHost, input: { runtimeId: string; profile: RuntimeToolProfile | null | undefined; observed: readonly string[]; extraAllowed?: readonly string[] }): void {
  if (host.profile.assertToolCatalog && host.profile.toolset?.(input.profile)) return host.profile.assertToolCatalog(input);
  const allowed = new Set([...(input.profile?.allowedToolNames ?? []), ...(input.extraAllowed ?? [])]);
  const unexpectedTools = input.observed.filter(name => !allowed.has(name));
  if (unexpectedTools.length) throw guardError(host, { runtimeId: input.runtimeId, toolset: 'restricted', unexpectedTools });
}
