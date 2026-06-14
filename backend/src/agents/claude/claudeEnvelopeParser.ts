export type ClaudeEnvelope = Record<string, unknown>;

export function createClaudeEnvelopeParser(
  onEnvelope: (e: ClaudeEnvelope) => void,
  onError?: (err: Error, raw: string) => void,
) {
  let buf = '';

  return {
    push(chunk: string): void {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          onEnvelope(JSON.parse(line) as ClaudeEnvelope);
        } catch (err) {
          onError?.(err as Error, line);
        }
      }
    },

    flush(): void {
      const tail = buf.trim();
      buf = '';
      if (!tail) return;
      try {
        onEnvelope(JSON.parse(tail) as ClaudeEnvelope);
      } catch (err) {
        onError?.(err as Error, tail);
      }
    },
  };
}
