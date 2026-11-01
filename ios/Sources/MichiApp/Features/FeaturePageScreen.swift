import SwiftUI
import MichiCore

struct FeaturePageScreen: View {
    let api: MichiAPI
    let pageId: String
    let workspaceId: String
    let workspaces: [JSONValue]
    let scrollTargetID: String?
    let allowsPageDeletion: Bool

    @StateObject private var model: FeaturePageModel
    @StateObject private var conversationStore: MichiStore
    @StateObject private var homeSections: NativePageHomeSectionModel
    @State private var richDestination: NativePageBlockDestination?
    @State private var openedConversation: FeaturePageOpenedConversation?
    @State private var openingConversation = false
    @State private var pageVisible = false
    @State private var taskViewID: String?
    @State private var pendingScrollTarget: String?
    @State private var revealNamedViews = false
    @State private var navigationCommand: PageNavigationCommand?
    @State private var navigationHighlight: String?
    @State private var showRegularInspector = false
    @State private var showCompactAssistant = false
    @State private var isEditingPage = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(api: MichiAPI, pageId: String, workspaceId: String, workspaces: [JSONValue], scrollTargetID: String? = nil, allowsPageDeletion: Bool = true) {
        self.api = api
        self.pageId = pageId
        self.workspaceId = workspaceId
        self.workspaces = workspaces
        self.scrollTargetID = scrollTargetID
        self.allowsPageDeletion = allowsPageDeletion
        _model = StateObject(wrappedValue: FeaturePageModel(api: api, pageId: pageId, workspaceId: workspaceId))
        _conversationStore = StateObject(wrappedValue: MichiStore(api: api))
        _homeSections = StateObject(wrappedValue: NativePageHomeSectionModel(api: api))
        _pendingScrollTarget = State(initialValue: PageNavigation.normalizedTarget(scrollTargetID))
    }

