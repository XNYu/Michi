import SwiftUI
import MichiCore

private enum DesignAgentsTab: Hashable {
    case runs, workflows, library
}

private struct DesignRunChip: Identifiable {
    let status: String
    let title: String
    var id: String { status }
}

/// Agents (ios/Design 44): agent runs and workflows filtered by status and
/// grouped by day, plus the agent library, in one screen. Workspace scope,
/// search, paging, polling and spawn recovery are AgentRunsModel's.
struct AgentRunsScreen: View {
    @StateObject private var model: AgentRunsModel
    @StateObject private var library: FeatureAgentLibraryModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.michiTokens) private var tokens
    @State private var newRun = false
    @State private var tab: DesignAgentsTab = .runs
    @State private var libraryQuery = ""
    @State private var titleVisible = true
    let onOpenConversation: ((String, String) -> Void)?
    init(api: MichiAPI, workspaceID: String? = nil, onOpenConversation: ((String, String) -> Void)? = nil) {
        _model = StateObject(wrappedValue: AgentRunsModel(api: api, workspaceID: workspaceID)); self.onOpenConversation = onOpenConversation
        _library = StateObject(wrappedValue: FeatureAgentLibraryModel(api: api))
    }
    var body: some View {
        List {
            Section {
                DesignSettingsTitleRow(title: "Agents", visible: $titleVisible) { workspaceMenu }
                DesignSettingsSegmented(selection: $tab, options: [
                    DesignSettingsOption(value: DesignAgentsTab.runs, label: "Runs"),
                    DesignSettingsOption(value: DesignAgentsTab.workflows, label: "Workflows"),
                    DesignSettingsOption(value: DesignAgentsTab.library, label: "Library")
                ], accessibilityTitle: "Agents view")
                .designSettingsBareRow(EdgeInsets(top: 8, leading: 16, bottom: 0, trailing: 16))
                if tab != .library {
                    chips.designSettingsBareRow(EdgeInsets(top: 4, leading: 16, bottom: 0, trailing: 16))
                }
            }
            if tab == .library {
                AgentLibraryRows(model: library, query: libraryQuery)
            } else {
                runRows
            }
        }
        .designSettingsList()
        .designSettingsTitle("Agents", revealed: !titleVisible)
        .searchable(text: tab == .library ? $libraryQuery : $model.query, prompt: searchPrompt)
        .refreshable {
            if tab == .library { await library.refresh() } else { await model.reload() }
        }
        .navigationDestination(for: NativeRunTarget.self) { target in AgentRunDetailScreen(api: model.api, target: target, onOpenConversation: onOpenConversation) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                switch tab {
                case .runs:
                    Button { newRun = true } label: { Image(systemName: "plus") }
                        .designSettingsProminentToolbarButton()
                        .accessibilityLabel("Start agent run")
                        .disabled(!model.customAgentsEnabled || model.availableDefinitions.isEmpty || model.workspaceID.isEmpty)
                case .library:
                    Button { library.beginCreate() } label: { Image(systemName: "plus") }
                        .designSettingsProminentToolbarButton()
                        .accessibilityLabel("New agent")
                        .disabled(library.customAgentsEnabled == false)
                case .workflows:
                    Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(model.loading)
                        .accessibilityLabel("Refresh workflows")
                }
            }
        }
        .sheet(isPresented: $newRun) { NativeStartAgentRunScreen(model: model) }
        .sheet(item: $library.createDraft) { draft in
            NavigationStack {
                FeatureAgentEditorForm(model: library, draft: draft, isNew: true)
            }
            .designSettingsSheetChrome()
        }
        .onChange(of: tab) { _, next in
            if next != .library { model.kind = next == .runs ? .agent : .workflow }
        }
        .onChange(of: model.kind) { _, _ in model.statusFilter = "" }
        .onChange(of: model.statusFilter) { _, _ in Task { await model.filtersChanged() } }
        .onChange(of: model.includeArchived) { _, _ in Task { await model.filtersChanged() } }
        .onChange(of: model.query) { _, query in
            Task {
                do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
                if model.query == query { await model.filtersChanged() }
            }
        }
        .task(id: tab) { if tab == .library { await library.refresh() } }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await model.bootstrap()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                await model.reload(preserveLoadedPages: true)
            }
        }
    }

    private var searchPrompt: String { tab == .library ? "Agent name" : "Name or task" }

    private var currentWorkspaceName: String {
        model.workspaces.first(where: { $0.id == model.workspaceID }).map(featureWorkspaceName) ?? "Choose a workspace"
    }

    private var workspaceMenu: some View {
        Menu {
            Picker("Workspace", selection: Binding(get: { model.workspaceID }, set: { id in Task { await model.selectWorkspace(id) } })) {
                ForEach(model.workspaces, id: \.id) { Text(featureWorkspaceName($0)).tag($0.id) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(currentWorkspaceName)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).accessibilityHidden(true)
            }
            .font(MichiFont.mono(size: 12, relativeTo: .caption))
            .foregroundStyle(tokens.muted)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .disabled(model.workspaces.isEmpty || tab == .library)
        .opacity(tab == .library ? 0.5 : 1)
        .accessibilityLabel("Workspace")
        .accessibilityValue(currentWorkspaceName)
    }

    private var chipFilters: [DesignRunChip] {
        model.kind == .agent
            ? [DesignRunChip(status: "", title: "All"), DesignRunChip(status: "running", title: "Running"), DesignRunChip(status: "waiting", title: "Needs you"), DesignRunChip(status: "completed", title: "Done")]
            : [DesignRunChip(status: "", title: "All"), DesignRunChip(status: "running", title: "Running"), DesignRunChip(status: "paused", title: "Paused"), DesignRunChip(status: "completed", title: "Done")]
    }

    private var chips: some View {
        let inChips = chipFilters.contains { $0.status == model.statusFilter }
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chipFilters) { chip in
                    DesignSettingsFilterChip(title: chip.title, selected: model.statusFilter == chip.status) { model.statusFilter = chip.status }
                }
                Menu {
                    Picker("Status", selection: $model.statusFilter) {
                        Text("All statuses").tag("")
                        ForEach(model.kind == .agent ? NativeRunContract.agentStatuses : NativeRunContract.workflowStatuses, id: \.self) {
                            Text(designSettingsRunStatusLabel($0)).tag($0)
                        }
                    }
                    if model.kind == .agent {
                        Toggle("Include archived runs", isOn: $model.includeArchived)
                    }
                } label: {
                    DesignSettingsChipLabel(
                        title: inChips ? "More" : designSettingsRunStatusLabel(model.statusFilter),
                        selected: !inChips || (model.kind == .agent && model.includeArchived),
                        systemImage: "chevron.down"
                    )
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .accessibilityLabel("More filters")
            }
        }
    }

    @ViewBuilder private var runRows: some View {
        if model.kind == .agent && !model.customAgentsEnabled {
            DesignSettingsSection {
                DesignSettingsStatusLine(text: "Custom agents are not enabled on this backend. Workflow activity remains available.", tone: .warn)
            }
        }
        if let error = model.kind == .agent ? model.error : model.workflowError {
            DesignSettingsSection {
                DesignSettingsErrorRow(title: "Activity unavailable", message: error, retry: { Task { await model.reload() } })
            }
        }
        if model.loading && model.visibleRows.isEmpty {
            Section { DesignSettingsLoading(message: "Loading activity…", inline: true).designSettingsBareRow() }
        }
        ForEach(designSettingsDayGroups(model.visibleRows, date: designAgentRunDate)) { group in
            DesignSettingsSection(title: group.title) {
                ForEach(group.items, id: \.id) { run in
                    NavigationLink(value: NativeRunTarget(id: run.id, workspaceID: model.workspaceID, kind: model.kind)) {
                        DesignAgentRunRow(run: run, kind: model.kind)
                    }
                }
            }
        }
        if model.visibleRows.isEmpty && !model.loading {
            Section {
                ContentUnavailableView("No matching activity", systemImage: "list.bullet.clipboard")
                    .designSettingsBareRow(EdgeInsets(top: 32, leading: 20, bottom: 20, trailing: 20))
            }
        }
        if model.kind == .agent && model.hasMore {
            DesignSettingsSection {
                DesignSettingsActionRow(title: "Load more runs") { Task { await model.loadMore() } }
                    .disabled(model.loading)
            }
        }
    }
}

