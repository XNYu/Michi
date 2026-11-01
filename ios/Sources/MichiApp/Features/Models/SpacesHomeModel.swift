import Foundation
import Combine
import MichiCore

func featureSpacesHomePath() -> String { "/spaces-home" }

func featureSpacesHomeWorkspacesPath() -> String { "/spaces-home/workspaces" }

func featureSpacesHomeSectionsPath() -> String { "/spaces-home/sections" }

func featureSpacesHomeAllTasksPath() -> String { "/spaces-home/all-tasks" }

func featureSpacesHomeAllTasksViewsPath() -> String { "/spaces-home/all-tasks/views" }

func featureWorkspaceHomePath(_ workspaceId: String) -> String {
    "/workspaces/\(FeatureAPI.segment(workspaceId))/home"
}

func featurePageTrashPath(_ workspaceId: String, cursor: String? = nil) -> String {
    "/workspaces/\(FeatureAPI.segment(workspaceId))/pages/trash" + FeatureAPI.query([("cursor", cursor)])
}

func featurePageRestorePath(_ pageId: String) -> String {
    "/pages/\(FeatureAPI.segment(pageId))/restore"
}

func featurePagePurgePath(_ pageId: String) -> String {
    "/pages/\(FeatureAPI.segment(pageId))/permanent"
}

func featureWorkspaceHomeHiddenBody(hidden: Bool) -> JSONValue {
    ["hidden": .bool(hidden)]
}

func featureAllTasksViewsBody(revision: Int, ops: [JSONValue]) throws -> JSONValue {
    guard revision >= 0, !ops.isEmpty else {
        throw FeatureRequestError(message: "Reload All tasks before saving views.")
    }
    if ops.contains(where: { $0["op"].stringValue != "view.save" && $0["op"].stringValue != "view.delete" }) {
        throw FeatureRequestError(message: "All tasks saves only its views.")
    }
    if ops.contains(where: { $0["op"].stringValue == "view.save" && $0["view"]["type"].stringValue == "custom" }) {
        throw FeatureRequestError(message: "All tasks has no custom views.")
    }
    return ["revision": .number(Double(revision)), "ops": .array(ops)]
}

func featureAllTasksSource(for databaseId: String, in payload: JSONValue) -> JSONValue? {
    payload["sources"].arrayValue.first { $0["databaseId"].stringValue == databaseId }
}

func featureAllTasksRowEntries(_ payload: JSONValue) -> [JSONValue] {
    payload["rows"].arrayValue
}

func featureAllTasksWorkspaceValue(_ source: JSONValue) -> JSONValue {
    .string(source["workspaceId"].stringValue)
}

func featureAllTasksStrippedRowOperation(_ operation: JSONValue) -> JSONValue {
    guard operation["op"].stringValue == "row.update" else { return operation }
    var values = operation["values"].objectValue
    values.removeValue(forKey: "workspace")
    var next = operation.objectValue
    if values.isEmpty {
        next.removeValue(forKey: "values")
        if next["body"] == nil { return .null }
    } else {
        next["values"] = .object(values)
    }
    return .object(next)
}

/// Dirty All tasks view drafts keep the revision they were based on.
func featureRetainLoadedRevision(current: Int, baseline: Int, dirty: Bool) -> Int {
    dirty ? baseline : current
}

func featureRequireAllTasksViews(_ payload: JSONValue) throws -> (views: JSONValue, revision: Int) {
    guard case .array = payload["views"] else {
        throw FeatureRequestError(message: "All tasks did not return saved views.")
    }
    guard let revision = payload["viewsRevision"].featureOptionalNumber else {
        throw FeatureRequestError(message: "All tasks did not return a views revision.")
    }
    return (payload["views"], Int(revision))
}

func featureRequireRestoredPageIds(_ payload: JSONValue, pageId: String) throws {
    try featureRequirePageWriteReceipt(
        payload["restored"],
        pageId: pageId,
        message: "Pages did not restore this item."
    )
}

func featureRequirePurgedPageIds(_ payload: JSONValue, pageId: String) throws {
    try featureRequirePageWriteReceipt(
        payload["purged"],
        pageId: pageId,
        message: "Pages did not permanently delete this item."
    )
}

