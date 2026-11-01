import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor private final class FakePageTrashOperations: DesignTrashOperations {
    var graphs: [WorkspaceGraph]
    var pageSnapshot: DesignTrashPagesSnapshot
    var hydrated = true
    var lifecycleBusy = false
    var refreshResults: [Bool] = []
    private(set) var refreshCount = 0
    private(set) var calls: [(name: String, id: String)] = []
    var failures: [(id: String, error: Error)] = []
    var pageErrorsAfterRefresh: [String: String] = [:]

    init(graphs: [WorkspaceGraph], pages: DesignTrashPagesSnapshot) {
        self.graphs = graphs
        self.pageSnapshot = pages
    }

    func refreshTrashSnapshot() async -> Bool {
        refreshCount += 1
        if !pageErrorsAfterRefresh.isEmpty {
            pageSnapshot.workspaces = pageSnapshot.workspaces.map { workspace in
                let error = pageErrorsAfterRefresh.first { DesignPageOpaqueID.same($0.key, workspace.id.raw) }?.value
                return DesignTrashPagesWorkspace(id: workspace.id, name: workspace.name, groups: workspace.groups, error: error ?? workspace.error)
            }
        }
        return refreshResults.isEmpty ? true : refreshResults.removeFirst()
    }
    private func record(_ name: String, _ id: String) throws {
        calls.append((name, id))
        if let failure = failures.first(where: { $0.id.utf8.elementsEqual(id.utf8) }) { throw failure.error }
    }
    func restoreGroup(_ group: DeletionGroup) async throws -> String { try record("restoreGroup", group.id); return group.root.id }
    func purgeGroup(_ group: DeletionGroup) async throws { try record("purgeGroup", group.id) }
    func restoreWorkspace(_ graph: WorkspaceGraph) async throws { try record("restoreWorkspace", graph.id) }
    func purgeWorkspace(_ graph: WorkspaceGraph) async throws { try record("purgeWorkspace", graph.id) }
    func archiveTree(_ tree: JSONValue, archived: Bool) async throws { try record(archived ? "archiveTree" : "unarchiveTree", tree.id) }
    func setWorkspaceArchived(_ graph: WorkspaceGraph, archived: Bool) async throws { try record(archived ? "archiveWorkspace" : "unarchiveWorkspace", graph.id) }
    func restorePageGroup(_ group: JSONValue, workspaceID: String) async throws {
        try record("restorePage", DesignTrashPages.actionPageID(group) + "@" + workspaceID)
    }
    func purgePageGroup(_ group: JSONValue, workspaceID: String) async throws {
        try record("purgePage", DesignTrashPages.actionPageID(group) + "@" + workspaceID)
    }
}

private func pageGraph(_ id: String, name: String = "Workspace", deleted: Bool = false, system: Bool = false,
                       groups: [(id: String, deletedAt: Double)] = []) -> WorkspaceGraph {
    var nodes: [JSONValue] = []
    for group in groups {
        nodes.append(["id": .string("node-" + group.id), "workspace_id": .string(id), "tree_id": "tree-live", "title": .string("Thread " + group.id),
                      "status": "idle", "deleted_at": .number(group.deletedAt), "deletion_group_id": .string(group.id)])
    }
    return WorkspaceGraph(raw: [
        "workspace": ["id": .string(id), "name": .string(name), "deleted_at": deleted ? 9 : .null, "archived_at": .null,
                      "settings": system ? ["system": "home"] : .null],
        "trees": [], "nodes": .array(nodes), "edges": [],
    ])
}

private func pageGroup(id: String, pageId: String, title: String, workspaceId: String, deletedAt: Double = 20, extraPages: [JSONValue] = []) -> JSONValue {
    var pages: [JSONValue] = [["id": .string(pageId), "title": .string(title), "workspaceId": .string(workspaceId)]]
    pages.append(contentsOf: extraPages)
    return [
        "deletionGroupId": .string(id), "deletedAt": .number(deletedAt),
        "root": ["id": .string(pageId), "title": .string(title), "workspaceId": .string(workspaceId)],
        "pages": .array(pages), "databases": [],
    ]
}

