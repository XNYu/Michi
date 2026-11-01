import SwiftUI
import UniformTypeIdentifiers
import MichiCore

/// Global chat permission defaults. GET/PUT /permissions/settings; nothing is written until Save.
struct PermissionsSettingsScreen: View {
    let api: MichiAPI

    @StateObject private var model: FeaturePermissionsSettingsModel

    init(api: MichiAPI) {
        self.api = api
        _model = StateObject(wrappedValue: FeaturePermissionsSettingsModel(api: api))
    }

    var body: some View {
            Group {
                if !model.ready {
                    if let error = model.error {
                        List {
                            DesignSettingsSection {
                                DesignSettingsErrorRow(title: "Couldn’t load permission settings", message: error, retry: { Task { await model.reload() } })
                            }
                        }
                        .designSettingsList()
                    } else {
                        DesignSettingsLoading(message: "Reading permission settings")
                    }
                } else {
                    List {
                        if let error = model.error {
                            DesignSettingsSection {
                                DesignSettingsErrorRow(title: "Update failed", message: error, retry: { Task { await model.reload() } })
                            }
                        }
                        DesignSettingsSection {
                            DesignSettingsToggle(
                                title: "Use global permissions",
                                subtitle: model.draft.global
                                    ? "One permission mode for all chats. Permission controls are hidden in the Composer."
                                    : "Set permissions separately in each chat’s Composer. New chats start in Ask.",
                                isOn: $model.draft.global
                            )
                        }
                        DesignSettingsSection(title: "Mode") {
                            DesignSettingsSegmented(selection: $model.draft.mode, options: modeOptions, accessibilityTitle: "Permission mode")
                            if model.draft.mode == "ask" && model.supportsApproveForMe {
                                DesignSettingsToggle(title: "Approve for me", isOn: $model.draft.approveForMe)
                            }
                            DesignSettingsNote(text: featurePermissionModeCopy(model.draft, approveRuntimeIds: model.approveRuntimeIds))
                        }
                        DesignSettingsSection {
                            DesignSettingsNote(text: featurePermissionFooter(
                                supportsYolo: model.supportsYolo,
                                approveRuntimeIds: model.approveRuntimeIds,
                                claudeAvailable: model.claudeAvailable
                            ))
                        }
                        DesignSettingsSection(footer: "Settings are read first. Nothing is written until you save.") {
                            DesignSettingsActionRow(title: model.saving ? "Saving…" : "Save", busy: model.saving) { Task { await model.save() } }
                                .disabled(!model.dirty || model.saving)
                        }
                    }
                    .designSettingsList()
                }
            }
            .designSettingsTitle("Permissions")
            .refreshable { await model.reload() }
            .featureBusy(model.saving)
            .onChange(of: model.draft.mode) { _, mode in
                if mode != "ask" { model.draft.approveForMe = false }
            }
            .task { await model.reload() }

    }

    private var modeOptions: [DesignSettingsOption<String>] {
        var options = [DesignSettingsOption(value: "ask", label: "Ask"), DesignSettingsOption(value: "trust", label: "Trust")]
        if model.supportsYolo { options.append(DesignSettingsOption(value: "yolo", label: "YOLO")) }
        return options
    }
}

/// Meta agent runtime, reading, writing, and tool-approval settings. GET /meta-agent, PUT /meta-agent/settings.
struct MetaAgentSettingsScreen: View {
    let api: MichiAPI

    @StateObject private var model: FeatureMetaAgentSettingsModel
    @State private var confirmRetry = false
    @Environment(\.michiTokens) private var tokens

    init(api: MichiAPI) {
        self.api = api
        _model = StateObject(wrappedValue: FeatureMetaAgentSettingsModel(api: api))
    }

