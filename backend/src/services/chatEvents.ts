import type { AgentCommand, PermissionOption, PlanEntry, SpawnBranchTopic, SubagentInfo, UserInputAnswer, UserInputQuestion } from "michi-shared";

export type { AgentCommand, PermissionOption, PlanEntry, SpawnBranchTopic, SubagentInfo, UserInputAnswer, UserInputQuestion } from "michi-shared";

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
    | { kind: "spawn_branches"; topics: SpawnBranchTopic[] }
    | { kind: "title"; title: string }
    | { kind: "branch_overview"; overview: string }
    | { kind: "follow_ups"; followUps: string[] }
    | { kind: "follow_ups_status"; status: "in_progress" | "completed" | "failed" }
    | { kind: "commands"; commands: AgentCommand[] }
    | { kind: "artifact_saved"; contextId?: string; name: string; filePath: string; size?: number }
    | { kind: "artifact_updated"; contextId?: string; name: string; filePath: string; size?: number }
    | { kind: "image"; path: string; caption?: string; mimeType: string; size: number }
    | { kind: "permission_request"; requestId: number; toolCallId?: string; title: string; detail?: string; options: PermissionOption[]; source?: string }
    | { kind: "user_input_request"; requestId: number; questions: UserInputQuestion[] }
    | { kind: "user_input_resolved"; requestId: number; answers: UserInputAnswer[] }
    | { kind: "subagent_list_update"; subagents: SubagentInfo[] }
    | { kind: "subagent_tool_activity"; subagentSessionId: string; title: string; status: string }
    | { kind: "context_usage"; contextUsagePercentage: number }
    | { kind: "usage_summary"; contextUsagePercentage: number; totalCredits: number; turnDurationMs: number; source?: string }
    | { kind: "cancel_phase"; phase: "requested" | "acknowledged" | "settled" }
    | { kind: "queue_update"; steering: string[]; followUp: string[] }
    | { kind: "steer_accepted"; text: string; pending?: boolean }
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
    | { kind: "mcp_server_error"; serverName: string; error: string }
    | { kind: "runtime_error"; error: string }
    | { kind: "turn_end"; stopReason?: string };
