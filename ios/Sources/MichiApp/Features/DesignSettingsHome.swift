import SwiftUI
import MichiCore
#if canImport(UIKit)
import UIKit
#endif

/// Settings from Home's gear (ios/Design 26). Drop-in for `NativeSettingsScreen`
/// with the same inputs and every destination it had. Trailing summaries are
/// read from the endpoints the destination screens use; a value that cannot be
/// read is left blank rather than guessed.
struct DesignSettingsHomeScreen: View {
    @ObservedObject var connection: ConnectionStore
    let api: MichiAPI
    @ObservedObject var preferences: NativeAppearanceModel
    var store: MichiStore? = nil
    @StateObject private var summary: DesignSettingsSummaryModel
    @State private var titleVisible = true
    @Environment(\.michiTokens) private var tokens

    init(connection: ConnectionStore, api: MichiAPI, preferences: NativeAppearanceModel, store: MichiStore? = nil) {
        self.connection = connection
        self.api = api
        self.preferences = preferences
        self.store = store
        _summary = StateObject(wrappedValue: DesignSettingsSummaryModel(api: api))
    }

    var body: some View {
        List {
            DesignSettingsTitleRow(title: "Settings", visible: $titleVisible)

            Section {
                Group {
                    if let store {
                        DesignSettingsStoreReader(store: store) { store in
                            DesignSettingsConnectionCard(connection: connection, synchronizationError: store.synchronizationError, connecting: !store.hydrated && store.loading)
                        }
                    } else {
                        DesignSettingsConnectionCard(connection: connection, synchronizationError: nil, connecting: false)
                    }
                }
                .designSettingsBareRow(EdgeInsets(top: 8, leading: 20, bottom: 0, trailing: 20))
            } footer: {
                DesignSettingsFootnote(text: "Your agents run on the connected computer. Closing the app leaves their work running; Stop cancels a response.")
            }

            DesignSettingsSection(title: "Preferences") {
                NavigationLink { NativeAppearanceScreen(model: preferences) } label: {
                    DesignSettingsNavLabel(title: "Appearance", systemImage: "circle.lefthalf.filled", trail: paletteTrail)
                }
                NavigationLink { RuntimeSettingsScreen(api: api) } label: {
                    DesignSettingsNavLabel(title: "Runtime & models", systemImage: "cpu", trail: summary.runtime)
                }
                NavigationLink { ServiceSettingsScreen(api: api) } label: {
                    DesignSettingsNavLabel(title: "Providers & services", systemImage: "key")
                }
                NavigationLink { PermissionsSettingsScreen(api: api) } label: {
                    DesignSettingsNavLabel(title: "Permissions", systemImage: "checkmark.shield", trail: summary.permissions)
                }
                NavigationLink { MetaAgentSettingsScreen(api: api) } label: {
                    DesignSettingsNavLabel(title: "Meta agent", systemImage: "wrench", trail: summary.metaAgent)
                }
                NavigationLink { DesignSettingsNotificationsScreen(model: preferences) } label: {
                    DesignSettingsNavLabel(title: "Notifications", systemImage: "bell", trail: designSettingsNotificationLabel(preferences.applied.notifications))
                }
            }

            DesignSettingsSection(title: "Data") {
                NavigationLink { BackupSettingsScreen(api: api) } label: {
                    DesignSettingsNavLabel(title: "Backup & restore", systemImage: "externaldrive")
                }
                if let store {
                    DesignSettingsStoreReader(store: store) { store in
                        NavigationLink { TrashScreen(store: store, showsDone: false) } label: {
                            DesignSettingsNavLabel(title: "Trash", systemImage: "trash", trail: designSettingsTrashCount(store))
                        }
                    }
                }
            }

            DesignSettingsSection(title: "About") {
                LabeledContent("Michi", value: "Native iOS")
                NavigationLink { DesignSettingsLicensesScreen() } label: {
                    DesignSettingsNavLabel(title: "Open-source licenses")
                }
            }
        }
        .designSettingsList()
        .designSettingsTitle("Settings", revealed: !titleVisible)
        .refreshable { await summary.reload() }
        .task { await summary.reload() }
        .accessibilityIdentifier("settings")
    }

