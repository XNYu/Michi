import type { UsageCharge, RuntimeWarning, AgentSessionState } from 'michi-shared';
import type { AgentCommand, PermissionOption, PlanEntry, SubagentActivityPayload, SubagentPatch, UserInputAnswer, UserInputQuestion } from "michi-shared";
import type { SteeringReport } from 'michi-shared';

export type { AgentCommand, PermissionOption, PlanEntry, SubagentActivityPayload, SubagentInfo, SubagentPatch, UserInputAnswer, UserInputQuestion } from "michi-shared";
// The types the events' payloads name.
export type {
    UsageCharge, RuntimeWarning, SteeringReport, UserInputOption, SubagentActivity, SubagentActivityKind, SubagentOutcome,
    SubagentSource, SubagentStatus, SubagentUsage,
} from 'michi-shared';

/** Coarse category of a runtime failure. Hosts map it onto their own error vocabulary. */
export type RuntimeErrorCategory = 'auth' | 'incompatible' | 'capacity' | 'transient' | 'terminal';

export type NormalizedEvent =
    | { kind: "chunk"; text: string }
    | { kind: "thought"; text: string }
    | { kind: "plan"; entries: PlanEntry[] }
    | {
          kind: "tool_call" | "tool_call_update";
          toolCallId: string;
          title: string;
          status: string;
          kindType?: string;
          detail?: string;
          inputJson?: string;
          output?: string;
      }
    | { kind: "heartbeat"; idleMs: number }
    | { kind: "title"; title: string }
    | { kind: "session_state"; state: AgentSessionState }
    | { kind: "commands"; commands: AgentCommand[] }
    | { kind: "permission_resolved"; requestId: number }
    | { kind: "permission_request"; requestId: number; toolCallId?: string; title: string; detail?: string; options: PermissionOption[]; source?: string }
    | { kind: "user_input_request"; requestId: number; interactionId?: string; questions: UserInputQuestion[] }
    | { kind: "user_input_resolved"; requestId: number; interactionId?: string; answers: UserInputAnswer[]; outcome?: "answered" | "skipped" }
    /** Patch semantics: entries merge onto the roster by sessionId. */
    | { kind: "subagent_list_update"; subagents: SubagentPatch[] }
    | ({ kind: "subagent_tool_activity" } & SubagentActivityPayload)
    | { kind: "context_usage"; contextUsagePercentage: number }
    | {
          kind: "usage_summary";
          contextUsagePercentage?: number;
          totalCredits?: number;
          charge?: UsageCharge;
          turnDurationMs?: number;
          source?: string;
          totalTokens?: number;
          inputTokens?: number;
          cachedInputTokens?: number;
          outputTokens?: number;
          reasoningOutputTokens?: number;
      }
    | { kind: "cancel_phase"; phase: "requested" | "acknowledged" | "settled" }
    | { kind: "queue_update"; steering: string[]; followUp: string[] }
    | { kind: "steer_accepted"; text: string; pending?: boolean }
    | { kind: "steering_report"; reports: SteeringReport[] }
    | { kind: "compaction_start"; detail?: string }
    | { kind: "compaction_end"; detail?: string }
    | { kind: "retry_start"; detail?: string }
    | { kind: "retry_end"; detail?: string }
    | {
          kind: "harness_lifecycle";
          level: "run" | "turn" | "item";
          phase: "start" | "delta" | "completed" | "failed" | "cancelled";
          nativeType?: string;
      }
    | ({ kind: "warning" } & RuntimeWarning)
    | { kind: "mcp_server_error"; serverName: string; error: string }
    /**
     * An event the host's own tools report through the session. `type` and
     * `payload` belong to the host: the runtime forwards them unchanged and
     * never reads them.
     */
    | { kind: "host_event"; type: string; payload: unknown }
    /**
     * `code` is the runtime's own name for the failure, when it has one. It is
     * opaque to the package: each host reads it in its own vocabulary and
     * ignores values it does not know.
     * `category` is the package's coarse category of the failure; the headless
     * driver takes it when present and otherwise infers one from the message.
     * `retryable` says whether the same work may succeed if run again; hosts
     * use it instead of reading `error`. None of them says anything about
     * whether the turn's output was saved.
     */
    | { kind: "runtime_error"; error: string; recoveryRequired?: boolean; code?: string; category?: RuntimeErrorCategory; retryable?: boolean }
    | { kind: "turn_end"; stopReason?: string };
