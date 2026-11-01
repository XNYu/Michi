import SwiftUI
import UniformTypeIdentifiers
import PhotosUI
import MichiCore

private struct ChatBranchRequest: Identifiable {
    let id = UUID()
    let anchor: String?
    var quote: String? = nil
    var question = ""
}

struct ConversationView: View {
    @ObservedObject var chat: ChatController
    @ObservedObject var store: MichiStore
    var allowsBranching: Bool
    var showsConversationSettings: Bool
    var startsWithContextPicker: Bool
    var initialMessageID: String?
    /// iPad Chats detail: Branches / Files / Context inspector column.
    var showsInspector: Bool
    @StateObject private var catalog: ChatRuntimeCatalog
    @State private var positionedMessageID: String?
    @State private var didOpenInitialContext = false
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.michiTokens) private var tokens
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var showBranches = false
    @State private var showOptions = false
    @State private var showFiles = false
    @State private var importing = false
    @State private var showDrafts = false
    @State private var showContext = false
    @State private var showMap = false
    @State private var showModelSheet = false
    @State private var photo: PhotosPickerItem?
    @State private var showCamera = false
    @State private var preparingPhoto = false
    @State private var branchError: String?
    @State private var branchRequest: ChatBranchRequest?
    @State private var selecting: NativeMessage?
    @State private var followUpsExpanded = true
    @State private var inspectorShown = false
    @State private var inspectorSheetPresented = false
    @State private var detailWidth: CGFloat = 0
    @State private var promptNotice: String?
    @StateObject private var tablePresenter = NativeMarkdownTablePresenter()
    @FocusState private var composerFocused: Bool

    init(chat: ChatController, store: MichiStore, allowsBranching: Bool = true, showsConversationSettings: Bool = true,
         startsWithContextPicker: Bool = false, initialMessageID: String? = nil, showsInspector: Bool = false) {
        _chat = ObservedObject(wrappedValue: chat)
        _store = ObservedObject(wrappedValue: store)
        self.allowsBranching = allowsBranching
        self.showsConversationSettings = showsConversationSettings
        self.startsWithContextPicker = startsWithContextPicker
        self.initialMessageID = initialMessageID
        self.showsInspector = showsInspector
        _catalog = StateObject(wrappedValue: ChatRuntimeCatalog(api: chat.api))
    }

    private var axLayout: Bool { dynamicTypeSize.isAccessibilitySize }
    private var regular: Bool { horizontalSizeClass == .regular }
    private var lastAssistantID: String? { chat.messages.last(where: { $0.role == "assistant" && !$0.id.hasPrefix("pending-") })?.id }
    private var isBranch: Bool { !chat.node["parent_node_id"].stringValue.isEmpty }
    /// A pushed compact conversation has only the floating composer (ios/Design
    /// 04/06/38). iPad's split detail (the only inspector caller) and other
    /// regular-width routes keep the sidebar/tab chrome.
    private var hidesTabBar: Bool { !regular && !showsInspector }
    private var inspectorAvailable: Bool { showsInspector && regular }
    /// Dock a 310 pt column only when the measured host is at least 360 + 310.
    /// Unknown (0) and narrower regular widths use the stored sheet instead.
    /// iPad landscape is usually `.regular` height — do not key off compact.
    private var canDockInspector: Bool { inspectorAvailable && detailWidth >= ChatInspectorLayout.dockThreshold }
    private var showsInspectorColumn: Bool { inspectorShown && canDockInspector }
    private var inspectorColumnWidth: CGFloat { showsInspectorColumn ? ChatInspectorLayout.columnWidth : 0 }
    /// Only the open table's own source (and, for a live block, its provable
    /// saved form) is watched and parsed; idle when nothing is presented.
    private var presentedTableWatch: NativeMarkdownTableWatch {
        guard tablePresenter.session != nil else { return .idle }
        return NativeMarkdownTableWatch(nodeID: chat.node.id, sources: trackedTableSources())
    }
    private var tableCoverItem: Binding<NativeMarkdownTableCoverToken?> {
        Binding(
            get: { tablePresenter.session.map { NativeMarkdownTableCoverToken(id: $0.id) } },
            set: { if $0 == nil { tablePresenter.dismiss() } }
        )
    }

    var body: some View {
        conversationDetail
        .navigationTitle(inspectorAvailable ? "" : chat.title).navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .toolbar(hidesTabBar ? .hidden : .automatic, for: .tabBar)
        .toolbar {
            if !inspectorAvailable {
                ToolbarItem(placement: .principal) { titleView }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if allowsBranching && !axLayout {
                    Button { showBranches = true } label: { Image(systemName: "point.3.connected.trianglepath.dotted") }
                        .accessibilityLabel("Branches").accessibilityIdentifier("branches")
                }
                moreMenu
                if inspectorAvailable {
                    Button { setInspectorShown(!inspectorShown) } label: { Image(systemName: "sidebar.right") }
                        .accessibilityLabel(inspectorShown ? "Hide inspector" : "Show inspector")
                        .accessibilityIdentifier("conversation-inspector")
                }
            }
        }
        .task {
            chat.enableFollowUps = preferences.followUps
            if !chat.loaded { await chat.load() }
            if startsWithContextPicker && !didOpenInitialContext && chat.loaded {
                didOpenInitialContext = true; showContext = true
            }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--preview-composer") && ProcessInfo.processInfo.arguments.contains("--uitesting") {
                chat.draft = "Compare the two options"; chat.quotedText = "A native place for your ideas."; chat.quoteSource = ["type": "artifact", "name": "Project notes", "filePath": "notes.md"]
            }
            if ProcessInfo.processInfo.arguments.contains("--uitesting"), ProcessInfo.processInfo.arguments.contains("--preview-permission"), !chat.busy {
                chat.draft = "Check the native app"; chat.send()
            }
            #endif
        }
        .onChange(of: preferences.followUps) { _, value in chat.enableFollowUps = value }
        .sheet(isPresented: $showBranches) { BranchPicker(store: store, graphID: chat.graph.id, treeID: chat.node["tree_id"].stringValue) }
        .sheet(isPresented: $showOptions) { ChatOptionsScreen(chat: chat) }
        .sheet(isPresented: $showDrafts) { NativeDraftsScreen(chat: chat) }
        .sheet(isPresented: $showContext) { NativeContextPicker(chat: chat) }
        .sheet(item: $branchRequest) { request in
            NewBranchSheet(store: store, parent: chat, anchor: request.anchor, quote: request.quote, initialQuestion: request.question)
        }
        .sheet(item: $selecting) { message in
            NativeMessageSelectionSheet(text: message.role == "assistant" ? AssistantText.visible(message.text) : message.text,
                                        canBranch: allowsBranching && !chat.isReadOnly && !message.id.hasPrefix("pending-"),
                                        onQuote: { text in chat.quotedText = text; chat.quoteSource = message.role == "assistant" ? .null : ["type": "attached"]; composerFocused = true },
                                        onBranch: { text in branchRequest = ChatBranchRequest(anchor: message.role == "assistant" ? message.id : lastAssistantID, quote: text) })
        }
        .sheet(isPresented: $showModelSheet) {
            ScrollView { ChatModelPopover(chat: chat, catalog: catalog).frame(maxWidth: .infinity) }
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showMap) { mapSheet }
        .onChange(of: photo) { _, selected in
            guard let selected else { return }
            preparingPhoto = true
            Task {
                defer { preparingPhoto = false }
                do {
                    guard let bytes = try await selected.loadTransferable(type: Data.self), bytes.count <= 20 * 1024 * 1024 else { throw NativeFailure("Choose a photo smaller than 20 MB.") }
                    let ext = selected.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent("michi-photo-" + UUID().uuidString + "." + ext)
                    try bytes.write(to: url, options: .atomic)
                    defer { try? FileManager.default.removeItem(at: url) }
                    await chat.upload(url)
                } catch { chat.error = error.localizedDescription }
                photo = nil
            }
        }
        .environment(\.markdownTablePresenter, tablePresenter)
        .fullScreenCover(item: tableCoverItem) { _ in
            NativeMarkdownTablePresentedCover(presenter: tablePresenter)
                .nativeMichiReferences(api: chat.api)
        }
        .onChange(of: presentedTableWatch) { _, _ in refreshPresentedTable() }
        .fullScreenCover(isPresented: $showCamera) {
            NativeCameraCapture { bytes in
                showCamera = false
                guard let bytes else { return }
                preparingPhoto = true
                Task {
                    defer { preparingPhoto = false }
                    do {
                        guard bytes.count <= 20 * 1024 * 1024 else { throw NativeFailure("Choose a photo smaller than 20 MB.") }
                        let url = FileManager.default.temporaryDirectory.appendingPathComponent("michi-camera-" + UUID().uuidString + ".jpg")
                        try bytes.write(to: url, options: .atomic)
                        defer { try? FileManager.default.removeItem(at: url) }
                        await chat.upload(url)
                    } catch { chat.error = error.localizedDescription }
                }
            }.ignoresSafeArea()
        }
        .sheet(isPresented: $inspectorSheetPresented) { inspectorSheet }
        .sheet(isPresented: $showFiles) { ArtifactScreen(api: chat.api, graph: store.graph(for: chat.node.id) ?? chat.graph, subtitle: chat.title, onQuote: { text, source in chat.quotedText = text; chat.quoteSource = source; showFiles = false }) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result { case .success(let urls): Task { for url in urls { await chat.upload(url) } }; case .failure(let error): chat.error = error.localizedDescription }
        }
        .nativeMichiReferences(api: chat.api)
    }

    // MARK: Chrome

    private var titleView: some View {
        VStack(spacing: 1) {
            Text(chat.title)
                .font(MichiFont.sans(size: axLayout ? 19 : 15, relativeTo: .headline, weight: .semibold))
                .foregroundStyle(tokens.fg).lineLimit(1)
            if !axLayout {
                Text([chat.graph.name, isBranch ? "branch" : "main"].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(MichiFont.mono(size: 11, relativeTo: .caption2)).foregroundStyle(tokens.muted).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var moreMenu: some View {
        Menu {
            if inspectorAvailable {
                Button(inspectorShown ? "Hide inspector" : "Show inspector", systemImage: "sidebar.right") { setInspectorShown(!inspectorShown) }
            }
            if allowsBranching {
                if axLayout { Button("Branches", systemImage: "point.3.connected.trianglepath.dotted") { showBranches = true } }
                Button("New branch", systemImage: "arrow.triangle.branch") { branchRequest = ChatBranchRequest(anchor: lastAssistantID) }.disabled(chat.isReadOnly)
                if store.graph(for: chat.node.id) != nil { Button("Workspace map", systemImage: "map") { showMap = true } }
            }
            if showsConversationSettings { Button("Conversation settings", systemImage: "slider.horizontal.3") { showOptions = true } }
            Button("Files & artifacts", systemImage: "paperclip") { showFiles = true }
            Button("Saved drafts", systemImage: "doc.badge.ellipsis") { showDrafts = true }
            Button("Compact context", systemImage: "arrow.down.right.and.arrow.up.left") { Task { await chat.compact() } }.disabled(chat.busy || chat.commandRunning || chat.isReadOnly || chat.pendingSubmission != nil || chat.submissionRecoveryError != nil)
            Button("Refresh history", systemImage: "arrow.clockwise") { Task { await chat.load() } }
            ShareLink(item: chat.messages.map { "## \($0.role.capitalized)\n\n\($0.text)" }.joined(separator: "\n\n")) { Label("Export conversation", systemImage: "square.and.arrow.up") }
        } label: { Image(systemName: "ellipsis") }
            .accessibilityLabel("More")
            .accessibilityIdentifier("conversation-menu")
    }

    @ViewBuilder private var mapSheet: some View {
        if let graph = store.graph(for: chat.node.id) {
            NavigationStack {
                WorkspaceOverviewScreen(api: store.api, graph: graph, startsInMap: true) { node in
                    Task {
                        await store.reload()
                        if let current = store.graph(for: node)?.node(node), current["deleted_at"].isNull {
                            showMap = false; store.select(current, workspace: current["workspace_id"].stringValue)
                        } else { store.error = "The conversation is no longer available." }
                    }
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { showMap = false } } }
            }
        }
    }

    /// Regular iPad inspector host only. `.sidebarAdaptable` can float a
    /// top-center tab strip over `.principal`; keep the same title below the bar.
    private var conversationTitleHeader: some View {
        titleView
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 6)
            .padding(.bottom, 8)
            .background(tokens.bg)
            .overlay(alignment: .bottom) { Rectangle().fill(tokens.sep).frame(height: 1) }
    }

    @ViewBuilder private var conversationDetail: some View {
        if inspectorAvailable {
            VStack(spacing: 0) {
                conversationTitleHeader
                GeometryReader { proxy in
                    HStack(spacing: 0) {
                        conversationScroll
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        inspectorColumn
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .onAppear { updateDetailWidth(proxy.size.width) }
                    .onChange(of: proxy.size.width) { _, width in updateDetailWidth(width) }
                }
            }
            .onChange(of: inspectorShown) { _, _ in applyInspectorPresentation() }
            .onChange(of: detailWidth) { _, _ in applyInspectorPresentation() }
            .onChange(of: inspectorSheetPresented) { _, presented in
                if !presented && inspectorShown && !canDockInspector { inspectorShown = false }
            }
        } else {
            conversationScroll
                .onAppear {
                    inspectorShown = false
                    inspectorSheetPresented = false
                    detailWidth = 0
                }
        }
    }

    private var inspectorColumn: some View {
        ChatInspector(chat: chat, store: store, onOpenFiles: { showFiles = true })
            .frame(width: ChatInspectorLayout.columnWidth, alignment: .top)
            .frame(width: inspectorColumnWidth, alignment: .leading)
            .clipped()
            .overlay(alignment: .leading) { Rectangle().fill(tokens.sep).frame(width: 1) }
            .accessibilityHidden(!showsInspectorColumn)
            .allowsHitTesting(showsInspectorColumn)
    }

    private var inspectorSheet: some View {
        NavigationStack {
            ChatInspector(chat: chat, store: store, onOpenFiles: { showFiles = true; setInspectorShown(false) })
                .navigationTitle("Inspector")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { setInspectorShown(false) } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func updateDetailWidth(_ width: CGFloat) {
        if detailWidth != width { detailWidth = width }
    }

    private func setInspectorShown(_ shown: Bool) {
        inspectorShown = shown
        applyInspectorPresentation()
    }

    private func applyInspectorPresentation() {
        let wantsSheet = inspectorAvailable && inspectorShown && !canDockInspector
        if inspectorSheetPresented != wantsSheet { inspectorSheetPresented = wantsSheet }
    }

    // MARK: Transcript

    private var conversationScroll: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if chat.loaded, let initialMessageID, !chat.messages.contains(where: { $0.id == initialMessageID }) {
                        Label("The referenced message is no longer in this saved conversation.", systemImage: "exclamationmark.bubble")
                            .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                    }
                    branchedFrom
                    if chat.messages.isEmpty && chat.answer.isEmpty && !chat.loading {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("What are we working on?").font(MichiFont.sans(size: 22, relativeTo: .title2, weight: .semibold)).foregroundStyle(tokens.fg)
                            Text("Ask a question, explore an idea, or hand a task to your agent.").font(MichiFont.row).foregroundStyle(tokens.mid)
                        }.padding(.vertical, 30)
                    }
                    messageRows
                    if preferences.showThoughts && !chat.plan.isEmpty {
                        DisclosureGroup {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(chat.plan.enumerated()), id: \.offset) { _, item in
                                    let status = item["status"].stringValue
                                    Label(item["content"].stringValue, systemImage: status == "completed" ? "checkmark.circle.fill" : status == "in_progress" ? "circle.lefthalf.filled" : "circle")
                                        .font(MichiFont.row)
                                        .foregroundStyle(status == "completed" ? tokens.digest : status == "in_progress" ? tokens.selectInk : tokens.mid)
                                }
                            }.padding(.top, 6)
                        } label: { structuralLabel("Plan") }
                    }
                    liveSection
                    if !chat.subagents.isEmpty {
                        DisclosureGroup {
                            ForEach(Array(chat.subagents.enumerated()), id: \.offset) { _, agent in
                                LabeledContent(agent["name"].optionalString ?? agent["sessionId"].stringValue, value: agent["status"].stringValue)
                                    .font(MichiFont.mono(size: 12.5, relativeTo: .caption)).foregroundStyle(tokens.mid)
                            }
                        } label: { structuralLabel("Agent activity") }
                    }
                    if let permission = chat.pendingPermission {
                        PermissionCard(request: permission, modeLabel: ChatPermissionCopy.title(chat.permissionMode) + " mode") { option in Task { await chat.permission(option) } }
                    }
                    if let question = chat.pendingQuestion { QuestionCard(request: question) { answers, skip in Task { await chat.respond(answers: answers, skip: skip) } }.id(question["interactionId"].optionalString ?? String(question["requestId"].intValue)) }
                    if let error = chat.error {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(tokens.dangerText)
                            if chat.busy {
                                Button("Reconnect to response") { chat.resumeIfNeeded() }
                                    .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .semibold))
                                    .michiGlassButton()
                            }
                        }.font(MichiFont.row).accessibilityIdentifier("chat-error")
                    }
                    submissionRecovery
                    if let branchError { Text(branchError).font(MichiFont.row).foregroundStyle(tokens.dangerText) }
                    if let result = chat.commandResult {
                        DisclosureGroup {
                            Text(result).font(MichiFont.code).foregroundStyle(tokens.fg).textSelection(.enabled).padding(.top, 6)
                        } label: { structuralLabel("Command result") }
                    }
                    if chat.busy && chat.liveBlocks.isEmpty && chat.pendingPermission == nil {
                        ChatAssistantHeader(status: chat.statusText.isEmpty ? "Working…" : chat.statusText, state: .streaming)
                    }
                    followUps
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 24)
                .frame(maxWidth: preferences.readingWidth.map { CGFloat($0) } ?? (regular ? 544 : .infinity))
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .defaultScrollAnchor(initialMessageID == nil ? .bottom : .top)
            .scrollDismissesKeyboard(.interactively)
            .background(tokens.bg)
            .michiScrollEdge()
            .overlay { if chat.loading && !chat.loaded { ProgressView("Loading conversation…").font(MichiFont.row).tint(tokens.mid) } }
            .safeAreaInset(edge: .bottom, spacing: 0) { composerArea }
            .onChange(of: chat.pendingPermission != nil || chat.pendingQuestion != nil) { _, pending in if pending { withAnimation(preferences.reduceMotion ? nil : .default) { proxy.scrollTo("bottom", anchor: .bottom) } } }
            .onChange(of: chat.messages.count) { _, _ in
                if initialMessageID == nil || positionedMessageID != nil { withAnimation(preferences.reduceMotion ? nil : .default) { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .task(id: chat.loaded && chat.displayedMessages.contains(where: { $0.id == initialMessageID })) {
                guard let target = initialMessageID, positionedMessageID != target,
                      chat.loaded, chat.displayedMessages.contains(where: { $0.id == target }) else { return }
                await Task.yield()
                guard !Task.isCancelled, chat.displayedMessages.contains(where: { $0.id == target }) else { return }
                proxy.scrollTo(target, anchor: .top); positionedMessageID = target
            }
        }
    }

    /// Branch source quote (web BranchedFrom). The quote is the first saved
    /// user message's quoted context, when the branch was started from one.
    @ViewBuilder private var branchedFrom: some View {
        let parentID = chat.node["parent_node_id"].stringValue
        if !parentID.isEmpty, let parent = chat.graph.node(parentID), parent["deleted_at"].isNull {
            let quote = chat.messages.first(where: { $0.role == "user" })?.metadata["quotedText"].stringValue ?? ""
            Button { store.select(parent, workspace: chat.graph.id) } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 14, weight: .medium)).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Branched from " + chat.graph.title(parent))
                            .font(MichiFont.tag).tracking(0.66).textCase(.uppercase)
                        if !quote.isEmpty {
                            Text("“\(quote)”").font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.fg).lineSpacing(4).lineLimit(4)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(tokens.accentText)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(tokens.accentF, in: UnevenRoundedRectangle(cornerRadii: .init(bottomTrailing: 4, topTrailing: 4), style: .continuous))
                .overlay(alignment: .leading) { Rectangle().fill(tokens.accent).frame(width: 2) }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the parent conversation")
        }
    }

    private var messageRows: some View {
        let promptAgain = chat.promptAgainReplyIDs
        return ForEach(chat.displayedMessages) { message in
            VStack(alignment: .leading, spacing: 4) {
                NativeMessageView(message: message, api: chat.api, workspaceID: chat.graph.id, nodeID: chat.node.id)
                    .environment(\.markdownTableDocument, .message(nodeID: chat.node.id, messageID: message.id))
                if message.role == "assistant" && !message.id.hasPrefix("pending-") { messageActions(message, promptAgain: promptAgain.includes(message.id)) }
            }
            .contextMenu {
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                Button("Quote", systemImage: "text.quote") { chat.quote(message); composerFocused = true }
                Button("Select text…", systemImage: "selection.pin.in.out") { selecting = message }
                if promptAgain.includes(message.id) {
                    Button("Use prompt again", systemImage: "arrow.clockwise") { usePromptAgain(message) }.disabled(promptAgainDisabled)
                }
                if allowsBranching { Button("Branch from here", systemImage: "arrow.triangle.branch") { branchRequest = ChatBranchRequest(anchor: message.id) }.disabled(chat.isReadOnly || message.id.hasPrefix("pending-")) }
                ShareLink(item: message.text) { Label("Share", systemImage: "square.and.arrow.up") }
            }
            .padding(message.id == initialMessageID ? 8 : 0)
            .background(message.id == initialMessageID ? tokens.accentF : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .id(message.id)
        }
    }

    /// Blocked while a response, command or saved submission is unresolved.
    /// A non-empty draft is reported on tap instead, so the user learns why.
    private var promptAgainDisabled: Bool {
        guard let blocked = chat.promptAgainBlocked else { return false }
        return blocked != .draftNotEmpty
    }

    private func usePromptAgain(_ reply: NativeMessage) {
        let outcome = chat.usePromptAgain(reply)
        promptNotice = DesignChatPromptAgain.notice(for: outcome)
        if case .filled = outcome { composerFocused = true }
    }

    private func messageActions(_ message: NativeMessage, promptAgain: Bool) -> some View {
        HStack(spacing: 0) {
            actionButton("doc.on.doc", "Copy reply") { UIPasteboard.general.string = AssistantText.visible(message.text) }
            if promptAgain {
                actionButton("arrow.clockwise", "Use prompt again") { usePromptAgain(message) }
                    .disabled(promptAgainDisabled)
                    .accessibilityHint("Puts the message that produced this reply in the composer. Nothing is sent until you tap Send.")
            }
            actionButton("selection.pin.in.out", "Select text") { selecting = message }
            if allowsBranching {
                actionButton("arrow.triangle.branch", "Branch from this reply") { branchRequest = ChatBranchRequest(anchor: message.id) }
                    .disabled(chat.isReadOnly)
            }
            ShareLink(item: AssistantText.visible(message.text)) {
                Image(systemName: "square.and.arrow.up").font(.system(size: 15)).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .foregroundStyle(tokens.muted).accessibilityLabel("Share reply")
            Spacer(minLength: 0)
            if let date = message.createdAt {
                Text(DesignChatTimestamp.label(date))
                    .font(MichiFont.mono(size: 11.5, relativeTo: .caption2)).foregroundStyle(tokens.faint)
                    .lineLimit(1)
                    .accessibilityLabel(DesignChatTimestamp.accessibilityLabel(date))
            }
        }
        .padding(.leading, -12)
    }

    private func actionButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 15)).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(tokens.muted).accessibilityLabel(label)
    }

    private var liveSegments: [ChatLiveSegment] {
        var segments: [ChatLiveSegment] = []
        var pending: [String] = []
        func flush() { if let first = pending.first { segments.append(.tools(id: "tools-" + first, ids: pending)); pending = [] } }
        for block in chat.liveBlocks {
            if case .tool(let id, _, _) = block.kind { pending.append(id) } else { flush(); segments.append(.block(block)) }
        }
        flush()
        return segments
    }

    @ViewBuilder private var liveSection: some View {
        if !chat.liveBlocks.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                ChatAssistantHeader(status: chat.busy ? (chat.pendingPermission != nil ? "Waiting for you" : (chat.statusText.isEmpty ? "Responding…" : chat.statusText)) : nil,
                                    state: chat.pendingPermission != nil ? .waiting : .streaming)
                ForEach(liveSegments) { segment in
                    switch segment {
                    case .tools(_, let ids):
                        ChatToolGroup(tools: ids.compactMap { id in chat.tools.first(where: { $0.id == id }) }, waitingForPermission: chat.pendingPermission != nil, collapsible: false)
                    case .block(let block):
                        switch block.kind {
                        case .answer:
                            NativeMarkdown(text: AssistantText.visible(block.text))
                                .environment(\.markdownTableDocument, liveTableDocument(block))
                                .accessibilityIdentifier("live-answer")
                        case .thinking:
                            if preferences.showThoughts {
                                DisclosureGroup { NativeMarkdown(text: AssistantText.visible(block.text)).foregroundStyle(tokens.mid) } label: { structuralLabel("Thinking") }
                            }
                        case .tool: EmptyView()
                        case .image(let path, let caption, _, _):
                            NativeConversationImage(api: chat.api, workspaceID: chat.graph.id, item: ["path": .string(path), "caption": caption.map(JSONValue.string) ?? .null])
                        case .userInput: EmptyView()
                        }
                    }
                }
            }
            .environment(\.liveAnswerContent, true)
        }
    }

    @ViewBuilder private var followUps: some View {
        if preferences.followUps && !chat.busy && !chat.followUps.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Button { followUpsExpanded.toggle() } label: {
                    HStack {
                        Text("Explore further").font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .medium)).foregroundStyle(tokens.mid)
                        Spacer()
                        Image(systemName: followUpsExpanded ? "chevron.down" : "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(tokens.mid)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .overlay(alignment: .top) { Rectangle().fill(tokens.line).frame(height: 1) }
                .accessibilityAddTraits(.isHeader)
                .accessibilityValue(followUpsExpanded ? "Expanded" : "Collapsed")
                if followUpsExpanded {
                    ForEach(Array(chat.followUps.enumerated()), id: \.offset) { index, followUp in
                        followUpRow(followUp)
                            .overlay(alignment: .top) { if index > 0 { Rectangle().fill(tokens.sep).frame(height: 1) } }
                    }
                }
            }
        }
    }

    @ViewBuilder private func followUpRow(_ followUp: String) -> some View {
        let fill = Button { chat.draft = followUp; composerFocused = true } label: {
            Text(followUp).font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.fg).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Adds this question to your reply")
        if axLayout {
            VStack(alignment: .leading, spacing: 4) {
                fill
                if allowsBranching { followUpBranch(followUp) }
            }.padding(.vertical, 6).padding(.leading, 10)
        } else {
            HStack(spacing: 12) {
                fill
                if allowsBranching { followUpBranch(followUp) }
            }.padding(.leading, 10)
        }
    }

    private func followUpBranch(_ followUp: String) -> some View {
        Button { branchRequest = ChatBranchRequest(anchor: lastAssistantID, question: followUp) } label: {
            Label("Branch", systemImage: "arrow.triangle.branch")
                .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .medium)).foregroundStyle(tokens.mid)
                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(chat.isReadOnly)
        .accessibilityLabel("Branch: \(followUp)")
    }

    private func structuralLabel(_ title: String) -> some View {
        Text(title).font(MichiFont.section).tracking(0.88).textCase(.uppercase).foregroundStyle(tokens.muted)
    }

    @ViewBuilder private var submissionRecovery: some View {
        if let status = chat.recoveryStatus,
           chat.error != nil || chat.reconnecting || chat.submissionRecoveryError != nil || (chat.pendingSubmission?.kind == "command" && !chat.commandRunning) {
            VStack(alignment: .leading, spacing: 8) {
                Text(status).font(MichiFont.rowSecondary).foregroundStyle(tokens.mid)
                if let text = chat.recoverableSubmissionText, !text.isEmpty {
                    DisclosureGroup {
                        Text(text).font(MichiFont.row).foregroundStyle(tokens.fg).textSelection(.enabled)
                        Button("Copy saved text", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }.font(MichiFont.row)
                    } label: { structuralLabel("Saved submission") }
                }
            }
            .padding(12)
            .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1) }
            .accessibilityIdentifier("submission-recovery")
        }
    }

    // MARK: Composer

    private var showsMeta: Bool { !axLayout && !chat.isReadOnly && (composerFocused || regular) }
    private var placeholder: String {
        if chat.busy { return "Steer or queue a message" }
        return chat.messages.isEmpty ? "Message Michi" : "Reply"
    }

    private var composerArea: some View {
        VStack(spacing: 8) {
            if chat.reconnecting {
                HStack(spacing: 8) {
                    MichiThreadStateDot(state: .streaming)
                    Text(chat.statusText.isEmpty ? "Reconnecting to this response…" : chat.statusText)
                }
                .font(MichiFont.mono(size: 12, relativeTo: .caption, weight: .medium))
                .foregroundStyle(tokens.selectInk)
                .padding(.horizontal, 14).frame(height: 34)
                .michiGlassCapsule()
                .accessibilityElement(children: .combine)
            }
            if !chat.queued.isEmpty { NativeQueuePanel(chat: chat) }
            if let error = chat.draftSaveError {
                HStack {
                    Text(error).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                    Button("Retry") { chat.retryDraftSave() }.font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .semibold))
                }
            }
            if chat.uploading || preparingPhoto { ProgressView("Uploading attachment…").font(MichiFont.rowSecondary) }
            if chat.isReadOnly {
                Label("Archived conversations are read-only", systemImage: "archivebox").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
            }
            if let promptNotice {
                HStack(alignment: .top, spacing: 8) {
                    Label(promptNotice, systemImage: "info.circle").font(MichiFont.rowSecondary).foregroundStyle(tokens.mid)
                    Spacer(minLength: 4)
                    Button { self.promptNotice = nil } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 44, height: 32) }
                        .buttonStyle(.plain).foregroundStyle(tokens.muted).accessibilityLabel("Dismiss")
                }
                .padding(.horizontal, 6)
                .accessibilityElement(children: .contain)
            }
            composerCapsule
        }
        .padding(.horizontal, 12).padding(.bottom, 8)
        .onChange(of: chat.composerSnapshot.isEmpty) { _, empty in if empty { promptNotice = nil } }
    }

    private var composerCapsule: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !chat.quotedText.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "text.quote").font(.system(size: 12, weight: .medium)).foregroundStyle(tokens.accent).padding(.top, 2)
                    Text(chat.quotedText).lineLimit(preferences.quoteLines).font(MichiFont.sans(size: 13, relativeTo: .footnote)).foregroundStyle(tokens.mid)
                    Spacer(minLength: 4)
                    Button { chat.clearQuote() } label: { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).frame(width: 44, height: 32) }
                        .buttonStyle(.plain).foregroundStyle(tokens.muted).accessibilityLabel("Remove quote")
                }
                .padding(.leading, 12).padding(.top, 6)
            }
            HStack(alignment: .bottom, spacing: 4) {
                plusMenu
                TextField(placeholder, text: $chat.draft, axis: .vertical)
                    .lineLimit(1...7)
                    .focused($composerFocused)
                    .foregroundStyle(tokens.fg)
                    .padding(.vertical, 11)
                    .accessibilityIdentifier("composer")
                    .disabled(chat.isReadOnly)
                    .modifier(MichiProseSize(size: preferences.composerSize))
                if !chat.usage["contextUsagePercentage"].isNull && !axLayout { ChatContextRing(chat: chat) }
                NativeDictationButton(draft: $chat.draft, enabled: chat.loaded && !chat.isReadOnly && !chat.busy && !chat.uploading && !preparingPhoto && chat.pendingSubmission == nil && chat.submissionRecoveryError == nil)
                trailingButtons
            }
            composerChips
            if showsMeta {
                HStack(spacing: 8) {
                    ChatPermissionControl(chat: chat, catalog: catalog)
                    ChatModelControl(chat: chat, catalog: catalog)
                    Spacer(minLength: 0)
                    Button { showContext = true } label: { ChatComposerChip(systemImage: "at") }
                        .buttonStyle(.plain).michiHitTarget()
                        .disabled(chat.isReadOnly || !chat.loaded)
                        .accessibilityLabel("Mention a chat or file")
                }
                .padding(.horizontal, 4)
            }
        }
        .padding(4)
        .michiGlassRounded(26)
        .animation(preferences.reduceMotion ? nil : .snappy(duration: 0.22), value: showsMeta)
    }

    /// Mention chips (exact range, removable) then attachment chips.
    @ViewBuilder private var composerChips: some View {
        let mentionChips = chat.mentionChips
        if !chat.attachments.isEmpty || !mentionChips.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(mentionChips) { chip in
                        Button { chat.removeMention(chip) } label: {
                            HStack(spacing: 5) {
                                Image(systemName: chip.systemImage).font(.system(size: 11))
                                Text(chip.label).lineLimit(1)
                                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                            }
                            .font(MichiFont.chip).foregroundStyle(tokens.accentText)
                            .padding(.horizontal, 10).frame(height: 28)
                            .background(tokens.accentF, in: Capsule())
                            .overlay { Capsule().stroke(tokens.accent.opacity(0.35), lineWidth: 1) }
                            .padding(.vertical, 8).contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(chat.isReadOnly)
                        .accessibilityLabel(chip.accessibilityLabel)
                    }
                    ForEach(Array(chat.attachments.enumerated()), id: \.offset) { index, file in
                        Button { chat.attachments.remove(at: index) } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "doc.text").font(.system(size: 11))
                                Text(file["name"].stringValue).lineLimit(1)
                                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                            }
                            .font(MichiFont.chip).foregroundStyle(tokens.accentText)
                            .padding(.horizontal, 10).frame(height: 28)
                            .background(tokens.accentF, in: Capsule())
                            .overlay { Capsule().stroke(tokens.accent.opacity(0.35), lineWidth: 1) }
                            .padding(.vertical, 8).contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove attachment \(file["name"].stringValue)")
                    }
                }.padding(.horizontal, 4)
            }
        }
    }

    private var plusMenu: some View {
        Menu {
            PhotosPicker(selection: $photo, matching: .images) { Label("Photo Library", systemImage: "photo") }
            if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Take Photo", systemImage: "camera") { showCamera = true } }
            Button("Choose File", systemImage: "paperclip") { importing = true }
            Divider()
            Button("Mention a chat or file", systemImage: "at") { showContext = true }
            Button("Commands", systemImage: "slash.circle") { chat.draft = "/"; composerFocused = true }.disabled(!chat.draft.isEmpty)
            Button("Saved drafts", systemImage: "doc.badge.ellipsis") { showDrafts = true }
            if axLayout {
                Divider()
                Menu { ChatPermissionMenuContent(chat: chat, catalog: catalog) } label: {
                    Label("Permissions · " + ChatPermissionCopy.title(chat.permissionMode), systemImage: "checkmark.shield")
                }.disabled(chat.controlsLocked)
                Button("Model & effort…", systemImage: "cpu") { showModelSheet = true }
                if !chat.usage["contextUsagePercentage"].isNull {
                    Button("Compact context (\(chat.usage["contextUsagePercentage"].intValue)% used)", systemImage: "arrow.down.right.and.arrow.up.left") { Task { await chat.compact() } }
                        .disabled(chat.busy || chat.commandRunning || chat.pendingSubmission != nil || chat.submissionRecoveryError != nil)
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: axLayout ? 18 : 15, weight: .semibold))
                .foregroundStyle(MichiGlass.isLiquidGlassOS ? tokens.fg : tokens.accent)
                .frame(width: axLayout ? 44 : 38, height: axLayout ? 44 : 38)
                .background(MichiGlass.isLiquidGlassOS ? tokens.fg.opacity(0.08) : .clear, in: Circle())
                .michiHitTarget()
        }
        .accessibilityLabel("Add context")
        .disabled(chat.isReadOnly || chat.uploading || preparingPhoto || !chat.loaded)
        .task { await catalog.loadStatus() }
    }

    @ViewBuilder private var trailingButtons: some View {
        let size: CGFloat = axLayout ? 44 : 38
        if chat.busy {
            if !chat.composerSnapshot.isEmpty {
                Menu {
                    Button("Queue next message", systemImage: "text.badge.plus") { chat.enqueueDraft() }
                    Button("Steer current response", systemImage: "arrow.turn.up.right") { Task { await chat.steer() } }.disabled(chat.steering)
                } label: {
                    Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).foregroundStyle(tokens.accentInk)
                        .frame(width: size, height: size).background(tokens.accent, in: Circle()).michiHitTarget()
                }
                .accessibilityLabel("Send options")
                .disabled(preparingPhoto || chat.uploading)
            }
            Button { Task { await chat.stop() } } label: {
                Image(systemName: "stop.fill").font(.system(size: 12, weight: .bold)).foregroundStyle(tokens.bg)
                    .frame(width: size, height: size).background(tokens.fg, in: Circle())
            }
            .buttonStyle(.plain).michiHitTarget()
            .accessibilityLabel("Stop response").accessibilityIdentifier("stop-response")
        } else if !chat.composerSnapshot.isEmpty {
            Button { composerFocused = false; chat.send() } label: {
                Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).foregroundStyle(tokens.accentInk)
                    .frame(width: size, height: size).background(tokens.accent, in: Circle())
            }
            .buttonStyle(.plain).michiHitTarget()
            .disabled(!chat.loaded || chat.isReadOnly || chat.uploading || preparingPhoto || chat.commandRunning || chat.pendingSubmission != nil || chat.submissionRecoveryError != nil)
            .opacity(!chat.loaded || chat.commandRunning || chat.pendingSubmission != nil || chat.submissionRecoveryError != nil ? 0.45 : 1)
            .accessibilityLabel("Send message").accessibilityIdentifier("send-message")
        }
    }
}

