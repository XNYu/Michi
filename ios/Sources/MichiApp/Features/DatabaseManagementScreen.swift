import SwiftUI
import MichiCore

struct DatabaseManagementScreen: View {
    @ObservedObject var model: FeatureDatabaseModel
    @StateObject private var management: DatabaseManagementModel
    @State private var deleteView: JSONValue?
    @State private var forgetPending = false

    init(model: FeatureDatabaseModel) {
        self.model = model
        _management = StateObject(wrappedValue: DatabaseManagementModel(model: model))
    }
    var body: some View {
        Form {
            DatabaseManagementStatus(model: model, management: management)
            if management.pending != nil {
                Section("Unconfirmed change") {
                    Text("The last change may already be saved. Refresh checks it without sending it again.")
                    Button("Refresh to check") { Task { await management.refresh() } }.disabled(model.loading || model.saving)
                    Button("Forget pending record", role: .destructive) { forgetPending = true }.disabled(model.loading || model.saving)
                }
            }
            Section("Views") {
                ForEach(model.views, id: \.id) { view in
                    VStack(alignment: .leading, spacing: 8) {
                        NavigationLink {
                            DatabaseViewManagementDetail(model: model, management: management, viewID: view.id)
                        } label: {
                            Label(view["name"].stringValue, systemImage: view["type"] == "custom" ? "square.stack.3d.up" : "rectangle.split.3x3")
                        }
                        Text(view["type"].stringValue.capitalized).font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("Duplicate") { Task { await management.duplicateView(view) } }
                                .disabled(management.disabled || model.views.count >= 50)
                            Spacer()
                            Button("Delete", role: .destructive) { deleteView = view }
                                .disabled(management.disabled || model.views.count <= 1)
                        }
                    }
                }
                if model.views.count == 1 { Text("At least one view must stay in this database.").font(.caption).foregroundStyle(.secondary) }
            }
            Section("Columns") {
                ForEach(model.columns, id: \.id) { column in
                    NavigationLink {
                        DatabaseColumnManagementDetail(model: model, management: management, columnID: column.id)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(column["name"].optionalString ?? column.id)
                            Text(DatabaseManagement.protectedColumn(column, database: model.database) ? "\(column["type"].stringValue) · protected" : column["type"].stringValue)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .buttonStyle(.borderless)
        .navigationTitle("Manage database")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .task { await management.refresh() }
        .refreshable { await management.refresh() }
        .confirmationDialog("Delete this view?", isPresented: Binding(get: { deleteView != nil }, set: { if !$0 { deleteView = nil } }), titleVisibility: .visible) {
            Button("Delete view", role: .destructive) { if let view = deleteView { Task { await management.deleteView(view) } }; deleteView = nil }
        } message: { Text("This removes the saved view. Database rows remain available in the other views.") }
        .confirmationDialog("Forget the unconfirmed change?", isPresented: $forgetPending, titleVisibility: .visible) {
            Button("Forget pending record", role: .destructive) { management.forgetPending() }
        } message: { Text("The original edit may still finish. Refresh and inspect the database before making a new edit.") }
    }
}

private struct DatabaseManagementStatus: View {
    @ObservedObject var model: FeatureDatabaseModel
    @ObservedObject var management: DatabaseManagementModel
    var body: some View {
        if model.loading || model.saving { ProgressView(model.saving ? "Saving database" : "Loading database") }
        if let error = model.error {
            Section { Text(error).foregroundStyle(.red); Button("Refresh") { Task { await management.refresh() } }.disabled(model.loading || model.saving) }
        }
        if let notice = management.notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
        if model.viewDirty { Text("Save or discard the current view draft before managing views or columns. Your draft has been kept.").foregroundStyle(.secondary) }
        if model.orderingPending != nil { Text("Resolve the unconfirmed ordering change before editing this database.").foregroundStyle(.secondary) }
    }
}

private struct DatabaseViewManagementDetail: View {
    @ObservedObject var model: FeatureDatabaseModel
    @ObservedObject var management: DatabaseManagementModel
    let viewID: String
    @State private var baseline: JSONValue = .null
    @State private var visibilityDraft: JSONValue = .null
    @State private var name = ""

    var body: some View {
        Form {
            DatabaseManagementStatus(model: model, management: management)
            Section("Name") {
                TextField("View name", text: $name).disabled(model.saving || model.loading)
                Button("Rename view") {
                    Task {
                        if await management.renameView(baseline, name: name) { reload() }
                    }
                }.disabled(management.disabled || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name == baseline["name"].stringValue)
            }
            if baseline["type"] == "custom" {
                Section { Text("The component configuration stays intact when this view is renamed, duplicated, or its visible columns change.").font(.footnote) }
            }
            Section("Visible columns") {
                DatabaseVisibleColumnControls(view: $visibilityDraft, columns: model.columns, isThreads: model.database["kind"] == "threads")
                    .disabled(model.saving || model.loading)
                Button("Save visible columns") {
                    Task { if await management.saveVisibleColumns(visibilityDraft, baseline: baseline) { reload() } }
                }.disabled(management.disabled || visibilityDraft == baseline)
            }
            Button("Discard local changes and reload", role: .destructive) { reload() }.disabled(model.saving)
        }
        .navigationTitle(baseline["name"].optionalString ?? "View")
        .onAppear { if baseline.isNull { reload() } }
    }
    private func reload() {
        baseline = model.views.first { $0.id == viewID } ?? .null
        visibilityDraft = baseline; name = baseline["name"].stringValue
    }
}

private struct DatabaseColumnManagementDetail: View {
    @ObservedObject var model: FeatureDatabaseModel
    @ObservedObject var management: DatabaseManagementModel
    let columnID: String
    @State private var baseline: JSONValue = .null
    @State private var type = "text"
    @State private var confirmDelete = false
    @State private var confirmType = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            DatabaseManagementStatus(model: model, management: management)
            if DatabaseManagement.protectedColumn(baseline, database: model.database) {
                Text("Built-in and core task columns keep their type and stay in the database.")
            } else {
                Picker("Type", selection: $type) {
                    ForEach(featureDatabaseColumnTypes.filter { $0 != "threads" }, id: \.self) { type in Text(type.capitalized).tag(type) }
                }.disabled(model.saving || model.loading)
                Button("Change type") { confirmType = true }.disabled(management.disabled || type == baseline["type"].stringValue || baseline.isNull)
                Button("Delete column", role: .destructive) { confirmDelete = true }.disabled(management.disabled || baseline.isNull)
            }
        }
        .navigationTitle(baseline["name"].optionalString ?? "Column")
        .onAppear { baseline = model.columns.first { $0.id == columnID } ?? .null; type = baseline["type"].stringValue }
        .confirmationDialog("Change this column's type?", isPresented: $confirmType, titleVisibility: .visible) {
            Button("Change type") { Task { if await management.changeColumnType(baseline, to: type) { baseline = model.columns.first { $0.id == columnID } ?? baseline } } }
        } message: { Text("Existing cell values are retained. Their display and editing follow the new type.") }
        .confirmationDialog("Delete this column and its values?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete column", role: .destructive) { Task { if await management.deleteColumn(baseline) { dismiss() } } }
        } message: { Text("This removes the column's values from every row and removes references to it from saved views.") }
    }
}

