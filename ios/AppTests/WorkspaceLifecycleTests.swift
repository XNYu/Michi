import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

/// Rows the fixture backend answers with. Tests edit them to stand in for the
/// backend applying a write or another device changing data; the transport's
/// lock serializes every handler call.
private final class LifecycleServer: @unchecked Sendable {
    var workspaces: [JSONValue]
    /// Paths answered with HTTP 503.
    var failing: Set<String> = []
    private var counts: [String: Int] = [:]
    init(_ workspaces: [JSONValue]) { self.workspaces = workspaces }
    var snapshot: AppContractResponse { .json(["workspaces": .array(workspaces)]) }
    func update(_ id: String, _ change: (inout JSONValue) -> Void) {
        guard let index = workspaces.firstIndex(where: { $0["workspace"].id == id }) else { return }
        change(&workspaces[index])
    }
    func updateNode(_ workspace: String, _ id: String, _ fields: [String: JSONValue]) {
        update(workspace) { row in row["nodes"] = .array(row["nodes"].arrayValue.map { $0.id == id ? $0.merging(fields) : $0 }) }
    }
    func updateTree(_ workspace: String, _ id: String, _ fields: [String: JSONValue]) {
        update(workspace) { row in row["trees"] = .array(row["trees"].arrayValue.map { $0.id == id ? $0.merging(fields) : $0 }) }
    }
    /// How many times `key` has been asked for, this time included.
    func count(_ key: String) -> Int { counts[key, default: 0] += 1; return counts[key] ?? 0 }
}

private func lifecycleWorkspace(_ id: String, active: String? = nil, archived: Bool = false, deleted: Bool = false,
                                trees: [JSONValue] = [], nodes: [JSONValue] = [], edges: [JSONValue] = []) -> JSONValue {
    let workspace: [String: JSONValue] = [
        "id": .string(id), "name": .string("Workspace \(id)"), "cwd": .string("/tmp/\(id)"), "created_at": 1, "settings": .null,
        "active_tree_id": active.map(JSONValue.string) ?? .null, "archived_at": archived ? 5 : .null,
        "deleted_at": deleted ? 6 : .null, "pinned_at": .null,
    ]
    return ["workspace": .object(workspace), "trees": .array(trees), "nodes": .array(nodes), "edges": .array(edges), "contexts": []]
}

private func lifecycleTree(_ id: String, in workspace: String, root: String, lastActive: Double = 10, archived: Bool = false) -> JSONValue {
    let row: [String: JSONValue] = [
        "id": .string(id), "workspace_id": .string(workspace), "root_node_id": .string(root), "name": .null,
        "archived_at": archived ? 7 : .null, "pinned_at": .null, "last_active_at": .number(lastActive), "created_at": 1, "rev": 3,
    ]
    return .object(row)
}

private func lifecycleNode(_ id: String, in workspace: String, tree: String, parent: String? = nil, extra: [String: JSONValue] = [:]) -> JSONValue {
    let row: [String: JSONValue] = [
        "id": .string(id), "workspace_id": .string(workspace), "tree_id": .string(tree),
        "parent_node_id": parent.map(JSONValue.string) ?? .null, "kind": "chat", "title": .string("Title \(id)"),
        "status": "idle", "deleted_at": .null, "deletion_group_id": .null, "created_at": 1,
    ]
    return JSONValue.object(row).merging(extra)
}

private func lifecycleEdge(_ kind: String, _ source: String, _ target: String, in workspace: String) -> JSONValue {
    let row: [String: JSONValue] = [
        "id": .string("\(kind)-\(source)-\(target)"), "workspace_id": .string(workspace),
        "source_node_id": .string(source), "target_node_id": .string(target), "kind": .string(kind),
    ]
    return .object(row)
}

private func isNumber(_ value: JSONValue?) -> Bool { if case .some(.number) = value { return true }; return false }

@MainActor
final class WorkspaceLifecycleTests: XCTestCase {
    private func hydratedStore(_ server: LifecycleServer,
                               respond: @escaping (AppContractRequest) -> AppContractResponse? = { _ in nil }) async -> (MichiStore, AppContractTransport) {
        let transport = AppContractTransport { request, _ in
            if server.failing.contains(request.path) { return .json(["error": "Unavailable"], status: 503) }
            if let answer = respond(request) { return answer }
            switch (request.method, request.path) {
            case ("GET", "/api/workspaces/all"): return server.snapshot
            case ("GET", "/api/agent/status"): return .json([:])
            case ("GET", "/api/persistence/capabilities"): return .json(["conditionalTrashPurge": "v1"])
            default: return .json(["error": "Unexpected request"], status: 400)
            }
        }
        let store = MichiStore(api: transport.api)
        await store.reload()
        XCTAssertTrue(store.hydrated)
        return (store, transport)
    }
    func testLegacyBackendCannotSilentlyIgnoreConditionalPurge() async throws {
        let server = LifecycleServer([])
        let (store, transport) = await hydratedStore(server) { request in
            request.path == "/api/persistence/capabilities" ? .json([:]) : nil
        }
        defer { transport.close() }
        await expectFailure("Legacy backend must refuse permanent deletion") { try await store.emptyTrash() }
        XCTAssertTrue(writes(transport).isEmpty)
    }
    private func writes(_ transport: AppContractTransport) -> [AppContractRequest] { transport.requests.filter { $0.method != "GET" } }
    private func batch(_ request: AppContractRequest?) -> [JSONValue] { request?.body["commands"].arrayValue ?? [] }
    private func payloadKeys(_ command: JSONValue?) -> Set<String> { Set((command ?? .null)["payload"].objectValue.keys) }
    @discardableResult
    private func expectFailure(_ message: String, file: StaticString = #filePath, line: UInt = #line,
                               _ operation: () async throws -> Void) async -> Error? {
        do {
            try await operation()
            XCTFail(message, file: file, line: line)
            return nil
        } catch { return error }
    }

