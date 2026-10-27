/** Adapt the pre-existing fake-process fixtures at the SDK boundary. This is
 * test-only: production ClaudeSession never falls back to the JSONL transport.
 * Existing kill/recovery tests default to a failed native interrupt. */
import type { ClaudeSdkTransportOptions, ClaudeSdkTransport } from 'michi-runtime/internal/adapters/claude/claudeSdkTransport';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
const transportModule = require('michi-runtime/internal/adapters/claude/claudeSdkTransport');
transportModule.createClaudeSdkTransport = async (args: ClaudeSdkTransportOptions): Promise<ClaudeSdkTransport> => {
  const child = require('michi-runtime/internal/adapters/claude/claudeBinary').spawnClaude(args);
  let buffer = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    buffer += data;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
      try { if (line.trim() && !closed) args.onMessage(JSON.parse(line)); } catch { /* malformed fixture */ }
    }
  });
  const failure = (error: Error) => { if (!closed) args.onError(error); };
  child.stdout.on('close', () => failure(new Error('Claude output connection closed. Original session retained.')));
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', failure);
  child.stderr.on('data', (text: Buffer) => args.onStderr(text.toString()));
  const query = {
    interrupt: async () => { throw new Error('Simulated failed SDK interrupt; verify process fallback'); },
    setModel: async () => {},
    setPermissionMode: async () => {},
  } as unknown as Query;
  return { child, query, initialized: Promise.resolve({} as any),
    send: message => child.stdin.write(JSON.stringify(message) + '\n', (error: Error | null) => { if (error) failure(error); }),
    close: () => { closed = true; },
  };
};