private func designAgentRunDate(_ run: JSONValue) -> Double? {
    let started = run["startedAt"].doubleValue
    return started == 0 ? run["createdAt"].featureOptionalNumber : started
}

private func designAgentState(_ status: String) -> MichiThreadState {
    switch status {
    case "running": return .streaming
    case "queued", "preparing", "recovering": return .running
    case "waiting": return .waiting
    case "paused": return .stalled
    case "completed": return .done
    case "failed": return .failed
    default: return .idle
    }
}

/// One run row: status glyph, name, a status line in the web's semantic
/// colors and, for workflows, step progress.
private struct DesignAgentRunRow: View {
    let run: JSONValue
    let kind: NativeRunKind
    @Environment(\.michiTokens) private var tokens

    private var status: String { run["status"].stringValue }
    private var approvals: Int { kind == .workflow ? run["approvals"].arrayValue.count : 0 }
    private var nodes: [JSONValue] { kind == .workflow ? run["nodes"].arrayValue : [] }
    private var finishedNodes: Int { nodes.filter { ["completed", "skipped"].contains($0["status"].stringValue) }.count }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            MichiThreadStateDot(state: approvals > 0 ? .waiting : designAgentState(status))
                .frame(width: 14, height: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(NativeRunContract.name(run, kind: kind))
                    .font(MichiFont.row)
                    .foregroundStyle(tokens.fg)
                    .lineLimit(2)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Text(statusLine.text)
                    .font(DesignSettingsFont.note)
                    .foregroundStyle(tokens.designSettingsColor(statusLine.tone))
                    .lineLimit(2)
                if let secondary, !secondary.isEmpty {
                    Text(secondary)
                        .font(DesignSettingsFont.note)
                        .foregroundStyle(tokens.muted)
                        .lineLimit(2)
                }
                if let progress {
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(tokens.alt2)
                            Capsule().fill(tokens.select).frame(width: proxy.size.width * progress)
                        }
                    }
                    .frame(height: 4)
                    .padding(.top, 6)
                    .accessibilityHidden(true)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var started: Double? { designAgentRunDate(run) }

