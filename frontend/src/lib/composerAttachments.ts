export interface AttachmentRef {
  name: string;
  absPath: string;
}

/**
 * Append a `[Attached files: name — path | ...]` sentinel to the user's
 * outgoing message text. Empty list returns the input unchanged.
 *
 * The agent recognises this sentinel by convention and reads the listed
 * paths via its filesystem tools.
 */
export function appendAttachmentsSentinel(input: string, attachments: readonly AttachmentRef[]): string {
  if (attachments.length === 0) return input;
  const list = attachments.map((a) => `${a.name} — ${a.absPath}`).join(' | ');
  return `${input}\n\n[Attached files: ${list}]`;
}
