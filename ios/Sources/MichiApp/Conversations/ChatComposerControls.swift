import SwiftUI
import MichiCore

/// Runtime/model catalog for the composer chips (web ComposerModelPicker).
/// Choices only update the controller's next-session fields; nothing is
/// written until the next message starts its session.
@MainActor final class ChatRuntimeCatalog: ObservableObject {
    let api: MichiAPI
    @Published private(set) var status: JSONValue = .null
    @Published private(set) var models: [JSONValue] = []
    @Published private(set) var capabilities: JSONValue = .null
    @Published private(set) var loadingModels = false
    @Published var error: String?
    private var modelsKey: String?
    private var epoch = 0

    init(api: MichiAPI) { self.api = api }

    var runtimes: [JSONValue] { status["availableRuntimes"].arrayValue }
    var defaultRuntimeID: String { status["runtime"].stringValue }

    func loadStatus() async {
        guard status.isNull else { return }
        do { status = try await api.request("/agent/status"); error = nil }
        catch { self.error = error.localizedDescription }
    }

    func loadModels(runtime: String, provider: String) async {
        guard !runtime.isEmpty else { return }
        let key = runtime + "|" + provider
        guard key != modelsKey else { return }
        epoch += 1
        let current = epoch
        loadingModels = true
        defer { if current == epoch { loadingModels = false } }
        var path = "/agent/runtime-catalog?runtime=\(FeatureAPI.segment(runtime))"
        if !provider.isEmpty { path += "&provider=\(FeatureAPI.segment(provider))" }
        let catalog = try? await api.request(path)
        guard current == epoch else { return }
        var nextModels = catalog?["models"].arrayValue ?? []
        var nextCapabilities = catalog?["capabilities"] ?? .null
        if nextCapabilities.isNull, runtime == defaultRuntimeID { nextCapabilities = status["capabilities"] }
        if nextModels.isEmpty, runtime == defaultRuntimeID {
            var fallback = "/agent/models?expectedRuntime=\(FeatureAPI.segment(runtime))"
            if !provider.isEmpty { fallback += "&provider=\(FeatureAPI.segment(provider))" }
            nextModels = (try? await api.request(fallback))?["models"].arrayValue ?? []
            guard current == epoch else { return }
        }
        models = nextModels; capabilities = nextCapabilities; modelsKey = key
    }

    func runtime(_ id: String) -> JSONValue? { runtimes.first { $0.id == id } }
    func runtimeLabel(_ id: String) -> String {
        if id.isEmpty { return defaultRuntimeID.isEmpty ? "Workspace default" : runtimeLabel(defaultRuntimeID) }
        return runtime(id)?["label"].optionalString ?? id
    }
    func modelLabel(_ id: String) -> String {
        guard !id.isEmpty else { return "Default model" }
        let model = models.first { $0.id == id }
        return model?["label"].optionalString ?? model?["name"].optionalString ?? id
    }
    var reasoningLevels: [String] {
        let listed = featureStringList(capabilities["supportedReasoningLevels"])
        return listed.isEmpty ? ["minimal", "low", "medium", "high", "xhigh", "max"] : listed
    }
    var supportsReasoning: Bool { capabilities["reasoning"] != .bool(false) }
    var supportsModels: Bool { capabilities["models"] != .bool(false) }
    func supportsApproveForMe(_ runtime: String) -> Bool { featureApproveForMeRuntimeIds(status).contains(runtime) }
}

enum ChatPermissionCopy {
    static func title(_ mode: String) -> String { mode == "yolo" ? "YOLO" : mode.capitalized }
    static func detail(_ mode: String) -> String {
        switch mode {
        case "trust": return "Approve tool requests automatically. Keep the runtime’s existing sandbox."
        case "yolo": return "Approve tools automatically and use full access where the runtime supports it."
        default: return "Ask before changes and tools that require approval. Read-only tools may run automatically."
        }
    }
}

extension ChatController {
    /// Runtime the next session would use, once `/agent/status` has resolved a default.
    func effectiveRuntime(_ catalog: ChatRuntimeCatalog) -> String {
        resolvedRuntimeID.isEmpty ? catalog.defaultRuntimeID : resolvedRuntimeID
    }
    var controlsLocked: Bool { busy || commandRunning || isReadOnly }
}