    private var statusLine: (text: String, tone: DesignSettingsTone) {
        if kind == .agent {
            switch status {
            case "waiting":
                let reason = run["waitingReason"].stringValue.replacingOccurrences(of: "_", with: " ")
                return (reason.isEmpty ? "Needs you" : "Needs you · \(reason)", .accent)
            case "completed": return ("Done \(featureRelative(run["completedAt"].featureOptionalNumber ?? started))", .muted)
            case "failed": return ("Failed \(featureRelative(run["completedAt"].featureOptionalNumber ?? started))", .bad)
            case "cancelled": return ("Cancelled \(featureRelative(run["completedAt"].featureOptionalNumber ?? started))", .muted)
            default: return ("\(designSettingsRunStatusLabel(status)) · started \(featureRelative(started))", .muted)
            }
        }
        if approvals > 0 { return (approvals == 1 ? "Needs you · 1 approval" : "Needs you · \(approvals) approvals", .accent) }
        let detail = run["statusDetail"].stringValue
        switch status {
        case "running":
            if !nodes.isEmpty {
                let current = nodes.first { $0["status"].stringValue == "running" }?["title"].stringValue ?? ""
                let step = "Step \(min(finishedNodes + 1, nodes.count)) of \(nodes.count)"
                return (current.isEmpty ? step : "\(step) · \(current)", .muted)
            }
            return (detail.isEmpty ? "Running" : detail, .muted)
        case "paused": return (detail.isEmpty ? "Paused" : "Paused · \(detail)", .warn)
        case "completed": return ("Done \(featureRelative(run["endedAt"].featureOptionalNumber ?? started))", .muted)
        case "failed": return (detail.isEmpty ? "Failed" : "Failed · \(detail)", .bad)
        default: return (designSettingsRunStatusLabel(status), .muted)
        }
    }

    private var secondary: String? {
        kind == .agent ? run["task"].stringValue : run["description"].stringValue
    }

    private var progress: Double? {
        guard kind == .workflow, status == "running", !nodes.isEmpty else { return nil }
        return Double(finishedNodes) / Double(nodes.count)
    }
}

private struct NativeRunStatus: View {
    let status: String
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        HStack(spacing: 6) {
            MichiThreadStateDot(state: designAgentState(status)).accessibilityHidden(true)
            Text(designSettingsRunStatusLabel(status))
                .font(MichiFont.meta)
                .foregroundStyle(color)
        }
        .accessibilityElement(children: .combine)
    }
    private var color: Color {
        switch status {
        case "failed": return tokens.dangerText
        case "waiting": return tokens.accentText
        case "paused", "recovering": return tokens.selectInk
        case "completed": return tokens.digest
        default: return tokens.muted
        }
    }
}

