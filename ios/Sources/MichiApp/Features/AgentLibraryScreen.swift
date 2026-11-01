import SwiftUI
import MichiCore

/// Custom agent library. Owns its NavigationStack for TabView/sheet placement;
/// the same rows are the Library tab of Agents (AgentRunsScreen).
struct AgentLibraryScreen: View {
    let api: MichiAPI

    @StateObject private var model: FeatureAgentLibraryModel
    @State private var query = ""

    init(api: MichiAPI) {
        self.api = api
        _model = StateObject(wrappedValue: FeatureAgentLibraryModel(api: api))
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.loading && model.agents.isEmpty {
                    DesignSettingsLoading(message: "Loading agents")
                } else {
                    List { AgentLibraryRows(model: model, query: query) }
                        .designSettingsList()
                }
            }
            .designSettingsTitle("Agents")
            .searchable(text: $query, prompt: "Agent name")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.beginCreate()
                    } label: {
                        Label("New agent", systemImage: "plus")
                    }
                    .designSettingsProminentToolbarButton()
                    .disabled(model.customAgentsEnabled == false)
                }
            }
            .refreshable { await model.refresh() }
            .sheet(item: $model.createDraft) { draft in
                NavigationStack {
                    FeatureAgentEditorForm(model: model, draft: draft, isNew: true)
                }
                .designSettingsSheetChrome()
            }
            .task { await model.refresh() }
        }
    }
}

/// Library sections: status, then agents filtered by `query`.
struct AgentLibraryRows: View {
    @ObservedObject var model: FeatureAgentLibraryModel
    var query = ""

    private var agents: [JSONValue] {
        guard !query.isEmpty else { return model.agents }
        return model.agents.filter {
            featureNamed($0, fallback: "").localizedCaseInsensitiveContains(query) || $0["description"].stringValue.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        if let error = model.error {
            DesignSettingsSection {
                DesignSettingsErrorRow(title: model.agents.isEmpty ? "Couldn’t load agents" : "Refresh failed", message: error, retry: { Task { await model.refresh() } })
            }
        }
        if model.customAgentsEnabled == false {
            DesignSettingsSection {
                DesignSettingsStatusLine(text: "Custom agents are disabled on this backend.", tone: .warn)
            }
        }
        if model.loading && model.agents.isEmpty {
            Section { DesignSettingsLoading(message: "Loading agents", inline: true).designSettingsBareRow() }
        } else {
            DesignSettingsSection(title: "Agents", count: model.agents.isEmpty ? nil : "\(model.agents.count)") {
                if agents.isEmpty {
                    DesignSettingsNote(text: model.agents.isEmpty ? "No custom agents." : "No agents match “\(query)”.")
                }
                ForEach(agents, id: \.id) { agent in
                    NavigationLink {
                        FeatureAgentEditorScreen(model: model, agentId: agent.id)
                    } label: {
                        FeatureAgentRow(agent: agent)
                    }
                }
            }
        }
    }
}

private struct FeatureAgentRow: View {
    let agent: JSONValue
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(featureNamed(agent, fallback: "Untitled agent"))
                    .font(MichiFont.row)
                    .foregroundStyle(tokens.fg)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Spacer(minLength: 8)
                if !agent["status"].stringValue.isEmpty {
                    MichiTag(text: agent["status"].stringValue, kind: agent["status"].stringValue == "enabled" ? .ok : .plain)
                }
            }
            if !agent["description"].stringValue.isEmpty {
                Text(agent["description"].stringValue)
                    .font(DesignSettingsFont.note)
                    .foregroundStyle(tokens.muted)
                    .lineLimit(2)
            }
            HStack(spacing: 10) {
                Label(agent["scope"].stringValue, systemImage: agent["scope"].stringValue == "global" ? "globe" : "folder")
                if !agent["runtimeProfile"]["runtimeId"].stringValue.isEmpty {
                    Label(agent["runtimeProfile"]["runtimeId"].stringValue, systemImage: "cpu")
                }
            }
            .font(MichiFont.meta)
            .foregroundStyle(tokens.faint)
        }
        .accessibilityElement(children: .combine)
    }
}

struct FeatureAgentEditorScreen: View {
    @ObservedObject var model: FeatureAgentLibraryModel
    let agentId: String

