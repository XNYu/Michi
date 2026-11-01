import SwiftUI
import MichiCore

struct NativeHomeScreen: View {
    @ObservedObject var store: MichiStore
    @ObservedObject var preferences: NativeAppearanceModel
    @ObservedObject var connection: ConnectionStore
    @StateObject private var activity: NativeHomeActivityModel
    @StateObject private var cards: HomeCardsModel
    @StateObject private var permissions: FeaturePermissionsSettingsModel
    @StateObject private var runtime: FeatureRuntimeSettingsModel
    @StateObject private var schedule: FeatureScheduleModel
    @State private var draft = ""
    @FocusState private var composerFocused: Bool
    @State private var showSettings = false
    @State private var creating = false
    @State private var showPermissions = false
    @State private var showRuntime = false
    @State private var homePage: FeatureOpenedPage?
    @State private var historyPage: FeatureOpenedPage?
    @State private var homePageJump: PageNavigationJump?
    @State private var homeDraft: NativeOpenedHomeDraft?
    @State private var inlineHomeDestination: NativeInlineHomeDestination?
    @State private var openedJob: NativeOpenedJob?
    @Environment(\.michiTokens) private var tokens
    @Environment(\.michiAppearance) private var appearance

    init(store: MichiStore, preferences: NativeAppearanceModel, connection: ConnectionStore) {
        self.store = store
        self.preferences = preferences
        self.connection = connection
        _activity = StateObject(wrappedValue: NativeHomeActivityModel(api: store.api))
        _cards = StateObject(wrappedValue: HomeCardsModel(api: store.api, workspaceIDs: store.visibleGraphs.map(\.id), hasConversation: true))
        _permissions = StateObject(wrappedValue: FeaturePermissionsSettingsModel(api: store.api))
        _runtime = StateObject(wrappedValue: FeatureRuntimeSettingsModel(api: store.api))
        _schedule = StateObject(wrappedValue: FeatureScheduleModel(api: store.api, workspaces: store.workspaceRows))
    }

    private var displayed: [NativeHomeActivityItem] {
        activity.displayed(store: store)
    }

