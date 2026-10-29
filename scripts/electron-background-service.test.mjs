import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const service = require("../electron/dist/backgroundService.js");
const notifications = require("../electron/dist/scheduledNotifications.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "michi-service-test-"));
}

const baseSpecInput = {
  nodeExecPath: "/Applications/michi.app/Contents/Frameworks/michi Helper.app/Contents/MacOS/michi Helper",
  entry: "/Applications/michi.app/Contents/Resources/app.asar/backend/dist/server.js",
  port: 51234,
  logDir: "/Users/test/.michi/logs",
  bundlePath: "/Applications/michi.app",
  build: "1.0.0-123",
  baseEnv: {
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/Users/test",
    LANG: "en_US.UTF-8",
    MICHI_DATA_DIR: "/Users/test/.michi",
    ANTHROPIC_API_KEY: "must-not-leak",
    MICHI_REMOTE_TOKEN: "must-not-leak",
  },
};

test("launch spec runs the bundled backend as a loopback service", () => {
  const spec = service.buildServiceLaunchSpec({ ...baseSpecInput, defaultRuntime: "pi" });
  assert.equal(spec.label, "com.michi.backend");
  assert.equal(spec.program, baseSpecInput.nodeExecPath);
  assert.deepEqual(spec.args, [baseSpecInput.entry]);
  assert.equal(spec.workingDirectory, "/");
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spec.env.PORT, "51234");
  assert.equal(spec.env.MICHI_BIND_HOST, "127.0.0.1");
  assert.equal(spec.env.MICHI_REMOTE_ACCESS, "0");
  assert.equal(spec.env.MICHI_SERVICE_MODE, "1");
  assert.equal(spec.env.MICHI_SERVICE_BUILD, "1.0.0-123");
  assert.equal(spec.env.MICHI_APP_BUNDLE, "/Applications/michi.app");
  assert.equal(spec.env.PATH, "/opt/homebrew/bin:/usr/bin");
  assert.equal(spec.env.MICHI_DATA_DIR, "/Users/test/.michi");
  assert.equal(spec.env.MICHI_DEFAULT_RUNTIME, "pi");
  // Secrets stay out of the plist; the backend reads ~/.michi/.env itself.
  assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spec.env.MICHI_REMOTE_TOKEN, undefined);
  assert.equal(spec.stderrPath, "/Users/test/.michi/logs/service.err.log");
});

test("the service does not forward retired external Desk configuration", () => {
  const spec = service.buildServiceLaunchSpec({
    ...baseSpecInput,
    baseEnv: {
      ...baseSpecInput.baseEnv,
      MICHI_DESK_URL: "http://127.0.0.1:4318",
      AGENT_DESK_DATA_DIR: "/Users/test/michi-data",
      AGENT_DESK_TOKEN_FILE: "/Users/test/michi-data/api-token",
      MICHI_DESK: "0",
    },
  });
  assert.equal(spec.env.MICHI_DESK_URL, undefined);
  assert.equal(spec.env.AGENT_DESK_DATA_DIR, undefined);
  assert.equal(spec.env.AGENT_DESK_TOKEN_FILE, undefined);
  assert.equal(spec.env.MICHI_DESK, undefined);
  assert.equal(spec.env.HOME, "/Users/test", "runtime tools retain the user home");
  assert.equal(spec.env.MICHI_BIND_HOST, "127.0.0.1", "the service remains local");
  assert.equal(spec.env.MICHI_REMOTE_ACCESS, "0");
});

test("an explicit default runtime wins over the pi fallback", () => {
  const spec = service.buildServiceLaunchSpec({
    ...baseSpecInput,
    baseEnv: { ...baseSpecInput.baseEnv, MICHI_DEFAULT_RUNTIME: "claude" },
    defaultRuntime: "pi",
  });
  assert.equal(spec.env.MICHI_DEFAULT_RUNTIME, "claude");
});