/// Live restore/purge receipts are a strict positive member count. Legacy
/// responses remain an array of opaque page ids compared byte for byte.
private func featureRequirePageWriteReceipt(_ value: JSONValue, pageId: String, message: String) throws {
    switch value {
    case .number(let count):
        guard count.isFinite,
              count >= 1,
              count <= 9_007_199_254_740_991,
              count.rounded(.towardZero) == count else {
            throw FeatureRequestError(message: message)
        }
    case .array(let items):
        let matched = items.contains { item in
            if case .string(let id) = item { return id.utf8.elementsEqual(pageId.utf8) }
            return false
        }
        guard matched else { throw FeatureRequestError(message: message) }
    default:
        throw FeatureRequestError(message: message)
    }
}

struct FeatureOpenedPage: Identifiable, Hashable {
    let id: String
    let workspaceId: String
}

@MainActor
final class FeatureSpacesHomeModel: ObservableObject {
    let api: MichiAPI
    @Published var workspaces: [JSONValue]
    @Published var home: JSONValue = .null
    @Published var workspaceHomes: [JSONValue] = []
    @Published var sections: JSONValue = .null
    @Published var allTasks: JSONValue = .null
    @Published var loading = false
    @Published var error: String?
    @Published var openedPage: FeatureOpenedPage?
    @Published var openedAllTasks = false
    @Published var openedTrashWorkspaceId: String?

    init(api: MichiAPI, workspaces: [JSONValue]) {
        self.api = api
        self.workspaces = workspaces
    }

    var homePage: JSONValue { featureUnwrap(home, "page") }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            async let homePayload = FeatureAPI.get(api, featureSpacesHomePath())
            async let homesPayload = FeatureAPI.get(api, featureSpacesHomeWorkspacesPath())
            async let sectionPayload = FeatureAPI.get(api, featureSpacesHomeSectionsPath())
            async let tasksPayload = FeatureAPI.get(api, featureSpacesHomeAllTasksPath())
            home = try await homePayload
            workspaceHomes = featureItems(try await homesPayload)
            sections = try await sectionPayload
            allTasks = try await tasksPayload
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func openHome() {
        let page = homePage
        guard !page.id.isEmpty else { return }
        openedPage = FeatureOpenedPage(id: page.id, workspaceId: page["workspaceId"].stringValue)
    }