    var body: some View {
            Group {
                if !model.ready {
                    if let error = model.error {
                        List {
                            DesignSettingsSection {
                                DesignSettingsErrorRow(title: "Couldn’t load the Meta agent", message: error, retry: { Task { await model.reload() } })
                            }
                        }
                        .designSettingsList()
                    } else {
                        DesignSettingsLoading(message: "Loading the Meta agent")
                    }
                } else if model.unavailable {
                    ContentUnavailableView(
                        "Meta agent unavailable",
                        systemImage: "sparkles",
                        description: Text("This Michi backend does not run the Meta agent yet. Its settings appear here once it does.")
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(tokens.bg)
                } else {
                    List {
                        if let error = model.error {
                            DesignSettingsSection {
                                DesignSettingsErrorRow(title: "Update failed", message: error, retry: { Task { await model.reload() } })
                            }
                        }
                        DesignSettingsSection {
                            DesignSettingsNote(text: "Reads conversations in all your workspaces, keeps every home page up to date, and answers questions and edits pages in Pages.")
                            NavigationLink { MetaMaintenanceScreen(api: api) } label: {
                                DesignSettingsNavLabel(title: "Background activity", systemImage: "chart.bar", subtitle: "Checks, writes and recent runs")
                            }
                        }
                        if !model.toolApprovals.isEmpty {
                            toolApprovals
                        }
                        if !model.failures.isEmpty {
                            guardSection
                        }
                        runtimeSection
                        readingSection
                        writingSection
                        usageSection
                        DesignSettingsSection(footer: "Omitted settings keep their value. Null runtime fields follow the global settings.") {
                            DesignSettingsActionRow(title: model.saving ? "Saving…" : "Save", busy: model.saving) { Task { await model.save() } }
                                .disabled(!model.dirty || model.saving)
                        }
                    }
                    .designSettingsList()
                }
            }
            .designSettingsTitle("Meta agent")
            .refreshable { await model.reload() }
            .featureBusy(model.saving)
            .confirmationDialog("Retry the Meta agent?", isPresented: $confirmRetry, titleVisibility: .visible) {
                Button("Retry now") { Task { await model.retryGuard() } }
            } message: {
                Text("Retrying a failed maintenance check starts a maintenance run immediately. Pages can change as that work runs.")
            }
            .task { await model.reload() }

    }

    private var toolApprovals: some View {
        DesignSettingsSection(title: "Tool approvals", footer: "Approve a tool for future background runs, including external changes it supports, with any valid arguments. Approval lasts until revoked or its definition or connection configuration changes.") {
            ForEach(model.toolApprovals, id: \.id) { request in
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(request["server"].stringValue) / \(request["tool"].stringValue)")
                        .font(MichiFont.mono(size: 13, relativeTo: .footnote, weight: .semibold))
                    if !request["description"].stringValue.isEmpty {
                        DesignSettingsNote(text: request["description"].stringValue, tone: .plain)
                    }
                    DesignSettingsStatusLine(
                        text: request["state"].stringValue == "pending" ? "Needs your approval; not executed" : request["state"].stringValue,
                        tone: request["state"].stringValue == "pending" ? .accent : request["state"].stringValue == "approved" ? .ok : .muted
                    )
                    if request["state"].stringValue != "approved" {
                        DesignSettingsActionRow(title: "Always allow this tool") {
                            Task { await model.decideToolApproval(id: request.id, state: "approved") }
                        }
                        .disabled(model.saving || request.id.isEmpty)
                    }
                    if request["state"].stringValue == "pending" {
                        DesignSettingsActionRow(title: "Deny", role: .destructive) {
                            Task { await model.decideToolApproval(id: request.id, state: "denied") }
                        }
                        .disabled(model.saving || request.id.isEmpty)
                    }
                    if request["state"].stringValue == "approved" {
                        DesignSettingsActionRow(title: "Revoke", role: .destructive) {
                            Task { await model.decideToolApproval(id: request.id, state: "revoked") }
                        }
                        .disabled(model.saving || request.id.isEmpty)
                    }
                }
            }
        }
    }

    private var guardSection: some View {
        DesignSettingsSection(title: "Restriction check") {
            let tools = Array(Set(model.failures.flatMap { featureStringList($0["unexpectedTools"]) })).sorted()
            let runtimes = Array(Set(model.failures.map { featureMetaAgentRuntimeLabel($0["runtimeId"].stringValue) })).sorted()
            DesignSettingsStatusLine(
                text: tools.isEmpty
                    ? "Meta agent stopped: \(runtimes.joined(separator: ", ")) did not pass its tool check"
                    : "Meta agent stopped: \(runtimes.joined(separator: ", ")) started with extra tools",
                tone: .bad
            )
            if !tools.isEmpty {
                DesignSettingsNote(text: "Extra tools: \(tools.joined(separator: ", ")).", tone: .plain)
            }
            DesignSettingsNote(text: "The Meta agent may only read threads and edit pages, so it did not run and pages won’t update.")
            ForEach(Array(model.failures.enumerated()), id: \.offset) { _, failure in
                LabeledContent(failure["toolset"].stringValue == "chat" ? "Chat window" : "Background maintenance") {
                    Text(featureMetaAgentRuntimeLabel(failure["runtimeId"].stringValue))
                }
                if let detail = failure["detail"].optionalString, !detail.isEmpty {
                    DesignSettingsNote(text: detail)
                }
            }
            DesignSettingsActionRow(title: "Retry", systemImage: "arrow.clockwise") { confirmRetry = true }
                .disabled(model.saving)
        }
    }

