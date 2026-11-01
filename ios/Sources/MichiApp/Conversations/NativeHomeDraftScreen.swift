import SwiftUI
import MichiCore

/// A Home suggestion is a draft. Opening it never starts an agent turn.
struct NativeHomeDraftScreen: View {
    @ObservedObject var store: MichiStore
    let selection: HomeCardPickResult
    let onPrepared: (String, Bool) -> Void
    @State private var workspaceID: String
    @State private var prompt: String
    @State private var preparing = false
    @State private var error: String?
    @State private var createdNode: String?
    @Environment(\.dismiss) private var dismiss

    init(store: MichiStore, selection: HomeCardPickResult, onPrepared: @escaping (String, Bool) -> Void) {
        self.store = store; self.selection = selection; self.onPrepared = onPrepared
        _workspaceID = State(initialValue: selection.workspaceID ?? store.selectedWorkspaceID ?? store.graphs.orderedLive.first?.id ?? "")
        _prompt = State(initialValue: selection.prompt ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                if selection.nodeID == nil {
                    Picker("Workspace", selection: $workspaceID) {
                        ForEach(store.graphs.orderedLive) { Text($0.name).tag($0.id) }
                    }.disabled(createdNode != nil)
                }
                if selection.startMention { Text("Choose a reference after opening the conversation.") }
                else { TextEditor(text: $prompt).frame(minHeight: 160).accessibilityLabel("Suggested draft") }
                Text("The suggestion is added to your composer. Any existing draft stays above it; nothing is sent until you tap Send.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
                Button(selection.nodeID == nil && createdNode == nil ? "Create conversation" : "Open conversation") { Task { await prepare() } }
                    .disabled(preparing || workspaceID.isEmpty)
                if preparing { ProgressView("Preparing draft…") }
            }.navigationTitle("Home suggestion")
                .toolbar { Button("Cancel") { dismiss() } }
        }
    }
    private func prepare() async {
        guard !preparing else { return }
        preparing = true; defer { preparing = false }
        do {
            let fresh = WorkspaceGraph(raw: try await store.api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))"))
            guard fresh.id == workspaceID, !fresh.isReadOnly, !fresh.isSystem else { throw NativeFailure("This workspace is no longer available for a new draft.") }
            let nodeID: String
            if let existing = selection.nodeID ?? createdNode {
                guard let node = fresh.node(existing), node["deleted_at"].isNull, node["workspace_id"].stringValue == workspaceID,
                      !fresh.isTreeArchived(node["tree_id"].stringValue) else { throw NativeFailure("This conversation moved or is now read-only.") }
                nodeID = existing; await store.reload()
            } else {
                nodeID = try await store.createThread(in: fresh)
                createdNode = nodeID
            }
            guard let chat = store.chat(for: nodeID), chat.graph.id == workspaceID else { throw NativeFailure("Refresh the workspace before opening this draft.") }
            if !chat.loaded { await chat.load() }
            guard chat.loaded, !chat.isReadOnly else { throw NativeFailure("The saved conversation could not be loaded. Your suggestion is kept here.") }
            if !prompt.isEmpty {
                // Appending does not invalidate existing mention offsets or
                // discard quotes/attachments in the current window's draft.
                chat.draft += (chat.draft.isEmpty ? "" : "\n\n") + prompt
            }
            onPrepared(nodeID, selection.startMention)
        } catch { self.error = error.localizedDescription }
    }
}
