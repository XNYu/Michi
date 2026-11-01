import Foundation
import MichiCore

enum DatabaseOrderingDirection: Equatable { case up, down }

struct DatabaseOrderingGroup: Identifiable {
    let key: String?
    let title: String
    let rows: [JSONValue]
    var id: String { key.map { "group:" + $0 } ?? "ungrouped" }
}

/// A dragged row or column. It carries only opaque ids and the revision the
/// person saw; `scope` binds it to this connection, workspace and database in
/// this app process, so a payload from another database, window or app is refused.
struct DatabaseOrderingDragItem: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable { case row, column }
    var version = 1
    let scope: String
    let workspaceId: String
    let databaseId: String
    let revision: Int
    let kind: Kind
    let id: String
    /// The `DatabaseOrderingGroup.id` a row was dragged from; nil for a column.
    let group: String?
}

/// A board card moved into another group: its group value and, when that group
/// already has cards, its position. The server applies both as one batch.
struct DatabaseOrderingTransfer: Equatable {
    let operations: [JSONValue]
    let expectedValues: [JSONValue]
}

/// Native Pages supports row.move and column.move, both guarded by the
/// database revision. view.save deliberately keeps a view's existing position.
enum DatabaseOrdering {
    static let orderOperations: Set<String> = ["row.move", "column.move"]
    static let pendingOperationKinds: Set<String> = ["row.move", "column.move", "row.update"]

    static func restriction(_ database: JSONValue) -> String? {
        if database["kind"] == "threads" { return "Conversations keep their own activity order." }
        if !database["merged"].isNull && database["merged"] != false { return "Merged databases keep each workspace's own order." }
        if database["readOnly"] == true || database["editable"] == false { return "This database is read-only." }
        return nil
    }
    static func rowRestriction(database: JSONValue, view: JSONValue) -> String? {
        if let reason = restriction(database) { return reason }
        if !["table", "list", "board", "gallery"].contains(view["type"].stringValue) { return "Choose a table, list, board, or gallery view to arrange rows." }
        let columns = Set(database["columns"].arrayValue.map(\.id))
        if view["config"]["sorts"].arrayValue.contains(where: { columns.contains($0["column"].stringValue) }) {
            return "This view has an active sort. Clear it before arranging rows manually."
        }
        return nil
    }
    static func orderedRows(_ database: JSONValue) -> [JSONValue] {
        database["rows"].arrayValue.sorted {
            let a = $0["position"].doubleValue, b = $1["position"].doubleValue
            return a == b ? $0.id < $1.id : a < b
        }
    }
    /// Opaque ids compare by their exact UTF-8 bytes, not Unicode equivalence.
    static func exact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
    static func exact(_ a: [String], _ b: [String]) -> Bool { a.count == b.count && zip(a, b).allSatisfy { exact($0, $1) } }

    /// A drag token valid only within this process (Hasher is seeded per launch).
    private static let processSalt = UUID().uuidString
    static func scope(baseURL: String, workspaceId: String, databaseId: String) -> String {
        var hasher = Hasher()
        hasher.combine(processSalt)
        for part in [baseURL, workspaceId, databaseId] { hasher.combine(Array(part.utf8)) }
        return String(UInt(bitPattern: hasher.finalize()), radix: 16)
    }

    /// SwiftUI `onMove` offsets as the dragged index and its final index. Nil for
    /// a drop back in place; several items at once, or stale offsets, are refused.
    static func listMove(source: IndexSet, destination: Int, count: Int) throws -> (from: Int, to: Int)? {
        guard source.count == 1, let from = source.first else { throw FeatureRequestError(message: "Move one item at a time.") }
        guard (0..<count).contains(from), (0...count).contains(destination) else {
            throw FeatureRequestError(message: "The list changed during the drag. Review it before moving again.")
        }
        let to = destination > from ? destination - 1 : destination
        return to == from ? nil : (from, to)
    }

