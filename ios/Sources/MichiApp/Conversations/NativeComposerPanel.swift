import SwiftUI

struct NativeQueuePanel: View {
    @ObservedObject var chat: ChatController
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        DisclosureGroup {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(chat.queued) { entry in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading) {
                                Text(entry.composer.value.isEmpty ? "Quoted context or attachment" : entry.composer.value).lineLimit(3)
                                if entry.outcomeUnknown { Text("The action’s outcome is unknown. Check the response before removing this item; it will not run again automatically.").font(MichiFont.rowSecondary).foregroundStyle(tokens.selectInk) }
                                if entry.steering { ProgressView("Steering…").font(.caption) }
                            }
                            Spacer()
                            Menu {
                                Button("Edit in composer", systemImage: "pencil") { chat.restoreQueued(entry.id) }.disabled(entry.outcomeUnknown)
                                if chat.busy { Button("Steer now", systemImage: "arrow.turn.up.right") { Task { await chat.steerQueued(entry.id) } }.disabled(entry.outcomeUnknown || chat.steering) }
                                Button("Remove from queue", systemImage: "xmark", role: .destructive) { chat.removeQueued(entry.id) }
                            } label: { Image(systemName: "ellipsis.circle").frame(width: 36, height: 36) }.disabled(entry.steering)
                        }
                    }
                    if chat.queuePaused {
                        Text("The queue is paused. Your messages are kept here.").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                        Button("Resume queue") { chat.resumeQueue() }.disabled(chat.busy || chat.queued.first?.outcomeUnknown == true || chat.pendingSubmission != nil || chat.submissionRecoveryError != nil)
                            .frame(minHeight: 44)
                    }
                }.font(MichiFont.row).foregroundStyle(tokens.fg)
            }.frame(maxHeight: 180)
        } label: {
            Text("Queued · \(chat.queued.count)").font(MichiFont.mono(size: 12, relativeTo: .caption, weight: .medium)).foregroundStyle(tokens.mid)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .michiGlassRounded(18)
        .accessibilityIdentifier("message-queue")
    }
}

struct NativeDraftsScreen: View {
    @ObservedObject var chat: ChatController
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section { Text("Each device or browser window keeps its own draft. Taking a saved draft copies it here; the source stays available. Your current text moves to the paused queue.").font(.footnote).foregroundStyle(.secondary) }
                if chat.otherWindowDrafts.isEmpty { ContentUnavailableView("No other saved drafts", systemImage: "doc.text") }
                ForEach(chat.otherWindowDrafts, id: \.id) { item in
                    Button { chat.useDraft(item.composer); dismiss() } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.composer.value.isEmpty ? item.composer.quotedText : item.composer.value).lineLimit(6)
                            Text("Saved window " + String(item.id.suffix(8))).font(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(chat.isReadOnly)
                }
            }.navigationTitle("Saved drafts").toolbar { Button("Done") { dismiss() } }
        }
    }
}

struct NativeContextPicker: View {
    @ObservedObject var chat: ChatController
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    var body: some View {
        NavigationStack {
            List {
                Section("Conversations in this workspace") {
                    ForEach(chat.graph.visibleNodes().filter { query.isEmpty || chat.graph.title($0).localizedCaseInsensitiveContains(query) }, id: \.id) { node in
                        Button { chat.insertMention(kind: "node", id: node.id, label: chat.graph.title(node)); dismiss() } label: { Label(chat.graph.title(node), systemImage: "bubble.left") }
                    }
                }
                Section("Artifacts") {
                    ForEach(chat.graph.contexts.filter { query.isEmpty || $0["name"].stringValue.localizedCaseInsensitiveContains(query) }, id: \.id) { artifact in
                        Button { chat.insertMention(kind: "context", id: artifact.id, label: artifact["name"].stringValue); dismiss() } label: { Label(artifact["name"].stringValue, systemImage: "doc.text") }
                    }
                }
            }.navigationTitle("Add a reference").searchable(text: $query)
                .toolbar { Button("Done") { dismiss() } }
        }
    }
}
