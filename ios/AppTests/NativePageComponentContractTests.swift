import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class NativePageComponentContractTests: XCTestCase {
    private let registered: JSONValue = ["id": "block-1", "type": "component", "componentId": "comp-1", "pinnedVersion": 2, "props": ["databaseId": "db-1"]]
    private let rawScript: JSONValue = ["id": "block-2", "type": "component", "componentId": "comp-1", "html": "<script>alert(1)</script>", "javascript": "alert(1)"]

    func testRegisteredComponentIsHostableAndRawScriptStaysUnsupported() {
        XCTAssertTrue(featureCanHostRegisteredComponent(registered))
        XCTAssertFalse(featureIsUnsupportedCustomBlock(registered))
        XCTAssertTrue(RichPageBlockModel.supportedTypes.contains("component"))
        XCTAssertFalse(featureCanHostRegisteredComponent(rawScript))
        XCTAssertTrue(featureIsUnsupportedCustomBlock(rawScript))
        XCTAssertFalse(featureCanHostRegisteredComponent(["type": "component"]))
        XCTAssertTrue(featureIsUnsupportedCustomBlock(["type": "component"]))
        XCTAssertFalse(featureIsUnsupportedCustomBlock(["type": "code", "code": "print(1)"]))
    }

    func testCustomViewHostingDoesNotWeakenNativeSaveGuards() throws {
        let view: JSONValue = ["id": "view-1", "name": "Custom", "type": "custom", "config": ["componentId": "comp-1", "pinnedVersion": 3, "props": ["x": 1]]]
        XCTAssertTrue(featureCanHostRegisteredCustomView(view))
        XCTAssertTrue(featureIsUnsupportedCustomView(view))
        XCTAssertThrowsError(try featureViewSaveOperation(from: view))
        XCTAssertFalse(featureCanHostRegisteredCustomView(["type": "custom", "config": ["code": "alert(1)"]]))
        XCTAssertFalse(featureCanHostRegisteredCustomView(["type": "custom", "config": [:]]))
        XCTAssertFalse(featureCanHostRegisteredCustomView(["type": "board", "config": ["componentId": "comp-1"]]))
        XCTAssertTrue(featureUnsupportedCustomReason(["type": "custom"]).contains("WebView"))
        XCTAssertFalse(featureUnsupportedCustomReason(view).contains("does not execute"))
    }

    func testPageOwnershipRequiresLiveIdentityAndDoesNotGuessWorkspace() {
        let preview = NativePageComponentOwnership(
            connectionIdentity: "https://example.test", credentialIdentity: "cred-a",
            workspaceID: "workspace-1", pageID: "page-1", expectedID: "page-1",
            title: "Home", revision: 4, readOnly: true, available: false
        )
        XCTAssertFalse(preview.allowsExecution)
        XCTAssertNil(NativePageComponentContract.pageHost(ownership: preview, block: registered))

        let live = NativePageComponentOwnership(
            connectionIdentity: "https://example.test", credentialIdentity: "cred-a",
            workspaceID: "workspace-1", pageID: "page-1", expectedID: "page-1",
            title: "Home", revision: 4, readOnly: false, available: true
        )
        let prepared = NativePageComponentContract.pageHost(ownership: live, block: registered)
        XCTAssertEqual(prepared?.host, ["kind": "page_block", "pageId": "page-1", "blockId": "block-1"])
        XCTAssertEqual(prepared?.componentID, "comp-1")
        XCTAssertEqual(prepared?.pinnedVersion, 2)
        XCTAssertEqual(prepared?.data["page"], ["id": "page-1", "title": "Home", "revision": 4])
        XCTAssertEqual(prepared?.data["block"], registered)
        XCTAssertEqual(prepared?.data["databases"], [:])
        XCTAssertEqual(prepared?.initialHeight, ComponentSandbox.heightMin)
        var resized = registered
        resized["height"] = 420
        resized["rev"] = 5
        resized["edit"] = ["at": 123]
        let revised = NativePageComponentContract.pageHost(ownership: live, block: resized)
        XCTAssertEqual(revised?.initialHeight, 420)
        XCTAssertEqual(revised?.bindingKey, .array([5, ["at": 123]]))
        XCTAssertEqual(revised?.scope, prepared?.scope)
        XCTAssertEqual(NativePageComponentContract.allowedDatabaseIDs(from: registered["props"]), ["db-1"])

        let otherPage = NativePageComponentOwnership(
            connectionIdentity: live.connectionIdentity, credentialIdentity: live.credentialIdentity,
            workspaceID: live.workspaceID, pageID: "page-other", expectedID: "page-1",
            title: live.title, revision: live.revision, readOnly: false, available: true
        )
        XCTAssertFalse(otherPage.allowsExecution)
        XCTAssertNil(NativePageComponentContract.pageHost(ownership: otherPage, block: registered))

        var guessed = registered
        guessed["workspaceId"] = "stolen-workspace"
        let fromLive = NativePageComponentContract.pageHost(ownership: live, block: guessed)
        XCTAssertEqual(fromLive?.host["pageId"], "page-1")
        XCTAssertNotEqual(fromLive?.host["pageId"], "stolen-workspace")
    }

    func testReadOnlyOwnedPageKeepsHostIdentityWithoutLeavingPreviewExecutable() {
        let ownedReadOnly = NativePageComponentOwnership(
            connectionIdentity: "https://example.test", credentialIdentity: "cred-a",
            workspaceID: "workspace-1", pageID: "page-1", expectedID: "page-1",
            title: "Home", revision: 4, readOnly: true, available: true
        )
        XCTAssertTrue(ownedReadOnly.allowsExecution)
        XCTAssertNotNil(NativePageComponentContract.pageHost(ownership: ownedReadOnly, block: registered))
        XCTAssertNil(NativePageComponentContract.pageHost(
            ownership: NativePageComponentOwnership(
                connectionIdentity: ownedReadOnly.connectionIdentity, credentialIdentity: ownedReadOnly.credentialIdentity,
                workspaceID: "", pageID: "page-1", expectedID: "page-1",
                title: "Home", revision: 4, readOnly: false, available: true
            ),
            block: registered
        ))
    }

    func testAllowedDatabaseIDsStayBoundedAndUnique() {
        var ids: [JSONValue] = (1...25).map { .string("db-\($0)") }
        ids.insert("db-1", at: 0)
        let props: JSONValue = ["databaseId": "db-root", "databaseIds": .array(ids)]
        let allowed = NativePageComponentContract.allowedDatabaseIDs(from: props)
        XCTAssertEqual(allowed.first, "db-root")
        XCTAssertEqual(allowed.count, 20)
        XCTAssertEqual(Set(allowed).count, 20)
        XCTAssertFalse(allowed.contains("db-25"))
    }

    func testComponentScopesAndDatabaseIDsKeepExactUnicodeBytes() {
        let composed = "caf\u{00e9}", decomposed = "cafe\u{0301}"
        func scope(_ id: String) -> String {
            NativePageComponentContract.hostScope(connectionIdentity: "https://fixture.test", credentialIdentity: "owner",
                workspaceID: "workspace", host: ["kind": "page_block", "pageId": .string(id), "blockId": "block"], componentID: "component")
        }
        XCTAssertNotEqual(scope(composed), scope(decomposed), "SwiftUI identity must remain distinct under String equality")
        XCTAssertEqual(NativePageComponentContract.allowedDatabaseIDs(from: ["databaseIds": [.string(composed), .string(decomposed)]]).count, 2)
        XCTAssertNil(NativePageComponentActions.unused.navigationHandler)
        XCTAssertNil(NativePageComponentActions.unused.draftHandler)
    }

    func testCustomDatabaseViewDataUsesSavedViewNotALocalDraft() {
        let columns: [JSONValue] = [
            ["id": "title", "name": "Title", "type": "text"],
            ["id": "status", "name": "Status", "type": "select", "options": [
                ["value": "todo", "label": "To do"],
                ["value": "done", "label": "Done"],
            ]],
        ]
        let rows: [JSONValue] = [
            ["id": "row-1", "position": 0, "rev": 1, "values": ["title": "One", "status": "todo"]],
            ["id": "row-2", "position": 1, "rev": 1, "values": ["title": "Two", "status": "done"]],
        ]
        let database: JSONValue = [
            "id": "db-1", "workspaceId": "workspace-1", "title": "Work", "revision": 7,
            "columns": .array(columns), "rows": .array(rows),
        ]
        let saved: JSONValue = [
            "id": "view-1", "type": "custom",
            "config": ["componentId": "comp-1", "filters": [], "match": "all", "sorts": [], "group": "status"],
        ]
        let draft: JSONValue = [
            "id": "view-1", "type": "custom",
            "config": ["componentId": "comp-1", "filters": [["column": "status", "op": "is", "value": "todo"]], "match": "all", "sorts": [], "group": "status"],
        ]
        let savedData = NativePageComponentContract.customDatabaseViewData(database: database, view: saved, rows: rows, columns: columns)
        let draftData = NativePageComponentContract.customDatabaseViewData(database: database, view: draft, rows: rows, columns: columns)
        XCTAssertEqual(savedData["database"], ["id": "db-1", "title": "Work", "revision": 7])
        XCTAssertEqual(savedData["columns"], .array(columns))
        XCTAssertEqual(savedData["rows"].arrayValue.map(\.id), ["row-1", "row-2"])
        XCTAssertEqual(savedData["groups"].arrayValue.map { $0["key"].stringValue }, ["todo", "done"])
        XCTAssertEqual(draftData["rows"].arrayValue.map(\.id), ["row-1"])
        XCTAssertNotEqual(savedData["rows"].arrayValue.map(\.id), draftData["rows"].arrayValue.map(\.id))

        let host = NativePageComponentContract.databaseHost(
            connectionIdentity: "https://example.test", credentialIdentity: "cred-a",
            workspaceID: "workspace-1", database: database, expectedDatabaseID: "db-1",
            view: saved, data: savedData
        )
        XCTAssertEqual(host?.host, ["kind": "database_view", "databaseId": "db-1", "viewId": "view-1"])
        XCTAssertEqual(host?.componentID, "comp-1")
        XCTAssertNil(NativePageComponentContract.databaseHost(
            connectionIdentity: "https://example.test", credentialIdentity: "cred-a",
            workspaceID: "other-workspace", database: database, expectedDatabaseID: "db-1",
            view: saved, data: savedData
        ))
        XCTAssertTrue(NativePageComponentContract.isDatabaseReadOnly(["readOnly": true]))
        XCTAssertTrue(NativePageComponentContract.isDatabaseReadOnly(["editable": false]))
        XCTAssertFalse(NativePageComponentContract.isDatabaseReadOnly(database))
    }

    func testHostScopeChangesWithCredentialWorkspaceHostAndComponentBytes() {
        let host: JSONValue = ["kind": "page_block", "pageId": "page-1", "blockId": "block-1"]
        let a = NativePageComponentContract.hostScope(
            connectionIdentity: "https://a.test", credentialIdentity: "cred-a",
            workspaceID: "workspace-1", host: host, componentID: "comp-1"
        )
        let b = NativePageComponentContract.hostScope(
            connectionIdentity: "https://a.test", credentialIdentity: "cred-b",
            workspaceID: "workspace-1", host: host, componentID: "comp-1"
        )
        let c = NativePageComponentContract.hostScope(
            connectionIdentity: "https://a.test", credentialIdentity: "cred-a",
            workspaceID: "workspace-2", host: host, componentID: "comp-1"
        )
        XCTAssertNotEqual(a, b)
        XCTAssertNotEqual(a, c)
        XCTAssertEqual(a, NativePageComponentContract.hostScope(
            connectionIdentity: "https://a.test", credentialIdentity: "cred-a",
            workspaceID: "workspace-1", host: host, componentID: "comp-1"
        ))
    }

    func testDraftAndPageCallbacksStayBounded() {
        XCTAssertNil(NativePageComponentContract.usableDraft(""))
        XCTAssertNil(NativePageComponentContract.usableDraft(String(repeating: "a", count: ComponentSandbox.draftCharacters + 1)))
        XCTAssertEqual(NativePageComponentContract.usableDraft("Ask about this page"), "Ask about this page")
        XCTAssertNil(NativePageComponentContract.usablePageID(""))
        XCTAssertEqual(NativePageComponentContract.usablePageID("page-1"), "page-1")
    }

    func testBoardDropPlansSameGroupMoveAndCrossGroupTransfer() {
        let todo = DatabaseOrderingGroup(key: "todo", title: "To do", rows: [
            ["id": "row-1"], ["id": "row-2"],
        ])
        let done = DatabaseOrderingGroup(key: "done", title: "Done", rows: [
            ["id": "row-3"],
        ])
        let fromTodo = DatabaseOrderingDragItem(
            scope: "scope", workspaceId: "workspace-1", databaseId: "db-1",
            revision: 7, kind: .row, id: "row-1", group: todo.id
        )
        XCTAssertEqual(NativeDatabaseBoardDrop.action(item: fromTodo, group: todo, ontoRowID: "row-2"), .moveOnto("row-2"))
        XCTAssertNil(NativeDatabaseBoardDrop.action(item: fromTodo, group: todo, ontoRowID: "row-1"))
        XCTAssertNil(NativeDatabaseBoardDrop.action(item: fromTodo, group: todo, ontoRowID: nil))
        XCTAssertEqual(NativeDatabaseBoardDrop.action(item: fromTodo, group: done, ontoRowID: "row-3"), .transfer(index: 0))
        XCTAssertEqual(NativeDatabaseBoardDrop.action(item: fromTodo, group: done, ontoRowID: nil), .transfer(index: 1))
        let column = DatabaseOrderingDragItem(
            scope: "scope", workspaceId: "workspace-1", databaseId: "db-1",
            revision: 7, kind: .column, id: "status", group: nil
        )
        XCTAssertNil(NativeDatabaseBoardDrop.action(item: column, group: done, ontoRowID: "row-3"))
        XCTAssertTrue(NativeDatabaseBoardDrop.accepts(nil))
        XCTAssertFalse(NativeDatabaseBoardDrop.accepts("That item belongs to another list and can't be dropped here."))
    }

    func testInlineHomePreviewOwnershipDoesNotExecuteAComponent() {
        let transport = AppContractTransport { _, _ in
            .json(["error": "unused"], status: 500)
        }
        defer { transport.close() }
        let preview: JSONValue = [
            "id": "home-page", "workspaceId": "workspace-1", "title": "Home", "revision": 3,
            "blocks": [["id": "widget", "rev": 1, "type": "component", "componentId": "comp-1", "props": [:]]],
        ]
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "workspace-1", initial: preview
        )
        XCTAssertFalse(model.liveOwned)
        XCTAssertTrue(model.readOnly)
        XCTAssertFalse(featureIsUnsupportedCustomBlock(preview["blocks"].arrayValue[0]))
        XCTAssertFalse(model.hasUnsupportedCustom)
        let ownership = model.pageComponentOwnership(api: transport.api)
        XCTAssertFalse(ownership.available)
        XCTAssertFalse(ownership.allowsExecution)
        XCTAssertNil(NativePageComponentContract.pageHost(ownership: ownership, block: preview["blocks"].arrayValue[0]))
    }
}
