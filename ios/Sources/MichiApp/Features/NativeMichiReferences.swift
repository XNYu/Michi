import SwiftUI
import MichiCore

private struct OpenMichiReferenceKey: EnvironmentKey {
    static let defaultValue: (NativeMichiReference) -> Void = { _ in }
}
private struct MichiReferenceAPIKey: EnvironmentKey {
    static let defaultValue: MichiAPI? = nil
}
extension EnvironmentValues {
    var openMichiReference: (NativeMichiReference) -> Void {
        get { self[OpenMichiReferenceKey.self] }
        set { self[OpenMichiReferenceKey.self] = newValue }
    }
    var michiReferenceAPI: MichiAPI? {
        get { self[MichiReferenceAPIKey.self] }
        set { self[MichiReferenceAPIKey.self] = newValue }
    }
}

struct NativeReferencePresentation: Identifiable {
    let id = UUID()
    let reference: NativeMichiReference
}

private struct NativeMichiReferencesModifier: ViewModifier {
    var api: MichiAPI?
    @Environment(\.michiReferenceAPI) private var inheritedAPI
    @State private var presented: NativeReferencePresentation?
    func body(content: Content) -> some View {
        if let api = api ?? inheritedAPI {
            content
                .environment(\.michiReferenceAPI, api)
                .environment(\.openMichiReference, { presented = NativeReferencePresentation(reference: $0) })
                .sheet(item: $presented) { item in
                    NativeReferenceScreen(api: api, reference: item.reference)
                }
        } else { content }
    }
}
extension View {
    func nativeMichiReferences(api: MichiAPI? = nil) -> some View {
        modifier(NativeMichiReferencesModifier(api: api))
    }
}

func nativeMichiOpenURL(_ url: URL, allowInternal: Bool, open: (NativeMichiReference) -> Void) -> OpenURLAction.Result {
    switch NativeMichiReference.linkDecision(for: url, allowInternal: allowInternal) {
    case .open(let target):
        open(target)
        return .handled
    case .system:
        return .systemAction
    case .discard:
        return .discarded
    }
}

/// Reading a citation never creates a conversation or activates a page helper.
/// Nested references get a presenter in their own sheet/presentation scope.
struct NativeReferenceScreen: View {
    let api: MichiAPI
    let reference: NativeMichiReference
    @StateObject private var model: NativeReferenceModel
    @Environment(\.dismiss) private var dismiss
    init(api: MichiAPI, reference: NativeMichiReference) {
        self.api = api; self.reference = reference
        _model = StateObject(wrappedValue: NativeReferenceModel(api: api))
    }
    var body: some View {
        NavigationStack {
            Group {
                if model.loading {
                    ProgressView("Opening reference…")
                        .font(MichiFont.rowSecondary)
                        .accessibilityIdentifier("reference-loading")
                } else if let resolved = model.resolved {
                    switch resolved {
                    case .page(let id, let workspaceID, let blockID):
                        FeaturePageScreen(api: api, pageId: id, workspaceId: workspaceID, workspaces: [], scrollTargetID: blockID)
                    case .conversation(let conversation):
                        NativeReferenceTranscript(api: api, conversation: conversation)
                    }
                } else {
                    ContentUnavailableView {
                        Label("Reference unavailable", systemImage: "link.badge.plus")
                    } description: {
                        Text(model.error ?? "This saved reference could not be opened.")
                    } actions: {
                        Button("Try again") { Task { await model.open(reference) } }
                    }.accessibilityIdentifier("reference-unavailable")
                }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .task { await model.open(reference) }
        .onDisappear { model.cancel() }
        .nativeMichiReferences(api: api)
    }
}

private struct NativeReferenceTranscript: View {
    let api: MichiAPI
    let conversation: NativeReferenceConversation
    @State private var hasPositioned = false
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    if conversation.messages.isEmpty {
                        Text("There are no saved messages in this conversation.").foregroundStyle(.secondary)
                    }
                    ForEach(conversation.messages) { message in
                        VStack(alignment: .leading, spacing: 8) {
                            if message.id == conversation.targetMessageID {
                                Label("Referenced message", systemImage: "quote.bubble")
                                    .font(.caption.weight(.semibold)).foregroundStyle(.tint)
                            }
                            NativeMessageView(message: message, api: api, workspaceID: conversation.graph.id)
                        }
                        .padding(12)
                        .background(message.id == conversation.targetMessageID ? Color.accentColor.opacity(0.09) : Color.clear, in: RoundedRectangle(cornerRadius: 12))
                        .id(message.id)
                        .accessibilityIdentifier("reference-message-" + message.id)
                    }
                }.padding(.horizontal, 12).padding(.vertical)
            }
            .task(id: conversation.targetMessageID) {
                guard !hasPositioned, let target = conversation.targetMessageID else { return }
                await Task.yield()
                guard !Task.isCancelled else { return }
                proxy.scrollTo(target, anchor: .top)
                hasPositioned = true
            }
        }
        .navigationTitle(conversation.graph.title(conversation.node))
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top) {
            HStack {
                Label(conversation.canOpenConversation ? "Saved conversation" : "Saved assistant conversation", systemImage: "text.bubble")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                if conversation.canOpenConversation {
                    NavigationLink("Open conversation") {
                        NativeReferenceLiveConversation(api: api, nodeID: conversation.node.id, messageID: conversation.targetMessageID)
                    }.font(.caption).accessibilityIdentifier("reference-open-conversation")
                }
            }.padding(.horizontal).padding(.vertical, 8).background(.bar)
        }
    }
}

private struct NativeReferenceLiveConversation: View {
    let nodeID: String
    let messageID: String?
    @StateObject private var store: MichiStore
    @State private var ready = false
    @State private var visible = false
    @State private var appearanceGeneration = UUID()
    @Environment(\.scenePhase) private var scenePhase
    init(api: MichiAPI, nodeID: String, messageID: String?) {
        self.nodeID = nodeID; self.messageID = messageID
        _store = StateObject(wrappedValue: MichiStore(api: api))
    }
    var body: some View {
        Group {
            if !ready { ProgressView("Opening conversation…") }
            else if let graph = store.graph(for: nodeID), !graph.isDeleted,
                    let node = graph.node(nodeID), node["deleted_at"].isNull,
                    NativeReferenceConversation.canOpenConversation(graph: graph, node: node), let chat = store.chat(for: nodeID) {
                ConversationView(chat: chat, store: store, initialMessageID: messageID)
            } else {
                ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left", description: Text(store.error ?? "This conversation is no longer available."))
            }
        }
        .task {
            let generation = UUID(); appearanceGeneration = generation; visible = true
            await store.reload()
            guard !Task.isCancelled, visible, appearanceGeneration == generation else { return }
            ready = true
            if scenePhase == .active { store.resumeStreams() }
        }
        .onDisappear { visible = false; appearanceGeneration = UUID(); store.disconnectStreams() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { store.disconnectStreams() }
            if phase == .active && visible { store.resumeStreams() }
        }
        .navigationDestination(item: $store.selectedNodeID) { id in
            if let chat = store.chat(for: id) { ConversationView(chat: chat, store: store) }
        }
    }
}