/// Glass chip shown in the composer's focused row (visual 28 pt, hit 44 pt).
struct ChatComposerChip: View {
    let systemImage: String
    var title: String? = nil
    var detail: String? = nil
    var open = false
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage).font(.system(size: 11, weight: .medium))
            if let title { Text(title).foregroundStyle(tokens.fg) }
            if let detail { Text(detail).foregroundStyle(open ? tokens.fg : tokens.muted) }
        }
        .font(MichiFont.mono(size: 11.5, relativeTo: .caption, weight: .medium))
        .foregroundStyle(tokens.fg)
        .lineLimit(1)
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(tokens.fg.opacity(open ? 0.18 : 0.07), in: Capsule())
        .padding(.vertical, 8)
        .contentShape(Capsule())
    }
}

/// Model chip + popover: Runtime / Model summary rows and a thinking-effort
/// slider; tapping a summary row swaps the same popover to its list.
struct ChatModelControl: View {
    @ObservedObject var chat: ChatController
    @ObservedObject var catalog: ChatRuntimeCatalog
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            ChatComposerChip(systemImage: "cpu", title: catalog.modelLabel(chat.modelID) == "Default model" ? catalog.runtimeLabel(chat.runtimeID) : catalog.modelLabel(chat.modelID),
                             detail: catalog.supportsReasoning ? (chat.reasoning.isEmpty ? "Default" : chat.reasoning.capitalized) : nil, open: open)
        }
        .buttonStyle(.plain)
        .michiHitTarget()
        .accessibilityLabel("Model and thinking effort")
        .accessibilityValue("\(catalog.modelLabel(chat.modelID)), \(chat.reasoning.isEmpty ? "default effort" : chat.reasoning)")
        .accessibilityIdentifier("composer-model")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            ChatModelPopover(chat: chat, catalog: catalog)
                .presentationCompactAdaptation(.popover)
        }
        .task { await catalog.loadStatus(); await catalog.loadModels(runtime: chat.effectiveRuntime(catalog), provider: chat.providerID) }
    }
}

