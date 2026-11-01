import SwiftUI
import MichiCore

struct ServiceSettingsScreen: View {
    @StateObject private var model: ServiceSettingsModel
    init(api: MichiAPI) { _model = StateObject(wrappedValue: ServiceSettingsModel(api: api)) }
    var body: some View {
        List {
            DesignSettingsSection(title: "Model providers") {
                if model.providers.isEmpty { DesignSettingsNote(text: "The active runtime does not list API-key providers.") }
                ForEach(model.providers, id: \.id) { provider in
                    if provider.id == "amazon-bedrock" {
                        NavigationLink { BedrockSettingsScreen(api: model.api) } label: { DesignSettingsNavLabel(title: "Amazon Bedrock") }
                    } else if model.canEdit(provider, search: false) {
                        NavigationLink { NativeProviderKeyScreen(model: model, providerID: provider.id, search: false) } label: {
                            DesignSettingsNavLabel(title: provider["label"].optionalString ?? provider.id, trail: provider["hasKey"].boolValue ? "Configured" : "Needs key", trailTone: provider["hasKey"].boolValue ? .ok : .accent)
                        }
                    } else {
                        LabeledContent(provider["label"].optionalString ?? provider.id, value: "Managed by backend")
                    }
                }
            }
            if !model.searchProviders.isEmpty {
                DesignSettingsSection(title: "Web search") {
                    DesignSettingsMenuPicker(title: "Search provider", selection: $model.searchProvider, options: searchOptions)
                    DesignSettingsActionRow(title: "Save search setting") { Task { await model.saveSearchProvider() } }
                        .disabled(!model.ready || !model.searchDirty || model.busy)
                    ForEach(model.searchProviders, id: \.id) { provider in
                        NavigationLink { NativeProviderKeyScreen(model: model, providerID: provider.id, search: true) } label: {
                            DesignSettingsNavLabel(title: provider["label"].optionalString ?? provider.id, trail: provider["hasKey"].boolValue ? "Configured" : "Needs key", trailTone: provider["hasKey"].boolValue ? .ok : .accent)
                        }
                    }
                }
            }
            DesignSettingsSection(title: "Services") {
                if !model.providers.contains(where: { $0.id == "amazon-bedrock" }) {
                    NavigationLink { BedrockSettingsScreen(api: model.api) } label: { DesignSettingsNavLabel(title: "Amazon Bedrock", systemImage: "cloud") }
                }
                NavigationLink { ServicePreferencesScreen(api: model.api) } label: { DesignSettingsNavLabel(title: "Usage reporting & Crew memory", systemImage: "chart.line.uptrend.xyaxis") }
                NavigationLink { MetaMaintenanceScreen(api: model.api) } label: { DesignSettingsNavLabel(title: "Meta agent activity", systemImage: "chart.bar") }
            }
            if let message = model.message { DesignSettingsSection { DesignSettingsNote(text: message, tone: .plain) } }
            if let error = model.error { DesignSettingsSection { DesignSettingsErrorRow(title: "Services request failed", message: error, retry: { Task { await model.reload() } }) } }
        }
        .designSettingsList()
        .designSettingsTitle("Providers & services")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.busy).accessibilityLabel("Refresh services")
            }
        }
        .task { if !model.ready { await model.reload() } }
    }

    private var searchOptions: [DesignSettingsOption<String>] {
        var options = [DesignSettingsOption(value: "", label: "Off")]
        options += model.searchProviders.map { DesignSettingsOption(value: $0.id, label: $0["label"].optionalString ?? $0.id) }
        if !options.contains(where: { $0.value == model.searchProvider }) {
            options.append(DesignSettingsOption(value: model.searchProvider, label: "Current: " + model.searchProvider))
        }
        return options
    }
}