struct DatabaseVisibleColumnControls: View {
    @Binding var view: JSONValue
    let columns: [JSONValue]
    var isThreads = false
    var body: some View {
        let shown = Set(DatabaseManagement.shownColumns(view: view, columns: columns, isThreads: isThreads).map(\.id))
        let title = DatabaseManagement.titleColumn(columns: columns, isThreads: isThreads)?.id
        ForEach(columns, id: \.id) { column in
            Toggle(column["name"].optionalString ?? column.id, isOn: Binding(
                get: { shown.contains(column.id) },
                set: { view = DatabaseManagement.settingVisibility(view: view, columns: columns, columnID: column.id, visible: $0, isThreads: isThreads) }
            )).disabled(column.id == title)
        }
        Text("The title column always stays visible. This changes only this view.").font(.caption).foregroundStyle(.secondary)
    }
}

/// Row labels can show the chosen properties without changing the complete
/// schema supplied to the row editor or the title's identity.
struct DatabaseVisibleProperties: View {
    let row: JSONValue
    let view: JSONValue
    let columns: [JSONValue]
    var isThreads = false
    var body: some View {
        let title = DatabaseManagement.titleColumn(columns: columns, isThreads: isThreads)?.id
        ForEach(DatabaseManagement.shownColumns(view: view, columns: columns, isThreads: isThreads).filter { $0.id != title }, id: \.id) { column in
            LabeledContent(column["name"].optionalString ?? column.id, value: featureCellText(row["values"][column.id], type: column["type"].stringValue))
                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
    }
}
