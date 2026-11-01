import SwiftUI
import MichiCore

/// Scheduled jobs (ios/Design 23). Owns its NavigationStack for TabView placement.
/// Jobs are grouped by workspace; the Meta agent's background maintenance is the
/// System row, read from /meta-agent/overview. Every mutation still goes
/// through FeatureScheduleModel / MetaMaintenanceModel.
struct ScheduleScreen: View {
    let api: MichiAPI
    let workspaces: [JSONValue]
    let onOpenConversation: (NativeRunConversationTarget) -> Void

    @StateObject private var model: FeatureScheduleModel
    @StateObject private var maintenance: MetaMaintenanceModel
    @State private var confirmStop = false
    @State private var stopRunId = ""
    @State private var filter: DesignScheduleFilter = .all
    @State private var titleVisible = true
    @State private var confirmMaintenance = false
    @State private var maintenancePauses = true
    @State private var showAssistant = false
    @State private var showSettings = false
    @State private var showMaintenance = false

    init(api: MichiAPI, workspaces: [JSONValue], onOpenConversation: @escaping (NativeRunConversationTarget) -> Void = { _ in }) {
        self.api = api
        self.workspaces = workspaces; self.onOpenConversation = onOpenConversation
        _model = StateObject(wrappedValue: FeatureScheduleModel(api: api, workspaces: workspaces))
        _maintenance = StateObject(wrappedValue: MetaMaintenanceModel(api: api))
    }