private func pageSnapshot(_ workspaces: [(id: String, name: String, groups: [JSONValue], error: String?)]) -> DesignTrashPagesSnapshot {
    DesignTrashPagesSnapshot(workspaces: workspaces.map {
        DesignTrashPagesWorkspace(id: DesignPageOpaqueID(raw: $0.id), name: $0.name, groups: $0.groups, error: $0.error)
    })
}

@MainActor private func selecting(_ keys: [DesignTrashKey], segment: DesignTrashSegment = .deleted) -> DesignTrashBatchModel {
    let model = DesignTrashBatchModel(segment: segment)
    model.setSelecting(true)
    for key in keys { model.toggle(key) }
    return model
}

@MainActor
final class DesignTrashPagesTests: XCTestCase {
    func testActionPageIDMatchesFeaturePageTrashModel() {
        let rooted = pageGroup(id: "del-1", pageId: "page-9", title: "Launch FAQ", workspaceId: "ws-a")
        XCTAssertEqual(DesignTrashPages.actionPageID(rooted), "page-9")
        let firstPage: JSONValue = [
            "deletionGroupId": "del-2", "deletedAt": 4,
            "root": ["id": "", "title": "Child"],
            "pages": [["id": "page-first", "title": "Child"]],
        ]
        XCTAssertEqual(DesignTrashPages.actionPageID(firstPage), "page-first")
        XCTAssertEqual(DesignTrashPages.title(rooted), "Launch FAQ")
    }

    func testCompoundIdentityIsExactUTF8() {
        let nfc = "é", nfd = "e\u{0301}"
        XCTAssertEqual(nfc, nfd)
        let left = DesignTrashPagesIdentity(workspaceID: nfc, deletionGroupID: nfc, pageID: nfc)
        let right = DesignTrashPagesIdentity(workspaceID: nfd, deletionGroupID: nfd, pageID: nfd)
        XCTAssertNotEqual(left, right)
        XCTAssertEqual(Set([left, right]).count, 2)
        let keyNFC = DesignTrashPages.key(pageGroup(id: nfc, pageId: nfc, title: "NFC", workspaceId: nfc), workspaceID: nfc)
        let keyNFD = DesignTrashPages.key(pageGroup(id: nfd, pageId: nfd, title: "NFD", workspaceId: nfd), workspaceID: nfd)
        XCTAssertNotEqual(keyNFC, keyNFD)
        XCTAssertFalse(keyNFC == DesignTrashKey(kind: .trashPage, workspaceID: nfc, entityID: nfc, qualifier: nfd))
    }

    func testPagesListUnderTheirWorkspaceAfterThreads() {
        let graphs = [
            pageGraph("ws-a", name: "Alpha", groups: [("del-1", 30)]),
            pageGraph("ws-b", name: "Beta"),
            pageGraph("ws-c", name: "Gone", deleted: true),
            pageGraph("ws-sys", name: "System", system: true),
        ]
        let faq = pageGroup(id: "pg-1", pageId: "page-faq", title: "Launch FAQ", workspaceId: "ws-a")
        let notes = pageGroup(id: "pg-2", pageId: "page-notes", title: "Notes", workspaceId: "ws-b")
        let pages = pageSnapshot([
            (id: "ws-a", name: "Alpha", groups: [faq], error: nil),
            (id: "ws-b", name: "Beta", groups: [notes], error: nil),
            (id: "ws-c", name: "Gone", groups: [pageGroup(id: "pg-x", pageId: "gone", title: "Hidden", workspaceId: "ws-c")], error: nil),
        ])
        let deleted = DesignTrashCatalog.sections(graphs, segment: .deleted, pages: pages)
        XCTAssertEqual(deleted.map(\.title), ["Alpha", "Beta", "Deleted workspaces"])
        XCTAssertEqual(deleted[0].items.map(\.key.kind), [.trashGroup, .trashPage])
        XCTAssertEqual(deleted[0].items.map(\.title), ["Thread del-1", "Launch FAQ"])
        XCTAssertEqual(deleted[1].items.map(\.key), [DesignTrashPages.key(notes, workspaceID: "ws-b")])
        XCTAssertTrue(deleted[1].items[0].canPurge)
        XCTAssertEqual(deleted[2].items.map(\.key.kind), [.deletedWorkspace])
    }

