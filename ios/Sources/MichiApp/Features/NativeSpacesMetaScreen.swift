import SwiftUI
import MichiCore

/// Page-specific preferences, deterministic Home rules and progress. No run
/// starts simply because this screen appears; Start is an explicit action.
struct NativeSpacesMetaScreen: View {
    @StateObject private var model: NativeSpacesPageModel
    @StateObject private var conversationStore: MichiStore
    @State private var openedConversation: NativeSpacesOpenedConversation?
    @State private var openingConversation = false
    let onOpenConversation: ((String, String) -> Void)?
    @State private var section = ""
    @State private var limitAge = false
    @State private var maxAge = 7
    @State private var limitItems = false
    @State private var maxItems = 5
    @State private var confirmStart = false
    @State private var confirmForgetRule = false
    @State private var retryWorkspace: String?
    @State private var deletingRule: JSONValue?
    @Environment(\.scenePhase) private var scenePhase
    init(api: MichiAPI, pageID: String, workspaceID: String, onOpenConversation: ((String, String) -> Void)? = nil) {
        _model = StateObject(wrappedValue: NativeSpacesPageModel(api: api, pageID: pageID, workspaceID: workspaceID))
        _conversationStore = StateObject(wrappedValue: MichiStore(api: api))
        self.onOpenConversation = onOpenConversation
    }
    var body: some View {
        Form {
            if let error = model.error { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
            Section {
                NavigationLink {
                    NativeSpacesAssistantScreen(api: model.api, pageID: model.pageID, workspaceID: model.workspaceID)
                } label: { Label("Ask Michi about this page", systemImage: "sparkles") }
                if !model.page["blocks"].arrayValue.isEmpty {
                    NavigationLink("Ask about a block") {
                        List(model.page["blocks"].arrayValue, id: \.id) { block in
                            NavigationLink {
                                NativeSpacesAssistantScreen(api: model.api, pageID: model.pageID, workspaceID: model.workspaceID, blockID: block.id)
                            } label: { Text(block["text"].stringValue.isEmpty ? block["type"].stringValue.capitalized : block["text"].stringValue).lineLimit(3) }
                        }.navigationTitle("Choose a block")
                    }
                }
            }
            Section("Layout preferences") {
                Text("Tell Michi how to organize this page. These preferences stay with this page.").font(.footnote).foregroundStyle(.secondary)
                TextEditor(text: $model.preferenceDraft).frame(minHeight: 120).accessibilityLabel("Page layout preferences")
                if model.preferenceDirty {
                    Text("Based on layout revision \(model.expectedRevision)").font(.caption).foregroundStyle(.secondary)
                    Button("Save preferences") { Task { await model.savePreferences() } }.disabled(model.loading)
                    Button("Discard draft", role: .destructive) { model.discardPreferenceDraft() }.disabled(model.loading)
                }
            }.disabled(!model.hasLoaded || model.saving)
            Section("Saved layout rules") {
                if model.rules.isEmpty { Text("No saved rules.").foregroundStyle(.secondary) }
                ForEach(model.rules, id: \.id) { rule in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(rule["text"].stringValue)
                        if !rule["sectionLimit"].isNull {
                            Text(rule["sectionLimit"]["section"].stringValue.capitalized + " · " + ruleLimitLabel(rule["sectionLimit"]))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Button("Delete rule", role: .destructive) { deletingRule = rule }.font(.caption)
                    }
                }
            }.disabled(model.saving || model.loading)
            Section("Add a rule") {
                TextField("How should this page be organized?", text: $model.ruleText, axis: .vertical).lineLimit(2...5).disabled(model.ruleOutcomeUnknown)
                if model.isHome {
                    Picker("Counted section", selection: $section) {
                        Text("Text rule only").tag("")
                        Text("Waiting on you").tag("waiting")
                        Text("Stalled").tag("stalled")
                        Text("Done").tag("done")
                    }.disabled(model.ruleOutcomeUnknown)
                    if !section.isEmpty {
                        Toggle("Limit age", isOn: $limitAge).disabled(model.ruleOutcomeUnknown)
                        if limitAge { Stepper("Last \(maxAge) days", value: $maxAge, in: 1...365).disabled(model.ruleOutcomeUnknown) }
                        Toggle("Limit items", isOn: $limitItems).disabled(model.ruleOutcomeUnknown)
                        if limitItems { Stepper("Up to \(maxItems) items", value: $maxItems, in: 1...8).disabled(model.ruleOutcomeUnknown) }
                    }
                }
                if model.ruleOutcomeUnknown {
                    Text("The last rule may already be saved or still be arriving. Refresh can confirm a matching saved rule; an empty result does not prove the write failed.").font(.footnote).foregroundStyle(.secondary)
                    if let body = model.pendingRuleBody, !body["sectionLimit"].isNull {
                        Text("Pending limit: " + body["sectionLimit"]["section"].stringValue.capitalized + " · " + ruleLimitLabel(body["sectionLimit"]))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button("Refresh saved rules") { Task { await model.refresh() } }
                    Button("Forget pending rule…", role: .destructive) { confirmForgetRule = true }
                }
                Button("Add rule") { Task { await model.addRule(section: section.isEmpty ? nil : section, maxAge: limitAge ? maxAge : nil, maxItems: limitItems ? maxItems : nil) } }
                    .disabled(NativeSpacesContract.trimmed(model.ruleText).isEmpty || model.ruleOutcomeUnknown)
            }.disabled(!model.hasLoaded || model.saving || model.loading)
            if !model.cards.isEmpty {
                Section("Conversations started here") {
                    ForEach(model.cards, id: \.spacesThreadID) { card in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(card["title"].stringValue).font(.headline)
                            Text(card["awaitingDetail"].optionalString ?? card["statusLine"].optionalString ?? card["status"].stringValue).font(.caption).foregroundStyle(.secondary)
                            if !card["summary"].stringValue.isEmpty { Text(card["summary"].stringValue).font(.footnote) }
                            Button(openingConversation ? "Opening…" : "Open conversation") { openCard(card) }.disabled(openingConversation)
                            Button("Dismiss card", role: .destructive) { Task { await model.dismissCard(card) } }.font(.caption)
                        }
                    }
                }.disabled(model.saving || model.loading)
            }
            Section("First read") {
                if let error = model.progressError { Text(error).font(.footnote).foregroundStyle(.secondary) }
                if !model.firstRun.isNull {
                    LabeledContent("Home summary", value: model.firstRun["summary"]["state"].stringValue.capitalized)
                    if let reason = model.firstRun["haltedReason"].optionalString { Text(reason).foregroundStyle(.red) }
                    ForEach(model.firstRun["workspaces"].arrayValue, id: \.spacesWorkspaceID) { workspace in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(workspace["workspaceName"].stringValue).font(.headline)
                            let progress = workspace["firstRun"]
                            if progress.isNull { Text("Not started").foregroundStyle(.secondary) }
                            else {
                                Text(progress["state"].stringValue.capitalized + " · \(progress["readCount"].intValue) of \(progress["total"].intValue) conversations").font(.caption)
                                if !progress["error"].stringValue.isEmpty { Text(progress["error"].stringValue).font(.footnote).foregroundStyle(.red) }
                                if progress["state"] == "failed" { Button("Retry this workspace") { retryWorkspace = workspace["workspaceId"].stringValue }.disabled(model.firstRunUnknown) }
                            }
                        }
                    }
                    if model.firstRun["requestedAt"].isNull { Button("Start first read") { confirmStart = true } }
                }
                Button("Refresh progress") { Task { await model.refreshFirstRun() } }
            }.disabled(model.saving || model.loading)
        }
        .navigationTitle("Page assistant & layout")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .overlay { if model.loading && !model.hasLoaded { ProgressView("Loading page settings…") } }
        .refreshable { await model.refresh() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await model.refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                await model.refresh()
            }
        }
        .onChange(of: scenePhase) { _, value in
            if value == .active { Task { await model.refreshFirstRun() }; if openedConversation != nil { conversationStore.resumeStreams() } }
            if value == .background { conversationStore.disconnectStreams() }
        }
        .sheet(item: $openedConversation, onDismiss: { conversationStore.disconnectStreams() }) { target in
            NavigationStack {
                Group {
                    if let chat = conversationStore.chat(for: target.id) { ConversationView(chat: chat, store: conversationStore) }
                    else { ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left") }
                }.navigationDestination(item: $conversationStore.selectedNodeID) { nodeID in
                    if let chat = conversationStore.chat(for: nodeID) { ConversationView(chat: chat, store: conversationStore) }
                }
            }
        }
        .confirmationDialog("Start reading workspace history?", isPresented: $confirmStart, titleVisibility: .visible) {
            Button("Start first read") { Task { await model.startFirstRun() } }
        } message: { Text("The Meta agent reads completed conversations and generates workspace homes using the connected computer's current settings.") }
        .confirmationDialog("Retry this workspace's first read?", isPresented: Binding(get: { retryWorkspace != nil }, set: { if !$0 { retryWorkspace = nil } }), titleVisibility: .visible) {
            Button("Retry") { if let workspace = retryWorkspace { Task { await model.startFirstRun(retryWorkspace: workspace, retry: true) } }; retryWorkspace = nil }
        }
        .confirmationDialog("Delete this layout rule?", isPresented: Binding(get: { deletingRule != nil }, set: { if !$0 { deletingRule = nil } }), titleVisibility: .visible) {
            Button("Delete rule", role: .destructive) { if let rule = deletingRule { Task { await model.deleteRule(rule) } }; deletingRule = nil }
        }
        .confirmationDialog("Forget the pending rule locally?", isPresented: $confirmForgetRule, titleVisibility: .visible) {
            Button("Forget pending rule", role: .destructive) {
                if let body = model.forgetPendingRule() {
                    let limit = body["sectionLimit"]
                    section = limit["section"].stringValue
                    limitAge = !limit["maxAgeDays"].isNull; if limitAge { maxAge = limit["maxAgeDays"].intValue }
                    limitItems = !limit["maxItems"].isNull; if limitItems { maxItems = limit["maxItems"].intValue }
                }
            }
        } message: { Text("The original request may still complete. This only removes the local pending record and keeps its text and limits as a draft. Adding it manually again may create a duplicate; no request will be retried or cancelled.") }
    }
    private func openCard(_ card: JSONValue) {
        guard !openingConversation else { return }
        openingConversation = true
        Task {
            defer { openingConversation = false }
            guard let target = await model.openCard(card) else { return }
            if let onOpenConversation { onOpenConversation(target.workspace, target.node); return }
            await conversationStore.reload()
            guard let graph = conversationStore.graph(for: target.node), graph.id == target.workspace,
                  !graph.isDeleted, !graph.isSystem, graph.node(target.node)?["deleted_at"].isNull == true else {
                model.error = "The conversation changed before it could be opened. Refresh the card and try again."; return
            }
            openedConversation = NativeSpacesOpenedConversation(id: target.node)
        }
    }
    private func ruleLimitLabel(_ value: JSONValue) -> String {
        var parts: [String] = []
        if !value["maxAgeDays"].isNull { parts.append("last \(value["maxAgeDays"].intValue) days") }
        if !value["maxItems"].isNull { parts.append("up to \(value["maxItems"].intValue) items") }
        return parts.joined(separator: ", ")
    }
}

