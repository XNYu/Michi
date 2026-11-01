import SwiftUI
import MichiCore

/// Dedicated editor for binding or creating a registered custom database view.
/// Generic native filter/sort save is not used here.
struct NativeComponentDatabaseBindingScreen: View {
    @ObservedObject var model: FeatureDatabaseModel
    @StateObject private var binding: NativeComponentDatabaseBindingModel
    @StateObject private var library: NativeComponentLibraryModel
    @State private var forgetPending = false

    init(model: FeatureDatabaseModel) {
        self.model = model
        _binding = StateObject(wrappedValue: NativeComponentDatabaseBindingModel(model: model))
        _library = StateObject(wrappedValue: NativeComponentLibraryModel(api: model.api, workspaceID: model.workspaceId, readOnly: true))
    }

    var body: some View {
        Form {
            Section {
                Text("Select an enabled workspace component and pin a saved version. The rest of this custom view's configuration is kept.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let restriction = DatabaseManagement.restriction(model.database) {
                    Label(restriction, systemImage: "lock")
                }
                if model.viewDirty {
                    Text("Save or discard the unsaved filter draft before changing a custom view binding.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let error = model.error {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
                if let notice = binding.notice {
                    Text(notice).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if binding.pending != nil || binding.journalIssue != nil {
                Section("Unconfirmed change") {
                    if let issue = binding.journalIssue {
                        Text(issue)
                    } else {
                        Text("The last custom view change may already be saved. Refresh checks it without sending it again.")
                    }
                    Button("Refresh to check") { Task { await binding.refresh() } }
                        .disabled(model.loading || model.saving)
                    Button("Forget pending record", role: .destructive) { forgetPending = true }
                        .disabled(model.loading || model.saving)
                }
            }
            Section("View") {
                TextField("Name", text: $binding.name)
                if binding.canBindSelected {
                    LabeledContent("Selected view", value: featureNamed(model.selectedView, fallback: model.selectedView.id))
                    Text("Binding updates the chosen component, pinned version, properties, and optional height. Filters and other saved settings stay.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Text("The selected view is not custom. Create adds a new custom view.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section("Workspace component") {
                if library.items.isEmpty && library.hasLoaded {
                    Text("No components saved in this workspace yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(library.items, id: \.id) { item in
                    Button {
                        _ = binding.selectComponent(item, version: item["activeVersion"].intValue)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(item["name"].stringValue).font(.headline)
                                if NativeComponentDatabaseBinding.exact(binding.componentID, item.id) {
                                    Image(systemName: "checkmark")
                                }
                            }
                            Text("v\(item["activeVersion"].intValue) · \(item["enabled"].boolValue ? "Enabled" : "Disabled")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(binding.disabled || library.loading || item["enabled"] != true)
                }
                if let selected = library.items.first(where: { NativeComponentDatabaseBinding.exact($0.id, binding.componentID) }) {
                    let versions = selected["versions"].intValue
                    if versions >= 1 {
                        Picker("Pinned version", selection: $binding.pinnedVersion) {
                            ForEach(bindingVersions(latest: versions, pinned: binding.pinnedVersion), id: \.self) { number in
                                Text("v\(number)\(number == selected["activeVersion"].intValue ? " · active" : "")").tag(number)
                            }
                        }
                        .disabled(binding.disabled || selected["enabled"] != true)
                    }
                }
                NavigationLink("Choose from library") {
                    NativeComponentLibraryScreen(
                        api: model.api,
                        workspaceID: model.workspaceId,
                        initialComponentID: binding.componentID.isEmpty ? nil : binding.componentID,
                        initialVersion: binding.pinnedVersion > 0 ? binding.pinnedVersion : nil,
                        onInsert: { component, version, props in
                            binding.adoptLibraryInsert(component, version: version, props: props)
                        }
                    )
                }
            }
            Section("Props JSON") {
                TextEditor(text: $binding.propsText)
                    .font(.caption.monospaced())
                    .frame(minHeight: 90)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel("Custom view properties JSON")
                Text("Must be a JSON object. Schema validation happens on the server.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Saved height") {
                TextField("Optional 80–1600", text: $binding.heightText)
                    .keyboardType(.numberPad)
                Toggle("Remove saved height", isOn: $binding.clearHeight)
                Text("Leave blank to keep an existing height, or omit it on a new view.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section {
                if binding.canBindSelected {
                    Button("Bind selected custom view") {
                        Task { await submitBinding(creating: false) }
                    }
                    .disabled(binding.disabled)
                }
                Button("Create custom view") {
                    Task { await submitBinding(creating: true) }
                }
                .disabled(binding.disabled)
            }
        }
        .navigationTitle(binding.canBindSelected ? "Bind custom view" : "Create custom view")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .task {
            await binding.refresh()
            _ = await library.refresh()
        }
        .confirmationDialog("Forget the local pending record?", isPresented: $forgetPending, titleVisibility: .visible) {
            Button("Forget pending record", role: .destructive) { binding.forgetPending() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The original edit may still finish. Refresh later to read the saved database.")
        }
    }

    private func bindingVersions(latest: Int, pinned: Int) -> [Int] {
        var values = Set(max(1, latest - 199)...latest)
        if pinned >= 1, pinned <= latest { values.insert(pinned) }
        return values.sorted(by: >)
    }

    private func submitBinding(creating: Bool) async {
        _ = await library.refresh()
        let selected = library.items.first { NativeComponentDatabaseBinding.exact($0.id, binding.componentID) }
        guard let selected, binding.selectComponent(selected) else {
            if model.error == nil {
                model.error = "Choose an enabled workspace component before binding this view."
            }
            return
        }
        if creating {
            _ = await binding.createCustomView()
        } else {
            _ = await binding.bindSelectedView()
        }
    }
}