private struct NativeStartAgentRunScreen: View {
    @ObservedObject var model: AgentRunsModel
    @Environment(\.dismiss) private var dismiss
    @State private var definitionID = ""
    @State private var task = ""
    @State private var environment = "auto"
    @State private var confirm = false
    var body: some View {
        NavigationStack {
            List {
                DesignSettingsSection(title: "Run on connected computer", footer: "Starts a new agent run using the selected definition's permissions. The backend sends a completion notification. Existing conversation turns are independent.") {
                    DesignSettingsMenuPicker(title: "Agent", selection: $definitionID, options: [DesignSettingsOption(value: "", label: "Choose an agent")] + model.availableDefinitions.map { DesignSettingsOption(value: $0.id, label: $0["name"].stringValue) })
                    TextField("Task", text: $task, axis: .vertical).lineLimit(4...12)
                    DesignSettingsMenuPicker(title: "Execution environment", selection: $environment, options: [
                        DesignSettingsOption(value: "auto", label: "Agent default"),
                        DesignSettingsOption(value: "read_only", label: "Workspace, read only"),
                        DesignSettingsOption(value: "git_worktree", label: "Isolated Git worktree")
                    ])
                }
                .disabled(model.spawning || model.spawnOutcomeUnknown)
                if model.error != nil || model.spawnRecoveryIssue != nil || model.spawnOutcomeUnknown {
                    DesignSettingsSection {
                        if let error = model.error { DesignSettingsNote(text: error, tone: .bad) }
                        if let issue = model.spawnRecoveryIssue { DesignSettingsNote(text: issue, tone: .bad) }
                        if model.spawnOutcomeUnknown { DesignSettingsNote(text: "The start request may have succeeded. Its original contents are saved on this device, including after restarting the app. Starting another run in this workspace is blocked because the backend cannot safely replay this request.", tone: .warn) }
                    }
                }
                DesignSettingsSection {
                    DesignSettingsActionRow(title: model.spawning ? "Starting run…" : "Start run", systemImage: "play", busy: model.spawning) { confirm = true }
                        .disabled(definitionID.isEmpty || task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.spawning || model.spawnOutcomeUnknown)
                }
            }
            .designSettingsList(onSheet: true)
            .designSettingsTitle("New agent run")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Start this agent run on the connected computer?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Start run") { Task { if await model.spawn(definitionID: definitionID, task: task, environment: environment, confirmed: true) { dismiss() } } }
            }
        }
        .designSettingsSheetChrome()
    }
}

private struct NativeRunConfirmation {
    let title: String
    let message: String
    let action: () async -> Void
}

