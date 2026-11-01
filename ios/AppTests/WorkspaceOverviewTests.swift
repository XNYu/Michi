import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func overviewGraph(workspaceArchived: Bool = false, treeArchived: Bool = false) -> WorkspaceGraph {
    var graph = appContractGraph(workspaceArchived: workspaceArchived, treeArchived: treeArchived)
    graph.raw["nodes"] = .array(graph.nodes.map { $0.merging(["kind": "chat", "created_at": 10]) })
    graph.raw["workspace"] = graph.workspace.merging(["active_tree_id": "tree-1"])
    return graph
}

private func overviewNode(_ id: String, tree: String = "tree-1", kind: String = "chat", parent: String? = nil) -> JSONValue {
    ["id": .string(id), "workspace_id": "workspace-1", "tree_id": .string(tree), "kind": .string(kind),
     "parent_node_id": parent.map(JSONValue.string) ?? .null, "title": .string(id), "deleted_at": .null, "created_at": 20]
}

private func overviewEdge(_ source: String, _ target: String, kind: String = "branch") -> JSONValue {
    ["id": .string(source + "-" + target), "workspace_id": "workspace-1", "source_node_id": .string(source), "target_node_id": .string(target), "kind": .string(kind)]
}

private let overviewMessages: JSONValue = ["messages": [
    ["node_id": "node-1", "seq": 1, "role": "user", "content": "Summarize the plan"],
    ["node_id": "node-1", "seq": 2, "role": "assistant", "content": "Fallback must not replace answer blocks", "blocks": [
        ["id": "block-thought", "kind": "thinking", "rawText": "Private notes"],
        ["id": "block-tool", "kind": "tool", "toolCallId": "tool-1", "section": "answer", "rawOffset": 0],
        ["id": "block-answer", "kind": "answer", "rawText": "[TITLE: Planning]\nThe visible plan."]
    ]],
    ["node_id": "foreign-node", "seq": 3, "role": "user", "content": "Do not include this other conversation"]
]]

private func overviewResponse(_ request: AppContractRequest, graph: WorkspaceGraph) -> AppContractResponse {
    if request.method == "GET" && request.path.hasSuffix("/messages") { return .json(overviewMessages) }
    if request.method == "GET" && request.path.hasSuffix("/workspace-1") { return .json(graph.raw) }
    if request.path.hasSuffix("/digests/stream") { return .events([("status", ["text": "Thinking"]), ("chunk", ["text": "# Generated"]), ("done", ["markdown": "# Generated\n\nA saved digest."])]) }
    if request.path.hasSuffix("/node-ids/allocate") { return .json(["nodeIds": ["digest-new"]]) }
    if request.path.hasSuffix("/commands") {
        return .json(["ok": true, "operationId": request.body["operationId"], "applied": .array(request.body["commands"].arrayValue.map {
            ["type": $0["type"], "id": $0["payload"]["id"]]
        })])
    }
    return .json(["error": "Unexpected request"], status: 500)
}

