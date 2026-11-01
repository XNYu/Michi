import Foundation
import Combine
import MichiCore

@MainActor
final class FeatureDatabaseModel: ObservableObject {
    let api: MichiAPI
    let databaseId: String
    let workspaceId: String
    let conversations: FeatureDatabaseConversationModel
    @Published var conversationLookup: FeatureConversationLookup?
    @Published var conversationError: String?

    @Published var database: JSONValue = .null
    @Published var loading = false
    @Published var saving = false
    @Published var error: String?
    @Published var activity: JSONValue = .null
    let taskActivity: NativeTaskActivityModel
    private var taskActivityObservation: AnyCancellable?
    @Published var selectedViewId = ""
    @Published var viewDraft: JSONValue = .null
    @Published var orderingPending: JSONValue?
    @Published var orderingAccess: Bool?
    @Published var orderingNotice: String?
    private var viewBaseline: JSONValue = .null
    private(set) var viewRevision = 0
    private var pendingInitialViewId: String?

    init(api: MichiAPI, databaseId: String, workspaceId: String, initialViewId: String? = nil) {
        self.api = api
        self.databaseId = databaseId
        self.workspaceId = workspaceId
        pendingInitialViewId = initialViewId
        conversations = FeatureDatabaseConversationModel(api: api)
        taskActivity = NativeTaskActivityModel(api: api, databaseId: databaseId, workspaceId: workspaceId)
        taskActivityObservation = taskActivity.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        restoreDatabaseOrdering()
    }

    var revision: Int { database["revision"].intValue }
    var columns: [JSONValue] { database["columns"].arrayValue }
    var rows: [JSONValue] { database["rows"].arrayValue }
    var views: [JSONValue] { database["views"].arrayValue }
    var isTasks: Bool { database["role"].stringValue == "tasks" }
    var selectedView: JSONValue {
        views.first { $0.id.utf8.elementsEqual(selectedViewId.utf8) } ?? views.first ?? .null
    }
    var viewDirty: Bool { featureViewDraftIsDirty(viewDraft, selected: viewBaseline.isNull ? selectedView : viewBaseline) }
    var effectiveView: JSONValue { viewDirty ? viewDraft : selectedView }
    var visibleRows: [JSONValue] {
        featureApplyView(rows: rows, columns: columns, config: featureEffectiveViewConfig(effectiveView, columns: columns), conversation: conversationLookup)
    }
    var boardGroups: [(key: String?, label: String, rows: [JSONValue])] {
        featureBoardGroups(rows: visibleRows, columns: columns, config: featureEffectiveViewConfig(effectiveView, columns: columns))
    }