    func testWorkspacePinArchiveAndTrashWriteOnlyTheirOwnColumn() async throws {
        let server = LifecycleServer([
            lifecycleWorkspace("ws-a", active: "tree-a", trees: [lifecycleTree("tree-a", in: "ws-a", root: "a1")],
                               nodes: [lifecycleNode("a1", in: "ws-a", tree: "tree-a")]),
            lifecycleWorkspace("ws-b"),
        ])
        let (store, transport) = await hydratedStore(server) { request in
            guard request.method == "POST", request.path.hasSuffix("/commands") else { return nil }
            // The backend's partial upsert: only the columns a payload names change.
            for command in request.body["commands"].arrayValue where command["type"] == "workspace.upsert" {
                let payload = command["payload"]
                server.update(payload.id) { row in row["workspace"] = row["workspace"].merging(payload.objectValue) }
            }
            return .json(["ok": true])
        }
        defer { transport.close() }
        XCTAssertEqual(store.selectedWorkspaceID, "ws-a")

        let b = try XCTUnwrap(store.graphs.first { $0.id == "ws-b" })
        try await store.setWorkspacePinned(b, pinned: true)
        let pin = batch(writes(transport).last)
        XCTAssertEqual(writes(transport).last?.path, "/api/workspaces/ws-b/commands")
        XCTAssertEqual(pin.count, 1)
        XCTAssertEqual(pin.first?["type"], "workspace.upsert")
        XCTAssertEqual(payloadKeys(pin.first), ["id", "pinned_at"])
        XCTAssertTrue(isNumber(pin.first?["payload"]["pinned_at"]))
        XCTAssertEqual(store.graphs.orderedLive.map(\.id), ["ws-b", "ws-a"], "Pinned workspaces come first")

        let a = try XCTUnwrap(store.graphs.first { $0.id == "ws-a" })
        try await store.setWorkspaceArchived(a, archived: true)
        XCTAssertEqual(payloadKeys(batch(writes(transport).last).first), ["id", "archived_at"])
        XCTAssertEqual(store.selectedWorkspaceID, "ws-b", "Archiving the open workspace moves to a live one")
        XCTAssertEqual(store.graphs.orderedLive.map(\.id), ["ws-b"])

        let pinned = try XCTUnwrap(store.graphs.first { $0.id == "ws-b" })
        try await store.trashWorkspace(pinned)
        XCTAssertEqual(payloadKeys(batch(writes(transport).last).first), ["id", "deleted_at"])
        XCTAssertNil(store.selectedWorkspaceID)

        let trashed = try XCTUnwrap(store.graphs.first { $0.id == "ws-b" })
        XCTAssertTrue(trashed.isDeleted)
        try await store.restoreWorkspace(trashed)
        let restore = batch(writes(transport).last).first
        XCTAssertEqual(payloadKeys(restore), ["id", "deleted_at"])
        XCTAssertEqual(restore?["payload"]["deleted_at"], JSONValue.null)
        XCTAssertEqual(writes(transport).count, 4)
        XCTAssertFalse(writes(transport).contains { request in batch(request).contains { $0["type"] != "workspace.upsert" } })
    }

    func testRejectedOrRefusedWorkspaceChangesLeaveTheSnapshotAndSelection() async throws {
        let server = LifecycleServer([lifecycleWorkspace("ws-a"), lifecycleWorkspace("ws-x", archived: true)])
        let (store, transport) = await hydratedStore(server) { request in
            request.method == "POST" ? .json(["error": "operation conflict"], status: 409) : nil
        }
        defer { transport.close() }
        let before = store.graphs.map(\.raw)
        let a = try XCTUnwrap(store.graphs.first { $0.id == "ws-a" })
        let failure = await expectFailure("A refused write must surface") { try await store.trashWorkspace(a) }
        XCTAssertEqual((failure as? MichiAPIError)?.statusCode, 409)
        XCTAssertEqual(store.graphs.map(\.raw), before, "Nothing is removed before the backend confirms it")
        XCTAssertEqual(store.selectedWorkspaceID, "ws-a")
        XCTAssertFalse(store.lifecycleBusy)

        let attempted = writes(transport).count
        let archived = try XCTUnwrap(store.graphs.first { $0.id == "ws-x" })
        await expectFailure("Archived workspaces are not pinned") { try await store.setWorkspacePinned(archived, pinned: true) }
        await expectFailure("A live workspace is never purged") { try await store.purgeWorkspace(a) }
        await expectFailure("A live workspace is not restored") { try await store.restoreWorkspace(a) }
        XCTAssertEqual(writes(transport).count, attempted)
    }

    func testThreadDeletionFollowsLiveParentPointersOnlyAndRetiresTheCurrentThread() async throws {
        let ws = "ws-a"
        let nodes: [JSONValue] = [
            lifecycleNode("a1", in: ws, tree: "tree-a"),
            lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1"),
            lifecycleNode("a3", in: ws, tree: "tree-a", parent: "a2"),
            // Already in Trash under its own group: neither regrouped nor walked through.
            lifecycleNode("a4", in: ws, tree: "tree-a", parent: "a2", extra: ["deleted_at": 3, "deletion_group_id": "del-earlier"]),
            lifecycleNode("a5", in: ws, tree: "tree-a", parent: "a4"),
            // A parent pointer into another thread is not ownership of that thread.
            lifecycleNode("x1", in: ws, tree: "tree-b", parent: "a2"),
            lifecycleNode("b1", in: ws, tree: "tree-b"),
            // Woven from and digesting tree-a, but owned by tree-b.
            lifecycleNode("m1", in: ws, tree: "tree-b", parent: "b1"),
            lifecycleNode("c1", in: ws, tree: "tree-c"),
        ]
        let edges: [JSONValue] = [
            lifecycleEdge("branch", "a1", "a2", in: ws), lifecycleEdge("branch", "a2", "a3", in: ws), lifecycleEdge("branch", "a2", "a4", in: ws),
            lifecycleEdge("merge", "a2", "m1", in: ws), lifecycleEdge("digest-source", "a3", "m1", in: ws), lifecycleEdge("link", "a3", "c1", in: ws),
        ]
        let trees: [JSONValue] = [
            lifecycleTree("tree-a", in: ws, root: "a1", lastActive: 50),
            lifecycleTree("tree-b", in: ws, root: "b1", lastActive: 20),
            lifecycleTree("tree-c", in: ws, root: "c1", lastActive: 40, archived: true),
        ]
        let server = LifecycleServer([lifecycleWorkspace(ws, active: "tree-a", trees: trees, nodes: nodes, edges: edges)])
        let (store, transport) = await hydratedStore(server) { request in
            request.method == "POST" && request.path == "/api/workspaces/ws-a/commands" ? .json(["ok": true]) : nil
        }
        defer { transport.close() }
        let graph = try XCTUnwrap(store.graphs.first)
        let a1 = try XCTUnwrap(graph.node("a1")), a2 = try XCTUnwrap(graph.node("a2"))
        store.select(a2, workspace: ws)
        try await store.trashNode(a1, graph: graph)

        XCTAssertEqual(writes(transport).count, 1)
        let sent = batch(writes(transport).first)
        let patches = sent.filter { $0["type"] == "node.patch" }
        XCTAssertEqual(patches.map { $0["payload"].id }, ["a1", "a2", "a3"])
        let group = patches.first?["payload"]["deletion_group_id"].stringValue ?? ""
        XCTAssertTrue(group.hasPrefix("del-"))
        for patch in patches {
            XCTAssertEqual(payloadKeys(patch), ["id", "deleted_at", "deletion_group_id"])
            XCTAssertEqual(patch["payload"]["deletion_group_id"].stringValue, group)
            XCTAssertTrue(isNumber(patch["payload"]["deleted_at"]))
        }
        XCTAssertEqual(sent.count, 4)
        XCTAssertEqual(sent.last?["payload"], ["id": "ws-a", "active_tree_id": "tree-b"], "The archived tree-c is not a landing thread")
        XCTAssertNil(store.selectedNodeID)
        // The change was computed from a snapshot read after the tap, not the cached one.
        let firstWrite = try XCTUnwrap(transport.requests.firstIndex { $0.method != "GET" })
        XCTAssertEqual(transport.requests[..<firstWrite].filter { $0.path == "/api/workspaces/all" }.count, 2)
    }

