import type { ChatPermissionMode } from 'michi-shared';
import type { RuntimeOwnerMode, RuntimeToolProfile } from '../../contract/types';
import type { ClaudeAdapterOptions } from './claudeAdapterOptions';

/**
 * How a Claude session enforces the host's restricted profile
 * (SessionProfilePort.isRestricted): a restricted session may call only the
 * host's own tools, whatever its permission mode.
 */

export interface ClaudeSpawnPolicy {
  permissionMode: 'default' | 'bypassPermissions';
  /** Built-in tools the session has (`--tools`); undefined keeps the CLI default. */
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  strictMcpConfig?: boolean;
  /** Load none of the user's, project's or local settings. */
  isolateSettings?: boolean;
  /** The CLI's `--restricted`. */
  restrictedMode?: boolean;
}

export interface ClaudeSpawnPolicyInput {
  /** Interactive for a chat, headless for an Agent Run. */
  ownerMode: RuntimeOwnerMode;
  permissionMode: ChatPermissionMode | undefined;
  toolProfile: RuntimeToolProfile | null | undefined;
}

/**
 * Every Claude built-in tool as a deny rule, backing up `--tools ""` for a
 * CLI that ignores it.
 */
export const CLAUDE_RESTRICTED_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  'Bash', 'BashOutput', 'KillShell', 'PowerShell', 'REPL', 'Monitor', 'Sleep',
  'Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead',
  'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'WebBrowser', 'RemoteTrigger', 'PushNotification',
  'Task', 'Agent', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
  'TodoWrite', 'ListAgents', 'SendMessage', 'SendUserMessage', 'TeamCreate', 'TeamDelete',
  'Workflow', 'ReportFindings', 'Brief', 'StructuredOutput',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'Config',
  'Skill', 'SlashCommand', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
]);

/**
 * The CLI flags a Claude session spawns with. `restricted` is the host's
 * verdict on the session's tool profile: a restricted session runs without
 * built-in tools, settings or other MCP servers and never bypasses
 * permissions. An unrestricted chat bypasses only in YOLO mode, and a
 * session restricted by a tool profile never does.
 */
export function claudeSpawnPolicy(
  restricted: boolean,
  { ownerMode: mode, permissionMode, toolProfile }: ClaudeSpawnPolicyInput,
): ClaudeSpawnPolicy {
  return restricted
    ? {
      permissionMode: 'default',
      tools: [],
      disallowedTools: CLAUDE_RESTRICTED_DISALLOWED_TOOLS,
      strictMcpConfig: true,
      isolateSettings: true,
      restrictedMode: true,
    }
    : { permissionMode: mode === 'interactive' && (!toolProfile || (toolProfile.assistant === true && !toolProfile.allowedToolNames)) && permissionMode === 'yolo' ? 'bypassPermissions' : 'default' };
}

/**
 * The host's verdict on a tool call of a restricted session
 * (ClaudeAdapterOptions.restrictedToolApproval); deny when it gives none.
 */
export function restrictedToolApproval(
  options: Pick<ClaudeAdapterOptions, 'restrictedToolApproval'>,
  hostToolName: string | null,
): 'allow' | 'deny' {
  return options.restrictedToolApproval?.(hostToolName) ?? 'deny';
}
