import SwiftUI
import MichiCore

struct FeatureDatabaseScreen: View {
    let api: MichiAPI
    let databaseId: String
    let workspaceId: String

    @StateObject private var model: FeatureDatabaseModel
    @State private var openedRow: EntityRef?
    @State private var hostDestination: FeatureDatabaseHostDestination?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.michiTokens) private var tokens

    init(api: MichiAPI, databaseId: String, workspaceId: String, initialViewId: String? = nil) {
        self.api = api
        self.databaseId = databaseId
        self.workspaceId = workspaceId
        _model = StateObject(wrappedValue: FeatureDatabaseModel(api: api, databaseId: databaseId, workspaceId: workspaceId, initialViewId: initialViewId))
    }

    var body: some View {
        Group {
            if model.loading && model.database.isNull {
                FeatureLoadingView(message: "Loading database")
            } else if let error = model.error, model.database.isNull {
                FeatureStatusBanner(title: "Couldn’t load database", message: error, retry: { Task { await model.refresh() } })
                    .padding()
            } else {
                List {
                    if let error = model.error {
                        FeatureStatusBanner(title: "Update failed", message: error, retry: { Task { await model.refresh() } })
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                    if let error = model.conversationError { Text(error).font(.caption).foregroundStyle(.secondary) }
                    if model.orderingPending != nil {
                        Section {
                            Label("A move may already be saved. It was not retried, and moving is paused until it is checked.", systemImage: "exclamationmark.arrow.circlepath")
                                .font(.footnote)
                            NavigationLink("Check saved order") { DatabaseOrderingScreen(model: model) }
                        }
                    }
                    Section {
                        Text(featureNamed(model.database, fallback: "Database"))
                            .font(MichiFont.sans(size: 22, relativeTo: .title2, weight: .semibold))
                            .foregroundStyle(tokens.fg)
                        Text("Revision \(model.revision)")
                            .font(MichiFont.meta)
                            .foregroundStyle(tokens.muted)
                        if model.isTasks {
                            Label("Task database", systemImage: "checkmark.circle")
                                .font(MichiFont.rowSecondary)
                                .foregroundStyle(tokens.muted)
                        }
                        if !model.views.isEmpty {
                            Picker("View", selection: Binding(
                                get: { model.selectedViewId },
                                set: { model.selectView($0) }
                            )) {
                                ForEach(model.views, id: \.id) { view in
                                    Text(featureNamed(view, fallback: view["type"].stringValue)).tag(view.id)
                                }
                            }
                            .pickerStyle(.segmented)
                        }
                        viewChips
                        customViewHost
                    }
                    if model.viewDirty {
                        Section("Unsaved view") {
                            Text("This draft still uses the original database revision \(model.viewRevision).")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Button("Save filters and sorts") { Task { await model.saveViewDraft() } }
                            Button("Discard view changes") { model.discardViewChanges() }
                        }
                    }
                    Section {
                        NavigationLink("Manage views & columns") { DatabaseManagementScreen(model: model) }
                        NavigationLink("Arrange rows & columns") { DatabaseOrderingScreen(model: model) }
                        NavigationLink("Workspace components") { NativeComponentLibraryScreen(api: api, workspaceID: model.workspaceId) }
                        NavigationLink(model.selectedView["type"].stringValue == "custom" ? "Bind custom view" : "Create custom view") {
                            NativeComponentDatabaseBindingScreen(model: model)
                        }
                        NavigationLink("Filter, sort, and board") {
                            FeatureViewEditor(view: $model.viewDraft, columns: model.columns)
                                .navigationTitle("View")
                                .toolbar {
                                    ToolbarItem(placement: .confirmationAction) {
                                        Button("Save") { Task { await model.saveViewDraft() } }
                                    }
                                }
                        }
                        Button("Add board view") { Task { await model.addBoardView() } }
                        NavigationLink("Edit schema") {
                            FeatureSchemaEditor(model: model)
                        }
                    } header: {
                        MichiSectionHeader(title: "View")
                    }
                    if model.isTasks {
                        Section("Task controls") {
                            Button("Add task") { Task { await model.addTask() } }
                            if let summary = model.taskActivity.snapshot?.latestUpkeep.flatMap(nativeTaskUpkeepSummary) {
                                Text(summary)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            if let unsupported = model.taskActivity.unsupported {
                                Text(unsupported)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            if let error = model.taskActivity.error {
                                Text(error).font(.footnote).foregroundStyle(.red)
                                Button("Reload task activity") { Task { await model.refresh() } }
                            }
                            if !model.activity.isNull {
                                NavigationLink("Inspect stored activity") {
                                    FeatureInspectView(value: model.activity, title: "Task activity")
                                }
                                .font(.footnote)
                            }
                        }
                    }
                    if hostedCustomView == nil {
                    if ["calendar", "gallery", "timeline"].contains(model.effectiveView["type"].stringValue) {
                        Section {
                            NativeDatabaseLayoutView(type: model.effectiveView["type"].stringValue, rows: model.visibleRows, columns: model.columns, config: featureEffectiveViewConfig(model.effectiveView, columns: model.columns), isTasks: model.isTasks, isThreads: model.database["kind"] == "threads", disabled: model.saving, onOpenRow: { openedRow = EntityRef($0) }, onMoveDate: { row, column, day in
                                do { guard let op = try nativeDatabaseCalendarMoveOperation(row: row, column: column, to: day) else { return true }; return await model.updateRow(op) }
                                catch { model.error = error.localizedDescription; return false }
                            }, onConfigChange: { model.viewDraft["config"] = $0 }, rowOrdering: galleryOrdering)
                        }
                    } else if model.effectiveView["type"].stringValue == "board" {
                        Section {
                            DesignPagesBoardLayout(model: model, openedRow: $openedRow)
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    } else {
                        // The drawn rows travel with each drag so a refreshed list
                        // is never reordered from stale offsets.
                        let drawn = DatabaseOrderingGroup(key: nil, title: "Rows", rows: model.visibleRows)
                        Section("Rows") {
                            if model.visibleRows.isEmpty {
                                Text("No rows.")
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(drawn.rows, id: \.id) { row in
                                NavigationLink {
                                    FeatureDatabaseRowScreen(model: model, row: row)
                                } label: {
                                    rowLabel(row)
                                }
                                .swipeActions {
                                    Button(role: .destructive) {
                                        Task { await model.deleteRow(row) }
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                                .moveDisabled(!model.rowDragEnabled)
                            }
                            .onMove(perform: rowMove(drawn))
                        }
                    }
                    }
                    if !model.isTasks {
                        Section {
                            Button("Add row") { Task { await model.addBlankRow() } }
                        }
                    }
                    let columnIDs = model.columns.map(\.id)
                    Section("Columns") {
                        ForEach(model.columns, id: \.id) { column in
                            LabeledContent(column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue, value: column["type"].stringValue)
                                .moveDisabled(model.orderingBlocked)
                        }
                        .onMove(perform: columnMove(columnIDs))
                    }
                }
                .michiPlainList()
            }
        }
        .navigationTitle(featureNamed(model.database, fallback: "Database"))
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .nativeMichiReferences(api: api)
        .navigationDestination(item: $hostDestination) { destination in
            switch destination {
            case .page(let id):
                FeaturePageScreen(api: api, pageId: id, workspaceId: model.workspaceId, workspaces: [])
            case .assistant(let draft):
                NativeSpacesAssistantScreen(api: api, workspaceID: model.workspaceId, initialPrompt: draft)
            }
        }
        .sheet(item: $openedRow) { row in NavigationStack { FeatureDatabaseRowScreen(model: model, row: row.value).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { openedRow = nil } } } } }
        .refreshable { await model.refresh() }
        .featureBusy(model.saving)
        .task { await model.refresh() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { break }
                if !Task.isCancelled { await model.refreshConversations() }
            }
        }
    }
    @ViewBuilder private var viewChips: some View {
        let filters = model.effectiveView["config"]["filters"].arrayValue
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(filters.enumerated()), id: \.offset) { _, filter in
                    NavigationLink {
                        FeatureViewEditor(view: $model.viewDraft, columns: model.columns)
                            .navigationTitle("View")
                            .toolbar {
                                ToolbarItem(placement: .confirmationAction) {
                                    Button("Save") { Task { await model.saveViewDraft() } }
                                }
                            }
                    } label: {
                        Text(filterChipTitle(filter))
                            .font(MichiFont.chip)
                            .foregroundStyle(tokens.accentText)
                            .padding(.horizontal, 10)
                            .frame(height: 28)
                            .background(tokens.accentF, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                NavigationLink {
                    FeatureViewEditor(view: $model.viewDraft, columns: model.columns)
                        .navigationTitle("View")
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Save") { Task { await model.saveViewDraft() } }
                            }
                        }
                } label: {
                    Label("Filter", systemImage: "line.3.horizontal.decrease")
                        .font(MichiFont.chip)
                        .foregroundStyle(tokens.mid)
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .overlay { Capsule().stroke(tokens.line, lineWidth: 1) }
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Long-press drag sends one revision-checked row.move; nil while the view
    /// is sorted, read-only, busy, or a previous move is unconfirmed.
    private func rowMove(_ drawn: DatabaseOrderingGroup) -> ((IndexSet, Int) -> Void)? {
        guard model.rowDragEnabled else { return nil }
        let model = self.model
        return { source, destination in Task { await model.dropOrderedRow(in: drawn, from: source, to: destination) } }
    }
    private func columnMove(_ snapshot: [String]) -> ((IndexSet, Int) -> Void)? {
        guard !model.orderingBlocked else { return nil }
        let model = self.model
        return { source, destination in Task { await model.dropOrderedColumn(from: source, to: destination, snapshot: snapshot) } }
    }
    /// Gallery cards can be dropped on one another within the visible rows.
    private var galleryOrdering: NativeDatabaseRowOrdering? {
        guard model.effectiveView["type"] == "gallery", model.rowDragEnabled, let group = model.orderingRowGroups.first else { return nil }
        let model = self.model
        return NativeDatabaseRowOrdering(
            item: { model.orderingDragItem(row: $0.id, in: group) },
            accepts: { model.orderingDropRejection($0, kind: .row) == nil },
            onDrop: { item, target in Task { await model.dropOrderedRow(item, onto: target.id) } },
            onStep: { row, direction in Task { await model.moveOrderedRow(row.id, in: group, direction: direction) } })
    }

    @ViewBuilder private var customViewHost: some View {
        if let prepared = hostedCustomView {
            NativeDatabaseBoundComponentHost(
                api: api,
                workspaceID: model.workspaceId,
                prepared: prepared,
                readOnly: customViewReadOnly,
                onNavigatePage: { hostDestination = .page($0) },
                onAskDraft: { hostDestination = .assistant($0) },
                onDatabaseChanged: { Task { await model.refresh() } }
            )
            customViewLibraryLink
        } else if featureCanHostRegisteredCustomView(model.selectedView) {
            Label("This custom view is paused until the database identity is confirmed.", systemImage: "puzzlepiece.extension")
                .font(.footnote)
                .foregroundStyle(.secondary)
            customViewLibraryLink
        } else if featureIsUnsupportedCustomView(model.selectedView) {
            FeatureUnsupportedCustomNotice(value: model.selectedView)
            if !model.selectedView["config"]["componentId"].stringValue.isEmpty {
                customViewLibraryLink
            }
        }
    }

    @ViewBuilder private var customViewLibraryLink: some View {
        NavigationLink("Component details & versions") {
            NativeComponentLibraryScreen(
                api: api,
                workspaceID: model.workspaceId,
                initialComponentID: model.selectedView["config"]["componentId"].stringValue,
                initialVersion: nativeComponentVersion(model.selectedView["config"]["pinnedVersion"])
            )
        }
    }

    private var customViewReadOnly: Bool {
        NativePageComponentContract.isDatabaseReadOnly(model.database) || model.saving
    }

    private var hostedCustomView: NativePageComponentPreparedHost? {
        let view = model.selectedView
        guard featureCanHostRegisteredCustomView(view) else { return nil }
        return NativePageComponentContract.databaseHost(
            connectionIdentity: api.baseURL.absoluteString,
            credentialIdentity: api.credentialIdentityFingerprint,
            workspaceID: model.workspaceId,
            database: model.database,
            expectedDatabaseID: databaseId,
            view: view,
            data: NativePageComponentContract.customDatabaseViewData(
                database: model.database,
                view: view,
                rows: model.rows,
                columns: model.columns,
                conversation: model.conversationLookup
            )
        )
    }

    private func filterChipTitle(_ filter: JSONValue) -> String {
        let column = model.columns.first { $0.id == filter["column"].stringValue }
        let name = column.flatMap { $0["name"].optionalString } ?? filter["column"].stringValue
        let op = filter["op"].stringValue
        return [name, op].filter { !$0.isEmpty }.joined(separator: " ")
    }

    private func rowLabel(_ row: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(featureRowTitle(row, columns: model.columns, isTasks: model.isTasks)).font(.headline)
            if model.isTasks {
                NativeTaskMarksLine(
                    mark: model.taskActivity.mark(for: row.id),
                    suggested: !model.taskActivity.suggestions(for: row.id).isEmpty
                )
            }
            DatabaseVisibleProperties(row: row, view: model.effectiveView, columns: model.columns, isThreads: model.database["kind"] == "threads")
        }
    }
}

private enum FeatureDatabaseHostDestination: Hashable, Identifiable {
    case page(String)
    case assistant(String)
    var id: String {
        switch self {
        case .page(let id): return "page\u{1e}\(id)"
        case .assistant(let draft): return "draft\u{1e}\(draft)"
        }
    }
}

struct FeatureDatabaseRowLabel: View {
    let row: JSONValue
    let columns: [JSONValue]
    let isTasks: Bool
    var mark: NativeTaskMarkKind? = nil
    var suggested: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(featureRowTitle(row, columns: columns, isTasks: isTasks))
                .font(.headline)
            if isTasks {
                NativeTaskMarksLine(mark: mark, suggested: suggested)
                Text(featureTaskStatusLabel(row["values"]["status"]))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let first = columns.first {
                Text(featureCellText(row["values"][first.id], type: first["type"].stringValue))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

struct NativeTaskMarksLine: View {
    var mark: NativeTaskMarkKind?
    var suggested: Bool

    var body: some View {
        if mark != nil || suggested {
            HStack(spacing: 6) {
                if suggested {
                    Text("Suggestion")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                if let mark {
                    Text(mark == .new ? "New" : "Updated")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct NativeTaskOriginSection: View {
    let api: MichiAPI
    let databaseId: String
    let rowId: String
    @StateObject private var loader: NativeTaskOriginLoader

    init(api: MichiAPI, databaseId: String, rowId: String) {
        self.api = api
        self.databaseId = databaseId
        self.rowId = rowId
        _loader = StateObject(wrappedValue: NativeTaskOriginLoader(api: api, databaseId: databaseId))
    }

    var body: some View {
        let key = nativeTaskOriginRowKey(databaseId: databaseId, rowId: rowId)
        Section("Origin") {
            NativeTaskOriginLine(presentation: loader.presentation, expectedKey: key)
        }
        .id(key)
        .task(id: key) {
            await loader.load(databaseId: databaseId, rowId: rowId)
        }
    }
}

struct NativeTaskOriginLine: View {
    let presentation: NativeTaskOriginPresentation
    let expectedKey: NativeTaskRowIdentity

    var body: some View {
        switch presentation {
        case .idle:
            EmptyView()
        case .loading(let key):
            if key == expectedKey {
                Text("Reading who created this…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .ready(let key, let origin):
            if key == expectedKey {
                Text(nativeTaskOriginSentence(origin))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .absent(let key):
            if key == expectedKey {
                EmptyView()
            }
        case .unsupported(let key, let message, let raw):
            if key == expectedKey {
                VStack(alignment: .leading, spacing: 6) {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    NavigationLink("Inspect stored origin") {
                        FeatureInspectView(value: raw, title: "Origin")
                    }
                    .font(.footnote)
                }
            }
        case .failed(let key, let message):
            if key == expectedKey {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct NativeTaskSuggestionCard: View {
    @ObservedObject var model: FeatureDatabaseModel
    let change: JSONValue

    var body: some View {
        FeaturePageChangeCard(model: model.taskActivity.history, change: change, onDecision: { change, action, edited in
            await model.decideTaskSuggestion(change, action: action, edited: edited)
        })
        .disabled(model.taskActivity.deciding || model.loading)
    }
}

struct FeatureDatabaseRowScreen: View {
    @ObservedObject var model: FeatureDatabaseModel
    let row: JSONValue
    // A draft keeps the revision it was based on, even when the list refreshes.
    @State private var baseline: JSONValue = .null
    @State private var draftColumns: [JSONValue] = []
    @State private var drafts: [String: String] = [:]
    @State private var structured: [String: JSONValue] = [:]
    @State private var bodyText = ""
    @State private var localError: String?
    @State private var confirmDelete = false
    @State private var confirmReload = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            FeatureStructuredRowForm(
                columns: draftColumns,
                isTasks: model.isTasks,
                drafts: $drafts,
                structured: $structured,
                bodyText: $bodyText,
                baseline: baseline,
                error: localError ?? model.error,
                onSave: { Task { await save() } },
                onReload: { confirmReload = true },
                onDelete: { confirmDelete = true }
            )
            NativeLinkedConversations(api: model.api, conversations: model.conversations, ids: model.columns.filter { $0["type"] == "threads" }.flatMap { featureStringList(baseline["values"][$0.id]) })
            if model.isTasks {
                let suggestions = model.taskActivity.suggestions(for: row.id)
                if !suggestions.isEmpty {
                    Section("Suggestions") {
                        ForEach(suggestions, id: \.id) { change in
                            NativeTaskSuggestionCard(model: model, change: change)
                        }
                    }
                }
                if let message = model.taskActivity.error ?? model.taskActivity.history.error {
                    Section("Task activity") {
                        Text(message).font(.footnote).foregroundStyle(.red)
                        Button("Reload task activity") { Task { await model.refresh() } }
                    }
                }
                NativeTaskOriginSection(api: model.api, databaseId: model.databaseId, rowId: row.id)
            }
        }
        .navigationTitle(model.isTasks ? "Task" : "Row")
        .featureBusy(model.saving)
        .onAppear {
            if baseline.isNull { load(row) }
            if model.isTasks { model.taskActivity.seen(row.id) }
        }
        .confirmationDialog("Delete this row?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    if await model.deleteRow(baseline) { dismiss() }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Discard your edits and reload this row?", isPresented: $confirmReload, titleVisibility: .visible) {
            Button("Discard edits and reload", role: .destructive) {
                Task {
                    await model.refresh()
                    if model.error == nil {
                        if let latest = model.rows.first(where: { $0.id == row.id }) {
                            load(latest)
                        } else {
                            localError = "This row no longer exists. Your edits have been kept."
                        }
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func load(_ source: JSONValue) {
        baseline = source
        draftColumns = model.columns
        bodyText = source["body"].stringValue
        drafts = Dictionary(draftColumns.map { column in
            (column.id, featureCellDraft(source["values"][column.id], type: column["type"].stringValue))
        }, uniquingKeysWith: { _, last in last })
        structured = Dictionary(draftColumns.compactMap { column -> (String, JSONValue)? in
            guard featureCanEditStructuredColumn(column) else { return nil }
            return (column.id, featureStructuredCellDraft(source["values"][column.id], type: column["type"].stringValue))
        }, uniquingKeysWith: { _, last in last })
        localError = nil
    }

    private func save() async {
        do {
            guard let operation = try featureDatabaseRowValueUpdate(
                baseline: baseline, columns: draftColumns, drafts: drafts, structured: structured, body: bodyText
            ) else { return }
            localError = nil
            if await model.updateRow(operation), let latest = model.rows.first(where: { $0.id == row.id }) {
                load(latest)
            }
        } catch {
            localError = featureErrorMessage(error)
        }
    }
}

struct FeatureCellField: View {
    let column: JSONValue
    @Binding var text: String

    var body: some View {
        let type = column["type"].stringValue
        let name = column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue
        switch type {
        case "select", "status":
            if !column["options"].arrayValue.isEmpty {
                Picker(name, selection: $text) {
                    Text("—").tag("")
                    ForEach(Array(column["options"].arrayValue.enumerated()), id: \.offset) { _, option in
                        Text(option["label"].optionalString ?? option["value"].stringValue)
                            .tag(option["value"].stringValue)
                    }
                }
            } else {
                TextField(name, text: $text)
            }
        case "checkbox":
            Toggle(name, isOn: Binding(
                get: { text == "true" },
                set: { text = $0 ? "true" : "false" }
            ))
        case "number", "progress":
            TextField(type == "progress" ? "\(name) (%)" : name, text: $text)
                .keyboardType(.decimalPad)
        default:
            TextField(name, text: $text, axis: .vertical)
        }
    }
}