    var body: some View {
        NavigationStack {
            Group {
                if loadingOnly {
                    DesignSettingsLoading(message: "Loading scheduled jobs")
                } else {
                    list
                }
            }
            .designSettingsTitle("Scheduled", revealed: loadingOnly || !titleVisible)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { optionsMenu }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        model.beginCreate()
                    } label: {
                        Image(systemName: "plus")
                    }
                    .designSettingsProminentToolbarButton()
                    .disabled(workspaces.isEmpty)
                    .accessibilityLabel("New job")
                }
            }
            .refreshable { await refreshAll() }
            .sheet(item: $model.editor) { draft in
                FeatureScheduleEditorScreen(model: model, draft: draft)
            }
            .navigationDestination(isPresented: $showAssistant) { NativeSpacesAssistantScreen(api: api, purpose: "schedule") }
            .navigationDestination(isPresented: $showSettings) { FeatureScheduleSettingsScreen(model: model) }
            .navigationDestination(isPresented: $showMaintenance) { MetaMaintenanceScreen(api: api) }
            .onChange(of: workspaces) { _, latest in model.workspaces = latest }
            .confirmationDialog("Confirm the previous execution has stopped?", isPresented: $confirmStop, titleVisibility: .visible) {
                Button("Both have stopped") {
                    let runId = stopRunId
                    Task { await model.confirmStopped(runId: runId) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("First stop the previous Michi process and the agent it started. A stop request alone does not confirm they have ended. Only continue after you have verified both have stopped. This allows new scheduled runs to start; it does not rerun the interrupted work.")
            }
            .confirmationDialog(maintenancePauses ? "Pause maintenance in every workspace?" : "Resume maintenance in every workspace?", isPresented: $confirmMaintenance, titleVisibility: .visible) {
                Button(maintenancePauses ? "Pause maintenance" : "Resume maintenance") {
                    let pause = maintenancePauses
                    Task { await maintenance.setPaused(pause, confirmed: true) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .task { model.workspaces = workspaces; await refreshAll() }
        }
    }

    private var loadingOnly: Bool {
        model.loading && model.jobs.isEmpty && model.error == nil && !maintenance.overviewReady
    }

    private func refreshAll() async {
        await model.refresh()
        await maintenance.reload()
    }

    private var list: some View {
        List {
            DesignSettingsTitleRow(title: "Scheduled", visible: $titleVisible) {
                DesignSettingsSubtitle(text: "Runs while the Michi server is running", systemImage: "info.circle")
            }
            statusRows
            if maintenance.overviewReady {
                DesignSettingsSection(title: "System") {
                    DesignScheduleMaintenanceRow(maintenance: maintenance, open: { showMaintenance = true }) { pause in
                        maintenancePauses = pause
                        confirmMaintenance = true
                    }
                }
            }
            jobSections
            Section {
                DesignSettingsNote(text: "Swipe a job to run it now. New jobs use \(featureTimeZoneId().replacingOccurrences(of: "_", with: " ")).")
                    .designSettingsBareRow(EdgeInsets(top: 4, leading: 20, bottom: 24, trailing: 20))
            }
        }
        .designSettingsList()
    }

    @ViewBuilder private var statusRows: some View {
        if let error = model.error {
            DesignSettingsSection {
                DesignSettingsErrorRow(title: model.jobs.isEmpty ? "Couldn’t load jobs" : "Refresh failed", message: error, retry: { Task { await model.refresh() } })
            }
        }
        if let error = model.detailError {
            DesignSettingsSection {
                DesignSettingsErrorRow(title: "Last job request failed", message: error)
            }
        }
        if !model.scheduler.isNull && !model.scheduler["active"].boolValue {
            DesignSettingsSection {
                DesignSettingsStatusLine(
                    text: model.scheduler["serviceMode"].boolValue ? "Background service is coordinating this data directory." : "Another Michi process owns scheduling.",
                    tone: .warn
                )
            }
        }
        if !model.blocked.isEmpty {
            DesignSettingsSection(title: "Blocked executions") {
                ForEach(Array(model.blocked.enumerated()), id: \.offset) { _, item in
                    let runId = item["runId"].stringValue
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item["reason"].stringValue)
                            .font(MichiFont.row)
                            .fixedSize(horizontal: false, vertical: true)
                        DesignSettingsStatusLine(text: "Since \(featureFormatDate(item["since"].featureOptionalNumber))", tone: .bad)
                        DesignSettingsActionRow(title: model.confirmingStopIds.contains(runId) ? "Checking…" : "Confirm stopped", busy: model.confirmingStopIds.contains(runId)) {
                            stopRunId = runId
                            confirmStop = true
                        }
                        .disabled(runId.isEmpty || model.confirmingStopIds.contains(runId))
                    }
                }
            }
        }
    }

    @ViewBuilder private var jobSections: some View {
        let groups = jobGroups
        if model.jobs.isEmpty {
            DesignSettingsSection(title: "Jobs") {
                DesignSettingsNote(text: model.error == nil ? "No scheduled jobs yet. A job runs a prompt in a workspace on a schedule, as an ordinary conversation." : "Jobs could not be loaded.")
                DesignSettingsActionRow(title: "New job", systemImage: "plus") { model.beginCreate() }
                    .disabled(workspaces.isEmpty)
                DesignSettingsActionRow(title: "Create with Michi", systemImage: "sparkles") { showAssistant = true }
            }
        } else if groups.isEmpty {
            DesignSettingsSection(title: "Jobs") {
                DesignSettingsNote(text: "No jobs match “\(filter.title)”.")
                DesignSettingsActionRow(title: "Show all jobs") { filter = .all }
            }
        } else {
            ForEach(groups) { group in
                DesignSettingsSection(title: group.name, count: group.jobs.count == 1 ? "1 job" : "\(group.jobs.count) jobs") {
                    ForEach(group.jobs, id: \.id) { job in
                        DesignScheduleJobRow(model: model, job: job, onOpenConversation: onOpenConversation)
                    }
                }
            }
        }
    }

    private var jobGroups: [DesignScheduleGroup] {
        var order: [String] = []
        var buckets: [String: [JSONValue]] = [:]
        for job in model.jobs where filter.includes(job) {
            let key = job["workspaceId"].stringValue
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(job)
        }
        let known = model.workspaces.map(\.id)
        order.sort { (known.firstIndex(of: $0) ?? Int.max) < (known.firstIndex(of: $1) ?? Int.max) }
        return order.map { key in
            DesignScheduleGroup(
                id: key,
                name: model.workspaces.first(where: { $0.id == key }).map(featureWorkspaceName) ?? "Other workspace",
                jobs: buckets[key] ?? []
            )
        }
    }

    private var optionsMenu: some View {
        Menu {
            Picker("Show", selection: $filter) {
                ForEach(DesignScheduleFilter.allCases) { Text($0.title).tag($0) }
            }
            Divider()
            Button("Create with Michi", systemImage: "sparkles") { showAssistant = true }
            Button("Schedule settings", systemImage: "gearshape") { showSettings = true }
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await refreshAll() } }
        } label: {
            Image(systemName: filter == .all ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Filter and options")
        .accessibilityValue(filter.title)
    }
}

