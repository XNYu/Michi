/**
 * Kiro's AcpProfile. Replaces the public repository's "bit-identical
 * contract" profile test (acpProfiles.test.ts), whose protocolVersion
 * "2025-01-01" and `acp -a` argv kiro-cli is never sent.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { acpShouldAttachMcp } from "../src/adapters/acp/types";
import { KiroAcpProfile } from "../src/adapters/kiro/kiroAcpProfile";

const base = { binaryPath: "/bin/false", cwd: "/tmp" };

describe("Kiro's ACP profile", () => {
    test("protocol version 1, checked; Michi's client info; no capabilities; no authenticate", () => {
        const profile = new KiroAcpProfile(base);
        assert.equal(profile.protocolVersion, 1);
        assert.equal(profile.requireProtocolVersion, true);
        assert.equal((profile as { buildAuthenticate?: unknown }).buildAuthenticate, undefined);
        assert.equal((profile as { preflight?: unknown }).preflight, undefined);
        assert.deepEqual(profile.clientInfo, { name: "michi", version: "1.0.0" });
        assert.deepEqual(profile.clientCapabilities, {});
    });

    test("Crew keeps Kiro's log label and name", () => {
        const kiro = new KiroAcpProfile(base);
        const crew = new KiroAcpProfile({ ...base, runtimeId: "crew", launch: { bin: "/crew", args: () => [] } });
        assert.deepEqual([kiro.runtimeId, kiro.logLabel, kiro.displayName], ["kiro", "kiro", "Kiro"]);
        assert.deepEqual([crew.runtimeId, crew.logLabel, crew.displayName], ["crew", "kiro", "Kiro"]);
    });

    test("argv by engine; v3 never puts the model on argv", () => {
        assert.deepEqual(new KiroAcpProfile(base).spawnArgs, ["acp", "--agent-engine", "v2"]);
        assert.deepEqual(new KiroAcpProfile({ ...base, model: "m" }).spawnArgs, ["acp", "--agent-engine", "v2", "--model", "m"]);
        assert.deepEqual(new KiroAcpProfile({ ...base, model: "m", engine: "v3" }).spawnArgs, ["acp", "--agent-engine", "v3", "--auth-method", "cli"]);
    });

    test("a launch override's argv is resolved at every read", () => {
        const models: Array<string | undefined> = [];
        const profile = new KiroAcpProfile({ ...base, model: "m", launch: { bin: "/crew", args: (model) => { models.push(model); return ["crew-acp", String(models.length)]; } } });
        assert.deepEqual(profile.spawnArgs, ["crew-acp", "1"]);
        assert.deepEqual(profile.spawnArgs, ["crew-acp", "2"]);
        assert.deepEqual(models, ["m", "m"]);
    });

    test("Michi's MCP slot is always attached", () => {
        const profile = new KiroAcpProfile(base);
        assert.equal(profile.mcpAttach, "always");
        assert.equal(acpShouldAttachMcp(profile.mcpAttach, { agentCapabilities: {} }), true);
    });

    test("cancel deadline: 5 seconds, or the launch override's", () => {
        assert.equal(new KiroAcpProfile(base).cancelTimeoutMs, 5_000);
        assert.equal(new KiroAcpProfile({ ...base, launch: { bin: "/crew", args: () => [], cancelTimeoutMs: 40 } }).cancelTimeoutMs, 40);
    });

    test("session params: v3's _meta.kiro (the cold-start model on new), then the caller's metadata", () => {
        const v2 = new KiroAcpProfile({ ...base, model: "m" });
        const v3 = new KiroAcpProfile({ ...base, model: "m", engine: "v3" });
        assert.deepEqual(v2.sessionParams("new", {}), {});
        assert.deepEqual(v2.sessionParams("new", { metadata: { chatId: "c" } }), { _meta: { chatId: "c" } });
        assert.deepEqual(v3.sessionParams("new", {}), { _meta: { kiro: { modelId: "m" } } });
        assert.deepEqual(v3.sessionParams("new", { modeId: "planner", workflowsEnabled: true }),
            { _meta: { kiro: { modelId: "m", modeId: "planner", settings: { workflows: { enabled: true } } } } });
        // With metadata, `_meta` is rebuilt from the options alone: the cold-start model drops out.
        assert.deepEqual(v3.sessionParams("new", { metadata: { chatId: "c" } }), { _meta: { kiro: {}, chatId: "c" } });
        assert.deepEqual(v3.sessionParams("load", {}), { _meta: { kiro: {} } }, "load does not add the cold-start model");
        assert.deepEqual(v3.sessionParams("load", { modelId: "x", metadata: { chatId: "c" } }), { _meta: { kiro: { modelId: "x" }, chatId: "c" } });
    });

    test("session info: v3 config options also answer as models and modes", () => {
        const info = new KiroAcpProfile(base).normalizeSessionInfo({ configOptions: [
            { id: "model", type: "select", currentValue: "m1", options: [{ value: "m1", name: "One" }] },
            { id: "mode", type: "select", currentValue: "agent", options: [{ group: "g", options: [{ value: "agent" }] }] },
        ] });
        assert.deepEqual(info.models, { currentModelId: "m1", availableModels: [{ value: "m1", name: "One", modelId: "m1" }] });
        assert.deepEqual(info.modes, { currentModeId: "agent", availableModes: [{ value: "agent", id: "agent" }] });
        assert.deepEqual(new KiroAcpProfile(base).normalizeSessionInfo({ modes: { currentModeId: "x" } }), { modes: { currentModeId: "x" } });
    });

    test("v3 consent: an 'always' answer persists for this session and the exact triggering resource", () => {
        const pending = { rpcId: 1, sessionId: "s",
            options: [{ optionId: "a", kind: "allow_always" }, { optionId: "r", kind: "reject_always" }, { optionId: "o", kind: "allow_once" }],
            meta: { kiro: { consent: { capability: "fs.write", resource: "/w", triggeringResource: "/w/a.ts", workspaceRoot: "/w" } } } };
        const v3 = new KiroAcpProfile({ ...base, engine: "v3" });
        const consent = { _meta: { kiro: { consent: { capability: "fs.write", scope: "session", resource: "/w/a.ts", workspaceRoot: "/w" } } } };
        assert.deepEqual(v3.permissionResultMeta(pending, "a"), consent);
        assert.deepEqual(v3.permissionResultMeta(pending, "r"), consent);
        assert.deepEqual(v3.permissionResultMeta(pending, "o"), {});
        assert.deepEqual(v3.permissionResultMeta({ ...pending, meta: undefined }, "a"), {});
        assert.deepEqual(new KiroAcpProfile(base).permissionResultMeta(pending, "a"), {}, "v2 never forwards consent");
    });

    test("usage summary: v3's own, else the core's metering default", () => {
        const v3 = new KiroAcpProfile({ ...base, engine: "v3" });
        assert.deepEqual(v3.usageSummary({ source: "kiro-v3", totalCredits: 1, sessionUpdate: "context_usage" }),
            { source: "kiro-v3", totalCredits: 1, sessionUpdate: "usage_summary" });
        assert.equal(v3.usageSummary({ meteringUsage: [] }), undefined);
        assert.equal(v3.usageSummary(undefined), undefined);
        assert.equal(new KiroAcpProfile(base).usageSummary({ source: "kiro-v3" }), undefined, "v2 never reports kiro-v3 summaries");
    });

    test("spawn environment: kiroEnv on the host's, read once per call", () => {
        let reads = 0;
        const hostEnv = () => { reads++; return { KEEP: "1" }; };
        for (const engine of ["v2", "v3"] as const) {
            // v3 also runs Kiro's trust classifier, which Approve for me needs.
            assert.deepEqual(new KiroAcpProfile({ ...base, engine }).spawnEnvironment(hostEnv),
                { KEEP: "1", ...(engine === "v3" ? { KIRO_TRUST_CLASSIFIER_MODE: "enforce" } : {}) });
        }
        assert.equal(reads, 2);
        let preloadReads = 0;
        const off = new KiroAcpProfile({ ...base, preloadTools: () => { preloadReads++; return false; } });
        assert.deepEqual(off.spawnEnvironment(hostEnv), { KEEP: "1" });
        assert.equal(preloadReads, 1);
        assert.equal(new KiroAcpProfile(base).spawnEnvironment(undefined), undefined, "no host environment: inherit ours");
        assert.equal(new KiroAcpProfile({ ...base, launch: { bin: "/crew", args: () => [] } }).spawnEnvironment(hostEnv), undefined,
            "a launch override's child inherits ours");
        assert.equal(reads, 3);
    });
});