    static func rowMove(database: JSONValue, view: JSONValue, visibleIDs: [String], id: String, direction: DatabaseOrderingDirection) throws -> JSONValue? {
        let checked = try checkedRowMove(database: database, view: view, visibleIDs: visibleIDs, id: id)
        let to = direction == .up ? checked.from - 1 : checked.from + 1
        guard visibleIDs.indices.contains(to) else { return nil }
        return try rowOperation(all: checked.all, visibleIDs: visibleIDs, from: checked.from, to: to)
    }
    /// Puts the row at `to` among the rows this view shows. Nil for a self-drop.
    static func rowPlacement(database: JSONValue, view: JSONValue, visibleIDs: [String], id: String, to: Int) throws -> JSONValue? {
        let checked = try checkedRowMove(database: database, view: view, visibleIDs: visibleIDs, id: id)
        guard visibleIDs.indices.contains(to) else { throw FeatureRequestError(message: "The drop position is outside this list.") }
        guard to != checked.from else { return nil }
        return try rowOperation(all: checked.all, visibleIDs: visibleIDs, from: checked.from, to: to)
    }
    private static func checkedRowMove(database: JSONValue, view: JSONValue, visibleIDs: [String], id: String) throws -> (all: [String], from: Int) {
        if let reason = rowRestriction(database: database, view: view) { throw FeatureRequestError(message: reason) }
        guard database["views"].arrayValue.contains(where: { $0.id == view.id }), !view.id.isEmpty else { throw FeatureRequestError(message: "This view no longer belongs to the database.") }
        let all = orderedRows(database).map(\.id)
        try validate(all)
        guard !visibleIDs.isEmpty, Set(visibleIDs).count == visibleIDs.count, Set(visibleIDs).isSubset(of: Set(all)),
              let from = visibleIDs.firstIndex(where: { exact($0, id) }) else { throw FeatureRequestError(message: "The visible rows changed. Refresh before moving this row.") }
        // A drop position is only meaningful if the list shows the saved order.
        guard isSubsequence(visibleIDs, of: all) else {
            throw FeatureRequestError(message: "This view does not show rows in their saved order. Refresh before arranging rows.")
        }
        return (all, from)
    }
    private static func rowOperation(all: [String], visibleIDs: [String], from: Int, to: Int) throws -> JSONValue {
        let id = visibleIDs[from]
        var next = visibleIDs; next.remove(at: from); next.insert(id, at: to)
        let after: String?
        if to > 0 { after = next[to - 1] }
        else {
            // At the top of a filtered list or board column, insert before its
            // former first row in global order, preserving unrelated hidden rows.
            let remaining = all.filter { $0 != id }
            guard let lead = remaining.firstIndex(of: next[1]) else { throw FeatureRequestError(message: "The move anchor is missing.") }
            after = lead > 0 ? remaining[lead - 1] : nil
        }
        return ["op": "row.move", "id": .string(id), "after": after.map(JSONValue.string) ?? .null]
    }
    static func isSubsequence(_ ids: [String], of all: [String]) -> Bool {
        var remaining = ids[...]
        for id in all where remaining.first == id { remaining = remaining.dropFirst() }
        return remaining.isEmpty
    }

    static func columnMove(database: JSONValue, id: String, direction: DatabaseOrderingDirection) throws -> JSONValue? {
        let checked = try checkedColumn(database: database, id: id)
        let to = direction == .up ? checked.from - 1 : checked.from + 1
        guard checked.ids.indices.contains(to) else { return nil }
        return columnOperation(ids: checked.ids, from: checked.from, to: to)
    }
    /// Puts the column at `to` in the database's column order. Nil for a self-drop.
    static func columnPlacement(database: JSONValue, id: String, to: Int) throws -> JSONValue? {
        let checked = try checkedColumn(database: database, id: id)
        guard checked.ids.indices.contains(to) else { throw FeatureRequestError(message: "The drop position is outside this list.") }
        guard to != checked.from else { return nil }
        return columnOperation(ids: checked.ids, from: checked.from, to: to)
    }
    private static func checkedColumn(database: JSONValue, id: String) throws -> (ids: [String], from: Int) {
        if let reason = restriction(database) { throw FeatureRequestError(message: reason) }
        let ids = database["columns"].arrayValue.map(\.id); try validate(ids)
        guard let from = ids.firstIndex(where: { exact($0, id) }) else { throw FeatureRequestError(message: "The column no longer belongs to the database.") }
        return (ids, from)
    }
    private static func columnOperation(ids: [String], from: Int, to: Int) -> JSONValue {
        var next = ids; let id = next.remove(at: from); next.insert(id, at: to)
        return ["op": "column.move", "id": .string(id), "after": to > 0 ? .string(next[to - 1]) : .null]
    }