    func refresh() async {
        guard !loading, !saving else { return }
        loading = true
        defer { loading = false }
        do {
            let loaded = featureUnwrap(try await FeatureAPI.get(api, "/databases/\(FeatureAPI.segment(databaseId))"), "database")
            applyDatabase(loaded, replacingViewDraft: false)
            await refreshConversations()
            if isTasks {
                await taskActivity.load()
                activity = taskActivity.payload
            }
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func refreshConversations() async {
        await conversations.refresh(workspaceID: workspaceId, rows: rows, columns: columns)
        conversationLookup = conversations.lookup; conversationError = conversations.error
    }

    @discardableResult
    func decideTaskSuggestion(_ change: JSONValue, action: FeaturePageChangeAction, edited: JSONValue? = nil) async -> Bool {
        let ok = await taskActivity.decide(change, action: action, edited: edited)
        let decisionError = taskActivity.error
        await refresh()
        if !ok, let decisionError {
            taskActivity.error = decisionError
            if error == nil { error = decisionError }
        }
        return ok
    }

    func addTask() async {
        await applyOps([[
            "op": "row.add",
            "values": [
                "task": .string("New task"),
                "status": "todo",
            ],
        ]])
    }

    func addBlankRow() async {
        await applyOps([["op": "row.add", "values": [:]]])
    }

    func updateRow(_ operation: JSONValue) async -> Bool {
        await applyOps([operation])
    }

    @discardableResult
    func deleteRow(_ row: JSONValue) async -> Bool {
        await applyOps([[
            "op": "row.delete",
            "id": .string(row.id),
            "expectRev": .number(Double(row["rev"].intValue)),
        ]])
    }

    @discardableResult
    private func applyOps(_ ops: [JSONValue], expectedRevision: Int? = nil) async -> Bool {
        guard !saving, !loading else { return false }
        guard revision > 0 else {
            error = "Reload the database before editing."
            return false
        }
        saving = true
        defer { saving = false }
        do {
            let result = try await FeatureAPI.send(
                api,
                "/databases/\(FeatureAPI.segment(databaseId))/edits",
                method: "POST",
                body: ["revision": .number(Double(expectedRevision ?? revision)), "ops": .array(ops)]
            )
            let rejected = result["changes"]["rejected"].arrayValue
            if let first = rejected.first {
                throw FeatureRequestError(message: first["message"].optionalString ?? "Revision conflict. Reload and try again.")
            }
            let replaceDraft = ops.contains { ["view.save", "view.delete"].contains($0["op"].stringValue) }
            applyDatabase(try featureRequireDatabase(result), replacingViewDraft: replaceDraft)
            error = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }

    func selectView(_ id: String) {
        guard !id.isEmpty else { return }
        let dirty = featureViewDraftIsDirty(viewDraft, selected: viewBaseline.isNull ? selectedView : viewBaseline)
        guard !dirty else { return }
        selectedViewId = id
        viewDraft = selectedView; viewBaseline = selectedView; viewRevision = revision
    }

    func discardViewChanges() {
        viewDraft = selectedView; viewBaseline = selectedView; viewRevision = revision
    }

    func saveViewDraft() async -> Bool {
        guard !saving else { return false }
        guard viewDirty else { return true }
        do {
            return await applyOps([try featureViewSaveOperation(from: viewDraft)], expectedRevision: viewRevision)
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }

    func addBoardView() async -> Bool {
        let group = columns.first { $0["type"].stringValue == "select" }?.id ?? ""
        var view: JSONValue = [
            "name": "Board",
            "type": "board",
            "config": featureEmptyViewConfig(),
        ]
        if !group.isEmpty { view["config"]["group"] = .string(group) }
        do {
            return await applyOps([try featureViewSaveOperation(from: view)])
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }

    func addColumn(name: String, type: String) async -> Bool {
        do {
            return await applyOps([try featureColumnAddOperation(name: name, type: type)])
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }

    func renameColumn(_ column: JSONValue, name: String) async -> Bool {
        do {
            return await applyOps([try featureColumnUpdateOperation(id: column.id, patch: ["name": .string(name)])])
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }

    func addOption(columnId: String, value: String) async -> Bool {
        do {
            return await applyOps([try featureOptionAddOperation(columnId: columnId, value: value)])
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }

    func moveBoardCard(_ row: JSONValue, to key: String?) async -> Bool {
        let config = featureEffectiveViewConfig(effectiveView, columns: columns)
        guard let column = columns.first(where: { $0.id == config["group"].stringValue }) else { return false }
        do {
            return await applyOps([try featureBoardMoveOperation(row: row, groupColumn: column, key: key)])
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }

    private func applyDatabase(_ loaded: JSONValue, replacingViewDraft: Bool) {
        let dirty = featureViewDraftIsDirty(viewDraft, selected: viewBaseline.isNull ? selectedView : viewBaseline)
        database = loaded
        if let requested = pendingInitialViewId {
            if views.contains(where: { $0.id.utf8.elementsEqual(requested.utf8) }) { selectedViewId = requested }
            pendingInitialViewId = nil
        }
        if selectedViewId.isEmpty || !loaded["views"].arrayValue.contains(where: { $0.id.utf8.elementsEqual(selectedViewId.utf8) }) {
            selectedViewId = loaded["views"].arrayValue.first?.id ?? ""
        }
        if replacingViewDraft || !dirty { viewDraft = selectedView; viewBaseline = selectedView; viewRevision = revision }
    }
    /// Ordering changes preserve the original revision and opaque contents of
    /// an unsaved view draft; only the returned database snapshot is replaced.
    func applyOrderedDatabase(_ loaded: JSONValue) { applyDatabase(loaded, replacingViewDraft: false) }
}

func featureRowTitle(_ row: JSONValue, columns: [JSONValue], isTasks: Bool) -> String {
    if isTasks {
        let task = row["values"]["task"].stringValue
        return task.isEmpty ? "Untitled task" : task
    }
    // Match shared/database/viewModel.titleColumn: visual order may start with
    // a number/select after a drag, while the first text column is still the title.
    if let first = columns.first(where: { $0["type"].stringValue == "text" }) ?? columns.first {
        let text = featureCellText(row["values"][first.id], type: first["type"].stringValue)
        if !text.isEmpty { return text }
    }
    return "Row"
}

func featureTaskStatusLabel(_ value: JSONValue) -> String {
    switch value.stringValue {
    case "todo": return "To do"
    case "doing": return "In progress"
    case "waiting": return "Waiting on you"
    case "done": return "Done"
    default: return value.stringValue.isEmpty ? "No status" : value.stringValue
    }
}

func featureCellText(_ value: JSONValue, type: String) -> String {
    if value.isNull { return "—" }
    switch type {
    case "checkbox": return value.boolValue ? "Yes" : "No"
    case "date":
        if let start = value["start"].optionalString {
            let end = value["end"].stringValue
            return end.isEmpty ? start : "\(start) – \(end)"
        }
    case "progress":
        if let number = value.featureOptionalNumber { return "\(featureNumberText(number * 100))%" }
    default: break
    }
    if let number = value.featureOptionalNumber { return featureNumberText(number) }
    if let string = value.optionalString { return string }
    if !value.arrayValue.isEmpty { return featureStringList(value).joined(separator: ", ") }
    return "—"
}

private func featureNumberText(_ number: Double) -> String {
    // JSON can contain finite numbers outside Int's range.
    if number.isFinite, number.rounded() == number,
       number >= Double(Int.min), number < Double(Int.max) { return String(Int(number)) }
    return String(number)
}

func featureCellDraft(_ value: JSONValue, type: String = "") -> String {
    if let flag = value.featureOptionalBool { return flag ? "true" : "false" }
    if let number = value.featureOptionalNumber { return featureNumberText(type == "progress" ? number * 100 : number) }
    if let text = value.optionalString { return text }
    return featureStringList(value).joined(separator: ", ")
}

func featureCanEditColumn(_ column: JSONValue) -> Bool {
    guard column["editable"].featureOptionalBool != false else { return false }
    // Keep structured values read-only until an editor can preserve their complete shape.
    return ["text", "url", "select", "status", "checkbox", "number", "progress"].contains(column["type"].stringValue)
}

func featureParseCell(_ draft: String, type: String) throws -> JSONValue {
    switch type {
    case "checkbox":
        guard draft == "true" || draft == "false" else { throw FeatureRequestError(message: "Choose a checkbox value.") }
        return .bool(draft == "true")
    case "number", "progress":
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .null }
        guard let number = Double(trimmed), number.isFinite else {
            throw FeatureRequestError(message: "Enter a valid, finite number.")
        }
        if type == "progress" {
            guard (0...100).contains(number) else { throw FeatureRequestError(message: "Progress must be between 0 and 100%.") }
            return .number(number / 100)
        }
        return .number(number)
    case "select", "status": return draft.isEmpty ? .null : .string(draft)
    case "text", "url": return .string(draft)
    default: throw FeatureRequestError(message: "This cell cannot be edited here.")
    }
}

/// Build a partial update from the original row. Untouched fields must not be
/// resubmitted: the backend uses submitted keys to establish human ownership.
func featureDatabaseRowUpdate(baseline: JSONValue, columns: [JSONValue], drafts: [String: String], body: String) throws -> JSONValue? {
    guard !baseline.id.isEmpty, baseline["rev"].intValue > 0 else {
        throw FeatureRequestError(message: "Reload this row before editing.")
    }
    var values: [String: JSONValue] = [:]
    for column in columns where featureCanEditColumn(column) {
        let original = baseline["values"][column.id]
        let type = column["type"].stringValue
        guard let draft = drafts[column.id], draft != featureCellDraft(original, type: type) else { continue }
        let parsed = try featureParseCell(draft, type: type)
        if parsed != original { values[column.id] = parsed }
    }
    let bodyChanged = body != baseline["body"].stringValue
    guard !values.isEmpty || bodyChanged else { return nil }
    var operation: [String: JSONValue] = [
        "op": "row.update", "id": .string(baseline.id), "expectRev": baseline["rev"],
    ]
    if !values.isEmpty { operation["values"] = .object(values) }
    if bodyChanged { operation["body"] = .string(body) }
    return .object(operation)
}
