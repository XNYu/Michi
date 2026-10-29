import { getToolApproval, requestToolApproval } from './toolApprovals';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
/** Shared unattended access boundary: Michi state is writable; external MCP
 * calls require a read-only declaration or saved human approval. Native shell/exec and delegation to
 * unconstrained workers are deliberately not an alternative call path. */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpClientManager, type McpToolInfo, type McpServerConfig } from '../mcpClientManager';
import { readPiMcpServers } from '../piMcpConfig';
import { assertMaintenanceAuthority } from '../pages/maintenanceRepository';
import type { MaintenanceExecutionContext } from '../pages/maintenanceWriter';
import { PAGE_TOOL_NAMES } from '../../agents/pageToolNames';

export const MAINTENANCE_ACCESS_TOOL_NAMES = ['maintenance_list_tools', 'maintenance_call_tool'] as const;

// These operations change only Michi-owned state, or read it. Launching or
// messaging workers is external execution, even when initiated by a Michi tool.
const INTERNAL_TOOLS = new Set<string>([
  ...PAGE_TOOL_NAMES, 'michi_docs', 'list_workspaces', 'list_threads', 'search_messages',
  'read_node', 'read_node_overview', 'read_conversation_updates', 'report_conversation_no_change',
  'list_panes', 'inspect_pane', 'read_pane_output', 'wait_pane',
  'save_artifact', 'update_artifact', 'layout_rules',
  'list_agents', 'check_agent', 'wait_agent', 'cancel_agent',
]);