private enum ChatLiveSegment: Identifiable {
    case block(TurnProjection.Block)
    case tools(id: String, ids: [String])
    var id: String {
        switch self {
        case .block(let block): return "block-\(block.id)"
        case .tools(let id, _): return id
        }
    }
}

/// `> michi` prompt line; while live, the state glyph and status follow it.
struct ChatAssistantHeader: View {
    var status: String? = nil
    var state: MichiThreadState = .streaming
    @Environment(\.michiTokens) private var tokens
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var body: some View {
        HStack(spacing: 8) {
            Text(">").font(MichiFont.mono(size: 12, relativeTo: .caption, weight: .medium)).foregroundStyle(tokens.accent)
            Text("michi").font(MichiFont.mono(size: 12, relativeTo: .caption, weight: .medium)).foregroundStyle(tokens.muted)
            if let status {
                MichiThreadStateDot(state: state).padding(.leading, 2)
                Text(status).font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .medium))
                    .foregroundStyle(state == .waiting ? tokens.accentText : tokens.selectInk)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(status.map { "Michi, \($0)" } ?? "Michi")
    }
}

private struct NativeMarkdownTableCoverToken: Identifiable {
    let id: UUID
}

extension ConversationView {
    fileprivate func refreshPresentedTable() {
        guard tablePresenter.session != nil else { return }
        tablePresenter.reconcile(NativeMarkdownTableCatalog.occurrences(in: trackedTableSources()), currentNodeID: chat.node.id)
    }