struct ChatModelPopover: View {
    @ObservedObject var chat: ChatController
    @ObservedObject var catalog: ChatRuntimeCatalog
    @State private var page = Page.summary
    @State private var query = ""
    @Environment(\.michiTokens) private var tokens
    private enum Page { case summary, runtimes, models }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch page {
            case .summary: summary
            case .runtimes: runtimeList
            case .models: modelList
            }
            if let error = catalog.error {
                Text(error).font(MichiFont.rowSecondary).foregroundStyle(tokens.dangerText).padding(12)
            }
        }
        .padding(6)
        .frame(width: 272)
        .disabled(chat.controlsLocked)
        .task { await catalog.loadStatus(); await catalog.loadModels(runtime: chat.effectiveRuntime(catalog), provider: chat.providerID) }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 0) {
            summaryRow("Runtime", catalog.runtimeLabel(chat.runtimeID)) { page = .runtimes }
            if catalog.supportsModels { summaryRow("Model", catalog.modelLabel(chat.modelID)) { page = .models } }
            if catalog.supportsReasoning {
                hairline
                effort
            }
            if chat.controlsLocked {
                Text(chat.isReadOnly ? "Archived conversations are read-only." : "Changes apply after the current response finishes.")
                    .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
                    .padding(.horizontal, 12).padding(.vertical, 8)
            }
        }
    }

    private func summaryRow(_ caption: String, _ value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(caption).font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
                    Text(value).font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(tokens.fg).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(tokens.muted)
            }
            .padding(.leading, 12).padding(.trailing, 10)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(caption): \(value)")
    }

    private var effort: some View {
        let levels = catalog.reasoningLevels
        let fallback = levels.firstIndex(of: "medium") ?? levels.count / 2
        let index = levels.firstIndex(of: chat.reasoning) ?? fallback
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Thinking effort").foregroundStyle(tokens.fg)
                Spacer()
                Text(chat.reasoning.isEmpty ? "Default" : chat.reasoning.capitalized).foregroundStyle(tokens.muted)
            }
            .font(MichiFont.sans(size: 15, relativeTo: .body))
            if levels.count >= 2 {
                Slider(value: Binding(get: { Double(index) }, set: { chat.selectReasoning(levels[min(levels.count - 1, max(0, Int($0.rounded())))]) }),
                       in: 0...Double(levels.count - 1), step: 1)
                    .tint(tokens.fg)
                    .accessibilityLabel("Thinking effort")
                    .accessibilityValue(chat.reasoning.isEmpty ? "Default" : chat.reasoning)
                HStack {
                    ForEach(Array(levels.enumerated()), id: \.offset) { offset, _ in
                        Circle().fill(tokens.fg.opacity(offset <= index && !chat.reasoning.isEmpty ? 1 : 0.26)).frame(width: 4, height: 4)
                        if offset < levels.count - 1 { Spacer(minLength: 0) }
                    }
                }.padding(.horizontal, 1).accessibilityHidden(true)
                HStack {
                    Text(levels.first?.capitalized ?? "")
                    Spacer()
                    Text(levels.last?.capitalized ?? "")
                }
                .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
            }
            if !chat.reasoning.isEmpty {
                Button("Use runtime default") { chat.selectReasoning("") }
                    .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .medium))
                    .foregroundStyle(tokens.accentText)
                    .frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func header(_ title: String) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                Button { page = .summary } label: {
                    Image(systemName: "chevron.left").font(.system(size: 15, weight: .semibold)).foregroundStyle(tokens.accent)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).accessibilityLabel("Back")
                Text(title).font(MichiFont.sans(size: 15, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg)
                Spacer()
            }
            hairline
        }
    }

    private var runtimeList: some View {
        VStack(alignment: .leading, spacing: 0) {
            header("Runtime")
            ScrollView {
                VStack(spacing: 0) {
                    choice("Workspace default", detail: catalog.defaultRuntimeID.isEmpty ? nil : catalog.runtimeLabel(catalog.defaultRuntimeID), selected: chat.runtimeID.isEmpty, enabled: true) { selectRuntime("") }
                    ForEach(catalog.runtimes, id: \.id) { runtime in
                        let available = runtime["available"].isNull || runtime["available"].boolValue
                        choice(runtime["label"].optionalString ?? runtime.id,
                               detail: available ? nil : (runtime["unavailableReason"].optionalString ?? "Unavailable"),
                               selected: chat.runtimeID == runtime.id, enabled: available) { selectRuntime(runtime.id) }
                    }
                }
            }.frame(maxHeight: 320)
        }
    }

    private var modelList: some View {
        let filtered = catalog.models.filter { query.isEmpty || catalog.modelLabel($0.id).localizedCaseInsensitiveContains(query) || $0.id.localizedCaseInsensitiveContains(query) }
        return VStack(alignment: .leading, spacing: 0) {
            header("Model")
            if catalog.models.count > 7 {
                TextField("Search models", text: $query)
                    .font(MichiFont.sans(size: 15, relativeTo: .body))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, 12).frame(minHeight: 44)
            }
            if catalog.loadingModels && catalog.models.isEmpty {
                ProgressView().frame(maxWidth: .infinity, minHeight: 52)
            } else if catalog.models.isEmpty {
                TextField("Model id (blank = default)", text: $chat.modelID)
                    .font(MichiFont.mono(size: 14, relativeTo: .body))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, 12).frame(minHeight: 52)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        choice("Default model", detail: nil, selected: chat.modelID.isEmpty, enabled: true) { chat.modelID = ""; page = .summary }
                        ForEach(filtered, id: \.id) { model in
                            choice(catalog.modelLabel(model.id), detail: nil, selected: chat.modelID == model.id, enabled: true) { chat.modelID = model.id; page = .summary }
                        }
                    }
                }.frame(maxHeight: 320)
            }
        }
    }

    private func choice(_ title: String, detail: String?, selected: Bool, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(MichiFont.sans(size: 15, relativeTo: .body)).foregroundStyle(enabled ? tokens.fg : tokens.faint)
                    if let detail { Text(detail).font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted).lineLimit(2) }
                }
                Spacer(minLength: 8)
                Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(tokens.accent).opacity(selected ? 1 : 0)
                    .frame(width: 16)
            }
            .padding(.leading, 12).padding(.trailing, 10)
            .frame(minHeight: 52)
            .background(selected ? tokens.fg.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var hairline: some View {
        Rectangle().fill(tokens.fg.opacity(0.1)).frame(height: 1).padding(.horizontal, 12).padding(.vertical, 4)
    }

    private func selectRuntime(_ id: String) {
        if chat.runtimeID != id { chat.runtimeID = id; chat.providerID = ""; chat.modelID = "" }
        page = .summary
        Task { await catalog.loadModels(runtime: chat.effectiveRuntime(catalog), provider: chat.providerID) }
    }
}