    func testRunningRepliesBlockArchiveTrashMoveTrimAndExtractBeforeAnyWrite() async throws {
        let ws = "ws-a"
        let server = LifecycleServer([
            lifecycleWorkspace(ws, active: "tree-a", trees: [lifecycleTree("tree-a", in: ws, root: "a1")], nodes: [
                lifecycleNode("a1", in: ws, tree: "tree-a"),
                lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1", extra: ["status": "streaming"]),
                lifecycleNode("a3", in: ws, tree: "tree-a", parent: "a2"),
            ], edges: [lifecycleEdge("branch", "a1", "a2", in: ws), lifecycleEdge("branch", "a2", "a3", in: ws)]),
            lifecycleWorkspace("ws-b"),
        ])
        let (store, transport) = await hydratedStore(server)
        defer { transport.close() }
        let graph = try XCTUnwrap(store.graphs.first { $0.id == ws })
        let tree = try XCTUnwrap(graph.tree("tree-a")), root = try XCTUnwrap(graph.node("a1"))
        let a2 = try XCTUnwrap(graph.node("a2")), a3 = try XCTUnwrap(graph.node("a3"))
        await expectFailure("Archive waits for the reply") { try await store.archiveTree(tree, archived: true) }
        await expectFailure("Trash waits for the reply") { try await store.trashNode(root, graph: graph) }
        await expectFailure("Move waits for the reply") { try await store.moveTree(tree, to: "ws-b") }
        await expectFailure("Trim waits for the reply") { try await store.pruneNode(a2, archive: false) }
        await expectFailure("Extraction waits for its parent chain") { _ = try await store.extractTree(a3) }
        XCTAssertTrue(writes(transport).isEmpty)
        XCTAssertFalse(store.lifecycleBusy)
    }

    func testTreeRowsAreRebuiltFromTheServerRowReadJustBeforeTheWrite() async throws {
        let ws = "ws-a"
        let server = LifecycleServer([lifecycleWorkspace(ws, active: "tree-a", trees: [
            lifecycleTree("tree-a", in: ws, root: "a1", lastActive: 50), lifecycleTree("tree-b", in: ws, root: "b1", lastActive: 20),
        ], nodes: [lifecycleNode("a1", in: ws, tree: "tree-a"), lifecycleNode("b1", in: ws, tree: "tree-b")])])
        let (store, transport) = await hydratedStore(server) { request in
            request.method == "POST" && request.path == "/api/workspaces/ws-a/commands" ? .json(["ok": true]) : nil
        }
        defer { transport.close() }
        let cached = try XCTUnwrap(store.graphs.first?.tree("tree-a"))
        // Another device renames the thread after this snapshot was taken.
        server.updateTree(ws, "tree-a", ["name": "Renamed elsewhere", "last_active_at": 99])

        try await store.setTreePinned(cached, pinned: true)
        XCTAssertEqual(batch(writes(transport).last).count, 1)
        let pin = batch(writes(transport).last).first
        XCTAssertEqual(pin?["type"], "tree.upsert")
        XCTAssertEqual(pin?["payload"]["name"], "Renamed elsewhere")
        XCTAssertEqual(pin?["payload"]["last_active_at"], 99)
        XCTAssertEqual(pin?["payload"]["root_node_id"], "a1")
        XCTAssertEqual(pin?["payload"]["workspace_id"], "ws-a")
        XCTAssertEqual(pin?["payload"]["archived_at"], JSONValue.null)
        XCTAssertTrue(isNumber(pin?["payload"]["pinned_at"]))
        XCTAssertEqual(payloadKeys(pin), ["id", "workspace_id", "root_node_id", "name", "archived_at", "pinned_at", "last_active_at", "created_at"])

        try await store.archiveTree(cached, archived: true)
        let archive = batch(writes(transport).last)
        XCTAssertEqual(archive.count, 2)
        XCTAssertTrue(isNumber(archive.first?["payload"]["archived_at"]))
        XCTAssertEqual(archive.first?["payload"]["name"], "Renamed elsewhere")
        XCTAssertEqual(archive.last?["payload"], ["id": "ws-a", "active_tree_id": "tree-b"])

        try await store.archiveTree(cached, archived: false)
        let unarchive = batch(writes(transport).last)
        XCTAssertEqual(unarchive.count, 1, "Unarchiving retires no thread")
        XCTAssertEqual(unarchive.first?["payload"]["archived_at"], JSONValue.null)
        XCTAssertGreaterThan(unarchive.first?["payload"]["last_active_at"].doubleValue ?? 0, 99)

        try await store.renameTree(cached, name: "  Planning  ")
        XCTAssertEqual(batch(writes(transport).last).first?["payload"]["name"], "Planning")
        let sent = writes(transport).count
        await expectFailure("A blank name is refused") { try await store.renameTree(cached, name: "   ") }
        server.update(ws) { row in row["trees"] = .array(row["trees"].arrayValue.filter { $0.id != "tree-a" }) }
        await expectFailure("A tree removed elsewhere is not recreated") { try await store.setTreePinned(cached, pinned: false) }
        XCTAssertEqual(writes(transport).count, sent)
    }

