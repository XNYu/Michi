import SwiftUI
import MichiCore

/// Pages tab root: designed Pages Home first, directory one navigation step away.
struct NativePagesHomeScreen: View {
    let api: MichiAPI
    let workspaces: [JSONValue]
    @StateObject private var home: FeatureSpacesHomeModel
    @StateObject private var directory: FeatureSpacesModel
    @State private var showDirectory = false
    @State private var showAssistant = false
    @State private var showMeta = false
    @State private var showHistory = false
    @State private var showTasks = false
    @State private var openedPage: FeatureOpenedPage?
    @State private var openedReview: FeatureOpenedPage?
    #if DEBUG
    @State private var didOpenPreviewPage = false
    #endif
    @Environment(\.michiTokens) private var tokens
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(api: MichiAPI, workspaces: [JSONValue]) {
        self.api = api
        self.workspaces = workspaces
        _home = StateObject(wrappedValue: FeatureSpacesHomeModel(api: api, workspaces: workspaces))
        _directory = StateObject(wrappedValue: FeatureSpacesModel(api: api, workspaces: workspaces))
    }

    var body: some View {
        NavigationStack {
            Group {
                if sizeClass == .regular {
                    ipadSplit
                } else {
                    phoneHome
                }
            }
            .background(tokens.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    MichiGlassIconButton(systemImage: "sidebar.left", accessibility: "Pages directory") { showDirectory = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 8) {
                        Button {
                            Task { await refresh() }
                        } label: {
                            Label("Update", systemImage: "arrow.clockwise")
                                .font(MichiFont.sans(size: 15, relativeTo: .subheadline, weight: .medium))
                                .padding(.horizontal, 12)
                                .frame(height: 44)
                        }
                        .buttonStyle(.plain)
                        .michiGlassCapsule()
                        .accessibilityLabel("Update Pages Home")
                        Menu {
                            Button("Assistant") { showAssistant = true }
                            Button("All tasks") { showTasks = true }
                            Button("Michi assistant & layout") { showMeta = true }
                            Button("History and proposals") { showHistory = true }
                            if !home.homePage.id.isEmpty {
                                Button("Open Home as a page") {
                                    openedPage = FeatureOpenedPage(id: home.homePage.id, workspaceId: home.homePage["workspaceId"].stringValue)
                                }
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("More")
                    }
                }
            }
            .michiToolbarBackground()
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if sizeClass != .regular {
                    DesignPagesAssistantFAB { showAssistant = true }
                }
            }
            .navigationDestination(isPresented: $showDirectory) {
                NativePagesDirectory(model: directory, home: home, api: api, workspaces: workspaces, onOpenReview: { openedReview = $0 })
            }
            .navigationDestination(isPresented: $showAssistant) {
                NativeSpacesAssistantScreen(api: api, pageID: home.homePage.id.isEmpty ? nil : home.homePage.id, workspaceID: home.homePage["workspaceId"].optionalString)
            }
            .navigationDestination(isPresented: $showMeta) {
                if !home.homePage.id.isEmpty {
                    NativeSpacesMetaScreen(api: api, pageID: home.homePage.id, workspaceID: home.homePage["workspaceId"].stringValue)
                } else {
                    ContentUnavailableView("Pages Home", systemImage: "square.stack", description: Text("Pages Home is not available on this computer yet."))
                }
            }
            .navigationDestination(isPresented: $showHistory) {
                if !home.homePage.id.isEmpty {
                    FeaturePageHistoryScreen(api: api, pageId: home.homePage.id, workspaceId: home.homePage["workspaceId"].stringValue, workspaces: workspaces)
                }
            }
            .navigationDestination(isPresented: $showTasks) {
                FeatureAllTasksScreen(api: api, workspaces: workspaces)
            }
            .navigationDestination(item: $directory.openedPage) { page in
                FeaturePageScreen(
                    api: api, pageId: page.id, workspaceId: page.workspaceId, workspaces: workspaces,
                    allowsPageDeletion: !isSpacesHome(page)
                )
            }
            .navigationDestination(item: $home.openedPage) { page in
                FeaturePageScreen(
                    api: api, pageId: page.id, workspaceId: page.workspaceId, workspaces: workspaces,
                    allowsPageDeletion: !isSpacesHome(page)
                )
            }
            .navigationDestination(item: $openedPage) { page in
                FeaturePageScreen(
                    api: api, pageId: page.id, workspaceId: page.workspaceId, workspaces: workspaces,
                    allowsPageDeletion: !isSpacesHome(page)
                )
            }
            .navigationDestination(item: $openedReview) { page in
                FeaturePageHistoryScreen(api: api, pageId: page.id, workspaceId: page.workspaceId, workspaces: workspaces)
            }
            .refreshable { await refresh() }
            .task {
                directory.workspaces = workspaces
                home.workspaces = workspaces
                await refresh()
                #if DEBUG
                if !didOpenPreviewPage && ProcessInfo.processInfo.arguments.contains("--uitesting") && ProcessInfo.processInfo.arguments.contains("--preview-page") {
                    didOpenPreviewPage = true
                    directory.openedPage = FeatureOpenedPage(id: "page-preview", workspaceId: "ws-preview")
                }
                #endif
            }
            .onChange(of: workspaces) { _, latest in
                directory.workspaces = latest
                home.workspaces = latest
            }
        }
    }

