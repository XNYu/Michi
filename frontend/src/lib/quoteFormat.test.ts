import { formatQuotedMessage, QuoteSource } from './quoteFormat';

const CONTEXT =
  'Context: The user selected the passage below from the previous assistant reply. Treat it as source context, not as text authored by the user.';

describe('formatQuotedMessage with artifact source', () => {
  const source: QuoteSource = {
    type: 'artifact',
    name: 'API Spec',
    filePath: 'docs/api-spec.md',
  };

  test('omits name gracefully when not provided', () => {
    const noName: QuoteSource = { type: 'artifact', filePath: 'src/index.ts' };
    const result = formatQuotedMessage('line 1', 'what is this?', noName);
    expect(result).toContain('from an artifact document at `src/index.ts`');
    expect(result).toContain('The full document is available at `src/index.ts`');
  });

  test('empty prompt with artifact source returns context only', () => {
    const result = formatQuotedMessage('hello', '', source);
    expect(result).toContain('from artifact "API Spec"');
    expect(result).toContain('The full document is available at `docs/api-spec.md`');
    expect(result).not.toContain("User's branch question:");
  });
});

test('file quotes and branch prompts identify the previously read version', () => {
  const snapshot = { hashKind: 'sha256-text-utf8' as const, contentHash: 'abc123', backendConnectionId: 'local', projectId: 'p', treeId: 't', resolvedFilePath: '/actual/spec.md' };
  const result = formatQuotedMessage('old selected text', 'change it', { type: 'artifact', filePath: 'spec.md', snapshot });
  expect(result).toContain('sha256-text-utf8 abc123');
  expect(result).toContain('line numbers belong to this already-read version');
  expect(result).toContain('current file may differ');
  expect(result).toContain('does not provide the old full file');
  expect(result).toContain('`/actual/spec.md`');
});
