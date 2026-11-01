import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class DatabaseManagementTests: XCTestCase {
    private static let custom: JSONValue = ["id": "custom", "name": "Overview", "type": "custom", "position": 3, "edit": ["at": 8],
        "config": ["filters": [], "sorts": [], "match": "all", "componentId": "component-1", "pinnedVersion": 4, "height": 360,
                   "props": ["zero": 0, "enabled": false, "optional": .null, "nested": ["unknown": [1, "two", false]]]]]
    private static let table: JSONValue = ["id": "table", "name": "Table", "type": "table", "position": 0, "config": ["filters": [], "sorts": [], "match": "all"]]
    private static let columns: [JSONValue] = [
        ["id": "number", "name": "Number", "type": "number"], ["id": "title", "name": "Title", "type": "text"],
        ["id": "tags", "name": "Tags", "type": "multi", "options": [["value": "a"], ["value": "b"], ["value": "c"]]],
        ["id": "due", "name": "Due", "type": "date"], ["id": "notes", "name": "Notes", "type": "text"],
    ]
    private static let database: JSONValue = ["id": "db", "workspaceId": "ws", "revision": 7, "title": "Work",
        "columns": .array(columns), "views": .array([table, custom]), "rows": [["id": "row", "rev": 7, "position": 0, "values": ["title": "Item", "tags": ["a", "c"]]]]]
    private static let workspace: JSONValue = ["workspace": ["id": "ws"], "nodes": [], "trees": [], "edges": []]
    private func store(_ transport: AppContractTransport) -> FeatureDatabaseModel { FeatureDatabaseModel(api: transport.api, databaseId: "db", workspaceId: "ws") }
    private func close(_ transport: AppContractTransport) {
        UserDefaults.standard.removeObject(forKey: "michi.database.management.\(transport.api.baseURL.absoluteString).ws.db")
        transport.close()
    }
    private static func response(_ request: AppContractRequest, database: JSONValue? = nil) -> AppContractResponse {
        if request.path == "/api/workspaces/ws" { return .json(workspace) }
        if request.path == "/api/databases/db" { return .json(database ?? Self.database) }
        return .json(["error": "Unexpected request"], status: 404)
    }

    func testMultiSelectBoardReplacesOnlySourceAndPreservesOtherChoices() throws {
        let row = Self.database["rows"].arrayValue[0], column = Self.columns[2]
        let moved = try featureBoardMoveOperation(row: row, groupColumn: column, key: "b", sourceKey: "a")
        XCTAssertEqual(moved, ["op": "row.update", "id": "row", "expectRev": 7, "values": ["tags": ["c", "b"]]])
        var alreadySelected = row; alreadySelected["values"]["tags"] = ["a", "b", "c"]
        XCTAssertEqual(try featureBoardMoveOperation(row: alreadySelected, groupColumn: column, key: "b", sourceKey: "a")["values"]["tags"], ["b", "c"])
        XCTAssertEqual(try featureBoardMoveOperation(row: row, groupColumn: column, key: nil, sourceKey: "a")["values"]["tags"], ["c"])
        var empty = row; empty["values"]["tags"] = .null
        XCTAssertEqual(try featureBoardMoveOperation(row: empty, groupColumn: column, key: "b", sourceKey: nil)["values"]["tags"], ["b"])
        XCTAssertThrowsError(try featureBoardMoveOperation(row: row, groupColumn: column, key: "b"))
        XCTAssertThrowsError(try featureBoardMoveOperation(row: row, groupColumn: column, key: "b", sourceKey: "missing"))
        XCTAssertThrowsError(try featureBoardMoveOperation(row: row, groupColumn: column.merging(["editable": false]), key: "b", sourceKey: "a"))
    }

    func testCustomViewRenameDuplicatePreserveOpaqueConfigAndUseNativeShape() throws {
        let renamed = try DatabaseManagement.saveView(Self.custom, name: " New name ")
        XCTAssertEqual(renamed["view"]["config"], Self.custom["config"])
        XCTAssertEqual(renamed["view"]["name"], "New name")
        XCTAssertEqual(Set(renamed["view"].objectValue.keys), ["id", "name", "type", "config"])
        let duplicate = try DatabaseManagement.duplicateView(Self.custom, database: Self.database, id: "copy-id")
        XCTAssertEqual(duplicate["view"].id, "copy-id")
        XCTAssertEqual(duplicate["view"]["name"], "Overview copy")
        XCTAssertEqual(duplicate["view"]["config"], Self.custom["config"])
        var future = Self.custom; future["config"]["futureFlag"] = ["retain": true]
        XCTAssertEqual(try DatabaseManagement.saveView(future, name: "Renamed")["view"]["config"], future["config"], "An unknown setting must be retained for server validation, never silently discarded")
        XCTAssertThrowsError(try DatabaseManagement.duplicateView(Self.custom, database: Self.database, id: "table"))
        XCTAssertThrowsError(try DatabaseManagement.deleteView(Self.table, database: Self.database.merging(["views": .array([Self.table])])) )
        XCTAssertEqual(try DatabaseManagement.deleteView(Self.custom, database: Self.database), ["op": "view.delete", "id": "custom"])
    }

    func testColumnManagementProtectsBuiltInsAndAllTaskCoreTypes() throws {
        let tasks = Self.database.merging(["role": "tasks"])
        for id in ["task", "status", "threads", "next"] {
            let column: JSONValue = ["id": .string(id), "type": "text"]
            let db = tasks.merging(["columns": .array([column])])
            XCTAssertThrowsError(try DatabaseManagement.deleteColumn(column, database: db))
            XCTAssertThrowsError(try DatabaseManagement.changeColumnType(column, type: "number", database: db))
        }
        let builtIn = Self.columns[0].merging(["builtin": true])
        XCTAssertThrowsError(try DatabaseManagement.changeColumnType(builtIn, type: "text", database: Self.database))
        XCTAssertThrowsError(try DatabaseManagement.changeColumnType(Self.columns[0], type: "threads", database: Self.database))
        XCTAssertEqual(try DatabaseManagement.changeColumnType(Self.columns[2], type: "text", database: Self.database), ["op": "column.update", "id": "tags", "patch": ["type": "text"]])
        XCTAssertEqual(try DatabaseManagement.deleteColumn(Self.columns[2], database: Self.database), ["op": "column.delete", "id": "tags"])
    }

    func testViewVisibilityUsesListDefaultsKeepsTitleAndPreservesCustomProperties() {
        let list = Self.table.merging(["type": "list"])
        XCTAssertEqual(DatabaseManagement.shownColumns(view: list, columns: Self.columns).map(\.id), ["number", "title", "due"])
        let hidden = DatabaseManagement.settingVisibility(view: list, columns: Self.columns, columnID: "number", visible: false)
        XCTAssertEqual(DatabaseManagement.shownColumns(view: hidden, columns: Self.columns).map(\.id), ["title", "due"])
        XCTAssertEqual(DatabaseManagement.settingVisibility(view: hidden, columns: Self.columns, columnID: "title", visible: false), hidden)
        let selected = DatabaseManagement.settingVisibility(view: Self.custom, columns: Self.columns, columnID: "tags", visible: false)
        XCTAssertEqual(selected["config"]["props"], Self.custom["config"]["props"])
        XCTAssertEqual(selected["config"]["pinnedVersion"], 4)
        XCTAssertFalse(DatabaseManagement.shownColumns(view: selected, columns: Self.columns).map(\.id).contains("tags"))
    }

    func testNativeCodeAndMermaidAreNotCustomComponents() {
        XCTAssertFalse(featureIsUnsupportedCustomBlock(["type": "code", "code": "print(1)", "language": "swift"]))
        XCTAssertFalse(featureIsUnsupportedCustomBlock(["type": "mermaid", "code": "graph TD; A-->B"]))
        XCTAssertTrue(featureCanHostRegisteredComponent(["type": "component", "componentId": "c"]))
        XCTAssertFalse(featureIsUnsupportedCustomBlock(["type": "component", "componentId": "c"]))
    }

    func testRenameSendsRevisionAndExactCustomConfigAfterVerifiedReads() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" {
                XCTAssertEqual(request.path, "/api/databases/db/edits")
                XCTAssertEqual(request.body["revision"], 7)
                let op = request.body["ops"].arrayValue[0]
                XCTAssertEqual(op["view"]["config"], Self.custom["config"])
                return .json(Self.database.merging(["revision": 8, "views": .array([Self.table, op["view"]])]))
            }
            return Self.response(request)
        }
        defer { close(transport) }
        let management = DatabaseManagementModel(model: store(transport))
        await management.refresh()
        let saved = await management.renameView(Self.custom, name: "Renamed")
        XCTAssertTrue(saved)
        XCTAssertNil(management.pending)
        XCTAssertEqual(management.model.views.first { $0.id == "custom" }?["name"], "Renamed")
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testDirtyViewDraftBlocksManagementAndSurvivesRefresh() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        defer { close(transport) }
        let model = store(transport), management = DatabaseManagementModel(model: model)
        await management.refresh()
        model.viewDraft["config"]["filters"] = [["column": "title", "op": "contains", "value": "keep"]]
        let draft = model.viewDraft
        let saved = await management.duplicateView(Self.custom)
        XCTAssertFalse(saved)
        await management.refresh()
        XCTAssertEqual(model.viewDraft, draft)
        XCTAssertEqual(model.viewRevision, 7)
        XCTAssertTrue(model.viewDirty)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testChangedRevisionAndFailedHydrationDoNotPost() async {
        let transport = AppContractTransport { request, requests in
            let reads = requests.filter { $0.path == "/api/databases/db" }.count
            return Self.response(request, database: reads > 1 ? Self.database.merging(["revision": 8]) : Self.database)
        }
        defer { close(transport) }
        let model = store(transport), management = DatabaseManagementModel(model: model)
        await management.refresh()
        let saved = await management.deleteView(Self.custom)
        XCTAssertFalse(saved)
        XCTAssertEqual(model.revision, 8)
        XCTAssertNotNil(model.error)
        XCTAssertNil(management.pending)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })

        let bad = AppContractTransport { _, _ in .json(["workspace": ["id": "ws", "archived_at": 100]]) }
        defer { close(bad) }
        let archived = DatabaseManagementModel(model: store(bad))
        await archived.refresh()
        XCTAssertFalse(archived.access)
        let archivedSave = await archived.duplicateView(Self.custom)
        XCTAssertFalse(archivedSave)
        XCTAssertTrue(bad.requests.allSatisfy { $0.method == "GET" })
    }

    func testUnknownDuplicateResultPersistsAndRefreshConfirmsWithoutReposting() async {
        let transport = AppContractTransport { request, requests in
            if request.method == "POST" { return .failure(.timedOut) }
            if let sent = requests.first(where: { $0.method == "POST" }), request.path == "/api/databases/db" {
                let duplicate = sent.body["ops"].arrayValue[0]["view"]
                return .json(Self.database.merging(["revision": 8, "views": .array([Self.table, Self.custom, duplicate])]))
            }
            return Self.response(request)
        }
        defer { close(transport) }
        let model = store(transport), management = DatabaseManagementModel(model: model)
        await management.refresh()
        let saved = await management.duplicateView(Self.custom)
        XCTAssertFalse(saved); XCTAssertNotNil(management.pending)
        let retry = await management.duplicateView(Self.custom)
        XCTAssertFalse(retry)
        let restored = DatabaseManagementModel(model: model)
        XCTAssertNotNil(restored.pending)
        await restored.refresh()
        XCTAssertNil(restored.pending)
        XCTAssertEqual(model.views.count, 3)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testMalformedSuccessfulResponseFreezesAndDoesNotReplaceSnapshot() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .json(["id": "db", "workspaceId": "ws", "revision": 8, "views": .array([Self.table])]) }
            return Self.response(request)
        }
        defer { close(transport) }
        let model = store(transport), management = DatabaseManagementModel(model: model)
        await management.refresh()
        let saved = await management.deleteView(Self.custom)
        XCTAssertFalse(saved); XCTAssertNotNil(management.pending)
        XCTAssertEqual(model.database, Self.database)
        XCTAssertNotNil(model.error)
        let retry = await management.deleteView(Self.custom)
        XCTAssertFalse(retry)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
}
