import SwiftUI
import MichiCore

/// ThreadStateDot semantics for a saved node plus its live controller, if any.
enum ChatThreadStatus {
    @MainActor static func state(_ node: JSONValue, store: MichiStore) -> MichiThreadState {
        let state = MichiThreadState.of(node: node, chat: store.existingChat(for: node.id))
        guard state == .idle else { return state }
        switch node["status"].stringValue {
        case "waiting", "needs_input", "permission": return .waiting
        case "done", "complete": return .done
        default: return .idle
        }
    }

    @MainActor static func label(_ state: MichiThreadState, chat: ChatController?) -> String? {
        switch state {
        case .waiting: return chat?.pendingPermission != nil ? "Needs approval" : "Needs you"
        case .streaming: return "Responding…"
        case .running: return "In progress"
        case .stalled: return "Stalled"
        case .failed: return "Failed"
        default: return nil
        }
    }
}

struct ChatThreadStateLabel: View {
    let state: MichiThreadState
    let text: String
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        Text(text)
            .font(MichiFont.meta)
            .foregroundStyle(color)
            .lineLimit(1)
    }
    private var color: Color {
        switch state {
        case .streaming: return tokens.selectInk
        case .waiting: return tokens.accentText
        case .stalled: return tokens.mauve
        case .failed: return tokens.dangerText
        default: return tokens.muted
        }
    }
}

struct BranchPicker: View {
    @ObservedObject var store: MichiStore
    let graphID: String
    let treeID: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        NavigationStack {
            List {
                if let graph = store.graphs.first(where: { $0.id == graphID }) {
                    Section {
                        ForEach(graph.branchRows(tree: treeID), id: \.node.id) { row in
                            let state = ChatThreadStatus.state(row.node, store: store)
                            let current = store.selectedNodeID == row.node.id
                            Button {
                                store.select(row.node, workspace: graphID); dismiss()
                            } label: {
                                HStack(spacing: 12) {
                                    MichiThreadStateDot(state: state)
                                        .frame(width: 12)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.depth == 0 ? "main · " + graph.title(row.node) : graph.title(row.node))
                                            .font(MichiFont.sans(size: row.depth == 0 ? 16 : 15, relativeTo: .body))
                                            .foregroundStyle(tokens.fg).lineLimit(2)
                                        if let label = ChatThreadStatus.label(state, chat: store.existingChat(for: row.node.id)) {
                                            ChatThreadStateLabel(state: state, text: label)
                                        } else if current {
                                            Text("Open now").font(MichiFont.meta).foregroundStyle(tokens.muted)
                                        }
                                    }
                                    Spacer(minLength: 8)
                                    if current { Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(tokens.accent) }
                                    else { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                                }
                                .padding(.leading, CGFloat(min(row.depth, 6)) * 16)
                                .frame(minHeight: 48)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(current ? tokens.alt : tokens.bg)
                            .accessibilityAddTraits(current ? .isSelected : [])
                            .accessibilityIdentifier("branch-\(row.node.id)")
                        }
                    } header: {
                        let count = graph.branchRows(tree: treeID).count
                        MichiSectionHeader(title: "This thread", count: "\(count) conversation\(count == 1 ? "" : "s")").listRowInsets(EdgeInsets())
                    }
                }
            }
            .michiPlainList()
            .navigationTitle("Branches").navigationBarTitleDisplayMode(.inline)
            .michiToolbarBackground()
            .toolbar { Button("Done") { dismiss() } }
        }.presentationDetents([.medium, .large])
    }
}

/// Medium sheet: the selected quote, then the branch's first question, then
/// Context and Agent rows (10-chats 07). The branch is created from the
/// chosen durable anchor; sending pushes it, and Back returns to the parent.
struct NewBranchSheet: View {
    @ObservedObject var store: MichiStore
    @ObservedObject var parent: ChatController
    let anchor: String?
    var quote: String? = nil
    var initialQuestion = ""
    @State private var question = ""
    @State private var creating = false
    @State private var error: String?
    @State private var context: DesignChatBranchContext
    @State private var agent = DesignChatBranchAgent.sameAsParent
    @StateObject private var catalog: ChatRuntimeCatalog
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens

    init(store: MichiStore, parent: ChatController, anchor: String?, quote: String? = nil, initialQuestion: String = "") {
        _store = ObservedObject(wrappedValue: store)
        _parent = ObservedObject(wrappedValue: parent)
        self.anchor = anchor; self.quote = quote; self.initialQuestion = initialQuestion
        _context = State(initialValue: DesignChatBranchPlan(requestedAnchor: anchor, durableIDs: parent.durableMessageIDs).defaultContext)
        _catalog = StateObject(wrappedValue: ChatRuntimeCatalog(api: parent.api))
    }

