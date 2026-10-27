import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { isIPv4, type AddressInfo } from 'node:net';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { redactId, slotSnapshot, type GroupRecord, type SlotRecord } from './registry';
import { buildServer, groupTarget, slotTarget, type ServerContext, type ServerTarget } from './server';
import { TOOL_CATALOG_UNAVAILABLE, ToolCatalogUnavailableError } from './tools';
import type { McpHostHandler } from './types';

/**
 * HTTP surface of the MCP host. Every request passes these gates before any
 * lookup: the peer must be loopback, the request must not carry an Origin
 * header (browsers always send one on POST, which blocks DNS-rebinding and
 * cross-site requests) or proxy forwarding headers, and the body must stay
 * under maxBodyBytes (default 4 MB). Behind the gates the 128-bit slot or
 * group id in the path is the capability. The gates apply whether the host
 * calls listen() or mounts handler() on its own server, so a host server
 * bound wider than loopback still cannot expose these routes.
 */

/**
 * Headers a proxy adds. A reverse proxy on this machine makes remote callers
 * look loopback; agent processes connect directly and never send these.
 */
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via'] as const;

/** Default request body limit (McpHostOptions.maxBodyBytes). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 127.0.0.0/8, ::1 and IPv4-mapped 127.x (`::ffff:127.0.0.1`). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1') return true;
  const lower = address.toLowerCase();
  const v4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  return isIPv4(v4) && v4.startsWith('127.');
}

export interface HttpContext<B> extends ServerContext<B> {
  basePath: string;
  maxBodyBytes: number;
  /** Close functions of in-flight MCP requests, run by host.close(). */
  active: Set<() => void>;
}

type Route =
  | { kind: 'slot'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'hook'; id: string; name: string };

function segmentsAfter(pathname: string, prefix: string): string[] | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const segments = pathname.slice(prefix.length).split('/');
  return segments.every((segment) => segment !== '') ? segments : undefined;
}

function matchRoute(pathname: string, basePath: string): Route | undefined {
  const slot = segmentsAfter(pathname, `${basePath}/`);
  if (slot?.length === 1) return { kind: 'slot', id: slot[0] };
  const group = segmentsAfter(pathname, `${basePath}-session/`);
  if (group?.length === 1) return { kind: 'group', id: group[0] };
  const hook = segmentsAfter(pathname, `${basePath}-hooks/`);
  if (hook?.length === 2) return { kind: 'hook', id: hook[0], name: hook[1] };
  return undefined;
}

function pathnameOf(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string,
  headers?: Record<string, string>): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function sendTooLarge(res: ServerResponse, limit: number): void {
  // The rest of the body is not read; close the connection instead of reusing it.
  sendJson(res, 413, { error: `request body exceeds ${limit} bytes` }, { connection: 'close' });
}

function declaredLength(req: IncomingMessage): number | undefined {
  const header = req.headers['content-length'];
  if (header === undefined) return undefined;
  const value = Number(header);
  return Number.isFinite(value) ? value : undefined;
}

function isJsonContentType(header: string | undefined): boolean {
  return (header ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/** Reads the request stream up to `limit` bytes. Past the limit the rest is discarded unread. */
function readBody(req: IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 413 }> {
  if (req.readableEnded) return Promise.resolve({ ok: true, text: '' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: { ok: true; text: string } | { ok: false; status: 400 | 413 }) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolve(result);
    };
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limit) {
        settle({ ok: false, status: 413 });
        return;
      }
      chunks.push(buffer);
    });
    req.once('end', () => {
      if (!settled) settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.once('error', () => settle({ ok: false, status: 400 }));
    req.once('close', () => settle({ ok: false, status: 400 }));
  });
}