    var body: some View {
        Group {
            if let draft = model.editDraft, draft.id == agentId {
                FeatureAgentEditorForm(model: model, draft: draft, isNew: false)
            } else if let error = model.detailError {
                List {
                    DesignSettingsSection {
                        DesignSettingsErrorRow(title: "Couldn’t load agent", message: error, retry: { Task { await model.loadAgent(agentId) } })
                    }
                }
                .designSettingsList()
                .designSettingsTitle("Agent")
            } else {
                DesignSettingsLoading(message: "Loading agent")
                    .designSettingsTitle("Agent")
            }
        }
        .task { await model.loadAgent(agentId) }
    }
}

struct FeatureAgentEditorForm: View {
    @ObservedObject var model: FeatureAgentLibraryModel
    @State var draft: FeatureAgentDraft
    let isNew: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens
    @State private var confirmDelete = false

    var body: some View {
        editor
            .designSettingsTitle(isNew ? "New agent" : draft.name.isEmpty ? "Agent" : draft.name)
            .featureBusy(model.mutating)
            .confirmationDialog("Delete this agent?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task {
                        if await model.delete(id: draft.id) {
                            if isNew { dismiss() }
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
            .onChange(of: model.editDraft?.revision) { _, _ in
                if let latest = model.editDraft, latest.id == draft.id {
                    draft = latest
                }
            }
            .toolbar {
                if isNew {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
            }
    }

    @ViewBuilder
    private var editor: some View {
        List {
            if let error = model.detailError {
                DesignSettingsSection {
                    DesignSettingsErrorRow(title: "Agent action failed", message: error)
                }
            }
            if !model.blockers.isEmpty {
                DesignSettingsSection(title: "Cannot enable") {
                    ForEach(Array(model.blockers.enumerated()), id: \.offset) { _, blocker in
                        VStack(alignment: .leading, spacing: 2) {
                            if let ref = blocker["ref"].optionalString, !ref.isEmpty {
                                Text(ref).font(MichiFont.meta).foregroundStyle(tokens.mid)
                            }
                            DesignSettingsNote(text: blocker["message"].stringValue, tone: .bad)
                        }
                    }
                }
            }
            DesignSettingsSection(title: "Identity") {
                TextField("Name", text: $draft.name)
                TextField("Description", text: $draft.description, axis: .vertical)
                TextEditor(text: $draft.instructions)
                    .font(MichiFont.sans(size: 15, relativeTo: .body))
                    .foregroundStyle(tokens.fg)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 100)
                    .accessibilityLabel("Instructions")
                DesignSettingsMenuPicker(title: "Scope", selection: $draft.scope, options: designSettingsOptions([("global", "Global"), ("workspace", "Workspace")], current: draft.scope))
                    .disabled(!isNew)
                if draft.scope == "workspace" {
                    DesignSettingsFieldRow(title: "Workspace id", prompt: "Workspace id", text: $draft.workspaceId)
                        .disabled(!isNew)
                }
            }
            DesignSettingsSection(title: "Runtime profile") {
                FeatureRuntimeProfileFields(profile: $draft.runtimeProfile, runtimes: model.runtimes)
                if !draft.fallbackChain.isEmpty {
                    ForEach(draft.fallbackChain.indices, id: \.self) { index in
                        FeatureRuntimeProfileFields(profile: $draft.fallbackChain[index], runtimes: model.runtimes, title: "Fallback \(index + 1)")
                    }
                }
                DesignSettingsActionRow(title: "Add fallback", systemImage: "plus") {
                    draft.fallbackChain.append(FeatureRuntimeProfileDraft())
                }
            }
            DesignSettingsSection(title: "Context policy") {
                DesignSettingsToggle(title: "Workspace instructions", isOn: $draft.includeWorkspaceInstructions)
                DesignSettingsToggle(title: "Message context", isOn: $draft.allowMessageContext)
                DesignSettingsToggle(title: "File context", isOn: $draft.allowFileContext)
                DesignSettingsToggle(title: "Artifact context", isOn: $draft.allowArtifactContext)
                DesignSettingsFieldRow(title: "Max characters", prompt: "100000", text: $draft.maxEstimatedChars)
                    .keyboardType(.numberPad)
            }
            DesignSettingsSection(title: "Permission policy") {
                DesignSettingsMenuPicker(title: "Preset", selection: $draft.permissionPreset, options: designSettingsOptions([("research", "Research"), ("build", "Build"), ("custom", "Custom")], current: draft.permissionPreset))
                if draft.permissionPreset == "custom" {
                    ForEach(FeatureAgentDraft.policyCategories, id: \.self) { category in
                        DesignSettingsMenuPicker(
                            title: category.replacingOccurrences(of: "_", with: " "),
                            selection: Binding(
                                get: { draft.categories[category] ?? "deny" },
                                set: { draft.categories[category] = $0 }
                            ),
                            options: designSettingsOptions([("allow", "Allow"), ("ask", "Ask"), ("deny", "Deny")], current: draft.categories[category] ?? "deny")
                        )
                    }
                }
                DesignSettingsFieldRow(title: "Delegation depth", prompt: "0", text: $draft.maxDelegationDepth)
                    .keyboardType(.numberPad)
                DesignSettingsFieldRow(title: "Concurrent runs", prompt: "1", text: $draft.maxConcurrentRuns)
                    .keyboardType(.numberPad)
                DesignSettingsFieldRow(title: "Wall time (min)", prompt: "60", text: $draft.maxWallTimeMinutes)
                    .keyboardType(.numberPad)
                DesignSettingsFieldRow(title: "Attempts", prompt: "1", text: $draft.maxAttempts)
                    .keyboardType(.numberPad)
            }
            DesignSettingsSection(title: "Capabilities") {
                TextField("Tool refs, one per line", text: $draft.toolRefs, axis: .vertical)
                    .font(MichiFont.code)
                TextField("Skill refs, one per line", text: $draft.skillRefs, axis: .vertical)
                    .font(MichiFont.code)
                TextField("MCP server refs, one per line", text: $draft.mcpServerRefs, axis: .vertical)
                    .font(MichiFont.code)
                if !model.capabilities.isEmpty {
                    ForEach(model.capabilities, id: \.id) { capability in
                        DesignSettingsActionRow(title: "\(capability["kind"].stringValue): \(capability.id) · \(capability["readiness"].stringValue)", systemImage: "plus.circle") {
                            draft.add(capability)
                        }
                    }
                }
            }
            DesignSettingsSection {
                DesignSettingsActionRow(title: isNew ? "Create draft" : "Save draft") {
                    Task {
                        if await model.save(draft, enabling: false) && isNew { dismiss() }
                    }
                }
                if !isNew {
                    if draft.status == "enabled" {
                        DesignSettingsActionRow(title: "Disable") { Task { await model.disable(id: draft.id) } }
                    } else {
                        DesignSettingsActionRow(title: "Enable") { Task { _ = await model.save(draft, enabling: true) } }
                    }
                    DesignSettingsActionRow(title: "Duplicate") { Task { await model.duplicate(id: draft.id) } }
                    DesignSettingsActionRow(title: "Delete", role: .destructive) { confirmDelete = true }
                }
            }
        }
        .designSettingsList(onSheet: isNew)
    }
}

private struct FeatureRuntimeProfileFields: View {
    @Binding var profile: FeatureRuntimeProfileDraft
    let runtimes: [JSONValue]
    var title: String = "Primary"

    var body: some View {
        if !runtimes.isEmpty {
            DesignSettingsMenuPicker(title: title, selection: $profile.runtimeId, options: runtimeOptions)
        } else {
            DesignSettingsFieldRow(title: title, prompt: "Runtime id", text: $profile.runtimeId)
        }
        DesignSettingsFieldRow(title: "Provider", prompt: "Default", text: $profile.providerId)
        DesignSettingsFieldRow(title: "Model", prompt: "Default", text: $profile.modelId)
        DesignSettingsFieldRow(title: "Reasoning", prompt: "Default", text: $profile.reasoning)
        DesignSettingsFieldRow(title: "Mode", prompt: "Default", text: $profile.modeId)
    }

    private var runtimeOptions: [DesignSettingsOption<String>] {
        var options = [DesignSettingsOption(value: "", label: "Choose runtime")]
        options += runtimes.map { DesignSettingsOption(value: $0.id, label: $0["label"].optionalString ?? $0.id) }
        if !options.contains(where: { $0.value == profile.runtimeId }) {
            options.append(DesignSettingsOption(value: profile.runtimeId, label: "Current: " + profile.runtimeId))
        }
        return options
    }
}