    func openWorkspaceHome(_ workspaceId: String) async {
        do {
            let payload = try await FeatureAPI.get(api, featureWorkspaceHomePath(workspaceId))
            let page = featureUnwrap(payload, "page")
            guard !page.id.isEmpty else { throw FeatureRequestError(message: "This workspace has no home page yet.") }
            openedPage = FeatureOpenedPage(id: page.id, workspaceId: page["workspaceId"].stringValue.isEmpty ? workspaceId : page["workspaceId"].stringValue)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func setWorkspaceHomeHidden(_ workspaceId: String, hidden: Bool) async {
        do {
            let payload = try await FeatureAPI.send(
                api,
                featureWorkspaceHomePath(workspaceId),
                method: "PATCH",
                body: featureWorkspaceHomeHiddenBody(hidden: hidden)
            )
            if let index = workspaceHomes.firstIndex(where: { $0["workspaceId"].stringValue == workspaceId }) {
                workspaceHomes[index] = payload
            }
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }
}

@MainActor
final class FeaturePageTrashModel: ObservableObject {
    let api: MichiAPI
    let workspaceId: String
    @Published var groups: [JSONValue] = []
    @Published var loading = false
    @Published var saving = false
    @Published var error: String?
    @Published var restoredPage: FeatureOpenedPage?

    init(api: MichiAPI, workspaceId: String) {
        self.api = api
        self.workspaceId = workspaceId
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        var collected: [JSONValue] = []
        var cursor: String?
        var seen = Set<String>()
        do {
            repeat {
                let payload = try await FeatureAPI.get(api, featurePageTrashPath(workspaceId, cursor: cursor))
                collected.append(contentsOf: featureItems(payload))
                cursor = payload["nextCursor"].optionalString
                if let cursor {
                    if seen.contains(cursor) { throw FeatureRequestError(message: "Pages trash pagination did not advance") }
                    seen.insert(cursor)
                }
            } while cursor != nil
            groups = collected
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func restore(_ group: JSONValue) async -> Bool {
        let pageId = group["root"].id.isEmpty ? group["pages"].arrayValue.first?.id ?? "" : group["root"].id
        guard !pageId.isEmpty else { return false }
        return await mutate {
            let result = try await FeatureAPI.send(api, featurePageRestorePath(pageId), method: "POST", body: [:])
            try featureRequireRestoredPageIds(result, pageId: pageId)
            restoredPage = FeatureOpenedPage(id: pageId, workspaceId: workspaceId)
            await refresh()
        }
    }

    func purge(_ group: JSONValue) async -> Bool {
        let pageId = group["root"].id.isEmpty ? group["pages"].arrayValue.first?.id ?? "" : group["root"].id
        guard !pageId.isEmpty else { return false }
        return await mutate {
            let result = try await FeatureAPI.send(api, featurePagePurgePath(pageId), method: "DELETE", body: [:])
            try featureRequirePurgedPageIds(result, pageId: pageId)
            await refresh()
        }
    }

    @discardableResult
    private func mutate(_ work: () async throws -> Void) async -> Bool {
        guard !saving else { return false }
        saving = true
        defer { saving = false }
        do {
            try await work()
            error = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }
}

@MainActor
final class FeatureAllTasksModel: ObservableObject {
    let api: MichiAPI
    let conversations: FeatureDatabaseConversationModel
    @Published var conversationLookup: FeatureConversationLookup?
    @Published var conversationError: String?
    @Published var payload: JSONValue = .null
    @Published var selectedViewId = "tasks-board"
    @Published var viewDraft: JSONValue = .null
    private var viewBaseline: JSONValue = .null
    @Published var viewRevision = 0
    @Published var loading = false
    @Published var saving = false
    @Published var error: String?

    init(api: MichiAPI) {
        self.api = api
        conversations = FeatureDatabaseConversationModel(api: api)
    }

    var sources: [JSONValue] { payload["sources"].arrayValue }
    var views: [JSONValue] { payload["views"].arrayValue }
    var viewDirty: Bool { featureViewDraftIsDirty(viewDraft, selected: viewBaseline.isNull ? selectedView : viewBaseline) }

    var selectedView: JSONValue {
        views.first { $0.id == selectedViewId } ?? views.first ?? .null
    }

    var columns: [JSONValue] {
        var columns = sources.first.flatMap { _ in payload["columns"].arrayValue } ?? []
        if columns.isEmpty {
            columns = [
                ["id": "task", "name": "Task", "type": "text"],
                ["id": "status", "name": "Status", "type": "select", "options": [
                    ["value": "todo", "label": "To do"],
                    ["value": "doing", "label": "In progress"],
                    ["value": "waiting", "label": "Waiting on you"],
                    ["value": "done", "label": "Done"],
                ]],
                ["id": "threads", "name": "Conversations", "type": "threads"],
                ["id": "next", "name": "Next step", "type": "text"],
                ["id": "workspace", "name": "Workspace", "type": "select", "options": .array(sources.map {
                    ["value": $0["workspaceId"], "label": $0["workspaceName"]]
                })],
            ]
        }
        if !columns.contains(where: { $0.id == "workspace" }) {
            columns.append([
                "id": "workspace", "name": "Workspace", "type": "select", "editable": false,
                "options": .array(sources.map { ["value": $0["workspaceId"], "label": $0["workspaceName"]] }),
            ])
        }
        if let index = columns.firstIndex(where: { $0.id == "status" }) {
            var options = columns[index]["options"].arrayValue
            var known = Set(options.map { $0["value"].stringValue })
            for option in sources.flatMap({ $0["statuses"].arrayValue }) {
                let value = option["value"].stringValue
                if !value.isEmpty && known.insert(value).inserted { options.append(option) }
            }
            columns[index]["options"] = .array(options)
        }
        return columns
    }

    var displayRows: [JSONValue] {
        featureAllTasksRowEntries(payload).map { entry in
            let row = entry["row"]
            var values = row["values"].objectValue
            values["workspace"] = featureAllTasksWorkspaceValue(featureAllTasksSource(for: entry["databaseId"].stringValue, in: payload) ?? [:])
            return row.merging(["values": .object(values), "databaseId": entry["databaseId"]])
        }
    }

    func displayRow(matching identity: NativeTaskRowIdentity) -> JSONValue? {
        displayRows.first { $0.nativeTaskRowIdentity == identity }
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            let loaded = try await FeatureAPI.get(api, featureSpacesHomeAllTasksPath())
            apply(loaded)
            await refreshConversations()
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func refreshConversations() async {
        await conversations.refresh(allTasks: payload)
        conversationLookup = conversations.lookup; conversationError = conversations.error
    }
    func selectView(_ id: String) {
        guard !id.isEmpty else { return }
        let dirty = featureViewDraftIsDirty(viewDraft, selected: viewBaseline.isNull ? selectedView : viewBaseline)
        guard !dirty else { return }
        selectedViewId = id
        viewDraft = selectedView; viewBaseline = selectedView
    }

    func discardViewChanges() {
        viewDraft = selectedView; viewBaseline = selectedView
        viewRevision = payload["viewsRevision"].intValue
    }

    func saveViewDraft() async -> Bool {
        guard !saving else { return false }
        guard viewDirty else { return true }
        do {
            let op = try featureViewSaveOperation(from: viewDraft)
            return await saveViews([op])
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }

    func saveViews(_ ops: [JSONValue]) async -> Bool {
        guard !saving else { return false }
        let expected = viewRevision
        return await mutate {
            let body = try featureAllTasksViewsBody(revision: expected, ops: ops)
            let result = try await FeatureAPI.send(api, featureSpacesHomeAllTasksViewsPath(), method: "POST", body: body)
            let saved = try featureRequireAllTasksViews(result)
            payload = payload.merging([
                "views": saved.views,
                "viewsRevision": .number(Double(saved.revision)),
            ])
            viewRevision = saved.revision
            viewDraft = selectedView; viewBaseline = selectedView
        }
    }

    func updateSourceRow(databaseId: String, operation: JSONValue) async -> Bool {
        guard !saving else { return false }
        let operation = featureAllTasksStrippedRowOperation(operation)
        if operation.isNull { return true }
        guard let source = featureAllTasksSource(for: databaseId, in: payload) else {
            error = "This task’s workspace is no longer on All tasks."
            return false
        }
        let revision = source["revision"].intValue
        guard revision > 0 else {
            error = "Reload All tasks before editing."
            return false
        }
        return await mutate {
            let result = try await FeatureAPI.send(
                api,
                "/databases/\(FeatureAPI.segment(databaseId))/edits",
                method: "POST",
                body: ["revision": .number(Double(revision)), "ops": .array([operation])]
            )
            let rejected = result["changes"]["rejected"].arrayValue
            if let first = rejected.first {
                throw FeatureRequestError(message: first["message"].optionalString ?? "Revision conflict. Reload and try again.")
            }
            let database = try featureRequireDatabase(result)
            guard database.id == databaseId else {
                throw FeatureRequestError(message: "The database update did not return a saved revision.")
            }
            replaceSource(database)
        }
    }

    private func replaceSource(_ database: JSONValue) {
        let sources = payload["sources"].arrayValue.map { source -> JSONValue in
            guard source["databaseId"].stringValue == database.id else { return source }
            return source.merging(["revision": database["revision"]])
        }
        let rows = payload["rows"].arrayValue.map { entry -> JSONValue in
            guard entry["databaseId"].stringValue == database.id else { return entry }
            if let row = database["rows"].arrayValue.first(where: { $0.id == entry["row"].id }) {
                return entry.merging(["row": row])
            }
            return entry
        }.filter { entry in
            entry["databaseId"].stringValue != database.id
                || database["rows"].arrayValue.contains { $0.id == entry["row"].id }
        }
        payload = payload.merging(["sources": .array(sources), "rows": .array(rows)])
    }

    private func apply(_ loaded: JSONValue) {
        let dirty = featureViewDraftIsDirty(viewDraft, selected: viewBaseline.isNull ? selectedView : viewBaseline)
        if dirty {
            payload = loaded
            return
        }
        payload = loaded
        viewRevision = loaded["viewsRevision"].intValue
        if selectedViewId.isEmpty || !loaded["views"].arrayValue.contains(where: { $0.id == selectedViewId }) {
            selectedViewId = loaded["views"].arrayValue.first?.id ?? "tasks-board"
        }
        viewDraft = selectedView; viewBaseline = selectedView
    }

    @discardableResult
    private func mutate(_ work: () async throws -> Void) async -> Bool {
        guard !saving else { return false }
        saving = true
        defer { saving = false }
        do {
            try await work()
            error = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }
}

extension FeatureAllTasksModel {
    var effectiveBoard: Bool { (viewDirty ? viewDraft : selectedView)["type"].stringValue == "board" }
    var visibleRows: [JSONValue] {
        featureApplyView(rows: displayRows, columns: columns, config: featureEffectiveViewConfig(viewDirty ? viewDraft : selectedView, columns: columns), conversation: conversationLookup)
    }
    var boardGroups: [(key: String?, label: String, rows: [JSONValue])] {
        featureBoardGroups(rows: visibleRows, columns: columns, config: featureEffectiveViewConfig(viewDirty ? viewDraft : selectedView, columns: columns))
    }
}