    func testTrashAndArchiveListsKeepTheirLanesAndHideHelperTranscripts() {
        let ws = "ws-a"
        let snapshot = "{\"parentId\":\"l1\",\"childrenIds\":[],\"wasTreeRoot\":null}"
        let graph = WorkspaceGraph(raw: lifecycleWorkspace(ws, trees: [
            lifecycleTree("tree-t", in: ws, root: "t1"),
            lifecycleTree("tree-live", in: ws, root: "l1", lastActive: 30),
            lifecycleTree("tree-pinned", in: ws, root: "p0", lastActive: 5).merging(["pinned_at": 40]),
            lifecycleTree("tree-old", in: ws, root: "o1", lastActive: 60, archived: true),
            lifecycleTree("tree-helper", in: ws, root: "h1", lastActive: 90),
        ], nodes: [
            lifecycleNode("t1", in: ws, tree: "tree-t", extra: ["deleted_at": 100, "deletion_group_id": "del-1"]),
            lifecycleNode("t2", in: ws, tree: "tree-t", parent: "t1", extra: ["deleted_at": 101, "deletion_group_id": "del-1"]),
            lifecycleNode("r1", in: ws, tree: "tree-live", parent: "l1", extra: ["deleted_at": 50, "deletion_group_id": "arch-1", "trim_snapshot": .string(snapshot)]),
            lifecycleNode("g1", in: ws, tree: "tree-live", parent: "l1", extra: ["deleted_at": 70, "deletion_group_id": "del-page", "page_id": "page-1"]),
            lifecycleNode("j1", in: ws, tree: "tree-live", parent: "l1", extra: ["deleted_at": 80, "deletion_group_id": "del-job", "maintenance_job_id": "job-1"]),
            lifecycleNode("l1", in: ws, tree: "tree-live"),
            lifecycleNode("p0", in: ws, tree: "tree-pinned"),
            lifecycleNode("o1", in: ws, tree: "tree-old"),
            lifecycleNode("h1", in: ws, tree: "tree-helper", extra: ["page_id": "page-2"]),
        ]))
        let trash = graph.deletionGroups(archive: false)
        XCTAssertEqual(trash.map(\.id), ["del-1"], "Page helpers and maintenance transcripts are not listed")
        XCTAssertEqual(trash.first?.members.map(\.id), ["t1", "t2"])
        XCTAssertEqual(trash.first?.root.id, "t1")
        XCTAssertEqual(trash.first?.deletedAt, 101)
        XCTAssertEqual(trash.first?.isTrim, false)
        let archive = graph.deletionGroups(archive: true)
        XCTAssertEqual(archive.map(\.id), ["arch-1"])
        XCTAssertEqual(archive.first?.isTrim, true)
        XCTAssertTrue(graph.hasTrash, "Hidden helper rows still count for Empty Trash")
        XCTAssertEqual(graph.threadTrees.map(\.id), ["tree-pinned", "tree-live"])
        XCTAssertEqual(graph.archivedTrees.map(\.id), ["tree-old"])
        XCTAssertEqual(graph.fallbackActiveTree(), "tree-live")
        XCTAssertNil(graph.activeTreeFix(), "No current thread needs no replacement")

        let archiveOnly = WorkspaceGraph(raw: lifecycleWorkspace(ws, nodes: [
            lifecycleNode("r1", in: ws, tree: "tree-live", extra: ["deleted_at": 50, "deletion_group_id": "arch-1"]),
        ]))
        XCTAssertFalse(archiveOnly.hasTrash, "Empty Trash never touches Archive")
    }

    func testRestoringATrimmedNodeRestoresItsDeletedWorkspaceFirstThenUsesRestoreTrim() async throws {
        let ws = "ws-d"
        let snapshot = "{\"parentId\":\"d1\",\"childrenIds\":[],\"wasTreeRoot\":null}"
        let server = LifecycleServer([lifecycleWorkspace(ws, active: "tree-gone", deleted: true, trees: [lifecycleTree("tree-d", in: ws, root: "d1")], nodes: [
            lifecycleNode("d1", in: ws, tree: "tree-d"),
            lifecycleNode("r1", in: ws, tree: "tree-d", parent: "d1", extra: ["deleted_at": 9, "deletion_group_id": "trim-1", "trim_snapshot": .string(snapshot)]),
        ])])
        let (store, transport) = await hydratedStore(server) { request in
            switch (request.method, request.path) {
            case ("POST", "/api/workspaces/ws-d/commands"): return .json(["ok": true])
            case ("POST", "/api/workspaces/ws-d/nodes/r1/restore-trim"): return .json(["ok": true, "restored": true])
            default: return nil
            }
        }
        defer { transport.close() }
        let group = try XCTUnwrap(store.graphs.first?.deletionGroups(archive: false).first)
        let root = try await store.restoreGroup(group)
        XCTAssertEqual(root, "r1")
        let sent = writes(transport)
        XCTAssertEqual(sent.map(\.path), ["/api/workspaces/ws-d/commands", "/api/workspaces/ws-d/nodes/r1/restore-trim"])
        XCTAssertEqual(batch(sent.first), [
            ["type": "workspace.upsert", "payload": ["id": "ws-d", "deleted_at": .null]],
            ["type": "workspace.upsert", "payload": ["id": "ws-d", "active_tree_id": "tree-d"]],
        ], "A restored workspace must also name a thread it still holds")
    }

    func testRestoringASubtreeClearsMarkersOnlyOnRowsStillInTheGroup() async throws {
        let ws = "ws-a"
        let deleted: [String: JSONValue] = ["deleted_at": 9, "deletion_group_id": "del-1"]
        let server = LifecycleServer([lifecycleWorkspace(ws, trees: [lifecycleTree("tree-a", in: ws, root: "a1")], nodes: [
            lifecycleNode("a1", in: ws, tree: "tree-a"),
            lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1", extra: deleted),
            lifecycleNode("a3", in: ws, tree: "tree-a", parent: "a2", extra: deleted),
            lifecycleNode("a4", in: ws, tree: "tree-a", parent: "a2", extra: deleted),
        ])])
        let (store, transport) = await hydratedStore(server) { request in
            request.method == "POST" && request.path == "/api/workspaces/ws-a/commands" ? .json(["ok": true]) : nil
        }
        defer { transport.close() }
        let group = try XCTUnwrap(store.graphs.first?.deletionGroups(archive: false).first)
        XCTAssertEqual(group.members.count, 3)
        // Another device restores one branch after the list was shown.
        server.updateNode(ws, "a4", ["deleted_at": .null, "deletion_group_id": .null])
        let top = try await store.restoreGroup(group)
        XCTAssertEqual(top, "a2")
        XCTAssertEqual(writes(transport).count, 1)
        XCTAssertEqual(batch(writes(transport).first), [
            ["type": "node.patch", "payload": ["id": "a2", "deleted_at": .null, "deletion_group_id": .null]],
            ["type": "node.patch", "payload": ["id": "a3", "deleted_at": .null, "deletion_group_id": .null]],
        ])
    }