    /// Same identity the inline table receives: turn, assistant message and
    /// projection block id, so stream completion can prove its saved fragment.
    fileprivate func liveTableDocument(_ block: TurnProjection.Block) -> NativeMarkdownTableDocument {
        .live(nodeID: chat.node.id, turnID: chat.turnID, assistantID: chat.liveAssistantID, blockID: block.id)
    }

    /// Rendered Markdown sources the open table depends on, mirroring what
    /// `liveSection` and `NativeMessageView` render. Untracked sources are
    /// skipped without parsing.
    fileprivate func trackedTableSources() -> [NativeMarkdownTableSource] {
        let nodeID = chat.node.id
        var sources: [NativeMarkdownTableSource] = []
        func add(_ document: NativeMarkdownTableDocument, _ markdown: () -> String) {
            if tablePresenter.tracks(document) { sources.append(.init(document: document, markdown: markdown())) }
        }
        for block in chat.liveBlocks {
            if case .answer = block.kind { add(liveTableDocument(block)) { AssistantText.visible(block.text) } }
        }
        for message in chat.displayedMessages {
            if message.blocks.isEmpty {
                add(.message(nodeID: nodeID, messageID: message.id)) {
                    message.role == "assistant" ? AssistantText.visible(message.text) : message.text
                }
            } else {
                for (offset, block) in message.blocks.enumerated() where block["kind"].stringValue == "answer" {
                    add(.message(nodeID: nodeID, messageID: message.id, fragment: offset, blockID: block["id"].optionalString)) {
                        AssistantText.visible(block["rawText"].stringValue)
                    }
                }
            }
        }
        return sources
    }
}

