// The Claude Agent SDK as this package's optional peer: the version it names
// and the error a host without it gets. Kept apart from claudeSdkTransport,
// which uses the SDK's types, so that the declarations of ./adapters/claude
// reach none of them.

/** The Claude Agent SDK version this package names as its optional peer (package.json peerDependencies). */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.306';

/** The host has not installed the Claude Agent SDK, an optional peer dependency of this package. */
export class ClaudeSdkMissingError extends Error {
  constructor(cause: unknown) {
    const sdk = `@anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}`;
    super(`The Claude adapter needs ${sdk}, an optional peer dependency of michi-runtime, and cannot `
      + `find it: it is not installed, or its install is incomplete. Install it beside michi-runtime: `
      + `npm install ${sdk}`, { cause });
    this.name = 'ClaudeSdkMissingError';
  }
}