/// Saved secrets are never shown; an entered key is cleared when the screen closes.
private struct NativeProviderKeyScreen: View {
    @ObservedObject var model: ServiceSettingsModel
    let providerID: String
    let search: Bool
    @State private var confirmClear = false
    @Environment(\.michiTokens) private var tokens
    var provider: JSONValue { (search ? model.searchProviders : model.providers).first { $0.id == providerID } ?? .null }
    var slot: String { model.keySlot(provider: providerID, search: search) }
    var body: some View {
        List {
            DesignSettingsSection {
                LabeledContent("Saved credential", value: provider["hasKey"].boolValue ? "Available" : "Not configured")
                if !provider["description"].stringValue.isEmpty { DesignSettingsNote(text: provider["description"].stringValue) }
                if let url = URL(string: provider["keyUrl"].stringValue), url.scheme == "https" {
                    Link(destination: url) { DesignSettingsNavLabel(title: "Provider account", systemImage: "arrow.up.right.square", titleColor: tokens.accentText) }
                }
            }
            DesignSettingsSection(title: "New API key", footer: "Leave blank to keep the saved key. A new key is sent only when you save or verify it.") {
                SecureField(provider["keyLabel"].optionalString ?? "API key", text: Binding(get: { model.keys[slot, default: ""] }, set: { model.keys[slot] = $0 }))
                    .font(DesignSettingsFont.trail)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                DesignSettingsActionRow(title: "Save key") { Task { await model.saveKey(provider: providerID, search: search) } }
                    .disabled(model.keys[slot, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if !search {
                    DesignSettingsActionRow(title: "Verify connection") { Task { await model.verifyKey(provider: providerID) } }
                        .disabled(!provider["hasKey"].boolValue && model.keys[slot, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    DesignSettingsNote(text: "Verification contacts the provider using the new key above, or the saved key if the field is blank.")
                }
                DesignSettingsActionRow(title: "Clear saved key", role: .destructive) { confirmClear = true }.disabled(!provider["hasKey"].boolValue)
            }.disabled(model.busy || !model.ready)
            if let message = model.message { DesignSettingsSection { DesignSettingsNote(text: message, tone: .plain) } }
            if let error = model.error { DesignSettingsSection { DesignSettingsErrorRow(title: "Key request failed", message: error) } }
        }
        .designSettingsList()
        .designSettingsTitle(provider["label"].optionalString ?? providerID)
        .confirmationDialog("Clear this saved API key?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear saved key", role: .destructive) { Task { await model.clearKey(provider: providerID, search: search, confirmed: true) } }
        }
        .onDisappear { model.keys[slot] = "" }
    }
}

struct BedrockSettingsScreen: View {
    @StateObject private var model: BedrockSettingsModel
    @State private var confirmSave = false
    @State private var confirmClear = false
    @Environment(\.michiTokens) private var tokens
    init(api: MichiAPI) { _model = StateObject(wrappedValue: BedrockSettingsModel(api: api)) }
    var body: some View {
        List {
            DesignSettingsSection(title: "Connected computer") {
                LabeledContent("Credentials", value: model.config["configured"].boolValue ? "Available" : "Not configured")
                if model.config["envDetected"].boolValue {
                    DesignSettingsNote(text: "Environment credentials take priority on this computer. Changes here update its saved Bedrock configuration.")
                }
                if model.config["hasAuthRefresh"].boolValue { DesignSettingsStatusLine(text: "A refresh command is configured", tone: .ok) }
                DesignSettingsActionRow(title: "Verify saved connection") { Task { await model.verify() } }.disabled(!model.ready || model.busy)
            }
            DesignSettingsSection(title: "Replace saved configuration", footer: "Saved secrets are never shown. Saving replaces the entire Bedrock configuration, so re-enter all credentials you want to use. Blank fields are not a request to preserve old credentials.") {
                DesignSettingsFieldRow(title: "AWS region", prompt: "us-east-1", text: $model.draft.region)
                DesignSettingsMenuPicker(title: "Credential source", selection: $model.draft.source, options: designSettingsOptions([
                    ("profile", "AWS profile"), ("bearer-token", "Bearer token"), ("access-keys", "Access keys"), ("auto", "Automatic AWS chain")
                ], current: model.draft.source))
                switch model.draft.source {
                case "profile": DesignSettingsFieldRow(title: "Profile", prompt: "Profile on the connected computer", text: $model.draft.profile)
                case "bearer-token": secret("New bearer token", text: $model.draft.bearerToken)
                case "access-keys":
                    secret("New access key ID", text: $model.draft.accessKeyID)
                    secret("New secret access key", text: $model.draft.secretAccessKey)
                default: DesignSettingsNote(text: "Use the AWS credential chain available to the backend process.")
                }
                DisclosureGroup {
                    secret("Replacement refresh command (optional)", text: $model.draft.refreshCommand)
                    DesignSettingsNote(text: "The connected backend can run this command to refresh credentials. Re-enter the command to keep it when replacing this configuration. Cloud operators must manage it on the server.")
                } label: {
                    Text("Credential refresh command").foregroundStyle(tokens.fg)
                }
                .tint(tokens.muted)
                DesignSettingsActionRow(title: "Save configuration") {
                    if model.replacesConfiguration { confirmSave = true }
                    else { Task { await model.save(confirmedReplacement: false) } }
                }
                DesignSettingsActionRow(title: "Clear saved configuration", role: .destructive) { confirmClear = true }.disabled(!model.replacesConfiguration)
            }.disabled(!model.ready || model.busy)
            if let message = model.message { DesignSettingsSection { DesignSettingsNote(text: message, tone: .plain) } }
            if let error = model.error { DesignSettingsSection { DesignSettingsErrorRow(title: "Bedrock request failed", message: error) } }
        }
        .designSettingsList()
        .designSettingsTitle("Amazon Bedrock")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.busy).accessibilityLabel("Refresh Bedrock status")
            }
        }
        .task { if !model.ready { await model.reload() } }
        .onDisappear { model.clearEnteredSecrets() }
        .confirmationDialog("Replace the saved Bedrock configuration?", isPresented: $confirmSave, titleVisibility: .visible) {
            Button("Replace configuration", role: .destructive) { Task { await model.save(confirmedReplacement: true) } }
        } message: { Text("The credentials and refresh command shown in this form replace the previous saved configuration. Environment credentials remain unchanged.") }
        .confirmationDialog("Clear saved Bedrock configuration?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear configuration", role: .destructive) { Task { await model.clear(confirmed: true) } }
        }
    }
    private func secret(_ title: String, text: Binding<String>) -> some View {
        SecureField(title, text: text)
            .font(DesignSettingsFont.trail)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
    }
}

