import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func referenceNode(_ id: String = "node-1") -> JSONValue {
    ["id": .string(id), "workspace_id": "workspace-1", "tree_id": "tree-1", "kind": "chat", "title": "Saved source", "deleted_at": .null]
}
private func referenceGraph(node: JSONValue = referenceNode()) -> JSONValue {
    ["workspace": ["id": "workspace-1", "name": "Owned workspace", "deleted_at": .null],
     "nodes": .array([node]), "trees": [["id": "tree-1", "workspace_id": "workspace-1", "root_node_id": node["id"]]], "edges": [], "contexts": []]
}
private func referenceMessage(_ id: String = "answer-1", node: String = "node-1", role: String = "assistant", seq: Int = 2) -> JSONValue {
    ["id": .string(id), "node_id": .string(node), "role": .string(role), "seq": .number(Double(seq)), "content": .string("Saved " + id),
     "metadata": "{\"turnId\":\"untrusted-metadata-turn\"}", "blocks": "[]", "tool_calls": "[]"]
}
private func referencePreview(node: String = "node-1", message: String = "answer-1", turn: String = "turn-1") -> JSONValue {
    ["nodeId": .string(node), "workspaceId": "workspace-1", "state": "live",
     "message": ["id": .string(message), "role": "assistant", "turnId": .string(turn)]]
}
private func referenceTransport(graph: JSONValue = referenceGraph(), messages: [JSONValue] = [referenceMessage()], preview: JSONValue = referencePreview()) -> AppContractTransport {
    AppContractTransport { request, _ in
        guard request.method == "GET", request.body.isNull else { return .json(["error": "No writes allowed"], status: 500) }
        switch request.path {
        case "/api/workspaces/all": return .json(["workspaces": .array([graph])])
        case "/api/workspaces/workspace-1/trees/tree-1/messages": return .json(["messages": .array(messages)])
        case "/api/spaces-home/source": return .json(preview)
        default: return .json(["error": "Unexpected request"], status: 500)
        }
    }
}

@MainActor final class NativeReferenceTests: XCTestCase {
    func testOnlyOrdinaryOwnedChatsOfferInteractiveContinuation() {
        let node = referenceNode()
        XCTAssertTrue(NativeReferenceConversation.canOpenConversation(graph: WorkspaceGraph(raw: referenceGraph()), node: node))
        var system = referenceGraph(); system["workspace"]["settings"] = "{\"system\":\"meta-agent\"}"
        XCTAssertFalse(NativeReferenceConversation.canOpenConversation(graph: WorkspaceGraph(raw: system), node: node))
        for field in ["page_id", "maintenance_job_id"] {
            var helper = node; helper[field] = "owned-helper"
            XCTAssertFalse(NativeReferenceConversation.canOpenConversation(graph: WorkspaceGraph(raw: referenceGraph(node: helper)), node: helper))
        }
        var digest = node; digest["kind"] = "digest"
        XCTAssertFalse(NativeReferenceConversation.canOpenConversation(graph: WorkspaceGraph(raw: referenceGraph(node: digest)), node: digest))
        var moved = node; moved["workspace_id"] = "other-workspace"
        XCTAssertFalse(NativeReferenceConversation.canOpenConversation(graph: WorkspaceGraph(raw: referenceGraph(node: moved)), node: moved))
        var deleted = referenceGraph(); var trees = deleted["trees"].arrayValue
        trees[0]["deleted_at"] = 1; deleted["trees"] = .array(trees)
        XCTAssertFalse(NativeReferenceConversation.canOpenConversation(graph: WorkspaceGraph(raw: deleted), node: node))
    }

    private func conversation(_ model: NativeReferenceModel, file: StaticString = #filePath, line: UInt = #line) -> NativeReferenceConversation? {
        guard case .conversation(let result) = model.resolved else { XCTFail(model.error ?? "No conversation", file: file, line: line); return nil }
        return result
    }