    private var runtimeSection: some View {
        DesignSettingsSection(title: "Runtime") {
            if model.availability["available"].featureOptionalBool == false {
                DesignSettingsNote(
                    text: model.availability["reason"].optionalString
                        ?? "The Meta agent cannot run on \(featureMetaAgentRuntimeLabel(model.resolved["runtimeId"].stringValue)).",
                    tone: .bad
                )
                if model.draft.followGlobal {
                    DesignSettingsActionRow(title: "Use a custom runtime") { model.chooseCustom() }
                }
            }
            DesignSettingsMenuPicker(title: "Source", selection: followGlobalBinding, options: [
                DesignSettingsOption(value: true, label: "Follow global settings"),
                DesignSettingsOption(value: false, label: "Custom")
            ])
            DesignSettingsNote(text: model.draft.followGlobal
                ? "Uses Settings › Runtime (global). Change the global settings and the Meta agent follows from its next run."
                : "Only for background maintenance. Assistant chat and new conversations use the global settings.")
            if !model.draft.followGlobal {
                DesignSettingsMenuPicker(title: "Runtime", selection: runtimeBinding, options: runtimeOptions)
                if model.providers.count > 1 || model.draft.providerId != nil {
                    DesignSettingsMenuPicker(title: "Provider", selection: providerBinding, options: optionalOptions(model.providers, current: model.draft.providerId))
                }
                if !model.models.isEmpty || model.draft.modelId != nil {
                    DesignSettingsMenuPicker(title: "Model", selection: modelBinding, options: optionalOptions(model.models, current: model.draft.modelId))
                }
                if model.capabilities["reasoning"].boolValue || model.draft.reasoning != nil {
                    DesignSettingsMenuPicker(title: "Reasoning", selection: reasoningBinding, options: reasoningOptions)
                }
                DesignSettingsNote(text: "Pi runs inside Michi and calls an AI provider directly with your own key, so there is nothing to install.")
            }
            let resolved = model.resolved
            DesignSettingsNote(text: featureResolvedRuntimeCopy(resolved))
        }
    }

