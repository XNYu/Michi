import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as acpErrors from "../src/adapters/acp/errors";
import {
    acpShouldAttachMcp,
    acpSupportsHttpMcp,
    acpSupportsImagePrompt,
    acpSupportsLoadSession,
    type AcpMcpServer as CoreMcpServer,
    type AcpSessionOptions as CoreSessionOptions,
} from "../src/adapters/acp/types";
import * as kiroAcp from "../src/adapters/kiro/acpClient";
import type { AcpMcpServer, AcpSessionOptions, AcpSessionInfo, AcpConfigOption } from "../src/adapters/kiro/kiroProtocol";
import type { AcpSessionInfo as CoreSessionInfo, AcpConfigOption as CoreConfigOption } from "../src/adapters/acp/types";

const ERROR_CLASSES = [
    "ACPError", "ACPNotRunningError", "ACPRequestNotSentError", "ACPProcessExitedError",
    "ACPSessionRecoveryRequiredError", "ACPNativeSessionMissingError", "ACPUnsupportedMethodError",
] as const;

describe("ACP errors", () => {
    test("the Kiro client re-exports the ACP core's classes, not copies", () => {
        for (const name of ERROR_CLASSES) assert.equal(kiroAcp[name], acpErrors[name], name);
    });

    test("the Kiro client's runtime exports are unchanged", () => {
        assert.deepEqual(Object.keys(kiroAcp).sort(), [...ERROR_CLASSES, "AcpClient", "findKiroCli", "probeKiroCli"].sort());
    });

    test("errors carry their class name and RPC details", () => {
        const error = new acpErrors.ACPRequestNotSentError("not sent", { method: "session/prompt", sessionId: "s", rpcCode: -1, rpcData: { a: 1 } });
        assert.equal(error.name, "ACPRequestNotSentError");
        assert.ok(error instanceof acpErrors.ACPNotRunningError);
        assert.ok(error instanceof acpErrors.ACPError);
        assert.deepEqual({ method: error.method, sessionId: error.sessionId, rpcCode: error.rpcCode, rpcData: error.rpcData },
            { method: "session/prompt", sessionId: "s", rpcCode: -1, rpcData: { a: 1 } });
        assert.equal(new acpErrors.ACPError("bare").method, undefined);
    });
});

describe("ACP initialize-result gating helpers", () => {
    const advertised = {
        agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true },
            promptCapabilities: { image: true },
        },
    };
    const silent = { agentCapabilities: {} };

    test("probes loadSession / http MCP / image from initialize result", () => {
        assert.equal(acpSupportsLoadSession(advertised), true);
        assert.equal(acpSupportsHttpMcp(advertised), true);
        assert.equal(acpSupportsImagePrompt(advertised), true);
        assert.equal(acpSupportsLoadSession(silent), false);
        assert.equal(acpSupportsHttpMcp(silent), false);
        assert.equal(acpSupportsImagePrompt(silent), false);
        assert.equal(acpSupportsLoadSession(null), false);
    });

    test("MCP attach follows the policy alone; unset means ifAdvertised for every runtime", () => {
        assert.equal(acpShouldAttachMcp("always", silent, "kiro"), true);
        assert.equal(acpShouldAttachMcp("always", silent, "cursor"), true);
        assert.equal(acpShouldAttachMcp("never", advertised), false);
        assert.equal(acpShouldAttachMcp("ifAdvertised", silent, "cursor"), false);
        assert.equal(acpShouldAttachMcp("ifAdvertised", advertised, "cursor"), true);
        // The runtime id no longer decides: Kiro declares "always" in its profile.
        assert.equal(acpShouldAttachMcp(undefined, silent, "kiro"), false);
        assert.equal(acpShouldAttachMcp(undefined, advertised, "kiro"), true);
        assert.equal(acpShouldAttachMcp(undefined, silent, "cursor"), false);
        assert.equal(acpShouldAttachMcp(undefined, null), false);
    });
});

describe("Kiro's protocol types build on the ACP core's", () => {
    test("Kiro session types are the core's, or extend them", () => {
        const server: AcpMcpServer = { name: "michi", type: "http", url: "http://127.0.0.1:1/api/mcp/x", headers: [],
            _meta: { kiro: { waitForReady: true, versionNegotiation: "legacy" } } };
        const coreServer: CoreMcpServer = server;
        const options: AcpSessionOptions = { modelId: "m", workflowsEnabled: true };
        const coreOptions: CoreSessionOptions = options;
        const option: AcpConfigOption = { id: "model", type: "select" };
        const coreOption: CoreConfigOption = option;
        const info: AcpSessionInfo = { configOptions: [coreOption] };
        const coreInfo: CoreSessionInfo = info;
        assert.deepEqual([coreServer.name, coreOptions.modelId, coreInfo.configOptions?.[0].id], ["michi", "m", "model"]);
    });
});