    func testRootPurgeRefusesRestoredBranchesThenPurgesOnlyACompleteGroup() async throws {
        let ws = "ws-a"
        let deleted: [String: JSONValue] = ["deleted_at": 9, "deletion_group_id": "del-1"]
        let server = LifecycleServer([lifecycleWorkspace(ws, active: "tree-a", trees: [
            lifecycleTree("tree-a", in: ws, root: "a1", lastActive: 50), lifecycleTree("tree-b", in: ws, root: "b1", lastActive: 20),
        ], nodes: [
            lifecycleNode("a1", in: ws, tree: "tree-a", extra: deleted),
            lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1", extra: deleted),
            lifecycleNode("b1", in: ws, tree: "tree-b"),
        ])])
        let (store, transport) = await hydratedStore(server) { request in
            switch (request.method, request.path) {
            case ("DELETE", "/api/workspaces/ws-a/nodes"):
                // Mirror the real foreign key: removing a root's tree also
                // removes every node still carrying that tree_id.
                let purged = Set(request.body["nodeIds"].arrayValue.map(\.stringValue))
                server.update(ws) { row in
                    let removedTrees = Set(row["trees"].arrayValue.filter { purged.contains($0["root_node_id"].stringValue) }.map(\.id))
                    row["nodes"] = .array(row["nodes"].arrayValue.filter { !purged.contains($0.id) && !removedTrees.contains($0["tree_id"].stringValue) })
                    row["trees"] = .array(row["trees"].arrayValue.filter { !purged.contains($0["root_node_id"].stringValue) })
                }
                return .json(["ok": true, "purged": .number(Double(purged.count))])
            case ("POST", "/api/workspaces/ws-a/commands"): return .json(["ok": true])
            default: return nil
            }
        }
        defer { transport.close() }
        let group = try XCTUnwrap(store.graphs.first?.deletionGroups(archive: false).first)
        XCTAssertEqual(group.members.map(\.id), ["a1", "a2"])
        // Another device restores a branch after the list was shown; it must survive.
        server.updateNode(ws, "a2", ["deleted_at": .null, "deletion_group_id": .null])
        let failure = await expectFailure("Purging the root would cascade to the restored branch") { try await store.purgeGroup(group) }
        XCTAssertTrue(failure is NativeFailure)
        XCTAssertTrue(writes(transport).isEmpty, "Do not send a destructive request with a wider cascade than the selected group")
        XCTAssertNotNil(store.graphs.first?.node("a1"))
        XCTAssertNotNil(store.graphs.first?.node("a2"))
        XCTAssertFalse(store.lifecycleBusy)

        // The whole tree is explicitly in this group again; the purge is safe.
        server.updateNode(ws, "a2", deleted)
        try await store.purgeGroup(group)
        let sent = writes(transport)
        XCTAssertEqual(sent.map(\.method), ["DELETE", "POST"])
        XCTAssertEqual(sent.first?.body, ["nodeIds": ["a1", "a2"], "expectedNodes": [
            ["id": "a1", "deletedAt": 9, "deletionGroupId": "del-1"],
            ["id": "a2", "deletedAt": 9, "deletionGroupId": "del-1"]
        ]])
        XCTAssertEqual(batch(sent.last), [["type": "workspace.upsert", "payload": ["id": "ws-a", "active_tree_id": "tree-b"]]],
                       "The backend refuses later batches until the current thread exists")
        XCTAssertNil(store.graphs.first?.node("a1"))
        XCTAssertNil(store.graphs.first?.node("a2"))
        XCTAssertNotNil(store.graphs.first?.node("b1"))
    }

    func testRootPurgeRefusesSeparatelyArchivedOrTrashedBranches() async throws {
        for otherGroup in ["arch-earlier", "del-earlier"] {
            let ws = "ws-a"
            let server = LifecycleServer([lifecycleWorkspace(ws, trees: [lifecycleTree("tree-a", in: ws, root: "a1")], nodes: [
                lifecycleNode("a1", in: ws, tree: "tree-a", extra: ["deleted_at": 9, "deletion_group_id": "del-root"]),
                lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1", extra: ["deleted_at": 8, "deletion_group_id": .string(otherGroup)]),
            ])])
            let (store, transport) = await hydratedStore(server)
            defer { transport.close() }
            let group = try XCTUnwrap(store.graphs.first?.deletionGroups(archive: false).first { $0.id == "del-root" })
            let failure = await expectFailure("The other group must survive: \(otherGroup)") { try await store.purgeGroup(group) }
            XCTAssertTrue(failure is NativeFailure)
            XCTAssertTrue(writes(transport).isEmpty, "A root purge must not cascade into \(otherGroup)")
            XCTAssertEqual(store.graphs.first?.node("a2")?["deletion_group_id"], .string(otherGroup))
            XCTAssertFalse(store.lifecycleBusy)
        }
    }

    func testEmptyTrashChecksEveryRootBeforeAnyWriteAndPreservesLiveOrArchivedBranches() async throws {
        let trashed: [String: JSONValue] = ["deleted_at": 9, "deletion_group_id": "del-root"]
        let retained: [[String: JSONValue]] = [
            [:],
            ["deleted_at": 8, "deletion_group_id": "arch-earlier"],
            ["deleted_at": 8, "deletion_group_id": "ARCH-earlier"],
        ]
        for fields in retained {
            let server = LifecycleServer([
                // An earlier safe target must also be kept if any later target is unsafe.
                lifecycleWorkspace("ws-safe", trees: [lifecycleTree("tree-safe", in: "ws-safe", root: "s1")], nodes: [
                    lifecycleNode("s1", in: "ws-safe", tree: "tree-safe", extra: trashed),
                ]),
                lifecycleWorkspace("ws-a", trees: [lifecycleTree("tree-a", in: "ws-a", root: "a1")], nodes: [
                    lifecycleNode("a1", in: "ws-a", tree: "tree-a", extra: trashed),
                    lifecycleNode("a2", in: "ws-a", tree: "tree-a", parent: "a1", extra: fields),
                ]),
                lifecycleWorkspace("ws-deleted", deleted: true),
            ])
            let (store, transport) = await hydratedStore(server)
            defer { transport.close() }
            let failure = await expectFailure("Empty Trash must not cascade outside its backend-selected rows") { try await store.emptyTrash() }
            XCTAssertTrue(failure is NativeFailure)
            XCTAssertTrue(writes(transport).isEmpty, "Preflight all workspaces before any POST or DELETE")
            XCTAssertNotNil(store.graphs.first { $0.id == "ws-a" }?.node("a2"))
            XCTAssertFalse(store.lifecycleBusy)
        }
    }

