import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func digestFollowUpGraph() -> WorkspaceGraph {
    var graph = appContractGraph()
    graph.raw["workspace"]["active_tree_id"] = "tree-1"
    graph.raw["nodes"] = [graph.nodes[0].merging(["kind": "chat"]),
        ["id": "source-2", "workspace_id": "workspace-1", "tree_id": "tree-1", "parent_node_id": "node-1", "kind": "chat", "deleted_at": .null, "status": "idle"],
        ["id": "digest-1", "workspace_id": "workspace-1", "tree_id": .null, "parent_node_id": .null, "kind": "digest", "title": "Saved findings", "deleted_at": .null,
         "digest": ["status": "idle", "generatedAt": 100, "viewedAt": 0, "sources": ["source-2", "node-1"], "content": "# Findings\nOriginal saved context\n\n## Open Questions & Future Directions\n- First question?\n* Second question?\n\n## References\nDo not include this"]]]
    graph.raw["edges"] = [["id": "branch-source", "workspace_id": "workspace-1", "source_node_id": "node-1", "target_node_id": "source-2", "kind": "branch"]]
    return graph
}

private func addingDigestFollowUp(_ payload: JSONValue, to original: WorkspaceGraph) -> WorkspaceGraph {
    var graph = original
    let node = payload["node"]
    graph.raw["nodes"] = .array(graph.nodes + [["id": node["id"], "workspace_id": .string(graph.id), "tree_id": node["treeId"], "parent_node_id": node["parentNodeId"],
                                               "kind": "chat", "title": node["title"], "status": "idle", "deleted_at": .null, "composer_draft": node["composerDraft"]]])
    graph.raw["edges"] = .array(graph.edges + payload["edges"].arrayValue.map { ["id": $0["id"], "workspace_id": .string(graph.id), "source_node_id": $0["sourceNodeId"], "target_node_id": $0["targetNodeId"], "kind": $0["kind"]] })
    return graph
}