private enum DesignScheduleFilter: String, CaseIterable, Identifiable {
    case all, active, paused, attention
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "All jobs"
        case .active: return "Active"
        case .paused: return "Paused"
        case .attention: return "Needs attention"
        }
    }
    func includes(_ job: JSONValue) -> Bool {
        switch self {
        case .all: return true
        case .active: return job["enabled"].boolValue && !job["autoPaused"].boolValue
        case .paused: return !job["enabled"].boolValue || job["autoPaused"].boolValue
        case .attention: return job["autoPaused"].boolValue || ["failed", "timed_out", "interrupted"].contains(job["lastStatus"].stringValue)
        }
    }
}

private struct DesignScheduleGroup: Identifiable {
    let id: String
    let name: String
    let jobs: [JSONValue]
}

private struct DesignScheduleJobRow: View {
    @ObservedObject var model: FeatureScheduleModel
    let job: JSONValue
    let onOpenConversation: (NativeRunConversationTarget) -> Void
    @Environment(\.michiTokens) private var tokens

    private var name: String { featureNamed(job, fallback: "Untitled job") }
    private var enabled: Bool { job["enabled"].boolValue }
    private var running: Bool { job["activeRunId"].optionalString != nil }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            NavigationLink {
                FeatureScheduleDetailScreen(model: model, jobId: job.id, onOpenConversation: onOpenConversation)
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "clock")
                        .font(.system(size: 17, weight: .regular))
                        .foregroundStyle(enabled ? tokens.mid : tokens.muted)
                        .frame(width: 24)
                        .padding(.top, 1)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .font(MichiFont.row)
                            .foregroundStyle(enabled ? tokens.fg : tokens.muted)
                            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                        Text(designScheduleSummaryLine(job))
                            .font(DesignSettingsFont.note)
                            .foregroundStyle(tokens.muted)
                            .fixedSize(horizontal: false, vertical: true)
                        if let status = designScheduleJobStatus(job) {
                            DesignSettingsStatusLine(text: status.text, tone: status.tone)
                                .padding(.top, 2)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Opens job details")

            Toggle("Enabled", isOn: Binding(
                get: { enabled },
                set: { next in Task { await model.setEnabled(jobId: job.id, enabled: next) } }
            ))
            .labelsHidden()
            .tint(tokens.accent)
            .disabled(model.mutating || job.id.isEmpty)
            .padding(.top, 2)
            .accessibilityLabel("\(name) enabled")
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if !running && !job.id.isEmpty {
                Button {
                    Task { await model.runNow(jobId: job.id) }
                } label: {
                    Label("Run now", systemImage: "play.fill")
                }
                .tint(tokens.accent)
            }
        }
        .contextMenu {
            Button("Run now", systemImage: "play") { Task { await model.runNow(jobId: job.id) } }
                .disabled(running || model.mutating || job.id.isEmpty)
            Button(enabled ? "Pause" : "Resume", systemImage: enabled ? "pause.circle" : "play.circle") {
                Task { await model.setEnabled(jobId: job.id, enabled: !enabled) }
            }
            .disabled(model.mutating || job.id.isEmpty)
            Button("Edit", systemImage: "pencil") { model.beginEdit(job) }
                .disabled(model.mutating)
        }
    }
}

/// The Meta agent's background maintenance as a system job. The switch pauses
/// or resumes maintenance in every workspace, after the same confirmation as
/// Meta agent activity.
private struct DesignScheduleMaintenanceRow: View {
    @ObservedObject var maintenance: MetaMaintenanceModel
    let open: () -> Void
    let requestPause: (Bool) -> Void
    @Environment(\.michiTokens) private var tokens

