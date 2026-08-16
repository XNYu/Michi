#!/usr/bin/env node
"use strict";

const fs = require("fs");

const argvPath = process.env.FAKE_ACP_ARGV;
if (argvPath) {
  fs.writeFileSync(argvPath, JSON.stringify(process.argv.slice(2)));
}

const received = [];
const logPath = process.env.FAKE_ACP_LOG;
function persist() {
  if (logPath) fs.writeFileSync(logPath, JSON.stringify(received, null, 2));
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const profile = process.env.FAKE_ACP_PROFILE || "kiro";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    received.push(msg);
    persist();
    handle(msg);
  }
});

function handle(msg) {
  if (msg.method === "initialize") {
    const result = { protocolVersion: msg.params && msg.params.protocolVersion };
    if (profile === "cursor") {
      result.authMethods = [{ id: "cursor_login" }];
    }
    if (profile === "grok") {
      result.authMethods = process.env.FAKE_GROK_AUTH_METHODS
        ? JSON.parse(process.env.FAKE_GROK_AUTH_METHODS)
        : [{ id: "xai.api_key" }, { id: "cached_token" }];
    }
    if (process.env.FAKE_ACP_AGENT_CAPS) {
      result.agentCapabilities = JSON.parse(process.env.FAKE_ACP_AGENT_CAPS);
    }
    send({ jsonrpc: "2.0", id: msg.id, result });
    return;
  }
  if (msg.method === "authenticate") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: "sess-1", modes: { availableModes: [], currentModeId: "agent" }, models: { availableModels: [] } },
    });
    if (process.env.FAKE_ACP_EMIT === "permission") {
      send({
        jsonrpc: "2.0",
        id: 9001,
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          toolCall: { toolCallId: "t1", title: "Edit file" },
          options: [
            { optionId: "allow-once", name: "Allow once" },
            { optionId: "allow-always", name: "Allow always" },
            { optionId: "reject-once", name: "Reject" },
          ],
        },
      });
    }
    if (process.env.FAKE_ACP_EMIT === "ask_question") {
      send({
        jsonrpc: "2.0",
        id: 9002,
        method: "cursor/ask_question",
        params: {
          sessionId: "sess-1",
          toolCallId: "call_123",
          title: "Need input",
          questions: [
            {
              id: "q1",
              prompt: "Which mode should I use?",
              options: [
                { id: "agent", label: "Agent" },
                { id: "plan", label: "Plan" },
              ],
              allowMultiple: false,
            },
          ],
        },
      });
    }
    return;
  }
  if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { modes: {}, models: {} } });
    return;
  }
  if (msg.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}

process.stdin.on("end", persist);
