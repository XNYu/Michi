import SwiftUI
import MichiCore

/// A tree or node row presented by a sheet or dialog.
struct EntityRef: Identifiable {
    let value: JSONValue
    var id: String { value.id }
    init(_ value: JSONValue) { self.value = value }
}

extension Binding where Value == Bool {
    /// Presents while `item` is set and clears it when dismissed.
    static func presence<Item>(of item: Binding<Item?>) -> Binding<Bool> {
        Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } })
    }
}

enum LifecycleText {
    static func plural(_ count: Int, _ noun: String) -> String { "\(count) \(noun)\(count == 1 ? "" : "s")" }
    static func relative(_ milliseconds: Double) -> String {
        milliseconds > 0 ? Date(timeIntervalSince1970: milliseconds / 1000).formatted(.relative(presentation: .named)) : "Unknown date"
    }
    static func deleteExplanation(_ graph: WorkspaceGraph) -> String {
        let count = graph.threadTrees.count
        let threads = count == 0 ? "It has no threads." : "Its \(plural(count, "thread")) \(count == 1 ? "moves" : "move") to Trash with it."
        let files = graph.workspace["cwd"].stringValue.isEmpty ? "" : " Files in its folder stay on disk."
        return "\(threads) You can restore it from Trash.\(files)"
    }
}

// MARK: - Workspaces

struct WorkspaceManagerScreen: View {
    @ObservedObject var store: MichiStore
    @Environment(\.dismiss) private var dismiss
    @State private var editing: WorkspaceGraph?
    @State private var deleting: WorkspaceGraph?
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
                let live = store.graphs.orderedLive
                let pinned = live.filter(\.isPinned)
                if !pinned.isEmpty { Section("Pinned") { ForEach(pinned) { row($0) } } }
                Section(pinned.isEmpty ? "Workspaces" : "Recent") {
                    ForEach(live.filter { !$0.isPinned }) { row($0) }
                    if live.isEmpty { Text("No active workspaces").foregroundStyle(.secondary) }
                }
                let archived = store.graphs.filter { $0.isArchived && !$0.isDeleted && !$0.isSystem }
                if !archived.isEmpty { Section("Archived workspaces") { ForEach(archived) { row($0) } } }
                Section { NavigationLink { TrashScreen(store: store, showsDone: false) } label: { Label("Trash", systemImage: "trash") } }
            }.navigationTitle("Workspaces")
            .toolbar { Button("Done") { dismiss() } }
            .sheet(item: $editing) { WorkspaceEditor(store: store, graph: $0) }
            .confirmationDialog(deleting.map { "Delete “\($0.name)”?" } ?? "Delete workspace?", isPresented: .presence(of: $deleting), titleVisibility: .visible, presenting: deleting) { graph in
                Button("Delete workspace", role: .destructive) { perform { try await store.trashWorkspace(graph) } }
                Button("Cancel", role: .cancel) {}
            } message: { graph in Text(LifecycleText.deleteExplanation(graph)) }
        }
    }
    private func row(_ graph: WorkspaceGraph) -> some View {
        HStack(spacing: 12) {
            // An archived workspace is not opened; its menu says what can be done with it.
            Button { store.selectedWorkspaceID = graph.id; dismiss() } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(graph.name).font(.headline).foregroundStyle(.primary)
                            if graph.isPinned { Image(systemName: "pin.fill").font(.caption).foregroundStyle(.secondary).accessibilityLabel("Pinned") }
                        }
                        Text(graph.workspace["cwd"].optionalString.flatMap { $0.isEmpty ? nil : $0 } ?? "Quick chat · no folder").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        Text(LifecycleText.plural(graph.threadTrees.count, "thread")).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if store.selectedWorkspaceID == graph.id { Image(systemName: "checkmark") }
                }
            }.buttonStyle(.borderless).disabled(graph.isArchived)
            Menu { actions(graph) } label: { Image(systemName: "ellipsis.circle").font(.title3) }
                .buttonStyle(.borderless).disabled(store.lifecycleBusy).accessibilityLabel("Actions for \(graph.name)")
        }.contextMenu { actions(graph) }
    }
    @ViewBuilder private func actions(_ graph: WorkspaceGraph) -> some View {
        Button(graph.isArchived ? "Rename…" : "Settings…", systemImage: "slider.horizontal.3") { editing = graph }
        if graph.isArchived {
            Button("Unarchive", systemImage: "arrow.uturn.backward") { perform { try await store.setWorkspaceArchived(graph, archived: false) } }
        } else {
            Button(graph.isPinned ? "Unpin" : "Pin", systemImage: graph.isPinned ? "pin.slash" : "pin") { perform { try await store.setWorkspacePinned(graph, pinned: !graph.isPinned) } }
            Button("Archive", systemImage: "archivebox") { perform { try await store.setWorkspaceArchived(graph, archived: true) } }
        }
        Button("Delete workspace…", systemImage: "trash", role: .destructive) { deleting = graph }
    }
    private func perform(_ change: @escaping () async throws -> Void) {
        Task { do { error = nil; try await change() } catch { self.error = error.localizedDescription } }
    }
}

