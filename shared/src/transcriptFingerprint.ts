export interface TranscriptFingerprintMessage {
  role: 'user' | 'assistant';
  content: string;
}

const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

/** Fold strings using the historical JS UTF-16 code-unit FNV-1a algorithm. */
export function foldFingerprintSegments(
  segments: Iterable<string>,
  initialState = FNV1A_32_OFFSET,
): number {
  let hash = initialState >>> 0;
  for (const segment of segments) {
    for (let index = 0; index < segment.length; index += 1) {
      hash ^= segment.charCodeAt(index);
      hash = Math.imul(hash, FNV1A_32_PRIME) >>> 0;
    }
  }
  return hash;
}

/** Compute the persisted resume fingerprint without building one giant payload. */
export function computeTranscriptFingerprint(
  messages: readonly TranscriptFingerprintMessage[],
): string {
  function* segments(): IterableIterator<string> {
    for (const message of messages) {
      yield message.role;
      yield '\u0000';
      yield message.content;
      yield '\u0000\u0000';
    }
  }

  return foldFingerprintSegments(segments()).toString(16).padStart(8, '0');
}
