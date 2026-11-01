import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

/// Records every lifecycle call by exact id bytes; never touches a network.
@MainActor private final class FakeTrashOperations: DesignTrashOperations {
    var graphs: [WorkspaceGraph]
    var hydrated = true
    var lifecycleBusy = false
    var refreshResults: [Bool] = []
    private(set) var refreshCount = 0
    private(set) var calls: [(name: String, id: String)] = []
    var failures: [(id: String, error: Error)] = []
    var beforeCall: (@MainActor (String) -> Void)?

    init(graphs: [WorkspaceGraph]) { self.graphs = graphs }

    func refreshTrashSnapshot() async -> Bool {
        refreshCount += 1
        return refreshResults.isEmpty ? true : refreshResults.removeFirst()
    }
    private func record(_ name: String, _ id: String) throws {
        calls.append((name, id))
        beforeCall?(id)
        if let failure = failures.first(where: { $0.id.utf8.elementsEqual(id.utf8) }) { throw failure.error }
    }
    func restoreGroup(_ group: DeletionGroup) async throws -> String { try record("restoreGroup", group.id); return group.root.id }
    func purgeGroup(_ group: DeletionGroup) async throws { try record("purgeGroup", group.id) }
    func restoreWorkspace(_ graph: WorkspaceGraph) async throws { try record("restoreWorkspace", graph.id) }
    func purgeWorkspace(_ graph: WorkspaceGraph) async throws { try record("purgeWorkspace", graph.id) }
    func archiveTree(_ tree: JSONValue, archived: Bool) async throws { try record(archived ? "archiveTree" : "unarchiveTree", tree.id) }
    func setWorkspaceArchived(_ graph: WorkspaceGraph, archived: Bool) async throws { try record(archived ? "archiveWorkspace" : "unarchiveWorkspace", graph.id) }
}

private func trashGraph(_ id: String, name: String = "Workspace", deleted: Bool = false, archived: Bool = false, system: Bool = false,
                        groups: [(id: String, deletedAt: Double)] = [], archivedTrees: [String] = []) -> WorkspaceGraph {
    var nodes: [JSONValue] = [], trees: [JSONValue] = []
    for group in groups {
        nodes.append(["id": .string("node-" + group.id), "workspace_id": .string(id), "tree_id": "tree-live", "title": .string("Thread " + group.id),
                      "status": "idle", "deleted_at": .number(group.deletedAt), "deletion_group_id": .string(group.id)])
    }
    for tree in archivedTrees {
        trees.append(["id": .string(tree), "workspace_id": .string(id), "root_node_id": .string("root-" + tree), "name": .string("Archived " + tree), "archived_at": 5])
        nodes.append(["id": .string("root-" + tree), "workspace_id": .string(id), "tree_id": .string(tree), "title": "Root", "status": "idle", "deleted_at": .null])
    }
    return WorkspaceGraph(raw: [
        "workspace": ["id": .string(id), "name": .string(name), "deleted_at": deleted ? 9 : .null, "archived_at": archived ? 8 : .null,
                      "settings": system ? ["system": "home"] : .null],
        "trees": .array(trees), "nodes": .array(nodes), "edges": [],
    ])
}

@MainActor private func selecting(_ keys: [DesignTrashKey], segment: DesignTrashSegment = .deleted) -> DesignTrashBatchModel {
    let model = DesignTrashBatchModel(segment: segment)
    model.setSelecting(true)
    for key in keys { model.toggle(key) }
    return model
}

private func group(_ workspace: String, _ id: String) -> DesignTrashKey { DesignTrashKey(kind: .trashGroup, workspaceID: workspace, entityID: id) }

@MainActor
final class DesignTrashBatchTests: XCTestCase {
    private func threeGroups() -> FakeTrashOperations {
        FakeTrashOperations(graphs: [trashGraph("ws-a", name: "Alpha", groups: [("del-1", 30), ("del-2", 20), ("del-3", 10)])])
    }

    func testSegmentsListTheSameLifecycleEntries() {
        let graphs = [
            trashGraph("ws-a", name: "Alpha", groups: [("del-1", 30), ("arch-1", 25)], archivedTrees: ["tree-old"]),
            trashGraph("ws-b", name: "Beta", archived: true, groups: [("arch-2", 5)], archivedTrees: ["tree-b"]),
            trashGraph("ws-c", name: "Gone", deleted: true, groups: [("del-9", 3)]),
            trashGraph("ws-sys", name: "System", deleted: true, system: true),
        ]
        let deleted = DesignTrashCatalog.sections(graphs, segment: .deleted)
        XCTAssertEqual(deleted.map(\.title), ["Alpha", "Deleted workspaces"])
        XCTAssertEqual(deleted[0].items.map(\.key), [group("ws-a", "del-1")])
        XCTAssertEqual(deleted[1].items.map(\.key), [DesignTrashKey(kind: .deletedWorkspace, workspaceID: "ws-c", entityID: "ws-c")])

        let archived = DesignTrashCatalog.sections(graphs, segment: .archived)
        XCTAssertEqual(archived.map(\.title), ["Alpha", "Beta"])
        XCTAssertEqual(archived[0].items.map(\.key), [
            DesignTrashKey(kind: .archivedThread, workspaceID: "ws-a", entityID: "tree-old"),
            DesignTrashKey(kind: .archivedGroup, workspaceID: "ws-a", entityID: "arch-1"),
        ])
        // A read-only archived workspace offers only unarchiving the workspace itself.
        XCTAssertEqual(archived[1].items.map(\.key), [DesignTrashKey(kind: .archivedWorkspace, workspaceID: "ws-b", entityID: "ws-b")])
        XCTAssertEqual(archived[0].items.map(\.canPurge), [false, true])
    }