struct AgentRunDetailScreen: View {
    @StateObject private var model: AgentRunDetailModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.michiTokens) private var tokens
    @State private var confirmation: NativeRunConfirmation?
    @State private var includeTask = true
    @State private var includeResult = true
    @State private var includeTranscript = false
    @State private var newThread = false
    let onOpenConversation: ((String, String) -> Void)?
    init(api: MichiAPI, target: NativeRunTarget, onOpenConversation: ((String, String) -> Void)? = nil) {
        _model = StateObject(wrappedValue: AgentRunDetailModel(api: api, target: target)); self.onOpenConversation = onOpenConversation
    }
    var body: some View {
        List {
            if model.ready {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        NativeRunStatus(status: model.run["status"].stringValue)
                        Text(NativeRunContract.name(model.run, kind: model.target.kind))
                            .font(DesignSettingsFont.detailTitle)
                            .tracking(-0.52)
                            .foregroundStyle(tokens.fg)
                            .accessibilityAddTraits(.isHeader)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .designSettingsBareRow(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                }
                DesignSettingsSection(title: model.target.kind == .agent ? "Task" : "Workflow") {
                    if model.target.kind == .agent { NativeMarkdown(text: model.run["task"].stringValue) }
                    else {
                        Text(model.run["description"].stringValue).foregroundStyle(tokens.fg)
                        if !model.run["statusDetail"].stringValue.isEmpty { DesignSettingsNote(text: model.run["statusDetail"].stringValue) }
                    }
                    if !model.run["parentNodeId"].stringValue.isEmpty, let onOpenConversation {
                        DesignSettingsActionRow(title: "Open parent conversation", systemImage: "bubble.left.and.bubble.right") { onOpenConversation(model.target.workspaceID, model.run["parentNodeId"].stringValue) }
                    }
                    if !model.run["parentRunId"].stringValue.isEmpty {
                        NavigationLink(value: NativeRunTarget(id: model.run["parentRunId"].stringValue, workspaceID: model.target.workspaceID, kind: .agent)) {
                            DesignSettingsNavLabel(title: "Open parent run", systemImage: "arrow.up.left", titleColor: tokens.accentText)
                        }
                    }
                    if !model.run["nodeId"].stringValue.isEmpty, let onOpenConversation {
                        DesignSettingsActionRow(title: "Open launching conversation", systemImage: "bubble.left") { onOpenConversation(model.target.workspaceID, model.run["nodeId"].stringValue) }
                    }
                }
                if model.target.kind == .agent { agentSections } else { workflowSections }
                DesignSettingsSection(title: "Details") { metadata }
            } else if model.loading {
                Section { DesignSettingsLoading(message: "Loading run…", inline: true).designSettingsBareRow() }
            }
            if let error = model.error {
                DesignSettingsSection { DesignSettingsErrorRow(title: "Run request failed", message: error) }
            }
            if let message = model.message {
                DesignSettingsSection { DesignSettingsNote(text: message) }
            }
            if let issue = model.recoveryIssue {
                DesignSettingsSection(title: "Recovery blocked") { DesignSettingsNote(text: issue, tone: .bad) }
            }
            if let pending = model.pendingAction {
                DesignSettingsSection(title: "Action result unknown") {
                    DesignSettingsNote(text: "The request may already have taken effect. Its original contents are saved on this device, including after restarting the app. No automatic retry occurs.")
                    if pending.canReplay {
                        DesignSettingsActionRow(title: "Recover the same request", systemImage: "arrow.uturn.forward") { Task { await model.retryPending() } }
                            .disabled(model.busy)
                    } else {
                        DesignSettingsNote(text: "This endpoint cannot safely replay the action. Further actions on this run remain blocked; you can still refresh and read its progress.", tone: .warn)
                    }
                }
            }
            if model.busy {
                Section { DesignSettingsLoading(message: "Submitting…", inline: true).designSettingsBareRow() }
            }
        }
        .designSettingsList()
        .designSettingsTitle(model.ready ? NativeRunContract.name(model.run, kind: model.target.kind) : "Run details")
        .refreshable { await model.load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.load() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Refresh run")
            }
        }
        .alert(confirmation?.title ?? "Confirm action", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })) {
            Button("Confirm") { if let action = confirmation?.action { Task { await action() } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(confirmation?.message ?? "") }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await model.load()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                await model.load()
            }
        }
    }
    @ViewBuilder private var agentSections: some View {
        if !model.pendingInteractions.isEmpty {
            DesignSettingsSection(title: "Needs your response") {
                ForEach(model.pendingInteractions, id: \.id) { interaction in
                    NativeRunInteraction(interaction: interaction, disabled: !model.canMutate) { response in
                        confirmation = .init(title: "Send this response?", message: "It will be delivered to the active agent run.", action: { await model.respond(id: interaction.id, response: response, confirmed: true) })
                    }
                }
            }
        }
        if model.interactions.contains(where: { $0["status"] != "pending" }) {
            DesignSettingsSection(title: "Past responses") {
                ForEach(model.interactions.filter { $0["status"] != "pending" }, id: \.id) { interaction in
                    DisclosureGroup(interaction["kind"].stringValue.replacingOccurrences(of: "_", with: " ").capitalized + " · " + interaction["status"].stringValue) {
                        Text(NativeRunContract.text(interaction["request"])).foregroundStyle(tokens.fg).textSelection(.enabled)
                        Text(NativeRunContract.text(interaction["response"])).foregroundStyle(tokens.muted).textSelection(.enabled)
                    }
                    .tint(tokens.muted)
                }
            }
        }
        DesignSettingsSection(title: "Activity", count: model.events.isEmpty ? nil : "\(model.events.count)") {
            if model.events.isEmpty { DesignSettingsNote(text: "No activity yet.") }
            ForEach(Array(model.events.enumerated()), id: \.offset) { _, event in
                NativeRunEvent(event: event)
            }
            if model.hasMoreEvents {
                DesignSettingsActionRow(title: "Load next event page") { Task { await model.loadMoreEvents() } }.disabled(model.loading)
            }
        }
        if !model.run["resultBundle"].isNull { DesignSettingsSection(title: "Result") { NativeRunResult(result: model.run["resultBundle"]) } }
        if !model.terminal {
            DesignSettingsSection(title: "Message this run") {
                TextField("Additional instructions or context", text: $model.input, axis: .vertical).lineLimit(2...8)
                DesignSettingsActionRow(title: "Queue input", systemImage: "text.append") {
                    let attempt = model.run["activeAttemptId"], text = model.input
                    confirmation = .init(title: "Send queued input?", message: "The current work continues while the runtime receives your message.", action: { await model.sendInput(mode: "queued", confirmed: true, expectedAttemptID: attempt, submittedInput: text) })
                }
                DesignSettingsActionRow(title: "Stop & redirect", systemImage: "arrow.triangle.turn.up.right.circle") {
                    let attempt = model.run["activeAttemptId"], text = model.input
                    confirmation = .init(title: "Stop and redirect this run?", message: "This interrupts current work and sends your message to the active attempt.", action: { await model.sendInput(mode: "immediate", confirmed: true, expectedAttemptID: attempt, submittedInput: text) })
                }.disabled(model.run["activeAttemptId"].isNull)
            }.disabled(!model.canMutate)
            DesignSettingsSection {
                DesignSettingsActionRow(title: "Notify when completed", systemImage: "bell") { confirmation = .init(title: "Request a completion notification?", message: "Creates a backend watch for this run.", action: { await model.createWatch(confirmed: true) }) }
                DesignSettingsActionRow(title: "Cancel run", systemImage: "stop.circle", role: .destructive) {
                    let attempt = model.run["activeAttemptId"]
                    confirmation = .init(title: "Cancel this run?", message: "Only the displayed active attempt is targeted.", action: { await model.cancel(confirmed: true, expectedAttemptID: attempt) })
                }
            }.disabled(!model.canMutate)
        } else {
            DesignSettingsSection(title: "Continue elsewhere") {
                DesignSettingsToggle(title: "Include task", isOn: $includeTask)
                DesignSettingsToggle(title: "Include result", isOn: $includeResult).disabled(model.run["resultBundle"].isNull)
                DesignSettingsToggle(title: "Include transcript", isOn: $includeTranscript).disabled(model.events.isEmpty)
                DesignSettingsToggle(title: "Allow a new thread if parent is unavailable", isOn: $newThread)
                DesignSettingsActionRow(title: "Create continuation", systemImage: "arrow.triangle.branch") {
                    let task = includeTask, result = includeResult && !model.run["resultBundle"].isNull, transcript = includeTranscript, fallback = newThread
                    confirmation = .init(title: "Create a conversation with this material?", message: "Creates a saved draft; it does not automatically send a new prompt.", action: { await model.continueRun(includeTask: task, includeResult: result, includeTranscript: transcript, newThread: fallback, confirmed: true) })
                }.disabled(!includeTask && (!includeResult || model.run["resultBundle"].isNull) && !includeTranscript)
                if model.run["definitionId"].isNull {
                    DesignSettingsActionRow(title: "Save as draft agent", systemImage: "square.and.arrow.down") { confirmation = .init(title: "Save this agent definition?", message: "Creates a disabled draft from the run's effective definition.", action: { await model.saveAsAgent(confirmed: true) }) }
                }
                if let continuation = model.continuation, let onOpenConversation {
                    DesignSettingsActionRow(title: "Open created conversation", systemImage: "bubble.left.and.bubble.right") { onOpenConversation(model.target.workspaceID, continuation["nodeId"].stringValue) }
                }
            }.disabled(!model.canMutate)
        }
        if !model.watches.isEmpty {
            DesignSettingsSection(title: "Watches and delivery") {
                ForEach(Array(model.watches.enumerated()), id: \.offset) { _, event in
                    if !event["type"].isNull { NativeRunEvent(event: event) }
                    else {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Completion watch").foregroundStyle(tokens.fg)
                            Text(event["status"].stringValue).font(MichiFont.meta).foregroundStyle(tokens.muted)
                        }
                    }
                }
            }
        }
    }
    @ViewBuilder private var workflowSections: some View {
        if !model.run["approvals"].arrayValue.isEmpty {
            DesignSettingsSection(title: "Tool approvals") {
                ForEach(model.run["approvals"].arrayValue, id: \.id) { approval in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(approval["title"].stringValue).font(MichiFont.rowTitle).foregroundStyle(tokens.fg)
                        Text(approval["detail"].stringValue).font(DesignSettingsFont.note).foregroundStyle(tokens.mid).textSelection(.enabled)
                        if approval["scope"] == "session" { DesignSettingsNote(text: "This approval belongs to the shared runtime session. Answering it also resolves it on other workflows in that session.") }
                        ForEach(Array(approval["options"].arrayValue.enumerated()), id: \.offset) { _, option in
                            DesignSettingsActionRow(title: option["name"].stringValue) {
                                confirmation = .init(title: option["name"].stringValue + "?", message: approval["title"].stringValue, action: { await model.workflowApproval(id: approval.id, optionID: option["optionId"].stringValue, confirmed: true) })
                            }
                        }
                    }
                }
            }.disabled(!model.canMutate)
        }
        DesignSettingsSection(title: "Steps", count: model.run["nodes"].arrayValue.isEmpty ? nil : "\(model.run["nodes"].arrayValue.count)") {
            ForEach(model.run["nodes"].arrayValue, id: \.id) { node in
                DisclosureGroup {
                    ForEach(["prompt", "currentTool", "statusMessage", "result", "error"], id: \.self) { key in
                        if !node[key].stringValue.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(key.capitalized).font(MichiFont.section).tracking(0.88).textCase(.uppercase).foregroundStyle(tokens.muted)
                                NativeMarkdown(text: node[key].stringValue)
                            }.padding(.vertical, 4)
                        }
                    }
                    if !node["parentId"].stringValue.isEmpty { LabeledContent("Parent step", value: node["parentId"].stringValue) }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(node["title"].stringValue).foregroundStyle(tokens.fg)
                        NativeRunStatus(status: node["status"].stringValue)
                    }
                }
                .tint(tokens.muted)
            }
        }
        if !model.run["result"].stringValue.isEmpty { DesignSettingsSection(title: "Final report") { NativeMarkdown(text: model.run["result"].stringValue) } }
        DesignSettingsSection(title: "Progress log") {
            ForEach(Array(model.run["log"].arrayValue.enumerated()), id: \.offset) { _, entry in
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry["text"].stringValue).foregroundStyle(tokens.fg).textSelection(.enabled)
                    Text(featureFormatDate(entry["at"].featureOptionalNumber)).font(MichiFont.meta).foregroundStyle(tokens.muted)
                }
            }
        }
        if !model.run["actions"].arrayValue.isEmpty {
            DesignSettingsSection(title: "Controls") {
                ForEach(model.run["actions"].arrayValue.map(\.stringValue), id: \.self) { action in
                    DesignSettingsActionRow(title: action.capitalized, role: action == "stop" ? .destructive : nil) { confirmation = .init(title: action.capitalized + " this workflow?", message: "The connected runtime will apply this control to this workflow.", action: { await model.workflowAction(action, confirmed: true) }) }
                }
            }.disabled(!model.canMutate)
        }
    }
    @ViewBuilder private var metadata: some View {
        LabeledContent("Run", value: model.target.id).textSelection(.enabled)
        if model.target.kind == .agent {
            LabeledContent("Runtime", value: model.run["effectiveDefinition"]["runtimeProfile"]["runtimeId"].stringValue)
            if !model.run["effectiveDefinition"]["runtimeProfile"]["modelId"].stringValue.isEmpty { LabeledContent("Model", value: model.run["effectiveDefinition"]["runtimeProfile"]["modelId"].stringValue) }
            LabeledContent("Definition", value: model.run["definitionId"].isNull ? "Ephemeral snapshot" : "Snapshot at revision \(model.run["definitionRevision"].intValue)")
            LabeledContent("Environment", value: model.run["executionEnvironment"]["kind"].stringValue.replacingOccurrences(of: "_", with: " "))
            LabeledContent("Permissions", value: model.run["effectiveDefinition"]["permissionPolicy"]["preset"].stringValue)
            if !model.run["waitingReason"].stringValue.isEmpty { LabeledContent("Waiting on", value: model.run["waitingReason"].stringValue.replacingOccurrences(of: "_", with: " ")) }
            LabeledContent("Completion", value: model.run["completionMode"].stringValue)
            DisclosureGroup("Context snapshot (\(model.run["contextManifest"]["entries"].arrayValue.count))") {
                DesignSettingsNote(text: "\(model.run["contextManifest"]["estimatedChars"].intValue) estimated characters · immutable snapshot")
                ForEach(Array(model.run["contextManifest"]["entries"].arrayValue.enumerated()), id: \.offset) { _, entry in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(entry["name"].optionalString ?? entry["label"].optionalString ?? entry["workspacePath"].optionalString ?? entry["kind"].stringValue).font(MichiFont.rowTitle).foregroundStyle(tokens.fg)
                        if !entry["content"].stringValue.isEmpty { Text(entry["content"].stringValue).font(DesignSettingsFont.note).foregroundStyle(tokens.mid).textSelection(.enabled) }
                        if !entry["size"].isNull { Text("\(entry["size"].intValue) bytes").font(MichiFont.meta).foregroundStyle(tokens.muted) }
                        Text("sha256 " + entry["sha256"].stringValue).font(MichiFont.mono(size: 11, relativeTo: .caption2)).foregroundStyle(tokens.muted).textSelection(.enabled)
                    }.padding(.vertical, 5)
                }
            }
            .tint(tokens.muted)
            DisclosureGroup("Attempts (\(model.attempts.count))") {
                ForEach(model.attempts, id: \.id) { attempt in
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Attempt \(attempt["attemptIndex"].intValue + 1) · \(attempt["runtimeProfile"]["runtimeId"].stringValue)").foregroundStyle(tokens.fg)
                        NativeRunStatus(status: attempt["status"].stringValue)
                        if !attempt["error"]["message"].stringValue.isEmpty { DesignSettingsNote(text: attempt["error"]["message"].stringValue, tone: .warn) }
                    }
                }
            }
            .tint(tokens.muted)
        } else {
            LabeledContent("Runtime", value: model.run["runtime"].stringValue)
            LabeledContent("Revision", value: String(model.run["revision"].intValue))
            if !model.run["definition"].stringValue.isEmpty {
                DisclosureGroup("Definition") {
                    Text(model.run["definition"].stringValue).font(MichiFont.code).foregroundStyle(tokens.mid).textSelection(.enabled)
                }
                .tint(tokens.muted)
            }
        }
    }
}

