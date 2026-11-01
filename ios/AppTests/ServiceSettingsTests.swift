import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class ServiceSettingsTests: XCTestCase {
    private var status: JSONValue { [
        "runtime": "pi", "provider": "anthropic", "model": "model-current", "future": ["preserved": true],
        "providers": [["id": "anthropic", "label": "Anthropic", "hasKey": true, "defaultModel": "default-model"],
                      ["id": "managed", "hasKey": true, "requiresUserKey": false], ["id": "amazon-bedrock", "hasKey": true]],
        "webSearchProvider": "jina", "webSearchProviders": [["id": "jina", "hasKey": true], ["id": "tavily", "hasKey": false]]
    ] }
    private var configuredBedrock: JSONValue { ["configured": true, "region": "us-west-2", "credentialSource": "bearer-token", "hasBearerToken": true, "hasAccessKeys": false, "hasProfile": false, "hasAuthRefresh": true, "envDetected": false] }
    private var overview: JSONValue { ["state": "running", "runtime": ["runtimeId": "pi"], "today": ["checks": 1], "cursors": [], "recentRuns": [], "future": ["x": true]] }

    func testLoadingServicesNeverReadsOrWritesSecretValues() async {
        let status = status
        let transport = AppContractTransport { _, _ in .json(status) }; defer { transport.close() }
        let model = ServiceSettingsModel(api: transport.api)
        await model.reload()
        XCTAssertTrue(model.ready); XCTAssertTrue(model.keys.isEmpty)
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
        XCTAssertEqual(transport.requests.map(\.path), ["/api/agent/status"])
        await model.saveKey(provider: "anthropic", search: false)
        XCTAssertEqual(transport.requests.count, 1, "Blank input must leave saved key untouched")
    }
    func testKeySaveSendsOnlyExplicitInputAndClearsItAfterSuccess() async {
        let status = status
        let transport = AppContractTransport { request, _ in request.method == "GET" ? .json(status) : .json(["ok": true]) }; defer { transport.close() }
        let model = ServiceSettingsModel(api: transport.api); await model.reload()
        model.keys["model:anthropic"] = "  test-key-only  "
        await model.saveKey(provider: "anthropic", search: false)
        XCTAssertEqual(transport.requests.last?.body, ["provider": "anthropic", "key": "test-key-only"])
        XCTAssertEqual(model.keys["model:anthropic"], "")
        XCTAssertEqual(model.status["future"], ["preserved": true])
    }
    func testManagedUnknownAndBedrockProvidersCannotUseGenericKeyEndpoint() async {
        let status = status
        let transport = AppContractTransport { _, _ in .json(status) }; defer { transport.close() }
        let model = ServiceSettingsModel(api: transport.api); await model.reload()
        for provider in ["managed", "unknown", "amazon-bedrock"] {
            model.keys["model:" + provider] = "test-only"
            await model.saveKey(provider: provider, search: false)
            await model.clearKey(provider: provider, search: false, confirmed: true)
        }
        XCTAssertEqual(transport.requests.count, 1)
    }
    func testSensitiveFailureNeverEchoesKeyAndRetainsEnteredDraft() async {
        let status = status
        let transport = AppContractTransport { request, _ in
            request.method == "GET" ? .json(status) : .json(["error": "rejected secret-test-only credential"], status: 401)
        }; defer { transport.close() }
        let model = ServiceSettingsModel(api: transport.api); await model.reload()
        model.keys["model:anthropic"] = "secret-test-only"
        await model.saveKey(provider: "anthropic", search: false)
        XCTAssertEqual(model.keys["model:anthropic"], "secret-test-only")
        XCTAssertFalse(model.error?.contains("secret-test-only") ?? true)
        XCTAssertTrue(model.error?.contains("401") ?? false)
    }
    func testVerifySavedKeyOmitsKeyAndUsesSelectedModel() async {
        let status = status
        let transport = AppContractTransport { request, _ in request.method == "GET" ? .json(status) : .json(["ok": true]) }; defer { transport.close() }
        let model = ServiceSettingsModel(api: transport.api); await model.reload(); await model.verifyKey(provider: "anthropic")
        XCTAssertEqual(transport.requests.last?.path, "/api/agent/provider-key/verify")
        XCTAssertEqual(transport.requests.last?.body, ["provider": "anthropic", "model": "model-current"])
    }
    func testClearRequiresConfirmationAndSearchUsesSeparateNamespace() async {
        let status = status
        let transport = AppContractTransport { request, _ in request.method == "GET" ? .json(status) : .json(["ok": true]) }; defer { transport.close() }
        let model = ServiceSettingsModel(api: transport.api); await model.reload()
        await model.clearKey(provider: "jina", search: true, confirmed: false)
        XCTAssertEqual(transport.requests.count, 1)
        await model.clearKey(provider: "jina", search: true, confirmed: true)
        XCTAssertEqual(transport.requests.last?.path, "/api/agent/search-key/jina")
        XCTAssertEqual(transport.requests.last?.method, "DELETE")
        XCTAssertFalse(model.searchProviders[0]["hasKey"].boolValue)
        XCTAssertTrue(model.providers[0]["hasKey"].boolValue)
    }
    func testSearchSelectionWritesOnlySearchPatchAndExplicitOffIsNull() async {
        let status = status
        let transport = AppContractTransport { request, _ in request.method == "GET" ? .json(status) : .json(["ok": true]) }; defer { transport.close() }
        let model = ServiceSettingsModel(api: transport.api); await model.reload()
        model.searchProvider = "tavily"; await model.saveSearchProvider()
        XCTAssertEqual(transport.requests.last?.body, ["webSearchProvider": "tavily"])
        model.searchProvider = ""; await model.saveSearchProvider()
        XCTAssertEqual(transport.requests.last?.body, ["webSearchProvider": .null])
        XCTAssertFalse(model.searchDirty)
    }
    func testBedrockReplacementCannotSendMissingCredentialsOrSkipConfirmation() async {
        let config = configuredBedrock
        let transport = AppContractTransport { _, _ in .json(config) }; defer { transport.close() }
        let model = BedrockSettingsModel(api: transport.api); await model.reload()
        XCTAssertEqual(model.draft.bearerToken, "")
        model.draft.region = "eu-west-1"
        await model.save(confirmedReplacement: false)
        await model.save(confirmedReplacement: true)
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertNotNil(model.error)
    }
    func testBedrockReplacementSendsOnlyChosenCredentialTypeAndExplicitRefresh() async {
        let config = configuredBedrock
        let transport = AppContractTransport { request, _ in request.method == "GET" ? .json(config) : .json(["ok": true]) }; defer { transport.close() }
        let model = BedrockSettingsModel(api: transport.api); await model.reload()
        model.draft.source = "access-keys"; model.draft.region = "eu-west-1"
        model.draft.accessKeyID = "test-access"; model.draft.secretAccessKey = "test-secret"
        model.draft.bearerToken = "leftover-not-selected"
        model.draft.refreshCommand = ""
        await model.save(confirmedReplacement: true)
        let post = transport.requests.first { $0.method == "POST" }
        XCTAssertEqual(post?.body, ["region": "eu-west-1", "credentialSource": "access-keys", "accessKeyId": "test-access", "secretAccessKey": "test-secret", "authRefreshCommand": ""])
        XCTAssertEqual(model.draft.accessKeyID, ""); XCTAssertEqual(model.draft.secretAccessKey, "")
        XCTAssertFalse(post?.body.prettyPrinted.contains("leftover") ?? true)
    }
    func testFailedBedrockLoadCannotBeReplacedFromDefaults() async {
        let transport = AppContractTransport { _, _ in .json(["error": "Forbidden"], status: 403) }; defer { transport.close() }
        let model = BedrockSettingsModel(api: transport.api); await model.reload()
        model.draft.source = "auto"; await model.save(confirmedReplacement: true)
        XCTAssertFalse(model.ready); XCTAssertEqual(transport.requests.count, 1)
    }
    func testUnavailableTelemetryCannotBeEnabledButCrewStillLoadsAndSaves() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("usage-telemetry") { return .json(["available": false, "enabled": false, "reason": "Unavailable here"]) }
            return .json(["defaultMode": request.method == "POST" ? request.body["defaultMode"] : "incognito"])
        }; defer { transport.close() }
        let model = ServicePreferencesModel(api: transport.api); await model.reload()
        model.telemetryEnabled = true; await model.saveTelemetry()
        XCTAssertFalse(transport.requests.contains { $0.method == "PUT" })
        XCTAssertEqual(model.crewMode, "incognito")
        model.crewMode = "temporary"; await model.saveCrew()
        XCTAssertEqual(transport.requests.last?.body, ["defaultMode": "temporary"])
    }
    func testPreferencesRefreshKeepsUnsavedEditsAndOnlySendsChangedField() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("usage-telemetry") { return .json(["available": true, "enabled": request.method == "PUT" ? request.body["enabled"] : false, "future": "keep"]) }
            return .json(["defaultMode": "persistent"])
        }; defer { transport.close() }
        let model = ServicePreferencesModel(api: transport.api); await model.reload()
        model.telemetryEnabled = true; model.crewMode = "incognito"; await model.reload()
        XCTAssertTrue(model.telemetryEnabled); XCTAssertEqual(model.crewMode, "incognito")
        await model.saveTelemetry()
        XCTAssertEqual(transport.requests.last?.body, ["enabled": true])
        XCTAssertEqual(model.telemetry["future"], "keep")
    }
    func testMetaLoadingDoesNotRunAndActionsRequireConfirmation() async {
        let overview = overview
        let transport = AppContractTransport { request, _ in request.path.hasSuffix("overview") ? .json(overview) : .json(["workspaces": []]) }; defer { transport.close() }
        let model = MetaMaintenanceModel(api: transport.api); await model.reload()
        await model.runNow(confirmed: false); await model.setPaused(true, confirmed: false)
        XCTAssertTrue(model.overviewReady); XCTAssertTrue(model.roundReady)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }
    func testMetaPauseUsesEmptyBodyAndKeepsResponseFields() async {
        let overview = overview
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("run-now") { return .json(["workspaces": []]) }
            return .json(request.method == "POST" ? overview.merging(["state": "paused"]) : overview)
        }; defer { transport.close() }
        let model = MetaMaintenanceModel(api: transport.api); await model.reload(); await model.setPaused(true, confirmed: true)
        XCTAssertEqual(transport.requests.last?.path, "/api/meta-agent/pause")
        XCTAssertEqual(transport.requests.last?.body, [:])
        XCTAssertEqual(model.overview["state"], "paused")
        XCTAssertEqual(model.overview["future"], ["x": true])
    }
    func testUnknownMetaRunOutcomeBlocksDuplicateSubmission() async {
        let overview = overview
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.timedOut) }
            return request.path.hasSuffix("overview") ? .json(overview) : .json(["workspaces": []])
        }; defer { transport.close() }
        let model = MetaMaintenanceModel(api: transport.api); await model.reload()
        await model.runNow(confirmed: true); await model.runNow(confirmed: true)
        XCTAssertTrue(model.outcomeUnknown)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        await model.refreshRound()
        XCTAssertTrue(model.outcomeUnknown, "A status refresh alone is not permission to submit again")
    }
    func testStartedMetaRoundBlocksDoubleTapEvenBeforeNextStatusRefresh() async {
        let overview = overview
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .json(["workspaces": [["workspaceId": "w", "outcome": "started"]]]) }
            return request.path.hasSuffix("overview") ? .json(overview) : .json(["workspaces": []])
        }; defer { transport.close() }
        let model = MetaMaintenanceModel(api: transport.api); await model.reload()
        await model.runNow(confirmed: true); await model.runNow(confirmed: true)
        XCTAssertTrue(model.running)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
}