    /// A card dropped into another board group, at `index` among that group's
    /// cards. Under an active sort, or when the card is already in that group
    /// (multi-select), only the value changes and the saved order is kept.
    static func boardTransfer(database: JSONValue, view: JSONValue, row: JSONValue, sourceKey: String?, targetKey: String?,
                              targetIDs: [String], index: Int) throws -> DatabaseOrderingTransfer? {
        if let reason = restriction(database) { throw FeatureRequestError(message: reason) }
        guard view["type"] == "board", !view.id.isEmpty, database["views"].arrayValue.contains(where: { $0.id == view.id }) else {
            throw FeatureRequestError(message: "The board changed. Refresh before moving this card.")
        }
        guard sourceKey != targetKey else { return nil }
        let columns = database["columns"].arrayValue
        let config = featureEffectiveViewConfig(view, columns: columns)
        guard let groupColumn = columns.first(where: { $0.id == config["group"].stringValue }), NativeDatabaseLayout.editable(groupColumn) else {
            throw FeatureRequestError(message: "This board's grouping column cannot be edited.")
        }
        let rows = orderedRows(database), all = rows.map(\.id)
        try validate(all)
        guard let current = rows.first(where: { exact($0.id, row.id) }), current == row else {
            throw FeatureRequestError(message: "This card changed. Refresh before moving it.")
        }
        let update = try featureBoardMoveOperation(row: current, groupColumn: groupColumn, key: targetKey, sourceKey: sourceKey)
        let expected: JSONValue = ["row": .string(current.id), "column": .string(groupColumn.id), "value": update["values"][groupColumn.id]]
        var operations = [update]
        let others = targetIDs.filter { !exact($0, current.id) }
        if rowRestriction(database: database, view: view) == nil, !others.isEmpty, others.count == targetIDs.count {
            guard Set(others).count == others.count, Set(others).isSubset(of: Set(all)), isSubsequence(others, of: all) else {
                throw FeatureRequestError(message: "The target group changed. Refresh before moving this card.")
            }
            guard (0...others.count).contains(index) else { throw FeatureRequestError(message: "The drop position is outside this group.") }
            let after: String?
            if index > 0 { after = others[index - 1] }
            else {
                let remaining = all.filter { $0 != current.id }
                guard let lead = remaining.firstIndex(of: others[0]) else { throw FeatureRequestError(message: "The move anchor is missing.") }
                after = lead > 0 ? remaining[lead - 1] : nil
            }
            let move: JSONValue = ["op": "row.move", "id": .string(current.id), "after": after.map(JSONValue.string) ?? .null]
            if try expectedIDs(database: database, operations: [move]) != all { operations.append(move) }
        }
        return .init(operations: operations, expectedValues: [expected])
    }

