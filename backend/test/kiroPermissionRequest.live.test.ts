/**
 * Records where real kiro-cli puts the tool name in session/request_permission.
 *
 * Explicit opt-in only: an authenticated kiro-cli, provider credits.
 *   MICHI_KIRO_PERMISSION_CAPTURE=v2,v3 npm exec -w backend -- node --require ts-node/register \
 *     --test test/kiroPermissionRequest.live.test.ts
 *
 * Every request is cancelled, so no tool runs. The test prints each
 * request's params and the tool_call updates for the same call, with paths
 * and ids replaced, the order they arrived in, and checks that wherever
 * Kiro names the tool, Michi reads that name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { kiroEnvOptions } from '../src/agents/michiKiroOptions';
import { acpPermissionToolName, canonicalKiroToolName } from 'michi-runtime/internal/adapters/kiro/kiroToolNames';

const enabled = (process.env.MICHI_KIRO_PERMISSION_CAPTURE ?? '').split(',');

function redact(value: unknown, replacements: Array<[string, string]>): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const [from, to] of replacements) text = text.split(from).join(to);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, replacements)]));
  }
  return value;
}

/** Values of every tool-name-like field, options excluded. */
function toolNameFields(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value)) {
    if (/^tool_?name$/i.test(key) && typeof item === 'string') found.push(item);
    else if (key !== 'options') toolNameFields(item, found);
  }
  return found;
}

for (const engine of ['v2', 'v3'] as const) {
  test(`real Kiro ${engine}: the tool name in session/request_permission`, {
    skip: !enabled.includes(engine), timeout: 240_000,
  }, async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `michi-kiro-permission-${engine}-`)));
    const client = new AcpClient(undefined, cwd, undefined, engine, undefined, 'kiro', kiroEnvOptions());
    const internal = client as unknown as { dispatch(message: any): void };
    const dispatch = internal.dispatch.bind(client);
    const raw: any[] = [];
    const toolUpdates: any[] = [];
    /** Arrival order of requests and tool_call updates: kind and toolCallId. */
    const arrivals: Array<{ kind: string; toolCallId?: string }> = [];
    internal.dispatch = (message) => {
      if (message?.method === 'session/request_permission') {
        raw.push(message.params);
        arrivals.push({ kind: 'request_permission', toolCallId: message.params?.toolCall?.toolCallId });
      }
      const update = message?.method === 'session/update' ? message.params?.update : undefined;
      if (update?.toolCallId && ['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        toolUpdates.push(update);
        arrivals.push({ kind: `${update.sessionUpdate}${update.status ? `(${update.status})` : ''}`, toolCallId: update.toolCallId });
      }
      dispatch(message);
    };
    try {
      client.start();
      await client.initialize(60_000);
      const { sessionId } = await client.newSession();
      const updates: any[] = [];
      const prompts = [
        'Use your shell tool to run exactly `echo MICHI_PERMISSION_PROBE`. If it is denied, stop.',
        'Use your file writing tool to create probe.txt containing hi. If it is denied, stop.',
      ];
      for (const prompt of prompts) {
        for await (const update of client.prompt(sessionId, prompt)) {
          if ((update as any).sessionUpdate !== 'permission_request') continue;
          updates.push(update);
          client.cancelPermission((update as any).requestId);
        }
      }
      const replacements: Array<[string, string]> = [[cwd, '<cwd>'], [os.homedir(), '<home>'], [sessionId, '<sessionId>']];
      for (const params of raw) {
        console.info(`${engine} request_permission params: ${JSON.stringify(redact(params, replacements), null, 2)}`);
        const calls = toolUpdates.filter((update) => update.toolCallId === params.toolCall?.toolCallId);
        console.info(`${engine} tool_call updates for it: ${JSON.stringify(redact(calls, replacements), null, 2)}`);
        const order = arrivals.filter((arrival) => arrival.toolCallId === params.toolCall?.toolCallId).map((arrival) => arrival.kind);
        console.info(`${engine} arrival order for it: ${order.join(' -> ')}`);
      }
      assert.ok(updates.length > 0, 'the prompts produced a permission request');
      for (const update of updates) {
        const name = acpPermissionToolName(update.toolCall, update._meta);
        console.info(`${engine} name: ${JSON.stringify(name)} canonical: ${JSON.stringify(name && canonicalKiroToolName(name))} title: ${JSON.stringify(redact(update.toolCall?.title, replacements))}`);
        // Wherever Kiro names the tool, Michi must read that name.
        const named = toolNameFields({ toolCall: update.toolCall, _meta: update._meta });
        if (named.length > 0) assert.equal(name, named[0], `Michi reads the tool name Kiro sent: ${JSON.stringify(named)}`);
      }
    } finally {
      await client.shutdown();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