    @ViewBuilder private var phoneHome: some View {
        if home.loading && home.home.isNull {
            FeatureLoadingView(message: "Loading Pages Home")
        } else if let error = home.error, home.home.isNull {
            FeatureStatusBanner(title: "Couldn’t load Pages Home", message: error, retry: { Task { await refresh() } })
                .padding()
        } else if !home.homePage.id.isEmpty {
            homeCanvas
                .id(DesignPagesHomeIdentity(pageId: home.homePage.id, workspaceId: home.homePage["workspaceId"].stringValue))
        } else {
            ContentUnavailableView("Pages Home", systemImage: "square.stack", description: Text("Pages Home is not available on this computer yet. Open the directory to browse pages."))
        }
    }

    @ViewBuilder private var ipadSplit: some View {
        NavigationSplitView {
            NativePagesDirectory(model: directory, home: home, api: api, workspaces: workspaces, onOpenReview: { openedReview = $0 })
        } detail: {
            phoneHome
        }
        .inspector(isPresented: $showAssistant) {
            NativeSpacesAssistantScreen(api: api, pageID: home.homePage.id.isEmpty ? nil : home.homePage.id, workspaceID: home.homePage["workspaceId"].optionalString)
        }
    }

    @ViewBuilder private var homeCanvas: some View {
        DesignPagesHomeCanvas(
            api: api,
            workspaces: workspaces,
            home: home,
            pageId: home.homePage.id,
            workspaceId: home.homePage["workspaceId"].stringValue,
            onOpenPage: { openedPage = $0 },
            onOpenTasks: { showTasks = true },
            onOpenAssistant: { showAssistant = true },
            onOpenMeta: { showMeta = true },
            onOpenHistory: { showHistory = true },
            onOpenReview: { openedReview = $0 }
        )
    }

    private func isSpacesHome(_ page: FeatureOpenedPage) -> Bool {
        DesignPagesHomeIdentity(pageId: page.id, workspaceId: page.workspaceId)
            == DesignPagesHomeIdentity(pageId: home.homePage.id, workspaceId: home.homePage["workspaceId"].stringValue)
    }

    private func refresh() async {
        await home.refresh()
        await directory.refresh()
    }
}

