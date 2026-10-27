import type { AgentReasoning, CapabilityDescriptor } from 'michi-shared';

// The harness's wire types, which a host names when it writes a descriptor or an override.
export type { CapabilityDescriptor, CapabilityKey, CapabilitySlot, CapabilityAvailability } from 'michi-shared';

// One description of what a runtime can do and how it behaves, owned by the
// adapter. Hosts read it instead of branching on runtime ids. It is computed
// per runtime instance, because one adapter can behave differently by
// configuration (Kiro's v2 engine, v3 locally and v3 in the cloud).
//
// The harness of an instance can change as it negotiates with its agent
// (Kiro v3 reports compaction, fork and steering per negotiated client), so
// hosts read it each time they use it and do not cache it. Topology and run
// are fixed for an instance.

/** When a session's native identity (resume token) becomes known. */
export type RuntimeIdentityTiming =
  /** Opening the session returns it; the host commits it with the binding. */
  | 'on-open'
  /** The first turn reports it before any other event of that turn. */
  | 'on-first-turn'
  /** The session has no native identity apart from the host's own id. */
  | 'none';

/** What `cancel()` establishes. */
export type RuntimeCancel =
  /**
   * The agent itself acknowledges the interrupt; the session stays usable.
   * The session may still restart its own process when it cannot confirm
   * the stop (Claude, when the SDK interrupt and terminal result do not
   * both arrive); the host does not rebuild the session.
   */
  | 'native-ack'
  /** A stop request is dispatched without an agent ack; the session is kept. */
  | 'inferred-keep-session'
  /** Cancelling ends the agent process; the next turn starts a new one. */
  | 'process-restart';

/** How the host's own tools reach the agent. */
export type RuntimeToolDelivery =
  /** One MCP HTTP endpoint per session. */
  | 'mcp-http'
  /** One MCP HTTP endpoint shared by a group of sessions, which name themselves per call. */
  | 'mcp-http-grouped'
  /** A relay on the agent's side forwards tool calls to the session's MCP endpoint. */
  | 'mcp-relay'
  /** Tools are called inside the host process. */
  | 'in-process';

/** How a session the host opens fresh, without native resume, gets the earlier conversation. */
export type RuntimeHistoryReplay =
  /** As structured chat messages (`replayHistory`). */
  | 'messages'
  /** As text context the host puts ahead of the first prompt. */
  | 'preamble';

/**
 * Where a conversation title comes from besides the host's own channels:
 * its title tool and the `[TITLE: …]` first line its preamble asks the agent
 * for. Those do not depend on the runtime, so `'none'` does not mean untitled.
 */
export type RuntimeTitleSource =
  /** `generateTitle()` on a separate cheap-model session. */
  | 'sidecar'
  /** The native agent reports a title update, forwarded as a `title` event. */
  | 'native-update'
  /** The adapter generates a title during the first turn and emits a `title` event. */
  | 'in-stream'
  /** No title mechanism of the runtime's own. */
  | 'none';

export interface RuntimeTopology {
  readonly identityTiming: RuntimeIdentityTiming;
  readonly cancel: RuntimeCancel;
  /** Every path in use; empty when the host supplied no tool endpoint. */
  readonly toolDelivery: readonly RuntimeToolDelivery[];
  readonly historyReplay: RuntimeHistoryReplay;
  /** The runtime starts turns of its own that the host must consume. */
  readonly backgroundTurns: boolean;
  readonly titles: RuntimeTitleSource;
  /**
   * The host generates titles for this runtime's chats beside a turn only for
   * users who opted in (Kiro: its sidecar title session). Default: no opt-in.
   */
  readonly hostTitleRequiresOptIn?: true;
  /**
   * The runtime has workflows, a feature each user turns on: hosts list it
   * among the runtimes with a workflows setting (Kiro v3). Default: none.
   */
  readonly workflowsRequireOptIn?: true;
  /** `/clear` replaces the native session (new identity) instead of clearing it in place. Default false. */
  readonly clearCreatesNewNativeSession?: boolean;
}

/**
 * Durable Agent Run behavior of a runtime. The capabilities a Run needs
 * (models, reasoning, native resume) are not repeated here: hosts check them
 * on `AgentRuntime.capabilities`.
 */
export interface RuntimeRunFacet {
  /**
   * `allowlist`: only the host's listed tools may run. `runtime_default`:
   * the runtime's native tools plus the host's injected ones.
   */
  readonly toolMode: 'allowlist' | 'runtime_default';
  /**
   * How supplemental input reaches a running turn: same-turn steering,
   * held for a new turn, or not at all.
   */
  readonly steering: 'native' | 'next_turn' | 'none';
  /** Native steering needs a live prompt, so immediate input after an interrupt uses a new turn. */
  readonly immediateSteering?: 'next_turn';
  /** A persisted native token can resume the session. */
  readonly supportsNativeResume: boolean;
}

export interface RuntimeDescriptor {
  readonly spec: 1;
  /** The capability slots the frontend shows, unchanged on the wire. */
  readonly harness: CapabilityDescriptor;
  readonly topology: RuntimeTopology;
  /** `null` declares that the runtime does not run Agent Runs. */
  readonly run: RuntimeRunFacet | null;
  readonly defaults?: { readonly model?: string; readonly reasoning?: AgentReasoning };
}
