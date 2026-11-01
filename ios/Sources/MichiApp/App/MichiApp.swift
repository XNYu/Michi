import SwiftUI
import MichiCore

@main struct MichiApp: App {
    @StateObject private var connection: ConnectionStore
    init() {
        ConnectionStoreAppHook.install()
        _connection = StateObject(wrappedValue: ConnectionStore())
    }
    var body: some Scene {
        WindowGroup {
            Group {
                if let api = connection.api {
                    NativeShell(api: api, connection: connection).id(connection.selected?.id)
                } else { ConnectionScreen(connection: connection) }
            }.tint(MichiTokens.monokai.accent)
                .environment(\.michiTokens, MichiTokens.monokai)
                .environment(\.openURL, OpenURLAction { url in
                    ["https", "http"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
                })
        }
    }
}

struct NativeShell: View {
    @StateObject private var store: MichiStore
    @StateObject private var preferences: NativeAppearanceModel
    @StateObject private var notifications: NativeScheduledNotificationsModel
    @AppStorage("michi.appearance") private var scheme = "dark"
    @ObservedObject var connection: ConnectionStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab = 0
    @Environment(\.colorScheme) private var systemScheme
    #if DEBUG
    @State private var continuationPreview = false
    #endif
    init(api: MichiAPI, connection: ConnectionStore) {
        _store = StateObject(wrappedValue: MichiStore(api: api)); _preferences = StateObject(wrappedValue: NativeAppearanceModel(api: api)); self.connection = connection
        _notifications = StateObject(wrappedValue: NativeScheduledNotificationsModel(api: api))
    }
    var body: some View {
        Group {
            if #available(iOS 18.0, *) {
                modernTabs
            } else {
                legacyTabs
            }
        }.task {
            notifications.setActive(scenePhase == .active)
            store.onScheduledJobRun = { [weak notifications] event in notifications?.receive(event) }
            await store.reload(); await preferences.reload()
            notifications.setNotificationPreference(preferences.ready ? preferences.applied.notifications : nil)
            store.startObserving()
            #if DEBUG
            let args = ProcessInfo.processInfo.arguments
            if args.contains("--uitesting") {
                NativeMathValidation.runIfRequested()
                if args.contains("--preview-chat"), let graph = store.visibleGraphs.first, let node = graph.nodes.first { store.presentConversation(node, workspace: graph.id) }
                if args.contains("--preview-home") || args.contains("--preview-design") { selectedTab = 0 }
                if args.contains("--preview-spaces") || args.contains("--preview-page") { selectedTab = 2 }
                if args.contains("--preview-schedule") { selectedTab = 3 }
                if args.contains("--preview-settings") { selectedTab = 0 }
                if args.contains("--preview-search") { selectedTab = 4 }
                if args.contains("--preview-agents") || args.contains("--preview-trash") || args.contains("--preview-files") { selectedTab = 1 }
                if args.contains("--preview-system") { scheme = "system" }
                else if args.contains("--preview-bone") { scheme = "light" }
                continuationPreview = ["--preview-components", "--preview-catalog", "--preview-database-management", "--preview-database-order", "--preview-parity-board", "--preview-parity-component", "--preview-parity-component-library", "--preview-parity-component-db", "--preview-navigation", "--preview-provider-video", "--preview-reference-message", "--preview-reference-helper", "--preview-reference-page", "--preview-reference-missing", "--preview-page-sources", "--preview-reference-table", "--preview-task-board", "--preview-task-upkeep", "--preview-task-origin", "--preview-task-proposal"].contains { args.contains($0) } || ContentParityFixtures.navigationRequested || NativeComponentRuntimeFixtures.sheet
            }
            #endif
        }
        #if DEBUG
        .sheet(isPresented: $continuationPreview) { NativeContinuationPreview(api: store.api) }
        #endif
        .overlay(alignment: .top) {
            NativeScheduledNotifications(model: notifications) { workspace, node in openConversation(workspace: workspace, node: node) }
        }
        .onChange(of: store.chatsPresentationEpoch) { _, _ in
            if store.selectedNodeID != nil { selectedTab = 1 }
        }
        .onChange(of: preferences.applied.notifications) { _, value in notifications.setNotificationPreference(preferences.ready ? value : nil) }
        .onChange(of: preferences.ready) { _, value in notifications.setNotificationPreference(value ? preferences.applied.notifications : nil) }
        .environment(\.michiAppearance, preferences.applied)
        .environment(\.michiTokens, resolvedTokens)
        .tint(resolvedTokens.accent)
        .preferredColorScheme(resolvedColorScheme)
        .transaction { if preferences.applied.reduceMotion { $0.animation = nil; $0.disablesAnimations = true } }
        .onChange(of: scenePhase) { _, phase in
            notifications.setActive(phase == .active)
            if phase == .background { store.disconnectStreams() }
            if phase == .active { store.resumeStreams(); Task { await store.reload() } }
        }.onDisappear { notifications.setActive(false); store.onScheduledJobRun = nil; store.disconnectStreams() }
        .nativeMichiReferences(api: store.api)
    }
    private var resolvedTokens: MichiTokens {
        let palette = NativeAppearancePreferences.resolvedPalette(
            palette: preferences.applied.palette,
            paletteExplicit: preferences.applied.paletteExplicit,
            appearance: scheme,
            systemIsLight: systemScheme == .light
        )
        return MichiTokens.named(palette).withAccent(preferences.applied.accentOverrides[palette])
    }
    private var resolvedColorScheme: ColorScheme? {
        switch NativeAppearancePreferences.preferredColorScheme(
            palette: preferences.applied.palette,
            paletteExplicit: preferences.applied.paletteExplicit,
            appearance: scheme
        ) {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    @available(iOS 18.0, *)
    private var modernTabs: some View {
        TabView(selection: $selectedTab) {
            Tab("Home", systemImage: "house", value: 0) { homeTab }
            Tab("Chats", systemImage: "bubble.left.and.bubble.right", value: 1) { chatsTab }
            Tab("Pages", systemImage: "square.stack", value: 2) { pagesTab }
            Tab("Scheduled", systemImage: "clock", value: 3) { scheduledTab }
            Tab("Search", systemImage: "magnifyingglass", value: 4, role: .search) { searchTab }
        }
        .modifier(MichiTabChrome())
    }

    private var legacyTabs: some View {
        TabView(selection: $selectedTab) {
            homeTab.tabItem { Label("Home", systemImage: "house") }.tag(0)
            chatsTab.tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }.tag(1)
            pagesTab.tabItem { Label("Pages", systemImage: "square.stack") }.tag(2)
            scheduledTab.tabItem { Label("Scheduled", systemImage: "clock") }.tag(3)
            searchTab.tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(4)
        }
    }

    private var homeTab: some View {
        NativeHomeScreen(store: store, preferences: preferences, connection: connection)
    }
    private var chatsTab: some View { ConversationsScreen(store: store) }
    private var pagesTab: some View { NativePagesHomeScreen(api: store.api, workspaces: store.workspaceRows) }
    private var scheduledTab: some View {
        ScheduleScreen(api: store.api, workspaces: store.workspaceRows, onOpenConversation: { target in openConversation(workspace: target.workspaceID, node: target.nodeID) })
    }
    private var searchTab: some View { NativeSearchScreen(store: store) }

    private func openConversation(workspace: String, node: String) {
        Task {
            await store.reload()
            guard let graph = store.graphs.first(where: { $0.id == workspace && !$0.isDeleted }), let current = graph.node(node), current["deleted_at"].isNull else {
                store.error = "The conversation is no longer available."; return
            }
            store.presentConversation(current, workspace: workspace)
        }
    }
}

private struct MichiTabChrome: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .tabBarMinimizeBehavior(.onScrollDown)
                .tabViewStyle(.sidebarAdaptable)
        } else if #available(iOS 18.0, *) {
            content.tabViewStyle(.sidebarAdaptable)
        } else {
            content
        }
    }
}

