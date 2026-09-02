#!/usr/bin/env node
/**
 * Capture raw SSE events from Michi backend when subagent activity occurs.
 * Tests each available runtime to see what subagent data actually arrives.
 *
 * Usage: node tests/subagent-data-capture.mjs [runtime]
 */

const BASE = `http://127.0.0.1:${process.env.PORT || 52249}`;
const WORKSPACE_ID = process.env.MICHI_TEST_WORKSPACE_ID || 'probe-workspace';
const CWD = process.env.MICHI_TEST_CWD || process.cwd();

const SUBAGENT_PROMPT = `Use the subagent tool to spawn exactly 2 branches in parallel:
Branch 1: "list the files in the current directory using the ls command"
Branch 2: "what is 2+2"
Keep your own response very short.`;

const TIMEOUT_MS = 180_000;

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

async function allocateNodeId() {
  const { nodeIds } = await apiJson('/api/node-ids/allocate', { count: 1 });
  return nodeIds[0];
}

async function ensureSession(nodeId, runtimeId, treeId) {
  const now = Date.now();
  return apiJson(`/api/nodes/${encodeURIComponent(nodeId)}/ensure-session`, {
    cwd: CWD,
    workspaceId: WORKSPACE_ID,
    runtimeId,
    graphPrerequisite: {
      workspace: {
        id: WORKSPACE_ID,
        name: 'michi',
        cwd: CWD,
        createdAt: now - 86400000,
        activeTreeId: treeId,
      },
      tree: {
        id: treeId,
        rootNodeId: nodeId,
        name: `subagent-test-${runtimeId}`,
        archivedAt: null,
        pinnedAt: null,
        lastActiveAt: now,
        createdAt: now,
      },
      node: {
        id: nodeId,
        treeId: treeId,
        parentNodeId: null,
        kind: 'chat',
        title: null,
        spawnedByAgent: false,
        createdAt: now,
        currentModeId: null,
        composerDraft: null,
      },
      edges: [],
    },
  });
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
    const t = await res.text();
    throw new Error(`streamMessage failed ${res.status}: ${t}`);
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
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ') && currentEvent) {
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
          onEvent(currentEvent, data);
          currentEvent = null;
        } else if (line === '') {
          currentEvent = null;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      onEvent('_timeout', { message: 'Stream timed out' });
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

const SUBAGENT_EVENT_TYPES = new Set([
  'subagent_list_update',
  'subagent_tool_activity',
  'agent_run_created',
  'agent_run_updated',
  'spawn_branches',
  'tool_call',
  'tool_call_update',
]);

async function testRuntime(runtime) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TESTING RUNTIME: ${runtime}`);
  console.log('='.repeat(60));

  const allEvents = [];
  const subagentEvents = [];
  let chunkCount = 0;
  let fullAssistantText = '';

  try {
    const nodeId = await allocateNodeId();
    const treeId = `t-test-${Date.now()}-${runtime}`;
    console.log(`  nodeId=${nodeId}  treeId=${treeId}`);

    console.log(`\n→ Ensuring session with runtime=${runtime}...`);
    const sessionResult = await ensureSession(nodeId, runtime, treeId);
    console.log(`  chatId=${sessionResult.chatId}  resume=${sessionResult.resumeStrategy || 'new'}`);

    console.log(`\n→ Sending subagent prompt...`);

    await streamMessage(nodeId, SUBAGENT_PROMPT, (eventType, data) => {
      const entry = { eventType, data, ts: Date.now() };
      allEvents.push(entry);

      if (SUBAGENT_EVENT_TYPES.has(eventType)) {
        subagentEvents.push(entry);
        console.log(`  📡 [${eventType}]`, JSON.stringify(data).slice(0, 300));
      } else if (eventType === 'chunk') {
        chunkCount++;
        if (data?.text) fullAssistantText += data.text;
      } else if (eventType === 'done' || eventType === 'error' || eventType === '_timeout') {
        console.log(`  ⏹ [${eventType}]`, JSON.stringify(data).slice(0, 200));
      } else if (eventType === 'title') {
        console.log(`  📝 [title]`, JSON.stringify(data).slice(0, 100));
      } else if (eventType === 'permission_request') {
        console.log(`  🔐 [permission_request]`, JSON.stringify(data).slice(0, 200));
      } else if (eventType === 'heartbeat' || eventType === 'turn_started') {
        // skip
      } else {
        console.log(`  📎 [${eventType}]`, JSON.stringify(data).slice(0, 200));
      }
    });

    // Summary
    console.log(`\n── Event Summary (${chunkCount} chunks omitted) ──`);
    const eventCounts = {};
    for (const e of allEvents) {
      eventCounts[e.eventType] = (eventCounts[e.eventType] || 0) + 1;
    }
    for (const [type, count] of Object.entries(eventCounts).sort()) {
      const marker = SUBAGENT_EVENT_TYPES.has(type) ? ' ⭐' : '';
      console.log(`  ${type}: ${count}${marker}`);
    }

    if (fullAssistantText.length > 0) {
      console.log(`\n── Assistant text (${fullAssistantText.length} chars) ──`);
      console.log(fullAssistantText.slice(0, 500));
      if (fullAssistantText.length > 500) console.log('  ...(truncated)');
    }

    console.log(`\n── Subagent-Specific Events (${subagentEvents.length} total) ──`);
    for (const e of subagentEvents) {
      console.log(`\n  [${e.eventType}]`);
      const pretty = JSON.stringify(e.data, null, 2);
      if (pretty.length > 1500) {
        console.log('    ' + pretty.slice(0, 1500) + '\n    ... (truncated)');
      } else {
        console.log('    ' + pretty.split('\n').join('\n    '));
      }
    }

    return { runtime, allEvents, subagentEvents, eventCounts, chunkCount };
  } catch (err) {
    console.error(`  ❌ Error testing ${runtime}: ${err.message}`);
    return { runtime, error: err.message, allEvents, subagentEvents: [] };
  }
}

async function main() {
  const requestedRuntime = process.argv[2];
  const status = await apiGet('/api/agent/status');
  console.log(`Default runtime: ${status.runtime} (model: ${status.model})`);
  console.log(`Available: ${status.availableRuntimes.filter(r => r.available).map(r => r.id).join(', ')}`);

  const runtimesToTest = requestedRuntime ? [requestedRuntime] : ['kiro', 'claude', 'codex'];
  const results = [];

  for (const rt of runtimesToTest) {
    const rtInfo = status.availableRuntimes.find(r => r.id === rt);
    if (!rtInfo?.available) {
      console.log(`\nSkipping ${rt} — not available`);
      continue;
    }
    results.push(await testRuntime(rt));
  }

  console.log(`\n\n${'='.repeat(60)}`);
  console.log('COMPARISON SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`\n${r.runtime}:`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
    } else {
      console.log(`  Total events: ${r.allEvents.length} (${r.chunkCount} chunks)`);
      console.log(`  Subagent events: ${r.subagentEvents.length}`);
      const types = [...new Set(r.subagentEvents.map(e => e.eventType))];
      console.log(`  Subagent event types: ${types.join(', ') || '(none)'}`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
