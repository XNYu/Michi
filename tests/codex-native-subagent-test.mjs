#!/usr/bin/env node
/**
 * Test Codex's NATIVE subagent thread spawning behavior.
 * 
 * Strategy: Instead of asking the model to use `subagent` tool (which maps to 
 * Michi's MCP spawn_branches), we intercept the raw JSON-RPC traffic from the 
 * Codex app-server process to see ALL notifications including thread/started.
 * 
 * We also send a complex task that should naturally trigger Codex's internal
 * subagent spawning (review, compact, etc.) without explicitly mentioning subagents.
 */

const BASE = `http://127.0.0.1:${process.env.PORT || 52249}`;
const WORKSPACE_ID = process.env.MICHI_TEST_WORKSPACE_ID || 'probe-workspace';
const CWD = process.env.MICHI_TEST_CWD || process.cwd();
const TIMEOUT_MS = 120_000;

// A prompt that explicitly asks to use subagents via the `subagent` tool 
// (Michi's spawn_branches), or via Codex's native `use_subagent`
const PROMPT = `Use the subagent tool to spawn exactly 2 parallel agents:
Agent 1: "list the files in the current directory"
Agent 2: "calculate 2+2 and respond with just the answer"
Keep your own response to one sentence.`;

async function apiJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} failed ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed ${res.status}`);
  return res.json();
}

async function streamMessage(nodeId, text, onEvent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const res = await fetch(`${BASE}/api/chats/${encodeURIComponent(nodeId)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: controller.signal,
  });
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`streamMessage failed ${res.status}: ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      let currentEvent = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
        else if (line.startsWith('data: ') && currentEvent) {
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
          onEvent(currentEvent, data);
          currentEvent = null;
        } else if (line === '') currentEvent = null;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') onEvent('_timeout', {});
    else throw err;
  } finally { clearTimeout(timer); }
}

async function main() {
  // Verify we're on Codex
  const status = await apiGet('/api/agent/status');
  console.log(`Runtime: ${status.runtime} (model: ${status.model || status.sanitizedModel || '?'})`);
  if (status.runtime !== 'codex') {
    console.log('Switching to codex...');
    await apiJson('/api/agent/options', { runtime: 'codex' });
    const s2 = await apiGet('/api/agent/status');
    console.log(`Now: ${s2.runtime}`);
  }

  // Allocate node
  const { nodeIds } = await apiJson('/api/node-ids/allocate', { count: 1 });
  const nodeId = nodeIds[0];
  const treeId = `t-codex-native-${Date.now()}`;
  const now = Date.now();

  console.log(`nodeId=${nodeId} treeId=${treeId}`);

  // Ensure session
  const session = await apiJson(`/api/nodes/${encodeURIComponent(nodeId)}/ensure-session`, {
    cwd: CWD,
    workspaceId: WORKSPACE_ID,
    runtimeId: 'codex',
    graphPrerequisite: {
      workspace: { id: WORKSPACE_ID, name: 'michi', cwd: CWD, createdAt: now - 86400000, activeTreeId: treeId },
      tree: { id: treeId, rootNodeId: nodeId, name: 'codex-native-subagent-test', archivedAt: null, pinnedAt: null, lastActiveAt: now, createdAt: now },
      node: { id: nodeId, treeId, parentNodeId: null, kind: 'chat', title: null, spawnedByAgent: false, createdAt: now, currentModeId: null, composerDraft: null },
      edges: [],
    },
  });
  console.log(`session: chatId=${session.chatId} runtime=${session.runtimeId}`);

  // Capture ALL SSE events
  const allEvents = [];
  const interestingTypes = new Set();
  let chunkCount = 0;
  let fullText = '';

  console.log(`\nSending prompt: "${PROMPT.slice(0, 80)}..."`);
  const t0 = Date.now();

  await streamMessage(nodeId, PROMPT, (type, data) => {
    allEvents.push({ type, data, ts: Date.now() });
    if (type === 'chunk') {
      chunkCount++;
      if (data?.text) fullText += data.text;
    } else if (type === 'heartbeat') {
      // skip
    } else {
      // Log everything non-chunk for full visibility
      const brief = JSON.stringify(data).slice(0, 250);
      console.log(`  [${type}] ${brief}`);
      interestingTypes.add(type);
    }
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n═══ Summary (${elapsed}s, ${allEvents.length} events, ${chunkCount} chunks) ═══`);

  // Event type breakdown
  const counts = {};
  for (const e of allEvents) counts[e.type] = (counts[e.type] || 0) + 1;
  for (const [t, c] of Object.entries(counts).sort()) {
    const star = t.includes('subagent') || t.includes('spawn') || t.includes('agent_run') ? ' ⭐' : '';
    console.log(`  ${t}: ${c}${star}`);
  }

  // Check for any subagent indicators
  const subagentIndicators = allEvents.filter(e => 
    e.type.includes('subagent') || 
    e.type.includes('spawn') ||
    e.type.includes('agent_run') ||
    (e.type === 'tool_call' && JSON.stringify(e.data).includes('subagent'))
  );
  console.log(`\nSubagent indicators: ${subagentIndicators.length}`);
  for (const e of subagentIndicators) {
    console.log(`  [${e.type}] ${JSON.stringify(e.data).slice(0, 400)}`);
  }

  // Check for thread_spawn hints in tool calls  
  const toolCalls = allEvents.filter(e => e.type === 'tool_call' || e.type === 'tool_call_update');
  console.log(`\nTool calls: ${toolCalls.length}`);
  for (const e of toolCalls) {
    console.log(`  [${e.type}] title=${e.data.title} status=${e.data.status}`);
    if (e.data.detail) console.log(`    detail: ${String(e.data.detail).slice(0, 300)}`);
    if (e.data.output) console.log(`    output: ${String(e.data.output).slice(0, 300)}`);
  }

  console.log(`\nAssistant text (${fullText.length} chars): ${fullText.slice(0, 500)}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