struct NativePagesDirectory: View {
    @ObservedObject var model: FeatureSpacesModel
    @ObservedObject var home: FeatureSpacesHomeModel
    let api: MichiAPI
    let workspaces: [JSONValue]
    var onOpenReview: (FeatureOpenedPage) -> Void = { _ in }
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        List {
            if let error = model.error ?? home.error {
                FeatureStatusBanner(title: "Refresh failed", message: error, retry: {
                    Task { await model.refresh(); await home.refresh() }
                })
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                NavigationLink { FeatureAllTasksScreen(api: api, workspaces: workspaces) } label: {
                    MichiHairlineRow(title: "All tasks", leading: {
                        Image(systemName: "checklist").foregroundStyle(tokens.mid)
                    }, trailing: {
                        HStack(spacing: 6) {
                            if home.allTasks["rows"].arrayValue.isEmpty == false {
                                Text("\(home.allTasks["rows"].arrayValue.count)").font(MichiFont.meta).foregroundStyle(tokens.muted)
                            }
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint)
                        }
                    })
                }
                NavigationLink { NativeSpacesAssistantScreen(api: api) } label: {
                    MichiHairlineRow(title: "Assistant", leading: {
                        Text(">_").font(MichiFont.prompt).foregroundStyle(tokens.accent)
                    }, trailing: {
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint)
                    })
                }
                Button {
                    if home.homePage.id.isEmpty {
                        Task { await home.refresh(); home.openHome() }
                    } else {
                        home.openHome()
                    }
                } label: {
                    MichiHairlineRow(title: "Spaces Home", leading: {
                        Image(systemName: "house").foregroundStyle(tokens.mid)
                    }, trailing: {
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint)
                    })
                }
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(tokens.bg)

            if !home.workspaceHomes.isEmpty || !model.contentWorkspaces.isEmpty {
                Section {
                    ForEach(home.workspaceHomes.isEmpty ? model.contentWorkspaces : home.workspaceHomes, id: \.designPagesWorkspaceIdentity) { item in
                        let workspaceId = item.featureWorkspaceKey
                        Button {
                            Task { await home.openWorkspaceHome(workspaceId) }
                        } label: {
                            MichiHairlineRow(
                                title: item["workspaceName"].optionalString ?? featureWorkspaceName(item),
                                subtitle: DesignPagesFormat.workspaceSubtitle(item),
                                leading: { Image(systemName: "folder").foregroundStyle(tokens.muted) },
                                trailing: {
                                    if item["pendingProposals"].intValue > 0 {
                                        HStack(spacing: 6) {
                                            Text("\(item["pendingProposals"].intValue)").font(MichiFont.meta).foregroundStyle(tokens.accentText)
                                            MichiThreadStateDot(state: .waiting)
                                        }
                                    }
                                }
                            )
                        }
                        .swipeActions {
                            if !DesignPageBatch.homePageID(item).isEmpty {
                                Button("Review") { openReview(item) }
                            }
                            Button(item["hiddenAt"].isNull ? "Hide" : "Show") {
                                Task { await home.setWorkspaceHomeHidden(workspaceId, hidden: item["hiddenAt"].isNull) }
                            }
                        }
                        .contextMenu {
                            if !DesignPageBatch.homePageID(item).isEmpty {
                                Button("Review proposals") { openReview(item) }
                            }
                            Button(item["hiddenAt"].isNull ? "Hide workspace home" : "Show workspace home") {
                                Task { await home.setWorkspaceHomeHidden(workspaceId, hidden: item["hiddenAt"].isNull) }
                            }
                        }
                    }
                } header: {
                    MichiSectionHeader(title: "Workspace homes")
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(tokens.bg)
            }

            if !model.filtered.isEmpty {
                ForEach(groupedPages) { group in
                    Section {
                        ForEach(group.pages, id: \.designPagesPageIdentity) { space in
                            NavigationLink {
                                FeaturePageScreen(api: api, pageId: space.id, workspaceId: space.featureWorkspaceKey, workspaces: workspaces)
                            } label: {
                                VStack(spacing: 0) {
                                    MichiHairlineRow(
                                        title: featureNamed(space, fallback: "Untitled page"),
                                        subtitle: spaceSubtitle(space),
                                        leading: { Image(systemName: "doc.text").foregroundStyle(tokens.muted) },
                                        trailing: { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                                    )
                                    ForEach(Array(featureStringList(space["childTitles"]).enumerated()), id: \.offset) { _, title in
                                        MichiHairlineRow(
                                            title: title,
                                            indent: 24,
                                            leading: { Image(systemName: "doc.text").font(.system(size: 13)).foregroundStyle(tokens.faint) },
                                            trailing: { EmptyView() }
                                        )
                                    }
                                }
                            }
                        }
                    } header: {
                        MichiSectionHeader(title: group.label)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(tokens.bg)
                }
            } else {
                Section {
                    Text("Create a page in a workspace to start a Space.")
                        .font(MichiFont.rowSecondary)
                        .foregroundStyle(tokens.muted)
                        .padding(20)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(tokens.bg)
            }

            if !databaseEntries.isEmpty {
                Section {
                    ForEach(databaseEntries, id: \.identity) { entry in
                        NavigationLink {
                            FeatureDatabaseScreen(api: api, databaseId: entry.databaseId, workspaceId: entry.workspaceId)
                        } label: {
                            MichiHairlineRow(
                                title: entry.title,
                                leading: { Image(systemName: "tablecells").foregroundStyle(tokens.muted) },
                                trailing: {
                                    HStack(spacing: 6) {
                                        if entry.count > 0 {
                                            Text("\(entry.count)").font(MichiFont.meta).foregroundStyle(tokens.muted)
                                        }
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint)
                                    }
                                }
                            )
                        }
                    }
                    ForEach(model.contentWorkspaces, id: \.designPagesWorkspaceIdentity) { workspace in
                        NavigationLink {
                            NativeHomeTaskDestination(api: api, workspaceID: workspace.id, viewID: nil)
                        } label: {
                            MichiHairlineRow(
                                title: "\(featureWorkspaceName(workspace)) tasks",
                                leading: { Image(systemName: "checklist").foregroundStyle(tokens.muted) },
                                trailing: { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                            )
                        }
                    }
                } header: {
                    MichiSectionHeader(title: "Databases")
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(tokens.bg)
            }

            if !model.contentWorkspaces.isEmpty {
                Section {
                    ForEach(model.contentWorkspaces, id: \.designPagesWorkspaceIdentity) { workspace in
                        NavigationLink {
                            FeaturePageTrashScreen(api: api, workspaceId: workspace.id, workspaces: workspaces)
                        } label: {
                            MichiHairlineRow(
                                title: "\(featureWorkspaceName(workspace)) trash",
                                leading: { Image(systemName: "trash").foregroundStyle(tokens.muted) },
                                trailing: { Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint) }
                            )
                        }
                    }
                } header: {
                    MichiSectionHeader(title: "Deleted pages")
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(tokens.bg)
            }
        }
        .michiPlainList()
        .navigationTitle("Pages")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                MichiGlassIconButton(systemImage: "plus", tinted: true, accessibility: "New Space") { model.prepareCreate() }
                    .disabled(model.contentWorkspaces.isEmpty)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("All workspaces") { model.workspaceFilter = nil }
                    ForEach(model.contentWorkspaces, id: \.designPagesWorkspaceIdentity) { workspace in
                        Button(featureWorkspaceName(workspace)) { model.workspaceFilter = workspace.id }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("Filter pages")
            }
        }
        .refreshable { await model.refresh(); await home.refresh() }
        .sheet(isPresented: $model.showingCreate, onDismiss: {
            if let page = model.createdPage {
                model.openedPage = FeatureOpenedPage(id: page.id, workspaceId: page["workspaceId"].stringValue)
                model.createdPage = nil
            }
        }) {
            FeatureCreateSpaceSheet(model: model)
        }
    }

    private var groupedPages: [DesignPagesDirectoryGroup] {
        DesignPageBatch.directoryGroups(model.filtered)
    }

    private func openReview(_ item: JSONValue) {
        let pageId = DesignPageBatch.homePageID(item)
        let workspaceId = item.featureWorkspaceKey
        guard !pageId.isEmpty, !workspaceId.isEmpty else { return }
        onOpenReview(FeatureOpenedPage(id: pageId, workspaceId: workspaceId))
    }

    private func spaceSubtitle(_ space: JSONValue) -> String? {
        if space["updatedAt"].isNull == false {
            return "Updated \(featureFormatDate(space["updatedAt"].featureOptionalNumber))"
        }
        return nil
    }

    private var databaseEntries: [DesignPagesDatabaseEntry] {
        home.allTasks["sources"].arrayValue.compactMap { source in
            let id = source["databaseId"].stringValue
            guard !id.isEmpty else { return nil }
            return DesignPagesDatabaseEntry(
                databaseId: id,
                workspaceId: source["workspaceId"].stringValue,
                title: source["workspaceName"].optionalString ?? source["name"].optionalString ?? "Tasks",
                count: source["rowCount"].intValue
            )
        }
    }
}

private struct DesignPagesDatabaseEntry: Identifiable {
    let databaseId: String
    let workspaceId: String
    let title: String
    let count: Int
    var identity: DesignPagesDatabaseIdentity { DesignPagesDatabaseIdentity(databaseId: databaseId, workspaceId: workspaceId) }
    var id: DesignPagesDatabaseIdentity { identity }
}
