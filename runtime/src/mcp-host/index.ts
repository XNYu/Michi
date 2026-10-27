/**
 * Generic loopback MCP host: lets a server-side Node host hand its own tools to
 * external agent processes (Kiro, Crew, Codex, Claude) over HTTP MCP. Ships no
 * product tools. Public entry `michi-runtime/mcp-host`.
 * createMcpSlotProvider puts the adapters' McpSlotProvider on such a host.
 */
export { createMcpHost } from './host';
export { createMcpSlotProvider } from './slotProvider';
export type { McpSlotProviderOptions } from './slotProvider';
export type {
  AskUserOption,
  AskUserQuestion,
  CreateSlotOptions,
  HostHookHandler,
  HostToolDef,
  HostToolSource,
  JsonSchemaObject,
  McpHost,
  McpHostHandler,
  McpHostListener,
  McpHostLog,
  McpHostLogLevel,
  McpHostOptions,
  McpHttpEndpoint,
  McpSessionGroup,
  McpSlotHandle,
  SessionGroupOptions,
  SessionToolSink,
  SlotBuiltins,
  SlotView,
  StructuredResultTool,
  ToolAnnotations,
  ToolCallContext,
  ToolContent,
  ToolResult,
  ToolSourceErrorMode,
} from './types';
