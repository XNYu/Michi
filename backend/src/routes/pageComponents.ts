import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { PageWriteError, assertPageRequestSize } from '../services/pages/core';
import { pageComponents } from '../services/pages/components';
import { callPageComponentCapability, mintPageComponentCapability, revokePageComponentCapability } from '../services/pages/componentCapabilities';
import { COMPONENT_SANDBOX_CSP, COMPONENT_SANDBOX_HTML, componentSandboxWrapper } from '../services/pages/sandboxDocument';
import { COMPONENT_SANDBOX_METHODS, isComponentRecord } from 'michi-shared';

type Obj = Record<string, unknown>;
const owner = (req: Request): string => (req as Request & { user?: { id?: string } }).user?.id ?? LOCAL_AGENT_OWNER_ID;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message: string): never { throw new PageWriteError(400, 'invalid', message); }
function body(req: Request, keys: readonly string[]): Obj {
  const data = req.body;
  if (!isObject(data) || Object.keys(data).some((key) => !keys.includes(key))) return fail('Invalid component request body');
  assertPageRequestSize(data);
  return data;
}
function route(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => { try { fn(req, res); } catch (error) { next(error); } };
}
function errors(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof PageWriteError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  res.status(500).json({ error: { code: 'internal_error', message: 'Unable to complete component request' } });
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 200) return fail(`Invalid ${label}`);
  return value;
}
function libraryRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail('Invalid expectedLibraryRevision');
  return value as number;
}

export function setupPageComponentRoutes(): Router {
  const router = Router();
  router.get('/component-sandbox', (_req, res) => {
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': COMPONENT_SANDBOX_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    }).send(COMPONENT_SANDBOX_HTML);
  });
  router.get('/component-sandbox-wrapper', route((req, res) => {
    const requestPath = req.originalUrl.split('?')[0] ?? '';
    const { html, csp } = componentSandboxWrapper(requestPath);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    }).send(html);
  }));

  router.get('/workspaces/:workspaceId/components', route((req, res) => {
    res.json(pageComponents.list(id(req.params.workspaceId, 'workspaceId'), owner(req)));
  }));
  router.get('/components/:componentId', route((req, res) => {
    if (Object.keys(req.query).some((key) => !['workspaceId', 'version'].includes(key))) fail('Unknown component query parameter');
    const workspaceId = id(req.query.workspaceId, 'workspaceId');
    const version = req.query.version === undefined ? undefined : Number(req.query.version);
    if (version !== undefined && !Number.isSafeInteger(version)) fail('Invalid version');
    res.json(pageComponents.read(workspaceId, owner(req), id(req.params.componentId, 'componentId'), version));
  }));
  router.get('/components/:componentId/references', route((req, res) => {
    if (Object.keys(req.query).some((key) => key !== 'workspaceId')) fail('Unknown component query parameter');
    res.json({ items: pageComponents.references(id(req.query.workspaceId, 'workspaceId'), owner(req), id(req.params.componentId, 'componentId')) });
  }));
  // This native UI endpoint creates user attribution server-side; agent tools use the separate validated save path.
  router.post('/workspaces/:workspaceId/components', route((req, res) => {
    const data = body(req, ['input', 'expectedLibraryRevision']);
    res.status(201).json(pageComponents.saveUser(id(req.params.workspaceId, 'workspaceId'), owner(req), {
      input: data.input, expectedLibraryRevision: libraryRevision(data.expectedLibraryRevision),
    }));
  }));
  router.post('/components/:componentId/enable', route((req, res) => {
    const data = body(req, ['workspaceId', 'expectedLibraryRevision']);
    res.json(pageComponents.setEnabled(id(data.workspaceId, 'workspaceId'), owner(req), id(req.params.componentId, 'componentId'), true,
      { expectedLibraryRevision: libraryRevision(data.expectedLibraryRevision), actor: { kind: 'user' } }));
  }));
  router.post('/components/:componentId/disable', route((req, res) => {
    const data = body(req, ['workspaceId', 'expectedLibraryRevision']);
    res.json(pageComponents.setEnabled(id(data.workspaceId, 'workspaceId'), owner(req), id(req.params.componentId, 'componentId'), false,
      { expectedLibraryRevision: libraryRevision(data.expectedLibraryRevision), actor: { kind: 'user' } }));
  }));
  router.post('/components/:componentId/activate', route((req, res) => {
    const data = body(req, ['workspaceId', 'expectedLibraryRevision', 'version']);
    const version = libraryRevision(data.version);
    if (version < 1) fail('Invalid version');
    res.json(pageComponents.activate(id(data.workspaceId, 'workspaceId'), owner(req), id(req.params.componentId, 'componentId'), version,
      { expectedLibraryRevision: libraryRevision(data.expectedLibraryRevision), actor: { kind: 'user' } }));
  }));
  router.post('/components/:componentId/rollback', route((req, res) => {
    const data = body(req, ['workspaceId', 'expectedLibraryRevision', 'version']);
    const version = libraryRevision(data.version);
    if (version < 1) fail('Invalid version');
    res.json(pageComponents.rollback(id(data.workspaceId, 'workspaceId'), owner(req), id(req.params.componentId, 'componentId'), version,
      { expectedLibraryRevision: libraryRevision(data.expectedLibraryRevision), actor: { kind: 'user' } }));
  }));
  router.delete('/components/:componentId', route((req, res) => {
    const data = body(req, ['workspaceId', 'expectedLibraryRevision']);
    res.json(pageComponents.delete(id(data.workspaceId, 'workspaceId'), owner(req), id(req.params.componentId, 'componentId'),
      { expectedLibraryRevision: libraryRevision(data.expectedLibraryRevision), actor: { kind: 'user' } }));
  }));

  router.post('/component-capabilities', route((req, res) => {
    const data = body(req, ['workspaceId', 'componentId', 'version', 'host', 'props']);
    const version = libraryRevision(data.version);
    if (version < 1 || !isComponentRecord(data.host)) fail('Invalid component host');
    res.status(201).json(mintPageComponentCapability({
      workspaceId: id(data.workspaceId, 'workspaceId'), ownerUserId: owner(req), componentId: id(data.componentId, 'componentId'),
      version, host: data.host as never, props: data.props,
    }));
  }));
  router.post('/component-capabilities/:capability', route((req, res) => {
    const data = body(req, ['method', 'resourceId', 'args']);
    if (typeof data.method !== 'string' || !COMPONENT_SANDBOX_METHODS.includes(data.method as never)) fail('Invalid component method');
    if (data.resourceId !== undefined && typeof data.resourceId !== 'string') fail('Invalid resourceId');
    if (data.args !== undefined && !Array.isArray(data.args)) fail('Invalid component arguments');
    res.json({ result: callPageComponentCapability(id(req.params.capability, 'capability'), owner(req), {
      method: data.method as typeof COMPONENT_SANDBOX_METHODS[number], resourceId: data.resourceId as string | undefined, args: data.args as unknown[] | undefined,
    }) });
  }));
  router.delete('/component-capabilities/:capability', route((req, res) => {
    revokePageComponentCapability(id(req.params.capability, 'capability'), owner(req));
    res.status(204).end();
  }));
  router.use(errors);
  return router;
}
