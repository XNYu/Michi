import type { AgentCommand, PermissionOption, PlanEntry, SpawnBranchTopic, SubagentInfo } from "michi-shared";

export type { AgentCommand, PermissionOption, PlanEntry, SpawnBranchTopic, SubagentInfo } from "michi-shared";

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
    | { kind: "context_saved"; name: string; filePath: string; size?: number }
    | { kind: "context_updated"; name: string; filePath: string; size?: number }
    | { kind: "image"; path: string; caption?: string; mimeType: string; size: number }
    | { kind: "permission_request"; requestId: number; toolCallId?: string; title: string; detail?: string; options: PermissionOption[] }
    | { kind: "subagent_list_update"; subagents: SubagentInfo[] }
    | { kind: "subagent_tool_activity"; subagentSessionId: string; title: string; status: string }
    | { kind: "context_usage"; contextUsagePercentage: number }
    | { kind: "usage_summary"; contextUsagePercentage: number; totalCredits: number; turnDurationMs: number }
    | { kind: "mcp_server_error"; serverName: string; error: string }
    | { kind: "turn_end"; stopReason?: string };
