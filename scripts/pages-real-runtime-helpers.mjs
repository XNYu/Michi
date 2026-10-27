const nativePageTools = new Set([
  'list_pages', 'read_page', 'create_page', 'edit_page', 'read_database',
  'edit_database', 'list_page_components', 'read_page_component',
  'save_page_component', 'configure_database_view',
]);
const oneTimePageTools = new Set([...nativePageTools, 'michi_docs', 'michi_list_tools', 'michi_call_tool']);

const EVIDENCE_MAX_BYTES = 90_000;

/** Keep decision evidence while removing duplicate raw turn/event transcripts. */
export function boundEvidence(value, maxBytes = EVIDENCE_MAX_BYTES, sanitizeString = (item) => item) {
  const result = JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === 'string' ? sanitizeString(item) : item));
  // turnTrace duplicates turns, stageTurns, and events, often including full
  // output payloads. The final per-call summaries below are the canonical trace.
  delete result.turnTrace;
  if (Array.isArray(result.turns)) result.turns = result.turns.map(compactTurn);
  if (result.stageTurns && typeof result.stageTurns === 'object') {
    result.stageTurns = Object.fromEntries(Object.entries(result.stageTurns)
      .map(([key, turn]) => [key, compactTurn(turn)]));
  }
  if (Array.isArray(result.events)) result.events = result.events.slice(-60).map(compactEvent);
  if (Array.isArray(result.toolOutputs)) result.toolOutputs = result.toolOutputs.slice(-24).map((item) => ({
    title: short(item.title, 160), status: item.status, turnId: item.turnId,
    assistantId: item.assistantId, output: short(item.output, 600),
  }));

  const size = () => Buffer.byteLength(JSON.stringify(result));
  while (size() > maxBytes && result.events?.length) result.events.shift();
  while (size() > maxBytes && result.toolOutputs?.length) result.toolOutputs.shift();
  while (size() > maxBytes && result.pageChanges?.length) result.pageChanges.pop();
  if (size() > maxBytes && result.assistantText) result.assistantText = result.assistantText.slice(-2000);
  // Preserve the acceptance verdict, grouped checks, read-back and provenance
  // even under unexpectedly large metadata by dropping only optional detail.
  if (size() > maxBytes) {
    for (const turn of [...(result.turns ?? []), ...Object.values(result.stageTurns ?? {})]) {
      if (turn?.toolCalls) turn.toolCalls = turn.toolCalls.slice(-12).map((call) => ({
        ...call, inputJson: call.inputJson ? short(call.inputJson, 500) : undefined,
      }));
    }
  }
  if (size() > maxBytes) throw new Error(`Acceptance evidence exceeds ${maxBytes} bytes after bounded compaction.`);
  return result;
}

function compactTurn(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  const latest = new Map();
  for (const call of turn.toolCalls ?? []) {
    const key = call.toolCallId ? `${call.turnId ?? turn.turnId ?? ''}:${call.toolCallId}`
      : `${call.turnId ?? turn.turnId ?? ''}:${call.title ?? ''}:${call.nativeTool ?? ''}`;
    latest.set(key, { ...call,
      title: short(call.title, 180),
      ...(call.inputJson ? { inputJson: short(call.inputJson, 1200) } : {}),
    });
  }
  return { requestedTurnId: turn.requestedTurnId, turnId: turn.turnId,
    assistantId: turn.assistantId, toolEventCount: turn.toolEventCount,
    terminal: turn.terminal, toolCalls: [...latest.values()].slice(-32) };
}

function compactEvent(event) {
  const copy = { ...event };
  for (const key of ['inputJson', 'output', 'detail']) {
    if (typeof copy[key] === 'string') copy[key] = short(copy[key], key === 'inputJson' ? 1200 : 800);
  }
  return copy;
}

function short(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : value;
}

/** Extract only the declared {tool, arguments} envelope used by michi_call_tool. */
export function wrappedNativePageTool(data) {
  const candidates = [data.inputJson, data.arguments, data.input, data.detail, data.description]
    .filter((value) => value !== undefined && value !== null);
  for (const candidate of candidates) {
    let wrapper = candidate;
    if (typeof wrapper === 'string') {
      try { wrapper = JSON.parse(wrapper); } catch { continue; }
    }
    // Do not recursively scan nested tool/name fields: they may describe
    // arguments or unrelated capability data rather than the dispatched tool.
    if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper)
        && Object.hasOwn(wrapper, 'tool')) {
      return typeof wrapper.tool === 'string' ? normalizeNativePageTool(wrapper.tool) : null;
    }
  }

  return null;
}

/** A read counts only after the exact identified native call completes. */
export function findCompletedNativeToolCall(toolCalls, nativeTool, turnId) {
  if (typeof turnId !== 'string' || !turnId) return null;
  return toolCalls.find((call) => call.nativeTool === nativeTool && call.status === 'completed'
    && typeof call.toolCallId === 'string' && call.toolCallId.length > 0
    && call.turnId === turnId) ?? null;
}

/** Resolve a direct native tool event from its canonical title spelling. */
export function directNativePageTool(title) {
  return normalizeNativePageTool(String(title ?? '').trim().replace(/^Running:\s*/i, ''));
}

export function isOneTimePagePermissionAllowed(requestedTool, wrappedTool = null) {
  if (requestedTool === 'michi_call_tool') return nativePageTools.has(wrappedTool);
  return oneTimePageTools.has(requestedTool);
}

export function normalizeNativePageTool(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^running:\s*/i, '');
  return [...nativePageTools].find((name) => normalized === name
    || normalized.endsWith(`/michi/${name}`) || normalized.endsWith(`/@michi/${name}`)
    || normalized === `michi/${name}` || normalized === `@michi/${name}`) ?? null;
}
