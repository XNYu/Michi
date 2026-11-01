import SwiftUI
import MichiCore

func nativeComponentVersion(_ value: JSONValue) -> Int? {
    guard case .number(let number) = value, let version = Int(exactly: number), version > 0 else { return nil }
    return version
}

private extension JSONValue {
    /// List identity by exact UTF-8 bytes; `String` identity would merge
    /// canonically equivalent but distinct component IDs.
    var exactComponentID: Data { Data(id.utf8) }
}

/// Native library management. Saved source can be previewed here in the
/// isolated sample sandbox; preview never mints a host capability.
struct NativeComponentLibraryScreen: View {
    let api: MichiAPI
    let workspaceID: String
    var workspaces: [JSONValue] = []
    var initialComponentID: String?
    var initialVersion: Int?
    var onInsert: ((JSONValue, Int, JSONValue) async -> Bool)?
    @StateObject private var model: NativeComponentLibraryModel
    @State private var editing = false
    @State private var started = false
    @State private var requestedID: String?
    @State private var requestedVersion: Int?
    @State private var requestedNew = false
    @State private var discardConfirmation = false
    @State private var action: NativeComponentAction?
    @State private var actionVersion: Int?
    @State private var propsText = "{}"
    @State private var insertError: String?
    @State private var inserting = false
    @State private var openedSource: NativeComponentSourceID?
    @State private var olderVersion = ""
    @Environment(\.scenePhase) private var scenePhase

    init(api: MichiAPI, workspaceID: String, workspaces: [JSONValue] = [],
         initialComponentID: String? = nil, initialVersion: Int? = nil, readOnly: Bool = false,
         onInsert: ((JSONValue, Int, JSONValue) async -> Bool)? = nil) {
        self.api = api; self.workspaceID = workspaceID; self.workspaces = workspaces
        self.initialComponentID = initialComponentID; self.initialVersion = initialVersion
        self.onInsert = onInsert
        _model = StateObject(wrappedValue: NativeComponentLibraryModel(api: api, workspaceID: workspaceID, readOnly: readOnly))
    }

