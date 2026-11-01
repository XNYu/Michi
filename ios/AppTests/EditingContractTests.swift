import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class EditingContractTests: XCTestCase {
    private func job(schedule: JSONValue = ["kind": "every", "everySeconds": 90]) -> JSONValue {
        [
            "id": "job-1", "workspaceId": "workspace-1", "name": "Original job", "prompt": "Review changes",
            "schedule": schedule, "permissionMode": "ask", "sessionMode": "persistent", "notify": true,
            "timeoutSeconds": 90, "runtimeId": .null, "providerId": .null, "modelId": .null, "reasoning": .null,
        ]
    }

    private func agent(policy: JSONValue) -> JSONValue {
        [
            "id": "agent-1", "revision": 4, "status": "published", "scope": "workspace", "workspaceId": "workspace-1",
            "name": "Researcher", "description": "Review source material", "instructions": "Preserve evidence",
            "runtimeProfile": ["version": 1, "runtimeId": "claude"], "fallbackChain": [],
            "contextPolicy": ["version": 1, "includeWorkspaceInstructions": true, "allowMessageContext": true,
                              "allowFileContext": true, "allowArtifactContext": true, "maxEstimatedChars": 100000],
            "permissionPolicy": policy, "toolRefs": [], "skillRefs": [], "mcpServerRefs": [], "defaultRunTtlMs": .null,
        ]
    }

    private var storedPolicy: JSONValue {
        [
            "version": 1, "preset": "research", "categories": ["shell_exec": "deny"],
            "maxDelegationDepth": 2, "maxConcurrentRuns": 2, "maxWallTimeMs": 90000, "maxAttempts": 3,
            "maxTokens": 12345, "maxSpendMicros": 98765,
            "opaqueFutureSetting": ["nested": [1, true, "retained"]],
        ]
    }

    private var runtimeStatus: JSONValue {
        [
            "runtime": "codex", "provider": "openai", "model": "active-model", "reasoning": "high",
            "providerByRuntime": ["claude": "anthropic"], "modelByRuntime": ["claude": "other-model"],
            "reasoningByRuntime": ["claude": "medium"], "webSearchProvider": "brave",
            "nativeResumeByRuntime": ["codex": false, "claude": true],
            "nativeForkByRuntime": ["codex": true, "claude": false],
            "workflowsByRuntime": ["claude": true], "workflowRuntimes": ["claude"],
        ]
    }

    func testMixedWeekdayRangeRemainsRawCronOnUnrelatedEdit() async throws {
        let schedule: JSONValue = ["kind": "cron", "expression": "0 9 * * 1,3-5", "timezone": "Asia/Tokyo"]
        let original = job(schedule: schedule)
        XCTAssertNil(featureSupportedCron("0 9 * * 1,3-5"))
        var draft = FeatureScheduleDraft.from(original, defaultWorkspace: "workspace-1", sessionMode: "persistent")
        XCTAssertEqual(draft.mode, .cron)
        XCTAssertEqual(try draft.scheduleJSON(), schedule)
        draft.name = "Renamed job"
        XCTAssertEqual(try draft.patchJSON(against: original), ["name": "Renamed job"])
    }

    func testCronShortcutParserRejectsOtherLossyForms() async {
        for expression in ["0 9 * * */2", "0 9 * * 1-3", "0 9 * * 7", "0 9 * * 1,,3", "0 25 * * 1", "60 9 * * 1", "0 9 1 * 1"] {
            XCTAssertNil(featureSupportedCron(expression), expression)
        }
        let weekly = featureSupportedCron("15 8 * * 0,2,6")
        XCTAssertEqual(weekly?.minute, 15)
        XCTAssertEqual(weekly?.hour, 8)
        XCTAssertEqual(weekly?.days, "0,2,6")
        XCTAssertEqual(featureSupportedCron("0 9 * * 1-5")?.days, "1-5")
    }

    func testRenamingNinetySecondJobPreservesExactIntervalAndTimeout() async throws {
        let original = job()
        var draft = FeatureScheduleDraft.from(original, defaultWorkspace: "workspace-1", sessionMode: "persistent")
        draft.name = "Renamed job"
        let input = try draft.inputJSON()
        XCTAssertEqual(input["schedule"]["everySeconds"], 90)
        XCTAssertEqual(input["timeoutSeconds"], 90)
        XCTAssertEqual(featureSchedulePatch(job: original, draft: input), ["name": "Renamed job"])
    }

    func testEditingIntervalDoesNotRoundUntouchedTimeout() async throws {
        let original = job()
        var draft = FeatureScheduleDraft.from(original, defaultWorkspace: "workspace-1", sessionMode: "persistent")
        draft.intervalValue = 2
        draft.intervalUnit = .minutes
        XCTAssertEqual(try draft.patchJSON(against: original), ["schedule": ["kind": "every", "everySeconds": 120]])
        draft = FeatureScheduleDraft.from(original, defaultWorkspace: "workspace-1", sessionMode: "persistent")
        draft.timeoutMinutes = 2
        XCTAssertEqual(try draft.patchJSON(against: original), ["timeoutSeconds": 120])
    }

    func testExistingNullPermissionPolicySurvivesDescriptionEdit() async throws {
        var draft = FeatureAgentDraft.from(agent(policy: .null))
        draft.description = "Updated description only"
        let input = try draft.requestJSON(includingRevision: true)
        XCTAssertEqual(input["permissionPolicy"], .null)
        XCTAssertEqual(input["expectedRevision"], 4)
    }

    func testOpaquePolicyAndExactWallTimeSurviveUnrelatedAgentEdit() async throws {
        var draft = FeatureAgentDraft.from(agent(policy: storedPolicy))
        draft.name = "Renamed researcher"
        let input = try draft.requestJSON(includingRevision: true)
        XCTAssertEqual(input["permissionPolicy"], storedPolicy)
        XCTAssertEqual(input["permissionPolicy"]["maxWallTimeMs"], 90000)
    }

    func testEditingOnePermissionLimitPreservesOpaqueFieldsAndExactOtherLimits() async throws {
        var draft = FeatureAgentDraft.from(agent(policy: storedPolicy))
        draft.maxConcurrentRuns = "5"
        let changed = try draft.requestJSON(includingRevision: true)["permissionPolicy"]
        XCTAssertEqual(changed, storedPolicy.merging(["maxConcurrentRuns": 5]))
        draft.maxWallTimeMinutes = "2"
        let explicitDuration = try draft.requestJSON(includingRevision: true)["permissionPolicy"]
        XCTAssertEqual(explicitDuration["maxWallTimeMs"], 120000)
        XCTAssertEqual(explicitDuration["opaqueFutureSetting"], storedPolicy["opaqueFutureSetting"])
    }

    func testNewAgentGetsDefaultPolicyWithoutRewritingExistingNullPolicy() async throws {
        var draft = FeatureAgentDraft.from(agent(policy: .null))
        draft.id = "new"
        let policy = try draft.requestJSON(includingRevision: false)["permissionPolicy"]
        XCTAssertEqual(policy, featureAgentDefaultPermissionPolicy(preset: "research"))
        XCTAssertEqual(policy["maxWallTimeMs"], 3600000)
    }

    func testRuntimeDraftUsesSelectedRuntimeSettingsAndActiveFallback() async {
        let selected = featureRuntimeDraft(from: runtimeStatus, runtime: "claude")
        XCTAssertEqual(selected.runtime, "claude")
        XCTAssertEqual(selected.provider, "anthropic")
        XCTAssertEqual(selected.model, "other-model")
        XCTAssertEqual(selected.reasoning, "medium")
        XCTAssertTrue(selected.nativeResume)
        XCTAssertFalse(selected.nativeFork)
        XCTAssertTrue(selected.workflows)
        XCTAssertEqual(selected.webSearchProvider, "brave")
        let active = featureRuntimeDraft(from: runtimeStatus, runtime: "codex")
        XCTAssertEqual(active.provider, "openai")
        XCTAssertEqual(active.model, "active-model")
        XCTAssertEqual(active.reasoning, "high")
        XCTAssertFalse(active.nativeResume)
    }

    func testMissingRuntimeFlagsDefaultTrueWithoutLeakingActiveModel() async {
        let empty: JSONValue = ["runtime": "codex", "provider": "openai", "model": "active-model", "reasoning": "high"]
        let selected = featureRuntimeDraft(from: empty, runtime: "claude")
        XCTAssertEqual(selected.provider, "")
        XCTAssertEqual(selected.model, "")
        XCTAssertEqual(selected.reasoning, "")
        XCTAssertTrue(selected.nativeResume)
        XCTAssertTrue(selected.nativeFork)
        XCTAssertFalse(selected.workflows)
    }

    func testRuntimeSaveComparesOverridesWithSelectedRuntimeBaseline() async throws {
        let status = runtimeStatus
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/agent/options" { return .json(["ok": true]) }
            if request.path == "/api/agent/status" { return .json(status) }
            return .json(["providers": [], "models": []])
        }
        defer { transport.close() }
        let model = FeatureRuntimeSettingsModel(api: transport.api)
        model.status = status
        model.ready = true
        model.baseline = featureRuntimeDraft(from: status, runtime: "codex")
        model.draft = featureRuntimeDraft(from: status, runtime: "claude")
        // These values equal codex's settings but intentionally change claude's.
        model.draft.provider = "openai"
        model.draft.model = "active-model"
        model.draft.nativeResume = false
        await model.save()
        let body = try XCTUnwrap(transport.requests.first { $0.path == "/api/agent/options" }?.body)
        XCTAssertEqual(body["runtime"], "claude")
        XCTAssertEqual(body["expectedRuntime"], "codex")
        XCTAssertEqual(body["provider"], "openai")
        XCTAssertEqual(body["model"], "active-model")
        XCTAssertEqual(body["nativeResumeByRuntime"]["claude"], false)
    }

    func testDirtyPageDraftKeepsBaselineRevisionAndBuildsStaleGuard() async {
        let original: JSONValue = ["id": "block-1", "rev": 7, "type": "markdown", "text": "Original"]
        let server: JSONValue = ["id": "block-1", "rev": 8, "type": "markdown", "text": "Server edit"]
        var session = FeatureBlockSession()
        session.capture(original)
        XCTAssertFalse(session.consider(server, dirty: true))
        XCTAssertEqual(session.id, "block-1")
        XCTAssertEqual(session.rev, 7)
        XCTAssertNotNil(session.conflict)
        let local: JSONValue = ["type": "markdown", "text": "My unsaved draft"]
        let operation = featureBlockUpdateOperation(id: session.id, expectRev: session.rev, input: local)
        XCTAssertEqual(operation, ["op": "update", "id": "block-1", "expectRev": 7, "block": local])
    }

    func testCleanPageDraftAdoptsServerRevisionAndClearsConflict() async {
        let original: JSONValue = ["id": "block-1", "rev": 7]
        let server: JSONValue = ["id": "block-1", "rev": 8]
        var session = FeatureBlockSession()
        session.capture(original)
        XCTAssertFalse(session.consider(server, dirty: true))
        XCTAssertNotNil(session.conflict)
        XCTAssertTrue(session.consider(server, dirty: false))
        XCTAssertEqual(session.rev, 8)
        XCTAssertNil(session.conflict)
        XCTAssertFalse(session.consider(server, dirty: true))
        XCTAssertEqual(session.rev, 8)
        XCTAssertNil(session.conflict)
    }
}