    var body: some View {
        Group {
            if model.loading && model.page.isNull {
                FeatureLoadingView(message: "Loading page")
            } else if let error = model.error, model.page.isNull {
                FeatureStatusBanner(title: "Couldn’t load page", message: error, retry: { Task { await model.refresh() } })
                    .padding()
            } else {
                ScrollViewReader { scroll in
                List {
                    if let recovery = model.insertionRecoveryMessage {
                        Section {
                            Text(recovery).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                            Button("Refresh page") { Task { await model.refresh() } }
                            Button("I reviewed the page; clear pending insert") { model.resolveUnknownInsertionAfterReview() }
                        } header: {
                            MichiSectionHeader(title: "Review previous insert")
                        }
                        .listRowBackground(tokens.bg)
                    }
                    if let error = model.error {
                        FeatureStatusBanner(title: "Update failed", message: error, retry: { Task { await model.refresh() } })
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                    Section {
                        DesignPagesDocumentHeader(
                            kick: workspaceKick,
                            title: model.title.isEmpty ? "Page" : model.title,
                            meta: pageMetaLine
                        )
                        .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 8, trailing: 0))
                        if isEditingPage {
                            TextField("Title", text: $model.title)
                                .font(MichiFont.row)
                                .onSubmit { Task { await model.saveTitle() } }
                                .padding(.horizontal, 20)
                                .listRowInsets(EdgeInsets())
                        }
                        if model.titleDirty {
                            VStack(alignment: .leading, spacing: 8) {
                                Button("Save title") { Task { await model.saveTitle() } }
                                Button("Discard title changes") { model.discardTitleChanges() }
                            }
                            .font(MichiFont.rowSecondary)
                            .padding(.horizontal, 20)
                            .listRowInsets(EdgeInsets())
                        }
                        if !model.pendingChanges.isEmpty {
                            DesignPagesProposalBar(count: model.pendingChanges.count) { model.openedHistory = true }
                                .padding(.horizontal, 20)
                                .padding(.vertical, 8)
                                .listRowInsets(EdgeInsets())
                        }
                    }
                    .listRowBackground(tokens.bg)
                    .listRowSeparator(.hidden)

                    Section {
                        if model.blocks.isEmpty {
                            Text("No blocks yet.")
                                .font(MichiFont.rowSecondary)
                                .foregroundStyle(tokens.muted)
                                .padding(.horizontal, 20)
                        }
                        mainContentBlocks(scroll: scroll)
                    }
                    .listRowBackground(tokens.bg)
                    .listRowSeparator(.hidden)

                    let hidden = model.blocks.filter { !RichPageBlockModel.isMainContent($0) }
                    if !hidden.isEmpty {
                        Section {
                            DisclosureGroup(isExpanded: $revealNamedViews) {
                                ForEach(hidden, id: \.id) { block in
                                    blockEditor(block, scroll: scroll)
                                        .id(block.id)
                                        .accessibilityIdentifier(PageNavigation.blockAccessibilityID(block.id))
                                        .modifier(PageNavigationAnchorPresence(id: block.id))
                                }
                            } label: {
                                Text("Detail content & named views")
                                    .font(MichiFont.row)
                            }
                            .accessibilityIdentifier(PageNavigation.namedViewsAccessibilityID)
                            .id(PageNavigationScrollAnchor.namedViews)
                            .modifier(PageNavigationAnchorPresence(anchor: .namedViews))
                        }
                        .listRowBackground(tokens.bg)
                    }
                    if isEditingPage {
                        Section {
                            Menu {
                                Button("Markdown") { Task { await model.insertBlock(type: "markdown") } }
                                Button("Heading") { Task { await model.insertBlock(type: "heading") } }
                                Button("Callout") { Task { await model.insertBlock(type: "callout") } }
                                Button("Checklist") { Task { await model.insertBlock(type: "checklist") } }
                            } label: {
                                Label("Add block", systemImage: "plus.square")
                                    .font(MichiFont.row)
                            }
                            NavigationLink("Browse all building blocks") {
                                NativeBlockCatalogScreen { input in
                                    guard await model.insertBlock(input: input) else {
                                        throw NativeFailure(model.error ?? "The page did not confirm the new block.")
                                    }
                                }
                            }
                            .font(MichiFont.row)
                        }
                        .listRowBackground(tokens.bg)
                    }
                    if !model.children.isEmpty {
                        Section {
                            ForEach(model.children, id: \.id) { child in
                                NavigationLink {
                                    FeaturePageScreen(api: api, pageId: child.id, workspaceId: child["workspaceId"].stringValue.isEmpty ? model.workspaceId : child["workspaceId"].stringValue, workspaces: workspaces)
                                } label: {
                                    MichiHairlineRow(
                                        title: featureNamed(child),
                                        leading: { Image(systemName: "doc").foregroundStyle(tokens.muted) },
                                        trailing: { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                                    )
                                }
                            }
                        } header: {
                            MichiSectionHeader(title: "Pages")
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(tokens.bg)
                    }
                    if !model.databases.isEmpty {
                        Section {
                            ForEach(model.databases, id: \.id) { database in
                                NavigationLink {
                                    FeatureDatabaseScreen(api: api, databaseId: database.id, workspaceId: model.workspaceId)
                                } label: {
                                    MichiHairlineRow(
                                        title: featureNamed(database, fallback: "Database"),
                                        subtitle: database["role"].stringValue == "tasks" ? "Tasks · \(database["rowCount"].intValue) rows" : "\(database["rowCount"].intValue) rows",
                                        leading: { Image(systemName: database["role"].stringValue == "tasks" ? "checklist" : "tablecells").foregroundStyle(tokens.muted) },
                                        trailing: { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                                    )
                                }
                            }
                        } header: {
                            MichiSectionHeader(title: "Databases")
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(tokens.bg)
                    }
                    if !model.pendingChanges.isEmpty {
                        Section {
                            ForEach(model.pendingChanges, id: \.id) { change in
                                NavigationLink {
                                    FeaturePageHistoryScreen(api: api, pageId: pageId, workspaceId: model.workspaceId, workspaces: workspaces)
                                } label: {
                                    MichiHairlineRow(
                                        title: featurePageChangeLabel(change),
                                        subtitle: featureRelative(change["createdAt"].featureOptionalNumber),
                                        leading: { MichiThreadStateDot(state: .waiting) },
                                        trailing: { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                                    )
                                }
                            }
                        } header: {
                            MichiSectionHeader(title: "Waiting for you")
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(tokens.bg)
                    }
                    Section {
                        NavigationLink("Michi assistant & layout") { NativeSpacesMetaScreen(api: api, pageID: pageId, workspaceID: model.workspaceId) }
                        NavigationLink("Workspace components") {
                            NativeComponentLibraryScreen(api: api, workspaceID: model.workspaceId, workspaces: workspaces, onInsert: { component, version, props in
                                await model.insertBlock(input: ["type": "component", "componentId": .string(component.id),
                                    "pinnedVersion": .number(Double(version)), "props": props])
                            })
                        }
                        Button {
                            Task { await model.openTasks() }
                        } label: {
                            Label(model.taskDatabaseId == nil ? "Open task database" : "Tasks", systemImage: "checkmark.circle")
                        }
                        NavigationLink {
                            FeaturePageHistoryScreen(api: api, pageId: pageId, workspaceId: model.workspaceId, workspaces: workspaces)
                        } label: {
                            Label("History and proposals", systemImage: "clock.arrow.circlepath")
                        }
                        NavigationLink {
                            FeatureCreateChildPageSheet(model: model, workspaces: workspaces)
                        } label: {
                            Label("New child page", systemImage: "plus")
                        }
                    }
                    .font(MichiFont.row)
                    .listRowBackground(tokens.bg)
                }
                .accessibilityIdentifier(PageNavigation.screenAccessibilityID)
                .environment(\.pageNavigationJump, { id in scrollToValidated(id, scroll: scroll) })
                .environment(\.pageNavigationCommand, navigationCommand)
                .environment(\.pageNavigationHighlight, navigationHighlight)
                .modifier(PageNavigationScrollDriver(command: navigationCommand, proxy: scroll, highlight: $navigationHighlight))
                .onChange(of: model.blocks) { _, _ in
                    navigationCommand = nil; navigationHighlight = nil
                }
                .task(id: "\(model.page.id):\(model.revision):\(model.loading)") {
                    // Let snapshot invalidation finish before consuming the
                    // one-time entry target. Actual scrolling still waits for
                    // anchor layout through PageNavigationScrollDriver.
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    consumeScrollTarget(scroll)
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        let headings = PageNavigation.outline(model.blocks)
                        if !headings.isEmpty {
                            Menu {
                                ForEach(Array(headings.enumerated()), id: \.offset) { _, heading in
                                    Button(heading.text) { scrollToValidated(heading.id, scroll: scroll) }
                                }
                            } label: { Label("Contents", systemImage: "list.bullet.indent") }
                            .accessibilityIdentifier("page-nav-contents-menu")
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(tokens.bg)
                .michiScrollEdge()
                }
            }
        }
        .navigationTitle(model.title.isEmpty ? "Page" : model.title)
        .nativeMichiReferences(api: api)
        .environment(\.nativePageComponentOwnership, pageComponentOwnership)
        .environment(\.nativePageComponentActions, pageComponentActions)
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .toolbar {
            if isEditingPage {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done editing") { isEditingPage = false }
                        .accessibilityIdentifier("page-done-editing")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 4) {
                    Button { openAssistant() } label: {
                        Text(">_")
                            .font(MichiFont.prompt)
                            .foregroundStyle(tokens.accent)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Assistant")
                    Button { DesignPagesShare.page(model.title) } label: {
                        Image(systemName: "square.and.arrow.up")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Share page")
                    Menu {
                        if isEditingPage {
                            Button("Done editing") { isEditingPage = false }
                                .accessibilityIdentifier("page-done-editing-menu")
                        } else {
                            Button("Edit page") { isEditingPage = true }
                                .accessibilityIdentifier("page-edit-page")
                        }
                        Button("Save title") { Task { await model.saveTitle() } }
                        Button("History and proposals") { model.openedHistory = true }
                        Button("Michi assistant & layout") { openAssistant() }
                        if allowsPageDeletion && model.page["role"] != "spaces-home" {
                            Button("Delete page", role: .destructive) { model.confirmDelete = true }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("More")
                }
                .michiGlassCapsule()
            }
        }
        .inspector(isPresented: $showRegularInspector) {
            NativeSpacesAssistantScreen(api: api, pageID: pageId, workspaceID: model.workspaceId)
        }
        .navigationDestination(isPresented: $showCompactAssistant) {
            NativeSpacesAssistantScreen(api: api, pageID: pageId, workspaceID: model.workspaceId)
        }
        .refreshable {
            await model.refresh()
            if hasHomeSections { await homeSections.refresh() }
            if conversationStore.hydrated { await conversationStore.reload() }
        }
        .featureBusy(model.saving)
        .confirmationDialog("Delete this page?", isPresented: $model.confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    if await model.deletePage() { dismiss() }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The page moves to trash. Child pages in the same deletion group go with it.")
        }
        .navigationDestination(item: $model.openedTaskId) { taskId in
            FeatureDatabaseScreen(api: api, databaseId: taskId, workspaceId: model.workspaceId, initialViewId: taskViewID)
        }
        .navigationDestination(isPresented: $model.openedHistory) {
            FeaturePageHistoryScreen(api: api, pageId: pageId, workspaceId: model.workspaceId, workspaces: workspaces)
        }
        .navigationDestination(item: $richDestination) { destination in
            switch destination {
            case .page(let id): FeaturePageScreen(api: api, pageId: id, workspaceId: model.workspaceId, workspaces: workspaces)
            case .database(let id, let view): FeatureDatabaseScreen(api: api, databaseId: id, workspaceId: model.workspaceId, initialViewId: view)
            case .file(let path):
                ArtifactDetail(api: api, workspaceID: model.workspaceId, artifact: ["file_path": .string(path), "name": .string(MichiAPI.safeArtifactFilename(path))])
            case .assistant(let prompt):
                NativeSpacesAssistantScreen(api: api, pageID: pageId, workspaceID: model.workspaceId, initialPrompt: prompt)
            case .proposal(let page, let workspace):
                FeaturePageHistoryScreen(api: api, pageId: page, workspaceId: workspace, workspaces: workspaces)
            case .component(let id, let version):
                NativeComponentLibraryScreen(api: api, workspaceID: model.workspaceId, workspaces: workspaces, initialComponentID: id, initialVersion: version)
            }
        }
        .sheet(item: $openedConversation, onDismiss: closeConversationStreams) { opened in
            NavigationStack {
                if let chat = conversationStore.chat(for: opened.id) {
                    ConversationView(chat: chat, store: conversationStore)
                        .navigationDestination(item: $conversationStore.selectedNodeID) { id in
                            if let next = conversationStore.chat(for: id) { ConversationView(chat: next, store: conversationStore) }
                        }
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { closeConversation() } } }
                }
            }
        }
        .task {
            await model.refresh()
            if model.blocks.contains(where: { ["threads", "conflict"].contains($0["type"].stringValue) }) { await conversationStore.reload() }
        }
        .task(id: pageVisible && scenePhase == .active && hasHomeSections && openedConversation == nil) {
            guard pageVisible, scenePhase == .active, hasHomeSections, openedConversation == nil else { homeSections.stop(); return }
            while !Task.isCancelled {
                await homeSections.refresh()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
        .onAppear { pageVisible = true }
        .onDisappear { pageVisible = false; conversationStore.disconnectStreams(); homeSections.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { homeSections.stop(); conversationStore.disconnectStreams() }
            else if phase == .active && openedConversation != nil { conversationStore.resumeStreams() }
        }
        .onChange(of: sizeClass) { _, _ in
            guard showRegularInspector || showCompactAssistant else { return }
            openAssistant()
        }
    }

    @ViewBuilder
    private func mainContentBlocks(scroll: ScrollViewProxy) -> some View {
        ForEach(model.blocks.filter(RichPageBlockModel.isMainContent), id: \.id) { block in
            blockEditor(block, scroll: scroll)
                .id(block.id)
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .accessibilityIdentifier(PageNavigation.blockAccessibilityID(block.id))
                .modifier(PageNavigationAnchorPresence(id: block.id))
                .listRowInsets(EdgeInsets())
                .moveDisabled(!isEditingPage)
        }
        .onMove { source, destination in
            guard isEditingPage else { return }
            moveMainBlocks(from: source, to: destination)
        }
    }

    private func moveMainBlocks(from source: IndexSet, to destination: Int) {
        do {
            let move = try RichPageBlockModel.moveInFullPage(source: source, destination: destination, blocks: model.blocks)
            let order = model.blocks.map(\.id)
            Task {
                guard model.blocks.map(\.id) == order else { model.error = "This page changed. Try moving the block again."; return }
                await model.moveBlocks(from: move.source, to: move.destination)
            }
        } catch { model.error = error.localizedDescription }
    }

    private func blockEditor(_ block: JSONValue, scroll: ScrollViewProxy) -> some View {
        FeatureBlockEditor(api: api, block: block, workspaceId: model.workspaceId, workspaces: workspaces,
                           editing: isEditingPage,
                           onApply: { input, id, rev in await model.updateBlock(id: id, expectRev: rev, input: input) },
                           onDelete: { Task { await model.deleteBlock(id: block.id) } },
                           richContent: AnyView(NativeRichPageBlock(
                            block: block, pageBlocks: model.blocks,
                            onApply: { input, id, rev in await model.updateBlock(id: id, expectRev: rev, input: input) },
                            onOpenThread: { openConversation($0) },
                            onOpenPage: { richDestination = .page($0) },
                            onOpenDatabase: { richDestination = .database($0, $1) },
                            onOpenTasks: { view in taskViewID = view; Task { await model.openTasks() } },
                            onPrompt: { prompt in richDestination = .assistant(prompt); return true },
                            onOpenFile: { richDestination = .file($0) },
                            onScrollToBlock: { id in scrollToValidated(id, scroll: scroll) },
                            onOpenComponent: { id, version in richDestination = .component(id, version) },
                            homeSectionContent: { key in
                                if let section = NativeHomeSection(rawValue: key) {
                                    return AnyView(NativePageHomeSectionView(model: homeSections, section: section, onOpen: openReminder))
                                }
                                return AnyView(Text("This reminder section is unsupported."))
                            },
                            threadRows: conversationStore.graphs.first { $0.id == model.workspaceId }?.nodes ?? []
                           )))
    }
    private var hasHomeSections: Bool { NativePageHomeSectionModel.containsSection(in: model.blocks) }

    private var pageComponentOwnership: NativePageComponentOwnership {
        NativePageComponentOwnership(
            connectionIdentity: api.baseURL.absoluteString,
            credentialIdentity: api.credentialIdentityFingerprint,
            workspaceID: model.workspaceId,
            pageID: model.page.id,
            expectedID: pageId,
            title: model.title,
            revision: model.revision,
            readOnly: model.saving || model.page["readOnly"] == true || model.page["editable"] == false || model.revision <= 0,
            available: NativePageComponentContract.exact(model.page.id, pageId) && !model.workspaceId.isEmpty && model.revision > 0
        )
    }

    private var pageComponentActions: NativePageComponentActions {
        NativePageComponentActions(
            onNavigatePage: { richDestination = .page($0) },
            onAskDraft: { richDestination = .assistant($0) }
        )
    }

    private var workspaceKick: String {
        let name = workspaces.first { $0.id == model.workspaceId }.map(featureWorkspaceName) ?? model.page["workspaceName"].optionalString
        if let name, !name.isEmpty { return "Page · \(name)" }
        return "Page"
    }

    private var pageMetaLine: String {
        var parts: [String] = []
        if !model.page["updatedAt"].isNull {
            parts.append("updated \(featureRelative(model.page["updatedAt"].featureOptionalNumber))")
        }
        if model.revision > 0 { parts.append("rev \(model.revision)") }
        if !model.page["color"].isNull { parts.append(model.page["color"].stringValue) }
        return parts.joined(separator: " · ")
    }

    /// Wait for the first confirmed page snapshot, then scroll once. Missing
    /// or duplicate identities are reported; this does not write the page.
    private func consumeScrollTarget(_ scroll: ScrollViewProxy) {
        guard let target = pendingScrollTarget, model.revision > 0, !model.loading, !model.page.isNull else { return }
        applyScroll(target, scroll: scroll)
        pendingScrollTarget = nil
    }

    private func scrollToValidated(_ id: String, scroll: ScrollViewProxy) {
        applyScroll(id, scroll: scroll)
    }

    private func applyScroll(_ id: String, scroll: ScrollViewProxy) {
        guard case .scroll(let target) = PageNavigation.resolveOnPage(targetID: id, blocks: model.blocks) else {
            model.error = "The referenced block is no longer available in this version of the page."
            return
        }
        if target.revealNamedViews { revealNamedViews = true }
        navigationCommand = PageNavigationCommand(target: target)
    }

    private func openReminder(_ item: NativeHomeSectionItem) {
        switch item.target {
        case .conversation(let node, let workspace): openConversation(node, workspaceID: workspace)
        case .page(let page, _, _): richDestination = .proposal(page, item.workspaceID ?? "")
        }
    }
    private func openConversation(_ id: String, workspaceID: String? = nil) {
        guard !openingConversation else { return }
        let targetWorkspace = workspaceID ?? model.workspaceId
        openingConversation = true
        Task {
            defer { openingConversation = false }
            await conversationStore.reload()
            guard pageVisible, scenePhase == .active else { return }
            guard conversationStore.hydrated, conversationStore.error == nil,
                  let graph = conversationStore.graphs.first(where: { $0.id == targetWorkspace && !$0.isDeleted && !$0.isSystem }),
                  let node = graph.node(id), node["deleted_at"].isNull, graph.isConversation(node) else {
                model.error = conversationStore.error ?? "This conversation moved or is no longer available in this workspace."; return
            }
            conversationStore.selectedWorkspaceID = graph.id
            conversationStore.selectedNodeID = nil
            openedConversation = FeaturePageOpenedConversation(id: id)
            conversationStore.startObserving()
        }
    }
    private func closeConversation() {
        openedConversation = nil
        closeConversationStreams()
    }

    private func closeConversationStreams() {
        conversationStore.selectedNodeID = nil
        conversationStore.disconnectStreams()
    }

    private func openAssistant() {
        let regular = sizeClass == .regular
        showRegularInspector = regular
        showCompactAssistant = !regular
    }
}

private struct FeaturePageOpenedConversation: Identifiable {
    let id: String
}

private enum NativePageBlockDestination: Hashable {
    case page(String), database(String, String?), file(String), assistant(String), proposal(String, String), component(String, Int?)
}

private struct FeatureCreateChildPageSheet: View {
    @ObservedObject var model: FeaturePageModel
    let workspaces: [JSONValue]
    @State private var title = ""
    @State private var created: JSONValue?

    var body: some View {
        Form {
            TextField("Title", text: $title)
            Button("Create") {
                Task { created = await model.createChild(title: title) }
            }
            .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if let created {
                NavigationLink("Open \(featureNamed(created))") {
                    FeaturePageScreen(api: model.api, pageId: created.id, workspaceId: model.workspaceId, workspaces: workspaces)
                }
            }
        }
        .navigationTitle("New page")
    }
}

struct FeatureBlockEditor: View {
    let api: MichiAPI
    let block: JSONValue
    let workspaceId: String
    let workspaces: [JSONValue]
    var editing = true
    let onApply: (JSONValue, String, Int) async -> Bool
    let onDelete: () -> Void
    var richContent: AnyView? = nil

    private var type: String { block["type"].stringValue }

    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: editing ? 8 : 0) {
            HStack {
                Label(type.replacingOccurrences(of: "-", with: " "), systemImage: featureBlockSymbol(type))
                    .font(MichiFont.tag)
                    .tracking(0.66)
                    .foregroundStyle(tokens.muted)
                    .textCase(.uppercase)
                Spacer()
                Button(role: .destructive, action: onDelete) {
                    Image(systemName: "trash")
                        .foregroundStyle(tokens.dangerText)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Delete block")
            }
            .featurePageMountedEditor(visible: editing)

            if let richContent {
                richContent
                Group {
                    if ["heading", "markdown", "callout", "checklist"].contains(type) {
                        DisclosureGroup("Edit block") {
                            FeatureBlockBody(api: api, block: block, workspaceId: workspaceId, workspaces: workspaces, onApply: onApply)
                        }
                    } else {
                        DisclosureGroup("Inspect & edit fields") { FeatureUnknownBlock(block: block, onApply: onApply) }
                    }
                }
                .featurePageMountedEditor(visible: editing)
            } else {
                FeatureBlockBody(api: api, block: block, workspaceId: workspaceId, workspaces: workspaces, onApply: onApply)
                    .featurePageMountedEditor(visible: editing)
                NativePageSourcesControl(block: block, savedContent: true)
                    .featurePageMountedEditor(visible: editing)
                if featureIsUnsupportedCustomBlock(block) {
                    FeatureUnsupportedCustomNotice(value: block)
                        .featurePageMountedEditor(visible: !editing)
                }
            }
        }
        .padding(.vertical, 4)
        .nativeMichiReferences(api: api)
    }
}

/// Keeps an editor subtree mounted (so `@State` drafts survive read/edit) while
/// taking no layout space and accepting no hits, focus, or VoiceOver when hidden.
private struct FeaturePageMountedEditorPresence: ViewModifier {
    var visible: Bool

    func body(content: Content) -> some View {
        content
            .disabled(!visible)
            .allowsHitTesting(visible)
            .accessibilityHidden(!visible)
            .opacity(visible ? 1 : 0)
            .frame(maxHeight: visible ? nil : 0, alignment: .top)
            .clipped()
    }
}

private extension View {
    func featurePageMountedEditor(visible: Bool) -> some View {
        modifier(FeaturePageMountedEditorPresence(visible: visible))
    }
}

private struct FeatureBlockBody: View {
    let api: MichiAPI
    let block: JSONValue
    let workspaceId: String
    let workspaces: [JSONValue]
    let onApply: (JSONValue, String, Int) async -> Bool

    var body: some View {
        switch block["type"].stringValue {
        case "heading":
            FeatureTextBlockEditor(block: block, field: "text", axis: .horizontal, onApply: onApply)
        case "markdown":
            FeatureMarkdownEditor(block: block, onApply: onApply)
        case "callout":
            FeatureCalloutEditor(block: block, onApply: onApply)
        case "checklist":
            FeatureChecklistEditor(block: block, onApply: onApply)
        case "database-ref":
            NavigationLink {
                FeatureDatabaseScreen(api: api, databaseId: block["databaseId"].stringValue, workspaceId: workspaceId)
            } label: {
                Label("Open database", systemImage: "tablecells")
            }
        case "page-link":
            NavigationLink {
                FeaturePageScreen(api: api, pageId: block["pageId"].stringValue, workspaceId: workspaceId, workspaces: workspaces)
            } label: {
                Label("Open linked page", systemImage: "link")
            }
        case "task-view":
            if !block["databaseId"].stringValue.isEmpty {
                NavigationLink {
                    FeatureDatabaseScreen(api: api, databaseId: block["databaseId"].stringValue, workspaceId: workspaceId)
                } label: {
                    Label("Open task board", systemImage: "checkmark.circle")
                }
            } else {
                NavigationLink {
                    FeatureAllTasksScreen(api: api, workspaces: workspaces)
                } label: {
                    Label("Open All tasks", systemImage: "checkmark.circle")
                }
            }
        case "component":
            if featureCanHostRegisteredComponent(block) {
                FeatureUnknownBlock(block: block, onApply: onApply)
            } else {
                FeatureUnsupportedCustomNotice(value: block)
            }
        default:
            if featureIsUnsupportedCustomBlock(block) {
                FeatureUnsupportedCustomNotice(value: block)
            } else {
                FeatureUnknownBlock(block: block, onApply: onApply)
            }
        }
    }
}

private struct FeatureTextBlockEditor: View {
    let block: JSONValue
    let field: String
    var axis: Axis = .vertical
    let onApply: (JSONValue, String, Int) async -> Bool
    @State private var session = FeatureBlockSession()
    @State private var text = ""
    @State private var loadedText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            FeatureDraftConflictNote(message: session.conflict)
            Group {
                if axis == .vertical {
                    TextEditor(text: $text)
                        .frame(minHeight: 72)
                        .font(.body)
                } else {
                    TextField("Text", text: $text, axis: .vertical)
                        .font(.headline)
                }
            }
            .onSubmit { Task { await apply() } }
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Apply") { Task { await apply() } }
                }
            }
        }
        .onAppear { adopt(force: true) }
        .onChange(of: block.id) { _, _ in adopt(force: false) }
        .onChange(of: block["rev"].intValue) { _, _ in adopt(force: false) }
        .onChange(of: block[field].stringValue) { _, _ in adopt(force: false) }
    }

    private func adopt(force: Bool) {
        guard session.consider(block, dirty: !force && text != loadedText) else { return }
        text = block[field].stringValue
        loadedText = text
    }

    private func apply() async {
        var next = featureBlockInput(from: block)
        next[field] = .string(text)
        if await onApply(next, session.id, session.rev) {
            loadedText = text
            session.capture(block)
        }
    }
}

private struct FeatureMarkdownEditor: View {
    let block: JSONValue
    let onApply: (JSONValue, String, Int) async -> Bool
    @State private var session = FeatureBlockSession()
    @State private var text = ""
    @State private var loadedText = ""
    @State private var preview = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            FeatureDraftConflictNote(message: session.conflict)
            Toggle("Preview", isOn: $preview)
                .font(.caption)
            if preview {
                FeatureMarkdownBlock(text: text)
            } else {
                TextEditor(text: $text)
                    .frame(minHeight: 96)
                    .font(.body)
            }
            Button("Apply") { Task { await apply() } }
                .font(.footnote.weight(.semibold))
        }
        .onAppear { adopt(force: true) }
        .onChange(of: block.id) { _, _ in adopt(force: false) }
        .onChange(of: block["rev"].intValue) { _, _ in adopt(force: false) }
        .onChange(of: block["text"].stringValue) { _, _ in adopt(force: false) }
    }

    private func adopt(force: Bool) {
        guard session.consider(block, dirty: !force && text != loadedText) else { return }
        text = block["text"].stringValue
        loadedText = text
    }

    private func apply() async {
        var next = featureBlockInput(from: block)
        next["text"] = .string(text)
        if await onApply(next, session.id, session.rev) {
            loadedText = text
            session.capture(block)
        }
    }
}

private struct FeatureCalloutEditor: View {
    let block: JSONValue
    let onApply: (JSONValue, String, Int) async -> Bool
    @State private var session = FeatureBlockSession()
    @State private var title = ""
    @State private var text = ""
    @State private var tone = "info"
    @State private var loadedTitle = ""
    @State private var loadedText = ""
    @State private var loadedTone = "info"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            FeatureDraftConflictNote(message: session.conflict)
            Picker("Tone", selection: $tone) {
                Text("Info").tag("info")
                Text("Success").tag("success")
                Text("Warn").tag("warn")
                Text("Danger").tag("danger")
            }
            .pickerStyle(.segmented)
            TextField("Title", text: $title)
            TextEditor(text: $text)
                .frame(minHeight: 64)
            Button("Apply") { Task { await apply() } }
                .font(.footnote.weight(.semibold))
        }
        .onAppear { adopt(force: true) }
        .onChange(of: block.id) { _, _ in adopt(force: false) }
        .onChange(of: block["rev"].intValue) { _, _ in adopt(force: false) }
    }

    private var dirty: Bool { title != loadedTitle || text != loadedText || tone != loadedTone }

    private func adopt(force: Bool) {
        guard session.consider(block, dirty: !force && dirty) else { return }
        title = block["title"].stringValue
        text = block["text"].stringValue
        tone = block["tone"].optionalString ?? "info"
        loadedTitle = title
        loadedText = text
        loadedTone = tone
    }

    private func apply() async {
        var next = featureBlockInput(from: block)
        next["text"] = .string(text)
        next["tone"] = .string(tone)
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var fields = next.objectValue
            fields.removeValue(forKey: "title")
            next = .object(fields)
        } else {
            next["title"] = .string(title)
        }
        if await onApply(next, session.id, session.rev) {
            loadedTitle = title
            loadedText = text
            loadedTone = tone
            session.capture(block)
        }
    }
}

