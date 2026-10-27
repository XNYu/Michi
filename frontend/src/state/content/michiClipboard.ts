/** Copy Michi text (resume commands, handoff notes). Throws when the clipboard is unavailable. */
export async function copyMichiText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard is unavailable');
  }
  await navigator.clipboard.writeText(text);
}
