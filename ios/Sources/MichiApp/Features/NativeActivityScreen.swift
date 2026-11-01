import SwiftUI
import MichiCore

/// Uses the ordinary run history endpoint. Browser notices are transient;
/// this view does not consume the Electron-only pending-delivery feed.
struct NativeActivityScreen: View {
    @StateObject private var model: NativeRunHistoryModel
    let jobName: String
    let onOpenConversation: (NativeRunConversationTarget) -> Void
    init(api: MichiAPI, jobID: String, jobName: String, onOpenConversation: @escaping (NativeRunConversationTarget) -> Void) {
        _model = StateObject(wrappedValue: NativeRunHistoryModel(api: api, jobID: jobID))
        self.jobName = jobName; self.onOpenConversation = onOpenConversation
    }
    var body: some View {
        List {
            if let error = model.error {
                DesignSettingsSection {
                    DesignSettingsErrorRow(title: "Run history unavailable", message: error, retry: { Task { await model.reload() } })
                }
            }
            if model.runs.isEmpty && model.loaded {
                Section {
                    ContentUnavailableView("No runs yet", systemImage: "clock", description: Text("Completed and active executions appear here."))
                        .designSettingsBareRow(EdgeInsets(top: 40, leading: 20, bottom: 20, trailing: 20))
                }
            }
            ForEach(designSettingsDayGroups(model.runs, date: { $0["startedAt"].featureOptionalNumber })) { group in
                DesignSettingsSection(title: group.title, count: "\(group.items.count)") {
                    ForEach(group.items, id: \.id) { run in
                        NavigationLink {
                            NativeScheduledRunScreen(api: model.api, runID: run.id, onOpenConversation: onOpenConversation)
                        } label: { NativeScheduledRunRow(run: run) }
                    }
                }
            }
        }
        .designSettingsList()
        .designSettingsTitle(jobName.isEmpty ? "Run history" : jobName)
        .overlay { if model.loading && !model.loaded { DesignSettingsLoading(message: "Loading runs…") } }
        .refreshable { await model.reload() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.loading)
                    .accessibilityLabel("Refresh run history")
            }
        }
        .task { await model.reload() }
    }
}

/// One scheduled execution: status glyph, when it started, and its outcome
/// ("Succeeded · 2m 14s", "Failed · runtime timed out").
struct NativeScheduledRunRow: View {
    let run: JSONValue
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            MichiThreadStateDot(state: state)
                .frame(width: 14, height: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(designSettingsDayTime(run["startedAt"].featureOptionalNumber))
                    .font(MichiFont.row)
                    .foregroundStyle(tokens.fg)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Text(detail)
                    .font(DesignSettingsFont.note)
                    .foregroundStyle(tokens.muted)
                    .lineLimit(3)
                if !run["summary"].stringValue.isEmpty {
                    Text(run["summary"].stringValue)
                        .font(DesignSettingsFont.note)
                        .foregroundStyle(tokens.mid)
                        .lineLimit(2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var status: String { run["status"].stringValue }

    private var state: MichiThreadState {
        switch status {
        case "succeeded": return .done
        case "running": return .streaming
        case "cancelled": return .idle
        default: return .failed
        }
    }

    private var detail: String {
        var parts = [designSettingsRunStatusLabel(status)]
        if !run["error"].stringValue.isEmpty { parts.append(run["error"].stringValue) }
        else if let duration = NativeScheduledRunContract.duration(run) { parts.append(duration) }
        if run["trigger"].stringValue == "manual" { parts.append("run now") }
        return parts.joined(separator: " · ")
    }
}

struct NativeScheduledRunScreen: View {
    @StateObject private var model: NativeScheduledRunModel
    let onOpenConversation: (NativeRunConversationTarget) -> Void
    init(api: MichiAPI, runID: String, onOpenConversation: @escaping (NativeRunConversationTarget) -> Void) {
        _model = StateObject(wrappedValue: NativeScheduledRunModel(api: api, runID: runID))
        self.onOpenConversation = onOpenConversation
    }
    var body: some View {
        List {
            if let error = model.error {
                DesignSettingsSection {
                    DesignSettingsErrorRow(title: "Run unavailable", message: error, retry: { Task { await model.reload() } })
                }
            }
            if model.loaded {
                DesignSettingsSection(title: "Execution") {
                    LabeledContent("Status", value: designSettingsRunStatusLabel(model.run["status"].stringValue))
                    LabeledContent("Trigger", value: model.run["trigger"].stringValue.capitalized)
                    LabeledContent("Started", value: featureFormatDate(model.run["startedAt"].featureOptionalNumber))
                    if !model.run["scheduledFor"].isNull { LabeledContent("Scheduled for", value: featureFormatDate(model.run["scheduledFor"].featureOptionalNumber)) }
                    if !model.run["finishedAt"].isNull { LabeledContent("Finished", value: featureFormatDate(model.run["finishedAt"].featureOptionalNumber)) }
                    if let duration = NativeScheduledRunContract.duration(model.run) { LabeledContent("Duration", value: duration) }
                }
                DesignSettingsSection(footer: model.hasConversation ? nil : "This execution has not created a conversation.") {
                    DesignSettingsActionRow(title: model.opening ? "Opening conversation…" : "Open conversation", systemImage: "bubble.left.and.bubble.right", busy: model.opening) {
                        Task { if let target = await model.conversationTarget() { onOpenConversation(target) } }
                    }
                    .disabled(!model.hasConversation || model.opening || model.loading)
                }
                if !model.run["summary"].stringValue.isEmpty {
                    DesignSettingsSection(title: "Summary") { NativeMarkdown(text: model.run["summary"].stringValue) }
                }
                if !model.run["error"].stringValue.isEmpty {
                    DesignSettingsSection(title: "Run error") {
                        DesignSettingsNote(text: model.run["error"].stringValue, tone: .bad)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .designSettingsList()
        .designSettingsTitle("Scheduled run")
        .overlay { if model.loading && !model.loaded { DesignSettingsLoading(message: "Loading run…") } }
        .refreshable { await model.reload() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.loading || model.opening)
                    .accessibilityLabel("Refresh run")
            }
        }
        .task { await model.reload() }
    }
}