private struct FeatureChecklistEditor: View {
    let block: JSONValue
    let onApply: (JSONValue, String, Int) async -> Bool
    @State private var session = FeatureBlockSession()
    @State private var title = ""
    @State private var items: [(text: String, done: Bool)] = []
    @State private var loadedTitle = ""
    @State private var loadedItems: [(text: String, done: Bool)] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            FeatureDraftConflictNote(message: session.conflict)
            TextField("Title", text: $title)
            ForEach(items.indices, id: \.self) { index in
                HStack {
                    Toggle("", isOn: Binding(
                        get: { items[index].done },
                        set: { items[index].done = $0; Task { await apply() } }
                    ))
                    .labelsHidden()
                    TextField("Item", text: Binding(
                        get: { items[index].text },
                        set: { items[index].text = $0 }
                    ))
                }
            }
            Button("Add item") {
                items.append(("", false))
            }
            Button("Apply") { Task { await apply() } }
                .font(.footnote.weight(.semibold))
        }
        .onAppear { adopt(force: true) }
        .onChange(of: block.id) { _, _ in adopt(force: false) }
        .onChange(of: block["rev"].intValue) { _, _ in adopt(force: false) }
    }

    private var dirty: Bool {
        title != loadedTitle
            || items.count != loadedItems.count
            || zip(items, loadedItems).contains { $0.text != $1.text || $0.done != $1.done }
    }

    private func adopt(force: Bool) {
        guard session.consider(block, dirty: !force && dirty) else { return }
        title = block["title"].stringValue
        items = block["items"].arrayValue.map { item in
            (item["text"].stringValue, item["done"].boolValue)
        }
        loadedTitle = title
        loadedItems = items
    }

    private func apply() async {
        var next = featureBlockInput(from: block)
        next["items"] = .array(items.map { item in
            ["text": .string(item.text), "done": .bool(item.done)]
        })
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var fields = next.objectValue
            fields.removeValue(forKey: "title")
            next = .object(fields)
        } else {
            next["title"] = .string(title)
        }
        if await onApply(next, session.id, session.rev) {
            loadedTitle = title
            loadedItems = items
            session.capture(block)
        }
    }
}