    private var pulse: NativeHomePulseCounts {
        activity.pulse(for: displayed)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    pulseRow
                    section(.needsYou)
                    section(.running)
                    cardsBlock
                    section(.upNext)
                    section(.justDone)
                    if store.hydrated && displayed.isEmpty && activity.error == nil && cards.snapshot.greeting == nil && !cards.showsRecommendationGrid && !cards.showsCustomPageStatus {
                        Text("When a conversation needs you, is running, or just finished, it shows up here.")
                            .font(MichiFont.rowSecondary)
                            .foregroundStyle(tokens.muted)
                            .padding(20)
                    }
                    if let error = activity.error ?? store.error {
                        Text(error).font(MichiFont.rowSecondary).foregroundStyle(tokens.dangerText).padding(20)
                    }
                    Color.clear.frame(height: 24)
                }
            }
            .background(tokens.bg)
            .michiScrollEdge()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Home").font(MichiFont.sans(size: 15, relativeTo: .headline, weight: .semibold)).opacity(0) }
                ToolbarItem(placement: .topBarTrailing) {
                    MichiGlassIconButton(systemImage: "gearshape", accessibility: "Settings") { showSettings = true }
                }
            }
            .michiToolbarBackground()
            .toolbar(composerFocused ? .hidden : .automatic, for: .tabBar)
            .michiFloatingComposer { composer }
            .refreshable { await reload() }
            .navigationDestination(isPresented: $showSettings) {
                DesignSettingsHomeScreen(connection: connection, api: store.api, preferences: preferences, store: store)
            }
            .navigationDestination(isPresented: $showPermissions) {
                PermissionsSettingsScreen(api: store.api)
            }
            .navigationDestination(isPresented: $showRuntime) {
                RuntimeSettingsScreen(api: store.api)
            }
            .navigationDestination(item: $homePage) { page in
                FeaturePageScreen(api: store.api, pageId: page.id, workspaceId: page.workspaceId, workspaces: store.workspaceRows)
            }
            .navigationDestination(item: $historyPage) { page in
                FeaturePageHistoryScreen(api: store.api, pageId: page.id, workspaceId: page.workspaceId, workspaces: store.workspaceRows)
            }
            .navigationDestination(item: $homePageJump) { jump in
                FeaturePageScreen(api: store.api, pageId: jump.pageID, workspaceId: jump.workspaceID, workspaces: store.workspaceRows, scrollTargetID: jump.blockID)
            }
            .navigationDestination(item: $inlineHomeDestination) { destination in
                inlineDestination(destination)
            }
            .navigationDestination(item: $openedJob) { job in
                FeatureScheduleDetailScreen(model: schedule, jobId: job.id) { target in
                    Task { await openConversation(workspace: target.workspaceID, node: target.nodeID) }
                }
            }
            .sheet(item: $homeDraft) { item in
                NativeHomeDraftScreen(store: store, selection: item.selection) { nodeID, _ in
                    homeDraft = nil
                    Task { await openConversation(nodeID: nodeID) }
                }
            }
            .task(id: store.hydrated) {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--preview-settings") { showSettings = true }
                #endif
                guard store.hydrated else { return }
                await reload()
            }
        }
        .background(tokens.bg)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(homeEyebrow())
                .font(MichiFont.tag)
                .tracking(0.88)
                .textCase(.uppercase)
                .foregroundStyle(tokens.muted)
            if let greeting = cards.snapshot.greeting ?? homeActivityGreeting {
                HStack(alignment: .top, spacing: 6) {
                    Text("_").font(MichiFont.greeting).foregroundStyle(tokens.accent)
                    Text(greeting.text)
                        .font(MichiFont.greeting)
                        .tracking(-0.52)
                        .foregroundStyle(tokens.fg)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                if let detail = greeting.detail, !detail.isEmpty {
                    Text(detail).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    private var pulseRow: some View {
        HStack(spacing: 14) {
            pulseItem(.streaming, "\(pulse.running) running")
            pulseItem(.waiting, "\(pulse.needsYou) need you")
            pulseItem(.done, "\(pulse.doneToday) done today")
        }
        .font(MichiFont.meta)
        .foregroundStyle(tokens.mid)
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 8)
    }

    private func pulseItem(_ state: MichiThreadState, _ text: String) -> some View {
        HStack(spacing: 6) {
            MichiThreadStateDot(state: state)
            Text(text)
        }
    }

    @ViewBuilder
    private func section(_ section: NativeHomeActivitySection) -> some View {
        let rows = activity.items(displayed, in: section)
        if !rows.isEmpty {
            MichiSectionHeader(title: section.title, count: activity.headerCount(section, rows: rows))
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
                    Button { Task { await open(item) } } label: {
                        MichiHairlineRow(title: item.title, subtitle: item.subtitle, leading: {
                            lead(item)
                        }, trailing: {
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint)
                        })
                    }
                    .buttonStyle(.plain)
                    if index < rows.count - 1 {
                        Rectangle().fill(tokens.sep).frame(height: 1).padding(.leading, 56)
                    }
                }
            }
            .overlay(alignment: .top) { Rectangle().fill(tokens.sep).frame(height: 1) }
            .overlay(alignment: .bottom) { Rectangle().fill(tokens.sep).frame(height: 1) }
        }
    }

    private var homeActivityGreeting: HomeGreetingRecord? {
        activity.greetingText.isEmpty ? nil : HomeGreetingRecord(text: activity.greetingText, detail: activity.greetingDetail)
    }

    private var cardsBlock: some View {
        NativeHomeCards(
            model: cards,
            presentation: .dashboard,
            workspaceIDs: store.visibleGraphs.map(\.id),
            hasConversation: store.visibleGraphs.contains { !$0.threadTrees.isEmpty },
            onSelection: openHomeSelection,
            onInlineDestination: openInlineHomeDestination,
            onPageNavigation: { homePageJump = $0 }
        )
    }

    @ViewBuilder
    private func lead(_ item: NativeHomeActivityItem) -> some View {
        switch item.kind {
        case .permission: Image(systemName: "hand.raised").foregroundStyle(tokens.accent)
        case .question: Image(systemName: "text.bubble").foregroundStyle(tokens.accent)
        case .proposal: Image(systemName: "wrench").foregroundStyle(tokens.accent)
        case .job: Image(systemName: "clock").foregroundStyle(tokens.mid)
        case .run: MichiThreadStateDot(state: .streaming)
        case .digest: Image(systemName: "checkmark").foregroundStyle(tokens.digest)
        default:
            MichiThreadStateDot(state: item.state == "waiting" ? .waiting : item.state == "streaming" ? .streaming : item.state == "stalled" ? .stalled : item.state == "done" ? .done : item.state == "failed" ? .failed : .idle)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            MichiComposerBar(
                text: $draft,
                placeholder: "Ask anything",
                focused: $composerFocused,
                canSend: canStart,
                isBusy: creating,
                onPlus: { composerFocused = true },
                onSend: { Task { await startConversation(send: true) } }
            ) {
                HStack(spacing: 8) {
                    if permissions.ready {
                        permissionChip
                    }
                    if runtime.ready, !runtimeChipTitle.isEmpty {
                        Button { showRuntime = true } label: { statusChip(runtimeChipTitle, systemImage: "cpu") }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Runtime & models")
                    }
                    Spacer()
                }
            }
        }
    }

    @ViewBuilder
    private var permissionChip: some View {
        if permissions.draft.global {
            statusChip(permissionTitle, systemImage: "checkmark.shield")
                .accessibilityLabel("Permissions \(permissionTitle), set globally")
        } else {
            Button { showPermissions = true } label: { statusChip(permissionTitle, systemImage: "checkmark.shield") }
                .buttonStyle(.plain)
                .accessibilityLabel("Permissions")
        }
    }

    private var permissionTitle: String {
        if permissions.draft.global {
            if permissions.draft.mode == "ask" && permissions.draft.approveForMe { return "Ask + approve" }
            return permissions.draft.mode.capitalized
        }
        return "Ask"
    }

    private var runtimeChipTitle: String {
        let runtimeID = runtime.draft.runtime
        let row = runtime.runtimes.first { $0.id == runtimeID }
        let runtimeName = row.map(featureRuntimeLabel) ?? (runtimeID.isEmpty ? "" : runtimeID)
        let modelID = runtime.draft.model
        let modelRow = runtime.models.first { $0.id == modelID }
        let modelName = modelRow?["label"].optionalString ?? modelRow?["name"].optionalString ?? modelID
        return [runtimeName, modelName, runtime.draft.reasoning].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func statusChip(_ title: String, systemImage: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage).font(.system(size: 11, weight: .medium))
            Text(title).font(MichiFont.chip)
        }
        .foregroundStyle(tokens.mid)
        .padding(.horizontal, 10)
        .frame(height: 28)
        .overlay { Capsule().stroke(tokens.line, lineWidth: 1) }
        .padding(.vertical, 8)
    }

    private var canStart: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !creating && store.hydrated
    }

    private func open(_ item: NativeHomeActivityItem) async {
        if item.kind == .job || item.kind == .run, let jobID = item.jobID, !jobID.isEmpty {
            schedule.workspaces = store.workspaceRows
            openedJob = NativeOpenedJob(id: jobID)
            await schedule.refresh()
            await schedule.loadDetail(jobId: jobID)
            return
        }
        if item.kind == .proposal, let page = item.pageID, let workspace = item.workspaceID {
            historyPage = FeatureOpenedPage(id: page, workspaceId: workspace)
            return
        }
        if let page = item.pageID, let workspace = item.workspaceID {
            homePage = FeatureOpenedPage(id: page, workspaceId: workspace)
            return
        }
        if let node = item.nodeID, let workspace = item.workspaceID {
            await openConversation(workspace: workspace, node: node)
        }
    }

    private func openConversation(workspace: String, node: String) async {
        await store.reload()
        guard store.hydrated,
              let graph = store.graphs.first(where: { $0.id == workspace && !$0.isDeleted }),
              let current = graph.node(node), current["deleted_at"].isNull, graph.isConversation(current) else {
            store.error = store.error ?? "The conversation is no longer available."
            return
        }
        store.presentConversation(current, workspace: workspace)
    }

    private func openConversation(nodeID: String) async {
        await store.reload()
        guard let graph = store.graph(for: nodeID), let node = graph.node(nodeID), node["deleted_at"].isNull else {
            store.error = store.error ?? "The conversation is no longer available."
            return
        }
        store.presentConversation(node, workspace: graph.id)
    }

    private func openHomeSelection(_ selection: HomeCardPickResult) {
        if selection.kind == .contentPage && (selection.contentPageID == nil || selection.contentPageWorkspaceID == nil) { return }
        if selection.openPagesHome {
            Task {
                do {
                    let value = try await store.api.request("/spaces-home")
                    let page = featureUnwrap(value, "page")
                    guard !page.id.isEmpty, !page["workspaceId"].stringValue.isEmpty else { throw NativeFailure("Pages Home could not be loaded.") }
                    homePage = FeatureOpenedPage(id: page.id, workspaceId: page["workspaceId"].stringValue)
                } catch { store.error = error.localizedDescription }
            }
        } else if let page = selection.contentPageID, let workspace = selection.contentPageWorkspaceID {
            homePage = FeatureOpenedPage(id: page, workspaceId: workspace)
        } else if selection.startMention || selection.nodeID != nil {
            homeDraft = NativeOpenedHomeDraft(selection: selection)
        } else if let prompt = selection.prompt, !prompt.isEmpty {
            if !draft.isEmpty { draft += "\n\n" }
            draft += prompt
            composerFocused = true
        } else {
            homeDraft = NativeOpenedHomeDraft(selection: selection)
        }
    }

    private func openInlineHomeDestination(_ destination: NativeInlineHomeDestination) {
        switch destination {
        case .page, .prompt: break
        case .thread(let id, let workspace):
            Task { await openConversation(workspace: workspace, node: id) }
        case .database, .tasks, .file, .component:
            inlineHomeDestination = destination
        }
    }

    @ViewBuilder
    private func inlineDestination(_ destination: NativeInlineHomeDestination) -> some View {
        switch destination {
        case .database(let id, let view, let workspace):
            FeatureDatabaseScreen(api: store.api, databaseId: id, workspaceId: workspace, initialViewId: view)
        case .tasks(let view, let workspace):
            NativeHomeTaskDestination(api: store.api, workspaceID: workspace, viewID: view)
        case .file(let path, let workspace):
            ArtifactDetail(api: store.api, workspaceID: workspace, artifact: ["file_path": .string(path), "name": .string(MichiAPI.safeArtifactFilename(path))])
        case .component(let id, let version, let workspace):
            NativeComponentLibraryScreen(api: store.api, workspaceID: workspace, workspaces: store.workspaceRows, initialComponentID: id, initialVersion: version.flatMap(Int.init))
        default:
            EmptyView()
        }
    }

    private func startConversation(send: Bool) async {
        guard !creating, store.hydrated else { return }
        creating = true
        defer { creating = false }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            var graph = NativeHomeActivityContract.creationWorkspace(selected: store.selectedGraph, live: store.graphs)
            if graph == nil {
                try await store.createWorkspace(name: "Chats", cwd: "")
                await store.reload()
                graph = NativeHomeActivityContract.creationWorkspace(selected: store.selectedGraph, live: store.graphs)
            }
            guard let graph, !graph.isSystem, !graph.isArchived, !graph.isDeleted else {
                throw NativeFailure("Create a workspace before starting a chat.")
            }
            let nodeID = try await store.createThread(in: graph)
            guard let chat = store.chat(for: nodeID) else { throw NativeFailure("The new conversation could not be opened.") }
            if !chat.loaded { await chat.load() }
            if !text.isEmpty { chat.draft = text }
            if send {
                guard chat.loaded else { throw NativeFailure("The conversation could not be loaded. Your draft is kept.") }
                chat.send()
            }
            draft = ""
            composerFocused = false
            await openConversation(workspace: graph.id, node: nodeID)
        } catch {
            store.error = error.localizedDescription
        }
    }

    private func reload() async {
        cards.workspaceIDs = Set(store.visibleGraphs.map(\.id))
        cards.hasConversation = store.visibleGraphs.contains { !$0.threadTrees.isEmpty }
        schedule.workspaces = store.workspaceRows
        async let cardsReload: Void = cards.reload()
        async let permissionsReload: Void = permissions.reload()
        async let runtimeReload: Void = runtime.reload()
        await cardsReload
        await activity.refresh(store: store, greeting: cards.snapshot.greeting)
        _ = await (permissionsReload, runtimeReload)
    }

    private func homeEyebrow(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEEE · MMMM d"
        return formatter.string(from: now).uppercased()
    }
}

private struct NativeOpenedHomeDraft: Identifiable {
    let id = UUID()
    let selection: HomeCardPickResult
}

private struct NativeOpenedJob: Identifiable, Hashable {
    let id: String
}