test("rendered plist is valid and escapes values", { skip: process.platform !== "darwin" }, () => {
  const dir = tempDir();
  try {
    const spec = service.buildServiceLaunchSpec({ ...baseSpecInput, entry: "/tmp/a&b<c>/server.js" });
    const file = path.join(dir, "test.plist");
    fs.writeFileSync(file, service.renderPlist(spec));
    execFileSync("/usr/bin/plutil", ["-lint", file]);
    const parsed = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    assert.equal(parsed.Label, "com.michi.backend");
    assert.deepEqual(parsed.ProgramArguments, [spec.program, "/tmp/a&b<c>/server.js"]);
    assert.equal(parsed.KeepAlive, true);
    assert.equal(parsed.RunAtLoad, true);
    assert.equal(parsed.EnvironmentVariables.PORT, "51234");
    assert.equal(parsed.WorkingDirectory, "/");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("service state round-trips and rejects malformed files", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "nested", "service.json");
    assert.equal(service.readServiceState(file), null);
    service.writeServiceState(file, { enabled: true, port: 4100 });
    assert.deepEqual(service.readServiceState(file), { enabled: true, port: 4100 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, JSON.stringify({ enabled: "yes", port: 4100 }));
    assert.equal(service.readServiceState(file), null);
    fs.writeFileSync(file, JSON.stringify({ enabled: true, port: 70000 }));
    assert.equal(service.readServiceState(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("helpers derive bundle path, build stamp and the backend server id", () => {
  assert.equal(service.appBundlePath("/Users/me/Applications/michi.app/Contents/MacOS/michi"), "/Users/me/Applications/michi.app");
  assert.equal(service.appBundlePath("/usr/local/bin/electron"), null);
  const expected = createHash("sha256").update("/data/michi").digest("hex").slice(0, 16);
  assert.equal(service.expectedServerId({ MICHI_DATA_DIR: "/data/michi" }, "/home/x"), expected);
  assert.equal(
    service.expectedServerId({}, "/home/x"),
    createHash("sha256").update(path.join("/home/x", ".michi")).digest("hex").slice(0, 16),
  );
  assert.equal(service.serviceBuildStamp("/definitely/missing", "2.0.0"), "2.0.0");
});

function fakeLaunchctl(script = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const handler = script[args[0]];
    if (typeof handler === "function") return handler(args, calls);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("install writes the plist, boots out a loaded copy, then bootstraps", async () => {
  const dir = tempDir();
  try {
    const plistFile = path.join(dir, "LaunchAgents", "com.michi.backend.plist");
    const spec = service.buildServiceLaunchSpec({ ...baseSpecInput, logDir: path.join(dir, "logs") });
    const { run, calls } = fakeLaunchctl({ print: (_args, seen) => ({ code: seen.some((call) => call[0] === "bootout") ? 113 : 0, stdout: "", stderr: "" }) });
    await service.installAndStartService({ spec, run, uid: 501, plistFile, delay: async () => {} });
    assert.deepEqual(calls.map((args) => args[0]), ["print", "bootout", "print", "bootstrap", "enable"]);
    assert.deepEqual(calls[3], ["bootstrap", "gui/501", plistFile]);
    assert.match(fs.readFileSync(plistFile, "utf8"), /<string>com\.michi\.backend<\/string>/);
    assert.ok(fs.existsSync(path.join(dir, "logs")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("install retries a failed bootstrap once and then reports the error", async () => {
  const dir = tempDir();
  try {
    const plistFile = path.join(dir, "com.michi.backend.plist");
    const spec = service.buildServiceLaunchSpec({ ...baseSpecInput, logDir: dir });
    let attempts = 0;
    const retried = fakeLaunchctl({
      print: () => ({ code: 113, stdout: "", stderr: "not found" }),
      bootstrap: () => ({ code: ++attempts === 1 ? 5 : 0, stdout: "", stderr: "Input/output error" }),
    });
    await service.installAndStartService({ spec, run: retried.run, uid: 501, plistFile, delay: async () => {} });
    assert.equal(attempts, 2);

    const failing = fakeLaunchctl({
      print: () => ({ code: 113, stdout: "", stderr: "" }),
      bootstrap: () => ({ code: 5, stdout: "", stderr: "Bootstrap failed: 5" }),
    });
    await assert.rejects(
      service.installAndStartService({ spec, run: failing.run, uid: 501, plistFile, delay: async () => {} }),
      /Bootstrap failed: 5/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stop boots out a loaded service and removes the plist when asked", async () => {
  const dir = tempDir();
  try {
    const plistFile = path.join(dir, "com.michi.backend.plist");
    fs.writeFileSync(plistFile, "x");
    const { run, calls } = fakeLaunchctl({ print: (_args, seen) => ({ code: seen.some((call) => call[0] === "bootout") ? 113 : 0, stdout: "", stderr: "" }) });
    await service.stopService({ run, uid: 501, plistFile, removePlist: true, delay: async () => {} });
    assert.deepEqual(calls[1], ["bootout", "gui/501/com.michi.backend"]);
    assert.equal(fs.existsSync(plistFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SSE parser handles split chunks, comments and CRLF", () => {
  const events = [];
  const parse = notifications.createSseParser((event, data) => events.push([event, data]));
  parse(": keepalive\n\nevent: scheduled_job_run\r\ndata: {\"a\"");
  parse(":1}\r\n\r\ndata: plain\n\n");
  assert.deepEqual(events, [["scheduled_job_run", "{\"a\":1}"], ["message", "plain"]]);
});

const notice = {
  phase: "finished", runId: "run-1", jobId: "job-1", jobName: "Digest", workspaceId: "ws-1",
  nodeId: "n-1", treeId: "t-1", status: "succeeded", summary: "All quiet", error: null, notify: true, at: 1,
};

test("describeNotice words finished, failed and attention notices", () => {
  assert.deepEqual(notifications.describeNotice(notice), { title: "Digest", subtitle: "Scheduled job finished", body: "All quiet" });
  assert.equal(notifications.describeNotice({ ...notice, status: "failed", error: "boom" }).body, "boom");
  assert.equal(notifications.describeNotice({ ...notice, notify: false }), null);
  assert.equal(notifications.describeNotice({ ...notice, status: "cancelled" }), null);
  assert.equal(notifications.describeNotice({ ...notice, phase: "attention", attention: "input", notify: false }).subtitle, "Needs your input");
});

test("planNoticeDelivery skips notices that are not shown", () => {
  const env = { hasFocusedWindow: true, osNotificationsSupported: true };
  assert.deepEqual(notifications.planNoticeDelivery({ ...notice, phase: "started" }, env), { kind: "skip", ack: false });
  assert.deepEqual(notifications.planNoticeDelivery({ ...notice, notify: false }, env), { kind: "skip", ack: true });
});

test("planNoticeDelivery shows only an in-app toast while a window is focused", () => {
  const content = notifications.describeNotice(notice);
  for (const osNotificationsSupported of [true, false]) {
    assert.deepEqual(
      notifications.planNoticeDelivery(notice, { hasFocusedWindow: true, osNotificationsSupported }),
      { kind: "toast", ack: true, content },
    );
  }
});

test("planNoticeDelivery uses an OS banner when no window is focused", () => {
  assert.deepEqual(
    notifications.planNoticeDelivery(notice, { hasFocusedWindow: false, osNotificationsSupported: true }),
    { kind: "banner", ack: true, content: notifications.describeNotice(notice) },
  );
});

test("planNoticeDelivery defers without acknowledging when nothing can show the notice", () => {
  const plan = notifications.planNoticeDelivery(notice, { hasFocusedWindow: false, osNotificationsSupported: false });
  assert.deepEqual(plan, { kind: "defer", ack: false });
});

test("notification feed replays notices, reconnects and acknowledges", async () => {
  const acks = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      acks.push(req.url);
      res.end("{}");
      return;
    }
    connections += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: scheduled_job_run\ndata: ${JSON.stringify({ ...notice, runId: `run-${connections}` })}\n\n`);
    // Drop the first connection to exercise reconnect.
    if (connections === 1) setTimeout(() => res.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const seen = [];
  const feed = new notifications.ScheduledNotificationFeed({
    port: () => port,
    onNotice: (value) => {
      seen.push(value.runId);
      feed.acknowledge(value.runId);
    },
    reconnectBaseMs: 10,
  });
  try {
    feed.start();
    const deadline = Date.now() + 3000;
    while ((seen.length < 2 || acks.length < 2) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, ["run-1", "run-2"]);
    assert.deepEqual(acks.sort(), ["/api/scheduled-jobs/runs/run-1/notified", "/api/scheduled-jobs/runs/run-2/notified"]);
  } finally {
    feed.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