    static func validate(_ ids: [String]) throws {
        guard Set(ids).count == ids.count, ids.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 200 }) else { throw FeatureRequestError(message: "The database order could not be read safely.") }
    }
    static func expectedIDs(database: JSONValue, operation: JSONValue) throws -> [String] {
        try expectedIDs(database: database, operations: [operation])
    }
    /// The order the server will save after `operations`, applied in sequence.
    static func expectedIDs(database: JSONValue, operations: [JSONValue]) throws -> [String] {
        let kinds = Set(operations.map { $0["op"].stringValue })
        guard (1...2).contains(operations.count), kinds.isSubset(of: pendingOperationKinds) else { throw FeatureRequestError(message: "This ordering operation is not supported.") }
        let rows = !kinds.contains("column.move")
        guard rows || kinds == ["column.move"] else { throw FeatureRequestError(message: "This ordering operation is not supported.") }
        var ids = (rows ? orderedRows(database) : database["columns"].arrayValue).map(\.id); try validate(ids)
        for operation in operations {
            let id = operation["id"].stringValue
            guard ids.contains(where: { exact($0, id) }), operation["after"] != .string(id) else { throw FeatureRequestError(message: "The move target is invalid.") }
            if operation["op"] == "row.update" { continue }
            ids.removeAll { exact($0, id) }
            let index: Int
            if operation["after"].isNull { index = 0 }
            else if let after = ids.firstIndex(where: { exact($0, operation["after"].stringValue) }) { index = after + 1 }
            else { throw FeatureRequestError(message: "The move anchor is missing.") }
            ids.insert(id, at: index)
        }
        return ids
    }
    /// Records written before batches existed hold a single `operation`.
    static func pendingOperations(_ pending: JSONValue) -> [JSONValue] {
        if case .array(let operations) = pending["operations"] { return operations }
        return pending["operation"].isNull ? [] : [pending["operation"]]
    }
    static func matches(_ pending: JSONValue, database: JSONValue) -> Bool {
        let operations = pendingOperations(pending)
        guard !operations.isEmpty else { return false }
        let rows = operations.contains { $0["op"].stringValue.hasPrefix("row.") }
        let current = rows ? orderedRows(database) : database["columns"].arrayValue
        guard exact(current.map(\.id), pending["expectedIDs"].arrayValue.map(\.stringValue)) else { return false }
        return pending["expectedValues"].arrayValue.allSatisfy { expected in
            guard let row = database["rows"].arrayValue.first(where: { exact($0.id, expected["row"].stringValue) }) else { return false }
            return row["values"][expected["column"].stringValue] == expected["value"]
        }
    }
}

