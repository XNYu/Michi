// Barrel for the frontend HTTP/SSE client.
//
// This module was physically split into `./api/*` concern modules, but the
// import path `services/api` is load-bearing: ~25 test mocks and ~32 source
// imports bind to it. Keep this file an `export *` barrel so every one of
// those keeps resolving against the same specifier. Add new API surface to the
// concern module it belongs to; it flows out here automatically.

export type { AgentCommand, PlanEntry, StreamHandlers } from './chatStreamEvents';
export type { PermissionRequest } from '../state/chatTypes';

export * from './api/uploads';
export * from './api/sessions';
export * from './api/stream';
export * from './api/panes';
export * from './api/permissions';
export * from './api/persistence';
export * from './api/prefs';
export * from './api/search';
export * from './api/version';
export * from './api/agentRuntime';
export * from './api/artifacts';