    func testPlainNodeReadsOwnedFullHistoryInSequenceWithoutActivation() async {
        let transport = referenceTransport(messages: [referenceMessage(), referenceMessage("foreign", node: "other"), referenceMessage("question", role: "user", seq: 1)])
        defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.node(id: "node-1", messageID: nil))
        let result = conversation(model)
        XCTAssertEqual(result?.graph.id, "workspace-1"); XCTAssertEqual(result?.node.id, "node-1")
        XCTAssertEqual(result?.messages.map(\.id), ["question", "answer-1"])
        XCTAssertNil(result?.targetMessageID); XCTAssertNil(model.error); XCTAssertFalse(model.loading)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(transport.requests.first?.query, ["meta": "1"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" && $0.body.isNull })
    }

    func testExactMessageReferenceNeverFallsBackToOtherNodeOrNearestAnswer() async {
        let transport = referenceTransport(messages: [referenceMessage("wanted", node: "other"), referenceMessage()]); defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.node(id: "node-1", messageID: "wanted"))
        XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testUserMessageLinkIsAllowedWhileSourceRequiresAssistantRole() async {
        let transport = referenceTransport(messages: [referenceMessage(role: "user")]); defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.node(id: "node-1", messageID: "answer-1"))
        XCTAssertEqual(conversation(model)?.targetMessageID, "answer-1")
        await model.open(.source(nodeID: "node-1", turnID: "turn-1", assistantID: "answer-1"))
        XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/source") })
    }