struct NativeMessageView: View {
    let message: NativeMessage
    let api: MichiAPI
    let workspaceID: String
    var nodeID: String? = nil
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.michiTokens) private var tokens
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if message.role == "user" { userBubble } else { assistant }
    }

    private var userBubble: some View {
        VStack(alignment: .leading, spacing: 8) {
            if message.metadata["steered"].boolValue {
                Text("Steered").font(MichiFont.tag).tracking(0.44).textCase(.uppercase).foregroundStyle(tokens.accentText)
            }
            quoted
            NativeMarkdown(text: message.text)
            attachments
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.bubble, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(alignment: .trailing) { Rectangle().fill(tokens.accent).frame(width: 2) }
        .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 30 : 56)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("You")
    }

    private var assistant: some View {
        VStack(alignment: .leading, spacing: 12) {
            ChatAssistantHeader()
            quoted
            if message.blocks.isEmpty {
                NativeMarkdown(text: message.role == "assistant" ? AssistantText.visible(message.text) : message.text)
                if !message.tools.isEmpty { ChatToolGroup(tools: message.tools, waitingForPermission: false, collapsible: true) }
            } else {
                ForEach(segments) { segment in
                    switch segment.content {
                    case .tools(let ids):
                        ChatToolGroup(tools: ids.compactMap { id in message.tools.first(where: { $0.id == id }) }, waitingForPermission: false, collapsible: true)
                    case .block(let block):
                        blockView(block, offset: segment.id)
                    }
                }
            }
            attachments
        }
    }

    @ViewBuilder private func blockView(_ block: JSONValue, offset: Int) -> some View {
        switch block["kind"].stringValue {
        case "answer":
            NativeMarkdown(text: AssistantText.visible(block["rawText"].stringValue))
                .environment(\.markdownTableDocument, answerDocument(fragment: offset, blockID: block["id"].optionalString))
        case "thinking":
            if preferences.showThoughts {
                DisclosureGroup {
                    // Not an answer fragment: no hosted table source, so a
                    // table here keeps its own local fullscreen cover.
                    NativeMarkdown(text: AssistantText.visible(block["rawText"].stringValue)).foregroundStyle(tokens.mid)
                        .environment(\.markdownTableDocument, nil)
                } label: { Text("Thinking").font(MichiFont.section).tracking(0.88).textCase(.uppercase).foregroundStyle(tokens.muted) }
            }
        case "user-input":
            let interaction = block["interaction"]
            DisclosureGroup {
                ForEach(Array(interaction["answers"].arrayValue.enumerated()), id: \.offset) { _, answer in
                    LabeledContent(answer["question"].stringValue, value: answer["answer"].stringValue).font(MichiFont.row)
                }
            } label: { Text("Your answers").font(MichiFont.section).tracking(0.88).textCase(.uppercase).foregroundStyle(tokens.muted) }
        case "image": NativeConversationImage(api: api, workspaceID: block["workspaceId"].optionalString ?? workspaceID, item: block)
        default: Text("Unsupported content block: \(block["kind"].stringValue)").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
        }
    }

    private func answerDocument(fragment: Int?, blockID: String?) -> NativeMarkdownTableDocument? {
        guard let nodeID, !nodeID.isEmpty else { return nil }
        return .message(nodeID: nodeID, messageID: message.id, fragment: fragment, blockID: blockID)
    }

    private struct Segment: Identifiable {
        enum Content { case block(JSONValue), tools([String]) }
        let id: Int
        let content: Content
    }

    /// Adjacent tool blocks share one bordered tool group, as on the web.
    private var segments: [Segment] {
        var result: [Segment] = []
        var pending: [String] = []
        var pendingStart = 0
        for (offset, block) in message.blocks.enumerated() {
            if block["kind"].stringValue == "tool" {
                if pending.isEmpty { pendingStart = offset }
                pending.append(block["toolCallId"].stringValue)
            } else {
                if !pending.isEmpty { result.append(Segment(id: pendingStart, content: .tools(pending))); pending = [] }
                result.append(Segment(id: offset, content: .block(block)))
            }
        }
        if !pending.isEmpty { result.append(Segment(id: pendingStart, content: .tools(pending))) }
        return result
    }

    @ViewBuilder private var quoted: some View {
        if !message.metadata["quotedText"].stringValue.isEmpty {
            DisclosureGroup {
                Text(message.metadata["quotedText"].stringValue).font(MichiFont.rowSecondary).foregroundStyle(tokens.mid).textSelection(.enabled)
            } label: {
                Label(message.metadata["quoteSource"]["type"] == "artifact" ? "Quoted artifact" : "Quoted context", systemImage: "text.quote")
                    .font(MichiFont.mono(size: 11.5, relativeTo: .caption2, weight: .medium)).foregroundStyle(tokens.accentText)
            }
        }
    }

    @ViewBuilder private var attachments: some View {
        ForEach(Array(message.metadata["attachments"].arrayValue.enumerated()), id: \.offset) { _, attachment in
            Label(attachment["name"].stringValue, systemImage: "paperclip").font(MichiFont.mono(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
        }
    }
}

/// One tool call, kept for existing callers; groups render the same rows.
struct NativeToolView: View {
    let tool: JSONValue
    var body: some View { ChatToolGroup(tools: [tool], waitingForPermission: false, collapsible: false) }
}

/// Bordered tool rows (mono summary, mauve glyph, trailing status). Saved
/// replies start collapsed to a one-line summary; each row expands in place.
struct ChatToolGroup: View {
    let tools: [JSONValue]
    let waitingForPermission: Bool
    let collapsible: Bool
    @State private var collapsed = true
    @State private var expanded: Set<String> = []
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        if !tools.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                if collapsible && collapsed && tools.count > 1 {
                    Button { collapsed = false } label: {
                        row(symbol: "terminal", title: "Used \(tools.count) tools", trailing: AnyView(Image(systemName: "chevron.right").font(.system(size: 11, weight: .medium)).foregroundStyle(tokens.faint)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows each tool call")
                } else {
                    ForEach(Array(tools.enumerated()), id: \.offset) { index, tool in
                        let key = tool.id.isEmpty ? String(index) : tool.id
                        VStack(alignment: .leading, spacing: 0) {
                            Button { if expanded.contains(key) { expanded.remove(key) } else { expanded.insert(key) } } label: {
                                row(symbol: symbol(tool), title: tool["title"].stringValue.isEmpty ? "Tool" : tool["title"].stringValue, trailing: AnyView(status(tool, isLastOpen: index == lastOpenIndex)))
                            }
                            .buttonStyle(.plain)
                            .accessibilityValue(expanded.contains(key) ? "Expanded" : "Collapsed")
                            if expanded.contains(key) { details(tool) }
                        }
                        .overlay(alignment: .top) { if index > 0 { Rectangle().fill(tokens.sep).frame(height: 1) } }
                    }
                }
            }
            .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1) }
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }

    private var lastOpenIndex: Int? { tools.lastIndex { !["completed", "failed", "error"].contains($0["status"].stringValue) } }

    private func row(symbol: String, title: String, trailing: AnyView) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 13, weight: .medium)).foregroundStyle(tokens.mauve).frame(width: 18)
            Text(title).font(MichiFont.mono(size: 12.5, relativeTo: .caption)).foregroundStyle(tokens.mid).lineLimit(1)
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func status(_ tool: JSONValue, isLastOpen: Bool) -> some View {
        switch tool["status"].stringValue {
        case "completed": Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(tokens.digest).accessibilityLabel("Completed")
        case "failed", "error": Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(tokens.dangerText).accessibilityLabel("Failed")
        default:
            if waitingForPermission && isLastOpen {
                Text("Waiting for you").font(MichiFont.mono(size: 12.5, relativeTo: .caption)).foregroundStyle(tokens.accentText)
            } else { MichiThreadStateDot(state: .streaming) }
        }
    }

    @ViewBuilder private func details(_ tool: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !tool["detail"].stringValue.isEmpty { Text(tool["detail"].stringValue).font(MichiFont.rowSecondary).foregroundStyle(tokens.mid).textSelection(.enabled) }
            if !tool["inputJson"].stringValue.isEmpty { Text(tool["inputJson"].stringValue).font(MichiFont.mono(size: 12, relativeTo: .caption)).foregroundStyle(tokens.fg).textSelection(.enabled) }
            if !tool["output"].stringValue.isEmpty { Text(tool["output"].stringValue).font(MichiFont.mono(size: 12, relativeTo: .caption)).foregroundStyle(tokens.fg).textSelection(.enabled) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(tokens.usesDarkCanvas ? tokens.bgDeep : tokens.alt)
    }

    private func symbol(_ tool: JSONValue) -> String {
        let title = tool["title"].stringValue.lowercased()
        if title.hasPrefix("read") || title.hasPrefix("view") || title.hasPrefix("open") { return "doc.text" }
        if title.hasPrefix("search") || title.hasPrefix("grep") || title.hasPrefix("find") || title.hasPrefix("glob") { return "magnifyingglass" }
        if title.hasPrefix("edit") || title.hasPrefix("write") || title.hasPrefix("patch") { return "pencil" }
        if title.hasPrefix("fetch") || title.hasPrefix("web") { return "globe" }
        return "terminal"
    }
}

