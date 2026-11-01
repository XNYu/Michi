import SwiftUI
import UniformTypeIdentifiers
import MichiCore

extension DatabaseOrderingDragItem: Transferable {
    static var transferRepresentation: some TransferRepresentation {
        // Never offered to other apps. A JSON drop from elsewhere decodes, if at
        // all, without this process's scope and is refused before any request.
        CodableRepresentation(contentType: .json).visibility(.ownProcess)
    }
}

/// Rows and columns can be dragged into a new saved order, and board cards into
/// another group. Explicit adjacent moves stay for VoiceOver, Switch Control and
/// keyboards. The screen never changes a saved filter/sort or unrelated values.
struct DatabaseOrderingScreen: View {
    @ObservedObject var model: FeatureDatabaseModel
    @State private var forgetPending = false
    @State private var editMode: EditMode = .inactive

    var body: some View {
        let rowReason = DatabaseOrdering.rowRestriction(database: model.database, view: model.effectiveView)
        let board = model.effectiveView["type"] == "board"
        let groups = model.orderingRowGroups
        let columnIDs = model.columns.map(\.id)
        List {
            if let error = model.error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
            if let notice = model.orderingNotice { Section { Text(notice).font(.footnote).foregroundStyle(.secondary) } }
            if model.orderingAccess == false { Section { Label("This workspace is read-only.", systemImage: "lock") } }
            if model.orderingPending != nil {
                Section("Unconfirmed move") {
                    Text("The previous move may already be saved. Refresh to check the order; no move is retried automatically.").font(.footnote)
                    Button("Check saved order") { Task { await model.refreshOrdering() } }
                    Button("Forget pending move…", role: .destructive) { forgetPending = true }
                }.disabled(model.loading || model.saving)
            }
            Section("Rows in this view") {
                LabeledContent("View", value: featureNamed(model.effectiveView, fallback: "Current view"))
                Text(board
                     ? "Drag a card within its group, or into another group to change its group value too. Hidden rows keep their relative order."
                     : "The same filters apply here. Drag a row, or use the arrows, to change its database order; hidden rows keep their relative order.")
                    .font(.footnote).foregroundStyle(.secondary)
                if model.viewDirty { Text("Your unsaved view changes are used here and remain unsaved.").font(.caption).foregroundStyle(.secondary) }
                if let rowReason {
                    Text(rowReason).foregroundStyle(.secondary)
                } else if groups.allSatisfy({ $0.rows.isEmpty }) {
                    Text("No matching rows.").foregroundStyle(.secondary)
                }
            }
            if rowReason == nil {
                ForEach(groups) { group in
                    Section(group.title) { rows(group, in: groups, board: board) }
                }
            }
            Section("Database columns") {
                Text("Views with an explicit visible-column list keep that list. Column types, values, filters, and sorts are preserved.").font(.footnote).foregroundStyle(.secondary)
                if let reason = DatabaseOrdering.restriction(model.database) { Text(reason).foregroundStyle(.secondary) }
                let disabled = model.orderingDisabled
                ForEach(Array(model.columns.enumerated()), id: \.element.id) { index, column in
                    DatabaseOrderingControls(title: featureNamed(column, fallback: column.id), first: index == 0,
                                             last: index == model.columns.count - 1, disabled: disabled) { direction in
                        Task { await model.moveOrderedColumn(column.id, direction: direction) }
                    }
                    .moveDisabled(disabled)
                }
                .onMove(perform: columnMove(disabled: disabled, snapshot: columnIDs))
            }
        }
        .environment(\.editMode, $editMode)
        .navigationTitle("Arrange rows & columns")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .overlay { if model.loading && model.orderingAccess == nil { ProgressView("Checking database…") } }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(editMode.isEditing ? "Done" : "Reorder") { withAnimation { editMode = editMode.isEditing ? .inactive : .active } }
                    .accessibilityHint("Shows drag handles. You can also drag without them, or use the arrow buttons.")
                Button { Task { await model.refreshOrdering() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.loading || model.saving).accessibilityLabel("Refresh saved order")
            }
        }
        .task { await model.refreshOrdering() }
        .refreshable { await model.refreshOrdering() }
        .onChange(of: model.orderingNotice) { _, notice in
            if let notice { UIAccessibility.post(notification: .announcement, argument: notice) }
        }
        .confirmationDialog("Forget this pending move locally?", isPresented: $forgetPending, titleVisibility: .visible) {
            Button("Forget pending move", role: .destructive) { model.forgetDatabaseOrdering() }
        } message: { Text("This does not undo or cancel the original move, which may still finish. Moving again is a new edit and may move the row or column another step.") }
    }

    /// `group` is the drawing a drag starts from; the model refuses the drop if
    /// the group has changed since, rather than moving a different row.
    @ViewBuilder private func rows(_ group: DatabaseOrderingGroup, in groups: [DatabaseOrderingGroup], board: Bool) -> some View {
        let disabled = model.orderingDisabled
        let others = groups.filter { $0.id != group.id }
        ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
            let title = featureRowTitle(row, columns: model.columns, isTasks: model.isTasks)
            let item = model.orderingDragItem(row: row.id, in: group)
            DatabaseOrderingControls(title: title, first: index == 0, last: index == group.rows.count - 1, disabled: disabled) { direction in
                Task { await model.moveOrderedRow(row.id, in: group, direction: direction) }
            } extra: {
                if board && !others.isEmpty {
                    Menu {
                        ForEach(others) { other in
                            Button(other.title) { Task { await model.moveOrderedRow(row.id, from: group, into: other) } }
                        }
                    } label: { Image(systemName: "rectangle.portrait.and.arrow.right") }
                        .disabled(disabled).accessibilityLabel("Move \(title) to another group")
                }
            }
            .moveDisabled(disabled)
            .itemProvider(board && !disabled ? Self.provider(item) : nil)
        }
        .onMove(perform: rowMove(group, disabled: disabled))
        .onInsert(of: board && !disabled ? [.json] : []) { index, providers in
            insert(providers, into: group, at: index)
        }
    }

    private func rowMove(_ group: DatabaseOrderingGroup, disabled: Bool) -> ((IndexSet, Int) -> Void)? {
        guard !disabled else { return nil }
        let model = self.model
        return { source, destination in Task { await model.dropOrderedRow(in: group, from: source, to: destination) } }
    }
    private func columnMove(disabled: Bool, snapshot: [String]) -> ((IndexSet, Int) -> Void)? {
        guard !disabled else { return nil }
        let model = self.model
        return { source, destination in Task { await model.dropOrderedColumn(from: source, to: destination, snapshot: snapshot) } }
    }
    /// Cards are offered only inside this process; see `DatabaseOrderingDragItem`.
    private static func provider(_ item: DatabaseOrderingDragItem) -> () -> NSItemProvider? {
        {
            let provider = NSItemProvider()
            provider.register(item)
            return provider
        }
    }

    private func insert(_ providers: [NSItemProvider], into group: DatabaseOrderingGroup, at index: Int) {
        guard providers.count == 1, let provider = providers.first else { model.orderingNotice = "Drop one card at a time."; return }
        let model = self.model
        _ = provider.loadTransferable(type: DatabaseOrderingDragItem.self) { result in
            Task { @MainActor in
                switch result {
                case .success(let item): _ = await model.transferOrderedRow(item, into: group, at: index)
                case .failure: model.orderingNotice = "That item can't be dropped here."
                }
            }
        }
    }
}

private struct DatabaseOrderingControls<Extra: View>: View {
    let title: String
    let first: Bool
    let last: Bool
    let disabled: Bool
    let onMove: (DatabaseOrderingDirection) -> Void
    @ViewBuilder let extra: () -> Extra
    var body: some View {
        HStack {
            Text(title).lineLimit(3)
            Spacer()
            extra()
            Button { onMove(.up) } label: { Image(systemName: "arrow.up") }
                .disabled(disabled || first).accessibilityLabel("Move \(title) up")
            Button { onMove(.down) } label: { Image(systemName: "arrow.down") }
                .disabled(disabled || last).accessibilityLabel("Move \(title) down")
        }.buttonStyle(.borderless)
    }
}

extension DatabaseOrderingControls where Extra == EmptyView {
    init(title: String, first: Bool, last: Bool, disabled: Bool, onMove: @escaping (DatabaseOrderingDirection) -> Void) {
        self.init(title: title, first: first, last: last, disabled: disabled, onMove: onMove, extra: { EmptyView() })
    }
}