async function bodyOf(req: IncomingMessage, provided: unknown, limit: number): Promise<BodyResult> {
  if (provided !== undefined) return { ok: true, value: provided };
  const read = await readBody(req, limit);
  if (!read.ok) return read;
  try {
    return { ok: true, value: JSON.parse(read.text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

async function serveMcp<B>(ctx: HttpContext<B>, server: Server, req: IncomingMessage, res: ServerResponse,
  body: unknown, logData: Record<string, unknown>): Promise<void> {
  if (res.writableEnded || res.destroyed) return;
  // Stateless: a fresh server and transport per POST, torn down when the response closes.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const closeAll = () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  };
  ctx.active.add(closeAll);
  res.on('close', () => {
    ctx.active.delete(closeAll);
    closeAll();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    ctx.log('error', 'mcp host request failed', { ...logData, error: messageOf(error) });
    sendJson(res, 500, { error: 'internal error' });
  }
}

async function serveHook<B>(ctx: HttpContext<B>, route: { id: string; name: string }, req: IncomingMessage,
  res: ServerResponse, provided: unknown): Promise<void> {
  const record = ctx.registry.routableSlot(route.id);
  const hook = record ? ctx.registry.hooks.get(route.name) : undefined;
  if (!record || !hook) {
    ctx.log('warn', 'mcp host hook request for an unknown slot or hook', { slot: redactId(route.id), known: Boolean(record) });
    sendJson(res, 404, { error: 'unknown hook' });
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    sendJson(res, 415, { error: 'hook bodies must be application/json' });
    return;
  }
  const body = await bodyOf(req, provided, ctx.maxBodyBytes);
  if (!body.ok) {
    if (body.status === 413) sendTooLarge(res, ctx.maxBodyBytes);
    else sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }
  const logData = { slot: redactId(record.slotId), hook: route.name };
  let text: string;
  try {
    const result = await hook(slotSnapshot(record), body.value);
    text = JSON.stringify(result === undefined ? {} : result);
  } catch (error) {
    ctx.log('warn', 'mcp host hook failed', { ...logData, error: messageOf(error) });
    sendJson(res, 500, { error: 'hook failed' });
    return;
  }
  ctx.log('debug', 'mcp host hook served', logData);
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

async function handle<B>(ctx: HttpContext<B>, req: IncomingMessage, res: ServerResponse, provided: unknown): Promise<void> {
  const remoteAddress = req.socket?.remoteAddress;
  if (!isLoopbackAddress(remoteAddress)) {
    ctx.log('warn', 'mcp host rejected a non-loopback request', { remoteAddress: remoteAddress ?? null });
    sendJson(res, 403, { error: 'mcp host is loopback-only' });
    return;
  }
  if (req.headers.origin !== undefined) {
    ctx.log('warn', 'mcp host rejected a request with an Origin header', { origin: String(req.headers.origin).slice(0, 200) });
    sendJson(res, 403, { error: 'browser-originated requests are not allowed' });
    return;
  }
  const proxyHeader = PROXY_HEADERS.find((name) => req.headers[name] !== undefined);
  if (proxyHeader) {
    ctx.log('warn', 'mcp host rejected a proxied request', { header: proxyHeader });
    sendJson(res, 403, { error: 'mcp host is loopback-only' });
    return;
  }
  const pathname = pathnameOf(req.url);
  const route = pathname === undefined ? undefined : matchRoute(pathname, ctx.basePath);
  if (!route) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  // Stateless mode has no server-initiated stream (GET) and no session to end (DELETE).
  if (req.method !== 'POST') {
    sendJsonRpcError(res, 405, -32000, 'Method Not Allowed', { allow: 'POST' });
    return;
  }
  const declared = declaredLength(req);
  if (declared !== undefined && declared > ctx.maxBodyBytes) {
    ctx.log('warn', 'mcp host rejected an oversized request body', { kind: route.kind, id: redactId(route.id), bytes: declared });
    sendTooLarge(res, ctx.maxBodyBytes);
    return;
  }
  if (route.kind === 'hook') {
    await serveHook(ctx, route, req, res, provided);
    return;
  }

  let target: ServerTarget;
  let logData: Record<string, unknown>;
  if (route.kind === 'slot') {
    const record: SlotRecord<B> | undefined = ctx.registry.routableSlot(route.id);
    if (!record) {
      // Usually an agent process that outlived its session, still calling its old URL.
      ctx.log('warn', 'mcp host request for an unknown slot', { slot: redactId(route.id) });
      sendJson(res, 404, { error: 'unknown mcp slot' });
      return;
    }
    logData = { slot: redactId(record.slotId) };
    target = slotTarget(ctx, record);
  } else {
    const group: GroupRecord | undefined = ctx.registry.group(route.id);
    if (!group) {
      ctx.log('warn', 'mcp host request for an unknown session group', { group: redactId(route.id) });
      sendJson(res, 404, { error: 'unknown mcp session group' });
      return;
    }
    logData = { group: redactId(group.groupId) };
    target = groupTarget(ctx, group);
  }

  const body = await bodyOf(req, provided, ctx.maxBodyBytes);
  if (!body.ok) {
    if (body.status === 413) {
      ctx.log('warn', 'mcp host rejected an oversized request body', logData);
      sendTooLarge(res, ctx.maxBodyBytes);
    } else {
      sendJsonRpcError(res, 400, -32700, 'Parse error');
    }
    return;
  }
  // tools/list is answered from a catalog built up front, so a failed catalog
  // is an HTTP error, not a list an agent could take for an empty catalog.
  if (isToolsListRequest(body.value)) {
    let tools: Tool[];
    try {
      tools = target.listTools();
    } catch (error) {
      if (!(error instanceof ToolCatalogUnavailableError)) throw error;
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: TOOL_CATALOG_UNAVAILABLE }, id: body.value.id ?? null });
      return;
    }
    target = { ...target, listTools: () => tools };
  }
  await serveMcp(ctx, buildServer(ctx, target), req, res, body.value, logData);
}

function isToolsListRequest(value: unknown): value is { method: 'tools/list'; id?: string | number | null } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { method?: unknown }).method === 'tools/list';
}

export function createRequestHandler<B>(ctx: HttpContext<B>): McpHostHandler {
  return async (req, res, body) => {
    try {
      await handle(ctx, req, res, body);
    } catch (error) {
      ctx.log('error', 'mcp host request failed', { error: messageOf(error) });
      sendJson(res, 500, { error: 'internal error' });
    }
  };
}

/** Starts a server for `handler` on 127.0.0.1. Never binds another interface. */
export async function listenLoopback(handler: McpHostHandler, port: number): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