    private var overview: JSONValue { maintenance.overview }
    private var notRunning: String? {
        let message = overview["notRunning"]["message"].stringValue
        return message.isEmpty ? nil : message
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: open) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "wrench")
                        .font(.system(size: 17, weight: .regular))
                        .foregroundStyle(tokens.mid)
                        .frame(width: 24)
                        .padding(.top, 1)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Meta agent · Maintain Pages")
                            .font(MichiFont.row)
                            .foregroundStyle(tokens.fg)
                            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                        Text("Checks every minute · uses the model only for pending work")
                            .font(DesignSettingsFont.note)
                            .foregroundStyle(tokens.muted)
                            .fixedSize(horizontal: false, vertical: true)
                        DesignSettingsStatusLine(text: status.text, tone: status.tone)
                            .padding(.top, 2)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Opens Meta agent activity")

            Toggle("Maintenance", isOn: Binding(
                get: { overview["state"].stringValue != "paused" },
                set: { on in requestPause(!on) }
            ))
            .labelsHidden()
            .tint(tokens.accent)
            .disabled(maintenance.busy || notRunning != nil)
            .padding(.top, 2)
            .accessibilityLabel("Meta agent maintenance")
        }
    }

    private var status: (text: String, tone: DesignSettingsTone) {
        if let notRunning { return (notRunning, .muted) }
        let today = overview["today"]
        switch overview["state"].stringValue {
        case "paused":
            return ("Paused", .muted)
        case "error":
            let message = overview["stopped"]["message"].optionalString ?? overview["error"].optionalString ?? "Stopped"
            return (message, .bad)
        default:
            let checks = "\(today["checks"].intValue)" + (today["checksTruncated"].boolValue ? "+" : "")
            return ("Running · \(checks) checks today", .run)
        }
    }
}

// MARK: - Detail (ios/Design 24)

struct FeatureScheduleDetailScreen: View {
    @ObservedObject var model: FeatureScheduleModel
    let jobId: String
    var onOpenConversation: (NativeRunConversationTarget) -> Void = { _ in }
    @State private var confirmCancel = false
    @State private var titleVisible = true
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens

    var job: JSONValue {
        model.jobs.first(where: { $0.id == jobId }) ?? (model.detail.id == jobId ? model.detail : .null)
    }

    /// History rows for this job only; the model's run list is shared.
    private var runs: [JSONValue] { model.runs.filter { $0["jobId"].stringValue == jobId } }
    private var enabled: Bool { job["enabled"].boolValue }
    private var running: Bool { job["activeRunId"].optionalString != nil }