private struct FeatureUnknownBlock: View {
    let block: JSONValue
    let onApply: (JSONValue, String, Int) async -> Bool
    @State private var session = FeatureBlockSession()
    @State private var text = ""
    @State private var loadedText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            FeatureDraftConflictNote(message: session.conflict)
            if block.objectValue.keys.contains("text") {
                TextEditor(text: $text)
                    .frame(minHeight: 64)
                Button("Apply text") { Task { await apply() } }
                    .font(.footnote.weight(.semibold))
            } else {
                Text("Structured content is preserved. Inspect its saved fields below.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            NavigationLink("Inspect fields") {
                FeatureInspectView(value: featureBlockInput(from: block), title: block["type"].stringValue)
            }
            .font(.footnote)
        }
        .onAppear { adopt(force: true) }
        .onChange(of: block.id) { _, _ in adopt(force: false) }
        .onChange(of: block["rev"].intValue) { _, _ in adopt(force: false) }
        .onChange(of: block["text"].stringValue) { _, _ in adopt(force: false) }
    }

    private func adopt(force: Bool) {
        guard session.consider(block, dirty: !force && text != loadedText) else { return }
        text = block["text"].stringValue
        loadedText = text
    }

    private func apply() async {
        var next = featureBlockInput(from: block)
        next["text"] = .string(text)
        if await onApply(next, session.id, session.rev) {
            loadedText = text
            session.capture(block)
        }
    }
}

private struct FeatureDraftConflictNote: View {
    let message: String?

    var body: some View {
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }
}