struct ServicePreferencesScreen: View {
    @StateObject private var model: ServicePreferencesModel
    init(api: MichiAPI) { _model = StateObject(wrappedValue: ServicePreferencesModel(api: api)) }
    var body: some View {
        List {
            DesignSettingsSection(title: "Usage reporting") {
                DesignSettingsToggle(title: "Enable usage reporting", subtitle: model.telemetry["reason"].stringValue, isOn: $model.telemetryEnabled)
                    .disabled(!model.telemetryReady || !model.telemetry["available"].boolValue || model.busy)
                DesignSettingsActionRow(title: "Save reporting preference") { Task { await model.saveTelemetry() } }
                    .disabled(!model.telemetryReady || !model.telemetry["available"].boolValue || !model.telemetryDirty || model.busy)
                if let error = model.telemetryError { DesignSettingsNote(text: error, tone: .bad) }
            }
            DesignSettingsSection(title: "Crew learned memory", footer: "Read & learn recalls and updates reusable preferences. Read only recalls without changing them. Off does neither. Chat history is retained independently.") {
                DesignSettingsMenuPicker(title: "Default memory mode", selection: $model.crewMode, options: designSettingsOptions([
                    ("persistent", "Read & learn"), ("incognito", "Read only"), ("temporary", "Off")
                ], current: model.crewMode))
                .disabled(!model.crewReady || model.busy)
                DesignSettingsActionRow(title: "Save Crew default") { Task { await model.saveCrew() } }.disabled(!model.crewReady || !model.crewDirty || model.busy)
                if let error = model.crewError { DesignSettingsNote(text: error, tone: .bad) }
            }
        }
        .designSettingsList()
        .designSettingsTitle("Service preferences")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.busy).accessibilityLabel("Refresh preferences")
            }
        }
        .task { await model.reload() }
    }
}