@MainActor final class DigestFollowUpTests: XCTestCase {
    private func directory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("MichiDigestFollowUpTests-" + UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func model(_ transport: AppContractTransport, directory: URL? = nil) -> WorkspaceOverviewModel {
        WorkspaceOverviewModel(api: transport.api, graph: digestFollowUpGraph(), followUpRecoveryDirectory: directory ?? self.directory())
    }
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }
    private static func creationResponse(_ request: AppContractRequest, history: [AppContractRequest], unknown: Bool = false) -> AppContractResponse {
        if request.path == "/api/node-ids/allocate" { return .json(["nodeIds": ["followup-1"]]) }
        if request.path.hasSuffix("/graph/nodes/ensure") { return unknown ? .failure(.networkConnectionLost) : .json(["ok": true]) }
        if request.path == "/api/workspaces/workspace-1" {
            if let creation = history.last(where: { $0.path.hasSuffix("/graph/nodes/ensure") }) { return .json(addingDigestFollowUp(creation.body, to: digestFollowUpGraph()).raw) }
            return .json(digestFollowUpGraph().raw)
        }
        return .json(["error": "Unexpected request"], status: 400)
    }
    func testQuestionParserSupportsCurrentAndLegacyMarkers() {
        let markdown = digestFollowUpGraph().node("digest-1")!["digest"]["content"].stringValue
        XCTAssertEqual(NativeDigestFollowUp.questions(markdown), ["First question?", "Second question?"])
        XCTAssertEqual(NativeDigestFollowUp.questions("Overview\nOpen Threads:\n- Does √dₖ hold at dₖ > 256?\n- Interaction with positional encoding?\n## More\nSkip"),
                       ["Does √dₖ hold at dₖ > 256?", "Interaction with positional encoding?"])
        XCTAssertEqual(NativeDigestFollowUp.questions("Just raw markdown"), [])
        XCTAssertEqual(NativeDigestFollowUp.questions("## Open Questions\n\n## More\nSkip"), [])
    }
    func testQuestionParserBoundsOutputWithoutChangingQuestionText() {
        let source = "Open Threads:\n" + (0..<110).map { "- Q\($0)?" }.joined(separator: "\n")
        XCTAssertEqual(NativeDigestFollowUp.questions(source).count, 100)
        XCTAssertEqual(NativeDigestFollowUp.questions("Open Threads:\n1. Preserve numbered text\n* **Keep markdown**"), ["1. Preserve numbered text", "**Keep markdown**"])
    }
    func testExploreCreatesSourceRootBranchWithAtomicDraftAndDurableReferenceOnly() async {
        let transport = AppContractTransport { request, history in Self.creationResponse(request, history: history) }; defer { transport.close() }
        let model = model(transport); await model.refresh(); model.selectDigest("digest-1")
        let id = await model.exploreDigest(question: "Explore this question")
        XCTAssertEqual(id, "followup-1")
        let body = transport.requests.first { $0.path.hasSuffix("/graph/nodes/ensure") }!.body
        XCTAssertEqual(body["node"]["parentNodeId"], "node-1"); XCTAssertEqual(body["node"]["treeId"], "tree-1")
        XCTAssertTrue(body["tree"].isNull)
        let draft = body["node"]["composerDraft"].parsedJSON
        XCTAssertEqual(draft["value"], "Explore this question"); XCTAssertEqual(draft[NativeDigestFollowUp.referenceKey]["digestId"], "digest-1")
        let link = body["edges"].arrayValue.first { $0["kind"] == "link" }
        XCTAssertEqual(link?["sourceNodeId"], "digest-1"); XCTAssertEqual(link?["targetNodeId"], "followup-1")
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/ensure-session") || $0.path.hasSuffix("/message") })
        XCTAssertNil(model.pendingFollowUp)
    }
    func testUnknownCreationSurvivesRecreationAndChecksOriginalIDWithoutAnotherPOST() async {
        let storage = directory()
        let transport = AppContractTransport { request, history in Self.creationResponse(request, history: history, unknown: true) }; defer { transport.close() }
        let first = model(transport, directory: storage); await first.refresh(); first.selectDigest("digest-1")
        let created = await first.exploreDigest(question: "Do not duplicate")
        XCTAssertNil(created); XCTAssertNotNil(first.pendingFollowUp)
        let recreated = model(transport, directory: storage); await recreated.refresh(); recreated.selectDigest("digest-1")
        XCTAssertFalse(recreated.canExploreDigest)
        XCTAssertEqual(recreated.pendingFollowUp, first.pendingFollowUp)
        let id = await recreated.checkPendingFollowUp(); XCTAssertEqual(id, "followup-1")
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/node-ids/allocate" }.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/graph/nodes/ensure") }.count, 1)
        XCTAssertNil(recreated.pendingFollowUp)
    }
    func testUnconfirmedMissingCreationCannotAllocateReplacement() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/node-ids/allocate" { return .json(["nodeIds": ["followup-1"]]) }
            if request.path.hasSuffix("/graph/nodes/ensure") { return .failure(.networkConnectionLost) }
            return .json(digestFollowUpGraph().raw)
        }; defer { transport.close() }
        let model = model(transport); await model.refresh(); model.selectDigest("digest-1")
        _ = await model.exploreDigest(question: "Keep original")
        _ = await model.checkPendingFollowUp(); _ = await model.exploreDigest(question: "Must not replace")
        XCTAssertNotNil(model.pendingFollowUp)
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/node-ids/allocate" }.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/graph/nodes/ensure") }.count, 1)
    }
    func testFreshArchivedMissingAndForeignSourcesRejectBeforeAllocation() async {
        for variant in 0..<5 {
            var changed = digestFollowUpGraph()
            switch variant {
            case 0: changed.raw["workspace"]["archived_at"] = 10
            case 1: changed.raw["trees"] = .array(changed.trees.map { $0.merging(["archived_at": 10]) })
            case 2: changed.raw["nodes"] = .array(changed.nodes.map { $0["kind"] == "chat" ? $0.merging(["deleted_at": 10]) : $0 })
            case 3: changed.raw["nodes"] = .array(changed.nodes.filter { $0.id != "node-1" })
            default: changed.raw["nodes"] = .array(changed.nodes.map { $0.id == "source-2" ? $0.merging(["workspace_id": "foreign"]) : $0 })
            }
            let snapshot = changed.raw
            let transport = AppContractTransport { _, history in .json(history.count == 1 ? digestFollowUpGraph().raw : snapshot) }
            let model = model(transport); await model.refresh(); model.selectDigest("digest-1")
            let id = await model.exploreDigest(question: "Do not create"); XCTAssertNil(id)
            XCTAssertFalse(transport.requests.contains { $0.method == "POST" }); transport.close()
        }
    }
    func testSourceChangeDuringAllocationCannotCreateUnderStaleRoot() async {
        let transport = AppContractTransport { request, history in
            if request.path == "/api/node-ids/allocate" { return .json(["nodeIds": ["unused-id"]]) }
            var graph = digestFollowUpGraph()
            if history.contains(where: { $0.path == "/api/node-ids/allocate" }) { graph.raw["trees"] = .array(graph.trees.map { $0.merging(["archived_at": 10]) }) }
            return .json(graph.raw)
        }; defer { transport.close() }
        let model = model(transport); await model.refresh(); model.selectDigest("digest-1")
        let result = await model.exploreDigest(question: "Check freshness"); XCTAssertNil(result)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertNil(model.pendingFollowUp)
    }
    func testOldQuestionCannotCrossDigestSelectionBoundary() async {
        let transport = AppContractTransport { request, history in Self.creationResponse(request, history: history) }; defer { transport.close() }
        let model = model(transport); await model.refresh(); model.selectDigest("digest-1")
        let id = await model.exploreDigest(question: "Stale question", digestID: "different-digest")
        XCTAssertNil(id); XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }
    func testRestartHydratesDraftAndInitialEnsureSessionIncludesExactDigestContext() async throws {
        let original = digestFollowUpGraph(), payload = try NativeDigestFollowUp.creation(graph: digestFollowUpGraph(), digestID: "digest-1", nodeID: "followup-1", question: "My editable question")
        let persistedGraph = addingDigestFollowUp(payload, to: original)
        let roundTripped = WorkspaceGraph(raw: try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(persistedGraph.raw)))
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/workspaces/workspace-1" { return .json(roundTripped.raw) }
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/message") {
                let stamp: JSONValue = ["nodeId": "followup-1", "turnId": request.body["turnId"], "assistantId": "a-followup"]
                return .events([("turn_start", stamp.merging(["seq": 0])), ("done", stamp.merging(["seq": 1]))])
            }
            return .json(["sessionState": [:], "runtime": "codex", "ok": true])
        }; defer { transport.close() }
        let chat = ChatController(api: transport.api, graph: roundTripped, node: roundTripped.node("followup-1")!, recoveryStore: NativeComposerRecoveryStore(directory: directory()), windowID: "restart-test")
        defer { chat.detach() }
        XCTAssertEqual(chat.draft, "My editable question")
        await chat.load(); XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/ensure-session") || $0.path.hasSuffix("/message") })
        chat.draft = "Edited question"; chat.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } && !chat.busy }
        let ensure = transport.requests.first { $0.path.hasSuffix("/ensure-session") }!.body
        XCTAssertEqual(ensure["parentChatId"], "node-1")
        XCTAssertEqual(ensure["mergeContexts"], [.string("=== Digest: Saved findings ===\n" + original.node("digest-1")!["digest"]["content"].stringValue)])
        XCTAssertEqual(transport.requests.first { $0.path.hasSuffix("/message") }?.body["displayText"], "Edited question")
        XCTAssertEqual(chat.node["composer_draft"].parsedJSON[NativeDigestFollowUp.referenceKey], payload["node"]["composerDraft"].parsedJSON[NativeDigestFollowUp.referenceKey])
    }
    func testMissingDeletedChangedDigestOrLinkFailsClosedBeforeSessionAndMessage() async throws {
        let payload = try NativeDigestFollowUp.creation(graph: digestFollowUpGraph(), digestID: "digest-1", nodeID: "followup-1", question: "Keep this draft")
        let persisted = addingDigestFollowUp(payload, to: digestFollowUpGraph())
        for variant in 0..<5 {
            var changed = persisted
            switch variant {
            case 0: changed.raw["nodes"] = .array(changed.nodes.filter { $0.id != "digest-1" })
            case 1: changed.raw["nodes"] = .array(changed.nodes.map { $0.id == "digest-1" ? $0.merging(["deleted_at": 10]) : $0 })
            case 2: changed.raw["nodes"] = .array(changed.nodes.map { row in var node = row; if node.id == "digest-1" { node["digest"]["content"] = "New generation" }; return node })
            case 3: changed.raw["edges"] = .array(changed.edges.filter { $0["kind"] != "link" })
            default: changed.raw["trees"] = .array(changed.trees.map { $0.merging(["archived_at": 10]) })
            }
            let response = changed.raw
            let transport = AppContractTransport { request, _ in request.path == "/api/workspaces/workspace-1" ? .json(response) : .json(["messages": [], "runtime": "codex"]) }
            let chat = ChatController(api: transport.api, graph: persisted, node: persisted.node("followup-1")!, recoveryStore: NativeComposerRecoveryStore(directory: directory()))
            await chat.load(); chat.send(); await eventually { chat.error != nil && !chat.busy }
            XCTAssertEqual(chat.draft, "Keep this draft")
            XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/ensure-session") || $0.path.hasSuffix("/message") })
            chat.detach(); transport.close()
        }
    }
    func testArbitraryDigestLinkDoesNotInjectContextAndIncompleteNativeReferenceFailsClosed() throws {
        var graph = digestFollowUpGraph(), node = graph.nodes[0]
        graph.raw["edges"] = .array(graph.edges + [["id": "ordinary-link", "workspace_id": "workspace-1", "source_node_id": "digest-1", "target_node_id": .string(node.id), "kind": "link"]])
        XCTAssertNil(try NativeDigestFollowUp.savedReference(node: node, graph: graph))
        node["composer_draft"] = [NativeDigestFollowUp.referenceKey: ["version": 1, "digestId": "digest-1"]]
        XCTAssertThrowsError(try NativeDigestFollowUp.savedReference(node: node, graph: graph))
    }
    func testReadReceiptOnlyMergesViewedAtForItsOwnGeneration() async {
        let transport = AppContractTransport { _, _ in .json(digestFollowUpGraph().raw) }; defer { transport.close() }
        let model = model(transport); await model.refresh()
        let original = model.graph.node("digest-1")!
        model.applyDigestReadReceipt(.init(workspaceID: "workspace-1", nodeID: "digest-1", generatedAt: 99, viewedAt: 200))
        XCTAssertEqual(model.graph.node("digest-1"), original)
        model.applyDigestReadReceipt(.init(workspaceID: "workspace-1", nodeID: "digest-1", generatedAt: 100, viewedAt: 200))
        XCTAssertEqual(model.graph.node("digest-1")?["digest"]["content"], original["digest"]["content"])
        XCTAssertEqual(model.graph.node("digest-1")?["digest"]["viewedAt"], 200)
    }
    func testFollowUpRecoveryIsWrittenBeforeGraphPOST() async {
        let storage = directory()
        let transport = AppContractTransport { request, history in
            if request.path.hasSuffix("/graph/nodes/ensure") {
                do {
                    let files = try FileManager.default.contentsOfDirectory(at: storage, includingPropertiesForKeys: nil)
                    let saved = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: XCTUnwrap(files.first)))
                    XCTAssertEqual(saved, request.body)
                } catch { XCTFail("Follow-up payload was not saved before POST: \(error)") }
            }
            return Self.creationResponse(request, history: history)
        }; defer { transport.close() }
        let model = model(transport, directory: storage); await model.refresh(); model.selectDigest("digest-1")
        let id = await model.exploreDigest(question: "Saved before transport"); XCTAssertEqual(id, "followup-1")
    }
    func testContextRefreshFailureDoesNotSilentlyDropDigestPreamble() async throws {
        let payload = try NativeDigestFollowUp.creation(graph: digestFollowUpGraph(), digestID: "digest-1", nodeID: "followup-1", question: "Preserved")
        let graph = addingDigestFollowUp(payload, to: digestFollowUpGraph())
        let transport = AppContractTransport { request, _ in
            request.path == "/api/workspaces/workspace-1" ? .failure(.networkConnectionLost) : .json(["messages": [], "runtime": "codex"])
        }; defer { transport.close() }
        let chat = ChatController(api: transport.api, graph: graph, node: graph.node("followup-1")!, recoveryStore: NativeComposerRecoveryStore(directory: directory()))
        defer { chat.detach() }
        await chat.load(); chat.send(); await eventually { chat.error != nil && !chat.busy }
        XCTAssertEqual(chat.draft, "Preserved")
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

    func testExistingDurableUserHistoryContinuesAfterDigestRebuildOrDeletion() async throws {
        let payload = try NativeDigestFollowUp.creation(graph: digestFollowUpGraph(), digestID: "digest-1", nodeID: "followup-1", question: "Original question")
        let persisted = addingDigestFollowUp(payload, to: digestFollowUpGraph())
        for deleted in [false, true] {
            var changed = persisted
            changed.raw["nodes"] = .array(changed.nodes.compactMap { row -> JSONValue? in
                guard row.id == "digest-1" else { return row }
                if deleted { return nil }
                var node = row; node["digest"]["content"] = "A later digest"; node["digest"]["generatedAt"] = 200; return node
            })
            let current = changed
            let transport = AppContractTransport { request, _ in
                if request.path.hasSuffix("/messages") { return .json(["messages": [["id": "durable-user-1", "node_id": "followup-1", "workspace_id": "workspace-1", "role": "user", "content": "Original question", "seq": 0]]]) }
                if request.path == "/api/workspaces/workspace-1" { return .json(current.raw) }
                if request.path.hasSuffix("/message") {
                    let stamp: JSONValue = ["nodeId": "followup-1", "turnId": request.body["turnId"], "assistantId": "continued-assistant"]
                    return .events([("turn_start", stamp.merging(["seq": 0])), ("done", stamp.merging(["seq": 1]))])
                }
                return .json(["sessionState": [:], "runtime": "codex", "ok": true])
            }
            let chat = ChatController(api: transport.api, graph: current, node: current.node("followup-1")!, recoveryStore: NativeComposerRecoveryStore(directory: directory()))
            await chat.load(); chat.draft = "Continue this conversation"; chat.send()
            await eventually { transport.requests.contains { $0.path.hasSuffix("/message") } && !chat.busy }
            XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/ensure-session") }.count, 1)
            XCTAssertTrue(transport.requests.first { $0.path.hasSuffix("/ensure-session") }!.body["mergeContexts"].isNull)
            XCTAssertFalse(transport.requests.contains { $0.path == "/api/workspaces/workspace-1" })
            chat.detach(); transport.close()
        }
    }
    func testOptimisticForeignAndAssistantRowsCannotSkipInitialDigestValidation() async throws {
        let payload = try NativeDigestFollowUp.creation(graph: digestFollowUpGraph(), digestID: "digest-1", nodeID: "followup-1", question: "Keep initial draft")
        let persisted = addingDigestFollowUp(payload, to: digestFollowUpGraph())
        var changed = persisted; changed.raw["nodes"] = .array(changed.nodes.filter { $0.id != "digest-1" })
        let missing = changed.raw
        let base: JSONValue = ["id": "row", "node_id": "followup-1", "role": "user", "content": "Not owned durable evidence", "seq": 0]
        let invalid = [base.merging(["node_id": "another-node"]), base.merging(["workspace_id": "foreign"]), base.merging(["role": "assistant"]), base.merging(["id": "pending-local"])]
        for row in invalid {
            let transport = AppContractTransport { request, _ in
                if request.path.hasSuffix("/messages") { return .json(["messages": [row]]) }
                if request.path == "/api/workspaces/workspace-1" { return .json(missing) }
                return .json(["runtime": "codex"])
            }
            let chat = ChatController(api: transport.api, graph: persisted, node: persisted.node("followup-1")!, recoveryStore: NativeComposerRecoveryStore(directory: directory()))
            await chat.load()
            chat.messages.append(NativeMessage(id: "pending-optimistic", role: "user", text: "Not saved"))
            chat.send(); await eventually { chat.error != nil && !chat.busy }
            XCTAssertEqual(chat.draft, "Keep initial draft")
            XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/ensure-session") || $0.path.hasSuffix("/message") })
            chat.detach(); transport.close()
        }
    }
    func testTerminalHistoryHydrationStopsReseedingDigestOnNextTurn() async throws {
        let payload = try NativeDigestFollowUp.creation(graph: digestFollowUpGraph(), digestID: "digest-1", nodeID: "followup-1", question: "First question")
        let graph = addingDigestFollowUp(payload, to: digestFollowUpGraph())
        let transport = AppContractTransport { request, history in
            let posts = history.filter { $0.path.hasSuffix("/message") }.count
            if request.path.hasSuffix("/messages") { return .json(["messages": posts == 0 ? [] : [["id": "saved-user", "node_id": "followup-1", "role": "user", "content": "First question", "seq": 0]]]) }
            if request.path == "/api/workspaces/workspace-1" {
                var current = graph
                if posts > 0 { current.raw["nodes"] = .array(current.nodes.filter { $0.id != "digest-1" }) }
                return .json(current.raw)
            }
            if request.path.hasSuffix("/message") {
                let stamp: JSONValue = ["nodeId": "followup-1", "turnId": request.body["turnId"], "assistantId": .string("assistant-\(posts)")]
                return .events([("turn_start", stamp.merging(["seq": 0])), ("done", stamp.merging(["seq": 1]))])
            }
            return .json(["sessionState": [:], "runtime": "codex", "ok": true])
        }; defer { transport.close() }
        let chat = ChatController(api: transport.api, graph: graph, node: graph.node("followup-1")!, recoveryStore: NativeComposerRecoveryStore(directory: directory()))
        defer { chat.detach() }
        await chat.load(); chat.send(); await eventually { transport.requests.filter { $0.path.hasSuffix("/message") }.count == 1 && !chat.busy }
        chat.draft = "Follow up again"; chat.send()
        await eventually { transport.requests.filter { $0.path.hasSuffix("/message") }.count == 2 && !chat.busy }
        let sessions = transport.requests.filter { $0.path.hasSuffix("/ensure-session") }
        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(sessions.first?.body["mergeContexts"].arrayValue.count, 1)
        XCTAssertTrue(sessions.last!.body["mergeContexts"].isNull)
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/workspaces/workspace-1" }.count, 1)
    }

}
