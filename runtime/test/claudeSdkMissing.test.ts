import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeSdkMissingError } from '../src/adapters/claude/index';
import { CLAUDE_AGENT_SDK_VERSION } from '../src/adapters/claude/claudeSdkPeer';
import { loadClaudeSdk } from '../src/adapters/claude/claudeSdkTransport';

const SDK = '@anthropic-ai/claude-agent-sdk';
type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const modules = Module as unknown as { _resolveFilename: ResolveFilename };

/** Runs `body` while require.resolve fails for `request` with `error`, as it does for a package not installed. */
function withUnresolvable<T>(request: string, error: Error, body: () => T): T {
  const original = modules._resolveFilename;
  modules._resolveFilename = function (this: unknown, wanted: string, ...rest: unknown[]) {
    if (wanted === request) throw error;
    return original.call(this, wanted, ...rest);
  };
  try {
    return body();
  } finally {
    modules._resolveFilename = original;
  }
}

function notFound(request: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
}

test('a host without the Claude Agent SDK gets the public ClaudeSdkMissingError naming the optional peer', () => {
  const cause = notFound(SDK);
  assert.throws(() => withUnresolvable(SDK, cause, () => loadClaudeSdk()), (error: unknown) => {
    assert.ok(error instanceof ClaudeSdkMissingError);
    assert.equal(error.name, 'ClaudeSdkMissingError');
    assert.match(error.message, /needs @anthropic-ai\/claude-agent-sdk@0\.3\.306, an optional peer dependency of michi-runtime/);
    assert.match(error.message, /npm install @anthropic-ai\/claude-agent-sdk@0\.3\.306$/);
    assert.equal(error.cause, cause);
    return true;
  });
});

test('other failures to resolve the SDK are not reported as a missing SDK', () => {
  const failure = Object.assign(new Error('No "exports" main defined'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.throws(() => withUnresolvable(SDK, failure, () => loadClaudeSdk()), (error: unknown) => error === failure);
});

test('an installed SDK still loads after a failed attempt', async () => {
  assert.throws(() => withUnresolvable(SDK, notFound(SDK), () => loadClaudeSdk()), ClaudeSdkMissingError);
  const sdk = await loadClaudeSdk();
  assert.equal(typeof sdk.query, 'function');
});

test('the SDK version the error names is the one package.json pins', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(manifest.peerDependencies['@anthropic-ai/claude-agent-sdk'], CLAUDE_AGENT_SDK_VERSION,
    'bump CLAUDE_AGENT_SDK_VERSION in src/adapters/claude/claudeSdkPeer.ts together with the peer');
  assert.equal(manifest.devDependencies['@anthropic-ai/claude-agent-sdk'], CLAUDE_AGENT_SDK_VERSION);
});