    var body: some View {
        List {
            Section {
                header
                    .designSettingsBareRow(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                    .onAppear { titleVisible = true }
                    .onDisappear { titleVisible = false }
                actions
                    .designSettingsBareRow(EdgeInsets(top: 12, leading: 16, bottom: 4, trailing: 16))
            }
            if let error = model.detailError {
                DesignSettingsSection {
                    DesignSettingsErrorRow(title: "Job action failed", message: error)
                }
            }
            DesignSettingsSection(title: "Prompt") {
                DesignSettingsPromptBox(text: job["prompt"].stringValue)
                    .designSettingsBareRow(EdgeInsets(top: 0, leading: 20, bottom: 12, trailing: 20))
            }
            DesignSettingsSection {
                LabeledContent("Workspace", value: workspaceName)
                LabeledContent("Agent", value: agentText)
                LabeledContent("Thread", value: designScheduleSessionLabel(job["sessionMode"].stringValue))
                LabeledContent("Notify", value: job["notify"].isNull || job["notify"].boolValue ? "When a run finishes" : "Off")
                LabeledContent("Permissions", value: designSchedulePermissionLabel(job["permissionMode"].stringValue))
                LabeledContent("Timeout", value: "\(job["timeoutSeconds"].intValue / 60) min")
                if let zone = job["schedule"]["timezone"].optionalString, !zone.isEmpty {
                    LabeledContent("Time zone", value: zone.replacingOccurrences(of: "_", with: " "))
                }
                LabeledContent("Last run", value: lastRunText)
                if let error = job["lastError"].optionalString, !error.isEmpty {
                    DesignSettingsNote(text: error, tone: .bad)
                        .textSelection(.enabled)
                }
            }
            DesignSettingsSection(title: "Runs", count: runs.isEmpty ? nil : "\(runs.count)") {
                if runs.isEmpty {
                    DesignSettingsNote(text: "No runs yet.")
                }
                ForEach(runs, id: \.id) { run in
                    NavigationLink {
                        NativeScheduledRunScreen(api: model.api, runID: run.id, onOpenConversation: onOpenConversation)
                    } label: { NativeScheduledRunRow(run: run) }
                }
                NavigationLink {
                    NativeActivityScreen(api: model.api, jobID: jobId, jobName: featureNamed(job, fallback: "Job"), onOpenConversation: onOpenConversation)
                } label: {
                    DesignSettingsNavLabel(title: "Full run history", titleColor: tokens.accentText)
                }
            }
        }
        .designSettingsList()
        .designSettingsTitle(featureNamed(job, fallback: "Job"), revealed: !titleVisible)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Edit") { model.beginEdit(job) }
                    .disabled(job.isNull || model.mutating)
            }
        }
        .refreshable { await model.loadDetail(jobId: jobId) }
        .featureBusy(model.mutating)
        .confirmationDialog("Cancel the active run?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel run", role: .destructive) { Task { await model.cancel(jobId: jobId) } }
            Button("Keep running", role: .cancel) {}
        } message: {
            Text("Only this job’s active run is cancelled. Its schedule stays as it is.")
        }
        // A job deleted from the editor, or elsewhere, leaves this screen.
        .onChange(of: model.jobs.contains(where: { $0.id == jobId })) { _, present in
            if !present { dismiss() }
        }
        .task { await model.loadDetail(jobId: jobId) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            DesignSettingsSubtitle(text: designSettingsScheduleText(job["schedule"]), systemImage: "clock")
            Text(featureNamed(job, fallback: "Job"))
                .font(DesignSettingsFont.detailTitle)
                .tracking(-0.52)
                .foregroundStyle(tokens.fg)
                .accessibilityAddTraits(.isHeader)
            DesignSettingsSubtitle(text: designScheduleNextDetail(job))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var actions: some View {
        HStack(spacing: 10) {
            if running {
                MichiSecondaryButton(title: "Cancel run", systemImage: "stop.fill") { confirmCancel = true }
                    .foregroundStyle(tokens.dangerText)
                    .disabled(model.mutating)
            } else {
                MichiPrimaryButton(title: "Run now", systemImage: "play.fill", enabled: !model.mutating && !job.isNull) {
                    Task { await model.runNow(jobId: jobId) }
                }
            }
            MichiSecondaryButton(title: enabled ? "Pause" : "Resume", systemImage: enabled ? "pause" : "play") {
                Task { await model.setEnabled(jobId: jobId, enabled: !enabled) }
            }
            .disabled(model.mutating || job.isNull)
        }
    }

    private var workspaceName: String {
        let id = job["workspaceId"].stringValue
        return model.workspaces.first(where: { $0.id == id }).map(featureWorkspaceName) ?? (id.isEmpty ? "—" : id)
    }

    private var agentText: String {
        guard let runtime = job["runtimeId"].optionalString, !runtime.isEmpty else { return "Default from Settings" }
        return [runtime, job["modelId"].optionalString, job["reasoning"].optionalString]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var lastRunText: String {
        guard let at = job["lastRunAt"].featureOptionalNumber else { return "Never" }
        let status = job["lastStatus"].stringValue
        return designSettingsDayTime(at) + (status.isEmpty ? "" : " · " + designSettingsRunStatusLabel(status))
    }
}

// MARK: - Settings

struct FeatureScheduleSettingsScreen: View {
    @ObservedObject var model: FeatureScheduleModel

    var body: some View {
        List {
            DesignSettingsSection(footer: "New jobs inherit this session mode. Persistent appends to one thread; fresh opens a new thread each run.") {
                DesignSettingsMenuPicker(title: "Default session", selection: $model.sessionMode, options: designSettingsOptions([("persistent", "Persistent thread"), ("fresh", "Fresh thread")], current: model.sessionMode))
                DesignSettingsActionRow(title: "Save") { Task { await model.saveSettings() } }
            }
            if let error = model.settingsError {
                DesignSettingsSection {
                    DesignSettingsErrorRow(title: "Couldn’t save settings", message: error)
                }
            }
        }
        .designSettingsList()
        .designSettingsTitle("Schedule settings")
        .task { await model.loadSettings() }
    }
}

// MARK: - New / edit (ios/Design 25)

struct FeatureScheduleEditorScreen: View {
    @ObservedObject var model: FeatureScheduleModel
    @State var draft: FeatureScheduleDraft
    @State private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens

    private static let modeOptions: [DesignSettingsOption<FeatureScheduleMode>] = [
        DesignSettingsOption(value: .interval, label: "Interval"),
        DesignSettingsOption(value: .daily, label: "Daily"),
        DesignSettingsOption(value: .weekly, label: "Weekly"),
        DesignSettingsOption(value: .once, label: "Once"),
        DesignSettingsOption(value: .cron, label: "Cron")
    ]
    private static let unitOptions: [DesignSettingsOption<FeatureIntervalUnit>] = [
        DesignSettingsOption(value: .minutes, label: "Minutes"),
        DesignSettingsOption(value: .hours, label: "Hours"),
        DesignSettingsOption(value: .days, label: "Days")
    ]
    /// Monday first, as Calendar weekday indices (Sunday = 0).
    private static let weekOrder = [1, 2, 3, 4, 5, 6, 0]

    var body: some View {
        NavigationStack {
            List {
                DesignSettingsSection {
                    TextField("Name", text: $draft.name)
                        .font(MichiFont.row)
                        .foregroundStyle(tokens.fg)
                        .accessibilityLabel("Name")
                    ZStack(alignment: .topLeading) {
                        if draft.prompt.isEmpty {
                            Text("What should Michi do each time it runs?")
                                .font(MichiFont.sans(size: 15, relativeTo: .body))
                                .foregroundStyle(tokens.faint)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                        TextEditor(text: $draft.prompt)
                            .font(MichiFont.sans(size: 15, relativeTo: .body))
                            .foregroundStyle(tokens.fg)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 96)
                            .accessibilityLabel("Prompt")
                    }
                }
                DesignSettingsSection(title: "Schedule") {
                    ViewThatFits(in: .horizontal) {
                        DesignSettingsSegmented(selection: modeBinding, options: Self.modeOptions, accessibilityTitle: "Schedule")
                        DesignSettingsMenuPicker(title: "Repeat", selection: modeBinding, options: Self.modeOptions)
                    }
                    scheduleFields
                    DesignSettingsActionRow(title: "Preview next runs", systemImage: "calendar") { Task { await model.preview(draft) } }
                    if let preview = model.previewResult {
                        if preview["valid"].boolValue {
                            ForEach(Array(preview["nextRuns"].arrayValue.enumerated()), id: \.offset) { _, stamp in
                                Text(previewText(stamp.featureOptionalNumber))
                                    .font(DesignSettingsFont.trail)
                                    .foregroundStyle(tokens.mid)
                            }
                        } else {
                            DesignSettingsNote(text: preview["error"].stringValue, tone: .bad)
                        }
                    }
                }
                DesignSettingsSection(title: "Run") {
                    DesignSettingsMenuPicker(title: "Workspace", selection: $draft.workspaceId, options: workspaceOptions)
                        .disabled(draft.jobId != nil)
                    DesignSettingsMenuPicker(title: "Permissions", selection: $draft.permissionMode, options: designSettingsOptions([("ask", "Ask"), ("trust", "Trust"), ("yolo", "YOLO")], current: draft.permissionMode))
                    DesignSettingsMenuPicker(title: "Thread", selection: $draft.sessionMode, options: designSettingsOptions([("persistent", "Same thread each run"), ("fresh", "New thread each run")], current: draft.sessionMode))
                    DesignSettingsToggle(title: "Notify when done", isOn: $draft.notify)
                    DesignSettingsStepper(title: "Timeout", value: "\(draft.timeoutMinutes) min", count: $draft.timeoutMinutes, range: 1...1440)
                }
                DesignSettingsSection(title: "Agent", footer: "Leave Runtime empty to use the runtime chosen in Settings when the job runs.") {
                    DesignSettingsFieldRow(title: "Runtime", prompt: "Default", text: $draft.runtimeId)
                    if !draft.runtimeId.isEmpty {
                        DesignSettingsFieldRow(title: "Provider", prompt: "Default", text: $draft.providerId)
                        DesignSettingsFieldRow(title: "Model", prompt: "Default", text: $draft.modelId)
                        DesignSettingsFieldRow(title: "Reasoning", prompt: "Default", text: $draft.reasoning)
                    }
                }
                if let error = model.editorError {
                    DesignSettingsSection {
                        DesignSettingsErrorRow(title: "Couldn’t save job", message: error)
                    }
                }
                if draft.jobId != nil {
                    DesignSettingsSection {
                        DesignSettingsActionRow(title: "Delete job", systemImage: "trash", role: .destructive) { confirmDelete = true }
                            .disabled(model.mutating)
                    }
                }
            }
            .designSettingsList(onSheet: true)
            .designSettingsTitle(draft.jobId == nil ? "New job" : "Edit job")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task {
                            if await model.save(draft) { dismiss() }
                        }
                    } label: {
                        Image(systemName: "checkmark")
                    }
                    .designSettingsProminentToolbarButton()
                    .disabled(model.mutating)
                    .accessibilityLabel("Save")
                }
            }
            .featureBusy(model.mutating)
            .confirmationDialog("Delete this job?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task {
                        guard let jobId = draft.jobId else { return }
                        if await model.delete(jobId: jobId) {
                            // The model re-reads the deleted job after the change;
                            // that expected not-found is not a failure to show.
                            model.detailError = nil
                            dismiss()
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Future runs will not start. This cannot be undone.")
            }
        }
        .designSettingsSheetChrome()
    }

    /// Weekdays is Daily with "Weekdays only"; the stored mode is unchanged
    /// until the user picks something else.
    private var modeBinding: Binding<FeatureScheduleMode> {
        Binding(
            get: { draft.mode == .weekdays ? .daily : draft.mode },
            set: { mode in
                if mode == .daily && draft.mode == .weekdays { return }
                draft.mode = mode
            }
        )
    }

    @ViewBuilder private var scheduleFields: some View {
        switch draft.mode {
        case .interval:
            DesignSettingsStepper(title: "Every", value: "\(draft.intervalValue)", count: $draft.intervalValue, range: 1...366)
            DesignSettingsMenuPicker(title: "Unit", selection: $draft.intervalUnit, options: Self.unitOptions)
        case .daily, .weekdays:
            timeRow
            DesignSettingsToggle(title: "Weekdays only", subtitle: "Monday through Friday", isOn: Binding(
                get: { draft.mode == .weekdays },
                set: { draft.mode = $0 ? .weekdays : .daily }
            ))
            timeZoneRow
        case .weekly:
            daysRow
            timeRow
            timeZoneRow
        case .once:
            DatePicker(selection: $draft.onceAt) {
                Text("Run at").font(MichiFont.row).foregroundStyle(tokens.fg)
            }
            .tint(tokens.accent)
        case .cron:
            DesignSettingsFieldRow(title: "Expression", prompt: "0 9 * * 1-5", text: $draft.cron)
            timeZoneRow
        }
    }

    private var timeRow: some View {
        DatePicker(selection: $draft.timeOfDay, displayedComponents: .hourAndMinute) {
            Text("Time").font(MichiFont.row).foregroundStyle(tokens.fg)
        }
        .tint(tokens.accent)
    }

    private var timeZoneRow: some View {
        NavigationLink {
            DesignSettingsTimeZoneList(selection: $draft.timezone)
        } label: {
            DesignSettingsNavLabel(title: "Time zone", trail: draft.timezone.replacingOccurrences(of: "_", with: " "))
        }
    }

    private var daysRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Days").font(MichiFont.row).foregroundStyle(tokens.fg)
            HStack(spacing: 0) {
                ForEach(Array(Self.weekOrder.enumerated()), id: \.offset) { index, day in
                    if index > 0 { Spacer(minLength: 4) }
                    dayButton(day)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Days")
    }

    private func dayButton(_ day: Int) -> some View {
        let on = draft.weekdays.contains(day)
        return Button {
            if on { draft.weekdays.remove(day) } else { draft.weekdays.insert(day) }
        } label: {
            Text(Calendar.current.veryShortWeekdaySymbols[day])
                .font(MichiFont.mono(size: 13, relativeTo: .footnote, weight: .semibold))
                .minimumScaleFactor(0.6)
                .foregroundStyle(on ? tokens.accentInk : tokens.mid)
                .frame(width: 44, height: 44)
                .background(on ? tokens.accent : tokens.bgDeep, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay {
                    if !on { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1) }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Calendar.current.weekdaySymbols[day])
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }

    private var workspaceOptions: [DesignSettingsOption<String>] {
        var options = model.workspaces.map { DesignSettingsOption(value: $0.id, label: featureWorkspaceName($0)) }
        if !options.contains(where: { $0.value == draft.workspaceId }) {
            options.append(DesignSettingsOption(value: draft.workspaceId, label: draft.workspaceId.isEmpty ? "Choose a workspace" : draft.workspaceId))
        }
        return options
    }

    /// Time-of-day schedules are evaluated in the chosen zone, so their
    /// preview is shown in it too.
    private func previewText(_ millis: Double?) -> String {
        guard let date = featureDate(millis) else { return "—" }
        let zoned: [FeatureScheduleMode] = [.daily, .weekdays, .weekly, .cron]
        let zone = zoned.contains(draft.mode) ? (TimeZone(identifier: draft.timezone) ?? .current) : .current
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: zone))
    }
}

