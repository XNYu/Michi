#!/usr/bin/env node
/**
 * Capture raw SSE events from Claude Code and Codex runtimes
 * to measure actual subagent data available.
 *
 * Usage: node tests/subagent-cc-codex.mjs [claude|codex]
 */

const BASE = `http://127.0.0.1:${process.env.PORT || 52249}`;
const WORKSPACE_ID = process.env.MICHI_TEST_WORKSPACE_ID || 'probe-workspace';
const CWD = process.env.MICHI_TEST_CWD || process.cwd();

// Claude Code uses "Task" tool natively — we need to ask it to spawn subagents
// in a way that triggers the Task tool (which is Claude's built-in parallel execution)
const CLAUDE_PROMPT = `I need you to do two things IN PARALLEL using separate Task agents:
1. Task 1: List the files in the current directory
2. Task 2: Read the contents of package.json and tell me the project name

Use your Task tool to spawn these as parallel subagents. Keep your own response very short after they complete.`;

// Codex spawns subagents via use_subagent / thread_spawn
const CODEX_PROMPT = `I need you to do two things in parallel using subagents:
1. Subagent 1: List the files in the current directory
2. Subagent 2: Read the contents of package.json and tell me the project name

Spawn these as parallel subagents. Keep your own response very short.`;

const TIMEOUT_MS = 240_000; // 4 min — CC can be slow to warm

