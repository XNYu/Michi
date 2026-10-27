import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { redactId, type GroupRecord, type SlotRecord } from './registry';
import {
  TOOL_CATALOG_UNAVAILABLE,
  ToolCatalogUnavailableError,
  declaresAnchor,
  errorResult,
  runEntry,
  slotCatalog,
  unknownToolResult,
  withAnchor,
  type CatalogContext,
  type CatalogEntry,
} from './tools';
import type { JsonSchemaObject, ToolResult } from './types';

/**
 * Builds one MCP `Server` per HTTP request. The low-level server takes JSON
 * Schema as-is (no zod); tools/list and tools/call are answered from the
 * registry at request time, so registration, visibility and rebind changes
 * show up on the next request.
 */

/** What one request's server answers. listTools throws ToolCatalogUnavailableError for a failed catalog. */
export interface ServerTarget {
  listTools(): Tool[];
  callTool(name: string, args: Record<string, unknown>, call: { toolCallId?: string; signal: AbortSignal }): Promise<ToolResult>;
}

export interface ServerContext<B> extends CatalogContext<B> {
  serverName: string;
  serverVersion: string;
}

/** `_meta` keys that carry the agent's own tool-use id. */
const TOOL_CALL_ID_META_KEYS = ['claudecode/toolUseId'];

function toWireTool<B>(entry: CatalogEntry<B>, inputSchema: JsonSchemaObject = entry.inputSchema): Tool {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: inputSchema as Tool['inputSchema'],
    ...(entry.annotations ? { annotations: entry.annotations } : {}),
  };
}

function readToolCallId(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  for (const key of TOOL_CALL_ID_META_KEYS) {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** The catalog for a tools/call; a failed catalog is a tool error, not an unknown tool. */
function catalogForCall<B>(ctx: ServerContext<B>, record: SlotRecord<B>): CatalogEntry<B>[] | ToolResult {
  try {
    return slotCatalog(ctx, record);
  } catch (error) {
    if (error instanceof ToolCatalogUnavailableError) return errorResult(TOOL_CATALOG_UNAVAILABLE);
    throw error;
  }
}

export function buildServer<B>(ctx: ServerContext<B>, target: ServerTarget): Server {
  const server = new Server({ name: ctx.serverName, version: ctx.serverVersion }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: target.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const raw = request.params.arguments;
    const args = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    const toolCallId = readToolCallId(request.params._meta);
    return await target.callTool(request.params.name, args, {
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      signal: extra.signal,
    }) as CallToolResult;
  });
  return server;
}

/** Target for `<basePath>/<slotId>`: the slot's own catalog. */
export function slotTarget<B>(ctx: ServerContext<B>, record: SlotRecord<B>): ServerTarget {
  const logData = { slot: redactId(record.slotId) };
  return {
    listTools: () => slotCatalog(ctx, record).map((entry) => toWireTool(entry)),
    async callTool(name, args, call) {
      const catalog = catalogForCall(ctx, record);
      if (!Array.isArray(catalog)) return catalog;
      const entry = catalog.find((candidate) => candidate.name === name);
      if (!entry) return unknownToolResult(name);
      return runEntry(entry, record, args, call, ctx.log, logData);
    },
  };
}

/**
 * Target for `<basePath>-session/<groupId>`: one stable URL for many native
 * sessions. tools/list mirrors the catalog slot with a required anchor
 * argument; tools/call routes on the anchor to the slot bound to that native
 * session and runs the tool against that slot's catalog, binding and sink.
 */
export function groupTarget<B>(ctx: ServerContext<B>, group: GroupRecord): ServerTarget {
  const { anchorArg, anchorDescription } = group;
  const groupLog = { group: redactId(group.groupId) };
  return {
    listTools() {
      const catalog = ctx.registry.slot(group.catalogSlotId);
      if (!catalog) return [];
      return slotCatalog(ctx, catalog)
        .filter((entry) => !declaresAnchor(entry, anchorArg))
        .map((entry) => toWireTool(entry, withAnchor(entry.inputSchema, anchorArg, anchorDescription)));
    },
    async callTool(name, args, call) {
      const anchor = args[anchorArg];
      if (typeof anchor !== 'string' || anchor === '') {
        return errorResult(`Missing required argument "${anchorArg}": pass the current session id from your session context.`);
      }
      const binding = group.sessions.get(anchor);
      const record = binding ? ctx.registry.slot(binding.slotId) : undefined;
      if (!binding || !record) {
        ctx.log('debug', 'mcp host session group call for an unbound session', { ...groupLog, tool: name });
        return errorResult(`The "${anchorArg}" value names a session that is not bound to this MCP endpoint. Use the current session id from your session context.`);
      }
      if (!binding.turn) {
        ctx.log('debug', 'mcp host session group call outside the turn window', { ...groupLog, slot: redactId(record.slotId), tool: name });
        return errorResult(`"${anchorArg}" names a session with no active turn. Tools can only be called while that session's turn is running.`);
      }
      const { [anchorArg]: _anchor, ...payload } = args;
      const catalog = catalogForCall(ctx, record);
      if (!Array.isArray(catalog)) return catalog;
      const entry = catalog.find((candidate) => candidate.name === name && !declaresAnchor(candidate, anchorArg));
      if (!entry) return unknownToolResult(name);
      return runEntry(entry, record, payload, call, ctx.log, { ...groupLog, slot: redactId(record.slotId) });
    },
  };
}
