import Foundation
import Combine
import MichiCore

enum DatabaseManagement {
    static func restriction(_ database: JSONValue) -> String? {
        if database["kind"] == "threads" { return "All threads keeps its own schema and views." }
        if !database["merged"].isNull && database["merged"] != false { return "Manage each workspace's database separately." }
        if database["readOnly"] == true || database["editable"] == false { return "This database is read-only." }
        return nil
    }
    static func protectedColumn(_ column: JSONValue, database: JSONValue) -> Bool {
        column["builtin"] == true || (database["role"] == "tasks" && ["task", "status", "threads", "next"].contains(column.id))
    }
    static func titleColumn(columns: [JSONValue], isThreads: Bool = false) -> JSONValue? {
        (isThreads ? columns.first { $0.id == "title" } : nil) ?? columns.first { $0["type"] == "text" } ?? columns.first
    }
    static func shownColumns(view: JSONValue, columns: [JSONValue], isThreads: Bool = false) -> [JSONValue] {
        let title = titleColumn(columns: columns, isThreads: isThreads)?.id
        let visible: Set<String>?
        if !view["config"]["visible"].isNull { visible = Set(featureStringList(view["config"]["visible"])) }
        else if view["type"] == "list" {
            if isThreads { visible = Set(columns.filter { $0["builtin"] == true && ["state", "project", "app", "lastActivity"].contains($0.id) }.map(\.id)) }
            else { visible = Set(columns.filter { $0.id != title && ["select", "app", "date", "number", "checkbox", "progress"].contains($0["type"].stringValue) }.prefix(2).map(\.id)) }
        } else { visible = nil }
        return columns.filter { $0.id == title || visible == nil || visible!.contains($0.id) }
    }
    static func settingVisibility(view: JSONValue, columns: [JSONValue], columnID: String, visible: Bool, isThreads: Bool = false) -> JSONValue {
        guard columns.contains(where: { $0.id == columnID }), titleColumn(columns: columns, isThreads: isThreads)?.id != columnID else { return view }
        var ids = Set(shownColumns(view: view, columns: columns, isThreads: isThreads).map(\.id))
        if visible { ids.insert(columnID) } else { ids.remove(columnID) }
        var next = view
        next["config"]["visible"] = .array(columns.filter { ids.contains($0.id) }.map { .string($0.id) })
        return next
    }
    /// Management changes only the requested view metadata. Opaque component
    /// properties and future server settings are never reconstructed or pruned.
    static func saveView(_ view: JSONValue, name: String, id: String? = nil) throws -> JSONValue {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let target = id ?? view.id
        guard !target.isEmpty, target.utf16.count <= 200, !name.isEmpty, name.utf16.count <= 100,
              featureDatabaseViewTypes.contains(view["type"].stringValue), case .object = view["config"] else {
            throw FeatureRequestError(message: "This view could not be read safely. Reload before editing.")
        }
        return ["op": "view.save", "view": ["id": .string(target), "name": .string(name), "type": view["type"], "config": view["config"]]]
    }
    static func duplicateView(_ view: JSONValue, database: JSONValue, id: String) throws -> JSONValue {
        let views = database["views"].arrayValue
        guard views.count < 50, !views.contains(where: { $0.id == id }) else { throw FeatureRequestError(message: "The database cannot add another view.") }
        let base = String(view["name"].stringValue.prefix(80)) + " copy"
        let names = Set(views.map { $0["name"].stringValue })
        var name = base, index = 2
        while names.contains(name) { name = "\(base) \(index)"; index += 1 }
        return try saveView(view, name: name, id: id)
    }
    static func deleteView(_ view: JSONValue, database: JSONValue) throws -> JSONValue {
        let views = database["views"].arrayValue
        guard views.count > 1, views.contains(where: { $0.id == view.id }) else { throw FeatureRequestError(message: "Keep at least one view in the database.") }
        return ["op": "view.delete", "id": .string(view.id)]
    }
    static func deleteColumn(_ column: JSONValue, database: JSONValue) throws -> JSONValue {
        guard database["columns"].arrayValue.contains(where: { $0.id == column.id }), !protectedColumn(column, database: database) else {
            throw FeatureRequestError(message: "Built-in and core task columns must stay in the database.")
        }
        return ["op": "column.delete", "id": .string(column.id)]
    }
    static func changeColumnType(_ column: JSONValue, type: String, database: JSONValue) throws -> JSONValue {
        guard !protectedColumn(column, database: database), featureDatabaseColumnTypes.contains(type), type != "threads" else {
            throw FeatureRequestError(message: "This column cannot use that type. The Conversations column belongs to task databases.")
        }
        return try featureColumnUpdateOperation(id: column.id, patch: ["type": .string(type)])
    }
    static func matches(_ operation: JSONValue, database: JSONValue) -> Bool {
        switch operation["op"].stringValue {
        case "view.save":
            guard let saved = database["views"].arrayValue.first(where: { $0.id == operation["view"].id }) else { return false }
            let expected = operation["view"]
            // The server may pin a human-edited custom view to its active
            // component version. All submitted config keys must still match.
            return saved["name"] == expected["name"] && saved["type"] == expected["type"] && expected["config"].objectValue.allSatisfy { saved["config"][$0.key] == $0.value }
        case "view.delete": return !database["views"].arrayValue.contains { $0.id == operation["id"].stringValue }
        case "column.delete": return !database["columns"].arrayValue.contains { $0.id == operation["id"].stringValue }
        case "column.update":
            guard let saved = database["columns"].arrayValue.first(where: { $0.id == operation["id"].stringValue }) else { return false }
            return operation["patch"].objectValue.allSatisfy { saved[$0.key] == $0.value }
        default: return false
        }
    }
}