    var body: some View {
        Form {
            Section {
                Text("Manage workspace components, their source, versions, and references.")
                Text("Preview a saved version here with isolated sample data. Preview never mints a host capability. Live page and database hosts run the pinned or active version after they are connected.")
                    .font(.caption).foregroundStyle(.secondary)
                if model.readOnly { Label("This workspace is read-only", systemImage: "lock") }
                if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                if let notice = model.notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                if let issue = model.recoveryIssue { Text(issue).foregroundStyle(.orange) }
                if model.loading || model.reading { ProgressView("Loading components…") }
            }
            if model.outcomeUnknown {
                Section("Unconfirmed change") {
                    Text("The service did not confirm the last change. Check the saved library before making another change.")
                    Button("Check saved result") { Task { _ = await model.reconcilePending() } }
                        .disabled(model.loading || model.saving)
                }
            }
            library
            if editing { editor }
        }
        .navigationTitle("Components")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { _ = await model.refresh() } }
                    .disabled(model.loading || model.saving)
            }
        }
        .task {
            guard !started else { return }; started = true
            if await model.refresh(), let id = initialComponentID {
                editing = await model.select(componentID: id, version: initialVersion)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, started, !model.saving { Task { _ = await model.refresh() } }
        }
        .sheet(item: $openedSource) { source in
            NavigationStack { NativeComponentSourceConversation(api: api, workspaceID: workspaceID, nodeID: source.id) }
        }
        .confirmationDialog("Discard your unsaved component draft?", isPresented: $discardConfirmation, titleVisibility: .visible) {
            Button("Discard draft", role: .destructive) { performSelection(discard: true) }
            Button("Keep editing", role: .cancel) {}
        }
        .confirmationDialog(actionTitle, isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } }), titleVisibility: .visible) {
            Button(actionTitle, role: action == .delete ? .destructive : nil) {
                guard let operation = action else { return }
                let version = actionVersion
                action = nil
                Task { _ = await model.perform(operation, version: version, confirmed: true) }
            }
            Button("Cancel", role: .cancel) { action = nil }
        } message: {
            Text(action == .delete ? "This removes the component from the workspace library. Pages and database views that reference it may become unavailable." : "This changes the shared component used by pages and database views in this workspace.")
        }
    }

    private var library: some View {
        Section("Workspace library") {
            if model.hasLoaded && model.items.isEmpty { Text("No components saved yet.").foregroundStyle(.secondary) }
            ForEach(model.items, id: \.exactComponentID) { item in
                Button {
                    requestedID = item.id; requestedVersion = nil; requestedNew = false
                    requestSelection()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(item["name"].stringValue).font(.headline)
                            if model.selectedID.map({ ComponentSandbox.sameID($0, item.id) }) == true { Image(systemName: "checkmark") }
                        }
                        Text(item["description"].stringValue).font(.subheadline).foregroundStyle(.secondary)
                        Text("v\(item["activeVersion"].intValue) · \(item["versions"].intValue) versions · \(item["enabled"].boolValue ? "Enabled" : "Disabled")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.disabled(model.saving || model.reading)
            }
            if let selected = model.selected, selected["versions"].intValue > 200 {
                HStack {
                    TextField("Older version number", text: $olderVersion).keyboardType(.numberPad)
                    Button("Load version") {
                        guard let number = Int(olderVersion), number > 0, number <= selected["versions"].intValue else { return }
                        requestedID = selected.id; requestedVersion = number; requestedNew = false; requestSelection()
                    }.disabled(model.saving || model.reading || Int(olderVersion) == nil)
                }
            }
            Button("New component", systemImage: "plus") {
                requestedID = nil; requestedVersion = nil; requestedNew = true
                requestSelection()
            }.disabled(!model.canMutate)
        }
    }

    @ViewBuilder private var editor: some View {
        Section(model.selected == nil ? "New component" : "Component source") {
            TextField("Name", text: $model.draft.name).textInputAutocapitalization(.never).autocorrectionDisabled()
                .disabled(!model.draftReady || model.readOnly || model.selectedID != nil)
            TextField("Description", text: $model.draft.description, axis: .vertical)
                .disabled(!model.draftReady || model.readOnly)
            if let selected = model.selected {
                Picker("Version", selection: Binding(get: { model.selectedVersion ?? selected["activeVersion"].intValue }, set: { number in
                    requestedID = selected.id; requestedVersion = number; requestedNew = false; requestSelection()
                })) {
                    ForEach(model.availableVersions, id: \.self) { number in
                        Text("v\(number)\(number == selected["activeVersion"].intValue ? " · active" : "")").tag(number)
                    }
                }.disabled(model.saving || model.reading)
                if !selected["enabled"].boolValue { Text("Enable this component to read its source.").font(.footnote).foregroundStyle(.secondary) }
            }
            Text("JavaScript source").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $model.draft.code).font(.system(.caption, design: .monospaced))
                .frame(minHeight: 210).autocorrectionDisabled().textInputAutocapitalization(.never)
                .accessibilityLabel("Component source code")
                .disabled(!model.draftReady || model.readOnly)
            DisclosureGroup("Props schema JSON") {
                TextEditor(text: $model.draft.propsSchemaText).font(.system(.caption, design: .monospaced))
                    .frame(minHeight: 140).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .accessibilityLabel("Component props schema JSON")
                    .disabled(!model.draftReady || model.readOnly)
            }
            if !model.draft.code.isEmpty { ShareLink(item: model.draft.code) { Label("Share source", systemImage: "square.and.arrow.up") } }
            Button(model.selected == nil ? "Save component" : "Save new version") { Task { _ = await model.save() } }
                .disabled(!model.canMutate || model.reading || !model.draftReady || !model.dirty)
                .accessibilityIdentifier("component-save")
            if model.dirty {
                Button("Discard draft", role: .destructive) { Task { await model.discardDraft() } }.disabled(model.saving)
            }
        }.disabled(model.saving)
        if !previewCode.isEmpty {
            Section("Isolated preview") {
                Text("Runs the source in the editor, including unsaved edits. Sample data only; no host capability is requested.")
                    .font(.caption).foregroundStyle(.secondary)
                NativeComponentHostView(
                    api: api, workspaceID: workspaceID, componentID: model.selectedID ?? "preview",
                    version: model.selectedVersion ?? 1, name: previewName, code: previewCode,
                    props: [:]
                )
                .frame(minHeight: 180)
            }
        }
        if let selected = model.selected {
            if let onInsert {
                Section("Add to page") {
                    Text("Properties JSON").font(.caption).foregroundStyle(.secondary)
                    TextEditor(text: $propsText).font(.caption.monospaced()).frame(minHeight: 90)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .accessibilityLabel("Component properties JSON")
                    Text("This inserts a reference to the chosen saved version. The page host runs that version in the isolated sandbox after it is connected.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let insertError { Text(insertError).foregroundStyle(.red) }
                    Button("Insert selected version") {
                        guard let version = model.selectedVersion, !inserting else { return }
                        do {
                            guard propsText.utf8.count <= 64_000,
                                  let data = propsText.data(using: .utf8),
                                  case .object = try JSONDecoder().decode(JSONValue.self, from: data) else {
                                insertError = "Properties must be a JSON object smaller than 64 KB."; return
                            }
                            let props = try JSONDecoder().decode(JSONValue.self, from: data)
                            inserting = true; insertError = nil
                            Task {
                                defer { inserting = false }
                                if await onInsert(selected, version, props) { insertError = "Added to the page." }
                                else { insertError = "The page did not confirm the insert. Return to the page to review its current state." }
                            }
                        } catch { insertError = "Properties are not valid JSON." }
                    }.disabled(!model.canMutate || model.reading || inserting || !selected["enabled"].boolValue || model.dirty)
                }
            }
            Section("Shared component") {
                Button(selected["enabled"].boolValue ? "Disable component" : "Enable component") {
                    actionVersion = nil; action = selected["enabled"].boolValue ? .disable : .enable
                }
                if let version = model.selectedVersion, version != selected["activeVersion"].intValue {
                    Button("Activate version \(version)") { actionVersion = version; action = .activate }
                    Button("Roll back to version \(version)") { actionVersion = version; action = .rollback }
                }
                Button("Delete component", role: .destructive) { actionVersion = nil; action = .delete }
            }.disabled(!model.canMutate)
            if !model.version["source"].isNull {
                Section("Source attribution") {
                    if model.version["source"]["kind"] == "user" { Text("Created by you") }
                    else {
                        Button("Open source conversation", systemImage: "bubble.left") {
                            openedSource = NativeComponentSourceID(id: model.version["source"]["nodeId"].stringValue)
                        }.disabled(model.version["source"]["nodeId"].stringValue.isEmpty)
                        DisclosureGroup("Source details") { Text(model.version["source"].prettyPrinted).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                }
            }
            Section("Used in \(model.references.count) places") {
                ForEach(Array(model.references.prefix(200).enumerated()), id: \.offset) { _, reference in
                    if let pageID = reference["pageId"].optionalString {
                        NavigationLink("Page · \(pageID)") { FeaturePageScreen(api: api, pageId: pageID, workspaceId: workspaceID, workspaces: workspaces) }
                    } else if let databaseID = reference["databaseId"].optionalString {
                        NavigationLink("Database · \(databaseID)") { FeatureDatabaseScreen(api: api, databaseId: databaseID, workspaceId: workspaceID, initialViewId: reference["viewId"].optionalString) }
                    }
                    if let version = nativeComponentVersion(reference["pinnedVersion"]) { Text("Pinned to v\(version)").font(.caption).foregroundStyle(.secondary) }
                }
                if model.references.isEmpty { Text("No saved references.").foregroundStyle(.secondary) }
                if model.references.count > 200 { Text("Showing the first 200 references.").font(.caption) }
            }
        }
    }

    private func requestSelection() {
        if model.dirty { discardConfirmation = true }
        else { performSelection(discard: false) }
    }
    private func performSelection(discard: Bool) {
        if requestedNew { editing = model.beginNew(discardDraft: discard) }
        else if let id = requestedID {
            let version = requestedVersion
            Task { editing = await model.select(componentID: id, version: version, discardDraft: discard) }
        }
    }
    private var previewName: String {
        if let selected = model.selected { return selected["name"].stringValue }
        return model.draft.name.isEmpty ? "Preview" : model.draft.name
    }
    /// The editor's draft, as on the web: saved source is loaded into the
    /// draft, and edits re-run the preview without contacting the server.
    private var previewCode: String { model.draft.code }
    private var actionTitle: String {
        switch action {
        case .enable: return "Enable component"
        case .disable: return "Disable component"
        case .activate: return "Activate selected version"
        case .rollback: return "Roll back to selected version"
        case .delete: return "Delete component"
        case nil: return "Component change"
        }
    }
}

private struct NativeComponentSourceID: Identifiable { let id: String }

private struct NativeComponentSourceConversation: View {
    let workspaceID: String
    let nodeID: String
    @StateObject private var store: MichiStore
    @State private var ready = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    init(api: MichiAPI, workspaceID: String, nodeID: String) {
        self.workspaceID = workspaceID; self.nodeID = nodeID
        _store = StateObject(wrappedValue: MichiStore(api: api))
    }
    var body: some View {
        Group {
            if ready, let chat = store.chat(for: nodeID) { ConversationView(chat: chat, store: store) }
            else if let error { ContentUnavailableView("Source unavailable", systemImage: "bubble.left", description: Text(error)) }
            else { ProgressView("Loading source conversation…") }
        }
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        .navigationDestination(item: $store.selectedNodeID) { id in
            if let chat = store.chat(for: id) { ConversationView(chat: chat, store: store) }
        }
        .task {
            await store.reload()
            guard store.hydrated, store.error == nil,
                  let graph = store.graphs.first(where: { $0.id == workspaceID && !$0.isDeleted }),
                  let node = graph.node(nodeID), node["deleted_at"].isNull, graph.isConversation(node) else {
                error = store.error ?? "This conversation moved or is no longer available in this workspace."; return
            }
            store.selectedWorkspaceID = graph.id
            store.startObserving(); ready = true
        }
        .onDisappear { store.disconnectStreams() }
    }
}
