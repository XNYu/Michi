import SwiftUI
import MichiCore

/// Pages Home canvas: designed chrome around the real Spaces Home page,
/// progress cards, first-read status, workspace homes, and reminder sections.
struct DesignPagesHomeCanvas: View {
    let api: MichiAPI
    let workspaces: [JSONValue]
    let expectedPageID: String
    let expectedWorkspaceID: String
    @ObservedObject var home: FeatureSpacesHomeModel
    var onOpenPage: (FeatureOpenedPage) -> Void
    var onOpenTasks: () -> Void
    var onOpenAssistant: () -> Void
    var onOpenMeta: () -> Void
    var onOpenHistory: () -> Void
    var onOpenReview: (FeatureOpenedPage) -> Void

    @StateObject private var page: FeaturePageModel
    @StateObject private var meta: NativeSpacesPageModel
    @StateObject private var homeSections: NativePageHomeSectionModel
    @StateObject private var conversationStore: MichiStore
    @State private var openedConversation: String?
    @State private var openingConversation = false
    @State private var pageVisible = false
    @State private var componentDestination: DesignPagesHomeComponentDestination?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.michiTokens) private var tokens

    init(
        api: MichiAPI,
        workspaces: [JSONValue],
        home: FeatureSpacesHomeModel,
        pageId: String,
        workspaceId: String,
        onOpenPage: @escaping (FeatureOpenedPage) -> Void,
        onOpenTasks: @escaping () -> Void,
        onOpenAssistant: @escaping () -> Void,
        onOpenMeta: @escaping () -> Void,
        onOpenHistory: @escaping () -> Void,
        onOpenReview: @escaping (FeatureOpenedPage) -> Void
    ) {
        self.api = api
        self.workspaces = workspaces
        self.expectedPageID = pageId
        self.expectedWorkspaceID = workspaceId
        self.home = home
        self.onOpenPage = onOpenPage
        self.onOpenTasks = onOpenTasks
        self.onOpenAssistant = onOpenAssistant
        self.onOpenMeta = onOpenMeta
        self.onOpenHistory = onOpenHistory
        self.onOpenReview = onOpenReview
        _page = StateObject(wrappedValue: FeaturePageModel(api: api, pageId: pageId, workspaceId: workspaceId))
        _meta = StateObject(wrappedValue: NativeSpacesPageModel(api: api, pageID: pageId, workspaceID: workspaceId))
        _homeSections = StateObject(wrappedValue: NativePageHomeSectionModel(api: api))
        _conversationStore = StateObject(wrappedValue: MichiStore(api: api))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                DesignPagesDocumentHeader(
                    title: page.title.isEmpty ? "Home" : page.title,
                    date: DesignPagesFormat.weekday(),
                    meta: updatedLine
                )
                .padding(.top, 8)
                DesignPagesAgentLine(text: DesignPagesFormat.agentLine(firstRun: meta.firstRun))
                    .padding(.top, 12)

                if let error = page.error ?? home.error ?? meta.error {
                    FeatureStatusBanner(title: "Pages Home needs a refresh", message: error, retry: { Task { await reload() } })
                        .padding(20)
                }
                if let progress = meta.progressError {
                    Text(progress)
                        .font(MichiFont.rowSecondary)
                        .foregroundStyle(tokens.muted)
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                }

                if !page.pendingChanges.isEmpty {
                    DesignPagesProposalBar(count: page.pendingChanges.count, action: onOpenHistory)
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                }

                document
                chats
                focus
                activity
                workspacesSection
                stalled
                decisions
                more
                Color.clear.frame(height: 24)
            }
        }
        .background(tokens.bg)
        .michiScrollEdge()
        .refreshable { await reload() }
        .task {
            await reload()
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
        .sheet(isPresented: Binding(get: { openedConversation != nil }, set: { if !$0 { closeConversation() } })) {
            NavigationStack {
                if let openedConversation, let chat = conversationStore.chat(for: openedConversation) {
                    ConversationView(chat: chat, store: conversationStore)
                        .navigationDestination(item: $conversationStore.selectedNodeID) { id in
                            if let next = conversationStore.chat(for: id) { ConversationView(chat: next, store: conversationStore) }
                        }
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { closeConversation() } } }
                }
            }
        }
        .nativeMichiReferences(api: api)
        .environment(\.nativePageComponentOwnership, pageComponentOwnership)
        .environment(\.nativePageComponentActions, pageComponentActions)
        .navigationDestination(item: $componentDestination) { destination in
            switch destination {
            case .page(let id):
                FeaturePageScreen(api: api, pageId: id, workspaceId: page.workspaceId, workspaces: workspaces)
            case .assistant(let prompt):
                NativeSpacesAssistantScreen(
                    api: api,
                    pageID: expectedPageID,
                    workspaceID: page.workspaceId,
                    initialPrompt: prompt
                )
            }
        }
    }

    private var pageComponentOwnership: NativePageComponentOwnership {
        NativePageComponentOwnership(
            connectionIdentity: api.baseURL.absoluteString,
            credentialIdentity: api.credentialIdentityFingerprint,
            workspaceID: page.workspaceId,
            pageID: page.page.id,
            expectedID: expectedPageID,
            title: page.title,
            revision: page.revision,
            readOnly: page.saving || page.page["readOnly"] == true || page.page["editable"] == false || page.revision <= 0,
            available: NativePageComponentContract.exact(page.page.id, expectedPageID)
                && NativePageComponentContract.exact(page.workspaceId, expectedWorkspaceID)
                && NativePageComponentContract.exact(page.pageId, expectedPageID)
                && !page.workspaceId.isEmpty
                && page.revision > 0
        )
    }

    private var pageComponentActions: NativePageComponentActions {
        NativePageComponentActions(
            onNavigatePage: { id in
                guard let usable = NativePageComponentContract.usablePageID(id) else { return }
                componentDestination = .page(usable)
            },
            onAskDraft: { prompt in
                guard NativePageComponentContract.usableDraft(prompt) != nil else { return }
                componentDestination = .assistant(prompt)
            }
        )
    }

    private var updatedLine: String? {
        let stamp = page.page["updatedAt"].featureOptionalNumber
        if stamp == nil { return nil }
        return "updated \(featureRelative(stamp))"
    }

    private var hasHomeSections: Bool { NativePageHomeSectionModel.containsSection(in: page.blocks) }

    @ViewBuilder private var document: some View {
        if page.loading && page.page.isNull {
            ProgressView("Loading Home document")
                .frame(maxWidth: .infinity)
                .padding(20)
        } else if !leadBlocks.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(leadBlocks, id: \.id) { block in
                    blockView(block)
                }
                if let byline = leadByline {
                    HStack(spacing: 6) {
                        Image(systemName: "wrench")
                            .font(.system(size: 11, weight: .medium))
                        Text(byline)
                    }
                    .font(MichiFont.meta)
                    .foregroundStyle(tokens.muted)
                    .padding(.horizontal, 20)
                }
            }
            .padding(.top, 16)
        }
    }

    @ViewBuilder private var chats: some View {
        let cards = meta.cards
        if !cards.isEmpty || !threadBlocks.isEmpty {
            MichiSectionHeader(title: "Chats started from Pages")
            ForEach(cards, id: \.spacesThreadID) { card in
                DesignPagesChatCard(
                    title: card["title"].stringValue.isEmpty ? "Conversation" : card["title"].stringValue,
                    subtitle: cardSubtitle(card),
                    quote: card["summary"].stringValue.isEmpty ? nil : card["summary"].stringValue,
                    state: DesignPagesFormat.cardState(card)
                ) {
                    openCard(card)
                }
            }
            ForEach(threadBlocks, id: \.id) { block in
                blockView(block)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
            }
        }
    }

    @ViewBuilder private var focus: some View {
        if !focusItems.isEmpty || !focusBlocks.isEmpty {
            MichiSectionHeader(title: "This week’s focus")
            if !focusItems.isEmpty {
                DesignPagesFocusList(items: focusItems)
            }
            ForEach(focusBlocks, id: \.id) { block in
                blockView(block)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
            }
        }
    }

    @ViewBuilder private var activity: some View {
        let waiting = homeSections.items(in: .waiting)
        if !page.pendingChanges.isEmpty || !waiting.isEmpty || !activityBlocks.isEmpty {
            MichiSectionHeader(title: "Activity")
            DesignPagesInsetGroup {
                ForEach(page.pendingChanges, id: \.id) { change in
                    DesignPagesActivityRow(
                        title: featurePageChangeLabel(change),
                        subtitle: [page.title, featureRelative(change["createdAt"].featureOptionalNumber)].filter { !$0.isEmpty }.joined(separator: " · "),
                        state: .waiting,
                        action: onOpenHistory
                    )
                    divider
                }
                ForEach(waiting) { item in
                    DesignPagesActivityRow(
                        title: item.title,
                        subtitle: [item.workspaceName, item.summary].filter { !$0.isEmpty }.joined(separator: " · "),
                        state: .waiting
                    ) { openReminder(item) }
                    divider
                }
            }
            ForEach(activityBlocks, id: \.id) { block in
                blockView(block)
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
            }
        }
    }

    @ViewBuilder private var workspacesSection: some View {
        let rows = home.workspaceHomes.isEmpty ? home.workspaces.filter { !$0.id.isEmpty } : home.workspaceHomes
        if !rows.isEmpty {
            MichiSectionHeader(title: "Workspaces")
            DesignPagesInsetGroup {
                ForEach(rows, id: \.designPagesWorkspaceIdentity) { item in
                    let workspaceId = item.featureWorkspaceKey
                    Button {
                        Task { await home.openWorkspaceHome(workspaceId) }
                    } label: {
                        MichiHairlineRow(
                            title: item["workspaceName"].optionalString ?? featureWorkspaceName(item),
                            subtitle: DesignPagesFormat.workspaceSubtitle(item),
                            leading: { Image(systemName: "folder").foregroundStyle(tokens.muted) },
                            trailing: {
                                if item["pendingProposals"].intValue > 0 {
                                    MichiThreadStateDot(state: .waiting)
                                } else {
                                    MichiThreadStateDot(state: .running)
                                }
                            }
                        )
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        if !DesignPageBatch.homePageID(item).isEmpty {
                            Button("Review proposals") {
                                onOpenReview(FeatureOpenedPage(id: DesignPageBatch.homePageID(item), workspaceId: workspaceId))
                            }
                        }
                        Button(item["hiddenAt"].isNull ? "Hide workspace home" : "Show workspace home") {
                            Task { await home.setWorkspaceHomeHidden(workspaceId, hidden: item["hiddenAt"].isNull) }
                        }
                    }
                    divider
                }
            }
        }
    }

    @ViewBuilder private var stalled: some View {
        let rows = homeSections.items(in: .stalled)
        if !rows.isEmpty || !stalledBlocks.isEmpty {
            MichiSectionHeader(title: "Stalled")
            DesignPagesInsetGroup {
                ForEach(rows) { item in
                    DesignPagesActivityRow(
                        title: item.title,
                        subtitle: item.summary.isEmpty ? item.workspaceName : item.summary,
                        state: .stalled
                    ) { openReminder(item) }
                    divider
                }
            }
            ForEach(stalledBlocks, id: \.id) { block in
                blockView(block)
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
            }
        }
    }

    @ViewBuilder private var decisions: some View {
        if !decisionItems.isEmpty || !decisionBlocks.isEmpty {
            MichiSectionHeader(title: "Cross-workspace decisions")
            if !decisionItems.isEmpty {
                DesignPagesFocusList(items: decisionItems)
            }
            ForEach(decisionBlocks, id: \.id) { block in
                blockView(block)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
            }
        }
    }

    @ViewBuilder private var more: some View {
        ForEach(classified.rest, id: \.id) { block in
            blockView(block)
                .padding(.horizontal, 20)
                .padding(.top, 12)
        }
        if !page.children.isEmpty || !page.databases.isEmpty {
            MichiSectionHeader(title: "On this Home")
            DesignPagesInsetGroup {
                ForEach(page.children, id: \.designPagesPageIdentity) { child in
                    Button {
                        onOpenPage(FeatureOpenedPage(id: child.id, workspaceId: child["workspaceId"].stringValue.isEmpty ? page.workspaceId : child["workspaceId"].stringValue))
                    } label: {
                        MichiHairlineRow(
                            title: featureNamed(child),
                            leading: { Image(systemName: "doc.text").foregroundStyle(tokens.muted) },
                            trailing: { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                        )
                    }
                    .buttonStyle(.plain)
                    divider
                }
                ForEach(page.databases, id: \.designPagesDatabaseIdentity) { database in
                    Button {
                        onOpenPage(FeatureOpenedPage(id: page.pageId, workspaceId: page.workspaceId))
                    } label: {
                        MichiHairlineRow(
                            title: featureNamed(database, fallback: "Database"),
                            subtitle: database["role"].stringValue == "tasks" ? "Tasks · \(database["rowCount"].intValue) rows" : "\(database["rowCount"].intValue) rows",
                            leading: { Image(systemName: database["role"].stringValue == "tasks" ? "checklist" : "tablecells").foregroundStyle(tokens.muted) },
                            trailing: { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                        )
                    }
                    .buttonStyle(.plain)
                    divider
                }
            }
        }
    }

    private var divider: some View {
        Rectangle().fill(tokens.sep).frame(height: 1).padding(.leading, 56)
    }

    private var leadBlocks: [JSONValue] {
        classified.lead
    }
    private var threadBlocks: [JSONValue] { classified.threads }
    private var focusBlocks: [JSONValue] { classified.focus }
    private var activityBlocks: [JSONValue] { classified.activity }
    private var stalledBlocks: [JSONValue] { classified.stalled }
    private var decisionBlocks: [JSONValue] { classified.decisions }

    private var focusItems: [String] {
        focusBlocks.flatMap { block in
            if block["type"].stringValue == "checklist" || ["next-steps", "agenda", "milestones"].contains(block["type"].stringValue) {
                return block["items"].arrayValue.compactMap { item in
                    let text = item["text"].optionalString ?? item["title"].optionalString ?? item["label"].stringValue
                    return text.isEmpty ? nil : text
                }
            }
            return []
        }
    }

    private var decisionItems: [String] {
        decisionBlocks.flatMap { block -> [String] in
            if block["type"] == "markdown" {
                return block["text"].stringValue
                    .split(separator: "\n")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { $0.hasPrefix("- ") || $0.hasPrefix("* ") }
                    .map { String($0.dropFirst(2)) }
            }
            return []
        }
    }

    private var leadByline: String? {
        if let first = leadBlocks.first {
            let provenance = NativePageProvenance(block: first)
            if provenance.isVisible {
                return "written by Meta agent · \(updatedLine ?? featureRelative(page.page["updatedAt"].featureOptionalNumber))"
            }
        }
        if meta.isHome { return updatedLine.map { "written by Meta agent · \($0.replacingOccurrences(of: "updated ", with: ""))" } }
        return nil
    }

    private var classified: DesignPagesBlockGroups {
        DesignPagesBlockGroups(blocks: page.blocks.filter(RichPageBlockModel.isMainContent))
    }

    private func blockView(_ block: JSONValue) -> some View {
        NativeRichPageBlock(
            block: block,
            pageBlocks: page.blocks,
            onApply: { input, id, rev in await page.updateBlock(id: id, expectRev: rev, input: input) },
            onOpenThread: { openConversation($0) },
            onOpenPage: { onOpenPage(FeatureOpenedPage(id: $0, workspaceId: page.workspaceId)) },
            onOpenDatabase: { id, _ in
                onOpenPage(FeatureOpenedPage(id: page.pageId, workspaceId: page.workspaceId))
                _ = id
            },
            onOpenTasks: { _ in onOpenTasks() },
            onPrompt: { prompt in
                guard NativePageComponentContract.usableDraft(prompt) != nil else { return false }
                componentDestination = .assistant(prompt)
                return true
            },
            onOpenFile: { _ in },
            onOpenComponent: { _, _ in onOpenMeta() },
            homeSectionContent: { key in
                if let section = NativeHomeSection(rawValue: key) {
                    return AnyView(NativePageHomeSectionView(model: homeSections, section: section, onOpen: openReminder))
                }
                return AnyView(Text("This reminder section is unsupported."))
            },
            threadRows: conversationStore.graphs.first { $0.id == page.workspaceId }?.nodes ?? []
        )
        .id(block.id)
        .padding(.horizontal, 20)
    }

    private func cardSubtitle(_ card: JSONValue) -> String {
        let status = card["awaitingDetail"].optionalString ?? card["statusLine"].optionalString ?? card["status"].stringValue
        let from = card["pageTitle"].optionalString ?? page.title
        if from.isEmpty { return status }
        if status.isEmpty { return "from \(from)" }
        return "from \(from) · \(status)"
    }

    private func reload() async {
        await home.refresh()
        await page.refresh()
        await meta.refresh()
        if hasHomeSections { await homeSections.refresh() }
        if conversationStore.hydrated { await conversationStore.reload() }
    }

    private func openCard(_ card: JSONValue) {
        guard !openingConversation else { return }
        openingConversation = true
        Task {
            defer { openingConversation = false }
            guard let target = await meta.openCard(card) else { return }
            await conversationStore.reload()
            guard pageVisible, scenePhase == .active else { return }
            guard conversationStore.hydrated, conversationStore.error == nil,
                  let graph = conversationStore.graphs.first(where: { $0.id == target.workspace && !$0.isDeleted && !$0.isSystem }),
                  let node = graph.node(target.node), node["deleted_at"].isNull, graph.isConversation(node) else {
                page.error = conversationStore.error ?? meta.error ?? "This conversation moved or is no longer available."
                return
            }
            conversationStore.selectedWorkspaceID = graph.id
            conversationStore.selectedNodeID = nil
            openedConversation = target.node
            conversationStore.startObserving()
        }
    }

    private func openReminder(_ item: NativeHomeSectionItem) {
        switch item.target {
        case .conversation(let node, let workspace):
            openConversation(node, workspaceID: workspace)
        case .page(let pageId, _, _):
            onOpenPage(FeatureOpenedPage(id: pageId, workspaceId: item.workspaceID ?? page.workspaceId))
        }
    }

    private func openConversation(_ id: String, workspaceID: String? = nil) {
        guard !openingConversation else { return }
        let targetWorkspace = workspaceID ?? page.workspaceId
        openingConversation = true
        Task {
            defer { openingConversation = false }
            await conversationStore.reload()
            guard pageVisible, scenePhase == .active else { return }
            guard conversationStore.hydrated, conversationStore.error == nil,
                  let graph = conversationStore.graphs.first(where: { $0.id == targetWorkspace && !$0.isDeleted && !$0.isSystem }),
                  let node = graph.node(id), node["deleted_at"].isNull, graph.isConversation(node) else {
                page.error = conversationStore.error ?? "This conversation moved or is no longer available in this workspace."
                return
            }
            conversationStore.selectedWorkspaceID = graph.id
            conversationStore.selectedNodeID = nil
            openedConversation = id
            conversationStore.startObserving()
        }
    }

    private func closeConversation() {
        openedConversation = nil
        conversationStore.selectedNodeID = nil
        conversationStore.disconnectStreams()
    }
}

private enum DesignPagesHomeComponentDestination: Hashable, Identifiable {
    case page(String)
    case assistant(String)

    var id: String {
        switch self {
        case .page(let id): return "page\u{1e}\(id)"
        case .assistant(let prompt): return "draft\u{1e}\(prompt)"
        }
    }
}

private struct DesignPagesBlockGroups {
    let lead: [JSONValue]
    let threads: [JSONValue]
    let focus: [JSONValue]
    let activity: [JSONValue]
    let stalled: [JSONValue]
    let decisions: [JSONValue]
    let rest: [JSONValue]

    init(blocks: [JSONValue]) {
        var lead: [JSONValue] = []
        var threads: [JSONValue] = []
        var focus: [JSONValue] = []
        var activity: [JSONValue] = []
        var stalled: [JSONValue] = []
        var decisions: [JSONValue] = []
        var rest: [JSONValue] = []
        var sawLead = false
        for block in blocks {
            let type = block["type"].stringValue
            let title = (block["title"].stringValue + " " + block["text"].stringValue).lowercased()
            if type == "threads" {
                threads.append(block)
            } else if type == "home-section" {
                switch block["section"].stringValue {
                case "stalled": stalled.append(block)
                default: activity.append(block)
                }
            } else if ["next-steps", "agenda", "milestones"].contains(type) || title.contains("focus") || title.contains("this week") {
                focus.append(block)
            } else if ["compare", "choice", "conflict"].contains(type) || title.contains("cross-workspace") || title.contains("decision") {
                decisions.append(block)
            } else if !sawLead && ["markdown", "heading", "quote", "callout"].contains(type) {
                lead.append(block)
                if type == "markdown" || type == "quote" { sawLead = true }
            } else if type == "checklist" && !sawLead {
                focus.append(block)
            } else {
                rest.append(block)
                if type == "markdown" && (title.contains("decision") || title.contains("cross")) {
                    decisions.append(block)
                    rest.removeLast()
                }
            }
        }
        if lead.isEmpty, let first = rest.first, ["markdown", "heading"].contains(first["type"].stringValue) {
            lead = [first]
            rest.removeFirst()
        }
        self.lead = lead
        self.threads = threads
        self.focus = focus
        self.activity = activity
        self.stalled = stalled
        self.decisions = decisions
        self.rest = rest
    }
}

private extension JSONValue {
    var spacesThreadID: String { self["threadNodeId"].stringValue }
}