    func testFailedPurgeKeepsTheTrashEntryAndSendsNothingElse() async throws {
        let ws = "ws-a"
        let server = LifecycleServer([lifecycleWorkspace(ws, trees: [lifecycleTree("tree-a", in: ws, root: "a1")], nodes: [
            lifecycleNode("a1", in: ws, tree: "tree-a"),
            lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1", extra: ["deleted_at": 9, "deletion_group_id": "del-1"]),
        ])])
        let (store, transport) = await hydratedStore(server) { request in
            request.method == "DELETE" ? .json(["error": "database is locked"], status: 500) : nil
        }
        defer { transport.close() }
        let group = try XCTUnwrap(store.graphs.first?.deletionGroups(archive: false).first)
        let failure = await expectFailure("A failed purge must surface") { try await store.purgeGroup(group) }
        XCTAssertEqual((failure as? MichiAPIError)?.statusCode, 500)
        XCTAssertEqual(failure?.localizedDescription, "database is locked")
        XCTAssertEqual(writes(transport).map(\.method), ["DELETE"])
        XCTAssertEqual(store.graphs.first?.deletionGroups(archive: false).map(\.id), ["del-1"], "The entry stays until the backend confirms")
        XCTAssertFalse(store.lifecycleBusy)
    }

    func testEmptyTrashStopsAtTheFirstFailureAndNeverPurgesArchive() async throws {
        let trashed: [String: JSONValue] = ["deleted_at": 9, "deletion_group_id": "del-1"]
        let server = LifecycleServer([
            lifecycleWorkspace("ws-e", trees: [lifecycleTree("tree-e", in: "ws-e", root: "e1")], nodes: [
                lifecycleNode("e1", in: "ws-e", tree: "tree-e"),
                lifecycleNode("e2", in: "ws-e", tree: "tree-e", parent: "e1", extra: ["deleted_at": 9, "deletion_group_id": "arch-1"]),
            ]),
            lifecycleWorkspace("ws-a", trees: [lifecycleTree("tree-a", in: "ws-a", root: "a1")], nodes: [
                lifecycleNode("a1", in: "ws-a", tree: "tree-a"), lifecycleNode("a2", in: "ws-a", tree: "tree-a", parent: "a1", extra: trashed),
            ]),
            lifecycleWorkspace("ws-b", trees: [lifecycleTree("tree-b", in: "ws-b", root: "b1")], nodes: [
                lifecycleNode("b1", in: "ws-b", tree: "tree-b"), lifecycleNode("b2", in: "ws-b", tree: "tree-b", parent: "b1", extra: trashed),
            ]),
            lifecycleWorkspace("ws-c", deleted: true),
        ])
        let (store, transport) = await hydratedStore(server) { request in
            switch request.method {
            case "POST" where request.path.hasSuffix("/trash/empty"): return .json(["ok": true, "purged": 1])
            case "DELETE": return .json(["ok": true])
            default: return nil
            }
        }
        defer { transport.close() }
        server.failing = ["/api/workspaces/ws-b/trash/empty"]
        await expectFailure("A failed purge stops Empty Trash") { try await store.emptyTrash() }
        XCTAssertEqual(writes(transport).map(\.path), ["/api/workspaces/ws-a/trash/empty", "/api/workspaces/ws-b/trash/empty"],
                       "The archive-only workspace is skipped and the deleted workspace is kept after the failure")
        XCTAssertNotNil(store.graphs.first { $0.id == "ws-c" })
        XCTAssertFalse(store.lifecycleBusy)

        server.failing = []
        try await store.emptyTrash()
        XCTAssertEqual(writes(transport).suffix(3).map { "\($0.method) \($0.path)" }, [
            "POST /api/workspaces/ws-a/trash/empty", "POST /api/workspaces/ws-b/trash/empty", "DELETE /api/workspaces/ws-c",
        ])
    }

    func testWorkspacePurgeHappensOnlyWhileTheServerStillHasItInTrash() async throws {
        let server = LifecycleServer([lifecycleWorkspace("ws-a"), lifecycleWorkspace("ws-c", deleted: true)])
        let (store, transport) = await hydratedStore(server) { request in
            guard request.method == "DELETE", request.path == "/api/workspaces/ws-c" else { return nil }
            server.workspaces.removeAll { $0["workspace"].id == "ws-c" }
            return .json(["ok": true])
        }
        defer { transport.close() }
        let cached = try XCTUnwrap(store.graphs.first { $0.id == "ws-c" })
        server.update("ws-c") { row in row["workspace"]["deleted_at"] = .null }
        await expectFailure("A workspace restored elsewhere is kept") { try await store.purgeWorkspace(cached) }
        XCTAssertTrue(writes(transport).isEmpty)

        server.update("ws-c") { row in row["workspace"]["deleted_at"] = 12 }
        try await store.purgeWorkspace(cached)
        XCTAssertEqual(writes(transport).map { "\($0.method) \($0.path)" }, ["DELETE /api/workspaces/ws-c"])
        XCTAssertNil(store.graphs.first { $0.id == "ws-c" })
    }