    func testRestoreRunsOneAtATimeInDisplayOrder() async {
        let operations = threeGroups()
        let model = selecting([group("ws-a", "del-3"), group("ws-a", "del-1")])
        let outcome = await model.perform(.restore, operations: operations)
        XCTAssertEqual(outcome, .completed(count: 2, action: .restore))
        XCTAssertEqual(operations.calls.map { $0.name }, ["restoreGroup", "restoreGroup"])
        XCTAssertEqual(operations.calls.map { $0.id }, ["del-1", "del-3"])
        XCTAssertEqual(operations.refreshCount, 2, "every item is revalidated from a fresh snapshot")
        XCTAssertTrue(model.selection.isEmpty)
        XCTAssertFalse(model.selecting)
        XCTAssertNil(model.running)
    }

    func testStopsAtTheFirstFailure() async {
        let operations = threeGroups()
        operations.failures = [("del-2", NativeFailure("This item was already restored or deleted on another device."))]
        let model = selecting([group("ws-a", "del-1"), group("ws-a", "del-2"), group("ws-a", "del-3")])
        let outcome = await model.perform(.restore, operations: operations)
        guard case .failed(let completed, let title, _) = outcome else { return XCTFail("Expected a failure, got \(outcome)") }
        XCTAssertEqual(completed, 1)
        XCTAssertEqual(title, "Thread del-2")
        XCTAssertEqual(operations.calls.map { $0.id }, ["del-1", "del-2"], "nothing after the failure is sent")
        XCTAssertEqual(model.selection, [group("ws-a", "del-2"), group("ws-a", "del-3")])
    }

    func testUnknownOutcomeStopsAndIsNotRetried() async {
        let operations = threeGroups()
        operations.failures = [("del-1", MichiAPIError(statusCode: nil, code: MichiAPIError.Code.network, message: "The connection was lost."))]
        let model = selecting([group("ws-a", "del-1"), group("ws-a", "del-2")])
        let outcome = await model.perform(.purge, operations: operations, confirmedPermanentDeletion: true)
        guard case .unknown(let completed, _, _) = outcome else { return XCTFail("Expected an unknown outcome, got \(outcome)") }
        XCTAssertEqual(completed, 0)
        XCTAssertEqual(operations.calls.map { $0.name }, ["purgeGroup"])
        XCTAssertEqual(operations.calls.map { $0.id }, ["del-1"])
        XCTAssertEqual(operations.refreshCount, 2, "a read-only refresh follows; the write is not repeated")
        XCTAssertTrue(model.outcome?.message.contains("not retried") == true)
    }