/// Inline permission card (accent, same color as Home's “Needs you”).
struct PermissionCard: View {
    let request: JSONValue
    var modeLabel: String? = nil
    let respond: (String?) -> Void
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "hand.raised").font(.system(size: 15, weight: .medium)).foregroundStyle(tokens.accent)
                Text(request["title"].stringValue.isEmpty ? "Permission requested" : request["title"].stringValue)
                    .font(MichiFont.sans(size: 15, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Permission requested: " + request["title"].stringValue)
            if !request["detail"].stringValue.isEmpty {
                Text(request["detail"].stringValue)
                    .font(MichiFont.code).foregroundStyle(tokens.fg).textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(tokens.usesDarkCanvas ? tokens.bgDeep : tokens.surface, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(tokens.line, lineWidth: 1) }
                    .padding(.top, 10)
            }
            if let modeLabel {
                Text(modeLabel).font(MichiFont.mono(size: 11.5, relativeTo: .caption2)).foregroundStyle(tokens.mid).padding(.top, 8)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { optionButtons }
                VStack(spacing: 8) { optionButtons }
            }
            .padding(.top, 12)
            Button("Cancel request", role: .cancel) { respond(nil) }
                .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .medium))
                .foregroundStyle(tokens.muted)
                .frame(minHeight: 44)
        }
        .padding(12)
        .background(tokens.accentF, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.accent.opacity(0.35), lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("permission-card")
    }

    private var options: [JSONValue] { request["options"].arrayValue }
    private var primaryIndex: Int? {
        options.firstIndex { option in
            let key = (option["optionId"].stringValue + " " + option["name"].stringValue).lowercased()
            return key.contains("allow") && !key.contains("always") && !option["disabled"].boolValue
        }
    }

    @ViewBuilder private var optionButtons: some View {
        ForEach(Array(options.enumerated()), id: \.offset) { index, option in
            let primary = index == primaryIndex
            Button { respond(option["optionId"].stringValue) } label: {
                Text(option["name"].stringValue)
                    .font(MichiFont.sans(size: 13, relativeTo: .subheadline, weight: .semibold))
                    .foregroundStyle(primary ? tokens.accentInk : tokens.fg)
                    .lineLimit(2).multilineTextAlignment(.center)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, minHeight: 34)
                    .background(primary ? tokens.accent : tokens.fg.opacity(0.07), in: Capsule())
                    .overlay { if !primary { Capsule().stroke(tokens.line, lineWidth: 1) } }
                    .padding(.vertical, 5)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(option["disabled"].boolValue)
            .opacity(option["disabled"].boolValue ? 0.45 : 1)
        }
    }
}