struct MetaMaintenanceScreen: View {
    @StateObject private var model: MetaMaintenanceModel
    @State private var confirmRun = false
    @State private var confirmToggle = false
    @State private var targetPaused = true
    @Environment(\.michiTokens) private var tokens
    init(api: MichiAPI) { _model = StateObject(wrappedValue: MetaMaintenanceModel(api: api)) }
    var body: some View {
        List {
            DesignSettingsSection(title: "Background maintenance") {
                if model.overviewReady {
                    LabeledContent("State") {
                        DesignSettingsStatusLine(text: model.overview["state"].stringValue.capitalized, tone: stateTone)
                    }
                    let runtime = model.overview["runtime"]
                    LabeledContent("Runtime", value: runtime["label"].optionalString ?? runtime["runtimeId"].stringValue)
                    if !model.overview["stopped"]["message"].stringValue.isEmpty { DesignSettingsNote(text: model.overview["stopped"]["message"].stringValue, tone: .bad) }
                    if !model.overview["notRunning"]["message"].stringValue.isEmpty { DesignSettingsNote(text: model.overview["notRunning"]["message"].stringValue) }
                    DesignSettingsActionRow(title: model.overview["state"] == "paused" ? "Resume all maintenance" : "Pause all maintenance", systemImage: model.overview["state"] == "paused" ? "play.circle" : "pause.circle") {
                        targetPaused = model.overview["state"] != "paused"; confirmToggle = true
                    }.disabled(model.busy)
                }
                if let error = model.overviewError { DesignSettingsNote(text: error) }
                DesignSettingsActionRow(title: model.running ? "Maintenance is running…" : "Run maintenance now", systemImage: "play", busy: model.running) { confirmRun = true }
                    .disabled(!model.roundReady || model.busy || model.running || model.outcomeUnknown)
                if let error = model.error { DesignSettingsNote(text: error, tone: .bad) }
                if model.outcomeUnknown {
                    DesignSettingsNote(text: "The previous run request has an unknown outcome. Refresh and check the recent runs before starting another.", tone: .warn)
                    DesignSettingsActionRow(title: "I reviewed the run status") { model.acknowledgeReviewedOutcome() }.disabled(!model.roundReady || model.running)
                }
            }
            if model.overviewReady {
                DesignSettingsSection(title: "Today") {
                    let today = model.overview["today"]
                    LabeledContent("Checks", value: "\(today["checks"].intValue)" + (today["checksTruncated"].boolValue ? "+" : ""))
                    LabeledContent("Model calls", value: "\(today["modelCalls"].intValue)")
                    LabeledContent("Writes", value: "\(today["writes"].intValue)")
                    LabeledContent("Pending proposals", value: "\(today["pendingProposals"].intValue)")
                }
                DesignSettingsSection(title: "Workspaces", count: "\(model.overview["cursors"].arrayValue.count)") {
                    ForEach(model.overview["cursors"].arrayValue, id: \.maintenanceWorkspaceID) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item["workspaceName"].stringValue).foregroundStyle(tokens.fg)
                            Text("\(item["state"].stringValue.capitalized) · \(item["unread"].intValue) unread turns").font(MichiFont.meta).foregroundStyle(tokens.muted)
                            if !item["lastRunAt"].isNull { Text("Last run: " + featureFormatDate(item["lastRunAt"].doubleValue)).font(MichiFont.meta).foregroundStyle(tokens.muted) }
                            if !item["problem"]["message"].stringValue.isEmpty { DesignSettingsNote(text: item["problem"]["message"].stringValue, tone: .bad) }
                        }
                    }
                }
                DesignSettingsSection(title: "Recent runs") {
                    ForEach(Array(model.overview["recentRuns"].arrayValue.enumerated()), id: \.offset) { _, run in
                        HStack(alignment: .top, spacing: 12) {
                            MichiThreadStateDot(state: runState(run["state"].stringValue))
                                .frame(width: 14, height: 20)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(run["workspaceName"].optionalString ?? "Multiple workspaces").foregroundStyle(tokens.fg)
                                Text("\(run["state"].stringValue.capitalized) · \(featureFormatDate(run["at"].doubleValue))").font(MichiFont.meta).foregroundStyle(tokens.muted)
                                Text("\(run["turns"].intValue) turns · \(run["writes"].intValue) writes · \(run["proposals"].intValue) proposals").font(DesignSettingsFont.note).foregroundStyle(tokens.mid)
                                if !run["error"].stringValue.isEmpty { DesignSettingsNote(text: run["error"].stringValue, tone: .bad) }
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            if !model.runResult.isNull {
                DesignSettingsSection(title: "Last requested round") {
                    ForEach(model.runResult["workspaces"].arrayValue, id: \.maintenanceWorkspaceID) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            LabeledContent(item["workspaceName"].stringValue, value: item["outcome"].stringValue.replacingOccurrences(of: "_", with: " "))
                            if !item["reason"].stringValue.isEmpty { DesignSettingsNote(text: item["reason"].stringValue) }
                        }
                    }
                }
            }
        }
        .designSettingsList()
        .designSettingsTitle("Meta agent activity")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.busy).accessibilityLabel("Refresh maintenance")
            }
        }
        .task { await model.reload() }
        .task(id: model.running) {
            guard model.running else { return }
            while !Task.isCancelled && model.running {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await model.refreshRound()
                if model.error != nil { return }
            }
        }
        .confirmationDialog("Run Meta agent maintenance now?", isPresented: $confirmRun, titleVisibility: .visible) {
            Button("Run now") { Task { await model.runNow(confirmed: true) } }
        } message: { Text("Each eligible workspace reads a bounded page of new conversations and may update its pages.") }
        .confirmationDialog(targetPaused ? "Pause maintenance in every workspace?" : "Resume maintenance in every workspace?", isPresented: $confirmToggle, titleVisibility: .visible) {
            Button(targetPaused ? "Pause maintenance" : "Resume maintenance") { Task { await model.setPaused(targetPaused, confirmed: true) } }
        }
    }

    private var stateTone: DesignSettingsTone {
        switch model.overview["state"].stringValue {
        case "running": return .run
        case "error": return .bad
        default: return .muted
        }
    }

    private func runState(_ state: String) -> MichiThreadState {
        switch state {
        case "done": return .done
        case "running": return .streaming
        case "attention": return .waiting
        case "failed": return .failed
        default: return .idle
        }
    }
}

private extension JSONValue {
    var maintenanceWorkspaceID: String { self["workspaceId"].stringValue }
}
