import SwiftUI
import MichiCore

struct NativeLinkedConversations: View {
    let api: MichiAPI
    @ObservedObject var conversations: FeatureDatabaseConversationModel
    let ids: [String]
    @StateObject private var store: MichiStore
    @State private var opened: String?
    @State private var error: String?
    @Environment(\.scenePhase) private var scenePhase
    init(api: MichiAPI, conversations: FeatureDatabaseConversationModel, ids: [String]) {
        self.api = api; self.conversations = conversations; self.ids = ids
        _store = StateObject(wrappedValue: MichiStore(api: api))
    }
    var body: some View {
        if !ids.isEmpty {
            Section {
                ForEach(Array(Set(ids)).sorted(), id: \.self) { id in
                    if let card = conversations.card(nodeID: id) {
                        DesignPagesChatCard(
                            title: card.title,
                            subtitle: card.state.capitalized,
                            quote: card.summary.isEmpty ? nil : card.summary,
                            state: DesignPagesFormat.cardState(["status": .string(card.state)])
                        ) {
                            Task {
                                await store.reload()
                                guard let graph = store.graphs.first(where: { $0.id == card.workspaceID && !$0.isDeleted }), let node = graph.node(id), node["deleted_at"].isNull else {
                                    error = "This conversation has moved or is no longer available."; return
                                }
                                opened = id; store.startObserving()
                            }
                        }
                    } else {
                        Text(id).font(MichiFont.meta).foregroundStyle(.secondary)
                    }
                }
                if let error { Text(error).font(MichiFont.rowSecondary).foregroundStyle(.red) }
            } header: {
                MichiSectionHeader(title: "Linked conversations")
            }
            .sheet(isPresented: Binding(get: { opened != nil }, set: { if !$0 { opened = nil; store.disconnectStreams() } })) {
                NavigationStack {
                    if let opened, let chat = store.chat(for: opened) {
                        ConversationView(chat: chat, store: store)
                            .navigationDestination(item: $store.selectedNodeID) { nodeID in
                                if let next = store.chat(for: nodeID) { ConversationView(chat: next, store: store) }
                            }
                            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { self.opened = nil; store.disconnectStreams() } } }
                    }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { store.disconnectStreams() }
                else if phase == .active && opened != nil { store.resumeStreams() }
            }
            .onDisappear { store.disconnectStreams() }
        }
    }
}