    func testExactHelperSourceReadsArchivedHistoryWithoutCreatingOrActivatingHelper() async {
        var graph = referenceGraph(node: referenceNode().merging(["page_id": "page-1", "status": "archived"]))
        graph["workspace"] = graph["workspace"].merging(["archived_at": 2])
        graph["trees"] = .array(graph["trees"].arrayValue.map { $0.merging(["archived_at": 2]) })
        let transport = referenceTransport(graph: graph, messages: [referenceMessage("decoy", seq: 3), referenceMessage()], preview: referencePreview().merging(["state": "archived"]))
        defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.source(nodeID: "node-1", turnID: "turn-1", assistantID: "answer-1"))
        let result = conversation(model)
        XCTAssertEqual(result?.kind, "helper"); XCTAssertEqual(result?.targetMessageID, "answer-1")
        XCTAssertEqual(result?.messages.map(\.id), ["answer-1", "decoy"])
        XCTAssertEqual(transport.requests.last?.query, ["nodeId": "node-1", "messageId": "answer-1"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testMaintenanceSourceUsesReadOnlyHistoryAndOpaqueSourceIDs() async {
        let nodeID = "helper/with spaces 🦉", assistant = "reply/回答?&%", turn = "turn/one ."
        let transport = referenceTransport(graph: referenceGraph(node: referenceNode(nodeID).merging(["maintenance_job_id": "job-1"])),
                                           messages: [referenceMessage(assistant, node: nodeID)], preview: referencePreview(node: nodeID, message: assistant, turn: turn))
        defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.source(nodeID: nodeID, turnID: turn, assistantID: assistant))
        XCTAssertEqual(conversation(model)?.kind, "maintenance")
        XCTAssertEqual(conversation(model)?.targetMessageID, assistant)
        XCTAssertEqual(transport.requests.last?.query, ["nodeId": nodeID, "messageId": assistant])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testSourceRejectsWrongTurnAliasRoleWorkspaceNodeAndDeletedPreview() async {
        for preview in [referencePreview(turn: "other-turn"), referencePreview(message: "runtime-alias"), referencePreview(node: "other"),
                        referencePreview().merging(["workspaceId": "foreign"]), referencePreview().merging(["state": "deleted"]),
                        referencePreview().merging(["message": ["id": "answer-1", "role": "user", "turnId": "turn-1"]])] {
            let transport = referenceTransport(preview: preview); defer { transport.close() }
            let model = NativeReferenceModel(api: transport.api)
            await model.open(.source(nodeID: "node-1", turnID: "turn-1", assistantID: "answer-1"))
            XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
            XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
        }
    }

    func testDeletedWorkspaceNodeAndMismatchedTreeOwnershipStopBeforeHistory() async {
        let base = referenceGraph()
        let invalid = [
            base.merging(["workspace": base["workspace"].merging(["deleted_at": 4])]),
            base.merging(["workspace": base["workspace"].merging(["purged_at": 4])]),
            referenceGraph(node: referenceNode().merging(["deleted_at": 4])),
            referenceGraph(node: referenceNode().merging(["purged_at": 4])),
            referenceGraph(node: referenceNode().merging(["workspace_id": "foreign"])),
            referenceGraph(node: referenceNode().merging(["tree_id": "missing"])),
            base.merging(["trees": [["id": "tree-1", "workspace_id": "foreign"]]]),
            base.merging(["trees": [["id": "tree-1", "workspace_id": "workspace-1", "deleted_at": 1]]]),
            base.merging(["nodes": .array([referenceNode(), referenceNode()])])
        ]
        for graph in invalid {
            let transport = referenceTransport(graph: graph); defer { transport.close() }
            let model = NativeReferenceModel(api: transport.api)
            await model.open(.node(id: "node-1", messageID: nil))
            XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
            XCTAssertEqual(transport.requests.count, 1)
        }
    }

    func testPageWorkspaceComesFromAuthoritativePageAndMustBeOwned() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/pages/page-1" { return .json(["page": ["id": "page-1", "workspaceId": "workspace-1", "revision": 1, "blocks": [["id": "markdown", "type": "markdown", "text": "# First\n\nParagraph\n\n## Second"]]]]) }
            return .json(["workspaces": .array([referenceGraph()])])
        }; defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.page(id: "page-1", blockID: "markdown~2"))
        guard case .page(let id, let workspace, let block) = model.resolved else { return XCTFail(model.error ?? "No page") }
        XCTAssertEqual(id, "page-1"); XCTAssertEqual(workspace, "workspace-1"); XCTAssertEqual(block, "markdown~2")
        XCTAssertEqual(transport.requests.map(\.path), ["/api/pages/page-1", "/api/workspaces/all"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testPageRejectsWrongIdentityDeletionAndUnownedWorkspace() async {
        let pages: [JSONValue] = [
            ["id": "other", "workspaceId": "workspace-1", "revision": 1, "blocks": []],
            ["id": "page-1", "workspaceId": "workspace-1", "revision": 1, "deleted_at": 2, "blocks": []],
            ["id": "page-1", "workspaceId": "foreign", "revision": 1, "blocks": []]
        ]
        for page in pages {
            let transport = AppContractTransport { request, _ in
                request.path.hasPrefix("/api/pages/") ? .json(page) : .json(["workspaces": .array([referenceGraph()])])
            }; defer { transport.close() }
            let model = NativeReferenceModel(api: transport.api)
            await model.open(.page(id: "page-1", blockID: nil))
            XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
        }
    }

    func testPageMissingStaleOrDuplicateBlockCannotSilentlyOpenPageTop() async {
        let blocks: [[JSONValue]] = [[],
            [["id": "wanted", "type": "heading", "text": "One"], ["id": "wanted", "type": "heading", "text": "Two"]],
            [["id": "wanted", "type": "markdown", "text": "# One heading only"]]]
        for (index, content) in blocks.enumerated() {
            let transport = AppContractTransport { _, _ in
                .json(["id": "page-1", "workspaceId": "workspace-1", "revision": 1, "blocks": .array(content)])
            }; defer { transport.close() }
            let model = NativeReferenceModel(api: transport.api)
            await model.open(.page(id: "page-1", blockID: index == 2 ? "wanted~0" : "wanted"))
            XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
            XCTAssertEqual(transport.requests.count, 1)
        }
    }

    func testCancelPreservesRenderedDestinationWhenNavigationPushesChild() async {
        let transport = referenceTransport(); defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.node(id: "node-1", messageID: nil))
        model.cancel()
        XCTAssertEqual(conversation(model)?.node.id, "node-1")
        XCTAssertFalse(model.loading); XCTAssertNil(model.error)
    }

    func testReopenAfterCancelDoesNotRefetchOrDropTheSameResolvedDestination() async {
        let transport = referenceTransport(); defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        let reference = NativeMichiReference.node(id: "node-1", messageID: nil)
        await model.open(reference)
        XCTAssertEqual(conversation(model)?.node.id, "node-1")
        XCTAssertEqual(transport.requests.count, 2)
        model.cancel()
        await model.open(reference)
        XCTAssertEqual(conversation(model)?.node.id, "node-1")
        XCTAssertFalse(model.loading); XCTAssertNil(model.error)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testRetryAfterFailureStillReadsTheSameReference() async {
        var unavailable = true
        let transport = AppContractTransport { request, _ in
            if unavailable { return .json(["error": "Unavailable"], status: 503) }
            if request.path == "/api/workspaces/all" { return .json(["workspaces": .array([referenceGraph()])]) }
            if request.path.hasSuffix("/messages") { return .json(["messages": .array([referenceMessage()])]) }
            return .json(["error": "Unexpected request"], status: 500)
        }; defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        let reference = NativeMichiReference.node(id: "node-1", messageID: nil)
        await model.open(reference)
        XCTAssertNil(model.resolved); XCTAssertNotNil(model.error); XCTAssertEqual(transport.requests.count, 1)
        unavailable = false
        await model.open(reference)
        XCTAssertEqual(conversation(model)?.node.id, "node-1")
        XCTAssertNil(model.error); XCTAssertFalse(model.loading)
        XCTAssertEqual(transport.requests.count, 3)
    }

    func testFailedHydrationAndInvalidDirectReferencesNeverReadHistoryOrWrite() async {
        let transport = AppContractTransport { _, _ in .json(["error": "Unavailable"], status: 503) }; defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.source(nodeID: "n", turnID: "", assistantID: "a"))
        XCTAssertTrue(transport.requests.isEmpty); XCTAssertNotNil(model.error)
        await model.open(.node(id: "node-1", messageID: nil))
        XCTAssertNil(model.resolved); XCTAssertNotNil(model.error); XCTAssertFalse(model.loading)
        XCTAssertEqual(transport.requests.count, 1); XCTAssertEqual(transport.requests.first?.method, "GET")
    }

    func testMalformedOrDuplicateHistoryCannotResolveAnExactTarget() async {
        for messages in [[referenceMessage(), referenceMessage()], [referenceMessage().merging(["seq": -1])], [referenceMessage().merging(["content": .null])]] {
            let transport = referenceTransport(messages: messages); defer { transport.close() }
            let model = NativeReferenceModel(api: transport.api)
            await model.open(.node(id: "node-1", messageID: "answer-1"))
            XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
        }
    }

    func testCanonicalUnicodeAliasesNeverResolveNodeMessageOrTurn() async {
        let composed = "é", decomposed = "e\u{0301}"
        let cases: [(NativeMichiReference, JSONValue, [JSONValue], JSONValue)] = [
            (.source(nodeID: decomposed, turnID: "turn-1", assistantID: "answer-1"), referenceGraph(node: referenceNode(composed)), [referenceMessage(node: composed)], referencePreview(node: composed)),
            (.source(nodeID: "node-1", turnID: "turn-1", assistantID: decomposed), referenceGraph(), [referenceMessage(composed)], referencePreview(message: composed)),
            (.source(nodeID: "node-1", turnID: decomposed, assistantID: "answer-1"), referenceGraph(), [referenceMessage()], referencePreview(turn: composed))
        ]
        for (reference, graph, messages, preview) in cases {
            let transport = referenceTransport(graph: graph, messages: messages, preview: preview); defer { transport.close() }
            let model = NativeReferenceModel(api: transport.api)
            await model.open(reference)
            XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
        }
    }

    func testCanonicalCollisionInMessageHistoryCannotShareSwiftUIScrollAnchor() async {
        let transport = referenceTransport(messages: [referenceMessage("é"), referenceMessage("e\u{0301}", seq: 3)])
        defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        await model.open(.source(nodeID: "node-1", turnID: "turn-1", assistantID: "é"))
        XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testWorkspaceAndTreeOwnershipUseByteIdentityAndDistinctGraphsDoNotCollapse() async {
        let composed = "é", decomposed = "e\u{0301}"
        var graph = referenceGraph()
        graph["workspace"] = graph["workspace"].merging(["id": .string(composed)])
        graph["nodes"] = .array([referenceNode().merging(["workspace_id": .string(composed), "tree_id": .string(composed)])])
        graph["trees"] = [["id": .string(composed), "workspace_id": .string(composed)]]
        let other: JSONValue = ["workspace": ["id": .string(decomposed)], "nodes": [], "trees": [], "edges": [], "contexts": []]
        var preview = referencePreview().merging(["workspaceId": .string(composed)])
        let variants = [graph,
                        graph.merging(["nodes": .array([referenceNode().merging(["workspace_id": .string(decomposed), "tree_id": .string(composed)])])]),
                        graph.merging(["trees": [["id": .string(decomposed), "workspace_id": .string(composed)]]]),
                        graph.merging(["trees": [["id": .string(composed), "workspace_id": .string(decomposed)]]]),
                        graph]
        for (index, candidate) in variants.enumerated() {
            if index == 4 { preview["workspaceId"] = .string(decomposed) }
            let receipt = preview
            let transport = AppContractTransport { request, _ in
                if request.path == "/api/workspaces/all" { return .json(["workspaces": .array([candidate, other])]) }
                if request.path.hasSuffix("/messages") { return .json(["messages": .array([referenceMessage()])]) }
                if request.path == "/api/spaces-home/source" { return .json(receipt) }
                return .json(["error": "Unexpected"], status: 500)
            }; defer { transport.close() }
            let model = NativeReferenceModel(api: transport.api)
            await model.open(.source(nodeID: "node-1", turnID: "turn-1", assistantID: "answer-1"))
            if index == 0 {
                XCTAssertEqual(conversation(model)?.graph.id.utf8.map { $0 }, Array(composed.utf8))
                XCTAssertNil(model.error)
            } else {
                XCTAssertNil(model.resolved); XCTAssertNotNil(model.error)
            }
            XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
        }
    }

    func testReplacementCancelsDelayedReadAndOldResultCannotOverwriteNewPage() async {
        let started = expectation(description: "First reference GET started")
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/pages/old" {
                started.fulfill()
                return .delayedJSON(["id": "old", "workspaceId": "workspace-1", "revision": 1, "blocks": []], status: 200, delay: 0.15)
            }
            if request.path == "/api/pages/new" { return .json(["id": "new", "workspaceId": "workspace-1", "revision": 1, "blocks": [["id": "b", "type": "heading", "text": "Target"]]]) }
            return .json(["workspaces": .array([referenceGraph()])])
        }; defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        let previous = Task { await model.open(.page(id: "old", blockID: nil)) }
        await fulfillment(of: [started], timeout: 2)
        await model.open(.page(id: "new", blockID: "b"))
        await previous.value
        guard case .page(let id, _, let block) = model.resolved else { return XCTFail(model.error ?? "No current page") }
        XCTAssertEqual(id, "new"); XCTAssertEqual(block, "b"); XCTAssertNil(model.error); XCTAssertFalse(model.loading)
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/workspaces/all" }.count, 1)
    }

    func testCancelClearsReadAndPreventsDeferredHistoryFetch() async {
        let started = expectation(description: "Metadata GET started")
        let transport = AppContractTransport { _, _ in
            started.fulfill()
            return .delayedJSON(["workspaces": .array([referenceGraph()])], status: 200, delay: 0.15)
        }; defer { transport.close() }
        let model = NativeReferenceModel(api: transport.api)
        let opening = Task { await model.open(.node(id: "node-1", messageID: nil)) }
        await fulfillment(of: [started], timeout: 2)
        model.cancel(); await opening.value
        XCTAssertFalse(model.loading); XCTAssertNil(model.resolved); XCTAssertNil(model.error)
        XCTAssertEqual(transport.requests.count, 1)
    }
}