    func testExtractionReusesItsTreeIDAcrossALostAnswerAndRefusesThreadRoots() async throws {
        let ws = "ws-a"
        let server = LifecycleServer([lifecycleWorkspace(ws, active: "tree-a", trees: [lifecycleTree("tree-a", in: ws, root: "a1")], nodes: [
            lifecycleNode("a1", in: ws, tree: "tree-a"),
            lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1"),
            lifecycleNode("a3", in: ws, tree: "tree-a", parent: "a1"),
        ], edges: [lifecycleEdge("branch", "a1", "a2", in: ws), lifecycleEdge("branch", "a1", "a3", in: ws)])])
        let (store, transport) = await hydratedStore(server) { request in
            guard request.method == "POST", request.path.hasSuffix("/extract-tree") else { return nil }
            let node = request.path.split(separator: "/").dropLast().last.map(String.init) ?? ""
            let treeID = request.body["treeId"].stringValue
            let attempt = server.count(request.path)
            let commit = {
                server.update(ws) { row in
                    row["trees"] = .array(row["trees"].arrayValue + [lifecycleTree(treeID, in: ws, root: node)])
                    row["nodes"] = .array(row["nodes"].arrayValue.map { $0.id == node ? $0.merging(["parent_node_id": .null, "tree_id": .string(treeID)]) : $0 })
                    row["workspace"]["active_tree_id"] = .string(treeID)
                }
            }
            switch (node, attempt) {
            case ("a2", 1): return .failure(.networkConnectionLost) // Nothing was committed.
            case ("a3", 1): commit(); return .failure(.networkConnectionLost) // Committed; the answer was lost.
            default:
                commit()
                return .json(["tree": lifecycleTree(treeID, in: ws, root: node), "nodeIds": [.string(node)], "messages": []])
            }
        }
        defer { transport.close() }
        let graph = try XCTUnwrap(store.graphs.first)
        let a1 = try XCTUnwrap(graph.node("a1")), a2 = try XCTUnwrap(graph.node("a2")), a3 = try XCTUnwrap(graph.node("a3"))
        await expectFailure("A thread root is already its own thread") { _ = try await store.extractTree(a1) }
        XCTAssertTrue(writes(transport).isEmpty)

        let lost = await expectFailure("A lost answer surfaces") { _ = try await store.extractTree(a2) }
        XCTAssertNotNil(lost as? MichiAPIError)
        XCTAssertNil((lost as? MichiAPIError)?.statusCode, "No response arrived, so the outcome is unknown")
        let treeID = try await store.extractTree(a2)
        let attempts = writes(transport).filter { $0.path == "/api/workspaces/ws-a/nodes/a2/extract-tree" }
        XCTAssertEqual(attempts.map { $0.body["treeId"].stringValue }, [treeID, treeID])
        XCTAssertTrue(treeID.hasPrefix("tree-"))
        XCTAssertEqual(store.selectedWorkspaceID, ws)
        XCTAssertEqual(store.selectedNodeID, "a2")

        await expectFailure("The committed attempt's answer is lost") { _ = try await store.extractTree(a3) }
        let recovered = try await store.extractTree(a3)
        let a3Attempts = writes(transport).filter { $0.path == "/api/workspaces/ws-a/nodes/a3/extract-tree" }
        XCTAssertEqual(a3Attempts.count, 1, "A committed extraction is read back, not repeated")
        XCTAssertEqual(a3Attempts.first?.body["treeId"].stringValue, recovered)
        XCTAssertEqual(store.selectedNodeID, "a3")
    }

    func testMovingAThreadUsesTheMoveRouteAndRepairsTheSourceWorkspace() async throws {
        let server = LifecycleServer([
            lifecycleWorkspace("ws-a", active: "tree-a", trees: [
                lifecycleTree("tree-a", in: "ws-a", root: "a1", lastActive: 50), lifecycleTree("tree-c", in: "ws-a", root: "c1", lastActive: 20),
            ], nodes: [lifecycleNode("a1", in: "ws-a", tree: "tree-a"), lifecycleNode("c1", in: "ws-a", tree: "tree-c")]),
            lifecycleWorkspace("ws-b"),
            lifecycleWorkspace("ws-x", archived: true),
        ])
        let (store, transport) = await hydratedStore(server) { request in
            switch (request.method, request.path) {
            case ("POST", "/api/trees/tree-a/move"):
                // The backend moves the tree and its nodes; the source still names it as current.
                var moved: [JSONValue] = []
                server.update("ws-a") { row in
                    moved = row["nodes"].arrayValue.filter { $0["tree_id"] == "tree-a" }
                    row["nodes"] = .array(row["nodes"].arrayValue.filter { $0["tree_id"] != "tree-a" })
                    row["trees"] = .array(row["trees"].arrayValue.filter { $0.id != "tree-a" })
                }
                server.update("ws-b") { row in
                    row["trees"] = [lifecycleTree("tree-a", in: "ws-b", root: "a1")]
                    row["nodes"] = .array(moved.map { $0.merging(["workspace_id": "ws-b"]) })
                }
                return .json(["ok": true, "movedNodes": 1, "movedEdges": 0, "droppedEdges": 0])
            case ("POST", "/api/workspaces/ws-a/commands"): return .json(["ok": true])
            default: return nil
            }
        }
        defer { transport.close() }
        let tree = try XCTUnwrap(store.graphs.first { $0.id == "ws-a" }?.tree("tree-a"))
        await expectFailure("An archived workspace is not a destination") { try await store.moveTree(tree, to: "ws-x") }
        await expectFailure("The same workspace is not a move") { try await store.moveTree(tree, to: "ws-a") }
        XCTAssertTrue(writes(transport).isEmpty)

        try await store.moveTree(tree, to: "ws-b")
        let sent = writes(transport)
        XCTAssertEqual(sent.map(\.path), ["/api/trees/tree-a/move", "/api/workspaces/ws-a/commands"])
        XCTAssertEqual(sent.first?.body, ["fromWorkspaceId": "ws-a", "toWorkspaceId": "ws-b"])
        XCTAssertEqual(batch(sent.last), [["type": "workspace.upsert", "payload": ["id": "ws-a", "active_tree_id": "tree-c"]]])
        XCTAssertEqual(store.graphs.first { $0.id == "ws-b" }?.tree("tree-a")?["root_node_id"], "a1")
    }

