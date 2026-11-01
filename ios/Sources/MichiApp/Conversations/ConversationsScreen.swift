import SwiftUI
import MichiCore

/// Chats tab: workspaces are groups, threads are trees and branches indent
/// (no connector lines, as in the web sidebar). Compact width pushes the
/// conversation; regular width is a native split with an inspector.
///
/// Presentation is local to this tab: `openNodeID` follows `selectedNodeID`
/// only while Chats is visible, or when another surface explicitly asks via
/// `store.presentConversation` (`chatsPresentationEpoch`). Home and Search
/// never cause a second, hidden push here.
struct ConversationsScreen: View {
    @ObservedObject var store: MichiStore
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.michiTokens) private var tokens
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var showAllThreads = false
    @State private var search = ""
    @State private var searchPresented = false
    @State private var newWorkspace = false
    @State private var manage = false
    @State private var workspaces = false
    @State private var archive = false
    @State private var trash = false
    @State private var agents = false
    @State private var runs = false
    @State private var overview = false
    @State private var overviewInMap = false
    @State private var creating = false
    @State private var treeForMap: EntityRef?
    @State private var treeToRename: EntityRef?
    @State private var renameText = ""
    @State private var treeToMove: EntityRef?
    @State private var treeToTrash: EntityRef?
    @State private var nodeToRename: EntityRef?
    @State private var nodeToTrash: EntityRef?
    @State private var homeDraft: NativeHomeDraftSelection?
    @State private var homePage: FeatureOpenedPage?
    @State private var homePageJump: PageNavigationJump?
    @State private var homeMentionNodeID: String?
    @State private var inlineHomeDestination: NativeInlineHomeDestination?
    @State private var openNodeID: String?
    @State private var visible = false
    @State private var handledPresentation: Int?
    private static let branchLimit = 8

    private var regular: Bool { horizontalSizeClass == .regular }

    // The body is assembled from small opaque stages so the type checker never
    // sees the whole modifier chain at once. Order is unchanged: navigation,
    // presentation tracking, sheets, alerts, dialogs, then references.
    var body: some View {
        let tracked = presentationTracking(Group { navigationRoot })
        let presented = toolSheets(workspaceSheets(tracked))
        return confirmations(renameAlerts(presented))
            .nativeMichiReferences(api: store.api)
    }

    @ViewBuilder private var navigationRoot: some View {
        if regular { splitNavigation } else { compactNavigation }
    }

    private var splitNavigation: some View {
        NavigationSplitView {
            listColumn
                .navigationSplitViewColumnWidth(min: 220, ideal: 300, max: 360)
        } detail: {
            NavigationStack { pageDestinations(detailRoot) }
                .navigationSplitViewColumnWidth(min: 360, ideal: 544)
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var compactNavigation: some View {
        NavigationStack { pageDestinations(compactListColumn) }
    }

    private var compactListColumn: some View {
        listColumn.navigationDestination(item: $openNodeID) { id in compactConversation(id) }
    }

    @ViewBuilder private func compactConversation(_ id: String) -> some View {
        if let chat = store.chat(for: id) { ConversationView(chat: chat, store: store, startsWithContextPicker: id == homeMentionNodeID) }
        else { ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left", description: Text("Refresh your workspace to try again.")) }
    }

    private func presentationTracking<Content: View>(_ content: Content) -> some View {
        content
            .onAppear { visible = true; adoptPresentationRequest() }
            .onDisappear { visible = false }
            .onChange(of: store.chatsPresentationEpoch) { _, _ in adoptPresentationRequest() }
            .onChange(of: store.selectedNodeID) { old, new in followSelection(old: old, new: new) }
            .onChange(of: openNodeID) { old, new in
                if new == nil, let old, store.selectedNodeID == old { store.selectedNodeID = nil }
            }
    }

    private func followSelection(old: String?, new: String?) {
        if let new {
            if visible && openNodeID != new { openNodeID = new }
        } else if let old, openNodeID == old {
            openNodeID = nil // The selected conversation was deleted or moved away.
        }
    }

    private func workspaceSheets<Content: View>(_ content: Content) -> some View {
        content
            .sheet(isPresented: $newWorkspace) { WorkspaceEditor(store: store, graph: nil) }
            .sheet(item: $homeDraft) { item in homeDraftSheet(item) }
            .sheet(isPresented: $manage) { if let graph = store.selectedGraph { WorkspaceEditor(store: store, graph: graph) } }
            .sheet(isPresented: $workspaces) { WorkspaceManagerScreen(store: store) }
            .sheet(isPresented: $archive) { ArchiveScreen(store: store) }
            .sheet(isPresented: $trash) { NavigationStack { TrashScreen(store: store) } }
            .sheet(isPresented: $agents) { AgentLibraryScreen(api: store.api) }
    }

    private func toolSheets<Content: View>(_ content: Content) -> some View {
        content
            .sheet(isPresented: $overview) { overviewSheet }
            .sheet(isPresented: $runs) { runsSheet }
            .sheet(item: $treeForMap) { ref in BranchMapScreen(store: store, workspaceID: ref.value["workspace_id"].stringValue, treeID: ref.id) }
    }

    private func homeDraftSheet(_ item: NativeHomeDraftSelection) -> some View {
        NativeHomeDraftScreen(store: store, selection: item.selection) { nodeID, mention in
            homeMentionNodeID = mention ? nodeID : nil
            homeDraft = nil
            if let graph = store.graph(for: nodeID), let node = graph.node(nodeID) { open(node, workspace: graph.id) }
        }
    }

    @ViewBuilder private var overviewSheet: some View {
        if let graph = store.selectedGraph {
            NavigationStack {
                WorkspaceOverviewScreen(api: store.api, graph: graph, startsInMap: overviewInMap) { node in
                    Task { await store.reload(); if let current = store.graph(for: node)?.node(node) { overview = false; open(current, workspace: current["workspace_id"].stringValue) } }
                }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { overview = false } } }
            }
        }
    }

    private var runsSheet: some View {
        NavigationStack {
            AgentRunsScreen(api: store.api, workspaceID: store.selectedWorkspaceID) { workspace, node in openRun(workspace: workspace, node: node) }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { runs = false } } }
        }
    }

    private func openRun(workspace: String, node: String) {
        Task {
            await store.reload()
            if let graph = store.graphs.first(where: { $0.id == workspace && !$0.isDeleted }), let current = graph.node(node), current["deleted_at"].isNull { runs = false; open(current, workspace: workspace) }
            else { store.error = "The conversation is no longer available." }
        }
    }

    private func renameAlerts<Content: View>(_ content: Content) -> some View {
        content
            .alert("Rename conversation", isPresented: .presence(of: $treeToRename), presenting: treeToRename) { ref in
                TextField("Name", text: $renameText)
                Button("Save") { let name = renameText; run { try await store.renameTree(ref.value, name: name) } }
                Button("Cancel", role: .cancel) {}
            }
            .alert("Rename branch", isPresented: .presence(of: $nodeToRename), presenting: nodeToRename) { ref in
                TextField("Name", text: $renameText)
                Button("Save") {
                    let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !name.isEmpty { run { try await store.patchNode(ref.value, fields: ["title": .string(name)]) } }
                }
                Button("Cancel", role: .cancel) {}
            }
    }

    private func confirmations<Content: View>(_ content: Content) -> some View {
        content
            .confirmationDialog("Move to workspace", isPresented: .presence(of: $treeToMove), titleVisibility: .visible, presenting: treeToMove) { ref in
                ForEach(store.graphs.orderedLive.filter { $0.id != ref.value["workspace_id"].stringValue }) { target in
                    Button(target.name) { run { try await store.moveTree(ref.value, to: target.id) } }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Move this conversation to Trash?", isPresented: .presence(of: $treeToTrash), titleVisibility: .visible, presenting: treeToTrash) { ref in
                Button("Move to Trash", role: .destructive) { trashThread(ref.value) }
                Button("Cancel", role: .cancel) {}
            } message: { _ in Text("Its branches move with it. You can restore it from Trash.") }
            .confirmationDialog("Move this branch to Trash?", isPresented: .presence(of: $nodeToTrash), titleVisibility: .visible, presenting: nodeToTrash) { ref in
                Button("Delete Branch", role: .destructive) {
                    if let graph = store.graph(for: ref.id) { run { try await store.trashNode(ref.value, graph: graph) } }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in Text("Branches that came from it move with it. You can restore them from Trash.") }
    }

    // MARK: Navigation

    private func adoptPresentationRequest() {
        guard handledPresentation != store.chatsPresentationEpoch else { return }
        handledPresentation = store.chatsPresentationEpoch
        if store.chatsPresentationEpoch > 0, let id = store.selectedNodeID { openNodeID = id }
    }

    private func open(_ node: JSONValue, workspace: String) {
        store.select(node, workspace: workspace)
        openNodeID = node.id
    }

    @ViewBuilder private var detailRoot: some View {
        if let id = openNodeID, let chat = store.chat(for: id) {
            ConversationView(chat: chat, store: store, startsWithContextPicker: id == homeMentionNodeID, showsInspector: true)
                .id(id)
                .toolbarRole(.editor)
                .toolbar { ToolbarItem(placement: .topBarLeading) { composeButton(prominent: false) } }
        } else if openNodeID != nil {
            ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left", description: Text("Refresh your workspace to try again."))
        } else {
            ContentUnavailableView("Choose a conversation", systemImage: "bubble.left.and.bubble.right", description: Text("Pick a thread from the sidebar, or start a new one."))
                .toolbar { ToolbarItem(placement: .topBarLeading) { composeButton(prominent: false) } }
        }
    }

    private func pageDestinations<Content: View>(_ content: Content) -> some View {
        content
            .navigationDestination(item: $homePage) { page in
                FeaturePageScreen(api: store.api, pageId: page.id, workspaceId: page.workspaceId, workspaces: store.workspaceRows)
            }
            .navigationDestination(item: $homePageJump) { jump in
                FeaturePageScreen(api: store.api, pageId: jump.pageID, workspaceId: jump.workspaceID, workspaces: store.workspaceRows, scrollTargetID: jump.blockID)
            }
            .navigationDestination(item: $inlineHomeDestination) { destination in
                switch destination {
                case .database(let id, let view, let workspace):
                    FeatureDatabaseScreen(api: store.api, databaseId: id, workspaceId: workspace, initialViewId: view)
                case .tasks(let view, let workspace):
                    NativeHomeTaskDestination(api: store.api, workspaceID: workspace, viewID: view)
                case .file(let path, let workspace):
                    ArtifactDetail(api: store.api, workspaceID: workspace, artifact: ["file_path": .string(path), "name": .string(MichiAPI.safeArtifactFilename(path))])
                case .component(let id, let version, let workspace):
                    NativeComponentLibraryScreen(api: store.api, workspaceID: workspace, workspaces: store.workspaceRows, initialComponentID: id, initialVersion: version.flatMap(Int.init))
                default: EmptyView()
                }
            }
    }

    // MARK: List

    private var listColumn: some View {
        conversationList
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .michiToolbarBackground()
            .searchable(text: $search, isPresented: $searchPresented, prompt: "Search conversations")
            .onChange(of: store.selectedWorkspaceID) { _, _ in showAllThreads = false }
            .onChange(of: store.hydrated) { _, hydrated in
                #if DEBUG
                if hydrated && ProcessInfo.processInfo.arguments.contains("--uitesting") && (ProcessInfo.processInfo.arguments.contains("--preview-digest") || ProcessInfo.processInfo.arguments.contains("--preview-graph")) {
                    overviewInMap = ProcessInfo.processInfo.arguments.contains("--preview-graph"); overview = true
                }
                #endif
            }
            .onChange(of: search) { _, value in store.search(value) }
            .onAppear {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--uitesting") && ProcessInfo.processInfo.arguments.contains("--preview-search") {
                    searchPresented = true
                    if search.isEmpty { search = "native" }
                }
                #endif
                store.search(search)
            }
            .onDisappear { store.cancelSearch() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { store.cancelSearch() }
                else if phase == .active && !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { store.search(search) }
            }
            .refreshable { await store.reload() }
            .overlay { if store.loading && !store.hydrated { ProgressView("Loading your workspaces…").font(MichiFont.row).tint(tokens.mid) } }
            .toolbar { listToolbar }
    }

    @ToolbarContentBuilder private var listToolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) { Text("Chats").font(MichiFont.sans(size: 15, relativeTo: .headline, weight: .semibold)).opacity(0).accessibilityHidden(true) }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { overviewInMap = true; overview = true } label: { Image(systemName: "point.3.connected.trianglepath.dotted") }
                .accessibilityLabel("Workspace map")
                .disabled(store.selectedGraph == nil)
            chatMenu
        }
        if !regular {
            ToolbarItem(placement: .topBarTrailing) { composeButton(prominent: true) }
        }
    }

    private var chatMenu: some View {
        Menu {
            let live = store.graphs.orderedLive
            if !live.isEmpty {
                Picker("Current workspace", selection: $store.selectedWorkspaceID) {
                    ForEach(live) { graph in Text(graph.name).tag(Optional(graph.id)) }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("workspace-picker")
            }
            Button("New workspace", systemImage: "folder.badge.plus") { newWorkspace = true }
            Button("Workspaces", systemImage: "square.stack") { workspaces = true }
            if store.selectedGraph != nil { Button("Manage workspace", systemImage: "slider.horizontal.3") { manage = true } }
            if store.selectedGraph != nil { Button("Workspace overview", systemImage: "doc.text.magnifyingglass") { overviewInMap = false; overview = true } }
            Divider()
            Button("Archive", systemImage: "archivebox") { archive = true }
            Button("Trash", systemImage: "trash") { trash = true }
            if store.customAgentsEnabled { Button("Agents", systemImage: "person.2") { agents = true } }
            Button("Agent runs & workflows", systemImage: "flowchart") { runs = true }
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.reload() } }
        } label: { Image(systemName: "ellipsis") }
            .accessibilityLabel("More")
            .accessibilityIdentifier("chat-menu")
    }

    private func composeButton(prominent: Bool) -> some View {
        Button { if let graph = store.selectedGraph { createThread(graph) } else { newWorkspace = true } } label: {
            Image(systemName: "square.and.pencil")
        }
        .modifier(ChatComposeStyle(prominent: prominent))
        .accessibilityLabel("New conversation")
        .disabled(creating || !store.hydrated)
    }

    private var conversationList: some View {
        List {
            MichiLargeTitle(text: "Chats")
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            if let error = store.error {
                Label(error, systemImage: "exclamationmark.triangle").font(MichiFont.row).foregroundStyle(tokens.dangerText)
                    .listRowBackground(Color.clear)
            }
            if let syncError = store.synchronizationError {
                Label(syncError, systemImage: "arrow.triangle.2.circlepath").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                    .listRowBackground(Color.clear)
            }
            if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                NativeGroupedSearchResults(store: store, query: search)
            } else {
                let live = store.graphs.orderedLive
                if !live.isEmpty {
                    ForEach(live) { graph in workspaceGroup(graph) }
                } else if !store.loading && store.hydrated {
                    emptyState
                }
            }
        }
        .michiPlainList()
        .environment(\.defaultMinListRowHeight, 44)
    }

    @ViewBuilder private func workspaceGroup(_ graph: WorkspaceGraph) -> some View {
        let trees = graph.threadTrees
        let visibleTrees = showAllThreads || graph.id != store.selectedWorkspaceID ? trees : Array(trees.prefix(preferences.sidebarThreadLimit))
        workspaceHeader(graph, count: trees.count)
        ForEach(visibleTrees, id: \.id) { tree in treeRows(tree, in: graph) }
        if graph.id == store.selectedWorkspaceID && trees.count > preferences.sidebarThreadLimit {
            Button { showAllThreads.toggle() } label: {
                Text(showAllThreads ? "Show fewer conversations" : "Show all conversations")
                    .font(MichiFont.mono(size: 12.5, relativeTo: .footnote)).foregroundStyle(tokens.muted)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 0, leading: 56, bottom: 0, trailing: 20))
            .listRowBackground(tokens.bg)
        }
        Button { createThread(graph) } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus").font(.system(size: 13, weight: .medium)).foregroundStyle(tokens.faint).frame(width: 24)
                Text("New conversation").font(MichiFont.sans(size: 14.5, relativeTo: .subheadline)).foregroundStyle(tokens.muted)
                Spacer()
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(creating || !store.hydrated || graph.isReadOnly)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowBackground(tokens.bg)
        .listRowSeparatorTint(tokens.sep)
        .accessibilityIdentifier(graph.id == store.selectedWorkspaceID ? "new-conversation" : "new-conversation-\(graph.id)")
    }

    /// Structural uppercase caption. Tapping it makes the workspace current
    /// for the compose button, as the old workspace picker did.
    private func workspaceHeader(_ graph: WorkspaceGraph, count: Int) -> some View {
        let selected = graph.id == store.selectedWorkspaceID
        return Button { store.selectedWorkspaceID = graph.id } label: {
            HStack(alignment: .firstTextBaseline) {
                Text(graph.name).font(MichiFont.section).tracking(0.88).textCase(.uppercase)
                    .foregroundStyle(selected ? tokens.mid : tokens.muted)
                Spacer()
                Text("\(count) thread\(count == 1 ? "" : "s")").font(MichiFont.meta).foregroundStyle(tokens.muted)
            }
            .padding(.top, 24).padding(.bottom, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowBackground(tokens.bg)
        .listRowSeparator(.hidden, edges: .top)
        .listRowSeparatorTint(tokens.sep)
        .alignmentGuide(.listRowSeparatorLeading) { _ in -20 }
        .accessibilityLabel(graph.name)
        .accessibilityValue("\(count) thread\(count == 1 ? "" : "s")")
        .accessibilityHint(selected ? "Current workspace for new conversations" : "Makes this the workspace for new conversations")
        .accessibilityAddTraits(selected ? [.isHeader, .isSelected] : .isHeader)
    }

    @ViewBuilder private func treeRows(_ tree: JSONValue, in graph: WorkspaceGraph) -> some View {
        if let root = graph.node(tree["root_node_id"].stringValue) {
            let branches = graph.branchRows(tree: tree.id).filter { $0.node.id != root.id }
            threadRow(root, tree: tree, in: graph, branchCount: branches.count)
            ForEach(Array(branches.prefix(Self.branchLimit)), id: \.node.id) { row in
                branchRow(row.node, depth: max(1, row.depth), tree: tree, in: graph)
            }
            if branches.count > Self.branchLimit {
                Button { treeForMap = EntityRef(tree) } label: {
                    Text("\(branches.count - Self.branchLimit) more branches")
                        .font(MichiFont.mono(size: 12.5, relativeTo: .footnote)).foregroundStyle(tokens.muted)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 0, leading: 60, bottom: 0, trailing: 20))
                .listRowBackground(tokens.bg)
                .accessibilityHint("Opens the branch map")
            }
        }
    }

    private func threadRow(_ root: JSONValue, tree: JSONValue, in graph: WorkspaceGraph, branchCount: Int) -> some View {
        let state = ChatThreadStatus.state(root, store: store)
        let pinned = !tree["pinned_at"].isNull
        let overviewLine = WorkspaceOverviewModel.overview(root).split(separator: "\n").first.map(String.init) ?? ""
        let subtitle = [overviewLine.isEmpty ? nil : overviewLine, branchCount > 0 ? "\(branchCount) branch\(branchCount == 1 ? "" : "es")" : nil].compactMap { $0 }.joined(separator: " · ")
        let indent: CGFloat = tree["parent_tree_id"].stringValue.isEmpty ? 0 : 16
        return Button { open(root, workspace: graph.id) } label: {
            HStack(spacing: 12) {
                Group {
                    if pinned && state == .idle { Image(systemName: "pin").font(.system(size: 12)).foregroundStyle(tokens.faint).accessibilityLabel("Pinned") }
                    else { MichiThreadStateDot(state: state) }
                }
                .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(graph.threadTitle(tree)).font(MichiFont.row).foregroundStyle(tokens.fg).lineLimit(1)
                    if !subtitle.isEmpty { Text(subtitle).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted).lineLimit(1) }
                }
                Spacer(minLength: 8)
                trailing(root, state: state, activeAt: tree["last_active_at"].featureOptionalNumber)
            }
            .padding(.leading, indent)
            .padding(.vertical, rowPadding)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowBackground(regular && openNodeID == root.id ? tokens.alt : tokens.bg)
        .listRowSeparatorTint(tokens.sep)
        .alignmentGuide(.listRowSeparatorLeading) { _ in 36 + indent }
        .accessibilityIdentifier("thread-\(root.id)")
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !graph.isReadOnly {
                Button("Delete", systemImage: "trash", role: .destructive) { treeToTrash = EntityRef(tree) }
                Button("Archive", systemImage: "archivebox") { run { try await store.archiveTree(tree, archived: true) } }.tint(tokens.mauve)
                Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") { run { try await store.setTreePinned(tree, pinned: !pinned) } }.tint(tokens.accent)
            }
        }
        .contextMenu { threadMenu(tree, in: graph) } preview: {
            threadPreview(root, in: graph, subtitle: graph.name)
        }
    }

    private func branchRow(_ node: JSONValue, depth: Int, tree: JSONValue, in graph: WorkspaceGraph) -> some View {
        let state = ChatThreadStatus.state(node, store: store)
        let pinned = !node["pinned_at"].isNull
        let indent = CGFloat(min(depth, 4)) * 20
        let readOnly = graph.isReadOnly || graph.isTreeArchived(tree.id)
        return Button { open(node, workspace: graph.id) } label: {
            HStack(spacing: 10) {
                Group {
                    if pinned && state == .idle { Image(systemName: "pin").font(.system(size: 10)).foregroundStyle(tokens.faint).accessibilityLabel("Pinned") }
                    else { MichiThreadStateDot(state: state) }
                }
                .frame(width: 12)
                Text(graph.title(node)).font(MichiFont.sans(size: 14.5, relativeTo: .subheadline)).foregroundStyle(tokens.fg).lineLimit(1)
                Spacer(minLength: 8)
                trailing(node, state: state, activeAt: nil)
            }
            .padding(.leading, indent)
            .padding(.vertical, max(0, rowPadding - 2))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowBackground(regular && openNodeID == node.id ? tokens.alt : tokens.bg)
        .listRowSeparatorTint(tokens.sep)
        .alignmentGuide(.listRowSeparatorLeading) { _ in indent + 22 }
        .accessibilityIdentifier("thread-\(node.id)")
        .accessibilityHint("Branch of \(graph.threadTitle(tree))")
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !readOnly {
                Button("Delete", systemImage: "trash", role: .destructive) { nodeToTrash = EntityRef(node) }
                Button("Archive", systemImage: "archivebox") { run { try await store.pruneNode(node, archive: true) } }.tint(tokens.mauve)
                Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") { run { try await store.setNodePinned(node, pinned: !pinned) } }.tint(tokens.accent)
            }
        }
        .contextMenu { branchMenu(node, in: graph, readOnly: readOnly) } preview: {
            let parent = graph.node(node["parent_node_id"].stringValue).map(graph.title) ?? graph.threadTitle(tree)
            threadPreview(node, in: graph, subtitle: graph.name + " · branch of " + parent)
        }
    }

    private var rowPadding: CGFloat {
        preferences.sidebarDensity == "compact" ? 4 : preferences.sidebarDensity == "airy" ? 12 : 8
    }

    @ViewBuilder private func trailing(_ node: JSONValue, state: MichiThreadState, activeAt: Double?) -> some View {
        let chat = store.existingChat(for: node.id)
        if let label = ChatThreadStatus.label(state, chat: chat) {
            ChatThreadStateLabel(state: state, text: label)
        } else if node["kind"].stringValue == "digest" {
            MichiTag(text: "digest", kind: .ok)
        } else if let chat, !chat.usage["contextUsagePercentage"].isNull {
            Text("\(chat.usage["contextUsagePercentage"].intValue)%").font(MichiFont.mono(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
                .accessibilityLabel("Context \(chat.usage["contextUsagePercentage"].intValue) percent used")
        } else if preferences.showTimestamps, let activeAt, activeAt > 0 {
            Text(Self.shortDate(activeAt)).font(MichiFont.mono(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
        }
    }

    /// Sidebar-style relative time: minutes, today's time, weekday, then date.
    private static func shortDate(_ milliseconds: Double) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        let elapsed = Date().timeIntervalSince(date)
        let calendar = Calendar.current
        if elapsed >= 0 && elapsed < 3600 { return "\(max(1, Int(elapsed / 60)))m" }
        if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if elapsed >= 0 && elapsed < 6 * 86_400 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// Long-press preview: title, where it lives, and the latest exchange when
    /// this device already holds the conversation (no request is made).
    private func threadPreview(_ node: JSONValue, in graph: WorkspaceGraph, subtitle: String) -> some View {
        let chat = store.existingChat(for: node.id)
        let user = chat?.messages.last(where: { $0.role == "user" })
        let reply = chat?.messages.last(where: { $0.role == "assistant" })
        let summary = chat == nil || reply == nil ? WorkspaceOverviewSummary.text(node: node, graph: graph) : ""
        return VStack(alignment: .leading, spacing: 0) {
            Text(graph.title(node)).font(MichiFont.sans(size: 17, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg)
            Text(subtitle).font(MichiFont.sans(size: 13, relativeTo: .footnote)).foregroundStyle(tokens.muted).padding(.top, 4)
            VStack(alignment: .leading, spacing: 12) {
                if let user { MichiUserBubble(text: String(user.text.prefix(240))) }
                if let reply {
                    Text(String(AssistantText.visible(reply.text).prefix(240)) + "…").font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.fg).lineLimit(5)
                } else if !summary.isEmpty {
                    Text(summary).font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.mid).lineLimit(5)
                }
            }
            .padding(.top, 12)
        }
        .padding(18)
        .frame(width: 360, alignment: .leading)
        .background(tokens.surface)
    }

    @ViewBuilder private func threadMenu(_ tree: JSONValue, in graph: WorkspaceGraph) -> some View {
        let pinned = !tree["pinned_at"].isNull
        if !graph.isReadOnly {
            Button("Rename…", systemImage: "square.and.pencil") { renameText = graph.threadTitle(tree); treeToRename = EntityRef(tree) }
            if store.graphs.orderedLive.contains(where: { $0.id != graph.id }) {
                Button("Move to Workspace…", systemImage: "folder") { treeToMove = EntityRef(tree) }
            }
            Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") { run { try await store.setTreePinned(tree, pinned: !pinned) } }
        }
        Button("Branch map", systemImage: "arrow.triangle.branch") { treeForMap = EntityRef(tree) }
        if !graph.isReadOnly {
            Divider()
            Button("Archive", systemImage: "archivebox") { run { try await store.archiveTree(tree, archived: true) } }
            Button("Move to Trash…", systemImage: "trash", role: .destructive) { treeToTrash = EntityRef(tree) }
        }
    }

    @ViewBuilder private func branchMenu(_ node: JSONValue, in graph: WorkspaceGraph, readOnly: Bool) -> some View {
        let pinned = !node["pinned_at"].isNull
        if !readOnly {
            Button("Rename…", systemImage: "square.and.pencil") { renameText = graph.title(node); nodeToRename = EntityRef(node) }
            if graph.extractionScope(node.id) != nil {
                Button("Extract as New Thread", systemImage: "arrow.triangle.branch") { run { try await store.extractTree(node) } }
            }
            Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin") { run { try await store.setNodePinned(node, pinned: !pinned) } }
            Divider()
            Button("Archive", systemImage: "archivebox") { run { try await store.pruneNode(node, archive: true) } }
            Button("Delete Branch…", systemImage: "trash", role: .destructive) { nodeToTrash = EntityRef(node) }
        } else {
            Button("Open", systemImage: "bubble.left") { open(node, workspace: graph.id) }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 0) {
            Image(systemName: "folder.badge.plus").font(.system(size: 26, weight: .regular)).foregroundStyle(tokens.accent)
                .frame(width: 72, height: 72)
                .background(tokens.usesDarkCanvas ? tokens.bgDeep : tokens.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(tokens.line, lineWidth: 1) }
                .accessibilityHidden(true)
            Text("Start with a workspace").font(MichiFont.sans(size: 22, relativeTo: .title2, weight: .semibold)).foregroundStyle(tokens.fg).padding(.top, 20)
                .accessibilityAddTraits(.isHeader)
            Text("A workspace keeps related chats, their branches and pages together.")
                .font(MichiFont.sans(size: 17, relativeTo: .body)).foregroundStyle(tokens.mid).multilineTextAlignment(.center).padding(.top, 8)
            MichiPrimaryButton(title: "New workspace") { newWorkspace = true }
                .frame(maxWidth: 280).padding(.top, 26)
            Button("Or just start chatting") { startChatWithoutWorkspace() }
                .font(MichiFont.sans(size: 15, relativeTo: .body, weight: .medium)).foregroundStyle(tokens.accentText)
                .frame(minHeight: 44).padding(.top, 8)
                .disabled(creating)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 40).padding(.top, 80)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    // MARK: Actions

    private func openInlineHomeDestination(_ destination: NativeInlineHomeDestination) {
        switch destination {
        case .page, .prompt: break // NativeHomeCards delivers these atomically through onSelection.
        case .thread(let id, let workspace):
            Task {
                await store.reload()
                guard store.hydrated, store.error == nil,
                      let graph = store.graphs.first(where: { $0.id == workspace && !$0.isDeleted }),
                      let node = graph.node(id), node["deleted_at"].isNull, graph.isConversation(node) else {
                    store.error = store.error ?? "This conversation moved or is no longer available."; return
                }
                open(node, workspace: graph.id)
            }
        case .database, .tasks, .file, .component: inlineHomeDestination = destination
        }
    }
    private func openHomeSelection(_ selection: HomeCardPickResult) {
        if selection.kind == .contentPage && (selection.contentPageID == nil || selection.contentPageWorkspaceID == nil) { return }
        if selection.openPagesHome {
            Task {
                do {
                    let value = try await store.api.request("/spaces-home")
                    let page = featureUnwrap(value, "page")
                    guard !page.id.isEmpty, !page["workspaceId"].stringValue.isEmpty else { throw NativeFailure("Pages Home could not be loaded.") }
                    homePage = FeatureOpenedPage(id: page.id, workspaceId: page["workspaceId"].stringValue)
                } catch { store.error = error.localizedDescription }
            }
        } else if let page = selection.contentPageID, let workspace = selection.contentPageWorkspaceID {
            homePage = FeatureOpenedPage(id: page, workspaceId: workspace)
        } else {
            homeDraft = NativeHomeDraftSelection(selection: selection)
        }
    }
    private func startChatWithoutWorkspace() {
        creating = true
        Task {
            defer { creating = false }
            do {
                if store.graphs.orderedLive.isEmpty {
                    try await store.createWorkspace(name: "Chats", cwd: "")
                }
                if let graph = store.selectedGraph ?? store.graphs.orderedLive.first {
                    let id = try await store.createThread(in: graph)
                    openNodeID = id
                }
            } catch { store.error = error.localizedDescription }
        }
    }
    private func trashThread(_ tree: JSONValue) {
        guard let graph = store.graphs.first(where: { $0.id == tree["workspace_id"].stringValue }),
              let root = graph.node(tree["root_node_id"].stringValue) else { return }
        run { try await store.trashNode(root, graph: graph) }
    }
    private func createThread(_ graph: WorkspaceGraph) {
        creating = true
        Task {
            defer { creating = false }
            do { openNodeID = try await store.createThread(in: graph) } catch { store.error = error.localizedDescription }
        }
    }
    private func run(_ action: @escaping () async throws -> Void) { Task { do { try await action() } catch { store.error = error.localizedDescription } } }
}

private struct ChatComposeStyle: ViewModifier {
    let prominent: Bool
    @Environment(\.michiTokens) private var tokens
    func body(content: Content) -> some View {
        if prominent { content.michiGlassButton(prominent: true).tint(tokens.accent) } else { content }
    }
}

/// Reads the reference action inside the navigation stack's presentation scope.
/// Snippet buttons stay separate from the whole-conversation button.
private struct NativeGroupedSearchResults: View {
    @ObservedObject var store: MichiStore
    let query: String
    @Environment(\.openMichiReference) private var openMichiReference
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Section {
            if store.searchLoading {
                ProgressView("Searching conversations…").font(MichiFont.row).accessibilityIdentifier("search.loading")
            } else if let error = store.searchError {
                VStack(alignment: .leading, spacing: 8) {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(tokens.dangerText)
                    Button("Try search again") { store.search(query) }
                }.font(MichiFont.row).accessibilityIdentifier("search.error")
            } else if !store.hydrated {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Load your workspaces to open search results.")
                    Button("Load workspaces") { Task { await store.reload() } }
                }.font(MichiFont.row)
            } else if store.searchCompleted && store.visibleSearchResults.isEmpty {
                ContentUnavailableView.search(text: query.trimmingCharacters(in: .whitespacesAndNewlines))
                    .accessibilityIdentifier("search.empty")
            } else {
                ForEach(store.visibleSearchResults) { result in resultRow(result) }
                if store.searchResults.count == NativeSearchContract.resultLimit {
                    Text("Showing up to \(NativeSearchContract.resultLimit) matching conversations. Refine your search for more specific results.")
                        .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                }
            }
        } header: { MichiSectionHeader(title: "Search results").listRowInsets(EdgeInsets()) }
        .listRowBackground(tokens.bg)
    }

    private func resultRow(_ result: NativeSearchResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { Task { await store.openSearchResult(result) } } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        NativeSearchHighlightedText(runs: NativeSearchHighlight.titleRuns(result, query: store.searchQuery))
                            .font(MichiFont.rowTitle).foregroundStyle(tokens.fg)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint)
                    }
                    Text(verbatim: ([result.workspaceName] + result.breadcrumb).filter { !$0.isEmpty }.joined(separator: " › "))
                        .font(MichiFont.meta).foregroundStyle(tokens.muted).lineLimit(3)
                    HStack(spacing: 8) {
                        Text(result.totalMatches == 0 ? "Title match" : "\(result.totalMatches) message \(result.totalMatches == 1 ? "match" : "matches")")
                        if let destination = NativeSearchContract.destination(result, graphs: store.graphs),
                           destination.graph.isArchived || destination.graph.isTreeArchived(destination.node["tree_id"].stringValue) {
                            Label("Archived · Read only", systemImage: "archivebox")
                        }
                    }.font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(store.openingSearchResult)
            .accessibilityIdentifier("search.node.\(result.nodeID)")

            ForEach(result.snippets) { snippet in
                Button {
                    guard store.canOpenSearchResult(result) else { return }
                    if let messageID = snippet.messageID {
                        openMichiReference(.node(id: result.nodeID, messageID: messageID))
                    } else {
                        Task { await store.openSearchResult(result) }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(snippet.messageID == nil ? "Matching title" : snippet.role == "user" ? "You" : "Michi")
                            .font(MichiFont.mono(size: 11, relativeTo: .caption2, weight: .medium)).foregroundStyle(tokens.muted)
                        NativeSearchHighlightedText(runs: NativeSearchHighlight.snippetRuns(snippet, query: store.searchQuery))
                            .font(MichiFont.row).foregroundStyle(tokens.fg).lineLimit(4)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                        .background(tokens.alt, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(store.openingSearchResult)
                .accessibilityHint(snippet.messageID == nil ? "Open the conversation" : "Open this matching message")
                .accessibilityIdentifier("search.snippet.\(result.nodeID).\(snippet.id)")
            }
            if result.remainingMatches > 0 {
                Text("\(result.remainingMatches) more \(result.remainingMatches == 1 ? "match" : "matches") in this conversation")
                    .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
            }
        }.padding(.vertical, 5)
    }
}

private struct NativeHomeDraftSelection: Identifiable {
    let id = UUID()
    let selection: HomeCardPickResult
}

extension JSONValue {
    var selfID: String { !id.isEmpty ? id : self["nodeId"].stringValue }
}

struct WorkspaceEditor: View {
    @ObservedObject var store: MichiStore
    let graph: WorkspaceGraph?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var cwd = ""
    @State private var allowNavigation = true
    @State private var savedNavigation = true
    @State private var error: String?
    @State private var saving = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Workspace") { TextField("Name", text: $name).accessibilityIdentifier("workspace-name"); TextField("Folder on the connected computer", text: $cwd).textInputAutocapitalization(.never).autocorrectionDisabled() }
                if graph != nil { Section { Toggle("Let AI navigate this workspace", isOn: $allowNavigation) } }
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle(graph == nil ? "New workspace" : "Workspace settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save") { save() }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving).accessibilityIdentifier("save-workspace") }
            }.task {
                if let graph {
                    name = graph.name; cwd = graph.workspace["cwd"].stringValue
                    allowNavigation = graph.workspace["settings"].parsedJSON["aiGlobalContext"] != .bool(false); savedNavigation = allowNavigation
                }
            }
        }
    }
    private func save() {
        saving = true
        Task {
            defer { saving = false }
            do {
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                if let graph {
                    // Only edited fields are written, so changes saved elsewhere are kept.
                    var fields: [String: JSONValue] = [:]
                    if trimmed != graph.name { fields["name"] = .string(trimmed) }
                    if cwd != graph.workspace["cwd"].stringValue { fields["cwd"] = cwd.isEmpty ? .null : .string(cwd) }
                    if !fields.isEmpty { try await store.updateWorkspaceDetails(graph, fields: fields) }
                    if allowNavigation != savedNavigation { try await store.setAIGlobalContext(graph, enabled: allowNavigation); savedNavigation = allowNavigation }
                    await store.reload()
                } else { try await store.createWorkspace(name: trimmed, cwd: cwd) }
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