    func testFailureClassification() {
        XCTAssertTrue(DesignTrashBatchModel.isKnownFailure(NativeFailure("Refused")))
        XCTAssertTrue(DesignTrashBatchModel.isKnownFailure(MichiAPIError(statusCode: 409, code: "conflict", message: "Changed")))
        XCTAssertTrue(DesignTrashBatchModel.isKnownFailure(MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidPath, message: "Bad path")))
        XCTAssertFalse(DesignTrashBatchModel.isKnownFailure(MichiAPIError(statusCode: 503, code: nil, message: "Unavailable")))
        XCTAssertFalse(DesignTrashBatchModel.isKnownFailure(MichiAPIError(statusCode: 403, code: MichiAPIError.Code.htmlResponse, message: "Sign in")))
        XCTAssertFalse(DesignTrashBatchModel.isKnownFailure(MichiAPIError(statusCode: nil, code: MichiAPIError.Code.timedOut, message: "Timed out")))
        XCTAssertFalse(DesignTrashBatchModel.isKnownFailure(CancellationError()))
    }

    func testStopTakesEffectOnlyBetweenRequests() async {
        let operations = threeGroups()
        let model = selecting([group("ws-a", "del-1"), group("ws-a", "del-2"), group("ws-a", "del-3")])
        operations.beforeCall = { id in if id == "del-1" { model.requestStop() } }
        let outcome = await model.perform(.restore, operations: operations)
        XCTAssertEqual(outcome, .cancelled(completed: 1, remaining: 2))
        XCTAssertEqual(operations.calls.map { $0.id }, ["del-1"], "the request in flight finishes; later items are untouched")
        XCTAssertEqual(model.selection, [group("ws-a", "del-2"), group("ws-a", "del-3")])
    }

    func testItemChangedElsewhereStopsBeforeItsRequest() async {
        let operations = threeGroups()
        let model = selecting([group("ws-a", "del-1"), group("ws-a", "del-2")])
        operations.beforeCall = { id in
            if id == "del-1" { operations.graphs = [trashGraph("ws-a", name: "Alpha", groups: [("del-3", 10)])] }
        }
        let outcome = await model.perform(.restore, operations: operations)
        XCTAssertEqual(outcome, .unavailable(completed: 1, title: "Thread del-2"))
        XCTAssertEqual(operations.calls.map { $0.id }, ["del-1"])
    }

    func testSnapshotFailureSendsNothing() async {
        let operations = threeGroups()
        operations.refreshResults = [false]
        let model = selecting([group("ws-a", "del-1")])
        let outcome = await model.perform(.restore, operations: operations)
        guard case .failed(0, _, _) = outcome else { return XCTFail("Expected a failure before any write, got \(outcome)") }
        XCTAssertTrue(operations.calls.isEmpty)
    }

    func testPermanentDeleteRequiresConfirmation() async {
        let operations = threeGroups()
        let model = selecting([group("ws-a", "del-1")])
        guard case .refused = await model.perform(.purge, operations: operations) else { return XCTFail("Unconfirmed deletion must be refused") }
        XCTAssertTrue(operations.calls.isEmpty)
        let outcome = await model.perform(.purge, operations: operations, confirmedPermanentDeletion: true)
        XCTAssertEqual(outcome, .completed(count: 1, action: .purge))
        XCTAssertEqual(operations.calls.map { $0.name }, ["purgeGroup"])
    }

    func testRestoreOnlyEntriesCannotBePurged() async {
        let operations = FakeTrashOperations(graphs: [trashGraph("ws-a", archivedTrees: ["tree-old"]), trashGraph("ws-b", archived: true)])
        let thread = DesignTrashKey(kind: .archivedThread, workspaceID: "ws-a", entityID: "tree-old")
        let workspace = DesignTrashKey(kind: .archivedWorkspace, workspaceID: "ws-b", entityID: "ws-b")
        let model = selecting([thread, workspace], segment: .archived)
        let items = model.selectedItems(in: DesignTrashCatalog.sections(operations.graphs, segment: .archived))
        XCTAssertFalse(model.canRun(.purge, items: items, operations: operations))
        XCTAssertTrue(model.canRun(.restore, items: items, operations: operations))
        guard case .refused = await model.perform(.purge, operations: operations, confirmedPermanentDeletion: true) else { return XCTFail("Expected refusal") }
        XCTAssertTrue(operations.calls.isEmpty)
        let outcome = await model.perform(.restore, operations: operations)
        XCTAssertEqual(outcome, .completed(count: 2, action: .restore))
        XCTAssertEqual(operations.calls.map { $0.name }, ["unarchiveTree", "unarchiveWorkspace"])
    }

    func testRefusedWhileBusyOrBeforeHydration() async {
        let operations = threeGroups()
        let model = selecting([group("ws-a", "del-1")])
        operations.lifecycleBusy = true
        guard case .refused = await model.perform(.restore, operations: operations) else { return XCTFail("Busy store must refuse") }
        operations.lifecycleBusy = false; operations.hydrated = false
        guard case .refused = await model.perform(.restore, operations: operations) else { return XCTFail("Unhydrated store must refuse") }
        XCTAssertTrue(operations.calls.isEmpty)
        XCTAssertEqual(operations.refreshCount, 0)
    }

    func testIdentityIsExactUTF8() async {
        let nfc = "ws-\u{E9}", nfd = "ws-e\u{301}"
        XCTAssertEqual(nfc, nfd, "Swift String equality treats these as the same")
        let keyNFC = DesignTrashKey(kind: .deletedWorkspace, workspaceID: nfc, entityID: nfc)
        let keyNFD = DesignTrashKey(kind: .deletedWorkspace, workspaceID: nfd, entityID: nfd)
        XCTAssertNotEqual(keyNFC, keyNFD)
        XCTAssertEqual(Set([keyNFC, keyNFD]).count, 2)

        let operations = FakeTrashOperations(graphs: [trashGraph(nfc, name: "Composed", deleted: true), trashGraph(nfd, name: "Decomposed", deleted: true)])
        XCTAssertEqual(DesignTrashCatalog.resolve(keyNFD, in: operations.graphs)?.title, "Decomposed")
        let model = selecting([keyNFD])
        XCTAssertFalse(model.isSelected(keyNFC))
        let outcome = await model.perform(.purge, operations: operations, confirmedPermanentDeletion: true)
        XCTAssertEqual(outcome, .completed(count: 1, action: .purge))
        XCTAssertEqual(operations.calls.count, 1)
        XCTAssertTrue(operations.calls[0].id.utf8.elementsEqual(nfd.utf8), "only the exact selected workspace is deleted")
    }

    func testSwitchingSegmentClearsSelection() {
        let model = selecting([group("ws-a", "del-1")])
        model.setSegment(.archived)
        XCTAssertTrue(model.selection.isEmpty)
        model.toggle(group("ws-a", "del-1"))
        XCTAssertTrue(model.selection.isEmpty, "a Deleted entry cannot be selected on the Archived switch")
    }
}