private struct NativeRunInteraction: View {
    let interaction: JSONValue
    let disabled: Bool
    let respond: (JSONValue) -> Void
    @State private var reply = ""
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(interaction["kind"].stringValue.replacingOccurrences(of: "_", with: " ").capitalized).font(MichiFont.rowTitle).foregroundStyle(tokens.fg)
            Text(NativeRunContract.text(interaction["request"])).foregroundStyle(tokens.mid).textSelection(.enabled)
            if interaction["kind"] == "permission" {
                HStack(spacing: 12) {
                    DesignSettingsActionRow(title: "Deny", role: .destructive) { respond(["decision": "deny"]) }
                    DesignSettingsActionRow(title: "Allow") { respond(["decision": "allow"]) }
                }
            } else {
                TextField("Your response or context", text: $reply, axis: .vertical).lineLimit(2...8)
                DesignSettingsActionRow(title: "Send response", systemImage: "arrow.up.circle") { respond(["text": .string(reply)]) }
                    .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(10)
        .background(tokens.accentF, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.accent.opacity(0.4), lineWidth: 1) }
        .disabled(disabled)
    }
}

private struct NativeRunEvent: View {
    let event: JSONValue
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        let type = event["type"].stringValue
        if type == "assistant" { NativeMarkdown(text: NativeRunContract.text(event["payload"])) }
        else {
            DisclosureGroup {
                Text(NativeRunContract.text(event["payload"])).font(DesignSettingsFont.note).foregroundStyle(tokens.mid).textSelection(.enabled)
                Text(featureFormatDate(event["createdAt"].featureOptionalNumber)).font(MichiFont.meta).foregroundStyle(tokens.muted)
            } label: {
                Text(type.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(MichiFont.mono(size: 12.5, relativeTo: .caption))
                    .foregroundStyle(tokens.mid)
            }
            .tint(tokens.muted)
        }
    }
}

