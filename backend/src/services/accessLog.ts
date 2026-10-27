// Existing high-frequency probes and runtime transport requests.
const SILENT_SUCCESS_PATHS = [
  /^\/(?:health|ready)$/,
  /^\/agent\/(?:status|models)$/,
  /^\/mcp\/[^/]+$/,
  /^\/nodes\/[^/]+\/ensure-session$/,
  /^\/workspaces(?:\/all)?$/,
  /^\/workspaces\/[^/]+\/sync$/,
  /^\/chats\/[^/]+\/heartbeat$/,
];

const POLLING_PATHS = [
  /^\/spaces$/,
  /^\/workspaces\/[^/]+\/(?:pages|databases|maintenance)$/,
  /^\/pages\/[^/]+(?:\/(?:changes|activity-seen))?$/,
  /^\/databases\/[^/]+$/,
];

/** Quiet routine polling, while retaining changed reads, mutations and errors. */
export function shouldLogAccess(method: string, requestPath: string, status: number): boolean {
  if (status >= 400) return true;
  const pathname = requestPath.replace(/^\/api(?=\/)/, '');
  if (SILENT_SUCCESS_PATHS.some((pattern) => pattern.test(pathname))) return false;
  if (method !== 'GET') return true;
  if (/^\/backend-connections\/recovery$/.test(pathname)) return false;
  return !((status === 204 || status === 304) && POLLING_PATHS.some((pattern) => pattern.test(pathname)));
}