/// The same durable chat implementation as Chats, scoped to the server's
/// dedicated assistant identity. Starting over has its expected-node guard.
struct NativeSpacesAssistantScreen: View {
    @StateObject private var model: NativeSpacesAssistantModel
    @State private var confirmReset = false
    @State private var settings = false
    @State private var history = false
    @State private var promptInserted = false
    @State private var showPageRequest = true
    private let initialPrompt: String?
    @Environment(\.scenePhase) private var scenePhase
    init(api: MichiAPI, pageID: String? = nil, workspaceID: String? = nil, blockID: String? = nil, purpose: String = "spaces", initialPrompt: String? = nil) {
        self.initialPrompt = initialPrompt
        _model = StateObject(wrappedValue: NativeSpacesAssistantModel(api: api, pageID: pageID, workspaceID: workspaceID, blockID: blockID, purpose: purpose))
    }
    var body: some View {
        Group {
            if let chat = model.chat {
                ConversationView(chat: chat, store: model.store, allowsBranching: false, showsConversationSettings: false)
                    .id(chat.node.id)
            } else if model.loading { ProgressView("Opening Michi assistant…") }
            else { ContentUnavailableView("Assistant unavailable", systemImage: "sparkles", description: Text(model.error ?? "Open the assistant to ask about your pages.")) }
        }
        .safeAreaInset(edge: .top) {
            VStack(alignment: .leading, spacing: 5) {
                if let initialPrompt, !initialPrompt.isEmpty, !promptInserted {
                    DisclosureGroup("Review page request", isExpanded: $showPageRequest) {
                        ScrollView { Text(initialPrompt).font(.subheadline).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 130)
                        Text("Add this to your draft, then review it before sending.").font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button(model.chat?.draft.isEmpty == true ? "Insert into draft" : "Append to draft") {
                                guard let chat = model.chat, chat.loaded, !chat.isReadOnly else { return }
                                chat.draft += (chat.draft.isEmpty ? "" : "\n\n") + initialPrompt
                                promptInserted = true
                            }.disabled(model.chat?.loaded != true || model.chat?.isReadOnly == true)
                            Button("Dismiss request") { promptInserted = true }
                        }.font(.caption)
                    }
                }
                if model.pageID != nil { Label(model.blockID == nil ? "About this page" : "About the selected page block", systemImage: "doc.text").font(.caption).foregroundStyle(.secondary) }
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.red) }
                if model.unknownChange { Text("The last conversation change is unconfirmed. Refresh to read the current conversation.").font(.caption).foregroundStyle(.secondary) }
                HStack {
                    Button("Refresh") { Task { await model.open() } }
                    if model.purpose == "spaces" { Button("History") { history = true } }
                    Button("Assistant settings") { settings = true }.disabled(model.info.isNull || model.unknownChange)
                    Spacer()
                    Button("Start over") { confirmReset = true }.disabled(model.info.isNull || model.chat?.busy == true || model.unknownChange)
                }.font(.caption).disabled(model.loading || model.changing)
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
            .background(.bar)
            .font(MichiFont.rowSecondary)
        }
        .navigationTitle(model.purpose == "schedule" ? "Create with Michi" : "Michi assistant")
        .navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .task { await model.open() }
        .onDisappear { model.detach() }
        .onChange(of: scenePhase) { _, value in if value == .background { model.detach() }; if value == .active { model.resume() } }
        .confirmationDialog("Start a new assistant conversation?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Start over") { Task { await model.reset() } }
        } message: { Text("The current conversation is kept in history. Unsent text remains with its conversation.") }
        .sheet(isPresented: $history) { NativeSpacesAssistantHistory(model: model) }
        .sheet(isPresented: $settings) { NativeSpacesAssistantSettings(model: model) }
    }
}