// MARK: - Archive

struct ArchivedConversation: Hashable { let nodeID: String }

/// Archived threads and archived branches in one place, with every thread of
/// an archived workspace readable but read-only until it is unarchived.
struct ArchiveScreen: View {
    @ObservedObject var store: MichiStore
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    @State private var purging: DeletionGroup?
    @State private var trashing: EntityRef?
    private var sections: [WorkspaceGraph] {
        store.graphs.filter { !$0.isSystem && !$0.isDeleted && ($0.isArchived || !$0.archivedTrees.isEmpty || !$0.deletionGroups(archive: true).isEmpty) }
    }
    var body: some View {
        NavigationStack {
            List {
                if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
                if sections.isEmpty {
                    ContentUnavailableView("Nothing archived", systemImage: "archivebox", description: Text("Archive a conversation or branch to keep it here."))
                }
                ForEach(sections) { graph in section(graph) }
            }.navigationTitle("Archive")
            .toolbar { Button("Done") { dismiss() } }
            .navigationDestination(for: ArchivedConversation.self) { target in
                if let chat = store.chat(for: target.nodeID) { ConversationView(chat: chat, store: store) }
                else { ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left", description: Text("Refresh your workspace to try again.")) }
            }
            .alert("Delete permanently?", isPresented: .presence(of: $purging), presenting: purging) { group in
                Button("Delete permanently", role: .destructive) { perform { try await store.purgeGroup(group) } }
                Button("Cancel", role: .cancel) {}
            } message: { group in Text("Permanently delete “\(group.title)” (\(LifecycleText.plural(group.members.count, "node")))? This cannot be undone.") }
            .confirmationDialog("Move this conversation to Trash?", isPresented: .presence(of: $trashing), titleVisibility: .visible, presenting: trashing) { ref in
                Button("Move to Trash", role: .destructive) { trashThread(ref.value) }
                Button("Cancel", role: .cancel) {}
            } message: { _ in Text("You can restore it from Trash.") }
        }
    }
    @ViewBuilder private func section(_ graph: WorkspaceGraph) -> some View {
        Section {
            if graph.isArchived {
                HStack {
                    Label("Workspace archived", systemImage: "archivebox").foregroundStyle(.secondary)
                    Spacer()
                    Button("Unarchive") { perform { try await store.setWorkspaceArchived(graph, archived: false) } }.buttonStyle(.borderless).disabled(store.lifecycleBusy)
                }
                ForEach(graph.threadTrees, id: \.id) { tree in threadRow(tree, in: graph, note: "Read-only") }
            }
            ForEach(graph.archivedTrees, id: \.id) { tree in threadRow(tree, in: graph, note: "Archived \(LifecycleText.relative(tree["archived_at"].doubleValue))") }
            ForEach(graph.deletionGroups(archive: true)) { group in branchRow(group) }
        } header: { Text(graph.name) }
    }
    private func threadRow(_ tree: JSONValue, in graph: WorkspaceGraph, note: String) -> some View {
        NavigationLink(value: ArchivedConversation(nodeID: tree["root_node_id"].stringValue)) {
            VStack(alignment: .leading, spacing: 4) {
                Text(graph.threadTitle(tree))
                Text("\(note) · \(LifecycleText.plural(graph.visibleNodes(tree: tree.id).count, "node"))").font(.caption).foregroundStyle(.secondary)
            }
        }
        .contextMenu { if !graph.isReadOnly && !tree["archived_at"].isNull { threadActions(tree) } }
        .swipeActions { if !graph.isReadOnly && !tree["archived_at"].isNull { threadActions(tree) } }
    }
    @ViewBuilder private func threadActions(_ tree: JSONValue) -> some View {
        Button("Move to Trash…", systemImage: "trash", role: .destructive) { trashing = EntityRef(tree) }
        Button("Unarchive", systemImage: "arrow.uturn.backward") { perform { try await store.archiveTree(tree, archived: false) } }.tint(.blue)
    }
    private func branchRow(_ group: DeletionGroup) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(group.title)
                Text("Archived branch · \(LifecycleText.plural(group.members.count, "node")) · \(LifecycleText.relative(group.deletedAt))").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Menu {
                Button("Restore", systemImage: "arrow.uturn.backward") { perform { _ = try await store.restoreGroup(group) } }
                Button("Delete permanently…", systemImage: "trash", role: .destructive) { purging = group }
            } label: { Image(systemName: "ellipsis.circle").font(.title3) }.disabled(store.lifecycleBusy).accessibilityLabel("Actions for \(group.title)")
        }
    }
    private func trashThread(_ tree: JSONValue) {
        guard let graph = store.graphs.first(where: { $0.id == tree["workspace_id"].stringValue }),
              let root = graph.node(tree["root_node_id"].stringValue) else { return }
        perform { try await store.trashNode(root, graph: graph) }
    }
    private func perform(_ change: @escaping () async throws -> Void) {
        Task { do { error = nil; try await change() } catch { self.error = error.localizedDescription } }
    }
}