struct NativeSettingsScreen: View {
    @ObservedObject var connection: ConnectionStore
    let api: MichiAPI
    @ObservedObject var preferences: NativeAppearanceModel
    var store: MichiStore? = nil
    @AppStorage("michi.appearance") private var appearance = "dark"
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "desktopcomputer").font(.title2).foregroundStyle(tokens.mid)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(connection.selected?.name ?? "Michi").font(MichiFont.sans(size: 15, relativeTo: .subheadline, weight: .semibold)).foregroundStyle(tokens.fg)
                        Text(connection.selected?.address.replacingOccurrences(of: "https://", with: "") ?? "").font(MichiFont.meta).foregroundStyle(tokens.muted).textSelection(.enabled)
                    }
                    Spacer()
                    Button("Switch") { connection.disconnect() }
                        .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .medium))
                }
                Text("Your agents run on the connected computer. Closing the app leaves their work running; Stop cancels a response.")
                    .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
            }
            .listRowBackground(tokens.bg)

            Section("Preferences") {
                NavigationLink { NativeAppearanceScreen(model: preferences) } label: {
                    settingsRow("Appearance & behavior", systemImage: "circle.lefthalf.filled", trail: preferences.applied.palette.capitalized)
                }
                NavigationLink { RuntimeSettingsScreen(api: api) } label: { settingsRow("Runtime & models", systemImage: "cpu") }
                NavigationLink { ServiceSettingsScreen(api: api) } label: { settingsRow("Providers & services", systemImage: "key") }
                NavigationLink { PermissionsSettingsScreen(api: api) } label: { settingsRow("Permissions", systemImage: "checkmark.shield") }
                NavigationLink { MetaAgentSettingsScreen(api: api) } label: { settingsRow("Meta agent", systemImage: "wrench") }
                NavigationLink { MetaMaintenanceScreen(api: api) } label: { settingsRow("Meta agent activity", systemImage: "chart.bar") }
                NavigationLink { BackupSettingsScreen(api: api) } label: { settingsRow("Backup & restore", systemImage: "externaldrive") }
                if let store {
                    NavigationLink { TrashScreen(store: store) } label: { settingsRow("Trash", systemImage: "trash") }
                }
                Picker("Appearance", selection: $appearance) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }
            }
            .listRowBackground(tokens.bg)

            Section("About") {
                LabeledContent("Michi", value: "Native iOS")
                NavigationLink("Open-source licenses") {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if let geist = Bundle.main.url(forResource: "OFL-Geist", withExtension: "txt").flatMap({ try? String(contentsOf: $0, encoding: .utf8) }) {
                                Text(geist)
                            }
                            Text(Bundle.main.url(forResource: "SwiftMath-Notices", withExtension: "txt").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "Licenses could not be loaded.")
                        }
                        .font(.footnote).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding()
                    }.navigationTitle("Open-source licenses")
                }
            }
            .listRowBackground(tokens.bg)
        }
        .michiPlainList()
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
        .accessibilityIdentifier("settings")
    }

    private func settingsRow(_ title: String, systemImage: String, trail: String? = nil) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer()
            if let trail { Text(trail).font(MichiFont.meta).foregroundStyle(tokens.muted) }
        }
    }
}
