import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class StoreContractTests: XCTestCase {
    private func expectFailure(_ message: String, file: StaticString = #filePath, line: UInt = #line, operation: () async throws -> Void) async {
        do {
            try await operation()
            XCTFail(message, file: file, line: line)
        } catch { /* A refused mutation is the expected result. */ }
    }

    func testFailedInitialHydrationBlocksEveryWorkspaceMutationEntryPoint() async {
        let transport = AppContractTransport { _, _ in .json(["error": "Offline"], status: 503) }
        defer { transport.close() }
        let store = MichiStore(api: transport.api)
        let graph = appContractGraph(), node = graph.nodes[0], tree = graph.trees[0]
        await store.reload()
        XCTAssertFalse(store.hydrated)
        XCTAssertNotNil(store.error)
        await expectFailure("Raw commands require hydration") {
            _ = try await store.command(workspace: graph.id, type: "node.patch", payload: ["id": .string(node.id)])
        }
        await expectFailure("Workspace creation requires hydration") {
            try await store.createWorkspace(name: "Unsent", cwd: "/tmp/unsent")
        }
        await expectFailure("Node allocation requires hydration") {
            _ = try await store.createThread(in: graph)
        }
        await expectFailure("Node editing requires hydration") {
            try await store.patchNode(node, fields: ["title": "Unsent"])
        }
        await expectFailure("Tree archiving requires hydration") {
            try await store.archiveTree(tree, archived: true)
        }
        await expectFailure("Subtree deletion requires hydration") {
            try await store.trashNode(node, graph: graph)
        }
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" }, "No writes or ID allocation may leave the client after initial hydration failed")
        XCTAssertNil(store.selectedWorkspaceID)
        XCTAssertNil(store.selectedNodeID)
    }

    func testMalformedRefreshPreservesLastGoodWorkspaceSnapshot() async {
        let graph = appContractGraph()
        let transport = AppContractTransport { request, history in
            if request.path == "/api/agent/status" { return .json(["customAgentsEnabled": true]) }
            let snapshots = history.filter { $0.path == "/api/workspaces/all" }.count
            if snapshots == 1 { return .json(["workspaces": .array([graph.raw])]) }
            // A partially valid array must not replace the authoritative graph.
            return .json(["workspaces": .array([graph.raw, ["workspace": ["name": "Missing ID"]]])])
        }
        defer { transport.close() }
        let store = MichiStore(api: transport.api)
        await store.reload()
        XCTAssertTrue(store.hydrated)
        XCTAssertEqual(store.graphs.map(\.raw), [graph.raw])
        store.selectedNodeID = "node-1"
        await store.reload()
        XCTAssertNotNil(store.error)
        XCTAssertEqual(store.graphs.map(\.raw), [graph.raw])
        XCTAssertEqual(store.selectedWorkspaceID, graph.id)
        XCTAssertEqual(store.selectedNodeID, "node-1")
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
    }

    func testArchivedWorkspaceAndParentRejectThreadCreationBeforeAllocation() async {
        let graph = appContractGraph()
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/agent/status" { return .json([:]) }
            return .json(["workspaces": .array([graph.raw])])
        }
        defer { transport.close() }
        let store = MichiStore(api: transport.api)
        await store.reload()
        XCTAssertTrue(store.hydrated)
        await expectFailure("An archived workspace cannot create a root thread") {
            _ = try await store.createThread(in: appContractGraph(workspaceArchived: true))
        }
        let archivedTree = appContractGraph(treeArchived: true)
        await expectFailure("An archived parent cannot create a branch") {
            _ = try await store.createThread(in: archivedTree, parent: archivedTree.nodes[0])
        }
        let deletedNode = appContractGraph(nodeDeleted: true)
        await expectFailure("A deleted parent cannot create a branch") {
            _ = try await store.createThread(in: deletedNode, parent: deletedNode.nodes[0])
        }
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
    }

    func testInvalidAllocatedIDNeverCreatesOptimisticGraphNode() async {
        let graph = appContractGraph()
        let transport = AppContractTransport { request, _ in
            switch request.path {
            case "/api/workspaces/all": return .json(["workspaces": .array([graph.raw])])
            case "/api/agent/status": return .json([:])
            case "/api/node-ids/allocate": return .json(["nodeIds": []])
            default: return .json(["error": "Unexpected request"], status: 400)
            }
        }
        defer { transport.close() }
        let store = MichiStore(api: transport.api)
        await store.reload()
        await expectFailure("An absent backend ID must stop creation") {
            _ = try await store.createThread(in: graph)
        }
        let mutations = transport.requests.filter { $0.method != "GET" }
        XCTAssertEqual(mutations.count, 1)
        XCTAssertEqual(mutations.first?.path, "/api/node-ids/allocate")
        XCTAssertEqual(mutations.first?.body, ["count": 1])
        XCTAssertEqual(store.graphs.map(\.raw), [graph.raw])
        XCTAssertNil(store.selectedNodeID)
    }
}