// MARK: - Trash

struct TrashSection: Identifiable {
    let graph: WorkspaceGraph
    let groups: [DeletionGroup]
    var id: String { graph.id }
}

/// Trash (screen 34): an Archived/Deleted switch over the same lifecycle
/// entries, single-item actions, and Select for a guarded sequential batch.
struct TrashScreen: View {
    @ObservedObject var store: MichiStore
    var showsDone = true
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    @State private var purgingGroup: DeletionGroup?
    @State private var purgingArchivedGroup: DeletionGroup?
    @State private var purgingWorkspace: WorkspaceGraph?
    @State private var purgingPage: DesignTrashPagesRef?
    @State private var confirmBatchPurge = false
    /// Empty Trash arms a temporary select-all for the shared batch confirmation.
    /// Cancelling that flow drops it; cancelling a manual batch keeps the user's picks.
    @State private var confirmingEmptyTrash = false
    @StateObject private var batch = DesignTrashBatchModel()
    @StateObject private var pages = DesignTrashPagesModel()
    private var liveSections: [TrashSection] {
        store.graphs.filter { !$0.isSystem && !$0.isDeleted }.map { TrashSection(graph: $0, groups: $0.deletionGroups(archive: false)) }.filter { !$0.groups.isEmpty }
    }
    private var deletedWorkspaces: [WorkspaceGraph] { store.graphs.filter { $0.isDeleted && !$0.isSystem } }
    private var itemCount: Int { liveSections.reduce(0) { $0 + $1.groups.count } + deletedWorkspaces.count }
    private var operations: DesignTrashScreenOperations { DesignTrashScreenOperations(store: store, pages: pages) }
    private var sections: [DesignTrashSection] {
        DesignTrashCatalog.sections(store.graphs, segment: batch.segment, pages: pages.snapshot)
    }
    /// Single-item actions wait for any store change and for a running batch.
    private var rowsLocked: Bool { store.lifecycleBusy || batch.running != nil || pages.saving }
    private var pageScopeToken: String {
        store.graphs.filter { !$0.isSystem && !$0.isDeleted }.map(\.id).joined(separator: "\u{1e}")
    }
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        applyBatchAlerts(applyWorkspaceAlerts(applyGroupAlerts(trashChrome)))
    }

    private var trashChrome: some View {
        trashList
            .michiPlainList()
            .navigationTitle("Trash")
            .navigationBarTitleDisplayMode(.inline)
            .michiToolbarBackground()
            .toolbar { trashToolbar }
            .safeAreaInset(edge: .bottom) { selectionInset }
            .task(id: pageScopeToken) { await pages.refresh(api: store.api, graphs: store.graphs) }
    }

    private var trashList: some View {
        List {
            segmentPicker
            chatErrorRow
            pageErrorRows
            outcomeRow
            emptyRow
            sectionRows
            emptyTrashSection
        }
    }

    private var segmentPicker: some View {
        Picker("Show", selection: Binding(get: { batch.segment }, set: { batch.setSegment($0) })) {
            ForEach(DesignTrashSegment.allCases) { Text($0.title.uppercased()).tag($0) }
        }
        .pickerStyle(.segmented)
        .disabled(batch.running != nil)
        .listRowBackground(Color.clear).listRowSeparator(.hidden)
        .accessibilityIdentifier("trash-segment")
    }

    @ViewBuilder private var chatErrorRow: some View {
        if let error {
            Label(error, systemImage: "exclamationmark.triangle").font(MichiFont.row).foregroundStyle(tokens.dangerText).listRowBackground(Color.clear)
        }
    }

    @ViewBuilder private var pageErrorRows: some View {
        if batch.segment == .deleted {
            ForEach(pages.snapshot.errors) { entry in
                VStack(alignment: .leading, spacing: 6) {
                    Label("Couldn’t load pages in \(entry.workspaceName)", systemImage: "exclamationmark.triangle")
                    Text(entry.message).font(MichiFont.rowSecondary)
                    Button("Try pages again") { Task { await pages.refresh(api: store.api, graphs: store.graphs) } }
                }
                .font(MichiFont.row).foregroundStyle(tokens.dangerText)
                .listRowBackground(Color.clear)
                .accessibilityIdentifier("trash-page-error-\(entry.id.raw)")
            }
            if pages.loading && !pages.snapshot.hasGroups {
                Label("Loading deleted pages", systemImage: "doc.text")
                    .font(MichiFont.row).foregroundStyle(tokens.muted)
                    .listRowBackground(Color.clear)
            }
        }
    }

    @ViewBuilder private var outcomeRow: some View {
        if let outcome = batch.outcome {
            Label(outcome.message, systemImage: outcomeSymbol(outcome)).font(MichiFont.row)
                .foregroundStyle(outcomeIsProblem(outcome) ? tokens.dangerText : tokens.mid)
                .textSelection(.enabled).listRowBackground(Color.clear)
        }
    }

    @ViewBuilder private var emptyRow: some View {
        if sections.isEmpty && shouldShowEmptyState {
            Group {
                if batch.segment == .deleted {
                    ContentUnavailableView("Trash is empty", systemImage: "trash", description: Text("No deleted threads, pages or workspaces."))
                } else {
                    ContentUnavailableView("Nothing archived", systemImage: "archivebox", description: Text("Archived workspaces, threads and branches appear here."))
                }
            }
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
    }

    private var shouldShowEmptyState: Bool {
        if batch.segment != .deleted { return true }
        if !pages.snapshot.errors.isEmpty { return false }
        if pages.loading { return false }
        return true
    }

    @ViewBuilder private var sectionRows: some View {
        ForEach(sections) { section in
            Section { ForEach(section.items) { item in row(item) } } header: { MichiSectionHeader(title: section.title).listRowInsets(EdgeInsets()) }
        }
    }

    @ViewBuilder private var emptyTrashSection: some View {
        if batch.segment == .deleted && itemCount > 0 {
            Section {
                Button(role: .destructive) {
                    batch.setSelecting(true)
                    batch.selectAll(sections)
                    confirmingEmptyTrash = true
                    confirmBatchPurge = true
                } label: {
                    Text(store.lifecycleBusy ? "Working…" : "Empty Trash")
                        .font(MichiFont.sans(size: 16, relativeTo: .body)).foregroundStyle(tokens.dangerText)
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.plain)
                .disabled(store.lifecycleBusy || !store.hydrated || batch.running != nil || batch.selecting || pages.loading || pages.saving || !pages.snapshot.errors.isEmpty)
                .accessibilityIdentifier("empty-trash")
            } footer: {
                Text("Deleting from Trash is permanent. Chats that are still running can’t be deleted.")
                    .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
            }
            .listRowBackground(tokens.bg)
        }
    }

    @ToolbarContentBuilder private var trashToolbar: some ToolbarContent {
        if showsDone { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        ToolbarItem(placement: .topBarTrailing) {
            Button(batch.selecting ? "Cancel" : "Select") { batch.setSelecting(!batch.selecting) }
                .michiGlassButton()
                .disabled(batch.running != nil || (!batch.selecting && sections.isEmpty))
                .accessibilityIdentifier("trash-select")
        }
    }

    @ViewBuilder private var selectionInset: some View {
        if batch.selecting { batchBar }
    }

    private func applyGroupAlerts<Content: View>(_ content: Content) -> some View {
        content
            .alert("Delete permanently?", isPresented: .presence(of: $purgingGroup), presenting: purgingGroup) { group in
                Button("Delete permanently", role: .destructive) { perform { try await store.purgeGroup(group) } }
                Button("Cancel", role: .cancel) {}
            } message: { group in Text("Permanently delete thread “\(group.title)” (\(LifecycleText.plural(group.members.count, "node")))? This cannot be undone.") }
            .alert("Delete permanently?", isPresented: .presence(of: $purgingArchivedGroup), presenting: purgingArchivedGroup) { group in
                Button("Delete permanently", role: .destructive) { perform { try await store.purgeGroup(group) } }
                Button("Cancel", role: .cancel) {}
            } message: { group in Text("Permanently delete archived branch “\(group.title)” (\(LifecycleText.plural(group.members.count, "node")))? This cannot be undone.") }
    }

    private func applyWorkspaceAlerts<Content: View>(_ content: Content) -> some View {
        content
            .alert("Delete permanently?", isPresented: .presence(of: $purgingWorkspace), presenting: purgingWorkspace) { graph in
                Button("Delete permanently", role: .destructive) { perform { try await store.purgeWorkspace(graph) } }
                Button("Cancel", role: .cancel) {}
            } message: { graph in Text("Permanently delete workspace “\(graph.name)” and all of its contents? This cannot be undone.") }
    }

    private func applyBatchAlerts<Content: View>(_ content: Content) -> some View {
        content
            .alert("Delete permanently?", isPresented: .presence(of: $purgingPage), presenting: purgingPage) { ref in
                Button("Delete permanently", role: .destructive) {
                    perform { try await operations.purgePageGroup(ref.group, workspaceID: ref.identity.workspaceID.raw) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { ref in Text("Permanently delete page “\(DesignTrashPages.title(ref.group))”? This cannot be undone.") }
            .alert("Delete selected items permanently?", isPresented: $confirmBatchPurge) {
                Button("Delete \(LifecycleText.plural(batch.selectedItems(in: sections).count, "item"))", role: .destructive) {
                    confirmingEmptyTrash = false
                    batch.start(.purge, operations: operations, confirmedPermanentDeletion: true)
                }
                Button("Cancel", role: .cancel) {
                    if confirmingEmptyTrash {
                        confirmingEmptyTrash = false
                        batch.setSelecting(false)
                    }
                }
            } message: {
                Text("Permanently delete \(LifecycleText.plural(batch.selectedItems(in: sections).count, "selected item"))? Michi deletes them one at a time and stops at the first problem. This cannot be undone.")
            }
    }

    @ViewBuilder private func row(_ item: DesignTrashItem) -> some View {
        switch item.payload {
        case .group(let group):
            if item.key.kind == .trashGroup { groupRow(group, key: item.key) } else { archivedGroupRow(group, key: item.key) }
        case .workspace(let graph):
            if item.key.kind == .deletedWorkspace { workspaceRow(graph, key: item.key) } else { archivedWorkspaceRow(graph, key: item.key) }
        case .thread(let tree, let graph):
            archivedThreadRow(tree, in: graph, key: item.key)
        case .page(let group):
            pageRow(group, key: item.key)
        }
    }
    private func pageRow(_ group: JSONValue, key: DesignTrashKey) -> some View {
        trashRow(key: key, title: DesignTrashPages.title(group),
                 subtitle: "Page · deleted \(LifecycleText.relative(DesignTrashPages.deletedAt(group)))",
                 symbol: "doc.text",
                 restore: { perform { try await operations.restorePageGroup(group, workspaceID: key.workspaceID) } },
                 purge: { purgingPage = DesignTrashPagesRef(identity: DesignTrashPages.identity(group, workspaceID: key.workspaceID), group: group) })
    }
    private func groupRow(_ group: DeletionGroup, key: DesignTrashKey) -> some View {
        trashRow(key: key, title: group.title,
                 subtitle: (group.members.count > 1 ? "With \(group.members.count - 1) branch\(group.members.count == 2 ? "" : "es") · " : "") + "deleted \(LifecycleText.relative(group.deletedAt))",
                 symbol: group.members.count > 1 ? "arrow.triangle.branch" : "bubble.left.and.bubble.right",
                 restore: { perform { _ = try await store.restoreGroup(group) } },
                 purge: { purgingGroup = group })
    }
    private func workspaceRow(_ graph: WorkspaceGraph, key: DesignTrashKey) -> some View {
        trashRow(key: key, title: graph.name,
                 subtitle: "Workspace · deleted \(LifecycleText.relative(graph.workspace["deleted_at"].doubleValue))",
                 symbol: "folder",
                 restore: { perform { try await store.restoreWorkspace(graph) } },
                 purge: { purgingWorkspace = graph })
    }
    private func archivedGroupRow(_ group: DeletionGroup, key: DesignTrashKey) -> some View {
        trashRow(key: key, title: group.title,
                 subtitle: "Archived branch · \(LifecycleText.plural(group.members.count, "node")) · \(LifecycleText.relative(group.deletedAt))",
                 symbol: "archivebox",
                 restore: { perform { _ = try await store.restoreGroup(group) } },
                 purge: { purgingArchivedGroup = group })
    }
    private func archivedThreadRow(_ tree: JSONValue, in graph: WorkspaceGraph, key: DesignTrashKey) -> some View {
        trashRow(key: key, title: graph.threadTitle(tree),
                 subtitle: "Archived thread · \(LifecycleText.relative(tree["archived_at"].doubleValue))",
                 symbol: "bubble.left.and.bubble.right",
                 restore: { perform { try await store.archiveTree(tree, archived: false) } },
                 purge: nil)
    }
    private func archivedWorkspaceRow(_ graph: WorkspaceGraph, key: DesignTrashKey) -> some View {
        trashRow(key: key, title: graph.name,
                 subtitle: "Workspace · archived \(LifecycleText.relative(graph.workspace["archived_at"].doubleValue))",
                 symbol: "folder",
                 restore: { perform { try await store.setWorkspaceArchived(graph, archived: false) } },
                 purge: nil)
    }
    @ViewBuilder private func trashRow(key: DesignTrashKey, title: String, subtitle: String, symbol: String,
                                       restore: @escaping () -> Void, purge: (() -> Void)?) -> some View {
        let selected = batch.isSelected(key)
        let content = HStack(spacing: 12) {
            if batch.selecting {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20)).foregroundStyle(selected ? tokens.accent : tokens.muted).frame(width: 24)
                    .accessibilityHidden(true)
            }
            Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(tokens.muted).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(MichiFont.row).foregroundStyle(tokens.fg).lineLimit(2)
                Text(subtitle).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            if !batch.selecting {
                Button(action: restore) {
                    Text("Restore").font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .semibold)).foregroundStyle(tokens.accentText)
                }
                .michiGlassButton()
                .accessibilityLabel("Restore \(title)")
            }
        }
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        Group {
            if batch.selecting {
                Button { batch.toggle(key) } label: { content }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(title).accessibilityValue(subtitle)
                    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            } else {
                content
                    .contextMenu {
                        Button("Restore", systemImage: "arrow.uturn.backward", action: restore)
                        if let purge { Button("Delete permanently…", systemImage: "trash", role: .destructive, action: purge) }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if let purge { Button("Delete permanently…", systemImage: "trash", role: .destructive, action: purge) }
                    }
                    .accessibilityActions {
                        if let purge { Button("Delete permanently", action: purge) }
                    }
            }
        }
        .listRowBackground(tokens.bg)
        .alignmentGuide(.listRowSeparatorLeading) { _ in batch.selecting ? 72 : 36 }
        .disabled(rowsLocked)
    }

    private var batchBar: some View {
        let items = batch.selectedItems(in: sections)
        let allKeys = sections.flatMap(\.items).map(\.key)
        let allSelected = !allKeys.isEmpty && allKeys.allSatisfy(batch.isSelected)
        return VStack(spacing: 8) {
            if batch.running != nil {
                HStack(spacing: 10) {
                    ProgressView(value: Double(batch.completedInRun), total: Double(max(batch.totalInRun, 1))).tint(tokens.accent)
                    Text("\(batch.completedInRun) of \(batch.totalInRun)").font(MichiFont.meta).foregroundStyle(tokens.muted)
                    Button(batch.stopRequested ? "Stopping…" : "Stop") { batch.requestStop() }
                        .michiGlassButton().disabled(batch.stopRequested)
                        .accessibilityHint("Stops after the item being changed now. That item is not cancelled.")
                }
            } else {
                HStack {
                    Button(allSelected ? "Deselect all" : "Select all") { if allSelected { batch.deselectAll() } else { batch.selectAll(sections) } }
                        .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .medium)).foregroundStyle(tokens.mid)
                        .frame(minHeight: 44)
                    Spacer()
                    Text(LifecycleText.plural(items.count, "selected item")).font(MichiFont.meta).foregroundStyle(tokens.muted)
                }
            }
            HStack(spacing: 10) {
                Button { batch.start(.restore, operations: operations) } label: {
                    Text(items.isEmpty ? "Restore" : "Restore \(items.count)")
                        .font(MichiFont.sans(size: 15, relativeTo: .body, weight: .semibold)).foregroundStyle(tokens.accentText)
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .michiGlassButton()
                .disabled(!batch.canRun(.restore, items: items, operations: operations))
                .accessibilityIdentifier("trash-batch-restore")
                Button(role: .destructive) { confirmingEmptyTrash = false; confirmBatchPurge = true } label: {
                    Text(items.isEmpty ? "Delete…" : "Delete \(items.count)…")
                        .font(MichiFont.sans(size: 15, relativeTo: .body, weight: .semibold)).foregroundStyle(tokens.dangerText)
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .michiGlassButton()
                .disabled(!batch.canRun(.purge, items: items, operations: operations))
                .accessibilityIdentifier("trash-batch-delete")
            }
            if !items.isEmpty && !items.allSatisfy(\.canPurge) {
                Text("Archived threads and workspaces can only be restored.").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
    }

    private func outcomeIsProblem(_ outcome: DesignTrashBatchOutcome) -> Bool {
        if case .completed = outcome { return false }
        if case .cancelled = outcome { return false }
        return true
    }
    private func outcomeSymbol(_ outcome: DesignTrashBatchOutcome) -> String {
        if case .completed = outcome { return "checkmark.circle" }
        if case .cancelled = outcome { return "stop.circle" }
        return "exclamationmark.triangle"
    }
    private func perform(_ change: @escaping () async throws -> Void) {
        batch.clearOutcome()
        Task { do { error = nil; try await change() } catch { self.error = error.localizedDescription } }
    }
}

// MARK: - Branch map

/// A thread's branches by parent pointer, with merge, link and digest
/// references for navigation. Archived threads and workspaces are read-only.
struct BranchMapScreen: View {
    @ObservedObject var store: MichiStore
    let workspaceID: String
    let treeID: String
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    @State private var nodeToRename: EntityRef?
    @State private var renameText = ""
    @State private var nodeToTrash: EntityRef?
    private var graph: WorkspaceGraph? { store.graphs.first { $0.id == workspaceID } }
    var body: some View {
        NavigationStack {
            List {
                if let error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
                if let graph, graph.tree(treeID) != nil {
                    let readOnly = graph.isReadOnly || graph.isSystem || graph.isTreeArchived(treeID)
                    if readOnly { Section { Label("Archived conversations are read-only", systemImage: "archivebox").foregroundStyle(.secondary) } }
                    Section {
                        ForEach(graph.branchRows(tree: treeID), id: \.node.id) { row in nodeRow(row.node, depth: row.depth, in: graph, readOnly: readOnly) }
                    } footer: { Text("Branches belong to the conversation they came from. Woven, linked and digest sources are references and open their own conversations.") }
                } else {
                    ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left", description: Text("It was moved or removed. Refresh to see the latest."))
                }
            }.navigationTitle(graph.flatMap { graph in graph.tree(treeID).map(graph.threadTitle) } ?? "Branches")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .alert("Rename branch", isPresented: .presence(of: $nodeToRename), presenting: nodeToRename) { ref in
                TextField("Name", text: $renameText)
                Button("Save") {
                    let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !name.isEmpty { perform { try await store.patchNode(ref.value, fields: ["title": .string(name)]) } }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Move this branch to Trash?", isPresented: .presence(of: $nodeToTrash), titleVisibility: .visible, presenting: nodeToTrash) { ref in
                Button("Move to Trash", role: .destructive) {
                    if let graph { perform { try await store.trashNode(ref.value, graph: graph) } }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in Text("Branches that came from it move with it. You can restore them from Trash.") }
        }.presentationDetents([.medium, .large])
    }
    @ViewBuilder private func nodeRow(_ node: JSONValue, depth: Int, in graph: WorkspaceGraph, readOnly: Bool) -> some View {
        let references = graph.references(of: node.id)
        Button { open(node, in: graph) } label: {
            HStack(spacing: 10) {
                Image(systemName: node["kind"].stringValue == "digest" ? "doc.text" : "bubble.left").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(graph.title(node)).foregroundStyle(.primary)
                    if !references.isEmpty { Text(LifecycleText.plural(references.count, "reference")).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                if !node["pinned_at"].isNull { Image(systemName: "pin.fill").font(.caption).foregroundStyle(.secondary).accessibilityLabel("Pinned") }
                if node["status"].stringValue == "streaming" { ProgressView() }
                if store.selectedNodeID == node.id { Image(systemName: "checkmark") }
            }.padding(.leading, CGFloat(min(depth, 8) * 16)).padding(.vertical, 4)
        }
        .accessibilityIdentifier("map-node-\(node.id)")
        .contextMenu { menu(node, in: graph, readOnly: readOnly, references: references) }
    }
    @ViewBuilder private func menu(_ node: JSONValue, in graph: WorkspaceGraph, readOnly: Bool, references: [(node: JSONValue, kind: String)]) -> some View {
        Button("Open", systemImage: "bubble.left") { open(node, in: graph) }
        if !references.isEmpty {
            Menu {
                ForEach(Array(references.enumerated()), id: \.offset) { _, reference in
                    Button("\(Self.label(reference.kind)): \(graph.title(reference.node))") { open(reference.node, in: graph) }
                }
            } label: { Label("References", systemImage: "arrow.triangle.merge") }
        }
        if !readOnly {
            let isRoot = graph.ownedTree(rootedAt: node.id) != nil
            let pinned = !node["pinned_at"].isNull
            if !isRoot {
                Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") { perform { try await store.setNodePinned(node, pinned: !pinned) } }
            }
            Button("Rename…", systemImage: "pencil") { renameText = graph.title(node); nodeToRename = EntityRef(node) }
            if node["kind"].stringValue == "chat" {
                Button("Branch new chat", systemImage: "arrow.triangle.branch") { perform { _ = try await store.createThread(in: graph, parent: node); dismiss() } }
            }
            if graph.extractionScope(node.id) != nil {
                Button("Extract as new conversation", systemImage: "arrow.up.right.square") { perform { try await store.extractTree(node); dismiss() } }
            }
            Button("Trim node", systemImage: "scissors") { perform { try await store.pruneNode(node, archive: false) } }
            Button("Archive node", systemImage: "archivebox") { perform { try await store.pruneNode(node, archive: true) } }
            if !isRoot { Button("Delete branch…", systemImage: "trash", role: .destructive) { nodeToTrash = EntityRef(node) } }
        }
    }
    private func open(_ node: JSONValue, in graph: WorkspaceGraph) {
        store.select(node, workspace: node["workspace_id"].optionalString ?? graph.id); dismiss()
    }
    private static func label(_ kind: String) -> String {
        switch kind {
        case "merge": return "Woven"
        case "digest-source": return "Digest"
        case "link": return "Linked"
        default: return kind.capitalized
        }
    }
    private func perform(_ change: @escaping () async throws -> Void) {
        Task { do { error = nil; try await change() } catch { self.error = error.localizedDescription } }
    }
}