/// Inline ask-user card: 44 pt option rows, typed answers, Skip / Submit.
struct QuestionCard: View {
    let request: JSONValue
    let respond: ([JSONValue], Bool) -> Void
    @State private var answers: [Int: String] = [:]
    @State private var selections: [Int: Set<String>] = [:]
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(request["questions"].arrayValue.enumerated()), id: \.offset) { index, question in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "text.bubble").font(.system(size: 15, weight: .medium)).foregroundStyle(tokens.accent).padding(.top, 2)
                    Text(question["question"].stringValue).font(MichiFont.sans(size: 16, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg)
                }
                .padding(.horizontal, 4).padding(.top, index == 0 ? 4 : 10)
                .accessibilityAddTraits(.isHeader)
                ForEach(Array(question["options"].arrayValue.enumerated()), id: \.offset) { _, option in
                    let label = option["label"].stringValue
                    let selected = selections[index, default: []].contains(label)
                    Button {
                        if question["multiSelect"].boolValue {
                            var current = selections[index, default: []]; if current.contains(label) { current.remove(label) } else { current.insert(label) }; selections[index] = current
                        } else { selections[index] = [label] }
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label).font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.fg)
                                if !option["description"].stringValue.isEmpty {
                                    Text(option["description"].stringValue).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                                }
                            }
                            Spacer(minLength: 8)
                            if selected { Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(tokens.accent) }
                            else if option["recommended"].boolValue {
                                Text("Recommended").font(MichiFont.tag).tracking(0.66).textCase(.uppercase).foregroundStyle(tokens.accentText)
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .background(tokens.usesDarkCanvas ? tokens.bgDeep : tokens.surface, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        .overlay { RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(selected ? tokens.accent : tokens.line, lineWidth: 1) }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
                TextField("Type an answer", text: Binding(get: { answers[index, default: ""] }, set: { answers[index] = $0 }), axis: .vertical)
                    .font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.fg)
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .frame(minHeight: 44)
                    .background(tokens.usesDarkCanvas ? tokens.bgDeep : tokens.surface, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(tokens.line, lineWidth: 1) }
            }
            HStack {
                Button("Skip") { respond([], true) }
                    .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .medium)).foregroundStyle(tokens.mid)
                    .frame(minWidth: 44, minHeight: 44)
                Spacer()
                Button("Submit answers") {
                    let result: [JSONValue] = request["questions"].arrayValue.enumerated().map { index, question in
                        let values = Array(selections[index, default: []]).sorted() + [answers[index, default: ""]].filter { !$0.isEmpty }
                        var row: JSONValue = ["question": question["question"], "answer": .string(values.joined(separator: ", "))]
                        if !question["id"].isNull { row["id"] = question["id"] }; return row
                    }; respond(result, false)
                }
                .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .semibold))
                .michiGlassButton(prominent: true)
                .tint(tokens.accent)
            }
            .padding(.top, 4)
        }
        .padding(10)
        .background(tokens.accentF, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.accent.opacity(0.4), lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("question-card")
    }
}

