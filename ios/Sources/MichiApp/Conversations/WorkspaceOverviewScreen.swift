import SwiftUI
import MichiCore

/// A navigation destination; the caller owns the navigation stack and routing
/// to conversation nodes, including source nodes from a merged thread.
struct WorkspaceOverviewScreen: View {
    @StateObject private var model: WorkspaceOverviewModel
    @StateObject private var digestReadModel: NativeDigestReadModel
    @StateObject private var exportModel: NativeDigestPageExportModel
    private let onOpenNode: ((String) -> Void)?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.michiTokens) private var tokens
    @State private var mode: Mode
    @State private var mapShowsList = false
    @State private var confirmGenerate = false
    @State private var confirmUnknown = false
    @State private var confirmDiscard = false
    @State private var confirmSavePage = false
    @State private var confirmDismissExport = false
    @State private var pageTitleDraft = ""
    /// Graph / Timeline / Doc as on the web map, plus the thread digest.
    private enum Mode: String, CaseIterable { case map = "Graph", timeline = "Timeline", overview = "Doc", digest = "Digest" }

    init(api: MichiAPI, graph: WorkspaceGraph, startsInMap: Bool = false, onOpenNode: ((String) -> Void)? = nil) {
        _model = StateObject(wrappedValue: WorkspaceOverviewModel(api: api, graph: graph))
        _digestReadModel = StateObject(wrappedValue: NativeDigestReadModel(api: api, workspaceID: graph.id))
        _exportModel = StateObject(wrappedValue: NativeDigestPageExportModel(api: api, workspaceID: graph.id))
        _mode = State(initialValue: startsInMap ? .map : .overview)
        self.onOpenNode = onOpenNode
    }

    var body: some View {
        Group {
            if mode == .map && !mapShowsList { mapCanvas } else { scrollingContent }
        }
        .safeAreaInset(edge: .bottom) {
            if mode == .digest, let digest = model.selectedDigest { digestActionBar(digest) }
        }
        .background(tokens.bg)
        .navigationTitle(model.graph.name).navigationBarTitleDisplayMode(.inline)
        .michiToolbarBackground()
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Workspace view", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue.uppercased()).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 300)
                .accessibilityIdentifier("workspace-view-mode")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Thread", selection: Binding(get: { model.selectedTreeID }, set: model.selectTree)) {
                        ForEach(model.trees, id: \.id) { tree in Text(treeTitle(tree)).tag(tree.id) }
                    }.disabled(model.generating || model.saving || model.creatingFollowUp || exportModel.busy)
                    if mode == .map {
                        Toggle("Show as list", isOn: $mapShowsList)
                    }
                    // Screen 15 puts Share and Rebuild top right; the segmented
                    // view switch already holds the bar, so they live here.
                    if mode == .digest, let digest = model.selectedDigest {
                        ShareLink(item: digest["digest"].parsedJSON["content"].stringValue) {
                            Label("Share digest", systemImage: "square.and.arrow.up")
                        }
                        Button("Rebuild digest…", systemImage: "arrow.triangle.2.circlepath") { confirmGenerate = true }
                            .disabled(!model.canGenerate || exportModel.busy)
                    }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                        .disabled(model.loading || model.generating || model.saving)
                } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("Workspace view options")
            }
        }
        .task {
            await model.refresh()
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--uitesting") && ProcessInfo.processInfo.arguments.contains("--preview-digest") {
                model.selectDigest(model.digestNodes.first?.id); mode = .digest
            }
            if ProcessInfo.processInfo.arguments.contains("--uitesting") && ProcessInfo.processInfo.arguments.contains("--preview-graph") { mode = .map }
            #endif
        }
        .task(id: digestReadTaskKey) {
            guard !digestReadTaskKey.isEmpty, let digest = model.selectedDigest else { return }
            if let receipt = await digestReadModel.markViewed(node: digest) { model.applyDigestReadReceipt(receipt) }
        }
        .refreshable { if !model.generating && !model.saving && !model.creatingFollowUp { await model.refresh() } }
        .onDisappear {
            model.detachGeneration()
            // Leaving cannot cancel a request in flight; it only stops before the next one.
            exportModel.requestStop()
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { model.detachGeneration() } }
        .onChange(of: model.selectedDigestID, initial: true) { _, id in exportModel.load(digestID: id) }
        .navigationDestination(item: $exportModel.openedPage) { page in
            exportedPage(page)
        }
        .alert("Save digest as a page", isPresented: $confirmSavePage) {
            TextField("Page title", text: $pageTitleDraft)
            Button("Save") { startSavePage() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Creates a new top-level page in this workspace with this digest’s text. Titles can have up to 200 characters.")
        }
        .confirmationDialog("Allow saving this digest again?", isPresented: $confirmDismissExport, titleVisibility: .visible) {
            Button("Forget the earlier save", role: .destructive) { exportModel.dismissPending() }
        } message: {
            Text("This only forgets this device’s record. It doesn’t delete or change any page, and saving again may create a duplicate page.")
        }
        .confirmationDialog(model.selectedDigest == nil ? "Generate a thread digest?" : "Rebuild this digest?", isPresented: $confirmGenerate, titleVisibility: .visible) {
            Button(model.selectedDigest == nil ? "Generate digest" : "Rebuild digest") { model.generate(rebuildDigestID: model.selectedDigestID) }
        } message: {
            Text("This starts an agent using the selected thread’s conversation history. Keep this screen open to receive the result; closing it does not cancel the server operation.")
        }
        .confirmationDialog("Allow another generation?", isPresented: $confirmUnknown, titleVisibility: .visible) {
            Button("Allow a new generation") { model.acknowledgeUnknownGeneration() }
        } message: {
            Text("The previous request may still be running and cannot be recovered or cancelled from this endpoint. Starting another generation may duplicate work.")
        }
        .confirmationDialog("Discard the pending save?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard pending save", role: .destructive) { model.discardPendingSave() }
        } message: {
            Text("The displayed output remains available to copy until you leave or generate again. This does not delete a digest already saved on the server.")
        }
    }

    @ViewBuilder private var statusLines: some View {
        if model.loading { ProgressView("Refreshing workspace…").font(MichiFont.rowSecondary).tint(tokens.mid) }
        if model.readOnly { Label("This workspace or thread is read-only.", systemImage: "lock").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted) }
        if let error = model.error { Label(error, systemImage: "exclamationmark.triangle").font(MichiFont.row).foregroundStyle(tokens.dangerText).textSelection(.enabled) }
        if let notice = model.notice { Text(notice).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted) }
    }

    private func exportedPage(_ page: NativeDigestExportedPage) -> some View {
        FeaturePageScreen(api: model.api, pageId: page.id, workspaceId: page.workspaceID, workspaces: [model.graph.workspace])
            .safeAreaInset(edge: .top, spacing: 0) {
                if let message = exportModel.error {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(MichiFont.rowSecondary)
                        .foregroundStyle(tokens.dangerText)
                        .textSelection(.enabled)
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(tokens.bg)
                        .accessibilityIdentifier("digest-export-incomplete")
                }
            }
    }

    private var scrollingContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                statusLines
                switch mode {
                case .overview: overview
                case .map:
                    NativeWorkspaceGraph(layout: WorkspaceGraphLayout.make(graph: model.graph, treeID: model.selectedTreeID), showsList: true,
                        title: model.graph.title, summary: { WorkspaceOverviewSummary.text(node: $0, graph: model.graph) }, onOpen: onOpenNode)
                        .id(model.graph.id + ":" + model.selectedTreeID)
                case .timeline: timeline
                case .digest: digests
                }
            }
            .font(MichiFont.row)
            .foregroundStyle(tokens.fg)
            .padding(.horizontal, 20).padding(.vertical, 12)
        }
        .michiScrollEdge()
    }

    /// Full-bleed dot-grid canvas (screen 14); zoom, Root/Fit and the
    /// selected-node card float over it.
    private var mapCanvas: some View {
        let prompts = Self.openingPrompts(model.graph)
        return NativeWorkspaceGraph(layout: WorkspaceGraphLayout.make(graph: model.graph, treeID: model.selectedTreeID), showsList: false, fullBleed: true,
            asked: { prompts[$0.id] ?? "" },
            title: model.graph.title, summary: { WorkspaceOverviewSummary.text(node: $0, graph: model.graph) }, onOpen: onOpenNode)
            .id(model.graph.id + ":" + model.selectedTreeID)
            .overlay(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) { statusLines }
                    .padding(.horizontal, 20).padding(.top, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
    }

    private var digestReadTaskKey: String {
        guard mode == .digest, scenePhase == .active, model.hydrated, !model.readOnly, !model.generating, !model.saving,
              let digest = model.selectedDigest, digest["digest"].parsedJSON["status"] == "idle" else { return "" }
        return digest.id + ":" + String(digest["digest"].parsedJSON["generatedAt"].doubleValue) + ":" + String(digest["digest"].parsedJSON["viewedAt"].doubleValue)
    }

    private func digestIsIdle(_ digest: JSONValue) -> Bool { digest["digest"].parsedJSON["status"] == "idle" }
    private func canSavePage(_ digest: JSONValue) -> Bool {
        model.hydrated && !model.readOnly && !model.generating && !model.saving && !model.creatingFollowUp
            && !exportModel.busy && !exportModel.isBlocked && digestIsIdle(digest)
    }
    /// The same conditions as the automatic marker: on screen, hydrated, idle.
    private func canMarkRead(_ digest: JSONValue) -> Bool {
        scenePhase == .active && model.hydrated && !model.readOnly && !model.generating && !model.saving
            && !digestReadModel.marking && digestIsIdle(digest)
    }

    /// Screen 15's floating pair: Save as page (glass) and Mark as read (prominent).
    /// An unconfirmed earlier send becomes Check read state, a read-only GET.
    private func digestActionBar(_ digest: JSONValue) -> some View {
        let read = NativeDigestPageExport.isRead(digest)
        let action = digestReadModel.action(for: digest)
        let checks = !read && action == .check
        return HStack(spacing: 10) {
            Button {
                pageTitleDraft = model.graph.title(digest)
                confirmSavePage = true
            } label: {
                Text(exportModel.busy ? "Saving…" : "Save as page")
                    .font(MichiFont.sans(size: 15, relativeTo: .body, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 48)
            }
            .michiGlassButton()
            .disabled(!canSavePage(digest))
            .accessibilityIdentifier("digest-save-page")
            Button {
                Task { if let receipt = await digestReadModel.markViewed(node: digest, userInitiated: true) { model.applyDigestReadReceipt(receipt) } }
            } label: {
                Label(read ? "Read" : checks ? "Check read state" : "Mark as read",
                      systemImage: read ? "checkmark" : checks ? "questionmark.circle" : "envelope.open")
                    .font(MichiFont.sans(size: 15, relativeTo: .body, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 48)
            }
            .michiGlassButton(prominent: true).tint(tokens.accent).foregroundStyle(tokens.accentInk)
            .disabled(read || action == nil || !canMarkRead(digest))
            .accessibilityHint(markReadHint(action))
            .accessibilityIdentifier("digest-mark-read")
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
    }

    private func markReadHint(_ action: NativeDigestReadAction?) -> String {
        switch action {
        case .check: return "An earlier attempt may have been saved. Reads the saved state without sending the marker again."
        case .retry: return "The last attempt was refused and not saved. Sends the read marker again."
        case .mark, nil: return "Saves that you have read this version of the digest."
        }
    }

    private func startSavePage() {
        guard let digest = model.selectedDigest, canSavePage(digest) else { return }
        let title = pageTitleDraft
        Task { await exportModel.save(digest: digest, title: title) }
    }

    @ViewBuilder private var exportStatus: some View {
        if let progress = exportModel.progress {
            HStack(spacing: 10) {
                ProgressView(progress).font(MichiFont.rowSecondary).tint(tokens.mid)
                Spacer(minLength: 0)
                if exportModel.canStop {
                    Button("Stop") { exportModel.requestStop() }
                        .michiGlassButton()
                        .accessibilityHint("Stops before the next request. A request already sent is not cancelled.")
                }
            }
        }
        if let error = exportModel.error {
            Label(error, systemImage: "exclamationmark.triangle").font(MichiFont.rowSecondary).foregroundStyle(tokens.dangerText).textSelection(.enabled)
        }
        if let notice = exportModel.notice { Text(notice).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted) }
        if let unreadable = exportModel.pendingUnreadable {
            Text(unreadable).font(MichiFont.rowSecondary).foregroundStyle(tokens.dangerText)
        }
        if let pending = exportModel.pending, !exportModel.busy {
            VStack(alignment: .leading, spacing: 8) {
                if pending.pageID == nil {
                    Text("An earlier save of this digest may have created a page titled “\(pending.title)”. It won’t be created again automatically.")
                } else {
                    let inFlight = pending.inFlightPart.map { " Part \($0 + 1) may also have been saved." } ?? ""
                    Text("An earlier save created “\(pending.title)” with \(pending.savedParts) of \(pending.partCount) part\(pending.partCount == 1 ? "" : "s") confirmed.\(inFlight)")
                }
                HStack(spacing: 10) {
                    if pending.pageID != nil {
                        Button("Open page") { exportModel.openPendingPage() }.michiGlassButton()
                    } else {
                        Button("Check Pages") { Task { await exportModel.checkPendingCreation() } }.michiGlassButton()
                    }
                    Button("Forget…", role: .destructive) { confirmDismissExport = true }.michiGlassButton()
                }
                ForEach(Array(exportModel.candidates.enumerated()), id: \.offset) { _, page in
                    Button { exportModel.openedPage = page } label: {
                        Label("Open “\(page.title)”", systemImage: "doc.text").font(MichiFont.row)
                    }
                    .frame(minHeight: 44)
                }
            }
            .font(MichiFont.rowSecondary).foregroundStyle(tokens.fg)
            .padding(12)
            .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1) }
        }
    }

    private func treeTitle(_ tree: JSONValue) -> String {
        WorkspaceOverviewModel.treeTitle(tree, graph: model.graph)
    }

    private var overview: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            Text("\(model.rows.count) conversations").font(.headline)
            if model.rows.isEmpty { ContentUnavailableView("No visible conversations", systemImage: "point.3.connected.trianglepath.dotted") }
            ForEach(model.rows) { row in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: row.depth == 0 ? "bubble.left" : "arrow.turn.down.right").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 6) {
                        nodeButton(row.node)
                        let summary = WorkspaceOverviewSummary.text(node: row.node, graph: model.graph)
                        if !summary.isEmpty { NativeMarkdown(text: summary) }
                        HStack {
                            Text(row.node["status"].stringValue).font(.caption).foregroundStyle(.secondary)
                            if row.node["tree_id"].stringValue != model.selectedTreeID { Text("Merged context").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    Spacer(minLength: 0)
                }.padding(.leading, CGFloat(min(row.depth, 4)) * 10)
                Divider()
            }
        }
    }

    private var timeline: some View {
        LazyVStack(alignment: .leading, spacing: 18) {
            Text("Conversation activity").font(.headline)
            Text("Newest saved message or overview first. Empty conversations use their creation date.").font(.caption).foregroundStyle(.secondary)
            let dates = WorkspaceOverviewModel.activityDates(graph: model.graph)
            ForEach(model.rows.sorted { dates[$0.id, default: 0] > dates[$1.id, default: 0] }) { row in
                VStack(alignment: .leading, spacing: 6) {
                    nodeButton(row.node)
                    if let date = date(dates[row.id, default: 0]) { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
                    let trail = WorkspaceOverviewModel.overviewTrail(row.node).sorted { $0["at"].doubleValue < $1["at"].doubleValue }
                    if !trail.isEmpty {
                        DisclosureGroup("Overview history (\(trail.count))") {
                            ForEach(Array(trail.enumerated()), id: \.offset) { _, entry in
                                VStack(alignment: .leading, spacing: 5) {
                                    if let date = date(entry["at"].doubleValue) { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
                                    NativeMarkdown(text: entry["text"].stringValue)
                                }.padding(.vertical, 6)
                            }
                        }
                    } else { Text(WorkspaceOverviewSummary.text(node: row.node, graph: model.graph)).foregroundStyle(.secondary).textSelection(.enabled) }
                }
                Divider()
            }
        }
    }

    private var digests: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Digest", selection: Binding(get: { model.selectedDigestID }, set: model.selectDigest)) {
                Text("New digest").tag(String?.none)
                ForEach(model.digestNodes, id: \.id) { Text(model.graph.title($0)).tag(Optional($0.id)) }
            }.pickerStyle(.menu).disabled(model.generating || model.saving || model.creatingFollowUp || exportModel.busy)
            if let digest = model.selectedDigest {
                let content = digest["digest"].parsedJSON
                let sources = content["sources"].arrayValue.map(\.stringValue)
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.graph.title(digest)).font(MichiFont.sans(size: 28, relativeTo: .title, weight: .semibold)).tracking(-0.56).foregroundStyle(tokens.fg)
                    HStack(spacing: 6) {
                        MichiTag(text: "digest", kind: .ok)
                        if let generated = date(content["generatedAt"].doubleValue) {
                            Text("Generated \(generated.formatted(date: .abbreviated, time: .shortened)) from \(sources.count) thread\(sources.count == 1 ? "" : "s")")
                                .font(MichiFont.meta).foregroundStyle(tokens.muted)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                NativeMarkdown(text: content["content"].stringValue)
                if let notice = digestReadModel.notice { Text(notice).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted) }
                if let error = digestReadModel.error { Text(error).font(MichiFont.rowSecondary).foregroundStyle(tokens.dangerText) }
                exportStatus
                if !model.openQuestions.isEmpty {
                    HStack(spacing: 8) {
                        MichiThreadStateDot(state: .waiting)
                        Text("Still open").font(MichiFont.sans(size: 17, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg)
                    }.accessibilityAddTraits(.isHeader)
                    VStack(spacing: 0) {
                        ForEach(Array(model.openQuestions.enumerated()), id: \.offset) { index, question in
                            HStack(spacing: 12) {
                                NativeMarkdown(text: question).frame(maxWidth: .infinity, alignment: .leading)
                                Button {
                                    Task { if let id = await model.exploreDigest(question: question, digestID: digest.id) { onOpenNode?(id) } }
                                } label: {
                                    Label("Branch", systemImage: "arrow.triangle.branch")
                                        .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .medium)).foregroundStyle(tokens.mid)
                                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(!model.canExploreDigest || onOpenNode == nil)
                                .accessibilityLabel("Explore in a branch")
                            }
                            .padding(.leading, 10).frame(minHeight: 46)
                            .overlay(alignment: .top) { Rectangle().fill(tokens.sep).frame(height: 1) }
                            .accessibilityElement(children: .contain)
                            .id(index)
                        }
                    }
                }
                if !sources.isEmpty {
                    Text("Threads").font(MichiFont.sans(size: 17, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg).accessibilityAddTraits(.isHeader)
                    FlowChips(items: sources) { id in
                        if let node = model.graph.node(id), node["deleted_at"].isNull, node["workspace_id"].stringValue == model.graph.id {
                            Button { onOpenNode?(node.id) } label: { sourceChip(model.graph.title(node)) }
                                .buttonStyle(.plain).disabled(onOpenNode == nil)
                                .accessibilityLabel("Open conversation: \(model.graph.title(node))")
                        } else { sourceChip("Unavailable conversation").opacity(0.5) }
                    }
                }
                TextField("Ask from this digest", text: $model.followUpDraft, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(2...6)
                    .disabled(!model.canExploreDigest)
                Button("Create follow-up draft", systemImage: "bubble.left.and.text.bubble.right") {
                    let question = model.followUpDraft
                    Task { if let id = await model.exploreDigest(question: question, digestID: digest.id) { onOpenNode?(id) } }
                }.disabled(!model.canExploreDigest || model.followUpDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || onOpenNode == nil)
                Text("Opens a branch in the originating thread with your question ready to edit. The saved digest is included when you send.")
                    .font(.caption).foregroundStyle(.secondary)
                Divider()
            }
            if let error = model.followUpError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let pending = model.pendingFollowUp {
                Text("A follow-up creation has not been confirmed. Its original draft is retained; checking only reads the saved workspace.").font(.caption).foregroundStyle(.orange)
                Text(pending["node"]["composerDraft"].parsedJSON["value"].stringValue).textSelection(.enabled)
                Button("Check created conversation") { Task { if let id = await model.checkPendingFollowUp() { onOpenNode?(id) } } }
                    .disabled(model.creatingFollowUp || onOpenNode == nil)
            }
            if model.creatingFollowUp { ProgressView("Preparing follow-up…") }
            DisclosureGroup("Sources for generation") {
                Text(model.selectedDigest == nil ? "With no individual selection, all visible conversations in this thread are included. Merged context from other threads is excluded." : "Rebuilding includes all live conversations in the originating thread, including new branches. Merged context from other threads is excluded.").font(.caption).foregroundStyle(.secondary)
                ForEach(model.rows.filter { $0.node["tree_id"].stringValue == model.selectedTreeID }) { row in
                    Button { model.toggleSource(row.id) } label: {
                        Label(model.graph.title(row.node), systemImage: model.selection.contains(row.id) ? "checkmark.circle.fill" : "circle")
                    }.disabled(model.generating || model.saving || model.selectedDigest != nil)
                }
            }
            TextField("Optional generation guidance", text: $model.guidance, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(2...6).disabled(model.generating || model.saving || model.readOnly)
            if model.uncertainGeneration {
                Label("A previous generation has an unknown outcome.", systemImage: "questionmark.circle").foregroundStyle(.orange)
                Button("Allow another generation…") { confirmUnknown = true }.disabled(model.readOnly)
            }
            if model.hasUnsavedOutput {
                Text("The completed output is retained locally until its save is confirmed. Retrying saves this output without running the agent again.").foregroundStyle(.secondary)
                Button(model.pendingSave == nil ? "Retry preparing and saving" : "Retry the same save") { Task { await model.retrySave() } }
                    .disabled(model.saving || model.generating || model.recoveryReadOnly)
                Button("Discard pending save…", role: .destructive) { confirmDiscard = true }.disabled(model.saving || model.generating)
            }
            if model.selectedDigest == nil {
                Button { confirmGenerate = true } label: {
                    Label("Generate digest…", systemImage: "sparkles").font(MichiFont.sans(size: 15, relativeTo: .body, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 48)
                }
                .michiGlassButton(prominent: true).tint(tokens.accent).disabled(!model.canGenerate)
            }
            if model.generating || model.saving { ProgressView(model.generationStatus.isEmpty ? "Saving digest…" : model.generationStatus) }
            if !model.generationThought.isEmpty {
                DisclosureGroup("Generation notes") { Text(model.generationThought).font(.subheadline).foregroundStyle(.secondary).textSelection(.enabled) }
            }
            if !model.generatedContent.isEmpty {
                Divider()
                Text("Generated output").font(.headline)
                if model.hasUnsavedOutput || model.error != nil || model.generating { Text("Saving is not yet confirmed.").font(.caption).foregroundStyle(.secondary) }
                NativeMarkdown(text: model.generatedContent)
                ShareLink(item: model.generatedContent) { Label("Share output", systemImage: "square.and.arrow.up") }
            }
        }
    }

    private func nodeButton(_ node: JSONValue) -> some View {
        Button { onOpenNode?(node.id) } label: {
            HStack(alignment: .firstTextBaseline) {
                Text(model.graph.title(node)).multilineTextAlignment(.leading)
                if onOpenNode != nil { Image(systemName: "chevron.right").font(.caption) }
            }
        }.disabled(onOpenNode == nil).accessibilityLabel("Open conversation: \(model.graph.title(node))")
    }
    private func date(_ value: Double) -> Date? { value.isFinite && value > 0 && value < 253_402_300_799_000 ? Date(timeIntervalSince1970: value / 1000) : nil }

    /// First saved user prompt per node, from the snapshot's own messages.
    private static func openingPrompts(_ graph: WorkspaceGraph) -> [String: String] {
        var best: [String: (seq: Double, text: String)] = [:]
        for message in graph.raw["messages"].arrayValue where message["role"] == "user" {
            guard message["workspace_id"].isNull || message["workspace_id"].stringValue == graph.id else { continue }
            let node = message["node_id"].stringValue, text = message["content"].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !node.isEmpty, !text.isEmpty else { continue }
            let seq = message["seq"].doubleValue
            if let current = best[node], current.seq <= seq { continue }
            best[node] = (seq, text)
        }
        return best.mapValues { $0.text }
    }

    private func sourceChip(_ title: String) -> some View {
        Text(title)
            .font(MichiFont.mono(size: 13, relativeTo: .footnote)).foregroundStyle(tokens.mid).lineLimit(1)
            .padding(.horizontal, 10).frame(minHeight: 28)
            .overlay { RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(tokens.line, lineWidth: 1) }
            .padding(.vertical, 8).contentShape(Rectangle())
    }
}

private struct FlowChips<Item: Hashable, Content: View>: View {
    let items: [Item]
    @ViewBuilder var content: (Item) -> Content
    var body: some View {
        MichiFlowLayout(spacing: 8) { ForEach(items, id: \.self) { content($0) } }
    }
}

/// Wrapping row layout for source-thread chips.
private struct MichiFlowLayout: Layout {
    var spacing: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
            if x > 0 && x + size.width > width { x = 0; y += rowHeight; rowHeight = 0 }
            x += size.width + spacing; widest = max(widest, x - spacing); rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width.isFinite ? width : widest, height: y + rowHeight)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += rowHeight; rowHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing; rowHeight = max(rowHeight, size.height)
        }
    }
}
