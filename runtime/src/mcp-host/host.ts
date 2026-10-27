import type http from 'node:http';
import { MAX_BODY_BYTES, closeServer, createRequestHandler, listenLoopback, type HttpContext } from './http';
import {
  McpHostRegistry,
  TOOL_NAME_PATTERN,
  newCapabilityId,
  redactId,
  slotSnapshot,
  type GroupRecord,
  type SlotRecord,
} from './registry';
import { ASK_USER_TOOL, DEFAULT_ANCHOR_DESCRIPTION, isObjectSchema } from './tools';
import type {
  CreateSlotOptions,
  HostHookHandler,
  HostToolDef,
  HostToolSource,
  McpHost,
  McpHostLog,
  McpHostOptions,
  McpHttpEndpoint,
  McpSessionGroup,
  McpSlotHandle,
  SessionGroupOptions,
} from './types';

const BASE_PATH_PATTERN = /^(?:\/[A-Za-z0-9._~-]+)+$/;
const ANCHOR_ARG_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function assertName(kind: string, name: unknown): asserts name is string {
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid MCP ${kind} name: ${JSON.stringify(name)} (expected [A-Za-z0-9_-]{1,64})`);
  }
}

/**
 * Creates a loopback MCP host for host-provided tools. See types.ts for the
 * contract. Typical use:
 *
 *   const host = createMcpHost<MyBinding>();
 *   host.registerTool({ name: 'lookup', description, inputSchema, handler });
 *   await host.listen();
 *   const slot = host.createSlot({ sessionKey, cwd, binding, sink });
 *   spawnAgent({ mcpServers: { host: slot.endpoint() } });
 *   ...
 *   await slot.dispose();
 */
export function createMcpHost<B = unknown>(options: McpHostOptions = {}): McpHost<B> {
  const basePath = options.basePath ?? '/mcp';
  if (!BASE_PATH_PATTERN.test(basePath)) {
    throw new Error(`Invalid MCP host basePath: ${JSON.stringify(basePath)} (expected /segment[/segment...] without a trailing slash)`);
  }
  const serverName = options.serverName ?? 'host';
  if (typeof serverName !== 'string' || serverName.trim() === '') throw new Error('MCP host serverName must be a non-empty string');
  const serverVersion = options.serverVersion ?? '0.0.0';
  if (typeof serverVersion !== 'string' || serverVersion.trim() === '') throw new Error('MCP host serverVersion must be a non-empty string');
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error(`Invalid MCP host maxBodyBytes: ${String(maxBodyBytes)} (expected a positive integer)`);
  }

  const userLog = options.log;
  const log: McpHostLog = (level, msg, data) => {
    if (!userLog) return;
    try {
      userLog(level, msg, data);
    } catch {
      // A failing log sink must not break request handling.
    }
  };

  const registry = new McpHostRegistry<B>();
  const sourceErrors = options.sourceErrors ?? 'fail';
  if (sourceErrors !== 'fail' && sourceErrors !== 'skip') {
    throw new Error(`Invalid MCP host sourceErrors: ${JSON.stringify(sourceErrors)} (expected "fail" or "skip")`);
  }
  const ctx: HttpContext<B> = { registry, log, serverName, serverVersion, sourceErrors, basePath, maxBodyBytes, active: new Set() };
  const requestHandler = createRequestHandler(ctx);
  const records = new WeakMap<McpSlotHandle<B>, SlotRecord<B>>();
  let closed = false;
  let listening = false;
  let listener: { server: http.Server; baseUrl: string } | undefined;

  const assertOpen = () => {
    if (closed) throw new Error('MCP host is closed');
  };

  const baseUrl = (): string => {
    const configured = typeof options.publicBaseUrl === 'function' ? options.publicBaseUrl() : options.publicBaseUrl;
    const base = configured || listener?.baseUrl;
    if (!base) throw new Error('MCP host has no base URL: call listen() or pass publicBaseUrl to createMcpHost()');
    return base.replace(/\/+$/, '');
  };
  const endpointFor = (path: string): McpHttpEndpoint => ({ type: 'http', url: `${baseUrl()}${path}`, headers: [] });
  // The route shapes matchRoute (http.ts) serves.
  const slotEndpoint = (slotId: string) => endpointFor(`${basePath}/${slotId}`);
  const sessionGroupEndpoint = (groupId: string) => endpointFor(`${basePath}-session/${groupId}`);

  const liveRecord = (handle: McpSlotHandle<B>): SlotRecord<B> => {
    const record = records.get(handle);
    if (!record || record.disposed) throw new Error('Not a live MCP slot of this host');
    return record;
  };

  const disposeSlot = (record: SlotRecord<B>) => {
    if (record.disposed) return;
    const groups = registry.removeSlot(record.slotId);
    log('debug', 'mcp host slot disposed', { slot: redactId(record.slotId), groupsRemoved: groups.length });
  };

  const host: McpHost<B> = {
    registerTool(def: HostToolDef<B>) {
      assertOpen();
      assertName('tool', def?.name);
      if (typeof def.handler !== 'function') throw new Error(`MCP tool ${def.name} needs a handler`);
      if (!isObjectSchema(def.inputSchema)) throw new Error(`MCP tool ${def.name} needs an inputSchema with type "object"`);
      if (registry.tools.has(def.name)) throw new Error(`MCP tool ${def.name} is already registered`);
      registry.tools.set(def.name, def);
      return () => {
        if (registry.tools.get(def.name) === def) registry.tools.delete(def.name);
      };
    },

    registerToolSource(source: HostToolSource<B>) {
      assertOpen();
      if (typeof source !== 'function') throw new Error('MCP tool source must be a function');
      if (registry.sources.includes(source)) throw new Error('MCP tool source is already registered');
      registry.sources.push(source);
      return () => {
        const index = registry.sources.indexOf(source);
        if (index !== -1) registry.sources.splice(index, 1);
      };
    },

    registerHook(name: string, handler: HostHookHandler<B>) {
      assertOpen();
      assertName('hook', name);
      if (typeof handler !== 'function') throw new Error(`MCP hook ${name} needs a handler`);
      if (registry.hooks.has(name)) throw new Error(`MCP hook ${name} is already registered`);
      registry.hooks.set(name, handler);
      return () => {
        if (registry.hooks.get(name) === handler) registry.hooks.delete(name);
      };
    },

    createSlot(o: CreateSlotOptions<B>) {
      assertOpen();
      if (typeof o.sessionKey !== 'string') throw new Error('MCP slot sessionKey must be a string');
      if (typeof o.cwd !== 'string') throw new Error('MCP slot cwd must be a string');
      if (typeof o.sink?.emit !== 'function') throw new Error('MCP slot sink must implement emit()');
      if (o.routable !== undefined && typeof o.routable !== 'boolean') throw new Error('MCP slot routable must be a boolean');
      const structuredResult = o.builtins?.structuredResult;
      if (structuredResult) {
        assertName('tool', structuredResult.name);
        if (structuredResult.name === ASK_USER_TOOL) throw new Error(`The structured result tool cannot be named ${ASK_USER_TOOL}`);
        if (!isObjectSchema(structuredResult.inputSchema)) throw new Error('The structured result tool needs an inputSchema with type "object"');
        if (typeof structuredResult.submit !== 'function') throw new Error('The structured result tool needs submit()');
      }
      const record: SlotRecord<B> = {
        slotId: newCapabilityId(),
        sessionKey: o.sessionKey,
        cwd: o.cwd,
        binding: o.binding,
        sink: o.sink,
        allowTools: o.allowTools ? new Set(o.allowTools) : undefined,
        builtins: {
          ...(o.builtins?.askUser !== undefined ? { askUser: o.builtins.askUser } : {}),
          ...(structuredResult ? { structuredResult } : {}),
        },
        routable: o.routable !== false,
        disposed: false,
        inflight: new Set(),
      };
      registry.addSlot(record);
      const handle: McpSlotHandle<B> = {
        get slotId() { return record.slotId; },
        get sessionKey() { return record.sessionKey; },
        get cwd() { return record.cwd; },
        get binding() { return record.binding; },
        endpoint: () => {
          if (!record.routable) throw new Error('MCP slot has no endpoint: it was created with routable: false');
          return slotEndpoint(record.slotId);
        },
        rebind(p) {
          if (record.disposed) throw new Error('MCP slot is disposed');
          if (p.sessionKey !== undefined && typeof p.sessionKey !== 'string') throw new Error('MCP slot sessionKey must be a string');
          const hasAllowTools = Object.prototype.hasOwnProperty.call(p, 'allowTools');
          const allowTools = hasAllowTools && p.allowTools ? new Set(p.allowTools) : undefined;
          if (p.sessionKey !== undefined) record.sessionKey = p.sessionKey;
          if (Object.prototype.hasOwnProperty.call(p, 'binding')) record.binding = p.binding as B;
          if (hasAllowTools) record.allowTools = allowTools;
        },
        async dispose() {
          disposeSlot(record);
        },
      };
      records.set(handle, record);
      log('debug', 'mcp host slot created', { slot: redactId(record.slotId) });
      return handle;
    },

    createSessionGroup(catalogFrom: McpSlotHandle<B>, o?: SessionGroupOptions): McpSessionGroup<B> {
      assertOpen();
      const catalog = liveRecord(catalogFrom);
      const anchorArg = o?.anchorArg ?? 'session_id';
      if (!ANCHOR_ARG_PATTERN.test(anchorArg)) throw new Error(`Invalid MCP session group anchorArg: ${JSON.stringify(anchorArg)}`);
      const anchorDescription = o?.anchorDescription ?? DEFAULT_ANCHOR_DESCRIPTION;
      if (typeof anchorDescription !== 'string' || anchorDescription.trim() === '') {
        throw new Error('MCP session group anchorDescription must be a non-empty string');
      }
      const group: GroupRecord = {
        groupId: newCapabilityId(), catalogSlotId: catalog.slotId, anchorArg, anchorDescription, sessions: new Map(),
      };
      registry.addGroup(group);
      log('debug', 'mcp host session group created', { group: redactId(group.groupId), catalog: redactId(catalog.slotId) });
      const assertLive = () => {
        if (!registry.hasGroup(group.groupId)) throw new Error('MCP session group is disposed');
      };
      /** The live slot record bound to a native session, or undefined (also once the group is disposed). */
      const boundRecord = (nativeSessionId: string) => {
        if (!registry.hasGroup(group.groupId)) return undefined;
        const binding = group.sessions.get(nativeSessionId);
        const record = binding ? registry.slot(binding.slotId) : undefined;
        return binding && record ? { binding, record } : undefined;
      };
      return {
        groupId: group.groupId,
        endpoint: () => sessionGroupEndpoint(group.groupId),
        bind(nativeSessionId, slot) {
          assertLive();
          if (typeof nativeSessionId !== 'string' || nativeSessionId === '') throw new Error('Native session id must be a non-empty string');
          const target = liveRecord(slot);
          if (group.sessions.get(nativeSessionId)?.slotId === target.slotId) return;
          group.sessions.set(nativeSessionId, { slotId: target.slotId });
        },
        beginTurn(nativeSessionId) {
          assertLive();
          const binding = group.sessions.get(nativeSessionId);
          if (!binding || !registry.slot(binding.slotId)) throw new Error('MCP session is not bound to this group');
          const turn = Symbol('mcp-turn');
          binding.turn = turn;
          return () => {
            if (binding.turn === turn) binding.turn = undefined;
          };
        },
        endTurn(nativeSessionId) {
          const binding = group.sessions.get(nativeSessionId);
          if (binding) binding.turn = undefined;
        },
        resolve(nativeSessionId) {
          const bound = boundRecord(nativeSessionId);
          return bound ? slotSnapshot(bound.record) : undefined;
        },
        isTurnActive(nativeSessionId) {
          return boundRecord(nativeSessionId)?.binding.turn !== undefined;
        },
        dispose() {
          if (registry.removeGroup(group.groupId)) log('debug', 'mcp host session group disposed', { group: redactId(group.groupId) });
        },
      };
    },

    slotEndpoint,

    sessionGroupEndpoint,

    hookUrl(slotId: string, name: string) {
      assertName('hook', name);
      return `${baseUrl()}${basePath}-hooks/${slotId}/${name}`;
    },

    handler() {
      return requestHandler;
    },

    async listen(o) {
      assertOpen();
      if (listener || listening) throw new Error('MCP host is already listening');
      const port = o?.port ?? 0;
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid MCP host port: ${port}`);
      listening = true;
      let started: { server: http.Server; baseUrl: string };
      try {
        started = await listenLoopback(requestHandler, port);
      } finally {
        listening = false;
      }
      if (closed) {
        await closeServer(started.server);
        throw new Error('MCP host is closed');
      }
      listener = started;
      log('info', 'mcp host listening', { baseUrl: started.baseUrl });
      return {
        baseUrl: started.baseUrl,
        async close() {
          if (listener === started) listener = undefined;
          await closeServer(started.server);
        },
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const closeRequest of [...ctx.active]) closeRequest();
      ctx.active.clear();
      registry.clear();
      const current = listener;
      listener = undefined;
      if (current) await closeServer(current.server);
    },
  };
  return host;
}