// MARK: - iPad inspector

private enum ChatInspectorLayout {
    static let columnWidth: CGFloat = 310
    static let minimumTranscriptWidth: CGFloat = 360
    static var dockThreshold: CGFloat { columnWidth + minimumTranscriptWidth }
}

/// Web desktop's second pane on iPad: this thread's branches, its files and
/// context usage. Every value comes from the saved graph or live usage.
struct ChatInspector: View {
    @ObservedObject var chat: ChatController
    @ObservedObject var store: MichiStore
    let onOpenFiles: () -> Void
    @State private var tab = Tab.branches
    @Environment(\.michiTokens) private var tokens
    private enum Tab: String, CaseIterable { case branches = "Branches", files = "Files", context = "Context" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Picker("Inspector", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16).padding(.bottom, 4)
                switch tab {
                case .branches: branches
                case .files: files
                case .context: context
                }
            }
            .padding(.top, 8)
        }
        .background(tokens.bar)
    }

    private var branches: some View {
        let graph = store.graph(for: chat.node.id) ?? chat.graph
        let rows = graph.branchRows(tree: chat.node["tree_id"].stringValue)
        return VStack(alignment: .leading, spacing: 0) {
            MichiSectionHeader(title: "This thread")
            hairline
            ForEach(rows, id: \.node.id) { row in
                let state = ChatThreadStatus.state(row.node, store: store)
                let current = row.node.id == chat.node.id
                Button { if !current { store.select(row.node, workspace: graph.id) } } label: {
                    HStack(spacing: 12) {
                        MichiThreadStateDot(state: state).frame(width: 12)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.depth == 0 ? "main" : graph.title(row.node)).font(MichiFont.sans(size: 16, relativeTo: .body)).foregroundStyle(tokens.fg).lineLimit(2)
                            Text(ChatThreadStatus.label(state, chat: store.existingChat(for: row.node.id)) ?? (current ? "Open now" : graph.title(row.node)))
                                .font(MichiFont.sans(size: 13, relativeTo: .footnote)).foregroundStyle(tokens.muted).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        if !current { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                    }
                    .padding(.leading, 20 + CGFloat(min(row.depth, 4)) * 12).padding(.trailing, 16)
                    .frame(minHeight: 56)
                    .background(current ? tokens.alt : .clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(current ? .isSelected : [])
                hairline
            }
        }
    }

    private var files: some View {
        let contexts = (store.graph(for: chat.node.id) ?? chat.graph).contexts
        return VStack(alignment: .leading, spacing: 0) {
            MichiSectionHeader(title: "Files", count: "\(contexts.count)")
            hairline
            ForEach(contexts, id: \.id) { artifact in
                Button(action: onOpenFiles) {
                    HStack(spacing: 12) {
                        Image(systemName: artifact["type"].stringValue == "image" ? "photo" : artifact["type"].stringValue == "link" ? "link" : "doc.text")
                            .font(.system(size: 14)).foregroundStyle(tokens.muted).frame(width: 24)
                        Text(artifact["name"].stringValue).font(MichiFont.mono(size: 14, relativeTo: .body)).foregroundStyle(tokens.fg).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 20).frame(minHeight: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                hairline
            }
            Button("Open files", systemImage: "paperclip", action: onOpenFiles)
                .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .semibold))
                .michiGlassButton()
                .padding(16)
        }
    }

    private var context: some View {
        let percent = chat.usage["contextUsagePercentage"]
        return VStack(alignment: .leading, spacing: 0) {
            MichiSectionHeader(title: "Context")
            hairline
            VStack(alignment: .leading, spacing: 10) {
                if percent.isNull {
                    Text("Context usage appears after the next response.").font(MichiFont.row).foregroundStyle(tokens.muted)
                } else {
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(percent.intValue)% used").font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.fg)
                        Spacer()
                        if !chat.usage["totalTokens"].isNull {
                            Text("\(chat.usage["totalTokens"].intValue.formatted()) tokens").font(MichiFont.mono(size: 13, relativeTo: .footnote)).foregroundStyle(tokens.muted)
                        }
                    }
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(tokens.alt2)
                            Capsule().fill(tokens.accent).frame(width: proxy.size.width * CGFloat(min(100, max(0, percent.intValue))) / 100)
                        }
                    }
                    .frame(height: 4)
                    .accessibilityHidden(true)
                }
                Button("Compact") { Task { await chat.compact() } }
                    .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .semibold))
                    .michiGlassButton()
                    .disabled(chat.busy || chat.commandRunning || chat.isReadOnly || chat.pendingSubmission != nil || chat.submissionRecoveryError != nil)
            }
            .padding(16)
            hairline
        }
    }

    private var hairline: some View { Rectangle().fill(tokens.sep).frame(height: 1) }
}