    func testTrimAndArchiveUseTheBackendTrimInTheirLaneAndNodePinsArePartial() async throws {
        let ws = "ws-a"
        let server = LifecycleServer([lifecycleWorkspace(ws, active: "tree-a", trees: [
            lifecycleTree("tree-a", in: ws, root: "a1"), lifecycleTree("tree-old", in: ws, root: "o1", archived: true),
        ], nodes: [
            lifecycleNode("a1", in: ws, tree: "tree-a"), lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1"),
            lifecycleNode("o1", in: ws, tree: "tree-old"), lifecycleNode("o2", in: ws, tree: "tree-old", parent: "o1"),
        ])])
        let (store, transport) = await hydratedStore(server) { request in
            switch (request.method, request.path) {
            case ("POST", "/api/workspaces/ws-a/nodes/a2/trim"):
                // The third trim finds the node already removed elsewhere.
                return .json(["ok": true, "trimmed": .number(server.count(request.path) <= 2 ? 1 : 0)])
            case ("POST", "/api/workspaces/ws-a/commands"): return .json(["ok": true])
            default: return nil
            }
        }
        defer { transport.close() }
        let graph = try XCTUnwrap(store.graphs.first)
        let a1 = try XCTUnwrap(graph.node("a1")), a2 = try XCTUnwrap(graph.node("a2")), o2 = try XCTUnwrap(graph.node("o2"))
        try await store.pruneNode(a2, archive: false)
        try await store.pruneNode(a2, archive: true)
        let trims = writes(transport).filter { $0.path.hasSuffix("/trim") }
        XCTAssertEqual(trims.count, 2)
        XCTAssertTrue(trims.first?.body["groupId"].stringValue.hasPrefix("trim-") ?? false)
        XCTAssertTrue(trims.last?.body["groupId"].stringValue.hasPrefix("arch-") ?? false)
        XCTAssertTrue(trims.allSatisfy { isNumber($0.body["deletedAt"]) })
        await expectFailure("A node removed elsewhere is reported") { try await store.pruneNode(a2, archive: false) }
        await expectFailure("An archived thread is read-only") { try await store.pruneNode(o2, archive: true) }
        XCTAssertEqual(writes(transport).filter { $0.path.hasSuffix("/trim") }.count, 3)
        XCTAssertFalse(writes(transport).contains { $0.path.hasSuffix("/commands") }, "The current thread still exists")

        try await store.setNodePinned(a2, pinned: true)
        let pin = batch(writes(transport).last)
        XCTAssertEqual(pin.count, 1)
        XCTAssertEqual(pin.first?["type"], "node.patch")
        XCTAssertEqual(payloadKeys(pin.first), ["id", "pinned_at"])
        let sent = writes(transport).count
        await expectFailure("A thread root pins as its thread") { try await store.setNodePinned(a1, pinned: true) }
        XCTAssertEqual(writes(transport).count, sent)
    }

    private func everyChange(_ store: MichiStore, _ graph: WorkspaceGraph, _ tree: JSONValue, _ root: JSONValue,
                             _ group: DeletionGroup) -> [(name: String, run: () async throws -> Void)] {
        [
            ("pin workspace", { try await store.setWorkspacePinned(graph, pinned: true) }),
            ("archive workspace", { try await store.setWorkspaceArchived(graph, archived: true) }),
            ("trash workspace", { try await store.trashWorkspace(graph) }),
            ("restore workspace", { try await store.restoreWorkspace(graph) }),
            ("purge workspace", { try await store.purgeWorkspace(graph) }),
            ("edit workspace", { try await store.updateWorkspaceDetails(graph, fields: ["name": "Unsent"]) }),
            ("AI navigation", { try await store.setAIGlobalContext(graph, enabled: false) }),
            ("pin thread", { try await store.setTreePinned(tree, pinned: true) }),
            ("rename thread", { try await store.renameTree(tree, name: "Unsent") }),
            ("archive thread", { try await store.archiveTree(tree, archived: true) }),
            ("trash thread", { try await store.trashNode(root, graph: graph) }),
            ("trim node", { try await store.pruneNode(root, archive: false) }),
            ("pin node", { try await store.setNodePinned(root, pinned: true) }),
            ("move thread", { try await store.moveTree(tree, to: "ws-b") }),
            ("extract branch", { _ = try await store.extractTree(root) }),
            ("restore group", { _ = try await store.restoreGroup(group) }),
            ("purge group", { try await store.purgeGroup(group) }),
            ("empty trash", { try await store.emptyTrash() }),
        ]
    }

    func testLifecycleChangesNeedHydrationAndAFreshSnapshot() async throws {
        let ws = "ws-a"
        let raw = lifecycleWorkspace(ws, active: "tree-a", trees: [lifecycleTree("tree-a", in: ws, root: "a1")], nodes: [
            lifecycleNode("a1", in: ws, tree: "tree-a"),
            lifecycleNode("a2", in: ws, tree: "tree-a", parent: "a1", extra: ["deleted_at": 9, "deletion_group_id": "del-1"]),
        ])
        let graph = WorkspaceGraph(raw: raw)
        let tree = try XCTUnwrap(graph.tree("tree-a")), root = try XCTUnwrap(graph.node("a1"))
        let group = try XCTUnwrap(graph.deletionGroups(archive: false).first)

        let offline = AppContractTransport { _, _ in .json(["error": "Offline"], status: 503) }
        defer { offline.close() }
        let cold = MichiStore(api: offline.api)
        await cold.reload()
        XCTAssertFalse(cold.hydrated)
        for change in everyChange(cold, graph, tree, root, group) {
            await expectFailure("\(change.name) must wait for hydration", change.run)
        }
        XCTAssertFalse(offline.requests.contains { $0.method != "GET" }, "An unloaded backend is not an empty workspace to write over")

        let server = LifecycleServer([raw, lifecycleWorkspace("ws-b")])
        let (store, transport) = await hydratedStore(server)
        defer { transport.close() }
        let before = store.graphs.map(\.raw)
        server.failing = ["/api/workspaces/all"]
        let freshReads: Set<String> = ["purge workspace", "pin thread", "rename thread", "archive thread", "trash thread", "trim node",
                                       "move thread", "extract branch", "restore group", "purge group", "empty trash"]
        for change in everyChange(store, graph, tree, root, group) where freshReads.contains(change.name) {
            let failure = await expectFailure("\(change.name) must read the saved workspace first", change.run)
            XCTAssertEqual(failure?.localizedDescription, "Michi could not read the latest saved workspaces, so nothing was changed.", change.name)
        }
        XCTAssertTrue(writes(transport).isEmpty)
        XCTAssertEqual(store.graphs.map(\.raw), before)
        XCTAssertFalse(store.lifecycleBusy)
    }

    func testASecondLifecycleChangeIsRefusedWhileTheFirstIsUnresolved() async throws {
        let server = LifecycleServer([lifecycleWorkspace("ws-a"), lifecycleWorkspace("ws-b")])
        let (store, transport) = await hydratedStore(server) { request in
            request.method == "POST" ? .delayedJSON(["ok": true], status: 200, delay: 0.4) : nil
        }
        defer { transport.close() }
        let a = try XCTUnwrap(store.graphs.first { $0.id == "ws-a" }), b = try XCTUnwrap(store.graphs.first { $0.id == "ws-b" })
        let first = Task { try await store.setWorkspacePinned(a, pinned: true) }
        let deadline = Date().addingTimeInterval(3)
        while !store.lifecycleBusy, Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(store.lifecycleBusy)
        let refused = await expectFailure("A second change waits for the first") { try await store.trashWorkspace(b) }
        XCTAssertEqual(refused?.localizedDescription, "Another change is still being saved.")
        try await first.value
        XCTAssertFalse(store.lifecycleBusy)
        XCTAssertEqual(writes(transport).map(\.path), ["/api/workspaces/ws-a/commands"])
    }
}
