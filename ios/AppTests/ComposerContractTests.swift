import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class ComposerContractTests: XCTestCase {
    private func recoveryStore() -> NativeComposerRecoveryStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("MichiComposerTests-" + UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return NativeComposerRecoveryStore(directory: directory)
    }
    private func chat(_ transport: AppContractTransport, node: JSONValue? = nil, store: NativeComposerRecoveryStore? = nil, windowID: String? = nil) -> ChatController {
        let graph = appContractGraph()
        return ChatController(api: transport.api, graph: graph, node: node ?? graph.nodes[0], recoveryStore: store ?? recoveryStore(), windowID: windowID)
    }
    private func cleanup(_ chat: ChatController, _ transport: AppContractTransport) {
        chat.detach()
        for suffix in [".draft", ".pendingComposer", ".activeTurn", "." + chat.composerWindowID + ".activeTurn"] {
            UserDefaults.standard.removeObject(forKey: "michi.\(transport.api.baseURL.absoluteString).\(chat.node.id)" + suffix)
        }
        transport.close()
    }
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }
    private static func response(_ request: AppContractRequest) -> AppContractResponse {
        if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
        if request.path.hasSuffix("/ensure-session") { return .json(["sessionState": [:]]) }
        if request.path.hasSuffix("/commands") { return .json(["ok": true]) }
        if request.path.hasSuffix("/message") {
            let stamp: JSONValue = ["nodeId": "node-1", "turnId": request.body["turnId"], "assistantId": "assistant"]
            return .events([("turn_start", stamp.merging(["seq": 0])), ("done", stamp.merging(["seq": 1, "stopReason": "end_turn"]))])
        }
        return .json(["error": "Unexpected request"], status: 400)
    }
    func testDraftWritesOnlyOwnWindowSlotAndDoesNotReplayGraphFields() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.draft = "Unsent on iPhone"
        await eventually { transport.requests.contains { $0.path.hasSuffix("/commands") } }
        let payload = transport.requests.first { $0.path.hasSuffix("/commands") }!.body["commands"].arrayValue[0]["payload"]
        XCTAssertEqual(Set(payload.objectValue.keys), ["id", "composer_draft", "composer_draft_window_id"])
        XCTAssertEqual(payload["composer_draft_window_id"].stringValue, chat.composerWindowID)
        XCTAssertEqual(payload["composer_draft"].parsedJSON["value"], "Unsent on iPhone")
        XCTAssertEqual(payload["id"], "node-1")
    }
    func testFailedHydrationCannotWriteDraft() async {
        let transport = AppContractTransport { _, _ in .json(["error": "offline"], status: 503) }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        chat.draft = "Keep offline"; await chat.load()
        try? await Task.sleep(for: .milliseconds(450))
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
        XCTAssertEqual(chat.draft, "Keep offline")
    }
    func testRapidDraftChangesAreSerializedAndStaleGraphCannotReplaceEditor() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/commands") { return .delayedJSON(["ok": true], status: 200, delay: 0.15) }
            return Self.response(request)
        }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.draft = "First"
        await eventually { transport.requests.filter { $0.path.hasSuffix("/commands") }.count == 1 }
        chat.draft = "Latest"
        await eventually { transport.requests.filter { $0.path.hasSuffix("/commands") }.count == 2 }
        let graph = appContractGraph(); chat.refresh(graph: graph, node: graph.nodes[0])
        XCTAssertEqual(chat.draft, "Latest")
        let snapshots = transport.requests.filter { $0.path.hasSuffix("/commands") }.map { $0.body["commands"].arrayValue[0]["payload"]["composer_draft"].parsedJSON["value"] }
        XCTAssertEqual(snapshots, ["First", "Latest"])
    }
    func testImmediateBackgroundResumeStillSavesPendingDraft() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.draft = "Save after resume"
        chat.detach(); chat.resumeIfNeeded()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/commands") } }
        XCTAssertEqual(transport.requests.first { $0.path.hasSuffix("/commands") }?.body["commands"].arrayValue.first?["payload"]["composer_draft"].parsedJSON["value"], "Save after resume")
    }
    func testExplicitDefaultReasoningSendsNullInsteadOfKeepingPreviousValue() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        var node = appContractGraph().nodes[0]; node["reasoning"] = "high"
        let chat = chat(transport, node: node); defer { cleanup(chat, transport) }
        await chat.load(); chat.selectReasoning(""); chat.draft = "Use default"; chat.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/ensure-session") } }
        let body = transport.requests.first { $0.path.hasSuffix("/ensure-session") }!.body
        XCTAssertNotNil(body.objectValue["reasoning"])
        XCTAssertEqual(body["reasoning"], .null)
    }
    func testExplicitClearedWindowDoesNotReviveLegacyDraftOrSpawnOutbox() async {
        let node: JSONValue = ["composer_draft": .string(JSONValue.object(["value": "Legacy", "__michiPendingSpawnPrompt": "Server-owned", "__michiWindowDrafts": ["phone": .null, "web": .string("{\"value\":\"Other tab\",\"mentions\":[]}")]]).prettyPrinted)]
        XCTAssertTrue(NativeComposer.fromNode(node, windowID: "phone").isEmpty)
        XCTAssertEqual(NativeComposer.fromNode(node, windowID: "web").value, "Other tab")
        XCTAssertEqual(NativeComposer.fromNode(node, windowID: "new").value, "Legacy")
    }
    func testQueueCombinesAdjacentMessagesAndKeepsNewComposerText() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.busy = true
        chat.draft = "First queued"; chat.enqueueDraft()
        chat.draft = "Second queued"; chat.enqueueDraft()
        chat.draft = "Still editing"; chat.busy = false; chat.flushQueue()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } && !chat.busy }
        let sent = transport.requests.filter { $0.path.hasSuffix("/message") }
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0].body["text"], "First queued\n\nSecond queued")
        XCTAssertEqual(chat.draft, "Still editing"); XCTAssertTrue(chat.queued.isEmpty)
    }
    func testWithdrawnQueueEntryCannotSendAfterSessionPreparation() async {
        for editing in [false, true] {
            let transport = AppContractTransport { request, _ in
                if request.path.hasSuffix("/ensure-session") { return .delayedJSON(["sessionState": [:]], status: 200, delay: 0.2) }
                return Self.response(request)
            }
            let chat = chat(transport)
            await chat.load(); chat.busy = true; chat.draft = "Withdraw this instruction"; chat.enqueueDraft()
            let id = chat.queued[0].id
            chat.busy = false; chat.flushQueue()
            await eventually { transport.requests.contains { $0.path.hasSuffix("/ensure-session") } }
            if editing { chat.restoreQueued(id) } else { chat.removeQueued(id) }
            await eventually { !chat.busy }
            XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/message") })
            XCTAssertTrue(chat.queuePaused)
            if editing { XCTAssertEqual(chat.draft, "Withdraw this instruction") }
            cleanup(chat, transport)
        }
    }
    func testRejectedQueueIsKeptPausedWithoutOverwritingNewDraft() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/message") { return .json(["error": "Rejected"], status: 400) }
            return Self.response(request)
        }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.busy = true; chat.draft = "Queued work"; chat.enqueueDraft()
        chat.draft = "New draft"; chat.busy = false; chat.flushQueue()
        await eventually { chat.queuePaused && !chat.busy }
        XCTAssertEqual(chat.queued.map { $0.composer.value }, ["Queued work"])
        XCTAssertEqual(chat.draft, "New draft")
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }
    func testQueueEditSwapsWithCurrentDraftWithoutLosingEither() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.busy = true; chat.draft = "Queued"; chat.enqueueDraft()
        chat.draft = "Current"; chat.restoreQueued(chat.queued[0].id)
        XCTAssertEqual(chat.draft, "Queued"); XCTAssertEqual(chat.queued[0].composer.value, "Current")
    }
    func testCompactUsesRuntimeEndpointWithoutCreatingPromptTurn() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/compact") { return .json(["started": true, "detail": "Compacted"]) }
            return Self.response(request)
        }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.draft = "/compact preserve the plan"; chat.send()
        await eventually { chat.commandResult != nil }
        XCTAssertEqual(transport.requests.first { $0.path.hasSuffix("/compact") }?.body["instructions"], "preserve the plan")
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/message") })
        XCTAssertEqual(chat.draft, "")
    }
    func testQuotesPreserveSourceMetadataAndAuthorshipBoundary() async {
        var composer = NativeComposer(); composer.value = "Please explain"; composer.quotedText = "Quoted statement"
        XCTAssertTrue(composer.wireText.contains("not as text authored by the user"))
        XCTAssertTrue(composer.wireText.contains("User's reply:\nPlease explain"))
        XCTAssertEqual(composer.metadata["quotedText"], "Quoted statement")
        composer.quoteSource = ["type": "artifact", "name": "Notes", "filePath": "notes.md"]
        XCTAssertTrue(composer.wireText.contains("at `notes.md`"))
        XCTAssertEqual(NativeComposer(raw: composer.persisted).quoteSource, composer.quoteSource)
    }
    func testMentionRangesUseUTF16AndDropOverlappingEdits() async {
        let mention: JSONValue = ["start": 3, "end": 7, "kind": "node", "refId": "remote:node/1", "label": "Foo"]
        var composer = NativeComposer(); composer.value = "😀 @Foo"; composer.mentions = [mention]
        XCTAssertEqual(composer.expandedText, "😀 @node:remote%3Anode%2F1")
        let shifted = NativeComposer.reanchor([mention], previous: composer.value, next: "X😀 @Foo")
        XCTAssertEqual(shifted[0]["start"], 4)
        XCTAssertTrue(NativeComposer.reanchor([mention], previous: composer.value, next: "😀 @Foz").isEmpty)
    }
    func testSlashCommandBoundaryMatchesRuntimeContract() async {
        XCTAssertEqual(NativeChatCommand.parse("/status", runtime: "claude", engine: "")?.name, "status")
        XCTAssertNil(NativeChatCommand.parse("/status", runtime: "codex", engine: ""))
        XCTAssertNil(NativeChatCommand.parse("/home/user/file", runtime: "kiro", engine: ""))
        XCTAssertNil(NativeChatCommand.parse("/compact\nnormal text", runtime: "kiro", engine: ""))
        XCTAssertNil(NativeChatCommand.parse("/fork", runtime: "kiro", engine: ""))
    }
    func testReferencedConversationUsesOwnedHistoryAndKeepsReadableDisplay() async throws {
        var graph = appContractGraph()
        graph.raw["nodes"] = .array(graph.nodes + [["id": "node-2", "tree_id": "tree-1", "workspace_id": "workspace-1", "title": "Related", "deleted_at": .null]])
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": [["id": "other", "node_id": "node-2", "role": "user", "content": "Source discussion", "seq": 0], ["id": "foreign", "node_id": "foreign-node", "role": "user", "content": "Do not include", "seq": 1]]]) }
            return Self.response(request)
        }
        let chat = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore()); defer { cleanup(chat, transport) }
        await chat.load(); chat.insertMention(kind: "node", id: "node-2", label: "Related"); chat.draft += "Explain"
        let snapshot = chat.composerSnapshot
        let wire = try await chat.resolvedPrompt(snapshot)
        XCTAssertTrue(wire.contains("Source discussion")); XCTAssertFalse(wire.contains("Do not include")); XCTAssertFalse(wire.contains("@node:"))
        chat.send(); await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } }
        XCTAssertEqual(transport.requests.first { $0.path.hasSuffix("/message") }?.body["displayText"], "@Related Explain")
    }
    func testMentionFromForeignWorkspaceIsRejectedBeforePromptSend() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.insertMention(kind: "node", id: "foreign", label: "Other workspace"); chat.send()
        await eventually { chat.error != nil }
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/message") })
        XCTAssertTrue(chat.draft.contains("Other workspace"))
    }
    func testArtifactMentionIsPassedAsExtraContextWithoutInjectingUnmentionedFiles() async throws {
        var graph = appContractGraph()
        graph.raw["contexts"] = [["id": "a1", "name": "notes.md", "file_path": "notes.md", "kind": "reference"], ["id": "a2", "name": "other.md", "file_path": "other.md"]]
        let transport = AppContractTransport { request, _ in Self.response(request) }
        let chat = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore()); defer { cleanup(chat, transport) }
        await chat.load(); chat.insertMention(kind: "context", id: "a1", label: "notes.md"); chat.draft += "Summarize"; chat.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/ensure-session") } }
        let body = transport.requests.first { $0.path.hasSuffix("/ensure-session") }!.body
        XCTAssertEqual(body["extraContexts"].arrayValue.count, 1)
        XCTAssertEqual(body["extraContexts"].arrayValue.first?["filePath"], "notes.md")
        XCTAssertEqual(body["contextManifest"].arrayValue.count, 2)
    }
    func testUnknownSteerOutcomeCannotAutomaticallySendAgain() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/message") {
                return .events([("turn_start", ["nodeId": "node-1", "turnId": request.body["turnId"], "assistantId": "assistant", "seq": 0])])
            }
            if request.path.hasSuffix("/stream") || request.path.hasSuffix("/steer") { return .failure(.networkConnectionLost) }
            return Self.response(request)
        }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.draft = "Start"; chat.send()
        await eventually { chat.turnID != nil }
        chat.draft = "Add this instruction"; await chat.steer()
        XCTAssertTrue(chat.queuePaused)
        XCTAssertEqual(chat.queued.first?.composer.value, "Add this instruction")
        XCTAssertEqual(chat.queued.first?.outcomeUnknown, true)
        await chat.steerQueued(chat.queued[0].id)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/steer") }.count, 1)
    }
    func testExplicitSteerRejectionPreservesEntryForNextTurn() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/message") { return .events([("turn_start", ["nodeId": "node-1", "turnId": request.body["turnId"], "assistantId": "assistant", "seq": 0])]) }
            if request.path.hasSuffix("/stream") { return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("/steer") { return .json(["accepted": false, "reason": "unsupported"], status: 409) }
            return Self.response(request)
        }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.draft = "Start"; chat.send(); await eventually { chat.turnID != nil }
        chat.draft = "Keep queued"; await chat.steer()
        XCTAssertEqual(chat.queued.first?.composer.value, "Keep queued"); XCTAssertEqual(chat.queued.first?.outcomeUnknown, false)
    }

    func testRuntimeErrorAndFailedPersistenceTerminalsPauseQueue() async {
        for terminal: JSONValue in [["stopReason": "error"], ["stopReason": "end_turn", "persisted": false]] {
            let transport = AppContractTransport { request, _ in
                if request.path.hasSuffix("/message") {
                    let stamp: JSONValue = ["nodeId": "node-1", "turnId": request.body["turnId"], "assistantId": "assistant"]
                    return .events([("turn_start", stamp.merging(["seq": 0])), ("done", stamp.merging(["seq": 1]).merging(terminal.objectValue))], delay: 0.1)
                }
                return Self.response(request)
            }
            let chat = chat(transport)
            await chat.load(); chat.draft = "First"; chat.send()
            await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } }
            chat.draft = "Only after success"; chat.enqueueDraft()
            await eventually { !chat.busy }
            XCTAssertTrue(chat.queuePaused); XCTAssertEqual(chat.queued.first?.composer.value, "Only after success")
            XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
            cleanup(chat, transport)
        }
    }
    func testMalformedSuccessfulSteerResponseFreezesEntry() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/message") { return .events([("turn_start", ["nodeId": "node-1", "turnId": request.body["turnId"], "assistantId": "assistant", "seq": 0])]) }
            if request.path.hasSuffix("/stream") { return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("/steer") { return .json(["unexpected": "response"]) }
            return Self.response(request)
        }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        await chat.load(); chat.draft = "Start"; chat.send(); await eventually { chat.turnID != nil }
        chat.draft = "Unknown acceptance"; await chat.steer()
        XCTAssertTrue(chat.queuePaused); XCTAssertEqual(chat.queued.first?.outcomeUnknown, true)
    }

    func testModelCommandDoesNotRevertToPreviousModelOnNextMessage() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/execute-command") { return .json(["success": true, "sessionState": ["version": 2, "modelId": "new-model"]]) }
            return Self.response(request)
        }
        let chat = chat(transport); defer { cleanup(chat, transport) }
        chat.runtimeID = "claude"; chat.modelID = "old-model"
        await chat.load(); chat.draft = "/model new-model"; chat.send()
        await eventually { chat.commandResult != nil && !chat.commandRunning }
        chat.draft = "Use the selected model"; chat.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } }
        let sessions = transport.requests.filter { $0.path.hasSuffix("/ensure-session") }
        XCTAssertEqual(sessions.last?.body["modelId"], "new-model")
    }

    func testSteerDoesNotCrossTurnBoundaryWhileResolvingMention() async {
        var graph = appContractGraph()
        graph.raw["nodes"] = .array(graph.nodes + [["id": "node-2", "tree_id": "tree-1", "workspace_id": "workspace-1", "title": "Reference", "deleted_at": .null]])
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("/messages") && requests.contains(where: { $0.path.hasSuffix("/message") }) {
                return .delayedJSON(["messages": []], status: 200, delay: 0.2)
            }
            if request.path.hasSuffix("/message") {
                let stamp: JSONValue = ["nodeId": "node-1", "turnId": request.body["turnId"], "assistantId": "assistant"]
                return .events([("turn_start", stamp.merging(["seq": 0])), ("done", stamp.merging(["seq": 1]))], delay: 0.1)
            }
            return Self.response(request)
        }
        let chat = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore()); defer { cleanup(chat, transport) }
        await chat.load(); chat.draft = "Initial"; chat.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } }
        chat.insertMention(kind: "node", id: "node-2", label: "Reference"); await chat.steer()
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/steer") })
    }
    func testExplicitIdempotencyHeaderIsBoundedAndNeverBodyData() async throws {
        let transport = AppContractTransport { _, _ in .json(["ok": true]) }; defer { transport.close() }
        _ = try await transport.api.request("/agent-runs/run/input", method: "POST", body: ["text": "input"], idempotencyKey: "operation-123")
        XCTAssertEqual(transport.requests[0].idempotencyKey, "operation-123")
        XCTAssertEqual(transport.requests[0].body, ["text": "input"])
        for invalid in ["", "has space", "newline\r\nheader", String(repeating: "a", count: 257)] {
            do { _ = try await transport.api.request("/agent-runs/run/input", method: "POST", body: [:], idempotencyKey: invalid); XCTFail("Invalid key accepted") }
            catch { XCTAssertEqual((error as? MichiAPIError)?.code, MichiAPIError.Code.invalidRequest) }
        }
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testTurnSnapshotIsDurableBeforePOSTIncludingAttachmentsAndExactPayload() async throws {
        let storage = recoveryStore()
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/message") {
                do {
                    let urls = try FileManager.default.contentsOfDirectory(at: storage.directory!, includingPropertiesForKeys: nil)
                    let state = try JSONDecoder().decode(NativeComposerRecoveryStore.State.self, from: Data(contentsOf: XCTUnwrap(urls.first)))
                    XCTAssertEqual(state.submission?.payload, request.body)
                    XCTAssertEqual(state.submission?.turnID, request.body["turnId"].optionalString)
                    XCTAssertEqual(state.submission?.composer.attachments.first?["name"], "notes.txt")
                    XCTAssertEqual(state.submission?.composer.quotedText, "Quoted context")
                    XCTAssertEqual(state.scope.windowID, "phone")
                } catch { XCTFail("Snapshot missing before POST: \(error)") }
                return .failure(.networkConnectionLost)
            }
            if request.path.hasSuffix("/stream") { return .json(["error": "Not found"], status: 410) }
            if request.path == "/api/workspaces/workspace-1" { return .json(appContractGraph().raw) }
            return Self.response(request)
        }
        let original = chat(transport, store: storage, windowID: "phone"); defer { cleanup(original, transport) }
        await original.load(); original.draft = "Preserve the message"; original.quotedText = "Quoted context"
        original.attachments = [["name": "notes.txt", "absPath": "/workspace/notes.txt"]]
        let snapshot = original.composerSnapshot; original.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } }
        original.detach()
        let recreated = chat(transport, store: NativeComposerRecoveryStore(directory: storage.directory), windowID: "phone")
        defer { recreated.detach() }
        XCTAssertEqual(recreated.pendingSubmission?.composer, snapshot)
        XCTAssertEqual(recreated.pendingSubmission?.payload, original.pendingSubmission?.payload)
        XCTAssertEqual(recreated.turnID, original.turnID); XCTAssertTrue(recreated.busy)
        XCTAssertTrue(recreated.recoverableSubmissionText?.contains("Preserve the message") == true)
        await recreated.load(); recreated.resumeQueue(); recreated.draft = "Do not duplicate"; recreated.send()
        await eventually { transport.requests.contains { $0.path == "/api/workspaces/workspace-1" } }
        XCTAssertTrue(recreated.busy); XCTAssertNotNil(recreated.pendingSubmission)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }
    func testUnknownQueuedTurnRestoresOriginalEntriesAndLaterQueueWithoutOverwritingDraft() async {
        let storage = recoveryStore()
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/message") || request.path.hasSuffix("/stream") { return .failure(.networkConnectionLost) }
            return Self.response(request)
        }
        let original = chat(transport, store: storage); defer { cleanup(original, transport) }
        await original.load(); original.busy = true
        original.draft = "First"; original.enqueueDraft(); original.draft = "Second"; original.enqueueDraft()
        let submittedIDs = original.queued.map(\.id)
        original.busy = false; original.flushQueue()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } }
        original.draft = "Next queued"; original.enqueueDraft(); original.draft = "Still editing"; original.detach()
        let recreated = chat(transport, store: NativeComposerRecoveryStore(directory: storage.directory)); defer { recreated.detach() }
        XCTAssertEqual(recreated.recoverableSubmittedQueue.map(\.id), submittedIDs)
        XCTAssertEqual(recreated.recoverableSubmittedQueue.map { $0.composer.value }, ["First", "Second"])
        XCTAssertEqual(recreated.queued.map { $0.composer.value }, ["Next queued"])
        XCTAssertEqual(recreated.draft, "Still editing"); XCTAssertTrue(recreated.queuePaused)
        recreated.resumeQueue(); XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }
    func testQueuedCommandUnknownOutcomeCannotResumeOrReplayAfterRecreation() async {
        for command in ["/compact keep decisions", "/clear"] {
            let storage = recoveryStore()
            let transport = AppContractTransport { request, _ in
                if request.path.hasSuffix("/compact") || request.path.hasSuffix("/execute-command") { return .failure(.networkConnectionLost) }
                return Self.response(request)
            }
            let original = chat(transport, store: storage); original.runtimeID = "kiro"
            await original.load(); original.busy = true; original.draft = command; original.enqueueDraft()
            let queueID = original.queued[0].id; original.busy = false; original.flushQueue()
            await eventually { original.pendingSubmission?.kind == "command" && !original.commandRunning }
            XCTAssertEqual(original.queued.first?.outcomeUnknown, true)
            original.resumeQueue(); original.removeQueued(queueID); original.restoreQueued(queueID)
            XCTAssertEqual(original.queued.first?.id, queueID)
            original.detach()
            let recreated = chat(transport, store: NativeComposerRecoveryStore(directory: storage.directory)); recreated.runtimeID = "kiro"
            await recreated.load(); recreated.resumeQueue(); recreated.send(); await recreated.compact()
            XCTAssertTrue(recreated.queuePaused); XCTAssertEqual(recreated.queued.first?.outcomeUnknown, true)
            XCTAssertEqual(recreated.recoverableSubmissionText, command)
            XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/compact") || $0.path.hasSuffix("/execute-command") }.count, 1)
            recreated.detach(); cleanup(original, transport)
        }
    }
    func testNonqueuedCommandUnknownOutcomeKeepsNewDraftAndPersistsOriginalText() async {
        let storage = recoveryStore()
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/execute-command") { return .delayedJSON(["error": "Runtime disconnected"], status: 500, delay: 0.15) }
            return Self.response(request)
        }
        let original = chat(transport, store: storage); original.runtimeID = "kiro"; defer { cleanup(original, transport) }
        await original.load(); original.draft = "/clear"; original.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/execute-command") } }
        original.draft = "A new draft"
        await eventually { !original.commandRunning && original.queued.first?.outcomeUnknown == true }
        XCTAssertEqual(original.draft, "A new draft"); original.detach()
        let recreated = chat(transport, store: NativeComposerRecoveryStore(directory: storage.directory)); defer { recreated.detach() }
        XCTAssertEqual(recreated.draft, "A new draft"); XCTAssertEqual(recreated.recoverableSubmissionText, "/clear")
        XCTAssertNil(recreated.turnID); await recreated.load(); recreated.send(); recreated.resumeQueue()
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/execute-command") }.count, 1)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/message") })
    }
    func testMalformedCommandSuccessRemainsUnknownButConfirmedUnsupportedCanRetry() async {
        for malformed in [true, false] {
            let transport = AppContractTransport { request, _ in
                if request.path.hasSuffix("/execute-command") {
                    return malformed ? .json(["unexpected": "body"]) : .json(["error": "Active session does not support command execution"], status: 400)
                }
                return Self.response(request)
            }
            let model = chat(transport); model.runtimeID = "kiro"
            await model.load(); model.draft = "/clear"; model.send()
            await eventually { model.error != nil && !model.commandRunning }
            XCTAssertEqual(model.pendingSubmission != nil, malformed)
            model.send(); await Task.yield()
            if malformed { XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/execute-command") }.count, 1) }
            else { await eventually { transport.requests.filter { $0.path.hasSuffix("/execute-command") }.count == 2 } }
            cleanup(model, transport)
        }
    }
    func testCommandSnapshotIsSavedBeforeTransportAndCompactButtonSharesGuard() async {
        let storage = recoveryStore()
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/compact") {
                do {
                    let urls = try FileManager.default.contentsOfDirectory(at: storage.directory!, includingPropertiesForKeys: nil)
                    let state = try JSONDecoder().decode(NativeComposerRecoveryStore.State.self, from: Data(contentsOf: XCTUnwrap(urls.first)))
                    XCTAssertEqual(state.submission?.kind, "command"); XCTAssertEqual(state.submission?.payload, request.body)
                    XCTAssertEqual(state.submission?.composer.value, "/compact")
                } catch { XCTFail("Command recovery record missing: \(error)") }
                return .failure(.timedOut)
            }
            return Self.response(request)
        }
        let model = chat(transport, store: storage); defer { cleanup(model, transport) }
        await model.load(); model.draft = "Unsent normal text"; await model.compact(); await model.compact()
        XCTAssertEqual(model.draft, "Unsent normal text"); XCTAssertEqual(model.recoverableSubmissionText, "/compact")
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/compact") }.count, 1)
    }
    func testQueueCommandWithdrawnDuringPreparationDoesNotSubmitOrCreatePendingMarker() async throws {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/ensure-session") { return .delayedJSON(["sessionState": [:]], status: 200, delay: 0.15) }
            return Self.response(request)
        }
        let model = chat(transport); defer { cleanup(model, transport) }
        await model.load(); model.busy = true; model.draft = "/compact"; model.enqueueDraft()
        let id = model.queued[0].id; model.busy = false; model.flushQueue()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/ensure-session") } }
        model.removeQueued(id); await eventually { !model.commandRunning }
        XCTAssertNil(model.pendingSubmission)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/compact") })
        XCTAssertNil(try model.recoveryStore.load(model.recoveryScope)?.submission)
    }
    func testExistingOpenControllerCannotOverwritePendingSubmission() async {
        let storage = recoveryStore()
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/message") || request.path.hasSuffix("/stream") { return .failure(.networkConnectionLost) }
            return Self.response(request)
        }
        let first = chat(transport, store: storage), second = chat(transport, store: NativeComposerRecoveryStore(directory: storage.directory))
        defer { second.detach(); cleanup(first, transport) }
        await first.load(); await second.load(); first.draft = "First"; first.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } }
        first.detach(); second.draft = "Second must wait"; second.send()
        await eventually { second.pendingSubmission != nil }
        XCTAssertEqual(second.pendingSubmission?.id, first.pendingSubmission?.id)
        XCTAssertEqual(second.draft, "Second must wait")
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }
    func testConfirmedTerminalAndKnownRefusalResolveDurableMarker() async throws {
        for rejected in [true, false] {
            let transport = AppContractTransport { request, _ in
                if rejected && request.path.hasSuffix("/message") { return .json(["error": "Invalid model", "code": "invalid_model"], status: 400) }
                return Self.response(request)
            }
            let model = chat(transport)
            await model.load(); model.draft = "Original"; model.send()
            await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } && !model.busy }
            XCTAssertNil(model.pendingSubmission); XCTAssertNil(try model.recoveryStore.load(model.recoveryScope)?.submission)
            if rejected { XCTAssertEqual(model.draft, "Original") }
            cleanup(model, transport)
        }
    }
    func testOnlyExactDurableTurnEvidenceResolvesRecoveredUnknownSubmission() async throws {
        let storage = recoveryStore()
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("/message") { return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("/stream") { return .json(["error": "Replay expired"], status: 410) }
            if request.path == "/api/workspaces/workspace-1" {
                var graph = appContractGraph().raw
                graph["nodes"] = .array(graph["nodes"].arrayValue.map { $0.merging(["last_applied_turn_id": requests.first(where: { $0.path.hasSuffix("/message") })?.body["turnId"] ?? .null]) })
                return .json(graph)
            }
            return Self.response(request)
        }
        let model = chat(transport, store: storage); defer { cleanup(model, transport) }
        await model.load(); model.draft = "Preserved until proof"; model.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } && !model.busy }
        XCTAssertNil(model.pendingSubmission); XCTAssertNil(try storage.load(model.recoveryScope)?.submission)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }
    func testRecoveryScopesSeparateConnectionNodeAndWindow() throws {
        let transport = AppContractTransport { request, _ in Self.response(request) }; defer { transport.close() }
        let storage = recoveryStore(), first = chat(transport, store: storage, windowID: "phone")
        var composer = NativeComposer(); composer.value = "/clear"
        let submission = NativeComposerSubmission(id: "command-1", kind: "command", turnID: nil, path: "/chats/node-1/execute-command", payload: ["command": "clear"], composer: composer, queueEntries: [])
        try storage.reserve(submission, queue: [], scope: first.recoveryScope)
        let same = chat(transport, store: storage, windowID: "phone"), otherWindow = chat(transport, store: storage, windowID: "tablet")
        XCTAssertEqual(same.pendingSubmission, submission); XCTAssertNil(otherWindow.pendingSubmission)
        let scope = first.recoveryScope
        XCTAssertNil(try storage.load(.init(connection: scope.connection, workspaceID: scope.workspaceID, nodeID: "node-2", windowID: scope.windowID)))
        XCTAssertNil(try storage.load(.init(connection: "https://other.michi.test", workspaceID: scope.workspaceID, nodeID: scope.nodeID, windowID: scope.windowID)))
    }
    func testInvalidRecoveryStorageBlocksTurnBeforePOSTWithoutClearingComposer() async throws {
        for corrupt in [true, false] {
            let storage = recoveryStore()
            let transport = AppContractTransport { request, _ in Self.response(request) }
            let initial = chat(transport, store: storage)
            if corrupt {
                try FileManager.default.createDirectory(at: storage.directory!, withIntermediateDirectories: true)
                try Data("corrupt".utf8).write(to: storage.fileURL(initial.recoveryScope))
            } else { try Data("not a directory".utf8).write(to: storage.directory!) }
            let model = chat(transport, store: storage)
            await model.load(); model.draft = "Never lose this"; model.send()
            if !corrupt { await eventually { model.error != nil } }
            XCTAssertEqual(model.draft, "Never lose this")
            XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/message") })
            cleanup(model, transport)
        }
    }

}