private struct NativeSpacesAssistantHistory: View {
    @ObservedObject var model: NativeSpacesAssistantModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                if let error = model.error { Text(error).foregroundStyle(.red) }
                ForEach(model.history, id: \.spacesNodeID) { item in
                    Button { Task { await model.activate(item); if model.info["nodeId"] == item["nodeId"] { dismiss() } } } label: {
                        VStack(alignment: .leading) { Text(item["title"].stringValue); Text(featureFormatDate(item["updatedAt"].featureOptionalNumber)).font(.caption).foregroundStyle(.secondary) }
                    }.disabled(model.changing || model.chat?.busy == true || model.unknownChange)
                }
                if model.nextCursor != nil { Button("Load more") { Task { await model.loadHistory(more: true) } } }
            }.navigationTitle("Assistant history").toolbar { Button("Done") { dismiss() } }
                .task { await model.loadHistory() }
        }
    }
}

private struct NativeSpacesAssistantSettings: View {
    @ObservedObject var model: NativeSpacesAssistantModel
    @State private var runtime = ""
    @State private var provider = ""
    @State private var modelID = ""
    @State private var reasoning = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Picker("Runtime", selection: $runtime) { ForEach(model.info["supportedRuntimes"].arrayValue.map(\.stringValue), id: \.self) { Text($0).tag($0) } }
                TextField("Provider (default if blank)", text: $provider).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Model (default if blank)", text: $modelID).textInputAutocapitalization(.never).autocorrectionDisabled()
                Picker("Reasoning", selection: $reasoning) { ForEach(["", "minimal", "low", "medium", "high", "xhigh", "max"], id: \.self) { Text($0.isEmpty ? "Default" : $0).tag($0) } }
                Text("Applies to this assistant conversation. A new conversation follows the connected computer's global settings.").font(.footnote).foregroundStyle(.secondary)
                if let error = model.error { Text(error).foregroundStyle(.red) }
            }.disabled(model.loading || model.changing || model.unknownChange || model.chat?.busy == true)
                .navigationTitle("Assistant settings")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { if await model.saveSettings(runtime: runtime, provider: provider, model: modelID, reasoning: reasoning) { dismiss() } } }.disabled(model.loading || model.changing || model.unknownChange || model.chat?.busy == true || runtime.isEmpty) }
                }
                .onAppear {
                    let settings = model.info["conversation"].isNull ? model.info["settings"] : model.info["conversation"]
                    runtime = settings["runtimeId"].stringValue; provider = settings["providerId"].stringValue; modelID = settings["modelId"].stringValue; reasoning = settings["reasoning"].stringValue
                }
        }
    }
}

private extension JSONValue {
    var spacesThreadID: String { self["threadNodeId"].stringValue }
    var spacesWorkspaceID: String { self["workspaceId"].stringValue }
    var spacesNodeID: String { self["nodeId"].stringValue }
}

private struct NativeSpacesOpenedConversation: Identifiable { let id: String }