    /// The palette on screen: the saved one, or Bone/Monokai while none is saved.
    private var paletteTrail: String {
        let applied = preferences.applied
        if applied.paletteExplicit { return designSettingsPaletteName(applied.palette) }
        let shown = NativeAppearancePreferences.palettes.first { MichiTokens.named($0).bg == tokens.bg } ?? applied.palette
        return designSettingsPaletteName(shown)
    }
}

/// Read-only Settings summaries. Each GET is independent; a failure only
/// leaves that row's trailing value empty.
@MainActor final class DesignSettingsSummaryModel: ObservableObject {
    let api: MichiAPI
    @Published private(set) var runtime: String?
    @Published private(set) var permissions: String?
    @Published private(set) var metaAgent: String?

    init(api: MichiAPI) { self.api = api }

    func reload() async {
        let status = try? await api.request("/agent/status")
        if Task.isCancelled { return }
        runtime = status.flatMap(Self.runtimeLabel)
        let permission = try? await api.request("/permissions/settings")
        if Task.isCancelled { return }
        permissions = permission.flatMap(Self.permissionLabel)
        let overview = try? await api.request("/meta-agent/overview")
        if Task.isCancelled { return }
        metaAgent = overview.flatMap(Self.metaAgentLabel)
    }

    static func runtimeLabel(_ status: JSONValue) -> String? {
        let id = status["runtime"].stringValue
        if let runtime = status["availableRuntimes"].arrayValue.first(where: { $0.id == id }),
           let label = runtime["label"].optionalString, !label.isEmpty { return label }
        if let label = status["label"].optionalString, !label.isEmpty { return label }
        return id.isEmpty ? nil : id
    }

    static func permissionLabel(_ value: JSONValue) -> String? {
        guard let draft = try? featurePermissionDraft(from: value) else { return nil }
        guard draft.global else { return "Per chat" }
        switch draft.mode {
        case "trust": return "Trust"
        case "yolo": return "YOLO"
        default: return draft.approveForMe ? "Approve for me" : "Ask"
        }
    }

    static func metaAgentLabel(_ overview: JSONValue) -> String? {
        if !overview["notRunning"].isNull, !overview["notRunning"]["message"].stringValue.isEmpty { return "Off" }
        switch overview["state"].stringValue {
        case "running": return "On"
        case "paused": return "Paused"
        case "error": return "Stopped"
        default: return nil
        }
    }
}

/// The mascot ships as a loose `MichiIcon.png` in the app bundle, not in an
/// asset catalog, so `Image("MichiIcon")` finds nothing and the card renders
/// as a bare black tile. Load the bitmap from its bundle URL instead.
private enum DesignSettingsMascot {
    #if canImport(UIKit)
    private static let bitmap: UIImage? = Bundle.main.url(forResource: "MichiIcon", withExtension: "png")
        .flatMap { UIImage(contentsOfFile: $0.path) } ?? UIImage(named: "MichiIcon", in: .main, compatibleWith: nil)
    static var image: Image { bitmap.map { Image(uiImage: $0) } ?? Image("MichiIcon") }
    #else
    static var image: Image { Image("MichiIcon") }
    #endif
}

/// The connected computer (design 26) and its live connection state (design 33).
private struct DesignSettingsConnectionCard: View {
    @ObservedObject var connection: ConnectionStore
    let synchronizationError: String?
    let connecting: Bool
    @Environment(\.michiTokens) private var tokens

    private var host: String {
        guard let address = connection.selected?.address else { return "" }
        return URLComponents(string: address)?.host ?? address.replacingOccurrences(of: "https://", with: "")
    }

