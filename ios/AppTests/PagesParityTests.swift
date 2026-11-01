import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class PagesParityTests: XCTestCase {
    func testLoadedPageOwnershipReplacesStaleNavigationWorkspace() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/pages/page-1" { return .json(["id": "page-1", "workspaceId": "current", "title": "Moved page", "revision": 2, "blocks": []]) }
            if request.path.hasSuffix("/task-database") { return .json(["databaseId": .null]) }
            if request.path.hasSuffix("/changes") { return .json(["changes": []]) }
            return .json(["items": []])
        }
        defer { transport.close() }
        let model = FeaturePageModel(api: transport.api, pageId: "page-1", workspaceId: "old")
        await model.refresh()
        XCTAssertEqual(model.workspaceId, "current")
        XCTAssertFalse(transport.requests.contains { $0.path.contains("/workspaces/old/") })
        XCTAssertTrue(transport.requests.contains { $0.path == "/api/workspaces/current/databases" })
    }
    private func page(_ title: String = "Home", revision: Int = 4, extra: [String: JSONValue] = [:]) -> JSONValue {
        .object([
            "id": "page-1", "workspaceId": "workspace-1", "title": .string(title),
            "revision": .number(Double(revision)), "blocks": .array([]),
            "keptUnknown": ["nested": true],
        ].merging(extra) { _, new in new })
    }

    private func change(
        id: String = "change-1",
        proposalState: JSONValue = "pending",
        applicationState: JSONValue = .null,
        sourceKind: String = "chat",
        extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        .object([
            "id": .string(id), "seq": 3, "batchId": "batch-1",
            "target": ["kind": "block", "pageId": "page-1", "blockId": "block-1"],
            "op": "update",
            "before": ["kind": "block", "exists": true, "block": ["id": "block-1", "type": "markdown", "text": "Old", "rev": 2], "location": ["parentId": .null, "slot": .null, "previousId": .null, "nextId": .null]],
            "after": ["kind": "block", "exists": true, "block": ["id": "block-1", "type": "markdown", "text": "New", "rev": 3], "location": ["parentId": .null, "slot": .null, "previousId": .null, "nextId": .null]],
            "forward": ["kind": "block", "op": "upsert", "block": ["id": "block-1", "type": "markdown", "text": "New", "rev": 3], "location": ["parentId": .null, "slot": .null, "previousId": .null, "nextId": .null]],
            "inverse": ["kind": "block", "op": "upsert", "block": ["id": "block-1", "type": "markdown", "text": "Old", "rev": 2], "location": ["parentId": .null, "slot": .null, "previousId": .null, "nextId": .null]],
            "baseRev": 2, "appliedRev": .null, "previousHeadId": .null,
            "source": ["kind": .string(sourceKind), "nodeId": "node-1", "turnId": "turn-1", "assistantId": "a-1"],
            "proposalState": proposalState, "applicationState": applicationState,
            "createdAt": 1_700_000_000_000, "resolvedAt": .null,
            "futureFlag": ["keep": true],
        ].merging(extra) { _, new in new })
    }

    func testHomeAndAllTasksRoutesAndWorkspaceHideBody() async throws {
        var hidden = false
        let transport = AppContractTransport { request, _ in
            switch request.path {
            case "/api/spaces-home":
                return .json(["role": "spaces-home", "page": self.page(), "layoutRules": []])
            case "/api/spaces-home/workspaces":
                return .json(["items": [["workspaceId": "workspace-1", "workspaceName": "Notes", "homePageId": "page-1", "hiddenAt": hidden ? 2 : .null, "pendingProposals": 1, "extra": "keep"]]])
            case "/api/spaces-home/sections":
                return .json(["waiting": ["items": [], "total": 0], "stalled": ["items": [], "total": 0], "done": ["items": [], "total": 0]])
            case "/api/spaces-home/all-tasks":
                return .json(["sources": [], "rows": [], "views": [], "viewsRevision": 0])
            case "/api/workspaces/workspace-1/home":
                if request.method == "PATCH" {
                    XCTAssertEqual(request.body, ["hidden": true])
                    hidden = true
                    return .json(["role": "workspace-home", "workspaceId": "workspace-1", "page": self.page(), "hiddenAt": 2, "layoutRules": [], "firstRun": .null])
                }
                return .json(["role": "workspace-home", "workspaceId": "workspace-1", "page": self.page(), "hiddenAt": .null, "layoutRules": [], "firstRun": .null])
            default:
                return .json(["error": .string("unexpected \(request.path)")], status: 500)
            }
        }
        defer { transport.close() }
        let model = FeatureSpacesHomeModel(api: transport.api, workspaces: [["id": "workspace-1", "name": "Notes"]])
        await model.refresh()
        XCTAssertEqual(model.homePage.id, "page-1")
        XCTAssertEqual(model.homePage["keptUnknown"], ["nested": true])
        XCTAssertEqual(model.workspaceHomes.first?["extra"], "keep")
        model.openHome()
        XCTAssertEqual(model.openedPage?.id, "page-1")
        await model.openWorkspaceHome("workspace-1")
        XCTAssertEqual(model.openedPage?.workspaceId, "workspace-1")
        await model.setWorkspaceHomeHidden("workspace-1", hidden: true)
        XCTAssertEqual(transport.requests.filter { $0.method == "PATCH" }.count, 1)
        XCTAssertTrue(hidden)
    }

    func testHomeFailureDoesNotInventEmptyPages() async {
        let transport = AppContractTransport { _, _ in .json(["error": ["code": "unavailable", "message": "Spaces Home is offline"]], status: 503) }
        defer { transport.close() }
        let model = FeatureSpacesHomeModel(api: transport.api, workspaces: [["id": "workspace-1"]])
        await model.refresh()
        XCTAssertNotNil(model.error)
        XCTAssertTrue(model.home.isNull)
        XCTAssertTrue(model.workspaceHomes.isEmpty)
    }

    func testTrashListRestoreAndPurgeUseEmptyBodies() async throws {
        var restored = false
        let group: JSONValue = [
            "deletionGroupId": "del-1", "deletedAt": 9,
            "root": ["id": "page-9", "title": "Gone", "workspaceId": "workspace-1"],
            "pages": [["id": "page-9", "title": "Gone"]],
            "databases": [],
        ]
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
        let model = FeaturePageTrashModel(api: transport.api, workspaceId: "workspace-1")
        await model.refresh()
        XCTAssertEqual(model.groups.count, 1)
        let result0 = await model.restore(group)
        XCTAssertTrue(result0)
        XCTAssertEqual(model.restoredPage?.id, "page-9")
        XCTAssertTrue(model.groups.isEmpty)
        restored = false
        await model.refresh()
        let result1 = await model.purge(group)
        XCTAssertTrue(result1)
    }

    func testRestoreConflictKeepsTrashAndReportsError() async {
        let group: JSONValue = ["deletionGroupId": "del-1", "root": ["id": "page-9"], "pages": [["id": "page-9"]]]
        let transport = AppContractTransport { request, _ in
            if request.path.hasPrefix("/api/workspaces/workspace-1/pages/trash") {
                return .json(["items": [group]])
            }
            return .json(["error": ["code": "conflict", "message": "Home pages cannot be deleted; hide them instead"]], status: 409)
        }
        defer { transport.close() }
        let model = FeaturePageTrashModel(api: transport.api, workspaceId: "workspace-1")
        await model.refresh()
        let result2 = await model.restore(group)
        XCTAssertFalse(result2)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.groups.count, 1)
        XCTAssertNil(model.restoredPage)
    }

    func testTrashRestoreAndPurgeSucceedOnPositiveMemberCounts() async {
        var restored = false
        let group: JSONValue = [
            "deletionGroupId": "del-1", "deletedAt": 9,
            "root": ["id": "page-9", "title": "Gone", "workspaceId": "workspace-1"],
            "pages": [["id": "page-9", "title": "Gone"]],
            "databases": [],
        ]
        let transport = AppContractTransport { request, _ in
            if request.path.hasPrefix("/api/workspaces/workspace-1/pages/trash") {
                return .json(["items": restored ? [] : [group], "nextCursor": .null])
            }
            if request.path == "/api/pages/page-9/restore" {
                XCTAssertEqual(request.method, "POST")
                XCTAssertEqual(request.body, [:])
                restored = true
                return .json(["restored": 1])
            }
            if request.path == "/api/pages/page-9/permanent" {
                XCTAssertEqual(request.method, "DELETE")
                XCTAssertEqual(request.body, [:])
                return .json(["purged": 3])
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageTrashModel(api: transport.api, workspaceId: "workspace-1")
        await model.refresh()
        let restoredSuccessfully = await model.restore(group)
        XCTAssertTrue(restoredSuccessfully)
        XCTAssertEqual(model.restoredPage?.id, "page-9")
        XCTAssertNil(model.error)
        XCTAssertTrue(model.groups.isEmpty)
        restored = false
        await model.refresh()
        let purgedSuccessfully = await model.purge(group)
        XCTAssertTrue(purgedSuccessfully)
        XCTAssertNil(model.error)
    }

    func testTrashRestoreRejectsZeroMemberCount() async {
        let group: JSONValue = ["deletionGroupId": "del-1", "root": ["id": "page-9"], "pages": [["id": "page-9"]]]
        let transport = AppContractTransport { request, _ in
            if request.path.hasPrefix("/api/workspaces/workspace-1/pages/trash") {
                return .json(["items": [group]])
            }
            if request.path == "/api/pages/page-9/restore" {
                XCTAssertEqual(request.method, "POST")
                XCTAssertEqual(request.body, [:])
                return .json(["restored": 0])
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageTrashModel(api: transport.api, workspaceId: "workspace-1")
        await model.refresh()
        let restoredSuccessfully = await model.restore(group)
        XCTAssertFalse(restoredSuccessfully)
        XCTAssertEqual(model.error, "Pages did not restore this item.")
        XCTAssertEqual(model.groups.count, 1)
        XCTAssertNil(model.restoredPage)
    }

    func testPageWriteReceiptsRejectZeroAndMalformedCounts() {
        let pageId = "page-9"
        let rejected: [(String, JSONValue)] = [
            ("zero", 0),
            ("negative", -1),
            ("fraction", .number(1.5)),
            ("bool true", true),
            ("bool false", false),
            ("nan", .number(.nan)),
            ("infinity", .number(.infinity)),
            ("-infinity", .number(-.infinity)),
            ("above safe integer", .number(9_007_199_254_740_992)),
            ("string one", "1"),
            ("null", .null),
            ("object", [:]),
            ("empty array", []),
        ]
        for (label, value) in rejected {
            XCTAssertThrowsError(try featureRequireRestoredPageIds(["restored": value], pageId: pageId), "restored \(label)")
            XCTAssertThrowsError(try featureRequirePurgedPageIds(["purged": value], pageId: pageId), "purged \(label)")
        }
        XCTAssertThrowsError(try featureRequireRestoredPageIds([:], pageId: pageId), "missing restored")
        XCTAssertThrowsError(try featureRequirePurgedPageIds([:], pageId: pageId), "missing purged")
        XCTAssertThrowsError(try featureRequireRestoredPageIds(["purged": 1], pageId: pageId), "count on the other key")
        XCTAssertThrowsError(try featureRequirePurgedPageIds(["restored": 1], pageId: pageId), "count on the other key")
        XCTAssertNoThrow(try featureRequireRestoredPageIds(["restored": 1], pageId: pageId))
        XCTAssertNoThrow(try featureRequirePurgedPageIds(["purged": 2], pageId: pageId))
        XCTAssertNoThrow(try featureRequireRestoredPageIds(["restored": 9_007_199_254_740_991], pageId: pageId))
        XCTAssertNoThrow(try featureRequirePurgedPageIds(["purged": 9_007_199_254_740_991], pageId: pageId))
    }

    func testPageWriteReceiptsKeepByteExactLegacyIdArrays() {
        let pageId = "page-9"
        let nfc = "caf\u{E9}"
        let nfd = "cafe\u{301}"
        XCTAssertEqual(nfc, nfd)
        XCTAssertFalse(nfc.utf8.elementsEqual(nfd.utf8))

        XCTAssertNoThrow(try featureRequireRestoredPageIds(["restored": ["page-9"]], pageId: pageId))
        XCTAssertNoThrow(try featureRequirePurgedPageIds(["purged": ["other", "page-9"]], pageId: pageId))
        XCTAssertThrowsError(try featureRequireRestoredPageIds(["restored": ["page-8"]], pageId: pageId))
        XCTAssertThrowsError(try featureRequirePurgedPageIds(["purged": ["page-8"]], pageId: pageId))
        XCTAssertThrowsError(try featureRequireRestoredPageIds(["restored": []], pageId: pageId))
        XCTAssertThrowsError(try featureRequirePurgedPageIds(["purged": ["page-9", "page-8"]], pageId: "missing"))

        XCTAssertNoThrow(try featureRequireRestoredPageIds(["restored": .array([.string(nfc)])], pageId: nfc))
        XCTAssertNoThrow(try featureRequirePurgedPageIds(["purged": .array([.string(nfd)])], pageId: nfd))
        XCTAssertThrowsError(try featureRequireRestoredPageIds(["restored": .array([.string(nfd)])], pageId: nfc))
        XCTAssertThrowsError(try featureRequirePurgedPageIds(["purged": .array([.string(nfc)])], pageId: nfd))
        XCTAssertThrowsError(try featureRequireRestoredPageIds(["restored": .array([.string(nfc)])], pageId: nfd))
        XCTAssertThrowsError(try featureRequirePurgedPageIds(["purged": .array([.string(nfd)])], pageId: nfc))
    }

    func testProposalAcceptDismissRevertRedoBodiesAndFailure() async throws {
        let pending = change()
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/changes") {
                let state = request.query["proposalState"]
                if state == "pending" {
                    return .json(["changes": [pending], "hasMore": false, "nextAfter": .null, "nextBefore": .null])
                }
                return .json(["changes": [pending], "hasMore": true, "nextAfter": .null, "nextBefore": 3])
            }
            if request.path.hasSuffix("/accept") {
                XCTAssertEqual(request.body, [:])
                return .json(["change": self.change(proposalState: "accepted", applicationState: "applied")])
            }
            if request.path.hasSuffix("/dismiss") {
                XCTAssertEqual(request.body, [:])
                return .json(["error": ["code": "undo_conflict", "message": "Only pending proposals can be dismissed"]], status: 409)
            }
            if request.path.hasSuffix("/revert") {
                XCTAssertEqual(request.body, [:])
                return .json(["change": self.change(proposalState: "accepted", applicationState: "reverted")])
            }
            if request.path.hasSuffix("/redo") {
                XCTAssertEqual(request.body, [:])
                return .json(["change": self.change(proposalState: "accepted", applicationState: "applied")])
            }
            return .json(["error": .string("unexpected \(request.path)")], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageHistoryModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        XCTAssertEqual(model.pending.count, 1)
        XCTAssertTrue(model.hasMore)
        XCTAssertEqual(model.nextAfter, 3)
        let result3 = await model.accept(pending)
        XCTAssertTrue(result3)
        let result4 = await model.dismiss(pending)
        XCTAssertFalse(result4)
        XCTAssertNotNil(model.error)
        let result5 = await model.revert(change(proposalState: "accepted", applicationState: "applied"))
        XCTAssertTrue(result5)
        let result6 = await model.redo(change(proposalState: "accepted", applicationState: "reverted"))
        XCTAssertTrue(result6)
        XCTAssertEqual(featurePageChangeActionPath("change-1", action: .accept), "/page-changes/change-1/accept")
        XCTAssertEqual(try featurePageChangeActionBody(action: .accept), [:])
        XCTAssertEqual(try featurePageChangeActionBody(action: .dismiss), [:])
    }

    func testEditedAcceptPreservesOnlyProposalFieldsAndRejectsUnknownShape() throws {
        let block = try featurePageChangeActionBody(action: .accept, editedContent: [
            "kind": "block", "block": ["type": "markdown", "text": "Edited"],
        ])
        XCTAssertEqual(block["editedContent"]["kind"], "block")
        XCTAssertEqual(block["editedContent"]["block"]["text"], "Edited")
        XCTAssertNil(block["editedContent"]["block"].objectValue["id"])

        let row = try featurePageChangeActionBody(action: .accept, editedContent: [
            "kind": "row", "values": ["task": "Renamed"], "body": "Notes",
        ])
        XCTAssertEqual(row["editedContent"]["values"], ["task": "Renamed"])

        XCTAssertThrowsError(try featurePageChangeActionBody(action: .dismiss, editedContent: ["kind": "block"]))
        XCTAssertThrowsError(try featureValidateEditedProposal(["kind": "row"]))
        XCTAssertThrowsError(try featureValidateEditedProposal(["kind": "block", "block": [:], "content": [:]]))
        XCTAssertThrowsError(try featureValidateEditedProposal(["kind": "view", "config": "nope"]))
    }

    func testDirtyPageTitleKeepsOriginalRevisionAcrossReload() async throws {
        var revision = 4
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/pages/page-1" && request.method == "PATCH" {
                XCTAssertEqual(request.body["revision"], 4)
                XCTAssertEqual(request.body["title"], "Draft title")
                revision = 5
                return .json(["page": self.page("Draft title", revision: revision)])
            }
            if request.path == "/api/pages/page-1" {
                return .json(["page": self.page("Server title", revision: revision, extra: ["color": "blue"])])
            }
            if request.path.contains("/changes") { return .json(["changes": []]) }
            if request.path.contains("/pages?") { return .json(["items": []]) }
            if request.path.contains("/databases") { return .json(["items": []]) }
            if request.path.contains("/task-database") { return .json(["databaseId": .null]) }
            return .json(["error": .string("unexpected \(request.path)")], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        XCTAssertEqual(model.title, "Server title")
        model.title = "Draft title"
        XCTAssertTrue(model.titleDirty)
        revision = 9
        await model.refresh()
        XCTAssertEqual(model.title, "Draft title")
        XCTAssertEqual(model.revision, 9)
        XCTAssertTrue(model.titleDirty)
        await model.saveTitle()
        let patch = try XCTUnwrap(transport.requests.first { $0.method == "PATCH" })
        XCTAssertEqual(patch.body["revision"], 4)
        XCTAssertNil(patch.body.objectValue["color"])
        XCTAssertNil(patch.body.objectValue["keptUnknown"])
    }

    func testDirtyHistoryDraftIsNotReplacedOnReload() async {
        let first = change()
        let later = change(extra: ["forward": ["kind": "block", "op": "upsert", "block": ["id": "block-1", "type": "markdown", "text": "Newer", "rev": 4], "location": ["parentId": .null, "slot": .null, "previousId": .null, "nextId": .null]]])
        var useLater = false
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/changes") {
                return .json(["changes": [useLater ? later : first], "hasMore": false])
            }
            return .json(["error": "no write"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageHistoryModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        model.beginEdit(first)
        model.draftContent = ["type": "markdown", "text": "Local draft"]
        XCTAssertTrue(model.draftDirty)
        XCTAssertEqual(model.draftRevision, 2)
        useLater = true
        await model.refresh()
        XCTAssertEqual(model.draftContent["text"], "Local draft")
        XCTAssertEqual(model.draftRevision, 2)
        XCTAssertEqual(model.changes.first?["futureFlag"], ["keep": true])
    }

    func testChangePreviewDoesNotRequireResubmittingUnknownSourceFields() {
        let preview = featurePageChangePreview(change())
        XCTAssertEqual(preview["before"]["block"]["text"], "Old")
        XCTAssertEqual(preview["after"]["block"]["text"], "New")
        XCTAssertEqual(preview["proposedBlock"]["text"], "New")
        XCTAssertNil(preview.objectValue["source"])
        XCTAssertTrue(featureIsPendingProposal(change()))
        XCTAssertTrue(featureIsPageChangeRevertible(change(proposalState: "accepted", applicationState: "applied")))
        XCTAssertTrue(featureIsPageChangeRedoable(change(proposalState: "accepted", applicationState: "reverted")))
        XCTAssertFalse(featureIsPageChangeRevertible(change(proposalState: .null, applicationState: "applied", sourceKind: "user", extra: ["source": ["kind": "user"]])))
    }

    func testAllTasksViewSaveUsesViewsRevisionAndKeepsDraftOn409() async throws {
        var revision = 2
        let view: JSONValue = ["id": "tasks-board", "name": "Board", "type": "board", "config": ["filters": [], "match": "all", "sorts": [], "group": "status"]]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/spaces-home/all-tasks" {
                return .json(["sources": [["workspaceId": "workspace-1", "workspaceName": "Notes", "databaseId": "db-1", "revision": 8]], "rows": [], "views": [view], "viewsRevision": .number(Double(revision))])
            }
            if request.path == "/api/spaces-home/all-tasks/views" {
                XCTAssertEqual(request.body["revision"], 2)
                XCTAssertEqual(request.body["ops"].arrayValue.first?["op"], "view.save")
                XCTAssertNil(request.body["ops"].arrayValue.first?["view"]["config"].objectValue["code"])
                return .json(["error": ["code": "stale_revision", "message": "All tasks views changed"]], status: 409)
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeatureAllTasksModel(api: transport.api)
        await model.refresh()
        XCTAssertEqual(model.viewRevision, 2)
        model.viewDraft["name"] = "My board"
        XCTAssertTrue(model.viewDirty)
        revision = 4
        await model.refresh()
        XCTAssertEqual(model.viewRevision, 2)
        XCTAssertEqual(model.viewDraft["name"], "My board")
        let result7 = await model.saveViewDraft()
        XCTAssertFalse(result7)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.viewRevision, 2)
        XCTAssertThrowsError(try featureAllTasksViewsBody(revision: 2, ops: [["op": "row.add", "values": [:]]]))
        XCTAssertThrowsError(try featureAllTasksViewsBody(revision: 2, ops: [["op": "view.save", "view": ["type": "custom", "name": "X", "config": featureEmptyViewConfig()]]]))
    }

    func testEditedAcceptAppliesProductionChangeAndClearsPending() async {
        let pending = change()
        let accepted = change(proposalState: "accepted", applicationState: "applied")
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/changes") {
                return .json(["changes": [pending], "hasMore": false])
            }
            if request.path.hasSuffix("/accept") {
                XCTAssertEqual(request.body["editedContent"]["block"]["text"], "Local draft")
                return .json(accepted)
            }
            return .json(["error": .string("unexpected \(request.path)")], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageHistoryModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        model.beginEdit(pending)
        let editingToken = model.draftToken
        model.draftContent = ["type": "markdown", "text": "Local draft"]
        XCTAssertTrue(model.draftDirty)
        XCTAssertEqual(model.pending.count, 1)
        let result8 = await model.acceptDraft(pending)
        XCTAssertTrue(result8)
        XCTAssertTrue(model.draftChangeId.isEmpty)
        XCTAssertNotEqual(model.draftToken, editingToken)
        XCTAssertFalse(model.draftDirty)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.changes.first?["proposalState"], "accepted")
        XCTAssertEqual(model.changes.first?["applicationState"], "applied")
    }

    func testAcceptDoesNotSucceedWithoutIdentifiedChange() async {
        let pending = change()
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/changes") {
                return .json(["changes": [pending], "hasMore": false])
            }
            if request.path.hasSuffix("/accept") {
                return .json(["ok": true])
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageHistoryModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        model.beginEdit(pending)
        model.draftContent = ["type": "markdown", "text": "Local draft"]
        let result9 = await model.acceptDraft(pending)
        XCTAssertFalse(result9)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.pending.count, 1)
        XCTAssertEqual(model.pending.first?["proposalState"], "pending")
        XCTAssertTrue(model.draftDirty)
        XCTAssertEqual(model.draftContent["text"], "Local draft")
    }

    func testHistoryMutationIgnoredWhileSaving() async {
        let pending = change()
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/changes") {
                return .json(["changes": [pending], "hasMore": false])
            }
            return .json(["error": "should not write"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageHistoryModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        model.saving = true
        let result10 = await model.accept(pending)
        XCTAssertFalse(result10)
        let result11 = await model.revertBatch("batch-1")
        XCTAssertFalse(result11)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 0)
    }

    func testBatchRevertRequiresRevertedIds() async {
        let pending = change()
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/changes") {
                return .json(["changes": [pending], "hasMore": false])
            }
            if request.path.hasSuffix("/revert") {
                return .json(["ok": true])
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageHistoryModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        let result12 = await model.revertBatch("batch-1")
        XCTAssertFalse(result12)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.pending.count, 1)
    }

    func testDraftSessionPreservesInvalidTextAcrossAppearAndResetsOnlyOnExplicitBegin() {
        var session = FeaturePageChangeDraftSession()
        let token = UUID()
        session.begin(token: token, changeID: "change-1", modelText: "{\"text\":\"New\"}")
        session.text = "{not json"
        session.error = "Enter valid proposed content"
        session.appear(token: token, changeID: "change-1", modelText: "{\"text\":\"New\"}")
        XCTAssertEqual(session.text, "{not json")
        XCTAssertEqual(session.error, "Enter valid proposed content")
        session.begin(token: UUID(), changeID: "change-1", modelText: "{\"text\":\"New\"}")
        XCTAssertEqual(session.text, "{\"text\":\"New\"}")
        XCTAssertNil(session.error)
    }

    func testDuplicateDraftSessionsKeepTheirOwnVisibleText() {
        var pending = FeaturePageChangeDraftSession()
        var history = FeaturePageChangeDraftSession()
        let token = UUID()
        pending.begin(token: token, changeID: "change-1", modelText: "{\"text\":\"Shared\"}")
        history.appear(token: token, changeID: "change-1", modelText: "{\"text\":\"Shared\"}")
        pending.text = "{\"text\":\"Pending edit\"}"
        history.text = "{invalid from history"
        history.error = "Enter valid proposed content"
        pending.appear(token: token, changeID: "change-1", modelText: "{\"text\":\"Shared\"}")
        history.appear(token: token, changeID: "change-1", modelText: "{\"text\":\"Shared\"}")
        XCTAssertEqual(pending.text, "{\"text\":\"Pending edit\"}")
        XCTAssertEqual(history.text, "{invalid from history")
        XCTAssertEqual(pending.visibleDraftText(), "{\"text\":\"Pending edit\"}")
        XCTAssertEqual(history.visibleDraftText(), "{invalid from history")
    }

    func testDuplicateCardCancelThenReopenUsesNewTokenWithoutOffscreenOnChange() async {
        let pendingChange = change()
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/changes") { return .json(["changes": [pendingChange], "hasMore": false]) }
            return .json(["error": "no write"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePageHistoryModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        let idle = model.draftToken
        model.beginEdit(pendingChange)
        XCTAssertNotEqual(model.draftToken, idle)
        let first = model.draftToken
        var waiting = FeaturePageChangeDraftSession()
        var history = FeaturePageChangeDraftSession()
        waiting.begin(token: first, changeID: pendingChange.id, modelText: model.draftContent.prettyPrinted)
        history.appear(token: first, changeID: pendingChange.id, modelText: model.draftContent.prettyPrinted)
        waiting.text = "{cancelled in waiting"
        waiting.error = "Enter valid proposed content"
        history.text = "{stale history leftover"
        history.error = "Enter valid proposed content"
        model.discardEdit()
        waiting.discard()
        XCTAssertNotEqual(model.draftToken, first)
        XCTAssertEqual(history.text, "{stale history leftover")
        model.beginEdit(pendingChange)
        let reopened = model.draftToken
        XCTAssertNotEqual(reopened, first)
        history.appear(token: reopened, changeID: pendingChange.id, modelText: model.draftContent.prettyPrinted)
        XCTAssertEqual(history.text, model.draftContent.prettyPrinted)
        XCTAssertNil(history.error)
        history.text = "{invalid after reopen"
        history.error = "Enter valid proposed content"
        history.appear(token: reopened, changeID: pendingChange.id, modelText: model.draftContent.prettyPrinted)
        XCTAssertEqual(history.text, "{invalid after reopen")
        XCTAssertEqual(model.draftRevision, 2)
    }

    func testPageChangeResultAcceptsProductionAndWrappedShapes() throws {
        let accepted = change(proposalState: "accepted", applicationState: "applied")
        XCTAssertEqual(try featurePageChangeResult(accepted, expectedId: "change-1", action: .accept)["id"], "change-1")
        XCTAssertEqual(try featurePageChangeResult(["change": accepted], expectedId: "change-1", action: .accept)["proposalState"], "accepted")
        XCTAssertThrowsError(try featurePageChangeResult(["ok": true], expectedId: "change-1", action: .accept))
        XCTAssertThrowsError(try featurePageChangeResult(change(), expectedId: "change-1", action: .accept))
        XCTAssertThrowsError(try featurePageChangeResult(accepted, expectedId: "other", action: .accept))
    }
}
