/**
 * Global digest-prompt trigger. Any call site fires `requestDigest(projectId, sources)`
 * which emits a custom event. The DigestPromptDialog (mounted in App)
 * listens, shows the modal, and calls `createDigest` on confirm.
 */
export function requestDigest(projectId: string, sourceIds: string[]) {
  window.dispatchEvent(
    new CustomEvent('michi:digest-prompt', {
      detail: { projectId, sourceIds },
    }),
  );
}
