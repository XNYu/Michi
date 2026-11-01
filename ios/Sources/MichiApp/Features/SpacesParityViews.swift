import SwiftUI
import MichiCore

struct FeatureAllTasksScreen: View {
    let api: MichiAPI
    let workspaces: [JSONValue]
    @StateObject private var model: FeatureAllTasksModel
    @Environment(\.scenePhase) private var scenePhase

    init(api: MichiAPI, workspaces: [JSONValue]) {
        self.api = api
        self.workspaces = workspaces
        _model = StateObject(wrappedValue: FeatureAllTasksModel(api: api))
    }

    var body: some View {
        Group {
            if model.loading && model.payload.isNull {
                FeatureLoadingView(message: "Loading all tasks")
            } else if let error = model.error, model.payload.isNull {
                FeatureStatusBanner(title: "Couldn’t load All tasks", message: error, retry: { Task { await model.refresh() } })
                    .padding()
            } else {
                List {
                    if let error = model.error {
                        FeatureStatusBanner(title: "Update failed", message: error, retry: { Task { await model.refresh() } })
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                    if let error = model.conversationError { Text(error).font(.caption).foregroundStyle(.secondary) }
                    Section {
                        Text("Each task stays in its own workspace’s Tasks database. A change made here is written there.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Picker("View", selection: Binding(
                            get: { model.selectedViewId },
                            set: { model.selectView($0) }
                        )) {
                            ForEach(model.views, id: \.id) { view in
                                Text(featureNamed(view, fallback: view["type"].stringValue)).tag(view.id)
                            }
                        }
                        if featureCanHostRegisteredCustomView(model.selectedView) {
                            Text("A registered custom view stays on its workspace database. All tasks does not host or rewrite that binding.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else if featureIsUnsupportedCustomView(model.selectedView) {
                            Text(featureUnsupportedCustomReason(model.selectedView))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if model.viewDirty {
                        Section("View draft") {
                            FeatureViewEditor(view: $model.viewDraft, columns: model.columns)
                            Button("Save view") { Task { await model.saveViewDraft() } }
                            Button("Discard view changes") { model.discardViewChanges() }
                        }
                    } else {
                        Section {
                            NavigationLink("Edit view filters and sorts") {
                                FeatureViewEditor(view: $model.viewDraft, columns: model.columns)
                                    .navigationTitle("All tasks view")
                                    .toolbar {
                                        ToolbarItem(placement: .confirmationAction) {
                                            Button("Save") { Task { await model.saveViewDraft() } }
                                        }
                                    }
                            }
                        }
                    }
                    if model.effectiveBoard {
                        Section {
                            DesignPagesAllTasksBoard(model: model)
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    } else {
                        Section("Tasks") {
                            if model.displayRows.isEmpty {
                                Text("No tasks yet. Open a workspace task database, or ask the assistant to gather tasks from conversations.")
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(model.visibleRows, id: \.nativeTaskRowIdentity) { row in
                                NavigationLink {
                                    FeatureAllTasksRowScreen(model: model, row: row)
                                } label: {
                                    FeatureDatabaseRowLabel(row: row, columns: model.columns, isTasks: true)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("All tasks")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .refreshable { await model.refresh() }
        .featureBusy(model.saving)
        .task { await model.refresh() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(60)) } catch { break }; if !Task.isCancelled { await model.refreshConversations() } }
        }
    }
}


struct FeatureAllTasksRowScreen: View {
    @ObservedObject var model: FeatureAllTasksModel
    let row: JSONValue
    @State private var baseline: JSONValue = .null
    @State private var drafts: [String: String] = [:]
    @State private var structured: [String: JSONValue] = [:]
    @State private var bodyText = ""
    @State private var localError: String?

    var body: some View {
        Form {
            NativeLinkedConversations(api: model.api, conversations: model.conversations, ids: featureStringList(row["values"]["threads"]))
            FeatureStructuredRowForm(
                columns: model.columns,
                isTasks: true,
                drafts: $drafts,
                structured: $structured,
                bodyText: $bodyText,
                baseline: baseline,
                error: localError ?? model.error,
                onSave: { Task { await save() } },
                onReload: { load(row) }
            )
            NativeTaskOriginSection(api: model.api, databaseId: row["databaseId"].stringValue, rowId: row.id)
        }
        .navigationTitle("Task")
        .featureBusy(model.saving)
        .onAppear { bind(row) }
        .onChange(of: row.nativeTaskRowIdentity) { _, _ in bind(row) }
    }

    private func bind(_ source: JSONValue) {
        if baseline.isNull || baseline.nativeTaskRowIdentity != source.nativeTaskRowIdentity {
            load(source)
        }
    }

    private func load(_ source: JSONValue) {
        baseline = source
        bodyText = source["body"].stringValue
        drafts = Dictionary(model.columns.map { column in
            (column.id, featureCellDraft(source["values"][column.id], type: column["type"].stringValue))
        }, uniquingKeysWith: { _, last in last })
        structured = Dictionary(model.columns.compactMap { column -> (String, JSONValue)? in
            guard featureCanEditStructuredColumn(column) else { return nil }
            return (column.id, featureStructuredCellDraft(source["values"][column.id], type: column["type"].stringValue))
        }, uniquingKeysWith: { _, last in last })
        localError = nil
    }

    private func save() async {
        do {
            guard let operation = try featureDatabaseRowValueUpdate(
                baseline: baseline, columns: model.columns, drafts: drafts, structured: structured, body: bodyText
            ) else { return }
            let databaseId = baseline["databaseId"].stringValue
            if await model.updateSourceRow(databaseId: databaseId, operation: operation),
               let latest = model.displayRow(matching: baseline.nativeTaskRowIdentity) {
                load(latest)
            }
        } catch {
            localError = featureErrorMessage(error)
        }
    }
}

struct FeaturePageTrashScreen: View {
    let api: MichiAPI
    let workspaceId: String
    let workspaces: [JSONValue]
    @StateObject private var model: FeaturePageTrashModel
    @State private var purgeGroup: JSONValue?

    init(api: MichiAPI, workspaceId: String, workspaces: [JSONValue]) {
        self.api = api
        self.workspaceId = workspaceId
        self.workspaces = workspaces
        _model = StateObject(wrappedValue: FeaturePageTrashModel(api: api, workspaceId: workspaceId))
    }

    var body: some View {
        Group {
            if model.loading && model.groups.isEmpty {
                FeatureLoadingView(message: "Loading deleted pages")
            } else if let error = model.error, model.groups.isEmpty {
                FeatureStatusBanner(title: "Couldn’t load trash", message: error, retry: { Task { await model.refresh() } })
                    .padding()
            } else if model.groups.isEmpty {
                FeatureEmptyView(symbol: "trash", title: "Trash is empty", detail: "Deleted pages for this workspace will appear here.")
            } else {
                List {
                    if let error = model.error {
                        FeatureStatusBanner(title: "Update failed", message: error, retry: { Task { await model.refresh() } })
                    }
                    ForEach(model.groups, id: \.featureDeletionGroupId) { group in
                        Section(featureNamed(group["root"], fallback: "Deleted page")) {
                            Text(featureFormatDate(group["deletedAt"].featureOptionalNumber))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            ForEach(group["pages"].arrayValue, id: \.id) { page in
                                Label(featureNamed(page), systemImage: "doc")
                            }
                            Button("Restore") { Task { await model.restore(group) } }
                            Button("Delete permanently", role: .destructive) { purgeGroup = group }
                        }
                    }
                }
            }
        }
        .navigationTitle("Deleted pages")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .confirmationDialog("Permanently delete these pages?", isPresented: Binding(get: { purgeGroup != nil }, set: { if !$0 { purgeGroup = nil } }), titleVisibility: .visible) {
            Button("Delete permanently", role: .destructive) { if let group = purgeGroup { Task { await model.purge(group) } }; purgeGroup = nil }
        } message: { Text("The page group and its contents cannot be restored after deletion.") }
        .refreshable { await model.refresh() }
        .featureBusy(model.saving)
        .navigationDestination(item: $model.restoredPage) { page in
            FeaturePageScreen(api: api, pageId: page.id, workspaceId: page.workspaceId, workspaces: workspaces)
        }
        .task { await model.refresh() }
    }
}

struct FeaturePageHistoryScreen: View {
    @StateObject private var model: FeaturePageHistoryModel
    @State private var selectedPending: Set<DesignPageOpaqueID> = []
    @State private var batchKind: DesignPageBatchKind?
    @State private var batchTask: Task<Void, Never>?

    init(api: MichiAPI, pageId: String, workspaceId: String, workspaces _: [JSONValue]) {
        _model = StateObject(wrappedValue: FeaturePageHistoryModel(api: api, pageId: pageId, workspaceId: workspaceId))
    }

    private var batchActive: Bool { batchKind != nil }
    private var selectedCount: Int {
        model.pending.filter { change in
            featureIsPendingProposal(change) && selectedPending.contains(change.designPageOpaqueID)
        }.count
    }

    var body: some View {
        Group {
            if model.loading && model.changes.isEmpty {
                FeatureLoadingView(message: "Loading page history")
            } else if let error = model.error, model.changes.isEmpty {
                FeatureStatusBanner(title: "Couldn’t load history", message: error, retry: { Task { await model.refresh() } })
                    .padding()
            } else {
                List {
                    if let error = model.error {
                        FeatureStatusBanner(title: "Update failed", message: error, retry: { Task { await model.refresh() } })
                    }
                    if !model.pending.isEmpty {
                        Section {
                            ForEach(model.pending, id: \.designPageOpaqueID) { change in
                                FeaturePageChangeCard(
                                    model: model,
                                    change: change,
                                    selected: Binding(
                                        get: { selectedPending.contains(change.designPageOpaqueID) },
                                        set: { on in
                                            if on { selectedPending.insert(change.designPageOpaqueID) }
                                            else { selectedPending.remove(change.designPageOpaqueID) }
                                        }
                                    ),
                                    locked: batchActive
                                )
                            }
                            HStack(spacing: 10) {
                                Button("Reject all") { startBatch(.rejectAll) }
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .michiGlassButton(prominent: false)
                                .disabled(batchActive || model.saving || model.pending.isEmpty)
                                Button("Accept \(selectedCount) changes") { startBatch(.acceptSelected) }
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .michiGlassButton(prominent: true)
                                .disabled(batchActive || model.saving || selectedCount == 0)
                            }
                            .padding(.vertical, 8)
                        } header: {
                            MichiSectionHeader(title: "Waiting for you")
                        }
                    }
                    Section {
                        if model.changes.isEmpty {
                            Text("No recorded changes.")
                                .font(MichiFont.rowSecondary)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(model.changes, id: \.designPageOpaqueID) { change in
                            FeaturePageChangeCard(model: model, change: change, locked: batchActive)
                        }
                        if model.hasMore {
                            Button("Load older activity") { Task { await model.loadOlder() } }
                                .disabled(model.loading || batchActive)
                        }
                    } header: {
                        MichiSectionHeader(title: "History")
                    }
                }
                .michiPlainList()
            }
        }
        .navigationTitle(model.pending.isEmpty ? "Page history" : "Suggested changes")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .refreshable { await model.refresh() }
        .featureBusy(model.saving)
        .task {
            await model.refresh()
            if selectedPending.isEmpty { selectedPending = Set(model.pending.map(\.designPageOpaqueID)) }
        }
        .onChange(of: model.pending.map(\.designPageOpaqueID)) { _, ids in
            selectedPending = selectedPending.filter { ids.contains($0) }
        }
        .onDisappear { cancelBatch() }
    }

    private func startBatch(_ kind: DesignPageBatchKind) {
        guard batchTask == nil, !model.saving else { return }
        let ids = DesignPageBatch.intendedIDs(kind: kind, pending: model.pending, selected: selectedPending)
        guard !ids.isEmpty else { return }
        batchKind = kind
        batchTask = Task {
            defer {
                batchKind = nil
                batchTask = nil
            }
            var session = DesignPageBatchSession(kind: kind, intendedIDs: ids)
            await DesignPageBatch.run(
                session: &session,
                isCancelled: { Task.isCancelled },
                pending: { model.pending }
            ) { change in
                switch kind {
                case .acceptSelected: await model.accept(change)
                case .rejectAll: await model.dismiss(change)
                }
            }
        }
    }

    private func cancelBatch() {
        batchTask?.cancel()
    }
}

struct FeaturePageChangeCard: View {
    @ObservedObject var model: FeaturePageHistoryModel
    let change: JSONValue
    var onDecision: ((JSONValue, FeaturePageChangeAction, JSONValue?) async -> Bool)? = nil
    var selected: Binding<Bool>? = nil
    var locked = false
    @State private var draftSession = FeaturePageChangeDraftSession()
    @State private var deciding = false
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: change["target"]["kind"].stringValue == "row" ? "tablecells" : "text.alignleft")
                    .foregroundStyle(tokens.muted)
                Text(featurePageChangeLabel(change))
                    .font(MichiFont.sans(size: 11, relativeTo: .caption2, weight: .medium))
                    .tracking(0.66)
                    .textCase(.uppercase)
                    .foregroundStyle(tokens.muted)
                Spacer()
                if let selected {
                    Button { selected.wrappedValue.toggle() } label: {
                        Image(systemName: selected.wrappedValue ? "checkmark" : "")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(selected.wrappedValue ? tokens.accentInk : tokens.muted)
                            .frame(width: 22, height: 22)
                            .background(selected.wrappedValue ? tokens.accent : Color.clear, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                            .overlay {
                                if !selected.wrappedValue {
                                    RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(tokens.lineS, lineWidth: 1.5)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .michiHitTarget()
                    .accessibilityLabel(selected.wrappedValue ? "Selected" : "Not selected")
                }
            }
            Text(featureRelative(change["createdAt"].featureOptionalNumber))
                .font(MichiFont.meta)
                .foregroundStyle(tokens.muted)
            DesignPagesChangeBody(change: change)
            NavigationLink("Preview version") {
                FeatureInspectView(value: featurePageChangePreview(change), title: "Version \(change["seq"].intValue)")
            }
            .font(MichiFont.rowSecondary)
            NativePageChangeSourcesView(source: change["source"])
            if model.draftChangeId == change.id {
                Text("Editing keeps the proposal’s original base revision \(model.draftRevision).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $draftSession.text)
                    .font(.system(.subheadline, design: .monospaced))
                    .frame(minHeight: 160).accessibilityLabel("Proposed content")
                    .onAppear {
                        draftSession.appear(token: model.draftToken, changeID: change.id, modelText: model.draftContent.prettyPrinted)
                        validateDraft(draftSession.text)
                    }
                    .onChange(of: draftSession.text) { _, text in validateDraft(text) }
                if let draftError = draftSession.error { Text(draftError).font(.caption).foregroundStyle(.red) }
                Button("Accept edited proposal") { Task { await decide(.accept, editing: true) } }
                    .disabled(draftSession.error != nil)
                Button("Cancel edit") { model.discardEdit(); draftSession.discard() }
            } else {
                if featureIsPendingProposal(change) {
                    Button("Apply proposal") { Task { await decide(.accept) } }
                    if featureCanEditProposal(change) {
                        Button("Review and edit") {
                            model.beginEdit(change)
                            draftSession.begin(token: model.draftToken, changeID: change.id, modelText: model.draftContent.prettyPrinted)
                            validateDraft(draftSession.text)
                        }
                    }
                    Button("Reject proposal") { Task { await decide(.dismiss) } }
                }
                if featureIsDismissedProposal(change) {
                    Button("Show again") { Task { await model.reopen(change) } }
                }
                if featureIsPageChangeRevertible(change) {
                    Button("Restore previous version") { Task { await model.revert(change) } }
                }
                if featureIsPageChangeRedoable(change) {
                    Button("Restore this version") { Task { await model.redo(change) } }
                }
            }
        }
        .padding(14)
        .background(tokens.bgDeep, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1)
        }
        .buttonStyle(.borderless)
        .disabled(locked || deciding || model.saving)
        .nativeMichiReferences(api: model.api)
    }

    private func validateDraft(_ text: String) {
        do {
            let parsed = try JSONValue.parse(text)
            _ = try featurePageDraftPayload(change: change, draft: parsed)
            model.draftContent = parsed; draftSession.error = nil
        } catch { draftSession.error = "Enter valid proposed content: " + error.localizedDescription }
    }
    private func decide(_ action: FeaturePageChangeAction, editing: Bool = false) async {
        guard !deciding else { return }
        if editing {
            let visible = draftSession.visibleDraftText()
            validateDraft(visible)
            guard draftSession.error == nil else { return }
        }
        deciding = true; defer { deciding = false }
        if let onDecision {
            do {
                let edited = editing ? try featurePageDraftPayload(change: change, draft: try JSONValue.parse(draftSession.visibleDraftText())) : nil
                if await onDecision(change, action, edited), model.draftChangeId == change.id { model.discardEdit(); draftSession.discard() }
            } catch { draftSession.error = error.localizedDescription }
        } else if action == .dismiss { _ = await model.dismiss(change) }
        else if editing { _ = await model.acceptDraft(change) }
        else { _ = await model.accept(change) }
    }
}

struct FeatureUnsupportedCustomNotice: View {
    let value: JSONValue

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if featureCanHostRegisteredCustomView(value) || featureCanHostRegisteredComponent(value) {
                Label("Registered custom component", systemImage: "puzzlepiece.extension")
                    .font(.subheadline.weight(.semibold))
                Text(featureUnsupportedCustomReason(value))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Label("Custom HTML/JS is not executed here", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                Text(featureUnsupportedCustomReason(value))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            NavigationLink("Inspect stored fields") {
                FeatureInspectView(value: value, title: "Custom component")
            }
            .font(.footnote)
        }
    }
}
