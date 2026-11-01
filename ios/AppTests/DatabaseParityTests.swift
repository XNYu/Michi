import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class DatabaseParityTests: XCTestCase {
    func testLinkedDatabaseViewSelectedOnceWithoutOverwritingLaterChoice() async {
        let database: JSONValue = ["id": "db-1", "workspaceId": "workspace-1", "revision": 1, "columns": [], "rows": [], "views": [
            ["id": "table", "type": "table", "config": featureEmptyViewConfig()],
            ["id": "calendar", "type": "calendar", "config": featureEmptyViewConfig()]
        ]]
        let transport = AppContractTransport { _, _ in .json(database) }
        defer { transport.close() }
        let model = FeatureDatabaseModel(api: transport.api, databaseId: "db-1", workspaceId: "workspace-1", initialViewId: "calendar")
        await model.refresh()
        XCTAssertEqual(model.selectedViewId, "calendar")
        model.selectView("table")
        await model.refresh()
        XCTAssertEqual(model.selectedViewId, "table")
        XCTAssertFalse(model.viewDirty)
    }
    private let columns: [JSONValue] = [
        ["id": "name", "name": "Name", "type": "text"],
        ["id": "count", "name": "Count", "type": "number"],
        ["id": "checked", "name": "Checked", "type": "checkbox"],
        ["id": "date", "name": "Date", "type": "date"],
        ["id": "tags", "name": "Tags", "type": "multi", "options": [
            ["value": "one", "label": "One"],
            ["value": "two", "label": "Two"],
        ]],
        ["id": "threads", "name": "Threads", "type": "threads"],
        ["id": "status", "name": "Status", "type": "select", "options": [
            ["value": "todo", "label": "To do"],
            ["value": "doing", "label": "In progress"],
        ]],
        ["id": "computed", "name": "Computed", "type": "text", "editable": false],
    ]

    private var original: JSONValue {
        [
            "id": "row-1", "rev": 7, "body": "Original notes", "position": 0,
            "values": [
                "name": "Original", "count": 12, "checked": true,
                "date": ["start": "2026-10-01", "end": "2026-10-31", "kept": "meta"],
                "tags": ["one", "two"],
                "threads": ["thread-a", "thread-b"],
                "status": "todo",
                "computed": "Derived",
            ],
            "edited": ["name": 123], "bodyEditedAt": 456, "unknownRow": ["keep": true],
        ]
    }

    private func drafts(for row: JSONValue) -> [String: String] {
        Dictionary(uniqueKeysWithValues: columns.map { column in
            (column.id, featureCellDraft(row["values"][column.id], type: column["type"].stringValue))
        })
    }

    func testStringDraftPathStillDoesNotClaimStructuredCells() throws {
        var draft = drafts(for: original)
        draft["date"] = "Should not be written"
        draft["tags"] = "Should not be written"
        draft["threads"] = "Should not be written"
        XCTAssertNil(try featureDatabaseRowUpdate(baseline: original, columns: columns, drafts: draft, body: "Original notes"))
        for column in columns where ["date", "tags", "threads", "computed"].contains(column.id) {
            XCTAssertFalse(featureCanEditColumn(column), column.id)
        }
        XCTAssertTrue(featureCanEditStructuredColumn(columns.first { $0.id == "date" }!))
        XCTAssertTrue(featureCanEditStructuredColumn(columns.first { $0.id == "tags" }!))
        XCTAssertTrue(featureCanEditStructuredColumn(columns.first { $0.id == "threads" }!))
        XCTAssertFalse(featureCanEditStructuredColumn(columns.first { $0.id == "computed" }!))
    }

    func testStructuredDateMultiAndThreadsWriteOnlyChangedKeys() throws {
        let date = try featureParseDateCell(start: "2026-11-02", end: "2026-11-04")
        let tags = try featureParseMultiCell(["two"], options: columns.first { $0.id == "tags" }!["options"].arrayValue)
        let threads = try featureParseThreadsCell(["thread-a"])
        let operation = try XCTUnwrap(featureDatabaseRowValueUpdate(
            baseline: original,
            columns: columns,
            drafts: drafts(for: original),
            structured: ["date": date, "tags": tags, "threads": threads],
            body: "Original notes"
        ))
        XCTAssertEqual(operation["op"], "row.update")
        XCTAssertEqual(operation["id"], "row-1")
        XCTAssertEqual(operation["expectRev"], 7)
        XCTAssertEqual(operation["values"]["date"], ["start": "2026-11-02", "end": "2026-11-04"])
        XCTAssertEqual(operation["values"]["tags"], ["two"])
        XCTAssertEqual(operation["values"]["threads"], ["thread-a"])
        XCTAssertNil(operation["values"].objectValue["name"])
        XCTAssertNil(operation["values"].objectValue["computed"])
        XCTAssertNil(operation.objectValue["edited"])
        XCTAssertNil(operation.objectValue["unknownRow"])
        XCTAssertEqual(original["values"]["date"]["kept"], "meta")
    }

    func testUnchangedStructuredValuesDoNotSubmitOwnership() throws {
        XCTAssertNil(try featureDatabaseRowValueUpdate(
            baseline: original,
            columns: columns,
            drafts: drafts(for: original),
            structured: [
                "date": original["values"]["date"],
                "tags": original["values"]["tags"],
                "threads": original["values"]["threads"],
            ],
            body: "Original notes"
        ))
    }

    func testClearingDateSendsNullAndInvalidDatesFailClosed() throws {
        let cleared = try XCTUnwrap(featureDatabaseRowValueUpdate(
            baseline: original, columns: columns, drafts: drafts(for: original),
            structured: ["date": .null], body: "Original notes"
        ))
        XCTAssertEqual(cleared["values"], ["date": .null])
        XCTAssertEqual(try featureParseDateCell(start: "2026-10-02", end: "2026-10-01"), ["start": "2026-10-01", "end": "2026-10-02"])
        XCTAssertEqual(try featureParseDateCell(start: "", end: nil), .null)
        XCTAssertThrowsError(try featureParseDateCell(start: "10/31/2026", end: nil))
        XCTAssertThrowsError(try featureParseMultiCell(Array(repeating: "x", count: 51)))
        XCTAssertThrowsError(try featureParseThreadsCell(Array(repeating: "id", count: 51)))
        XCTAssertThrowsError(try featureDatabaseRowValueUpdate(
            baseline: original, columns: columns, drafts: drafts(for: original),
            structured: ["name": "stolen"], body: "Original notes"
        ))
    }

    func testViewSaveOmitsCodeAndCustomHTML() throws {
        let saved = try featureViewSaveOperation(from: [
            "id": "board-1", "name": "Board", "type": "board",
            "config": ["filters": [["column": "status", "op": "is", "value": "todo"]], "match": "all", "sorts": [["column": "name", "dir": "asc"]], "group": "status"],
        ])
        XCTAssertEqual(saved["op"], "view.save")
        XCTAssertEqual(Set(saved["view"].objectValue.keys), ["id", "name", "type", "config"])
        XCTAssertEqual(Set(saved["view"]["config"].objectValue.keys), ["filters", "match", "sorts", "group"])
        XCTAssertThrowsError(try featureViewSaveOperation(from: [
            "name": "Widget", "type": "table", "config": ["filters": [], "match": "all", "sorts": [], "code": "alert(1)"],
        ]))
        XCTAssertThrowsError(try featureViewSaveOperation(from: [
            "name": "Custom", "type": "custom", "config": ["filters": [], "match": "all", "sorts": [], "componentId": "comp-1"],
        ]))
        XCTAssertTrue(featureIsUnsupportedCustomView(["type": "custom", "config": ["componentId": "comp-1"]]))
        XCTAssertTrue(featureCanHostRegisteredCustomView(["type": "custom", "config": ["componentId": "comp-1"]]))
        XCTAssertTrue(featureIsUnsupportedCustomBlock(["type": "component", "componentId": "comp-1", "html": "<script>"]))
        XCTAssertFalse(featureCanHostRegisteredComponent(["type": "component", "componentId": "comp-1", "html": "<script>"]))
        XCTAssertTrue(featureUnsupportedCustomReason(["type": "custom"]).contains("WebView"))
    }

    func testColumnAndOptionOpsNeverSupplyClientIdsOrUnknownKeys() throws {
        let add = try featureColumnAddOperation(name: "Due", type: "date")
        XCTAssertEqual(add["op"], "column.add")
        XCTAssertNil(add["column"].objectValue["id"])
        XCTAssertEqual(add["column"]["type"], "date")
        XCTAssertThrowsError(try featureColumnUpdateOperation(id: "name", patch: ["builtin": true]))
        let option = try featureOptionAddOperation(columnId: "tags", value: "three", color: "blue")
        XCTAssertEqual(option, ["op": "option.add", "id": "tags", "option": ["value": "three", "color": "blue"]])
        XCTAssertThrowsError(try featureOptionAddOperation(columnId: "tags", value: "x", color: "pink"))
    }

    func testFilterSortAndBoardPreserveRowIdentity() {
        let rows: [JSONValue] = [
            original,
            ["id": "row-2", "rev": 3, "position": 1, "values": ["name": "Later", "status": "doing", "count": 1, "checked": false, "date": .null, "tags": [], "threads": []]],
            ["id": "row-3", "rev": 2, "position": 2, "values": ["name": "Waiting", "status": "todo", "count": 20, "checked": false, "date": ["start": "2026-12-01"], "tags": ["one"], "threads": ["thread-z"]]],
        ]
        let filtered = featureApplyView(rows: rows, columns: columns, config: [
            "filters": [["column": "status", "op": "is", "value": "todo"]],
            "match": "all",
            "sorts": [["column": "count", "dir": "desc"]],
        ])
        XCTAssertEqual(filtered.map(\.id), ["row-3", "row-1"])
        let groups = featureBoardGroups(rows: rows, columns: columns, config: ["group": "status", "filters": [], "match": "all", "sorts": []])
        XCTAssertEqual(groups.map(\.key), ["todo", "doing"])
        XCTAssertEqual(groups[0].rows.map(\.id), ["row-1", "row-3"])
        let move = try? featureBoardMoveOperation(row: original, groupColumn: columns.first { $0.id == "status" }!, key: "doing")
        XCTAssertEqual(move?["values"], ["status": "doing"])
        XCTAssertEqual(move?["expectRev"], 7)
        XCTAssertThrowsError(try featureBoardMoveOperation(row: ["id": "row-1"], groupColumn: columns.first { $0.id == "status" }!, key: "doing"))
    }

    func testDatabaseModelWritesViewAndStructuredRowAgainstLoadedRevision() async throws {
        let database: JSONValue = [
            "id": "db-1", "workspaceId": "workspace-1", "title": "Tasks", "role": "tasks",
            "revision": 5, "columns": .array(columns), "views": [[
                "id": "tasks-board", "name": "Board", "type": "board",
                "config": ["filters": [], "match": "all", "sorts": [], "group": "status"],
            ]],
            "rows": [original], "opaque": ["keep": true],
        ]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/databases/db-1" {
                return .json(["database": database])
            }
            if request.path == "/api/databases/db-1/edits" {
                XCTAssertEqual(request.body["revision"], 5)
                let op = request.body["ops"].arrayValue[0]
                XCTAssertEqual(op["op"], "view.save")
                XCTAssertNil(op["view"]["config"].objectValue["componentId"])
                var next = database
                next["revision"] = 6
                next["views"] = [op["view"].merging(["id": "tasks-board"])]
                return .json(["database": next, "changes": ["rejected": []]])
            }
            if request.path.contains("task-activity") { return .json([:]) }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeatureDatabaseModel(api: transport.api, databaseId: "db-1", workspaceId: "workspace-1")
        await model.refresh()
        XCTAssertEqual(model.revision, 5)
        XCTAssertEqual(model.database["opaque"], ["keep": true])
        model.viewDraft["name"] = "Status board"
        XCTAssertTrue(model.viewDirty)
        let result0 = await model.saveViewDraft()
        XCTAssertTrue(result0)
        let edit = try XCTUnwrap(transport.requests.first { $0.path.hasSuffix("/edits") })
        XCTAssertEqual(edit.body["revision"], 5)
    }

    func testRemoteViewChangeCannotRebaseUnsavedViewRevision() async {
        let view: JSONValue = ["id": "table", "name": "Table", "type": "table", "config": featureEmptyViewConfig()]
        let database: JSONValue = ["id": "db-1", "workspaceId": "workspace-1", "revision": 5, "columns": [], "views": [view], "rows": []]
        let transport = AppContractTransport { request, requests in
            if request.method == "GET" {
                let reads = requests.filter { $0.method == "GET" }.count
                return .json(database.merging(["revision": .number(reads == 1 ? 5 : 6), "views": .array([reads == 1 ? view : view.merging(["name": "Changed remotely"])])]))
            }
            return .json(["error": "Revision conflict"], status: 409)
        }
        defer { transport.close() }
        let model = FeatureDatabaseModel(api: transport.api, databaseId: "db-1", workspaceId: "workspace-1")
        await model.refresh(); model.viewDraft["name"] = "My draft"; await model.refresh()
        XCTAssertEqual(model.revision, 6); XCTAssertEqual(model.viewRevision, 5)
        XCTAssertEqual(model.viewDraft["name"], "My draft"); XCTAssertTrue(model.viewDirty)
        let saved = await model.saveViewDraft(); XCTAssertFalse(saved)
        XCTAssertEqual(transport.requests.last?.body["revision"], 5)
    }
    func testAllTasksIncludesCustomSourceStatusLabels() async {
        let transport = AppContractTransport { _, _ in .json(["views": [], "viewsRevision": 0, "rows": [], "sources": [["databaseId": "db", "workspaceId": "workspace", "statuses": [["value": "blocked", "label": "Blocked by dependency"]]]]]) }
        defer { transport.close() }
        let model = FeatureAllTasksModel(api: transport.api); await model.refresh()
        XCTAssertTrue(model.columns.first { $0.id == "status" }!["options"].arrayValue.contains { $0["value"] == "blocked" && $0["label"] == "Blocked by dependency" })
    }
    func testDatabaseEditConflictLeavesDirtyViewDraftOnOriginalRevision() async {
        let database: JSONValue = [
            "id": "db-1", "workspaceId": "workspace-1", "title": "Tasks",
            "revision": 5, "columns": .array(columns), "views": [[
                "id": "table", "name": "Table", "type": "table", "config": featureEmptyViewConfig(),
            ]],
            "rows": [original],
        ]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/databases/db-1" { return .json(["database": database]) }
            if request.path.hasSuffix("/edits") {
                return .json(["error": ["code": "stale_revision", "message": "Revision conflict. Reload and try again."]], status: 409)
            }
            return .json([:])
        }
        defer { transport.close() }
        let model = FeatureDatabaseModel(api: transport.api, databaseId: "db-1", workspaceId: "workspace-1")
        await model.refresh()
        model.viewDraft["name"] = "Kept draft"
        let result1 = await model.saveViewDraft()
        XCTAssertFalse(result1)
        XCTAssertEqual(model.revision, 5)
        XCTAssertEqual(model.viewDraft["name"], "Kept draft")
        XCTAssertTrue(model.viewDirty)
        await model.refresh()
        XCTAssertEqual(model.viewDraft["name"], "Kept draft")
        XCTAssertEqual(model.revision, 5)
    }

    func testAllTasksRowWriteUsesSourceDatabaseRevisionAndRowExpectRev() async throws {
        let row = original.merging(["databaseId": "db-1"])
        let payload: JSONValue = [
            "sources": [["workspaceId": "workspace-1", "workspaceName": "Notes", "databaseId": "db-1", "revision": 11, "statuses": []]],
            "rows": [["databaseId": "db-1", "row": original]],
            "views": [], "viewsRevision": 1,
        ]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/spaces-home/all-tasks" { return .json(payload) }
            if request.path == "/api/databases/db-1/edits" {
                XCTAssertEqual(request.body["revision"], 11)
                XCTAssertEqual(request.body["ops"].arrayValue[0]["expectRev"], 7)
                XCTAssertEqual(request.body["ops"].arrayValue[0]["values"], ["date": ["start": "2026-11-01"]])
                var updated = self.original
                updated["rev"] = 8
                updated["values"]["date"] = ["start": "2026-11-01"]
                return .json(["database": ["id": "db-1", "revision": 12, "rows": [updated], "columns": [], "views": []], "changes": ["rejected": []]])
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeatureAllTasksModel(api: transport.api)
        await model.refresh()
        let operation = try XCTUnwrap(featureDatabaseRowValueUpdate(
            baseline: row, columns: columns, drafts: drafts(for: row),
            structured: ["date": ["start": "2026-11-01"]], body: row["body"].stringValue
        ))
        let result2 = await model.updateSourceRow(databaseId: "db-1", operation: operation)
        XCTAssertTrue(result2)
        XCTAssertEqual(featureAllTasksSource(for: "db-1", in: model.payload)?["revision"], 12)
    }

    func testAllTasksStripsComputedWorkspaceFromSourceWrites() {
        let operation: JSONValue = [
            "op": "row.update", "id": "row-1", "expectRev": 7,
            "values": ["task": "Renamed", "workspace": "workspace-2"],
        ]
        XCTAssertEqual(featureAllTasksStrippedRowOperation(operation)["values"], ["task": "Renamed"])
        XCTAssertEqual(
            featureAllTasksStrippedRowOperation(["op": "row.update", "id": "row-1", "expectRev": 7, "values": ["workspace": "workspace-2"]]),
            .null
        )
    }

    func testEffectiveBoardUsesFirstSelectWhenGroupMissing() {
        let view: JSONValue = ["id": "board", "type": "board", "config": featureEmptyViewConfig()]
        XCTAssertEqual(featureEffectiveViewConfig(view, columns: columns)["group"], "status")
        XCTAssertEqual(featureRetainLoadedRevision(current: 9, baseline: 4, dirty: true), 4)
        XCTAssertEqual(featureRetainLoadedRevision(current: 9, baseline: 4, dirty: false), 9)
    }

    func testSelectingCleanViewsUpdatesDraftAndDirtyViewIsPreserved() async {
        let table: JSONValue = ["id": "table", "name": "Table", "type": "table", "config": featureEmptyViewConfig()]
        let board: JSONValue = [
            "id": "board", "name": "Board", "type": "board",
            "config": ["filters": [], "match": "all", "sorts": [], "group": "status"],
        ]
        let database: JSONValue = [
            "id": "db-1", "workspaceId": "workspace-1", "title": "Notes",
            "revision": 5, "columns": .array(columns), "views": [table, board], "rows": [original],
        ]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/databases/db-1" { return .json(["database": database]) }
            return .json(["error": "no write"], status: 500)
        }
        defer { transport.close() }
        let model = FeatureDatabaseModel(api: transport.api, databaseId: "db-1", workspaceId: "workspace-1")
        await model.refresh()
        XCTAssertEqual(model.selectedViewId, "table")
        XCTAssertEqual(model.viewDraft.id, "table")
        XCTAssertFalse(model.viewDirty)
        model.selectView("board")
        XCTAssertEqual(model.selectedViewId, "board")
        XCTAssertEqual(model.viewDraft.id, "board")
        XCTAssertEqual(model.viewDraft["name"], "Board")
        XCTAssertFalse(model.viewDirty)
        model.viewDraft["name"] = "Dirty board"
        XCTAssertTrue(model.viewDirty)
        model.selectView("table")
        XCTAssertEqual(model.selectedViewId, "board")
        XCTAssertEqual(model.viewDraft["name"], "Dirty board")
        XCTAssertTrue(model.viewDirty)
    }

    func testRowWriteKeepsDirtyViewDraftAndRequiresDatabaseResult() async throws {
        let view: JSONValue = ["id": "table", "name": "Table", "type": "table", "config": featureEmptyViewConfig()]
        var database: JSONValue = [
            "id": "db-1", "workspaceId": "workspace-1", "title": "Notes",
            "revision": 5, "columns": .array(columns), "views": [view], "rows": [original],
        ]
        var missingDatabase = false
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/databases/db-1" { return .json(["database": database]) }
            if request.path == "/api/databases/db-1/edits" {
                if missingDatabase {
                    return .json(["changes": ["rejected": []]])
                }
                XCTAssertEqual(request.body["ops"].arrayValue[0]["op"], "row.update")
                var next = database
                next["revision"] = 6
                return .json(["database": next, "changes": ["rejected": []]])
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeatureDatabaseModel(api: transport.api, databaseId: "db-1", workspaceId: "workspace-1")
        await model.refresh()
        model.viewDraft["name"] = "Kept draft"
        XCTAssertTrue(model.viewDirty)
        let operation = try XCTUnwrap(featureDatabaseRowValueUpdate(
            baseline: original, columns: columns, drafts: drafts(for: original),
            structured: ["date": ["start": "2026-11-01"]], body: original["body"].stringValue
        ))
        let result3 = await model.updateRow(operation)
        XCTAssertTrue(result3)
        XCTAssertEqual(model.revision, 6)
        XCTAssertEqual(model.viewDraft["name"], "Kept draft")
        XCTAssertTrue(model.viewDirty)
        missingDatabase = true
        model.viewDraft["name"] = "Still kept"
        let result4 = await model.saveViewDraft()
        XCTAssertFalse(result4)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.viewDraft["name"], "Still kept")
        XCTAssertEqual(model.revision, 6)
    }

    func testAllTasksSelectingCleanViewsAndPreservingDirty() async {
        let board: JSONValue = [
            "id": "tasks-board", "name": "Board", "type": "board",
            "config": ["filters": [], "match": "all", "sorts": [], "group": "status"],
        ]
        let table: JSONValue = ["id": "tasks-table", "name": "Table", "type": "table", "config": featureEmptyViewConfig()]
        let payload: JSONValue = [
            "sources": [["workspaceId": "workspace-1", "workspaceName": "Notes", "databaseId": "db-1", "revision": 11]],
            "rows": [], "views": [board, table], "viewsRevision": 2,
        ]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/spaces-home/all-tasks" { return .json(payload) }
            return .json(["error": "no write"], status: 500)
        }
        defer { transport.close() }
        let model = FeatureAllTasksModel(api: transport.api)
        await model.refresh()
        XCTAssertEqual(model.selectedViewId, "tasks-board")
        XCTAssertFalse(model.viewDirty)
        model.selectView("tasks-table")
        XCTAssertEqual(model.selectedViewId, "tasks-table")
        XCTAssertEqual(model.viewDraft.id, "tasks-table")
        XCTAssertFalse(model.viewDirty)
        model.viewDraft["name"] = "Dirty table"
        XCTAssertTrue(model.viewDirty)
        model.selectView("tasks-board")
        XCTAssertEqual(model.selectedViewId, "tasks-table")
        XCTAssertEqual(model.viewDraft["name"], "Dirty table")
        XCTAssertEqual(model.viewRevision, 2)
    }

    func testAllTasksViewSaveRequiresViewsResultAndIgnoresWhileSaving() async {
        let view: JSONValue = ["id": "tasks-board", "name": "Board", "type": "board", "config": featureEmptyViewConfig()]
        let payload: JSONValue = [
            "sources": [["workspaceId": "workspace-1", "workspaceName": "Notes", "databaseId": "db-1", "revision": 11]],
            "rows": [["databaseId": "db-1", "row": original]],
            "views": [view], "viewsRevision": 2,
        ]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/spaces-home/all-tasks" { return .json(payload) }
            if request.path == "/api/spaces-home/all-tasks/views" {
                return .json(["ok": true])
            }
            if request.path.hasSuffix("/edits") {
                return .json(["error": "should not write"], status: 500)
            }
            return .json(["error": "unexpected"], status: 500)
        }
        defer { transport.close() }
        let model = FeatureAllTasksModel(api: transport.api)
        await model.refresh()
        model.viewDraft["name"] = "My board"
        let result5 = await model.saveViewDraft()
        XCTAssertFalse(result5)
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.viewRevision, 2)
        XCTAssertEqual(model.viewDraft["name"], "My board")
        model.saving = true
        let operation: JSONValue = ["op": "row.update", "id": "row-1", "expectRev": 7, "values": ["task": "Renamed"]]
        let result6 = await model.updateSourceRow(databaseId: "db-1", operation: operation)
        XCTAssertFalse(result6)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/edits") }.count, 0)
    }
}
