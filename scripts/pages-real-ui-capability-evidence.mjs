export function recordMintedComponentCapability(owners, event, request, responseBody, page, issuedAt = Date.now()) {
  let requestBody;
  try { requestBody = JSON.parse(request.postData() ?? '{}'); } catch { return null; }
  if (typeof requestBody.componentId !== 'string' || typeof responseBody?.capability !== 'string') return null;
  const owner = { componentId: requestBody.componentId, host: requestBody.host, page, issuedAt };
  owners.set(responseBody.capability, owner);
  Object.assign(event, { capability: responseBody.capability, ...owner });
  return owner;
}

export function capabilitiesForHost(owners, componentId, host, page) {
  return [...owners].filter(([, owner]) => owner.componentId === componentId
    && owner.page === page
    && owner.host?.kind === host.kind
    && owner.host?.pageId === host.pageId
    && owner.host?.blockId === host.blockId);
}

export function capabilityReadHostSucceeded(traffic, token) {
  return traffic.some((event) => event.path.endsWith(`/${token}`)
    && event.status === 200
    && event.method === 'POST'
    && JSON.parse(event.requestBody ?? '{}').method === 'read.host');
}

export function oldCapabilityCallsAfterOwnerReplacement(traffic, owners, oldTokens, replacementsByPage) {
  return traffic.filter((event) => {
    if (event.method !== 'POST' || !event.path.startsWith('/api/component-capabilities/')) return false;
    const token = decodeURIComponent(event.path.split('/').at(-1) ?? '');
    if (!oldTokens.has(token)) return false;
    const owner = owners.get(token);
    if (!owner) return true;
    const replacement = replacementsByPage[owner.page];
    if (!replacement || typeof replacement.issuedAt !== 'number') return true;
    const requestStartedAt = typeof event.requestStartedAt === 'number' && event.requestStartedAt > 0
      ? event.requestStartedAt
      : event.at;
    return requestStartedAt > replacement.issuedAt;
  });
}

function exactNotFound(entry, message) {
  if (entry.status !== 404) return false;
  try {
    const payload = JSON.parse(entry.responseBody ?? '');
    return payload.error?.code === 'not_found' && payload.error?.message === message;
  } catch { return false; }
}

function sameHost(left, right) {
  return left?.kind === right?.kind && left?.pageId === right?.pageId && left?.blockId === right?.blockId;
}

function effectiveRequestStart(entry) {
  return typeof entry.requestStartedAt === 'number' && entry.requestStartedAt > 0
    ? entry.requestStartedAt
    : entry.at;
}

export function isExpectedDisabledComponent404(entry, componentId, windows, owners) {
  if (!entry || entry.status !== 404) return false;
  const startedAt = effectiveRequestStart(entry);
  const window = windows.find((candidate) => candidate.componentId === componentId
    && Number.isFinite(candidate.endedAt)
    && startedAt >= candidate.startedAt && startedAt <= candidate.endedAt);
  if (!window) return false;
  if (exactNotFound(entry, 'Component is disabled')
    && entry.method === 'GET' && entry.path === `/api/components/${encodeURIComponent(componentId)}`) return true;

  let requestBody;
  try { requestBody = JSON.parse(entry.requestBody ?? '{}'); } catch { requestBody = null; }
  if (exactNotFound(entry, 'Component is disabled')
    && entry.method === 'POST' && entry.path === '/api/component-capabilities'
    && requestBody?.componentId === componentId && window.host && sameHost(requestBody.host, window.host)) return true;

  if (!exactNotFound(entry, 'Component capability was revoked')
    || !window.host || entry.method !== 'POST' || !entry.path.startsWith('/api/component-capabilities/')) return false;
  const token = decodeURIComponent(entry.path.split('/').at(-1) ?? '');
  const owner = owners.get(token);
  return entry.path === `/api/component-capabilities/${encodeURIComponent(token)}`
    && owner?.componentId === componentId && sameHost(owner.host, window.host);
}

export function isExpectedDeletedComponentRead(entry, componentId, deleteResponse) {
  return Boolean(deleteResponse
    && deleteResponse.method === 'DELETE'
    && deleteResponse.status >= 200 && deleteResponse.status < 300
    && deleteResponse.path === `/api/components/${encodeURIComponent(componentId)}`
    && entry?.method === 'GET'
    && entry.path === `/api/components/${encodeURIComponent(componentId)}`
    && effectiveRequestStart(entry) >= deleteResponse.at
    && exactNotFound(entry, 'Component not found'));
}