const ALL_INTERESTING_EVENTS = new Set([
  'subagent_list_update',
  'subagent_tool_activity',
  'agent_run_created',
  'agent_run_updated',
  'spawn_branches',
  'tool_call',
  'tool_call_update',
  'permission_request',
  'ask_user',
  'error',
  'done',
  'title',
  'branch_overview',
  'follow_ups',
  'thinking',
  'plan',
  'image',
  'commands',
]);

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
      onEvent('_timeout', { message: 'Stream timed out after ' + TIMEOUT_MS + 'ms' });
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function testRuntime(runtime) {
  const prompt = runtime === 'claude' ? CLAUDE_PROMPT : CODEX_PROMPT;
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TESTING RUNTIME: ${runtime.toUpperCase()}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Prompt: ${prompt.slice(0, 120)}...`);

  const allEvents = [];
  const interestingEvents = [];
  let chunkCount = 0;
  let thinkingChunks = 0;
  let fullAssistantText = '';
  let fullThinkingText = '';
  const startTime = Date.now();

  try {
    const nodeId = await allocateNodeId();
    const treeId = `t-test-${Date.now()}-${runtime}`;
    console.log(`  nodeId=${nodeId}  treeId=${treeId}`);

    console.log(`\n→ Ensuring session (runtime=${runtime})...`);
    const sessionResult = await ensureSession(nodeId, runtime, treeId);
    console.log(`  chatId=${sessionResult.chatId}  resume=${sessionResult.resumeStrategy || 'new'}`);

    console.log(`\n→ Sending prompt... (timeout=${TIMEOUT_MS/1000}s)`);

    await streamMessage(nodeId, prompt, (eventType, data) => {
      const entry = { eventType, data, ts: Date.now() - startTime };
      allEvents.push(entry);

      if (eventType === 'chunk') {
        chunkCount++;
        if (data?.text) fullAssistantText += data.text;
      } else if (eventType === 'thinking') {
        thinkingChunks++;
        if (data?.text) fullThinkingText += data.text;
      } else if (eventType === 'heartbeat' || eventType === 'turn_started') {
        // skip
      } else {
        interestingEvents.push(entry);
        const marker = ALL_INTERESTING_EVENTS.has(eventType) ? '⭐' : '📎';
        const preview = JSON.stringify(data);
        console.log(`  ${marker} [${eventType}] +${Math.round(entry.ts/1000)}s  ${preview.slice(0, 400)}`);
      }
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Summary ──
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`EVENT SUMMARY (${elapsed}s, ${chunkCount} chunks + ${thinkingChunks} thinking omitted)`);
    console.log('─'.repeat(50));
    const eventCounts = {};
    for (const e of allEvents) {
      eventCounts[e.eventType] = (eventCounts[e.eventType] || 0) + 1;
    }
    for (const [type, count] of Object.entries(eventCounts).sort()) {
      const isSubagent = type.startsWith('subagent') || type === 'spawn_branches' || type.startsWith('agent_run');
      console.log(`  ${isSubagent ? '🔥' : '  '} ${type}: ${count}`);
    }

    // ── Subagent-specific deep dive ──
    const subagentEvents = allEvents.filter(e =>
      e.eventType.startsWith('subagent') || e.eventType === 'spawn_branches' || e.eventType.startsWith('agent_run')
    );
    
    if (subagentEvents.length > 0) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`SUBAGENT EVENTS DETAIL (${subagentEvents.length})`);
      console.log('─'.repeat(50));
      for (const e of subagentEvents) {
        console.log(`\n  [${e.eventType}] +${Math.round(e.ts/1000)}s`);
        const pretty = JSON.stringify(e.data, null, 2);
        if (pretty.length > 2000) {
          console.log('    ' + pretty.slice(0, 2000).split('\n').join('\n    ') + '\n    ... (truncated)');
        } else {
          console.log('    ' + pretty.split('\n').join('\n    '));
        }
      }
    } else {
      console.log(`\n  ⚠️  NO SUBAGENT EVENTS RECEIVED`);
    }

    // ── Tool calls deep dive ──
    const toolEvents = allEvents.filter(e => e.eventType === 'tool_call' || e.eventType === 'tool_call_update');
    if (toolEvents.length > 0) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`TOOL CALL EVENTS (${toolEvents.length})`);
      console.log('─'.repeat(50));
      for (const e of toolEvents) {
        const pretty = JSON.stringify(e.data, null, 2);
        console.log(`\n  [${e.eventType}] +${Math.round(e.ts/1000)}s`);
        console.log('    ' + pretty.slice(0, 1500).split('\n').join('\n    '));
      }
    }

    // ── Assistant text ──
    if (fullAssistantText.length > 0) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`ASSISTANT TEXT (${fullAssistantText.length} chars)`);
      console.log('─'.repeat(50));
      console.log(fullAssistantText.slice(0, 1000));
      if (fullAssistantText.length > 1000) console.log('  ...(truncated)');
    }

    return { runtime, allEvents, subagentEvents, eventCounts, chunkCount, elapsed };
  } catch (err) {
    console.error(`  ❌ Error testing ${runtime}: ${err.message}`);
    return { runtime, error: err.message };
  }
}

async function main() {
  const requestedRuntime = process.argv[2];
  const status = await apiGet('/api/agent/status');
  console.log(`Available: ${status.availableRuntimes.filter(r => r.available).map(r => r.id).join(', ')}`);

  const runtimesToTest = requestedRuntime
    ? [requestedRuntime]
    : ['claude', 'codex'];

  const results = [];
  for (const rt of runtimesToTest) {
    const rtInfo = status.availableRuntimes.find(r => r.id === rt);
    if (!rtInfo?.available) {
      console.log(`\nSkipping ${rt} — not available`);
      continue;
    }
    results.push(await testRuntime(rt));
  }

  console.log(`\n\n${'='.repeat(70)}`);
  console.log('FINAL COMPARISON');
  console.log('='.repeat(70));
  for (const r of results) {
    console.log(`\n${r.runtime}:`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
    } else {
      console.log(`  Time: ${r.elapsed}s`);
      console.log(`  Total events: ${r.allEvents.length} (${r.chunkCount} chunks)`);
      const subCount = r.subagentEvents?.length || 0;
      console.log(`  Subagent events: ${subCount}`);
      if (subCount > 0) {
        const types = [...new Set(r.subagentEvents.map(e => e.eventType))];
        console.log(`  Subagent event types: ${types.join(', ')}`);
      }
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