// MARK: - Formatting

/// "Every day at 8:00 AM · Next tomorrow"
private func designScheduleSummaryLine(_ job: JSONValue) -> String {
    designSettingsScheduleText(job["schedule"]) + " · " + designScheduleNextShort(job)
}

private func designScheduleNextShort(_ job: JSONValue) -> String {
    if job["activeRunId"].optionalString != nil { return "Running now" }
    if !job["enabled"].boolValue { return job["autoPaused"].boolValue ? "Auto-paused" : "Paused" }
    guard let date = featureDate(job["nextRunAt"].featureOptionalNumber) else { return "No next run" }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "Next at " + date.formatted(date: .omitted, time: .shortened) }
    if calendar.isDateInTomorrow(date) { return "Next tomorrow" }
    return "Next " + date.formatted(.dateTime.month(.abbreviated).day())
}

/// "Next run tomorrow 8:00 AM · in 22h"
private func designScheduleNextDetail(_ job: JSONValue) -> String {
    if job["activeRunId"].optionalString != nil { return "Running now" }
    if !job["enabled"].boolValue { return job["autoPaused"].boolValue ? "Paused after repeated failures" : "Paused" }
    guard let date = featureDate(job["nextRunAt"].featureOptionalNumber) else { return "No next run scheduled" }
    let when = designSettingsDayTime(featureMillis(date))
    let relative = date.formatted(.relative(presentation: .numeric, unitsStyle: .narrow))
    return "Next run \(when.prefix(1).lowercased() + when.dropFirst()) · \(relative)"
}