/// Permission chip: a system Menu titled “Permissions · this chat”, one line
/// of consequence per mode. YOLO only appears where the runtime supports it.
struct ChatPermissionControl: View {
    @ObservedObject var chat: ChatController
    @ObservedObject var catalog: ChatRuntimeCatalog

    var body: some View {
        Menu {
            ChatPermissionMenuContent(chat: chat, catalog: catalog)
        } label: {
            ChatComposerChip(systemImage: "checkmark.shield", title: ChatPermissionCopy.title(chat.permissionMode))
        }
        .michiHitTarget()
        .disabled(chat.controlsLocked)
        .accessibilityLabel("Permissions for this chat")
        .accessibilityValue(ChatPermissionCopy.title(chat.permissionMode))
        .accessibilityIdentifier("composer-permissions")
        .task { await catalog.loadStatus() }
    }
}

/// Menu body shared by the permission chip and the accessibility-size “+” menu.
struct ChatPermissionMenuContent: View {
    @ObservedObject var chat: ChatController
    @ObservedObject var catalog: ChatRuntimeCatalog

    private var modes: [String] {
        let runtime = chat.effectiveRuntime(catalog)
        return featurePermissionModes.filter { $0 != "yolo" || runtime.isEmpty || featureSupportsChatYolo(runtimeId: runtime) || chat.permissionMode == "yolo" }
    }

    var body: some View {
            Section("Permissions · this chat") {
                Picker("Permission mode", selection: Binding(get: { chat.permissionMode }, set: { mode in
                    chat.permissionMode = mode
                    if mode != "ask" { chat.approveForMe = false }
                })) {
                    ForEach(modes, id: \.self) { mode in
                        VStack(alignment: .leading) {
                            Text(ChatPermissionCopy.title(mode))
                            Text(ChatPermissionCopy.detail(mode))
                        }.tag(mode)
                    }
                }
                .pickerStyle(.inline)
                if chat.permissionMode == "ask" && (catalog.supportsApproveForMe(chat.effectiveRuntime(catalog)) || chat.approveForMe) {
                    Toggle("Approve for me", isOn: $chat.approveForMe)
                }
            }
    }
}

/// Context-usage ring (visual 18 pt, hit 44 pt); its menu offers Compact.
struct ChatContextRing: View {
    @ObservedObject var chat: ChatController
    @Environment(\.michiTokens) private var tokens
    private var percent: Int { chat.usage["contextUsagePercentage"].intValue }

    var body: some View {
        Menu {
            Section("Context \(percent)% used") {
                if !chat.mentions.isEmpty { Text("\(chat.mentions.count) references in this draft") }
                Button("Compact context", systemImage: "arrow.down.right.and.arrow.up.left") { Task { await chat.compact() } }
                    .disabled(chat.busy || chat.commandRunning || chat.isReadOnly || chat.pendingSubmission != nil || chat.submissionRecoveryError != nil)
            }
        } label: {
            ZStack {
                Circle().stroke(tokens.fg.opacity(0.14), lineWidth: 3)
                Circle().trim(from: 0, to: CGFloat(min(100, max(0, percent))) / 100)
                    .stroke(tokens.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 18, height: 18)
            .frame(width: 38, height: 38)
            .michiHitTarget()
        }
        .accessibilityLabel("Context \(percent) percent used")
        .accessibilityIdentifier("context-ring")
    }
}