@MainActor
final class DatabaseManagementModel: ObservableObject {
    let model: FeatureDatabaseModel
    @Published private(set) var access = false
    @Published private(set) var pending: JSONValue?
    @Published private(set) var notice: String?
    private var key: String { "michi.database.management.\(model.api.baseURL.absoluteString).\(model.workspaceId).\(model.databaseId)" }
    var disabled: Bool { !access || model.loading || model.saving || model.viewDirty || pending != nil || model.orderingPending != nil || DatabaseManagement.restriction(model.database) != nil }
    init(model: FeatureDatabaseModel) { self.model = model; restorePending() }
    private func restorePending() {
        guard let raw = UserDefaults.standard.string(forKey: key), let value = try? JSONValue.parse(raw),
              value["databaseId"].stringValue == model.databaseId, value["workspaceId"].stringValue == model.workspaceId,
              value["revision"].intValue > 0, ["view.save", "view.delete", "column.delete", "column.update"].contains(value["operation"]["op"].stringValue) else { return }
        pending = value
    }
    private func snapshot() async throws -> JSONValue {
        access = false
        let graph = WorkspaceGraph(raw: try await model.api.request("/workspaces/\(MichiAPI.pathSegment(model.workspaceId))"))
        guard graph.id == model.workspaceId, !graph.isDeleted, !graph.isArchived, !graph.isSystem else {
            throw FeatureRequestError(message: "This database's workspace is unavailable or read-only.")
        }
        let database = try featureRequireDatabase(await model.api.request("/databases/\(MichiAPI.pathSegment(model.databaseId))"))
        guard database.id == model.databaseId, database["workspaceId"].stringValue == model.workspaceId,
              case .array = database["views"], case .array = database["columns"], case .array = database["rows"] else {
            throw FeatureRequestError(message: "The database snapshot did not match this workspace.")
        }
        if let reason = DatabaseManagement.restriction(database) { throw FeatureRequestError(message: reason) }
        access = true
        return database
    }
    func refresh() async {
        guard !model.loading, !model.saving else { return }
        model.loading = true; defer { model.loading = false }
        restorePending()
        do {
            let latest = try await snapshot()
            guard !Task.isCancelled else { return }
            model.applyOrderedDatabase(latest)
            if let pending, latest["revision"].intValue > pending["revision"].intValue, DatabaseManagement.matches(pending["operation"], database: latest) {
                clearPending(); notice = "The saved change is confirmed."
            }
            model.error = nil
        } catch { access = false; model.error = featureErrorMessage(error) }
    }
    func renameView(_ view: JSONValue, name: String) async -> Bool {
        do { try requireView(view); return await apply(try DatabaseManagement.saveView(view, name: name)) }
        catch { model.error = featureErrorMessage(error); return false }
    }
    func duplicateView(_ view: JSONValue) async -> Bool {
        do { try requireView(view); return await apply(try DatabaseManagement.duplicateView(view, database: model.database, id: "view-" + UUID().uuidString.lowercased())) }
        catch { model.error = featureErrorMessage(error); return false }
    }
    func deleteView(_ view: JSONValue) async -> Bool {
        do { try requireView(view); return await apply(try DatabaseManagement.deleteView(view, database: model.database)) }
        catch { model.error = featureErrorMessage(error); return false }
    }
    func deleteColumn(_ column: JSONValue) async -> Bool {
        do { try requireColumn(column); return await apply(try DatabaseManagement.deleteColumn(column, database: model.database)) }
        catch { model.error = featureErrorMessage(error); return false }
    }
    func changeColumnType(_ column: JSONValue, to type: String) async -> Bool {
        do { try requireColumn(column); return await apply(try DatabaseManagement.changeColumnType(column, type: type, database: model.database)) }
        catch { model.error = featureErrorMessage(error); return false }
    }
    func saveVisibleColumns(_ view: JSONValue, baseline: JSONValue) async -> Bool {
        do {
            try requireView(baseline)
            var changed = baseline
            changed["config"]["visible"] = view["config"]["visible"]
            return await apply(try DatabaseManagement.saveView(changed, name: changed["name"].stringValue))
        } catch { model.error = featureErrorMessage(error); return false }
    }
    private func requireView(_ view: JSONValue) throws {
        guard model.views.first(where: { $0.id == view.id }) == view else { throw FeatureRequestError(message: "This view changed. Review the latest view before editing.") }
    }
    private func requireColumn(_ column: JSONValue) throws {
        guard model.columns.first(where: { $0.id == column.id }) == column else { throw FeatureRequestError(message: "This column changed. Review its current settings before editing.") }
    }
    private func apply(_ operation: JSONValue) async -> Bool {
        restorePending()
        guard !disabled, model.revision > 0 else { return false }
        let revision = model.revision
        model.saving = true; notice = nil; defer { model.saving = false }
        var sent = false
        do {
            let latest = try await snapshot()
            model.applyOrderedDatabase(latest)
            guard !Task.isCancelled else { return false }
            guard latest["revision"].intValue == revision, !model.viewDirty else {
                throw FeatureRequestError(message: "The database changed. Review the refreshed state before applying this edit.")
            }
            let changesState = !DatabaseManagement.matches(operation, database: latest)
            let record: JSONValue = ["databaseId": .string(model.databaseId), "workspaceId": .string(model.workspaceId), "revision": .number(Double(revision)), "operation": operation]
            pending = record; UserDefaults.standard.set(record.prettyPrinted, forKey: key)
            sent = true
            let result = try await model.api.request("/databases/\(MichiAPI.pathSegment(model.databaseId))/edits", method: "POST",
                body: ["revision": .number(Double(revision)), "ops": .array([operation])])
            let saved = try featureRequireDatabase(result)
            guard saved.id == model.databaseId, saved["workspaceId"].stringValue == model.workspaceId,
                  saved["revision"].intValue >= revision + (changesState ? 1 : 0),
                  case .array = saved["views"], case .array = saved["columns"], case .array = saved["rows"],
                  result["changes"]["rejected"].arrayValue.isEmpty,
                  DatabaseManagement.matches(operation, database: saved) else {
                throw FeatureRequestError(message: "The saved change could not be confirmed. Refresh to check it.")
            }
            model.applyOrderedDatabase(saved); clearPending(); model.error = nil; notice = "Saved."; return true
        } catch {
            if !sent || (error as? MichiAPIError)?.statusCode.map({ [400, 401, 403, 404, 409, 422].contains($0) }) == true { clearPending() }
            model.error = featureErrorMessage(error) + (pending == nil ? "" : " The change may already be saved; it has not been retried.")
            return false
        }
    }
    private func clearPending() { pending = nil; UserDefaults.standard.removeObject(forKey: key) }
    func forgetPending() {
        guard !model.loading, !model.saving else { return }
        clearPending(); notice = "The local pending record was forgotten. The original edit may still finish."
    }
}

@MainActor extension FeatureDatabaseModel {
    func moveBoardCard(_ row: JSONValue, from source: String?, to target: String?) async -> Bool {
        guard !saving, !loading else { return false }
        if source == target { return true }
        let config = featureEffectiveViewConfig(effectiveView, columns: columns)
        guard let column = columns.first(where: { $0.id == config["group"].stringValue }),
              let current = rows.first(where: { $0.id == row.id }), current["rev"] == row["rev"],
              let group = boardGroups.first(where: { $0.key == source }), group.rows.contains(where: { $0.id == row.id }) else {
            error = "This card or group changed. Refresh before moving it."; return false
        }
        do { return await updateRow(try featureBoardMoveOperation(row: current, groupColumn: column, key: target, sourceKey: source)) }
        catch { self.error = featureErrorMessage(error); return false }
    }
}