private func designScheduleJobStatus(_ job: JSONValue) -> (text: String, tone: DesignSettingsTone)? {
    if job["activeRunId"].optionalString != nil { return ("Running", .run) }
    if job["autoPaused"].boolValue { return ("Paused after repeated failures", .bad) }
    let status = job["lastStatus"].stringValue
    let when = featureRelative(job["lastRunAt"].featureOptionalNumber)
    switch status {
    case "succeeded":
        return ("Succeeded \(when)", .ok)
    case "failed", "timed_out", "interrupted":
        if let error = job["lastError"].optionalString, !error.isEmpty {
            return ("\(designSettingsRunStatusLabel(status)): \(error)", .bad)
        }
        return ("\(designSettingsRunStatusLabel(status)) \(when)", .bad)
    case "cancelled":
        return ("Cancelled \(when)", .muted)
    case "running":
        return ("Running", .run)
    default:
        return nil
    }
}

private func designScheduleSessionLabel(_ mode: String) -> String {
    switch mode {
    case "fresh": return "New thread each run"
    case "persistent": return "Same thread each run"
    case "": return "—"
    default: return mode
    }
}

private func designSchedulePermissionLabel(_ mode: String) -> String {
    switch mode {
    case "ask": return "Ask"
    case "trust": return "Trust"
    case "yolo": return "YOLO"
    case "": return "—"
    default: return mode
    }
}
