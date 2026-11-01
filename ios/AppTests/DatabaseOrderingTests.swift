import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class DatabaseOrderingTests: XCTestCase {
    private static let view: JSONValue = ["id": "view-1", "name": "Board", "type": "board", "position": 0,
        "config": ["filters": [], "match": "all", "sorts": [], "group": "status", "futureSetting": ["keep": true]]]
    private static let database: JSONValue = [
        "id": "database-1", "workspaceId": "workspace-1", "title": "Work", "revision": 7, "future": ["preserve": true],
        "columns": [["id": "title", "name": "Title", "type": "text"], ["id": "status", "name": "Status", "type": "select", "options": [["value": "todo", "color": "blue"], ["value": "done"]]], ["id": "opaque", "name": "Opaque", "type": "future", "editable": false, "extra": ["keep": 4]]],
        "views": .array([view]),
        "rows": [
            ["id": "row-1", "position": 0, "rev": 5, "values": ["title": "One", "status": "todo", "opaque": ["future": "untouched"]], "edited": ["title": 30]],
            ["id": "row-2", "position": 1, "rev": 6, "values": ["title": "Two", "status": "todo"], "body": "Notes"],
            ["id": "row-3", "position": 2, "rev": 7, "values": ["title": "Three", "status": "done"]]
        ]
    ]
    private static let workspace: JSONValue = ["workspace": ["id": "workspace-1"], "nodes": [], "trees": [], "edges": []]
    private static var movedRows: JSONValue {
        database.merging(["revision": 8, "rows": .array([
            database["rows"].arrayValue[1].merging(["position": 0, "rev": 8]),
            database["rows"].arrayValue[0].merging(["position": 1, "rev": 8]),
            database["rows"].arrayValue[2]
        ])])
    }
    private func model(_ transport: AppContractTransport) -> FeatureDatabaseModel {
        FeatureDatabaseModel(api: transport.api, databaseId: "database-1", workspaceId: "workspace-1")
    }
    private func cleanup(_ transport: AppContractTransport) {
        UserDefaults.standard.removeObject(forKey: "michi.database.order.\(transport.api.baseURL.absoluteString).workspace-1.database-1")
        transport.close()
    }
    private static func readResponse(_ request: AppContractRequest, database: JSONValue? = nil) -> AppContractResponse {
        if request.path == "/api/workspaces/workspace-1" { return .json(workspace) }
        if request.path == "/api/databases/database-1" { return .json(database ?? Self.database) }
        return .json(["error": "Unexpected request"], status: 404)
    }

    func testColumnReorderKeepsTextRowTitleLikeWeb() {
        let row: JSONValue = ["values": ["title": "Native Home", "priority": 1, "status": "todo"]]
        let columns: [JSONValue] = [["id": "priority", "type": "number"], ["id": "status", "type": "select"], ["id": "title", "type": "text"]]
        XCTAssertEqual(featureRowTitle(row, columns: columns, isTasks: false), "Native Home")
        XCTAssertEqual(featureRowTitle(row, columns: [columns[0]], isTasks: false), "1")
    }

    func testRowMovesUseActualNativeShapeAndDoNotResubmitValues() throws {
        let up = try XCTUnwrap(DatabaseOrdering.rowMove(database: Self.database, view: Self.view, visibleIDs: ["row-1", "row-2"], id: "row-2", direction: .up))
        XCTAssertEqual(up, ["op": "row.move", "id": "row-2", "after": .null])
        let down = try XCTUnwrap(DatabaseOrdering.rowMove(database: Self.database, view: Self.view, visibleIDs: ["row-1", "row-2"], id: "row-1", direction: .down))
        XCTAssertEqual(down, ["op": "row.move", "id": "row-1", "after": "row-2"])
        XCTAssertNil(up.objectValue["values"]); XCTAssertNil(up.objectValue["expectRev"])
        XCTAssertNil(try DatabaseOrdering.rowMove(database: Self.database, view: Self.view, visibleIDs: ["row-1", "row-2"], id: "row-1", direction: .up))
    }

    func testFilteredBoardTopUsesGlobalPredecessorAndKeepsHiddenRows() throws {
        let ids = ["hidden-before", "visible-a", "hidden-between", "visible-b", "hidden-after"]
        let rows = ids.enumerated().map { index, id -> JSONValue in ["id": .string(id), "position": .number(Double(index))] }
        let db = Self.database.merging(["rows": .array(rows)])
        let up = try XCTUnwrap(DatabaseOrdering.rowMove(database: db, view: Self.view, visibleIDs: ["visible-a", "visible-b"], id: "visible-b", direction: .up))
        XCTAssertEqual(up["after"], "hidden-before")
        XCTAssertEqual(try DatabaseOrdering.expectedIDs(database: db, operation: up), ["hidden-before", "visible-b", "visible-a", "hidden-between", "hidden-after"])
        let down = try XCTUnwrap(DatabaseOrdering.rowMove(database: db, view: Self.view, visibleIDs: ["visible-a", "visible-b"], id: "visible-a", direction: .down))
        XCTAssertEqual(down["after"], "visible-b")
        XCTAssertEqual(try DatabaseOrdering.expectedIDs(database: db, operation: down).filter { $0.hasPrefix("hidden") }, ["hidden-before", "hidden-between", "hidden-after"])
    }

    func testActiveSortPreventsRowMoveButMissingSortColumnDoesNot() throws {
        var view = Self.view; view["config"]["sorts"] = [["column": "title", "dir": "desc"]]
        XCTAssertThrowsError(try DatabaseOrdering.rowMove(database: Self.database, view: view, visibleIDs: ["row-1", "row-2"], id: "row-2", direction: .up))
        view["config"]["sorts"] = [["column": "removed-column", "dir": "asc"]]
        XCTAssertNotNil(try DatabaseOrdering.rowMove(database: Self.database, view: view, visibleIDs: ["row-1", "row-2"], id: "row-2", direction: .up))
        XCTAssertNotNil(try DatabaseOrdering.columnMove(database: Self.database, id: "status", direction: .up))
    }

    func testMissingOrRepeatedTargetsAndAnchorsAreRejected() {
        XCTAssertThrowsError(try DatabaseOrdering.rowMove(database: Self.database, view: Self.view, visibleIDs: ["foreign", "row-1"], id: "row-1", direction: .up))
        XCTAssertThrowsError(try DatabaseOrdering.rowMove(database: Self.database, view: Self.view, visibleIDs: ["row-1", "row-1"], id: "row-1", direction: .down))
        XCTAssertThrowsError(try DatabaseOrdering.columnMove(database: Self.database, id: "foreign", direction: .up))
        XCTAssertThrowsError(try DatabaseOrdering.expectedIDs(database: Self.database, operation: ["op": "row.move", "id": "row-1", "after": "foreign"]))
        XCTAssertThrowsError(try DatabaseOrdering.expectedIDs(database: Self.database, operation: ["op": "view.move", "id": "view-1", "after": .null]))
    }

    func testThreadsMergedAndReadOnlyDatabasesCannotBeReordered() {
        for patch: [String: JSONValue] in [["kind": "threads"], ["merged": true], ["merged": ["source": "tasks"]], ["readOnly": true], ["editable": false]] {
            let db = Self.database.merging(patch)
            XCTAssertThrowsError(try DatabaseOrdering.rowMove(database: db, view: Self.view, visibleIDs: ["row-1", "row-2"], id: "row-2", direction: .up))
            XCTAssertThrowsError(try DatabaseOrdering.columnMove(database: db, id: "status", direction: .up))
        }
        XCTAssertNotNil(try? DatabaseOrdering.columnMove(database: Self.database.merging(["role": "tasks"]), id: "status", direction: .up))
    }

    func testColumnMoveKeepsOpaqueColumnAndViewDataOutOfRequest() throws {
        let before = Self.database
        let op = try XCTUnwrap(DatabaseOrdering.columnMove(database: before, id: "opaque", direction: .up))
        XCTAssertEqual(op, ["op": "column.move", "id": "opaque", "after": "title"])
        XCTAssertEqual(try DatabaseOrdering.expectedIDs(database: before, operation: op), ["title", "opaque", "status"])
        XCTAssertEqual(before, Self.database)
        XCTAssertEqual(Set(op.objectValue.keys), ["op", "id", "after"])
    }

    func testOpeningOrderingIsReadOnlyAndLoadsActualBoardGroups() async {
        let transport = AppContractTransport { request, _ in Self.readResponse(request) }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        XCTAssertEqual(model.orderingAccess, true); XCTAssertNil(model.error)
        XCTAssertEqual(model.orderingRowGroups.first { $0.key == "todo" }?.rows.map(\.id), ["row-1", "row-2"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testMoveUsesFreshWorkspaceAndOriginalDatabaseRevision() async throws {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .json(["database": Self.movedRows, "changes": ["rejected": []]]) }
            return Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let group = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "todo" })
        let moved = await model.moveOrderedRow("row-2", in: group, direction: .up)
        XCTAssertTrue(moved); XCTAssertNil(model.orderingPending); XCTAssertEqual(model.revision, 8)
        XCTAssertEqual(transport.requests.last?.body, ["revision": 7, "ops": [["op": "row.move", "id": "row-2", "after": .null]]])
        XCTAssertEqual(Array(transport.requests.suffix(3)).map(\.path), ["/api/workspaces/workspace-1", "/api/databases/database-1", "/api/databases/database-1/edits"])
        XCTAssertEqual(model.database["future"], Self.database["future"])
        XCTAssertEqual(model.rows.first { $0.id == "row-1" }?["values"]["opaque"], ["future": "untouched"])
    }

    func testOrderingPreservesDirtyViewDraftAndItsOriginalRevision() async {
        let columns = Self.database["columns"].arrayValue
        let moved = Self.database.merging(["revision": 8, "columns": .array([columns[1], columns[0], columns[2]])])
        let transport = AppContractTransport { request, _ in
            request.method == "POST" ? .json(["database": moved, "changes": ["rejected": []]]) : Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        model.viewDraft["config"]["filters"] = [["column": "title", "op": "contains", "value": "One"]]
        let draft = model.viewDraft
        let saved = await model.moveOrderedColumn("status", direction: .up)
        XCTAssertTrue(saved); XCTAssertEqual(model.viewDraft, draft); XCTAssertEqual(model.viewRevision, 7); XCTAssertTrue(model.viewDirty)
        XCTAssertEqual(model.views, Self.database["views"].arrayValue)
        XCTAssertEqual(transport.requests.last?.body["ops"], [["op": "column.move", "id": "status", "after": .null]])
    }

    func testChangedDatabaseRevisionStopsBeforePostAndShowsLatestOrder() async {
        let transport = AppContractTransport { request, requests in
            if request.path == "/api/databases/database-1", requests.filter({ $0.path == request.path }).count > 1 { return .json(Self.database.merging(["revision": 8])) }
            return Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let moved = await model.moveOrderedColumn("status", direction: .up)
        XCTAssertFalse(moved); XCTAssertEqual(model.revision, 8); XCTAssertNotNil(model.error)
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

    func testArchivedWorkspaceBlocksMoveAfterPreviouslySuccessfulRead() async {
        let transport = AppContractTransport { request, requests in
            if request.path == "/api/workspaces/workspace-1", requests.filter({ $0.path == request.path }).count > 1 {
                return .json(["workspace": ["id": "workspace-1", "archived_at": 10]])
            }
            return Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let moved = await model.moveOrderedColumn("status", direction: .up)
        XCTAssertFalse(moved); XCTAssertEqual(model.orderingAccess, false)
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

    func testForeignDatabaseResponseNeverBecomesMoveTarget() async {
        let transport = AppContractTransport { request, _ in Self.readResponse(request, database: Self.database.merging(["workspaceId": "foreign"])) }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        XCTAssertTrue(model.database.isNull); XCTAssertNotNil(model.error)
        let moved = await model.moveOrderedColumn("status", direction: .up)
        XCTAssertFalse(moved); XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

    func testUnknownMoveSurvivesReopenAndZeroChangeReadDoesNotReplay() async throws {
        var committed = false
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            return Self.readResponse(request, database: committed ? Self.movedRows : Self.database)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let group = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "todo" })
        let moved = await model.moveOrderedRow("row-2", in: group, direction: .up)
        XCTAssertFalse(moved); let pending = try XCTUnwrap(model.orderingPending)
        let reopened = self.model(transport); await reopened.refreshOrdering()
        XCTAssertEqual(reopened.orderingPending, pending); XCTAssertTrue(reopened.orderingDisabled)
        let again = await reopened.moveOrderedColumn("status", direction: .up); XCTAssertFalse(again)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        committed = true; await reopened.refreshOrdering()
        XCTAssertNil(reopened.orderingPending); XCTAssertEqual(reopened.revision, 8)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testUnknownMoveCanOnlyBeForgottenExplicitlyWithoutNetworkMutation() async {
        let transport = AppContractTransport { request, _ in request.method == "POST" ? .failure(.networkConnectionLost) : Self.readResponse(request) }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        _ = await model.moveOrderedColumn("status", direction: .up)
        XCTAssertNotNil(model.orderingPending)
        let count = transport.requests.count
        model.forgetDatabaseOrdering()
        XCTAssertNil(model.orderingPending); XCTAssertEqual(transport.requests.count, count)
        XCTAssertTrue(model.orderingNotice?.contains("may still finish") == true)
    }

    func testMalformedAcknowledgmentKeepsPendingMoveAndKnown409DoesNot() async {
        for response: AppContractResponse in [.json(["database": Self.database, "changes": ["rejected": []]]), .json(["error": "Stale"], status: 409)] {
            let transport = AppContractTransport { request, _ in request.method == "POST" ? response : Self.readResponse(request) }
            let model = self.model(transport); await model.refreshOrdering()
            let moved = await model.moveOrderedColumn("status", direction: .up)
            XCTAssertFalse(moved); XCTAssertNotNil(model.error)
            if case .json(_, let status) = response { XCTAssertEqual(model.orderingPending == nil, status == 409) }
            XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
            cleanup(transport)
        }
    }

    // MARK: Drag ordering

    private static var hiddenRows: JSONValue {
        let ids = ["hidden-before", "visible-a", "hidden-between", "visible-b", "hidden-after"]
        return database.merging(["rows": .array(ids.enumerated().map { index, id -> JSONValue in ["id": .string(id), "position": .number(Double(index))] })])
    }
    /// row-1 moved from "todo" to the top of "done": [row-2, row-1, row-3].
    private static func transferred(status: JSONValue) -> JSONValue {
        let rows = database["rows"].arrayValue
        var one = rows[0].merging(["position": 1, "rev": 8]); one["values"]["status"] = status
        return database.merging(["revision": 8, "rows": .array([rows[1].merging(["position": 0]), one, rows[2]])])
    }
    private static func transfer(_ row: JSONValue, from source: String?, to target: String?, targetIDs: [String], index: Int,
                                 view: JSONValue = DatabaseOrderingTests.view, database: JSONValue = DatabaseOrderingTests.database) throws -> DatabaseOrderingTransfer? {
        try DatabaseOrdering.boardTransfer(database: database, view: view, row: row, sourceKey: source, targetKey: target, targetIDs: targetIDs, index: index)
    }
    private func posts(_ transport: AppContractTransport) -> [JSONValue] { transport.requests.filter { $0.method == "POST" }.map(\.body) }

    func testListMoveTranslatesOnMoveOffsetsAndRefusesSelfMultiAndStaleDrops() throws {
        XCTAssertEqual(try DatabaseOrdering.listMove(source: [0], destination: 3, count: 3).map { [$0.from, $0.to] }, [0, 2])
        XCTAssertEqual(try DatabaseOrdering.listMove(source: [2], destination: 0, count: 3).map { [$0.from, $0.to] }, [2, 0])
        XCTAssertNil(try DatabaseOrdering.listMove(source: [1], destination: 1, count: 3))
        XCTAssertNil(try DatabaseOrdering.listMove(source: [1], destination: 2, count: 3))
        XCTAssertThrowsError(try DatabaseOrdering.listMove(source: [0, 1], destination: 3, count: 3))
        XCTAssertThrowsError(try DatabaseOrdering.listMove(source: [3], destination: 0, count: 3))
        XCTAssertThrowsError(try DatabaseOrdering.listMove(source: [0], destination: 4, count: 3))
    }

    func testRowPlacementMatchesArrowMovesAndRefusesNonCanonicalSortedOrOutOfRangeDrops() throws {
        let db = Self.hiddenRows, visible = ["visible-a", "visible-b"]
        let top = try XCTUnwrap(DatabaseOrdering.rowPlacement(database: db, view: Self.view, visibleIDs: visible, id: "visible-b", to: 0))
        XCTAssertEqual(top, try DatabaseOrdering.rowMove(database: db, view: Self.view, visibleIDs: visible, id: "visible-b", direction: .up))
        XCTAssertEqual(top["after"], "hidden-before")
        XCTAssertEqual(try DatabaseOrdering.rowPlacement(database: db, view: Self.view, visibleIDs: visible, id: "visible-a", to: 1),
                       ["op": "row.move", "id": "visible-a", "after": "visible-b"])
        XCTAssertNil(try DatabaseOrdering.rowPlacement(database: db, view: Self.view, visibleIDs: visible, id: "visible-a", to: 0))
        XCTAssertThrowsError(try DatabaseOrdering.rowPlacement(database: db, view: Self.view, visibleIDs: visible, id: "visible-a", to: 2))
        // A list drawn out of saved order would make the drop position mean a different place.
        XCTAssertThrowsError(try DatabaseOrdering.rowPlacement(database: db, view: Self.view, visibleIDs: ["visible-b", "visible-a"], id: "visible-a", to: 0))
        var sorted = Self.view; sorted["config"]["sorts"] = [["column": "title", "dir": "asc"]]
        XCTAssertThrowsError(try DatabaseOrdering.rowPlacement(database: db, view: sorted, visibleIDs: visible, id: "visible-b", to: 0))
        // Ids compare by exact bytes: a canonically equivalent spelling is another row.
        let composed = Self.database.merging(["rows": [["id": "caf\u{E9}", "position": 0], ["id": "next", "position": 1]]])
        XCTAssertFalse(DatabaseOrdering.exact("caf\u{E9}", "cafe\u{301}"))
        XCTAssertThrowsError(try DatabaseOrdering.rowPlacement(database: composed, view: Self.view, visibleIDs: ["caf\u{E9}", "next"], id: "cafe\u{301}", to: 1))
    }

    func testColumnPlacementUsesDatabaseColumnOrderAndRejectsSelfOrOutOfRangeDrops() throws {
        XCTAssertEqual(try DatabaseOrdering.columnPlacement(database: Self.database, id: "opaque", to: 0), ["op": "column.move", "id": "opaque", "after": .null])
        XCTAssertEqual(try DatabaseOrdering.columnPlacement(database: Self.database, id: "title", to: 2), ["op": "column.move", "id": "title", "after": "opaque"])
        XCTAssertNil(try DatabaseOrdering.columnPlacement(database: Self.database, id: "status", to: 1))
        XCTAssertThrowsError(try DatabaseOrdering.columnPlacement(database: Self.database, id: "status", to: 3))
        XCTAssertThrowsError(try DatabaseOrdering.columnPlacement(database: Self.database.merging(["kind": "threads"]), id: "status", to: 0))
        XCTAssertThrowsError(try DatabaseOrdering.expectedIDs(database: Self.database, operations: [
            ["op": "column.move", "id": "status", "after": .null], ["op": "row.move", "id": "row-1", "after": .null]]))
    }

    func testBoardTransferBatchesGroupValueAndPositionOnlyWhenOrderChanges() throws {
        let rows = Self.database["rows"].arrayValue
        let top = try XCTUnwrap(Self.transfer(rows[0], from: "todo", to: "done", targetIDs: ["row-3"], index: 0))
        XCTAssertEqual(top.operations, [["op": "row.update", "id": "row-1", "expectRev": 5, "values": ["status": "done"]],
                                        ["op": "row.move", "id": "row-1", "after": "row-2"]])
        XCTAssertEqual(top.expectedValues, [["row": "row-1", "column": "status", "value": "done"]])
        XCTAssertEqual(try DatabaseOrdering.expectedIDs(database: Self.database, operations: top.operations), ["row-2", "row-1", "row-3"])
        // Already in that place, an empty group, an active sort, or a card already
        // in the target (multi-select): only the value changes.
        XCTAssertEqual(try Self.transfer(rows[1], from: "todo", to: "done", targetIDs: ["row-3"], index: 0)?.operations.map { $0["op"] }, ["row.update"])
        XCTAssertEqual(try Self.transfer(rows[2], from: "done", to: nil, targetIDs: [], index: 0)?.operations.map { $0["op"] }, ["row.update"])
        var sorted = Self.view; sorted["config"]["sorts"] = [["column": "title", "dir": "asc"]]
        XCTAssertEqual(try Self.transfer(rows[0], from: "todo", to: "done", targetIDs: ["row-3"], index: 0, view: sorted)?.operations.map { $0["op"] }, ["row.update"])
        XCTAssertEqual(try Self.transfer(rows[0], from: "todo", to: "done", targetIDs: ["row-3", "row-1"], index: 0)?.operations.map { $0["op"] }, ["row.update"])
        XCTAssertNil(try Self.transfer(rows[0], from: "todo", to: "todo", targetIDs: ["row-1", "row-2"], index: 1))
        let locked = Self.database.merging(["columns": .array(Self.database["columns"].arrayValue.map { $0.id == "status" ? $0.merging(["editable": false]) : $0 })])
        XCTAssertThrowsError(try Self.transfer(rows[0], from: "todo", to: "done", targetIDs: ["row-3"], index: 0, database: locked))
        XCTAssertThrowsError(try Self.transfer(rows[0].merging(["rev": 99]), from: "todo", to: "done", targetIDs: ["row-3"], index: 0))
        XCTAssertThrowsError(try Self.transfer(rows[0], from: "todo", to: "done", targetIDs: ["row-3", "row-2"], index: 0))
        XCTAssertThrowsError(try Self.transfer(rows[0], from: "todo", to: "done", targetIDs: ["row-3"], index: 2))
        XCTAssertThrowsError(try Self.transfer(rows[0], from: "todo", to: "done", targetIDs: ["row-3"], index: 0, view: Self.view.merging(["type": "list"])))
    }

    func testDraggedRowPostsOneMoveWithOriginalRevisionAndSelfOrStaleDropSendsNothing() async throws {
        let transport = AppContractTransport { request, _ in
            request.method == "POST" ? .json(["database": Self.movedRows, "changes": ["rejected": []]]) : Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let group = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "todo" })
        let stayed = await model.dropOrderedRow(in: group, from: [0], to: 1)
        XCTAssertTrue(stayed); XCTAssertTrue(posts(transport).isEmpty)
        let stale = DatabaseOrderingGroup(key: "todo", title: group.title, rows: Array(group.rows.reversed()))
        let refused = await model.dropOrderedRow(in: stale, from: [1], to: 0)
        XCTAssertFalse(refused); XCTAssertNotNil(model.error); XCTAssertTrue(posts(transport).isEmpty)
        let moved = await model.dropOrderedRow(in: group, from: [1], to: 0)
        XCTAssertTrue(moved); XCTAssertNil(model.orderingPending); XCTAssertEqual(model.revision, 8)
        XCTAssertEqual(posts(transport), [["revision": 7, "ops": [["op": "row.move", "id": "row-2", "after": .null]]]])
    }

    func testDraggedColumnUsesDrawnSnapshotAndNeverPostsForChangedColumns() async {
        let columns = Self.database["columns"].arrayValue
        let moved = Self.database.merging(["revision": 8, "columns": .array([columns[2], columns[0], columns[1]])])
        let transport = AppContractTransport { request, _ in
            request.method == "POST" ? .json(["database": moved, "changes": ["rejected": []]]) : Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let refused = await model.dropOrderedColumn(from: [2], to: 0, snapshot: ["title", "opaque", "status"])
        XCTAssertFalse(refused); XCTAssertNotNil(model.error); XCTAssertTrue(posts(transport).isEmpty)
        let saved = await model.dropOrderedColumn(from: [2], to: 0, snapshot: ["title", "status", "opaque"])
        XCTAssertTrue(saved); XCTAssertEqual(model.columns.map(\.id), ["opaque", "title", "status"])
        XCTAssertEqual(posts(transport), [["revision": 7, "ops": [["op": "column.move", "id": "opaque", "after": .null]]]])
    }

    func testForeignOrStaleDragPayloadsAreRefusedBeforeAnyRequest() async throws {
        let transport = AppContractTransport { request, _ in
            request.method == "POST" ? .json(["database": Self.movedRows, "changes": ["rejected": []]]) : Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let todo = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "todo" })
        let done = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "done" })
        let item = model.orderingDragItem(row: "row-2", in: todo)
        XCTAssertNil(model.orderingDropRejection(item, kind: .row)); XCTAssertNotNil(model.orderingDropRejection(item, kind: .column))
        let otherDatabase = DatabaseOrdering.scope(baseURL: transport.api.baseURL.absoluteString, workspaceId: "workspace-1", databaseId: "database-2")
        XCTAssertNotEqual(otherDatabase, item.scope); XCTAssertEqual(item.scope, model.orderingScope)
        func payload(version: Int = 1, scope: String? = nil, workspaceId: String = "workspace-1", databaseId: String = "database-1",
                     revision: Int = 7, kind: DatabaseOrderingDragItem.Kind = .row, group: String? = nil) -> DatabaseOrderingDragItem {
            .init(version: version, scope: scope ?? item.scope, workspaceId: workspaceId, databaseId: databaseId, revision: revision, kind: kind, id: "row-2", group: group ?? item.group)
        }
        let foreign = [payload(version: 2), payload(scope: "another-process"), payload(scope: otherDatabase, databaseId: "database-2"),
                       payload(workspaceId: "workspace-2"), payload(revision: 6), payload(kind: .column), payload(group: "group:missing")]
        let count = transport.requests.count
        for dropped in foreign {
            model.error = nil
            let transferred = await model.transferOrderedRow(dropped, into: done, at: 0)
            XCTAssertFalse(transferred); XCTAssertNotNil(model.error)
            let placed = await model.dropOrderedRow(dropped, onto: "row-1")
            XCTAssertFalse(placed)
        }
        XCTAssertEqual(transport.requests.count, count)
        // A card dropped back into its own group is not a group change.
        let same = await model.transferOrderedRow(item, into: todo, at: 0)
        XCTAssertTrue(same); XCTAssertEqual(transport.requests.count, count)
        // A card dropped on another card of its group takes that card's place.
        let placed = await model.dropOrderedRow(item, onto: "row-1")
        XCTAssertTrue(placed)
        XCTAssertEqual(posts(transport), [["revision": 7, "ops": [["op": "row.move", "id": "row-2", "after": .null]]]])
    }

    func testBoardTransferSendsOneBatchAndConfirmsValueAndOrder() async throws {
        let transport = AppContractTransport { request, _ in
            request.method == "POST" ? .json(["database": Self.transferred(status: "done"), "changes": ["rejected": []]]) : Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let todo = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "todo" })
        let done = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "done" })
        let moved = await model.transferOrderedRow(model.orderingDragItem(row: "row-1", in: todo), into: done, at: 0)
        XCTAssertTrue(moved); XCTAssertNil(model.orderingPending); XCTAssertNil(model.error)
        XCTAssertEqual(posts(transport), [["revision": 7, "ops": [["op": "row.update", "id": "row-1", "expectRev": 5, "values": ["status": "done"]],
                                                                  ["op": "row.move", "id": "row-1", "after": "row-2"]]]])
        XCTAssertEqual(Set(model.orderingRowGroups.first { $0.key == "done" }?.rows.map(\.id) ?? []), ["row-1", "row-3"])
    }

    func testUnknownBoardTransferStaysPendingUntilValueAndOrderBothMatch() async throws {
        var state = 0
        let snapshots = [Self.database, Self.transferred(status: "todo"), Self.transferred(status: "done")]
        let transport = AppContractTransport { request, _ in
            request.method == "POST" ? .failure(.networkConnectionLost) : Self.readResponse(request, database: snapshots[state])
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let todo = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "todo" })
        let done = try XCTUnwrap(model.orderingRowGroups.first { $0.key == "done" })
        let moved = await model.transferOrderedRow(model.orderingDragItem(row: "row-1", in: todo), into: done, at: 0)
        XCTAssertFalse(moved); XCTAssertTrue(model.error?.contains("not retried") == true)
        let pending = try XCTUnwrap(model.orderingPending)
        XCTAssertEqual(pending["operations"].arrayValue.map { $0["op"] }, ["row.update", "row.move"])
        XCTAssertEqual(pending["operation"]["op"], "row.move")
        XCTAssertEqual(pending["expectedValues"], [["row": "row-1", "column": "status", "value": "done"]])
        let reopened = self.model(transport); XCTAssertEqual(reopened.orderingPending, pending)
        state = 1; await reopened.refreshOrdering()
        // A newer revision with the saved order but not the group value is not this batch.
        XCTAssertNotNil(reopened.orderingPending); XCTAssertTrue(reopened.orderingBlocked)
        let blockedTodo = try XCTUnwrap(reopened.orderingRowGroups.first { $0.key == "todo" })
        let blockedDone = try XCTUnwrap(reopened.orderingRowGroups.first { $0.key == "done" })
        let again = await reopened.transferOrderedRow(reopened.orderingDragItem(row: "row-2", in: blockedTodo), into: blockedDone, at: 0)
        XCTAssertFalse(again); XCTAssertEqual(posts(transport).count, 1)
        state = 2; await reopened.refreshOrdering()
        XCTAssertNil(reopened.orderingPending); XCTAssertEqual(reopened.orderingNotice, "The saved order is confirmed.")
        XCTAssertEqual(posts(transport).count, 1)
    }

    func testLegacySingleOperationPendingStillRestoresAndUnsupportedOneDoesNot() async {
        let transport = AppContractTransport { request, _ in Self.readResponse(request, database: Self.movedRows) }; defer { cleanup(transport) }
        let key = "michi.database.order.\(transport.api.baseURL.absoluteString).workspace-1.database-1"
        var record: JSONValue = ["databaseId": "database-1", "workspaceId": "workspace-1", "revision": 7,
                                 "operation": ["op": "view.move", "id": "view-1", "after": .null], "expectedIDs": ["row-2", "row-1", "row-3"]]
        UserDefaults.standard.set(record.prettyPrinted, forKey: key)
        XCTAssertNil(self.model(transport).orderingPending)
        record["operation"] = ["op": "row.move", "id": "row-2", "after": .null]
        UserDefaults.standard.set(record.prettyPrinted, forKey: key)
        let model = self.model(transport)
        XCTAssertEqual(model.orderingPending?["operation"]["op"], "row.move"); XCTAssertTrue(model.orderingBlocked)
        await model.refreshOrdering()
        XCTAssertNil(model.orderingPending); XCTAssertTrue(posts(transport).isEmpty)
    }

    func testDragCancelledBeforeSendingPostsNothingAndLeavesNoPendingMove() async {
        let box = DatabaseOrderingTaskBox()
        let transport = AppContractTransport { request, requests in
            // The second database read is the pre-send snapshot of the move.
            if request.path == "/api/databases/database-1", requests.filter({ $0.path == request.path }).count > 1 { box.cancel() }
            return Self.readResponse(request)
        }; defer { cleanup(transport) }
        let model = self.model(transport); await model.refreshOrdering()
        let task = Task { await model.dropOrderedColumn(from: [2], to: 0, snapshot: ["title", "status", "opaque"]) }
        box.set(task)
        let moved = await task.value
        XCTAssertFalse(moved); XCTAssertTrue(posts(transport).isEmpty)
        XCTAssertNil(model.orderingPending); XCTAssertNil(model.error)
        XCTAssertNil(UserDefaults.standard.string(forKey: "michi.database.order.\(transport.api.baseURL.absoluteString).workspace-1.database-1"))
    }
}

private final class DatabaseOrderingTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Bool, Never>?
    func set(_ task: Task<Bool, Never>) { lock.lock(); self.task = task; lock.unlock() }
    func cancel() { lock.lock(); let task = self.task; lock.unlock(); task?.cancel() }
}