@MainActor final class WorkspaceOverviewTests: XCTestCase {
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(5)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }
    private func clean(_ model: WorkspaceOverviewModel, _ transport: AppContractTransport) {
        model.detachGeneration()
        let key = "michi.\(transport.api.baseURL.absoluteString).workspace-1"
        UserDefaults.standard.removeObject(forKey: key + ".digest-generation")
        UserDefaults.standard.removeObject(forKey: key + ".digest-save")
        UserDefaults.standard.removeObject(forKey: key + ".digest-output")
        transport.close()
    }

    func testLoadingIsReadOnlyAndMustHydrateBeforeGeneration() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, _ in overviewResponse(request, graph: graph) }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        model.generate(); XCTAssertTrue(transport.requests.isEmpty)
        await model.refresh()
        XCTAssertTrue(model.hydrated); XCTAssertTrue(model.canGenerate)
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
        XCTAssertEqual(model.rows.map(\.id), ["node-1"])
    }

    func testFailedHydrationKeepsSnapshotAndBlocksGeneration() async {
        let transport = AppContractTransport { _, _ in .json(["error": "Offline"], status: 503) }
        let model = WorkspaceOverviewModel(api: transport.api, graph: overviewGraph()); defer { clean(model, transport) }
        await model.refresh(); model.generate()
        XCTAssertFalse(model.hydrated); XCTAssertFalse(model.generating)
        XCTAssertEqual(model.rows.map(\.id), ["node-1"]); XCTAssertNotNil(model.error)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testSnapshotWithForeignOwnerIsRejected() async {
        var graph = overviewGraph(); graph.raw["nodes"] = [overviewNode("foreign").merging(["workspace_id": "someone-else"])]
        let transport = AppContractTransport { _, _ in .json(graph.raw) }
        let model = WorkspaceOverviewModel(api: transport.api, graph: overviewGraph()); defer { clean(model, transport) }
        await model.refresh()
        XCTAssertFalse(model.hydrated); XCTAssertNotNil(model.error)
        XCTAssertEqual(model.graph.nodes.first?.id, "node-1")
    }

    func testArchiveGuardsPreventGenerationAndAllocation() async {
        for graph in [overviewGraph(workspaceArchived: true), overviewGraph(treeArchived: true)] {
            let transport = AppContractTransport { request, _ in overviewResponse(request, graph: graph) }
            let model = WorkspaceOverviewModel(api: transport.api, graph: graph)
            await model.refresh(); model.generate()
            XCTAssertTrue(model.readOnly); XCTAssertFalse(model.generating)
            XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
            clean(model, transport)
        }
    }

    func testArchivingBetweenRefreshAndGeneratePreventsPOST() async {
        let initial = overviewGraph(), archived = overviewGraph(workspaceArchived: true)
        let transport = AppContractTransport { _, requests in .json(requests.count == 1 ? initial.raw : archived.raw) }
        let model = WorkspaceOverviewModel(api: transport.api, graph: initial); defer { clean(model, transport) }
        await model.refresh(); model.generate(); await eventually { !model.generating }
        XCTAssertNotNil(model.error); XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testMapUsesBranchAndMergeEdgesAndExcludesNonConversationNodes() {
        var graph = overviewGraph()
        graph.raw["nodes"] = .array(graph.nodes + [overviewNode("branch"), overviewNode("linked"), overviewNode("digest", kind: "digest"),
            overviewNode("page").merging(["page_id": "page-1"]), overviewNode("deleted").merging(["deleted_at": 4]),
            overviewNode("maintenance").merging(["maintenance_job_id": "job-1"])])
        graph.raw["edges"] = [overviewEdge("node-1", "branch"), overviewEdge("branch", "node-1"),
            overviewEdge("node-1", "linked", kind: "link"), overviewEdge("node-1", "digest", kind: "digest-source"),
            overviewEdge("node-1", "page"), overviewEdge("node-1", "deleted"), overviewEdge("node-1", "maintenance")]
        XCTAssertEqual(WorkspaceOverviewModel.mapRows(graph: graph, treeID: "tree-1").map(\.id), ["node-1", "branch"])
    }

    func testMergeMapIncludesSourceAncestorsWithoutUsingCrossThreadSourcesForDigest() {
        var graph = overviewGraph()
        // Actual TreeRow wire schema: no synthetic `kind` field.
        graph.raw["trees"] = .array(graph.trees + [["id": "merged", "workspace_id": "workspace-1", "root_node_id": "merge-root", "name": "Merged investigation", "created_at": 20, "last_active_at": 30]])
        graph.raw["nodes"] = .array(graph.nodes + [overviewNode("branch", parent: "node-1"), overviewNode("merge-root", tree: "merged")])
        graph.raw["edges"] = [overviewEdge("node-1", "branch"), overviewEdge("branch", "merge-root", kind: "merge")]
        let transport = AppContractTransport { _, _ in .json(graph.raw) }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        model.selectTree("merged")
        XCTAssertEqual(Set(model.rows.map(\.id)), ["node-1", "branch", "merge-root"])
        XCTAssertEqual(model.sourceNodes.map(\.id), ["merge-root"])
    }

    func testTreeTitleUsesWireNameAndRootFallback() {
        let graph = overviewGraph()
        var tree = graph.trees[0].merging(["name": "My named thread", "title": "Not a wire column"])
        XCTAssertEqual(WorkspaceOverviewModel.treeTitle(tree, graph: graph), "My named thread")
        tree["name"] = "  "; tree["archived_at"] = 20
        XCTAssertEqual(WorkspaceOverviewModel.treeTitle(tree, graph: graph), "Conversation · Archived")
    }

    func testTimelineUsesMessageRowsAndOverviewJournalDates() {
        var graph = overviewGraph()
        graph.raw["nodes"] = .array(graph.nodes.map { $0.merging(["last_assistant_at": 999_999, "branch_overview": .string("[{\"at\":40,\"text\":\"First\"},{\"at\":80,\"text\":\"Latest\"}]")]) } + [
            overviewNode("message-newest"), overviewNode("empty"), overviewNode("foreign").merging(["workspace_id": "other-workspace"])
        ])
        graph.raw["messages"] = [
            ["node_id": "node-1", "created_at": 60], ["node_id": "message-newest", "created_at": 200],
            ["node_id": "message-newest", "created_at": 100], ["node_id": "empty", "created_at": "300"],
            ["node_id": "foreign", "created_at": 800], ["node_id": "missing", "created_at": 900]
        ]
        XCTAssertEqual(WorkspaceOverviewModel.activityDates(graph: graph), ["node-1": 80, "message-newest": 200, "empty": 20])
        XCTAssertEqual(WorkspaceOverviewModel.overview(graph.nodes[0]), "Latest")
    }

    func testOverviewJournalLegacyAndMalformedDatesAreHandled() {
        XCTAssertEqual(WorkspaceOverviewModel.overviewTrail(["branch_overview": " Legacy summary "]), [["at": 0, "text": "Legacy summary"]])
        let node: JSONValue = ["branch_overview": [["at": "99", "text": "Invalid timestamp"], ["at": 40, "text": " "], ["at": 80, "text": " Kept "]]]
        XCTAssertEqual(WorkspaceOverviewModel.overviewTrail(node), [["at": 80, "text": "Kept"]])
    }

    func testLongBranchChainIsIterativeAndCycleSafe() {
        var graph = overviewGraph()
        let nodes = (0..<10_000).map { overviewNode("deep-\($0)") }
        graph.raw["nodes"] = .array(graph.nodes + nodes)
        graph.raw["edges"] = .array([overviewEdge("node-1", "deep-0")] + (1..<10_000).map { overviewEdge("deep-\($0 - 1)", "deep-\($0)") } + [overviewEdge("deep-9999", "node-1")])
        let rows = WorkspaceOverviewModel.mapRows(graph: graph, treeID: "tree-1")
        XCTAssertEqual(rows.count, 10_001); XCTAssertEqual(rows.last?.depth, 20)
    }

    func testSourceProjectionAndFingerprintMatchWebPropertyOrderAndUTF16() {
        let snapshot = DigestSourceSnapshot(node: ["id": "n😀", "parent_node_id": "parent", "title": "A / B"], messages: [
            ["role": "user", "content": "  hi\n"], ["role": "assistant", "content": "answer\n"], ["role": "tool", "content": "private"]
        ])
        XCTAssertEqual(snapshot.canonicalJSON, #"{"nodeId":"n😀","parentNodeId":"parent","title":"A / B","depth":0,"messages":[{"role":"user","text":"  hi\n"},{"role":"assistant","text":"answer\n"}]}"#)
        // Golden produced independently by Node JSON.stringify + charCodeAt/FNV.
        XCTAssertEqual(snapshot.fingerprint, "v2:3f64b16b")
    }

    func testAssistantProjectionPreservesProseWhitespaceAndRemovesMetadata() {
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("  answer\n[TITLE: title]\n\nNext\n"), "  answer\nNext\n")
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("Answer [FOLLOW-UP 2/3: next?] \nMore"), "Answer More")
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("A [TIT"), "A ")
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("[note](https://example.com)\n"), "[note](https://example.com)\n")
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("[TITLE:" + String(repeating: "x", count: 100_000) + "] next"), "next")
    }

    func testMalformedAssistantBlocksUseTheSameContentFallbackAsWebHydration() {
        let snapshot = DigestSourceSnapshot(node: overviewNode("node-1"), messages: [
            ["role": "assistant", "content": "Persisted answer", "blocks": [["kind": "thinking", "rawText": "Missing block ID"]]]
        ])
        XCTAssertEqual(snapshot.payload["messages"], [["role": "assistant", "text": "Persisted answer"]])
    }

    func testSteeringProjectionKeepsExamplesAndBoundsUnterminatedReports() {
        let marker = "[STEERING steer-1234567890abcdef1234567890abcdef: internal [detail]]"
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant(marker + "\nVisible"), "\nVisible")
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("Inline " + marker), "Inline " + marker)
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("```text\n" + marker + "\n```"), "```text\n" + marker + "\n```")
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("    " + marker), "    " + marker)
        XCTAssertEqual(DigestSourceSnapshot.visibleAssistant("[STEERING steer-1234567890abcdef1234567890abcdef: unfinished\n\nVisible"), "\nVisible")
    }

    func testGenerationPayloadUsesVisibleHistoryAndOnlyScopedCommandPersistence() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, _ in overviewResponse(request, graph: graph) }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.guidance = "Focus on next steps"; model.generate()
        await eventually { !model.generating }
        XCTAssertNil(model.error); XCTAssertNil(model.pendingSave)
        let generation = transport.requests.first { $0.path.hasSuffix("/digests/stream") }
        XCTAssertEqual(generation?.body["workspaceId"], "workspace-1")
        XCTAssertEqual(generation?.body["cwd"], "/tmp/michi-contract")
        XCTAssertEqual(generation?.body["customPrompt"], "Focus on next steps")
        let messages = generation?.body["nodes"].arrayValue.first?["messages"].arrayValue ?? []
        XCTAssertEqual(messages, [["role": "user", "text": "Summarize the plan"], ["role": "assistant", "text": "The visible plan."]])
        let commands = transport.requests.first { $0.path.hasSuffix("/commands") }?.body["commands"].arrayValue ?? []
        XCTAssertEqual(commands.map { $0["type"].stringValue }, ["node.upsert", "edge.upsert"])
        let node = commands.first?["payload"] ?? .null
        XCTAssertEqual(node["kind"], "digest"); XCTAssertTrue(node["tree_id"].isNull); XCTAssertTrue(node["parent_node_id"].isNull)
        XCTAssertEqual(node["digest"].parsedJSON["sources"], ["node-1"])
        XCTAssertTrue(node["digest"].parsedJSON["sourceFingerprints"]["node-1"].stringValue.hasPrefix("v2:"))
        XCTAssertEqual(commands.last?["payload"]["id"], "digest-source-node-1-digest-new")
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/workspaces") && $0.method == "POST" })
    }

    func testGenerationEOFIsUnknownAndCannotAutomaticallyRetryAcrossModelRecreation() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, _ in
            request.path.hasSuffix("/digests/stream") ? .events([("chunk", ["text": "Partial"])] ) : overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.generate(); await eventually { !model.generating }
        XCTAssertTrue(model.uncertainGeneration); XCTAssertEqual(model.generatedContent, "Partial"); XCTAssertNil(model.pendingSave)
        model.generate(); XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/digests/stream") }.count, 1)
        let restored = WorkspaceOverviewModel(api: transport.api, graph: graph)
        XCTAssertTrue(restored.uncertainGeneration); XCTAssertFalse(restored.canGenerate)
        restored.acknowledgeUnknownGeneration(); XCTAssertFalse(restored.uncertainGeneration)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/cancel") })
    }

    func testExplicitGenerationRejectionDoesNotPersistUnknownOutcome() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, _ in
            request.path.hasSuffix("/digests/stream") ? .json(["error": "Forbidden"], status: 403) : overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.generate(); await eventually { !model.generating }
        XCTAssertFalse(model.uncertainGeneration); XCTAssertNotNil(model.error)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/node-ids/allocate") })
    }

    func testDisconnectPreservesUnknownMarkerAndDoesNotStartAnotherOperation() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, _ in
            request.path.hasSuffix("/digests/stream") ? .events([("done", ["markdown": "Late result"])], delay: 0.2) : overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.generate()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/digests/stream") } }
        model.detachGeneration()
        try? await Task.sleep(for: .milliseconds(250))
        XCTAssertTrue(model.uncertainGeneration); XCTAssertFalse(model.generating); XCTAssertTrue(model.generatedContent.isEmpty)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/commands") || $0.path.hasSuffix("/cancel") })
    }

    func testUnknownSaveRetainsExactOperationAndDoesNotRegenerateOnRetry() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("/commands") && requests.filter({ $0.path.hasSuffix("/commands") }).count == 1 { return .failure(.networkConnectionLost) }
            return overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.generate(); await eventually { !model.generating }
        XCTAssertNotNil(model.pendingSave); XCTAssertNotNil(model.error); XCTAssertFalse(model.canGenerate)
        let restored = WorkspaceOverviewModel(api: transport.api, graph: graph)
        await restored.refresh(); await restored.retrySave()
        let saves = transport.requests.filter { $0.path.hasSuffix("/commands") }
        XCTAssertEqual(saves.count, 2); XCTAssertEqual(saves.first?.body, saves.last?.body)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/digests/stream") }.count, 1)
        XCTAssertNil(restored.pendingSave); XCTAssertNil(restored.error)
    }

    func testCompletedOutputIsPersistedBeforePostGenerationReadAndCanRecover() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, requests in
            if request.method == "GET", request.path.hasSuffix("/workspace-1"),
               let generation = requests.firstIndex(where: { $0.path.hasSuffix("/digests/stream") }),
               requests.dropFirst(generation + 1).filter({ $0.path.hasSuffix("/workspace-1") }).count == 1 {
                return .delayedJSON(["error": "Metadata temporarily unavailable"], status: 503, delay: 0.15)
            }
            return overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.guidance = "Keep the result"; model.generate()
        await eventually { model.pendingOutput != nil }
        // Recreate while the first fallible GET is still pending: the completed
        // output, source fingerprints and operation identity must already exist.
        let restored = WorkspaceOverviewModel(api: transport.api, graph: graph)
        XCTAssertEqual(restored.generatedContent, "# Generated\n\nA saved digest.")
        XCTAssertEqual(restored.guidance, "Keep the result")
        XCTAssertEqual(restored.pendingOutput, model.pendingOutput)
        XCTAssertFalse(restored.uncertainGeneration); XCTAssertFalse(restored.canGenerate)
        let completed = restored.pendingOutput
        await eventually { !model.generating }
        XCTAssertNil(model.pendingSave); XCTAssertNotNil(model.error)
        await restored.refresh(); await restored.retrySave()
        XCTAssertNil(restored.pendingOutput); XCTAssertNil(restored.pendingSave); XCTAssertNil(restored.error)
        let save = transport.requests.first { $0.path.hasSuffix("/commands") }?.body
        XCTAssertEqual(save?["operationId"], completed?["operationId"])
        XCTAssertEqual(save?["commands"].arrayValue.first?["payload"]["digest"].parsedJSON["generatedAt"], completed?["digest"]["generatedAt"])
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/digests/stream") }.count, 1)
    }

    func testAllocationFailureRetainsPaidOutputAndRetriesOnlyPreparation() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("/node-ids/allocate"), requests.filter({ $0.path.hasSuffix("/node-ids/allocate") }).count == 1 {
                return .failure(.networkConnectionLost)
            }
            return overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.generate(); await eventually { !model.generating }
        XCTAssertNotNil(model.pendingOutput); XCTAssertNil(model.pendingSave); XCTAssertFalse(model.canGenerate)
        let completed = model.pendingOutput
        let restored = WorkspaceOverviewModel(api: transport.api, graph: graph)
        await restored.refresh(); await restored.retrySave()
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/digests/stream") }.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/node-ids/allocate") }.count, 2)
        let save = transport.requests.first { $0.path.hasSuffix("/commands") }?.body
        XCTAssertEqual(save?["operationId"], completed?["operationId"])
        XCTAssertEqual(save?["commands"].arrayValue.first?["payload"]["digest"].parsedJSON, completed?["digest"])
        XCTAssertNil(restored.pendingOutput); XCTAssertNil(restored.error)
    }

    func testKnownAllocatedIDAndPreparedCommandsRemainStableAfterLaterReadFailure() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, requests in
            if request.method == "GET", request.path.hasSuffix("/workspace-1"),
               let allocation = requests.firstIndex(where: { $0.path.hasSuffix("/node-ids/allocate") }),
               requests.dropFirst(allocation + 1).filter({ $0.path.hasSuffix("/workspace-1") }).count == 1 {
                return .json(["error": "Read failed after allocation"], status: 503)
            }
            return overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.generate(); await eventually { !model.generating }
        let prepared = model.pendingSave
        XCTAssertEqual(model.pendingOutput?["nodeId"], "digest-new")
        XCTAssertNotNil(prepared); XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/commands") })
        let restored = WorkspaceOverviewModel(api: transport.api, graph: graph)
        XCTAssertEqual(restored.pendingSave, prepared)
        await restored.refresh(); await restored.retrySave()
        let submitted = transport.requests.first { $0.path.hasSuffix("/commands") }?.body
        XCTAssertEqual(submitted?["operationId"], prepared?["operationId"])
        XCTAssertEqual(submitted?["commands"], prepared?["commands"])
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/node-ids/allocate") }.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/digests/stream") }.count, 1)
        XCTAssertNil(restored.pendingOutput); XCTAssertNil(restored.pendingSave)
    }

    func testMalformedSaveAcknowledgmentDoesNotClaimSuccess() async {
        let graph = overviewGraph()
        let transport = AppContractTransport { request, _ in
            request.path.hasSuffix("/commands") ? .json(["ok": true, "operationId": "different", "applied": []]) : overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.generate(); await eventually { !model.generating }
        XCTAssertNotNil(model.pendingSave); XCTAssertNotNil(model.error); XCTAssertNil(model.notice)
    }

    func testArchivedWorkspaceAfterGenerationKeepsOutputWithoutSaving() async {
        let graph = overviewGraph(), archived = overviewGraph(workspaceArchived: true)
        let transport = AppContractTransport { request, requests in
            if request.method == "GET" && request.path.hasSuffix("/workspace-1") && requests.contains(where: { $0.path.hasSuffix("/digests/stream") }) { return .json(archived.raw) }
            return overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.generate(); await eventually { !model.generating }
        XCTAssertFalse(model.generatedContent.isEmpty); XCTAssertNotNil(model.error)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/commands") || $0.path.hasSuffix("/node-ids/allocate") })
    }

    func testRebuildDoesNotOverwriteDigestChangedDuringGeneration() async {
        var graph = overviewGraph()
        let saved: JSONValue = ["sources": ["node-1"], "content": "Old digest", "generatedAt": 10, "sourceFingerprints": [:], "status": "idle"]
        graph.raw["nodes"] = .array(graph.nodes + [overviewNode("saved", kind: "digest").merging(["digest": .string(saved.prettyPrinted), "tree_id": .null])])
        var changed = graph
        changed.raw["nodes"] = .array(graph.nodes.map { $0.id == "saved" ? $0.merging(["digest": .string(saved.merging(["content": "Edited elsewhere", "generatedAt": 20]).prettyPrinted)]) : $0 })
        let transport = AppContractTransport { request, requests in
            if request.method == "GET" && request.path.hasSuffix("/workspace-1") && requests.contains(where: { $0.path.hasSuffix("/digests/stream") }) { return .json(changed.raw) }
            return overviewResponse(request, graph: graph)
        }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.selectDigest("saved"); model.generate(rebuildDigestID: "saved")
        await eventually { !model.generating }
        XCTAssertTrue(model.error?.contains("changed on another device") == true); XCTAssertFalse(model.generatedContent.isEmpty)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/commands") })
        XCTAssertEqual(transport.requests.first { $0.path.hasSuffix("/digests/stream") }?.body["previousContent"], "Old digest")
    }

    func testRebuildIncludesNewLiveBranchesEvenWhenSelectionWasNarrower() async {
        var graph = overviewGraph()
        let saved: JSONValue = ["sources": ["node-1"], "content": "Old digest", "generatedAt": 10, "sourceFingerprints": [:], "status": "idle"]
        graph.raw["nodes"] = .array(graph.nodes + [overviewNode("new-branch", parent: "node-1"), overviewNode("saved", kind: "digest").merging(["digest": .string(saved.prettyPrinted), "tree_id": .null])])
        graph.raw["edges"] = [overviewEdge("node-1", "new-branch")]
        let transport = AppContractTransport { request, _ in overviewResponse(request, graph: graph) }
        let model = WorkspaceOverviewModel(api: transport.api, graph: graph); defer { clean(model, transport) }
        await model.refresh(); model.toggleSource("node-1"); model.selectDigest("saved"); model.generate(rebuildDigestID: "saved")
        await eventually { !model.generating }
        let sources = transport.requests.first { $0.path.hasSuffix("/digests/stream") }?.body["nodes"].arrayValue.map { $0["nodeId"].stringValue }
        XCTAssertEqual(sources, ["node-1", "new-branch"])
        XCTAssertEqual(transport.requests.first { $0.path.hasSuffix("/commands") }?.body["commands"].arrayValue.first?["type"], "node.patch")
    }

    func testOversizedRequestIsRejectedBeforeGeneration() {
        let snapshot = DigestSourceSnapshot(node: overviewNode("node-1"), messages: [["role": "user", "content": .string(String(repeating: "x", count: 4 * 1024 * 1024))]])
        XCTAssertThrowsError(try WorkspaceOverviewModel.generationPayload(graph: overviewGraph(), treeID: "tree-1", sources: [snapshot], previous: "", guidance: ""))
    }
}