    var body: some View {
        HStack(spacing: 12) {
            DesignSettingsMascot.image
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
                .padding(10)
                .frame(width: 52, height: 52)
                .background(Color.black, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(connection.selected?.name ?? "Michi")
                    .font(MichiFont.sans(size: 15, relativeTo: .subheadline, weight: .semibold))
                    .foregroundStyle(tokens.fg)
                    .lineLimit(2)
                if !host.isEmpty {
                    Text(host)
                        .font(MichiFont.meta)
                        .foregroundStyle(tokens.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                DesignSettingsStatusLine(text: statusText, tone: statusTone)
                    .padding(.top, 2)
            }
            Spacer(minLength: 8)
            Button { connection.disconnect() } label: {
                Text("Switch")
                    .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .semibold))
                    .foregroundStyle(tokens.fg)
                    .padding(.horizontal, 6)
                    .frame(minHeight: 30)
            }
            .michiGlassButton()
            .michiHitTarget()
            .accessibilityLabel("Switch computer")
            .accessibilityHint("Disconnects from this computer and returns to the connection screen.")
        }
        .padding(12)
        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(tokens.line, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private var statusText: String {
        if let synchronizationError, !synchronizationError.isEmpty {
            if synchronizationError.hasSuffix("Reconnecting…") { return "Reconnecting to \(connection.selected?.name ?? "your computer")…" }
            return synchronizationError
        }
        if connecting { return "Connecting…" }
        return host.hasSuffix(".ts.net") ? "Connected over Tailscale" : "Connected"
    }

    private var statusTone: DesignSettingsTone {
        if let synchronizationError, !synchronizationError.isEmpty {
            return synchronizationError.hasSuffix("Reconnecting…") ? .run : .bad
        }
        return connecting ? .run : .ok
    }
}

/// The notification level stored in /prefs (also edited under Appearance).
struct DesignSettingsNotificationsScreen: View {
    @ObservedObject var model: NativeAppearanceModel

    var body: some View {
        List {
            if let error = model.error {
                DesignSettingsSection { DesignSettingsErrorRow(title: "Preferences not saved", message: error, retry: { Task { await model.reload() } }) }
            }
            DesignSettingsSection(title: "In-app notices", footer: "All includes completion and approval notices. Scheduled jobs that finish while Michi is open show a banner at the top. This preference does not grant iOS notification permission or set up push delivery.") {
                DesignSettingsMenuPicker(title: "Notify me about", selection: $model.draft.notifications, options: designSettingsOptions(designSettingsNotificationChoices, current: model.draft.notifications))
            }
            DesignSettingsSection(footer: "Saved for every Michi client connected to this computer.") {
                DesignSettingsActionRow(title: model.saving ? "Saving…" : "Save preferences", busy: model.saving) { Task { await model.save() } }
                    .disabled(!model.ready || !model.dirty || model.saving || model.loading)
                DesignSettingsActionRow(title: "Discard changes") { model.discardEdits() }
                    .disabled(!model.dirty || model.saving)
            }
        }
        .designSettingsList()
        .designSettingsTitle("Notifications")
        .disabled(model.saving)
        .task { if !model.ready { await model.reload() } }
    }
}

private struct DesignSettingsLicensesScreen: View {
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let geist = Bundle.main.url(forResource: "OFL-Geist", withExtension: "txt").flatMap({ try? String(contentsOf: $0, encoding: .utf8) }) {
                    Text(geist)
                }
                Text(Bundle.main.url(forResource: "SwiftMath-Notices", withExtension: "txt").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "Licenses could not be loaded.")
            }
            .font(MichiFont.code)
            .foregroundStyle(tokens.mid)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .background(tokens.bg)
        .michiScrollEdge()
        .designSettingsTitle("Open-source licenses")
    }
}

let designSettingsNotificationChoices: [(String, String)] = [("all", "All"), ("approval-only", "Approval only"), ("off", "Off")]

func designSettingsNotificationLabel(_ value: String) -> String {
    designSettingsNotificationChoices.first { $0.0 == value }?.1 ?? value
}

func designSettingsPaletteName(_ palette: String) -> String {
    switch palette {
    case "bone": return "Bone"
    case "slate": return "Slate"
    case "monokai": return "Monokai"
    case "gruvbox": return "Gruvbox"
    default: return palette.capitalized
    }
}

/// Matches TrashScreen's count: deleted thread groups in live workspaces plus
/// deleted workspaces. Blank until the snapshot is hydrated.
@MainActor
func designSettingsTrashCount(_ store: MichiStore) -> String? {
    guard store.hydrated else { return nil }
    let groups = store.graphs.filter { !$0.isSystem && !$0.isDeleted }.reduce(0) { $0 + $1.deletionGroups(archive: false).count }
    let workspaces = store.graphs.filter { $0.isDeleted && !$0.isSystem }.count
    let total = groups + workspaces
    return total == 0 ? nil : "\(total)"
}