    private var plan: DesignChatBranchPlan { DesignChatBranchPlan(requestedAnchor: anchor, durableIDs: parent.durableMessageIDs) }
    /// Before the parent's history has been read there are no durable ids to
    /// choose from; the requested anchor is passed through and the backend
    /// rejects one it does not hold. After load, a missing requested reply
    /// stays missing — it never becomes the latest tail.
    private var canConfirm: Bool {
        !creating && !parent.isReadOnly && (!parent.loaded || plan.allowsCreation(for: context))
    }
    private var trimmedQuestion: String { question.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var contextDetail: String {
        let history = parent.loaded ? plan.detail(for: context) : "The branch keeps this thread’s history up to the reply it starts from."
        return history + " Nothing is sent until you tap Send."
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let quote, !quote.isEmpty {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "text.quote").font(.system(size: 15, weight: .medium)).foregroundStyle(tokens.accent).padding(.top, 4)
                            Text("“\(quote)”").font(MichiFont.sans(size: 17, relativeTo: .body)).foregroundStyle(tokens.mid).lineSpacing(5).lineLimit(8)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Quoted: \(quote)")
                    }
                    TextField("What should this branch explore?", text: $question, axis: .vertical)
                        .font(MichiFont.sans(size: 17, relativeTo: .body))
                        .foregroundStyle(tokens.fg)
                        .lineSpacing(5)
                        .lineLimit(2...10)
                        .focused($focused)
                        .accessibilityIdentifier("branch-question")
                    branchOptions
                    VStack(alignment: .leading, spacing: 6) {
                        Text(contextDetail)
                        Text(DesignChatBranchPersistence.note(agent: agent, hasQuestion: !trimmedQuestion.isEmpty))
                    }
                    .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                    if let error { Text(error).font(MichiFont.rowSecondary).foregroundStyle(tokens.dangerText) }
                }
                .padding(.horizontal, 24).padding(.top, 6)
            }
            .task {
                await catalog.loadStatus()
                await catalog.loadModels(runtime: parent.effectiveRuntime(catalog), provider: parent.providerID)
            }
            .background(tokens.bg.opacity(MichiGlass.isLiquidGlassOS ? 0 : 1))
            .navigationBarTitleDisplayMode(.inline)
            .michiToolbarBackground()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Cancel")
                }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("New branch").font(MichiFont.sans(size: 15, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg)
                        Text("from " + parent.title).font(MichiFont.mono(size: 11, relativeTo: .caption2)).foregroundStyle(tokens.muted).lineLimit(1)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await create() } } label: {
                        if creating { ProgressView() } else { Image(systemName: "arrow.up") }
                    }
                    .michiGlassButton(prominent: true)
                    .tint(tokens.accent)
                    .disabled(!canConfirm)
                    .accessibilityLabel(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Create branch" : "Send to new branch")
                    .accessibilityIdentifier("create-branch")
                }
            }
            .onAppear { if question.isEmpty { question = initialQuestion }; focused = true }
            .onChange(of: parent.loaded) { _, loaded in
                if loaded, !plan.missingRequestedAnchor, !plan.offersChoice { context = .fullThread }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: Context and agent

    private var branchOptions: some View {
        VStack(spacing: 0) {
            optionRow(symbol: "text.bubble", title: "Context") {
                if parent.loaded && plan.showsContextPicker {
                    Menu {
                        Picker("Context", selection: $context) {
                            ForEach(DesignChatBranchContext.allCases) { Text($0.title).tag($0) }
                        }
                    } label: { optionValue(context.title, menu: true) }
                    .accessibilityLabel("Context")
                    .accessibilityValue(context.title)
                } else {
                    optionValue(DesignChatBranchContext.fullThread.title, menu: false)
                }
            }
            Rectangle().fill(tokens.sep).frame(height: 1).padding(.leading, 52)
            optionRow(symbol: "cpu", title: "Agent") {
                Menu {
                    Picker("Agent", selection: $agent) {
                        ForEach(DesignChatBranchAgent.allCases) { Text($0.title).tag($0) }
                    }
                } label: { optionValue(agent.title, menu: true) }
                .accessibilityLabel("Agent")
                .accessibilityValue(agent.title + ", " + agentSummary)
            }
            Text(agentSummary)
                .font(MichiFont.mono(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 52).padding(.trailing, 14).padding(.bottom, 10)
                .accessibilityHidden(true)
        }
        .background(tokens.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .disabled(creating)
    }

    private func optionRow<Trailing: View>(symbol: String, title: String, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 15)).foregroundStyle(tokens.muted).frame(width: 26)
            Text(title).font(MichiFont.sans(size: 16, relativeTo: .body)).foregroundStyle(tokens.fg)
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.leading, 14).padding(.trailing, 14)
        .frame(minHeight: 48)
    }

    private func optionValue(_ value: String, menu: Bool) -> some View {
        HStack(spacing: 4) {
            Text(value).lineLimit(1)
            if menu { Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .medium)) }
        }
        .font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.mid)
        .frame(minHeight: 44).contentShape(Rectangle())
    }

    private var agentSummary: String {
        switch agent {
        case .defaultAgent: return "Michi’s default runtime, model and permissions"
        case .sameAsParent:
            let settings = parent.agentSettings
            var parts = [catalog.runtimeLabel(settings.runtimeID), catalog.modelLabel(settings.modelID)]
            if !settings.reasoning.isEmpty { parts.append(settings.reasoning.capitalized + " effort") }
            parts.append(ChatPermissionCopy.title(settings.permissionMode) + (settings.approveForMe ? " + approve for me" : ""))
            return parts.joined(separator: " · ")
        }
    }

    private func create() async {
        guard !creating, let graph = store.graph(for: parent.node.id), let current = graph.node(parent.node.id) else { return }
        creating = true; defer { creating = false }
        // Snapshot the choices at tap time; the parent may keep changing.
        let inherited = agent == .sameAsParent ? parent.agentSettings : nil
        let latest = DesignChatBranchPlan(requestedAnchor: anchor, durableIDs: parent.durableMessageIDs)
        let branchAnchor: String?
        if parent.loaded {
            switch latest.createAnchor(for: context) {
            case .failure(let message):
                error = message.localizedDescription
                return
            case .success(let value):
                branchAnchor = value
            }
        } else {
            branchAnchor = anchor
        }
        do {
            let id = try await store.createThread(in: graph, parent: current, anchor: branchAnchor)
            let text = trimmedQuestion
            // Apply inherited fields before anything else can open this
            // branch and start its first session with the defaults.
            let chat = store.chat(for: id)
            var agentReady = true
            if let inherited, let chat { agentReady = chat.adoptBranchAgentSettings(inherited, parentNodeID: current.id, workspaceID: graph.id) }
            dismiss()
            guard let chat else { return }
            // Selecting the branch opens it, and its view may already be
            // loading; wait for that read instead of dropping the question.
            if !chat.loaded, !(await chat.load()) {
                var waited = 0
                while chat.loading && waited < 100 { try? await Task.sleep(for: .milliseconds(100)); waited += 1 }
            }
            guard !chat.isReadOnly else { return }
            if let quote, !quote.isEmpty { chat.quotedText = quote; chat.quoteSource = .null }
            guard !text.isEmpty else { return }
            chat.draft = text
            guard agentReady else {
                chat.error = "The parent’s agent settings could not be applied. Your question is in the composer; check the agent before sending."
                return
            }
            if chat.loaded { chat.send() }
        } catch { self.error = error.localizedDescription }
    }
}