    private var readingSection: some View {
        DesignSettingsSection(title: "Reading") {
            DesignSettingsMenuPicker(title: "First run", selection: $model.draft.firstRunDays, options: firstRunOptions)
            DesignSettingsNote(text: "Last \(model.draft.firstRunDays) days of conversations, up to 1,000")
            VStack(alignment: .leading, spacing: 2) {
                Text("Never read").foregroundStyle(tokens.fg)
                DesignSettingsNote(text: "Scheduled-job output, the Meta agent’s own chat, and archived or deleted conversations")
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var writingSection: some View {
        DesignSettingsSection(title: "Writing") {
            DesignSettingsToggle(title: "Workspace homes", subtitle: "Keeps each workspace’s home page up to date", isOn: $model.draft.writeWorkspaceHomes)
            DesignSettingsToggle(title: "Pages home", subtitle: "Keeps the overview on the Pages Home up to date from the workspace homes", isOn: $model.draft.maintainSpacesHome)
            VStack(alignment: .leading, spacing: 2) {
                Text("Blocks you edited").foregroundStyle(tokens.fg)
                DesignSettingsNote(text: "Never overwritten: the Meta agent suggests a change and you accept it")
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var usageSection: some View {
        DesignSettingsSection(title: "Usage") {
            DesignSettingsNote(text: featureMetaAgentUsageText(model.info["usageToday"]), tone: .plain)
        }
    }

    private var runtimeOptions: [DesignSettingsOption<String>] {
        var options = featureMetaAgentRuntimes.map { DesignSettingsOption(value: $0, label: featureRuntimeChoiceLabel($0, model: model)) }
        if !featureMetaAgentRuntimes.contains(model.draft.runtimeId) {
            options.append(DesignSettingsOption(value: model.draft.runtimeId, label: model.draft.runtimeId.isEmpty ? "None" : "Current: " + model.draft.runtimeId))
        }
        return options
    }

    private func optionalOptions(_ items: [JSONValue], current: String?) -> [DesignSettingsOption<String?>] {
        var options = [DesignSettingsOption<String?>(value: nil, label: "Default")]
        options += items.map { DesignSettingsOption<String?>(value: $0.id, label: $0["label"].optionalString ?? $0.id) }
        if let current, !items.contains(where: { $0.id == current }) {
            options.append(DesignSettingsOption<String?>(value: current, label: "Current: " + current))
        }
        return options
    }

    private var reasoningOptions: [DesignSettingsOption<String?>] {
        var options = [DesignSettingsOption<String?>(value: nil, label: "Default")]
        options += model.reasoningLevels.map { DesignSettingsOption<String?>(value: $0, label: $0) }
        if let current = model.draft.reasoning, !model.reasoningLevels.contains(current) {
            options.append(DesignSettingsOption<String?>(value: current, label: "Current: " + current))
        }
        return options
    }

    private var firstRunOptions: [DesignSettingsOption<Int>] {
        var options = featureMetaAgentFirstRunDays.map { DesignSettingsOption(value: $0, label: "\($0) days") }
        if !featureMetaAgentFirstRunDays.contains(model.draft.firstRunDays) {
            options.append(DesignSettingsOption(value: model.draft.firstRunDays, label: "\(model.draft.firstRunDays) days"))
        }
        return options
    }

    private var runtimeBinding: Binding<String> {
        Binding(
            get: { model.draft.runtimeId },
            set: { model.selectRuntime($0) }
        )
    }

    private var followGlobalBinding: Binding<Bool> {
        Binding(
            get: { model.draft.followGlobal },
            set: { follow in
                if follow { model.chooseFollowGlobal() } else { model.chooseCustom() }
            }
        )
    }

    private var providerBinding: Binding<String?> {
        Binding(get: { model.draft.providerId }, set: { model.draft.providerId = $0 })
    }

    private var modelBinding: Binding<String?> {
        Binding(get: { model.draft.modelId }, set: { model.draft.modelId = $0 })
    }

    private var reasoningBinding: Binding<String?> {
        Binding(get: { model.draft.reasoning }, set: { model.draft.reasoning = $0 })
    }
}

/// Portable backup export/import. GET /backup/export, POST /backup/import?mode=merge.
struct BackupSettingsScreen: View {
    let api: MichiAPI

    @StateObject private var model: FeatureBackupSettingsModel
    @State private var importing = false
    @State private var confirmImport = false

    init(api: MichiAPI) {
        self.api = api
        _model = StateObject(wrappedValue: FeatureBackupSettingsModel(api: api))
    }

    var body: some View {
            List {
                DesignSettingsSection(footer: "Pages, databases, attachments, scheduled jobs, and credentials are not included.") {
                    DesignSettingsNote(text: "Export workspaces, conversations and Agent data from this server as a JSON file.", tone: .plain)
                }
                DesignSettingsSection {
                    DesignSettingsActionRow(title: "Export backup", systemImage: "square.and.arrow.up", busy: model.busy) { Task { await model.exportBackup() } }
                        .disabled(model.busy)
                    DesignSettingsActionRow(title: "Choose backup…", systemImage: "doc.badge.arrow.up") { importing = true }
                        .disabled(model.busy || model.restoredCount != nil)
                }
                if let pending = model.pending, model.canRestore {
                    DesignSettingsSection(title: "Ready to restore", footer: "Restore creates new copies. Existing workspaces are kept. Importing the same backup again creates duplicates.") {
                        LabeledContent("File", value: model.pendingName)
                        LabeledContent("Schema", value: "Michi portable backup")
                        LabeledContent("Version", value: "\(pending.version)")
                        LabeledContent("Exported", value: featureFormatDate(pending.exportedAt))
                        LabeledContent("Workspaces", value: "\(pending.workspaceCount)")
                        LabeledContent("Messages", value: "\(pending.messageCount)")
                        DesignSettingsActionRow(title: "Restore backup", systemImage: "arrow.down.doc") { confirmImport = true }
                            .disabled(model.busy)
                        DesignSettingsActionRow(title: "Cancel", role: .cancel) { model.cancelPending() }
                            .disabled(model.busy)
                    }
                }
                if let count = model.restoredCount {
                    DesignSettingsSection {
                        DesignSettingsStatusLine(text: "Restored \(count) workspace(s). Reload when you are ready to open them.", tone: .ok)
                    }
                }
                if let notice = model.notice, model.restoredCount == nil {
                    DesignSettingsSection { DesignSettingsNote(text: notice, tone: .plain) }
                }
                if let error = model.error {
                    DesignSettingsSection {
                        DesignSettingsErrorRow(title: "Backup failed", message: error)
                    }
                }
            }
            .designSettingsList()
            .designSettingsTitle("Backup & restore")
            .featureBusy(model.busy)
            .fileExporter(
                isPresented: $model.presentExporter,
                document: FeatureBackupFileDocument(data: model.exportData ?? Data()),
                contentType: .json,
                defaultFilename: model.exportFilename
            ) { result in
                if case .failure(let error) = result {
                    model.error = error.localizedDescription
                } else if model.error == nil {
                    model.notice = "Backup saved."
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
                switch result {
                case .success(let urls):
                    guard let url = urls.first else { return }
                    Task { await importFile(url) }
                case .failure(let error):
                    model.error = error.localizedDescription
                }
            }
            .confirmationDialog("Restore this backup?", isPresented: $confirmImport, titleVisibility: .visible) {
                Button("Restore backup") { Task { await model.confirmImport() } }
            } message: {
                if let pending = model.pending {
                    Text("Import \(pending.workspaceCount) workspace(s) and \(pending.messageCount) message(s) from this Michi v\(pending.version) backup. Existing workspaces stay; a second import creates duplicates.")
                }
            }

    }

    private func importFile(_ url: URL) async {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        do {
            let bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            if let error = featureBackupSizeError(byteCount: bytes) { throw error }
            let data = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: url, options: .mappedIfSafe) }.value
            try model.reviewImport(data: data, name: url.lastPathComponent)
        } catch {
            model.error = featureErrorMessage(error)
        }
    }
}

struct FeatureBackupFileDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    static var writableContentTypes: [UTType] { [.json] }

    var data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

private func featurePermissionModeCopy(_ draft: FeaturePermissionDraft, approveRuntimeIds: [String]) -> String {
    if draft.mode == "ask" && draft.approveForMe {
        let extra = approveRuntimeIds.isEmpty ? "" : " Other runtimes use Ask."
        return "Kiro approves routine work, blocks risky actions and asks when unsure. Workspace edits and read-only shell run automatically.\(extra)"
    }
    switch draft.mode {
    case "trust":
        return "Approve tool requests automatically. Keep the runtime’s existing sandbox."
    case "yolo":
        return "Approve tools automatically and use full access where the runtime supports it."
    default:
        return "Ask before changes and tools that require approval. Read-only tools may run automatically."
    }
}

private func featurePermissionFooter(supportsYolo: Bool, approveRuntimeIds: [String], claudeAvailable: Bool) -> String {
    var text = supportsYolo
        ? "Changes apply to the next turn. Trust keeps native sandbox limits; YOLO uses full access where supported. Kiro, Crew and Pi use Trust for YOLO. Agent Runs use their own permissions."
        : "Changes apply to the next turn. Ask requests approval; Trust approves tools automatically. Agent Runs use their own permissions."
    if !approveRuntimeIds.isEmpty {
        text += " Approve for me lets Kiro V3 approve routine work and ask when unsure; other runtimes use Ask."
    }
    if claudeAvailable && supportsYolo {
        text += " Moving a Claude chat into or out of YOLO restarts it on its next message, which stops any workflow it is running."
    }
    return text
}

@MainActor
private func featureRuntimeChoiceLabel(_ id: String, model: FeatureMetaAgentSettingsModel) -> String {
    let label = featureMetaAgentRuntimeLabel(id)
    if !featureMetaAgentRuntimeSupported(id) { return "\(label) (not supported yet)" }
    if !model.runtimeAvailable(id) && id != model.draft.runtimeId { return "\(label) (unavailable)" }
    return label
}

private func featureResolvedRuntimeCopy(_ resolved: JSONValue) -> String {
    let runtime = featureMetaAgentRuntimeLabel(resolved["runtimeId"].stringValue)
    let model = resolved["modelId"].optionalString ?? "default model"
    let reasoning = resolved["reasoning"].optionalString.map { "reasoning \($0)" }
    let source = resolved["followsGlobal"].boolValue ? "follows global" : "custom"
    let parts = [runtime, model, reasoning].compactMap { $0 }
    let profile = parts.joined(separator: " · ")
    let restriction = featureMetaAgentRestriction(resolved["runtimeId"].stringValue)
    var text = "Now using \(profile) (\(source))"
    if let restriction { text += ". Background maintenance: \(restriction)." }
    else { text += "." }
    text += " Background maintenance can change Michi content and use external read-only tools. Other external tools need your saved approval."
    return text
}
