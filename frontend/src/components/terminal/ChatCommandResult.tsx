import type { ChatNodeState } from '../../state/chatTypes';

/** Session controls have visible results, but do not create model turns. */
export function ChatCommandResult({ result }: { result: NonNullable<ChatNodeState['commandResult']> }) {
  return (
    <details key={`${result.command}:${result.status}`} open className="rounded border border-line bg-surface text-fg" aria-busy={result.status === 'running'}>
      <summary className="cursor-pointer px-3 py-2 text-xs select-none">
        /{result.command}{result.status === 'running' ? ' · Running' : result.status === 'error' ? ' · Failed' : ''}
      </summary>
      <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 text-xs">{result.message}</pre>
    </details>
  );
}
