import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class SpacesMetaTests: XCTestCase {
    private static let page: JSONValue = ["id": "page-1", "workspaceId": "workspace-1", "title": "Workspace home", "role": "workspace-home", "revision": 1, "blocks": [["id": "block-1", "type": "markdown", "text": "Current content"]]]
    private static let firstRun: JSONValue = ["requestedAt": .null, "summary": ["state": "waiting", "summarizedAt": .null], "workspaces": [["workspaceId": "workspace-1", "workspaceName": "Notes", "firstRun": .null]], "haltedReason": .null]
    private static func pageResponse(_ request: AppContractRequest) -> AppContractResponse {
        switch request.path {
        case "/api/pages/page-1": return .json(page)
        case "/api/pages/page-1/layout-preferences": return .json(["text": "Keep it concise", "revision": 2, "updatedAt": 1, "updatedBy": "user", "future": true])
        case "/api/pages/page-1/layout-rules": return .json(["items": []])
        case "/api/pages/page-1/progress-cards": return .json(["items": []])
        case "/api/spaces-home/first-run": return .json(firstRun)
        default: return .json(["error": "Unexpected route"], status: 404)
        }
    }
    private static func assistantInfo(node: String = "assistant-node", purpose: String = "spaces") -> JSONValue {
        ["nodeId": .string(node), "workspaceId": "assistant-workspace", "treeId": .string("tree-" + node),
         "settings": ["runtimeId": "claude", "modelId": .null, "reasoning": .null], "conversation": ["runtimeId": "claude", "modelId": .null, "reasoning": .null],
         "supportedRuntimes": ["claude", "codex"]]
    }
    private static func assistantGraph(node: String = "assistant-node", purpose: String = "spaces") -> JSONValue {
        ["workspace": ["id": "assistant-workspace", "name": "Michi", "cwd": "/tmp", "settings": .string(JSONValue.object(["system": "assistant", "assistant": .object([purpose == "schedule" ? "scheduleNodeId" : "nodeId": .string(node)])]).prettyPrinted)],
         "nodes": [["id": .string(node), "workspace_id": "assistant-workspace", "tree_id": .string("tree-" + node), "kind": "chat", "runtime_id": "claude", "title": "Michi"]],
         "trees": [["id": .string("tree-" + node), "root_node_id": .string(node), "workspace_id": "assistant-workspace"]], "edges": [], "contexts": []]
    }
    private static func assistantResponse(_ request: AppContractRequest, node: String = "assistant-node", purpose: String = "spaces") -> AppContractResponse {
        if request.path == "/api/assistant" || request.path == "/api/assistant/schedule" { return .json(assistantInfo(node: node, purpose: purpose)) }
        if request.path == "/api/workspaces/assistant-workspace" { return .json(assistantGraph(node: node, purpose: purpose)) }
        if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
        if request.path == "/api/spaces" || request.path == "/api/spaces-home/workspaces" { return .json(["items": [], "nextCursor": .null]) }
        if request.path == "/api/spaces-home" { return .json(["page": page]) }
        return pageResponse(request)
    }
    private func cleanup(_ model: NativeSpacesAssistantModel, _ transport: AppContractTransport) { model.detach(); transport.close() }
    private func waitForRequest(_ transport: AppContractTransport, matching: (AppContractRequest) -> Bool, count: Int = 1) async {
        for _ in 0..<200 {
            if transport.requests.filter(matching).count >= count { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Expected request was not observed")
    }
    private func cleanupPage(_ transport: AppContractTransport) {
        UserDefaults.standard.removeObject(forKey: "michi.spaces.rule.\(transport.api.baseURL.absoluteString).page-1")
        UserDefaults.standard.removeObject(forKey: "michi.spaces.first-run-retry.\(transport.api.baseURL.absoluteString)")
        transport.close()
    }

    func testContextIsOnlyBoundedReferencesNotPageContents() throws {
        let context = try NativeSpacesContract.context(page: Self.page, blockID: "block-1", knownPages: [Self.page, ["id": "remote:x:y", "title": "Remote"], ["id": "p2", "title": .string(String(repeating: "👨‍👩‍👧‍👦", count: 100)), "body": "Never send"]])
        XCTAssertEqual(context["pageId"], "page-1"); XCTAssertEqual(context["blockId"], "block-1")
        XCTAssertEqual(context["pages"].arrayValue.count, 2)
        XCTAssertLessThanOrEqual(context["pages"].arrayValue[1]["title"].stringValue.utf16.count, 300)
        XCTAssertFalse(context.prettyPrinted.contains("Current content")); XCTAssertFalse(context.prettyPrinted.contains("Never send"))
        XCTAssertEqual(Set(context.objectValue.keys), ["pageId", "blockId", "pages"])
    }
    func testUnknownBlockAndForeignContextAreRejected() {
        XCTAssertThrowsError(try NativeSpacesContract.context(page: Self.page, blockID: "removed", knownPages: []))
        XCTAssertThrowsError(try NativeSpacesContract.context(page: nil, blockID: "block", knownPages: []))
        XCTAssertFalse(NativeSpacesContract.usableID("x\ny")); XCTAssertFalse(NativeSpacesContract.usableID("remote:ws"))
    }
    func testAssistantIdentityRequiresServerOwnedSystemAndCurrentPointer() throws {
        let info = Self.assistantInfo()
        XCTAssertEqual(try NativeSpacesContract.assistantGraph(Self.assistantGraph(), info: info, purpose: "spaces").id, "assistant-workspace")
        for settings: JSONValue in [["system": "ordinary", "assistant": ["nodeId": "assistant-node"]], ["system": "assistant", "assistant": ["nodeId": "other"]]] {
            var graph = Self.assistantGraph(); graph["workspace"]["settings"] = .string(settings.prettyPrinted)
            XCTAssertThrowsError(try NativeSpacesContract.assistantGraph(graph, info: info, purpose: "spaces"))
        }
        var graph = Self.assistantGraph(); graph["nodes"] = [["id": "assistant-node", "workspace_id": "foreign", "tree_id": "tree-assistant-node", "kind": "chat"]]
        XCTAssertThrowsError(try NativeSpacesContract.assistantGraph(graph, info: info, purpose: "spaces"))
    }
    func testPageLoadDoesNotStartFirstReadOrAddRules() async {
        let transport = AppContractTransport { request, _ in Self.pageResponse(request) }; defer { transport.close() }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh()
        XCTAssertTrue(model.hasLoaded); XCTAssertEqual(model.preferenceDraft, "Keep it concise")
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" }); XCTAssertNil(model.error)
    }
    func testForeignPageStopsBeforeReadingOrWritingItsSettings() async {
        let transport = AppContractTransport { _, _ in .json(Self.page.merging(["workspaceId": "foreign"])) }; defer { transport.close() }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh()
        XCTAssertFalse(model.hasLoaded); XCTAssertNotNil(model.error)
        let saved = await model.savePreferences(); XCTAssertFalse(saved)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("layout-preferences") })
    }
    func testPreferenceDraftKeepsOriginalRevisionAfterRemoteRefresh() async {
        var revision = 2
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("layout-preferences") {
                if request.method == "PUT" { return .json(["error": "Conflict"], status: 409) }
                return .json(["text": revision == 2 ? "Original" : "Remote edit", "revision": .number(Double(revision))])
            }
            return Self.pageResponse(request)
        }; defer { transport.close() }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); model.preferenceDraft = "My draft"; revision = 3; await model.refresh()
        XCTAssertEqual(model.expectedRevision, 2); XCTAssertEqual(model.preferences["revision"], 3); XCTAssertEqual(model.preferenceDraft, "My draft")
        let saved = await model.savePreferences(); XCTAssertFalse(saved)
        XCTAssertEqual(transport.requests.last?.body, ["text": "My draft", "expectedRevision": 2])
    }
    func testPreferenceSaveDoesNotOverwriteNewTypingDuringRequest() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "PUT" { return .delayedJSON(["text": request.body["text"], "revision": 3], status: 200, delay: 0.1) }
            return Self.pageResponse(request)
        }; defer { transport.close() }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); model.preferenceDraft = "Submitted"
        let save = Task { await model.savePreferences() }
        try? await Task.sleep(for: .milliseconds(20)); model.preferenceDraft = "Still editing"
        let saved = await save.value; XCTAssertTrue(saved); XCTAssertEqual(model.preferenceDraft, "Still editing"); XCTAssertTrue(model.preferenceDirty)
    }
    func testLayoutRulesEnforceBackendBoundsAndHomeOnlySectionLimits() throws {
        XCTAssertThrowsError(try NativeSpacesContract.ruleBody(text: "Rule", section: "waiting", maxAge: 7, maxItems: nil, isHome: false))
        XCTAssertThrowsError(try NativeSpacesContract.ruleBody(text: "Rule", section: "waiting", maxAge: 366, maxItems: 9, isHome: true))
        XCTAssertThrowsError(try NativeSpacesContract.ruleBody(text: String(repeating: "x", count: 501), section: nil, maxAge: nil, maxItems: nil, isHome: true))
        XCTAssertEqual(try NativeSpacesContract.ruleBody(text: " Keep recent ", section: "done", maxAge: 7, maxItems: 3, isHome: true), ["text": "Keep recent", "sectionLimit": ["section": "done", "maxAgeDays": 7, "maxItems": 3]])
    }
    func testUnknownRuleOutcomePersistsAndCannotDuplicateOnReopen() async {
        let transport = AppContractTransport { request, _ in request.method == "POST" ? .failure(.networkConnectionLost) : Self.pageResponse(request) }
        defer {
            UserDefaults.standard.removeObject(forKey: "michi.spaces.rule.\(transport.api.baseURL.absoluteString).page-1"); transport.close()
        }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); model.ruleText = "Keep summaries concise"
        let first = await model.addRule(); XCTAssertFalse(first); XCTAssertTrue(model.ruleOutcomeUnknown)
        let reopened = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await reopened.refresh(); let second = await reopened.addRule(); XCTAssertFalse(second)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
    func testUnknownRuleReconcilesOnlyOneNewMatchingSavedRule() async {
        var posted = false
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { posted = true; return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("layout-rules"), posted { return .json(["items": [["id": "rule-new", "text": "Keep focus", "createdBy": "user", "createdAt": 1]]]) }
            return Self.pageResponse(request)
        }; defer { transport.close() }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); model.ruleText = "Keep focus"; _ = await model.addRule(); await model.refresh()
        XCTAssertFalse(model.ruleOutcomeUnknown); XCTAssertEqual(model.ruleText, ""); XCTAssertEqual(model.rules.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
    func testFirstReadStartsOnlyExplicitlyAndRetryMustNameFailedWorkspace() async {
        let transport = AppContractTransport { request, _ in Self.pageResponse(request) }; defer { transport.close() }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); await model.startFirstRun(retryWorkspace: "foreign", retry: true)
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
        await model.startFirstRun()
        XCTAssertEqual(transport.requests.last?.path, "/api/spaces-home/first-run"); XCTAssertEqual(transport.requests.last?.method, "POST"); XCTAssertEqual(transport.requests.last?.body, [:])
    }
    func testAssistantOpenUsesExistingIdentityAndContextWithoutSendingPrompt() async {
        let transport = AppContractTransport { request, _ in Self.assistantResponse(request) }
        let model = NativeSpacesAssistantModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1", blockID: "block-1")
        defer { cleanup(model, transport) }
        await model.open()
        XCTAssertNotNil(model.chat); XCTAssertTrue(model.chat?.loaded == true); XCTAssertNil(model.error)
        XCTAssertEqual(model.chat?.metaAgentContext?["pageId"], "page-1"); XCTAssertEqual(model.chat?.metaAgentContext?["blockId"], "block-1")
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }
    func testScheduledAssistantNeverReceivesSpacesContext() async {
        let transport = AppContractTransport { request, _ in Self.assistantResponse(request, purpose: "schedule") }
        let model = NativeSpacesAssistantModel(api: transport.api, workspaceID: "workspace-1", purpose: "schedule"); defer { cleanup(model, transport) }
        await model.open()
        XCTAssertEqual(model.chat?.metaAgentContext, ["schedule": ["workspaceId": "workspace-1"]])
        XCTAssertFalse(transport.requests.contains { $0.path == "/api/spaces" })
    }
    func testUnknownResetCannotRepeatAgainstNewCurrentConversation() async {
        var current = "assistant-node"
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/reset") { XCTAssertEqual(request.body["nodeId"], "assistant-node"); current = "new-node"; return .failure(.networkConnectionLost) }
            return Self.assistantResponse(request, node: current)
        }
        let model = NativeSpacesAssistantModel(api: transport.api); defer { cleanup(model, transport) }
        await model.open(); await model.reset(); XCTAssertTrue(model.unknownChange)
        await model.reset(); XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/reset") }.count, 1)
        await model.open(); XCTAssertEqual(model.info["nodeId"], "new-node"); XCTAssertFalse(model.unknownChange)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/reset") }.count, 1)
    }
    func testAssistantHistoryUsesExpectedCurrentNodeForActivation() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/assistant/conversations" { return .json(["items": [["nodeId": "older", "title": "Earlier work", "updatedAt": 2]], "nextCursor": "cursor/next"]) }
            if request.path.hasSuffix("/activate") { XCTAssertEqual(request.body, ["currentNodeId": "assistant-node"]); return .json(["error": "Changed", "code": "assistant_changed"], status: 409) }
            return Self.assistantResponse(request)
        }
        let model = NativeSpacesAssistantModel(api: transport.api); defer { cleanup(model, transport) }
        await model.open(); await model.loadHistory(); XCTAssertEqual(model.history.count, 1)
        await model.activate(model.history[0]); XCTAssertEqual(model.info["nodeId"], "assistant-node"); XCTAssertFalse(model.unknownChange)
        await model.loadHistory(more: true)
        XCTAssertEqual(transport.requests.last?.query["cursor"], "cursor/next")
    }
    func testAssistantSettingsWritesExplicitNullsWithDedicatedRoute() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/assistant/settings" {
                XCTAssertEqual(request.body, ["nodeId": "assistant-node", "runtimeId": "claude", "providerId": .null, "modelId": .null, "reasoning": .null])
                return .json(Self.assistantInfo())
            }
            return Self.assistantResponse(request)
        }
        let model = NativeSpacesAssistantModel(api: transport.api); defer { cleanup(model, transport) }
        await model.open(); let saved = await model.saveSettings(runtime: "claude", provider: "", model: "", reasoning: ""); XCTAssertTrue(saved)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/ensure-session") || $0.path.hasSuffix("/commands") })
    }

    func testPreferenceTypingDuringRefreshKeepsDraftAndOriginalRevision() async {
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("layout-preferences"), requests.filter({ $0.path.hasSuffix("layout-preferences") }).count > 1 {
                return .delayedJSON(["text": "Remote changed", "revision": 3], status: 200, delay: 0.15)
            }
            return Self.pageResponse(request)
        }; defer { cleanupPage(transport) }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh()
        let refresh = Task { await model.refresh() }
        await waitForRequest(transport, matching: { $0.path.hasSuffix("layout-preferences") }, count: 2)
        model.preferenceDraft = "Typed while refreshing"
        await refresh.value
        XCTAssertEqual(model.preferenceDraft, "Typed while refreshing"); XCTAssertEqual(model.expectedRevision, 2)
        XCTAssertEqual(model.preferences["revision"], 3); XCTAssertTrue(model.preferenceDirty)
    }

    func testTypingDuringInitialPreferenceReadIsNotOverwritten() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("layout-preferences") { return .delayedJSON(["text": "Server preference", "revision": 4], status: 200, delay: 0.15) }
            return Self.pageResponse(request)
        }; defer { cleanupPage(transport) }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        let refresh = Task { await model.refresh() }
        await waitForRequest(transport, matching: { $0.path.hasSuffix("layout-preferences") })
        model.preferenceDraft = "Initial typing"
        await refresh.value
        XCTAssertEqual(model.preferenceDraft, "Initial typing"); XCTAssertEqual(model.expectedRevision, 4); XCTAssertTrue(model.preferenceDirty)
    }

    func testRuleCannotStartDuringOutstandingRuleRefresh() async {
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("layout-rules"), request.method == "GET", requests.filter({ $0.path.hasSuffix("layout-rules") }).count > 1 {
                return .delayedJSON(["items": []], status: 200, delay: 0.15)
            }
            return Self.pageResponse(request)
        }; defer { cleanupPage(transport) }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); model.ruleText = "Pending draft"
        let refresh = Task { await model.refresh() }
        await waitForRequest(transport, matching: { $0.path.hasSuffix("layout-rules") }, count: 2)
        let added = await model.addRule()
        XCTAssertFalse(added); XCTAssertNil(model.pendingRuleBody)
        await refresh.value
        XCTAssertFalse(model.ruleOutcomeUnknown); XCTAssertEqual(model.ruleText, "Pending draft")
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

    func testInFlightRuleCannotBeReconciledOrForgottenBeforeItsResponse() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .delayedJSON(["error": "Lost acknowledgment"], status: 500, delay: 0.15) }
            return Self.pageResponse(request)
        }; defer { cleanupPage(transport) }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); model.ruleText = "Keep focus"
        let add = Task { await model.addRule() }
        await waitForRequest(transport, matching: { $0.method == "POST" })
        let readsBefore = transport.requests.filter { $0.method == "GET" }.count
        await model.refresh(); XCTAssertNil(model.forgetPendingRule())
        XCTAssertEqual(transport.requests.filter { $0.method == "GET" }.count, readsBefore)
        let added = await add.value; XCTAssertFalse(added); XCTAssertTrue(model.ruleOutcomeUnknown)
        XCTAssertEqual(model.pendingRuleBody, ["text": "Keep focus"])
        await model.refresh()
        XCTAssertTrue(model.ruleOutcomeUnknown); XCTAssertNotNil(model.pendingRuleBody)
        let duplicate = await model.addRule(); XCTAssertFalse(duplicate)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testUnknownRuleRetainsExactLimitsAndForgetIsOnlyLocal() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            if request.path == "/api/pages/page-1" { return .json(Self.page.merging(["role": "spaces-home"])) }
            return Self.pageResponse(request)
        }; defer { cleanupPage(transport) }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); model.ruleText = "\u{FEFF} Keep recent \u{FEFF}"
        _ = await model.addRule(section: "done", maxAge: 7, maxItems: 3)
        let expected: JSONValue = ["text": "Keep recent", "sectionLimit": ["section": "done", "maxAgeDays": 7, "maxItems": 3]]
        XCTAssertEqual(transport.requests.last?.body, expected)
        let reopened = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await reopened.refresh(); XCTAssertEqual(reopened.pendingRuleBody, expected); XCTAssertTrue(reopened.ruleOutcomeUnknown)
        XCTAssertEqual(reopened.forgetPendingRule(), expected); XCTAssertFalse(reopened.ruleOutcomeUnknown)
        XCTAssertEqual(reopened.ruleText, "Keep recent"); XCTAssertTrue(reopened.error?.contains("may create a duplicate") == true)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertThrowsError(try NativeSpacesContract.ruleBody(text: "\u{FEFF}\u{00A0}", section: nil, maxAge: nil, maxItems: nil, isHome: true))
    }

    func testAcceptedResetWithFailedFollowupReadFreezesOldConversation() async {
        var resetAccepted = false, failRead = true
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/reset") { resetAccepted = true; return .json(Self.assistantInfo(node: "new-node")) }
            if resetAccepted && failRead && request.path == "/api/workspaces/assistant-workspace" { return .json(["error": "Unavailable"], status: 404) }
            return Self.assistantResponse(request, node: resetAccepted ? "new-node" : "assistant-node")
        }
        let model = NativeSpacesAssistantModel(api: transport.api); defer { cleanup(model, transport) }
        await model.open(); let previous = model.chat
        await model.reset()
        XCTAssertTrue(model.unknownChange); XCTAssertNil(model.chat); XCTAssertFalse(previous?.loaded ?? true)
        XCTAssertNil(previous?.metaAgentContext)
        previous?.draft = "Must not send to archived assistant"; previous?.send()
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/message") })
        await model.reset(); XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/reset") }.count, 1)
        failRead = false; await model.open()
        XCTAssertFalse(model.unknownChange); XCTAssertEqual(model.chat?.node.id, "new-node")
    }

    func testAcceptedActivationWithFailedFollowupReadIsNotTreatedAsRejection() async {
        var activated = false
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/assistant/conversations" { return .json(["items": [["nodeId": "older", "title": "Older"]], "nextCursor": .null]) }
            if request.path.hasSuffix("/activate") { activated = true; return .json(Self.assistantInfo(node: "older")) }
            if activated && request.path == "/api/workspaces/assistant-workspace" { return .json(["error": "Denied read"], status: 403) }
            return Self.assistantResponse(request)
        }
        let model = NativeSpacesAssistantModel(api: transport.api); defer { cleanup(model, transport) }
        await model.open(); await model.loadHistory(); await model.activate(model.history[0])
        XCTAssertTrue(model.unknownChange); XCTAssertNil(model.chat)
        await model.activate(model.history[0]); XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/activate") }.count, 1)
    }

    func testAuthoritativeOpenClearsUnknownEvenWhenCurrentNodeDidNotChange() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/reset") { return .failure(.networkConnectionLost) }
            return Self.assistantResponse(request)
        }
        let model = NativeSpacesAssistantModel(api: transport.api); defer { cleanup(model, transport) }
        await model.open(); await model.reset(); XCTAssertTrue(model.unknownChange); XCTAssertNil(model.chat)
        await model.open(); XCTAssertFalse(model.unknownChange); XCTAssertEqual(model.chat?.node.id, "assistant-node")
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/reset") }.count, 1)
    }

    func testAcceptedResetDoesNotPublishConversationWhoseHistoryFailed() async {
        var accepted = false
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/reset") { accepted = true; return .json(Self.assistantInfo(node: "new-node")) }
            if accepted && request.path.hasSuffix("/messages") { return .json(["error": "History denied"], status: 403) }
            return Self.assistantResponse(request, node: accepted ? "new-node" : "assistant-node")
        }
        let model = NativeSpacesAssistantModel(api: transport.api); defer { cleanup(model, transport) }
        await model.open(); await model.reset()
        XCTAssertTrue(model.unknownChange); XCTAssertNil(model.chat); XCTAssertNotNil(model.error)
        XCTAssertEqual(model.info["nodeId"], "assistant-node")
    }

    func testPreferenceSaveUsesServerWhitespaceIncludingBOM() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "PUT" { return .json(["text": "Concise", "revision": 3]) }
            return Self.pageResponse(request)
        }; defer { cleanupPage(transport) }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); model.preferenceDraft = "\u{FEFF} Concise \u{FEFF}"
        let saved = await model.savePreferences()
        XCTAssertTrue(saved); XCTAssertEqual(model.preferenceDraft, "Concise"); XCTAssertNil(model.error)
    }

    func testUnknownFirstReadRetryReconcilesOnlyNewAttemptAndSurvivesReopen() async {
        func status(started: Int) -> JSONValue {
            Self.firstRun.merging(["requestedAt": 1, "workspaces": [["workspaceId": "workspace-1", "workspaceName": "Notes", "firstRun": ["state": "failed", "startedAt": .number(Double(started)), "updatedAt": .number(Double(started + 1)), "error": "Failed", "readCount": 0, "total": 1]]]])
        }
        var started = 10
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/retry") { return .failure(.networkConnectionLost) }
            if request.path == "/api/spaces-home/first-run" { return .json(status(started: started)) }
            return Self.pageResponse(request)
        }; defer { cleanupPage(transport) }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); await model.startFirstRun(retryWorkspace: "workspace-1", retry: true)
        XCTAssertTrue(model.firstRunUnknown)
        await model.refreshFirstRun(); XCTAssertTrue(model.firstRunUnknown); XCTAssertNotNil(model.progressError)
        await model.startFirstRun(retryWorkspace: "workspace-1", retry: true)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/retry") }.count, 1)
        let reopened = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await reopened.refresh(); XCTAssertTrue(reopened.firstRunUnknown)
        started = 20; await reopened.refreshFirstRun()
        XCTAssertFalse(reopened.firstRunUnknown); XCTAssertNil(reopened.progressError)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/retry") }.count, 1)
    }

    func testProgressCardSeenOnlyAfterExplicitValidatedOpen() async {
        let card: JSONValue = ["threadNodeId": "node-1", "workspaceId": "workspace-1", "startedFromPageId": "page-1", "seenAt": .null]
        let graph: JSONValue = ["workspace": ["id": "workspace-1"], "nodes": [["id": "node-1", "workspace_id": "workspace-1", "tree_id": "tree-1", "kind": "chat"]], "trees": [["id": "tree-1", "workspace_id": "workspace-1", "root_node_id": "node-1"]], "edges": []]
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/progress-cards") { return .json(["items": .array([card])]) }
            if request.path == "/api/workspaces/workspace-1" { return .json(graph) }
            if request.path.hasSuffix("/seen") { return .json(card.merging(["seenAt": 100, "expiresAt": 86_400_100])) }
            return Self.pageResponse(request)
        }; defer { cleanupPage(transport) }
        let model = NativeSpacesPageModel(api: transport.api, pageID: "page-1", workspaceID: "workspace-1")
        await model.refresh(); XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
        let foreign = await model.openCard(card.merging(["workspaceId": "foreign"]))
        XCTAssertNil(foreign); XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
        let target = await model.openCard(card)
        XCTAssertEqual(target?.node, "node-1"); XCTAssertEqual(model.cards.first?["seenAt"], 100)
        XCTAssertEqual(transport.requests.last?.path, "/api/progress-cards/node-1/seen")
        XCTAssertEqual(transport.requests.last?.body, [:])
    }
}