    func testPageLoadErrorDoesNotDropChatGroups() {
        let graphs = [pageGraph("ws-a", name: "Alpha", groups: [("del-1", 30)])]
        let pages = pageSnapshot([(id: "ws-a", name: "Alpha", groups: [], error: "Pages trash is offline")])
        let deleted = DesignTrashCatalog.sections(graphs, segment: .deleted, pages: pages)
        XCTAssertEqual(deleted.map(\.title), ["Alpha"])
        XCTAssertEqual(deleted[0].items.map(\.key.kind), [.trashGroup])
        XCTAssertEqual(pages.errors.map(\.message), ["Pages trash is offline"])
        XCTAssertFalse(pages.hasGroups)
    }

    func testRestoreAndPurgeUseEmptyBodiesAndConfirmedIds() async throws {
        let group = pageGroup(id: "del-1", pageId: "page-9", title: "Launch FAQ", workspaceId: "workspace-1")
        var restored = false
        let transport = AppContractTransport { request, _ in
            if request.path.hasPrefix("/api/workspaces/workspace-1/pages/trash") {
                return .json(["items": restored ? [] : [group], "nextCursor": .null])
            }
            if request.path == "/api/pages/page-9/restore" {
                XCTAssertEqual(request.method, "POST")
                XCTAssertEqual(request.body, [:])
                restored = true
                return .json(["restored": ["page-9"]])
            }
            if request.path == "/api/pages/page-9/permanent" {
                XCTAssertEqual(request.method, "DELETE")
                XCTAssertEqual(request.body, [:])
                return .json(["purged": ["page-9"]])
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        try await DesignTrashPages.restore(group, api: transport.api)
        XCTAssertTrue(restored)
        try await DesignTrashPages.purge(group, api: transport.api)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/restore") }.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/permanent") }.count, 1)
    }

    func testRestoreConfirmationRejectsZeroAffectedPages() async {
        let group = pageGroup(id: "del-1", pageId: "page-9", title: "Launch FAQ", workspaceId: "workspace-1")
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/pages/page-9/restore" { return .json(["restored": 0]) }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        do {
            try await DesignTrashPages.restore(group, api: transport.api)
            XCTFail("A zero affected-page count must not confirm a restore")
        } catch {
            XCTAssertTrue(error is FeatureRequestError)
            XCTAssertFalse(DesignTrashBatchModel.isKnownFailure(error), "unconfirmed restore is not retried")
        }
    }

    func testFeaturePageTrashModelPaginationIsConsumed() async {
        let first = pageGroup(id: "pg-1", pageId: "page-1", title: "One", workspaceId: "workspace-1")
        let second = pageGroup(id: "pg-2", pageId: "page-2", title: "Two", workspaceId: "workspace-1")
        let transport = AppContractTransport { request, _ in
            if request.path.hasPrefix("/api/workspaces/workspace-1/pages/trash") {
                if request.query["cursor"] == "next-1" {
                    return .json(["items": [second], "nextCursor": .null])
                }
                return .json(["items": [first], "nextCursor": "next-1"])
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageTrashModel(api: transport.api, workspaceId: "workspace-1")
        await model.refresh()
        XCTAssertNil(model.error)
        XCTAssertEqual(model.groups.map { $0["deletionGroupId"].stringValue }, ["pg-1", "pg-2"])
        XCTAssertEqual(transport.requests.filter { $0.path.contains("/pages/trash") }.count, 2)
    }

    func testLoaderKeepsChatWorkspaceWhenOnePageListFails() async {
        let graphs = [pageGraph("ws-ok", name: "OK"), pageGraph("ws-bad", name: "Bad")]
        let group = pageGroup(id: "pg-1", pageId: "page-1", title: "FAQ", workspaceId: "ws-ok")
        let transport = AppContractTransport { request, _ in
            if request.path.hasPrefix("/api/workspaces/ws-ok/pages/trash") {
                return .json(["items": [group], "nextCursor": .null])
            }
            if request.path.hasPrefix("/api/workspaces/ws-bad/pages/trash") {
                return .json(["error": ["code": "unavailable", "message": "Pages trash is offline"]], status: 503)
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = DesignTrashPagesModel()
        await model.refresh(api: transport.api, graphs: graphs)
        XCTAssertEqual(model.snapshot.groups(for: "ws-ok").count, 1)
        XCTAssertEqual(model.snapshot.groups(for: "ws-bad").count, 0)
        XCTAssertEqual(model.snapshot.errors.map(\.workspaceName), ["Bad"])
        XCTAssertTrue(model.snapshot.refreshFailed(for: "ws-bad"))
        XCTAssertFalse(model.snapshot.refreshFailed(for: "ws-ok"))
        let sections = DesignTrashCatalog.sections(graphs, segment: .deleted, pages: model.snapshot)
        XCTAssertEqual(sections.map(\.title), ["OK"])
        XCTAssertEqual(sections[0].items.map(\.title), ["FAQ"])
    }

    func testBatchRestoresPagesWithCompoundKeysAndStopsOnPageSnapshotFailure() async {
        let faq = pageGroup(id: "pg-1", pageId: "page-faq", title: "Launch FAQ", workspaceId: "ws-a")
        let notes = pageGroup(id: "pg-2", pageId: "page-notes", title: "Notes", workspaceId: "ws-a")
        let graphs = [pageGraph("ws-a", name: "Alpha", groups: [("del-1", 30)])]
        let pages = pageSnapshot([(id: "ws-a", name: "Alpha", groups: [faq, notes], error: nil)])
        let operations = FakePageTrashOperations(graphs: graphs, pages: pages)
        let keys = [DesignTrashPages.key(faq, workspaceID: "ws-a"), DesignTrashPages.key(notes, workspaceID: "ws-a")]
        let model = selecting(keys)
        let outcome = await model.perform(.restore, operations: operations)
        XCTAssertEqual(outcome, .completed(count: 2, action: .restore))
        XCTAssertEqual(operations.calls.map(\.name), ["restorePage", "restorePage"])
        XCTAssertEqual(operations.calls.map(\.id), ["page-faq@ws-a", "page-notes@ws-a"])

        let blocked = FakePageTrashOperations(graphs: graphs, pages: pages)
        blocked.pageErrorsAfterRefresh = ["ws-a": "Pages trash is offline"]
        let stopped = selecting([DesignTrashPages.key(faq, workspaceID: "ws-a")])
        let failed = await stopped.perform(.restore, operations: blocked)
        guard case .failed(0, "Launch FAQ", let message) = failed else { return XCTFail("Expected a page snapshot failure, got \(failed)") }
        XCTAssertTrue(message.contains("couldn't read the latest saved state"))
        XCTAssertTrue(blocked.calls.isEmpty)
    }

    func testBatchDoesNotApplyACanonicallyEquivalentPage() async {
        let nfc = "é", nfd = "e\u{0301}"
        let nfcGroup = pageGroup(id: nfc, pageId: nfc, title: "Composed", workspaceId: nfc)
        let nfdGroup = pageGroup(id: nfd, pageId: nfd, title: "Decomposed", workspaceId: nfd)
        let graphs = [pageGraph(nfc, name: "Composed"), pageGraph(nfd, name: "Decomposed")]
        let pages = pageSnapshot([
            (id: nfc, name: "Composed", groups: [nfcGroup], error: nil),
            (id: nfd, name: "Decomposed", groups: [nfdGroup], error: nil),
        ])
        let operations = FakePageTrashOperations(graphs: graphs, pages: pages)
        let model = selecting([DesignTrashPages.key(nfdGroup, workspaceID: nfd)])
        let outcome = await model.perform(.purge, operations: operations, confirmedPermanentDeletion: true)
        XCTAssertEqual(outcome, .completed(count: 1, action: .purge))
        XCTAssertEqual(operations.calls.count, 1)
        XCTAssertTrue(operations.calls[0].id.utf8.elementsEqual(("\(nfd)@\(nfd)").utf8))
    }
}