@MainActor extension FeatureDatabaseModel {
    private var orderingKey: String { "michi.database.order.\(api.baseURL.absoluteString).\(workspaceId).\(databaseId)" }
    /// Up/down controls wait for the workspace check on the Arrange screen.
    var orderingDisabled: Bool { orderingBlocked || orderingAccess != true }
    /// Every move, including a drag, re-reads the workspace and database first.
    var orderingBlocked: Bool { loading || saving || orderingAccess == false || orderingPending != nil || DatabaseOrdering.restriction(database) != nil }
    /// Whether rows of the current view can be dragged into a new saved order.
    var rowDragEnabled: Bool { !orderingBlocked && DatabaseOrdering.rowRestriction(database: database, view: effectiveView) == nil }
    var orderingRowGroups: [DatabaseOrderingGroup] {
        if effectiveView["type"] == "board" { return boardGroups.map { DatabaseOrderingGroup(key: $0.key, title: $0.label.isEmpty ? "No value" : $0.label, rows: $0.rows) } }
        return [DatabaseOrderingGroup(key: nil, title: "Rows", rows: visibleRows)]
    }
    var orderingScope: String { DatabaseOrdering.scope(baseURL: api.baseURL.absoluteString, workspaceId: workspaceId, databaseId: databaseId) }
    func orderingDragItem(row id: String, in group: DatabaseOrderingGroup) -> DatabaseOrderingDragItem {
        .init(scope: orderingScope, workspaceId: workspaceId, databaseId: databaseId, revision: revision, kind: .row, id: id, group: group.id)
    }
    func orderingDragItem(column id: String) -> DatabaseOrderingDragItem {
        .init(scope: orderingScope, workspaceId: workspaceId, databaseId: databaseId, revision: revision, kind: .column, id: id, group: nil)
    }
    /// Why a dropped payload cannot be used here, or nil. Checked before any request.
    func orderingDropRejection(_ item: DatabaseOrderingDragItem, kind: DatabaseOrderingDragItem.Kind) -> String? {
        guard item.version == 1, item.kind == kind, DatabaseOrdering.exact(item.scope, orderingScope),
              DatabaseOrdering.exact(item.workspaceId, workspaceId), DatabaseOrdering.exact(item.databaseId, databaseId) else {
            return "That item belongs to another list and can't be dropped here."
        }
        guard revision > 0, item.revision == revision else { return "The database changed during the drag. Review the latest order before moving again." }
        return nil
    }
    func restoreDatabaseOrdering() {
        guard let raw = UserDefaults.standard.string(forKey: orderingKey), let pending = try? JSONValue.parse(raw),
              pending["databaseId"].stringValue == databaseId, pending["workspaceId"].stringValue == workspaceId, pending["revision"].intValue > 0,
              case .array = pending["expectedIDs"] else { return }
        let operations = DatabaseOrdering.pendingOperations(pending)
        guard (1...2).contains(operations.count), operations.allSatisfy({ DatabaseOrdering.pendingOperationKinds.contains($0["op"].stringValue) }) else { return }
        orderingPending = pending
    }
    func refreshOrdering() async {
        guard !loading, !saving else { return }
        loading = true; defer { loading = false }
        do {
            try await readOrderingAccess()
            let latest = try await readOrderingDatabase()
            applyOrderedDatabase(latest)
            if let pending = orderingPending, latest["revision"].intValue > pending["revision"].intValue, DatabaseOrdering.matches(pending, database: latest) {
                clearDatabaseOrdering(); orderingNotice = "The saved order is confirmed."
            } else if orderingPending != nil { orderingNotice = "The previous move is still unconfirmed. No move was retried." }
            error = nil
        } catch { self.error = featureErrorMessage(error) }
    }
    private func readOrderingAccess() async throws {
        let graph = WorkspaceGraph(raw: try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceId))"))
        guard graph.id == workspaceId else { orderingAccess = false; throw FeatureRequestError(message: "The database workspace could not be verified.") }
        orderingAccess = !graph.isArchived && !graph.isDeleted && !graph.isSystem
        guard orderingAccess == true else { throw FeatureRequestError(message: "This database's workspace is read-only.") }
    }
    private func readOrderingDatabase() async throws -> JSONValue {
        let latest = try featureRequireDatabase(await api.request("/databases/\(MichiAPI.pathSegment(databaseId))"))
        guard latest.id == databaseId, latest["workspaceId"].stringValue == workspaceId,
              case .array = latest["rows"], case .array = latest["columns"], case .array = latest["views"] else { throw FeatureRequestError(message: "The database identity or ordering data did not match this workspace.") }
        return latest
    }
    /// The group as it is drawn now; a drop computed from an older drawing is refused.
    private func currentOrderingGroup(_ group: DatabaseOrderingGroup) throws -> DatabaseOrderingGroup {
        guard let current = orderingRowGroups.first(where: { $0.id == group.id }), DatabaseOrdering.exact(current.rows.map(\.id), group.rows.map(\.id)) else {
            throw FeatureRequestError(message: "The visible group changed. Review it before moving this row.")
        }
        return current
    }
    func moveOrderedRow(_ rowID: String, in group: DatabaseOrderingGroup, direction: DatabaseOrderingDirection) async -> Bool {
        guard !orderingBlocked else { return false }
        do {
            let current = try currentOrderingGroup(group)
            guard let operation = try DatabaseOrdering.rowMove(database: database, view: effectiveView, visibleIDs: current.rows.map(\.id), id: rowID, direction: direction) else { return true }
            return await performDatabaseOrdering([operation])
        } catch { self.error = featureErrorMessage(error); return false }
    }
    /// A row dragged within a native list (`onMove` offsets of the drawn `group`).
    func dropOrderedRow(in group: DatabaseOrderingGroup, from source: IndexSet, to destination: Int) async -> Bool {
        guard !orderingBlocked else { return false }
        do {
            let ids = try currentOrderingGroup(group).rows.map(\.id)
            guard let move = try DatabaseOrdering.listMove(source: source, destination: destination, count: ids.count),
                  let operation = try DatabaseOrdering.rowPlacement(database: database, view: effectiveView, visibleIDs: ids, id: ids[move.from], to: move.to) else { return true }
            return await performDatabaseOrdering([operation])
        } catch { self.error = featureErrorMessage(error); return false }
    }
    /// A card dropped on another card of its own group (gallery): it takes that card's place.
    func dropOrderedRow(_ item: DatabaseOrderingDragItem, onto targetID: String) async -> Bool {
        guard !orderingBlocked else { return false }
        do {
            if let reason = orderingDropRejection(item, kind: .row) { throw FeatureRequestError(message: reason) }
            guard let group = orderingRowGroups.first(where: { $0.id == item.group }) else { throw FeatureRequestError(message: "The visible group changed. Review it before moving this row.") }
            let ids = group.rows.map(\.id)
            guard let from = ids.firstIndex(where: { DatabaseOrdering.exact($0, item.id) }),
                  let to = ids.firstIndex(where: { DatabaseOrdering.exact($0, targetID) }) else { throw FeatureRequestError(message: "The visible rows changed. Refresh before moving this row.") }
            guard let operation = try DatabaseOrdering.rowPlacement(database: database, view: effectiveView, visibleIDs: ids, id: ids[from], to: to) else { return true }
            return await performDatabaseOrdering([operation])
        } catch { self.error = featureErrorMessage(error); return false }
    }
    /// A board card dropped into the drawn `target` group at `index`. A drop back
    /// into its own group is left to the list's reorder handling.
    func transferOrderedRow(_ item: DatabaseOrderingDragItem, into target: DatabaseOrderingGroup, at index: Int) async -> Bool {
        guard !orderingBlocked else { return false }
        if let reason = orderingDropRejection(item, kind: .row) { error = reason; return false }
        guard item.group != target.id else { return true }
        guard let source = orderingRowGroups.first(where: { $0.id == item.group }),
              let row = source.rows.first(where: { DatabaseOrdering.exact($0.id, item.id) }) else {
            error = "This card is no longer in the group it was dragged from. Refresh before moving it."; return false
        }
        return await moveOrderedRow(row.id, from: source, into: target, at: index)
    }
    /// Moves a board card into another group; `index` nil appends it to that group.
    func moveOrderedRow(_ rowID: String, from source: DatabaseOrderingGroup, into target: DatabaseOrderingGroup, at index: Int? = nil) async -> Bool {
        guard !orderingBlocked else { return false }
        do {
            let currentSource = try currentOrderingGroup(source), currentTarget = try currentOrderingGroup(target)
            guard let row = currentSource.rows.first(where: { DatabaseOrdering.exact($0.id, rowID) }) else {
                throw FeatureRequestError(message: "This card is no longer in that group. Refresh before moving it.")
            }
            guard let plan = try DatabaseOrdering.boardTransfer(database: database, view: effectiveView, row: row, sourceKey: currentSource.key, targetKey: currentTarget.key,
                                                                targetIDs: currentTarget.rows.map(\.id), index: index ?? currentTarget.rows.count) else { return true }
            return await performDatabaseOrdering(plan.operations, expectedValues: plan.expectedValues)
        } catch { self.error = featureErrorMessage(error); return false }
    }
    func moveOrderedColumn(_ id: String, direction: DatabaseOrderingDirection) async -> Bool {
        guard !orderingBlocked else { return false }
        do {
            guard let operation = try DatabaseOrdering.columnMove(database: database, id: id, direction: direction) else { return true }
            return await performDatabaseOrdering([operation])
        } catch { self.error = featureErrorMessage(error); return false }
    }
    /// A column dragged within a native list of every column (`snapshot`: the ids drawn).
    func dropOrderedColumn(from source: IndexSet, to destination: Int, snapshot: [String]) async -> Bool {
        guard !orderingBlocked else { return false }
        do {
            guard DatabaseOrdering.exact(columns.map(\.id), snapshot) else { throw FeatureRequestError(message: "The columns changed. Review them before moving one.") }
            guard let move = try DatabaseOrdering.listMove(source: source, destination: destination, count: snapshot.count),
                  let operation = try DatabaseOrdering.columnPlacement(database: database, id: snapshot[move.from], to: move.to) else { return true }
            return await performDatabaseOrdering([operation])
        } catch { self.error = featureErrorMessage(error); return false }
    }
    private func performDatabaseOrdering(_ operations: [JSONValue], expectedValues: [JSONValue] = []) async -> Bool {
        guard !orderingBlocked, !operations.isEmpty, database.id == databaseId, database["workspaceId"].stringValue == workspaceId, revision > 0 else { return false }
        let baselineRevision = revision
        saving = true; orderingNotice = nil; error = nil; defer { saving = false }
        var sent = false
        do {
            let expected = try DatabaseOrdering.expectedIDs(database: database, operations: operations)
            try await readOrderingAccess()
            let latest = try await readOrderingDatabase()
            applyOrderedDatabase(latest)
            guard latest["revision"].intValue == baselineRevision else { throw FeatureRequestError(message: "The database changed. Its latest order is shown; review it before moving again.") }
            if let reason = DatabaseOrdering.restriction(latest) { throw FeatureRequestError(message: reason) }
            // A drag abandoned while the snapshot was read is never sent.
            try Task.checkCancellation()
            let primary = operations.first { DatabaseOrdering.orderOperations.contains($0["op"].stringValue) } ?? operations[0]
            let pending: JSONValue = ["databaseId": .string(databaseId), "workspaceId": .string(workspaceId), "revision": .number(Double(baselineRevision)),
                                      "operation": primary, "operations": .array(operations),
                                      "expectedIDs": .array(expected.map(JSONValue.string)), "expectedValues": .array(expectedValues)]
            orderingPending = pending; UserDefaults.standard.set(pending.prettyPrinted, forKey: orderingKey)
            sent = true
            let result = try await api.request("/databases/\(MichiAPI.pathSegment(databaseId))/edits", method: "POST",
                                               body: ["revision": .number(Double(baselineRevision)), "ops": .array(operations)])
            let saved = try featureRequireDatabase(result)
            guard saved.id == databaseId, saved["workspaceId"].stringValue == workspaceId, saved["revision"].intValue > baselineRevision,
                  result["changes"]["rejected"].arrayValue.isEmpty, DatabaseOrdering.matches(pending, database: saved) else {
                throw FeatureRequestError(message: "The move's saved order could not be confirmed. Refresh to check it.")
            }
            applyOrderedDatabase(saved); clearDatabaseOrdering(); orderingNotice = "Order saved."; error = nil; return true
        } catch {
            if !sent || (error as? MichiAPIError)?.statusCode.map({ [400, 401, 403, 404, 409, 422].contains($0) }) == true { clearDatabaseOrdering() }
            // Cancelling before the move was sent is not a failure to report.
            if error is CancellationError && !sent { return false }
            let message = error is CancellationError ? "The move was interrupted after it was sent." : featureErrorMessage(error)
            self.error = message + (orderingPending == nil ? "" : " The move may already be saved; it was not retried.")
            return false
        }
    }
    private func clearDatabaseOrdering() { orderingPending = nil; UserDefaults.standard.removeObject(forKey: orderingKey) }
    /// Called only after a warning-confirmed local recovery action; never sends a move.
    func forgetDatabaseOrdering() {
        guard !loading, !saving, orderingPending != nil else { return }
        clearDatabaseOrdering(); orderingNotice = "The pending record was forgotten. The original move may still finish; moving again is a new edit."
    }
}