export function isMaintenanceInternalTool(name: string): boolean { return INTERNAL_TOOLS.has(name); }
export function isExternalReadOnlyTool(tool: McpToolInfo): boolean {
  const annotations = tool.annotations as { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined;
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true
    && tool.execution?.taskSupport !== 'required';
}

export interface MaintenanceAccessEntry {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
}
export interface MaintenanceAccessDependencies {
  internalTools(context: MaintenanceExecutionContext): MaintenanceAccessEntry[];
  servers?: () => McpServerConfig[];
  manager?: () => Pick<McpClientManager, 'connect' | 'callTool' | 'dispose'>;
  assertAuthority?: (context: MaintenanceExecutionContext) => void;
}
const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const failure = (error: unknown): CallToolResult => ({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
class UnavailableTool extends Error {}
const validator = new AjvJsonSchemaValidator();
function validateInput(schema: Record<string, unknown>, args: Record<string, unknown>): void {
  const validation = validator.getValidator(schema)(args);
  if (!validation.valid) throw new Error(`Invalid tool arguments: ${validation.errorMessage}`);
}
const textSchema = { type: 'string', minLength: 1, maxLength: 200 };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object' as const, properties, required, additionalProperties: false as const });

export function createMaintenanceAccessTools(
  getContext: () => MaintenanceExecutionContext | null,
  deps: MaintenanceAccessDependencies,
) {
  const check = (expected?: MaintenanceExecutionContext): MaintenanceExecutionContext => {
    const context = getContext();
    if (!context || (expected && (context.runId !== expected.runId || context.planId !== expected.planId
      || context.execution.turnId !== expected.execution.turnId || context.ownerUserId !== expected.ownerUserId))) {
      throw new Error('This maintenance turn no longer owns the tool call');
    }
    if (deps.assertAuthority) deps.assertAuthority(context);
    else assertMaintenanceAuthority(context, Date.now());
    return context;
  };
  const internal = (context: MaintenanceExecutionContext) => deps.internalTools(context).filter(t => isMaintenanceInternalTool(t.name));
  const withServer = async <T>(name: string, context: MaintenanceExecutionContext, signal: AbortSignal | undefined,
    action: (manager: Pick<McpClientManager, 'connect' | 'callTool' | 'dispose'>, tools: McpToolInfo[], config: McpServerConfig) => Promise<T>): Promise<T> => {
    // Do not fall back to a host desktop configuration for a cloud principal.
    if (process.env.MICHI_CLOUD === '1') throw new Error('Background external tools require a local backend');
    const config = (deps.servers ?? readPiMcpServers)().find(s => s.serverName === name);
    if (!config) throw new UnavailableTool('Unknown configured external server. Use maintenance_list_tools to find alternatives.');
    const manager = deps.manager?.() ?? new McpClientManager({ ownerUserId: context.ownerUserId });
    try {
      const { tools } = await manager.connect(config, signal);
      signal?.throwIfAborted();
      check(context);
      return await action(manager, tools, config);
    } finally { await manager.dispose(); }
  };
  const execute = (fn: (args: Record<string, unknown>, context: MaintenanceExecutionContext, signal?: AbortSignal) => Promise<CallToolResult>) =>
    async (args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> => {
      try {
        signal?.throwIfAborted();
        return await fn(args, check(), signal);
      } catch (error) { signal?.throwIfAborted(); return error instanceof UnavailableTool ? result({ status: 'unavailable', message: error.message }) : failure(error); }
    };
  return [
    {
      name: MAINTENANCE_ACCESS_TOOL_NAMES[0],
      description: 'Discover writable Michi tools and external read-only MCP tools. With no server, lists Michi tools and configured external server names. With server, lists tools with their access status. Calling an unapproved tool requests persistent user approval without executing it. Follow nextOffset to read more schemas.',
      parameters: schema({ server: textSchema, offset: { type: 'integer', minimum: 0 } }, []),
      execute: execute(async (args, context, signal) => {
        const offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('offset must be a non-negative integer');
        let entries: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; access?: string }>;
        let servers: string[] | undefined;
        if (typeof args.server === 'string') {
          entries = await withServer(args.server, context, signal, async (_manager, tools, config) => tools.map(tool => ({ ...tool, access: isExternalReadOnlyTool(tool) ? 'read-only' : getToolApproval(config, tool, context.ownerUserId)?.state ?? 'needs-approval' })));
        } else {
          entries = internal(context);
          servers = process.env.MICHI_CLOUD === '1' ? [] : (deps.servers ?? readPiMcpServers)().map(s => s.serverName);
        }
        const page = entries.slice(offset as number, (offset as number) + 10)
          .map(({ name, description, inputSchema, access }) => ({ name, description, inputSchema, access }));
        const end = (offset as number) + page.length;
        return result({ scope: args.server ? 'external' : 'michi', server: args.server, servers, tools: page, nextOffset: end < entries.length ? end : null });
      }),
    },
    {
      name: MAINTENANCE_ACCESS_TOOL_NAMES[1],
      description: 'Call a tool discovered by maintenance_list_tools. Omit server for Michi tools; specify server for external read-only calls. External tools not declared read-only require persistent human approval. When approval is needed, continue with permitted alternatives or tell the user to review Settings → Meta agent → Tool approvals. Do not claim the blocked work completed. Arbitrary code/shell execution and launching unrestricted workers are unavailable. Existing maintenance writers remain the receipt path for source-batch page/database decisions.',
      parameters: schema({ server: textSchema, tool: textSchema, arguments: { type: 'object', additionalProperties: true } }, ['tool', 'arguments']),
      execute: execute(async (args, context, signal) => {
        if (typeof args.tool !== 'string' || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) throw new Error('tool and arguments are required');
        const input = args.arguments as Record<string, unknown>;
        if (typeof args.server === 'string') return withServer(args.server, context, signal, async (manager, tools, config) => {
          const tool = tools.find(t => t.name === args.tool);
          const alternatives = tools.filter(isExternalReadOnlyTool).map(t => t.name);
          if (!tool) return result({ status: 'unavailable', message: 'Tool not found. Try another listed tool.', alternatives });
          if (tool.execution?.taskSupport === 'required') return result({ status: 'unavailable', message: 'This tool requires unsupported task execution. Try another tool.', alternatives });
          if (!isExternalReadOnlyTool(tool) && getToolApproval(config, tool, context.ownerUserId)?.state !== 'approved') {
            const request = requestToolApproval(config, tool, context.ownerUserId);
            if (!request) return result({ status: 'unavailable', message: 'The saved tool approval limit has been reached. Try permitted alternatives and tell the user this tool was not executed.', alternatives });
            return result({ status: request?.state === 'denied' || request?.state === 'revoked' ? request.state : 'approval_required',
              requestId: request?.id, server: config.serverName, tool: tool.name, alternatives,
              message: 'This tool was not executed. Try permitted alternatives. If needed, tell the user to review Settings → Meta agent → Tool approvals. Do not claim the blocked work completed.' });
          }
          // Fresh discovery per call prevents a previous list from authorizing a changed catalog.
          check(context);
          validateInput(tool.inputSchema, input);
          return manager.callTool(args.server as string, tool.name, input, signal);
        });
        const tool = internal(context).find(t => t.name === args.tool);
        if (!tool) return result({ status: 'unavailable', message: 'Tool is not an available Michi-state operation. Try a listed tool.', alternatives: internal(context).map(t => t.name) });
        check(context);
        validateInput(tool.inputSchema, input);
        return tool.execute(input, signal);
      }),
    },
  ];
}
