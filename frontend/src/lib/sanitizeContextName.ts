/**
 * Renderer-side sanitizer for context names. Output rules: keep
 * Unicode letters/numbers (\p{L}\p{N}), underscore, and hyphen; replace
 * any other char (run) with a single "-", trim leading/trailing dashes,
 * fall back to "context" if the result is empty, dedup against existing
 * names (case-insensitive) with "-2", "-3" suffixes.
 *
 * Note: this intentionally diverges from the server-side sanitizer in
 * importWorkspaceFile, which replaces disallowed chars with "_" and does
 * not collapse runs. We use "-" for display-friendly reference names; the
 * server's stricter rule still applies to embedded files written under
 * .contexts/.
 */
export function sanitizeContextName(rawName: string, existing: string[]): string {
  const stem = rawName.replace(/\.[^./\\]+$/, '');
  let cleaned = stem
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (cleaned.length === 0) cleaned = 'context';

  const lower = new Set(existing.map((n) => n.toLowerCase()));
  if (!lower.has(cleaned.toLowerCase())) return cleaned;

  let suffix = 2;
  while (lower.has(`${cleaned}-${suffix}`.toLowerCase())) suffix++;
  return `${cleaned}-${suffix}`;
}