private struct NativeRunResult: View {
    let result: JSONValue
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        if result["source"] == "inferred" { DesignSettingsStatusLine(text: "Inferred from final output", tone: .warn) }
        NativeMarkdown(text: result["handoff"]["conclusion"].stringValue)
        NativeMarkdown(text: result["handoff"]["artifactsOrChanges"].stringValue)
        if !result["handoff"]["unresolvedIssues"].stringValue.isEmpty { LabeledContent("Unresolved", value: result["handoff"]["unresolvedIssues"].stringValue) }
        ForEach(result["artifacts"].arrayValue, id: \.id) { artifact in
            if let url = URL(string: artifact["uri"].stringValue), MarkdownDocument.safeLink(url) {
                Link(destination: url) { DesignSettingsNavLabel(title: artifact["name"].stringValue, systemImage: "link", titleColor: tokens.accentText) }
            } else {
                DesignSettingsNavLabel(title: artifact["name"].stringValue, systemImage: "doc.text")
            }
        }
        if !result["changeSet"].isNull {
            DisclosureGroup("Changes · \(result["changeSet"]["changedFiles"].arrayValue.count) files") {
                Text(result["changeSet"]["summary"].stringValue).foregroundStyle(tokens.fg)
                Text("Base " + result["changeSet"]["baseCommit"].stringValue).font(MichiFont.meta).foregroundStyle(tokens.muted).textSelection(.enabled)
                ForEach(result["changeSet"]["changedFiles"].arrayValue.map(\.stringValue), id: \.self) { Text($0).font(MichiFont.code).foregroundStyle(tokens.mid) }
                DesignSettingsNote(text: "Changes have not been merged automatically.")
            }
            .tint(tokens.muted)
        }
        ForEach(["resourceMutations", "externalActions"], id: \.self) { key in
            ForEach(result[key].arrayValue, id: \.id) { receipt in Text(receipt["summary"].stringValue).font(DesignSettingsFont.note).foregroundStyle(tokens.mid).textSelection(.enabled) }
        }
    }
}