struct ChatOptionsScreen: View {
    @ObservedObject var chat: ChatController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens
    @State private var catalog: JSONValue = .null
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Agent for this conversation") {
                    Picker("Runtime", selection: $chat.runtimeID) {
                        Text("Workspace default").tag("")
                        ForEach(catalog["availableRuntimes"].arrayValue, id: \.id) { runtime in Text(runtime["label"].optionalString ?? runtime.id).tag(runtime.id) }
                        if !chat.runtimeID.isEmpty && !catalog["availableRuntimes"].arrayValue.contains(where: { $0.id == chat.runtimeID }) { Text(chat.runtimeID).tag(chat.runtimeID) }
                    }
                    TextField("Provider (workspace default if blank)", text: $chat.providerID).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Model (workspace default if blank)", text: $chat.modelID).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Reasoning", selection: Binding(get: { chat.reasoning }, set: { chat.selectReasoning($0) })) { ForEach(["", "minimal", "low", "medium", "high", "xhigh", "max"], id: \.self) { Text($0.isEmpty ? "Default" : $0.capitalized).tag($0) } }
                    if !chat.modes.isEmpty {
                        Picker("Mode", selection: $chat.modeID) { Text("Default").tag(""); ForEach(chat.modes, id: \.id) { mode in Text(mode["name"].optionalString ?? mode.id).tag(mode.id) } }
                    }
                }.disabled(chat.busy || chat.commandRunning || chat.isReadOnly)
                Section { Text("These selections apply when the next message starts. Existing server permission settings are preserved.").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted) }
                if !chat.usage.isNull {
                    Section("Usage") {
                        if !chat.usage["contextUsagePercentage"].isNull { LabeledContent("Context", value: "\(chat.usage["contextUsagePercentage"].intValue)%") }
                        if !chat.usage["totalTokens"].isNull { LabeledContent("Tokens", value: "\(chat.usage["totalTokens"].intValue)") }
                    }
                }
                if let error { Text(error).foregroundStyle(tokens.dangerText) }
            }
            .font(MichiFont.row)
            .scrollContentBackground(.hidden).background(tokens.bg)
            .navigationTitle("Conversation settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .task {
                loading = true; defer { loading = false }
                do { catalog = try await chat.api.request("/agent/status"); await chat.loadModes() }
                catch { self.error = error.localizedDescription }
            }
        }
    }
}
