import SwiftUI
import MichiCore

/// Spaces list, create, and page navigation. Placed in a TabView, so this view owns its stack.
struct SpacesScreen: View {
    let api: MichiAPI
    let workspaces: [JSONValue]

    @StateObject private var model: FeatureSpacesModel
    @StateObject private var home: FeatureSpacesHomeModel
    @State private var openedReview: FeatureOpenedPage?
    #if DEBUG
    @State private var didOpenPreviewPage = false
    #endif

    init(api: MichiAPI, workspaces: [JSONValue]) {
        self.api = api
        self.workspaces = workspaces
        _model = StateObject(wrappedValue: FeatureSpacesModel(api: api, workspaces: workspaces))
        _home = StateObject(wrappedValue: FeatureSpacesHomeModel(api: api, workspaces: workspaces))
    }

    var body: some View {
        NavigationStack {
            NativePagesDirectory(model: model, home: home, api: api, workspaces: workspaces, onOpenReview: { openedReview = $0 })
                .navigationDestination(item: $model.openedPage) { page in
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
                .navigationDestination(item: $openedReview) { page in
                    FeaturePageHistoryScreen(api: api, pageId: page.id, workspaceId: page.workspaceId, workspaces: workspaces)
                }
                .onChange(of: workspaces) { _, latest in
                    model.workspaces = latest
                    home.workspaces = latest
                }
                .task {
                    model.workspaces = workspaces
                    home.workspaces = workspaces
                    await model.refresh()
                    await home.refresh()
                    #if DEBUG
                    if !didOpenPreviewPage && ProcessInfo.processInfo.arguments.contains("--uitesting") && ProcessInfo.processInfo.arguments.contains("--preview-page") {
                    didOpenPreviewPage = true
                        model.openedPage = FeatureOpenedPage(id: "page-preview", workspaceId: "ws-preview")
                    }
                    #endif
                }
                .overlay {
                    if model.loading && model.spaces.isEmpty && home.home.isNull {
                        FeatureLoadingView(message: "Loading spaces")
                    }
                }
        }
    }

    private func isSpacesHome(_ page: FeatureOpenedPage) -> Bool {
        DesignPagesHomeIdentity(pageId: page.id, workspaceId: page.workspaceId)
            == DesignPagesHomeIdentity(pageId: home.homePage.id, workspaceId: home.homePage["workspaceId"].stringValue)
    }
}

private struct FeatureSpaceRow: View {
    let space: JSONValue

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(featureNamed(space, fallback: "Untitled Space"))
                .font(.headline)
            HStack(spacing: 8) {
                Label(space["workspaceName"].stringValue, systemImage: "folder")
                if space["pageCount"].intValue > 0 {
                    Label("\(space["pageCount"].intValue) pages", systemImage: "doc")
                }
                if space["databaseCount"].intValue > 0 {
                    Label("\(space["databaseCount"].intValue) db", systemImage: "tablecells")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            let children = featureStringList(space["childTitles"])
            if !children.isEmpty {
                Text(children.joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct FeatureCreateSpaceSheet: View {
    @ObservedObject var model: FeatureSpacesModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        NavigationStack {
            Form {
                Picker("Workspace", selection: $model.createWorkspaceId) {
                    ForEach(model.contentWorkspaces, id: \.id) { workspace in
                        Text(featureWorkspaceName(workspace)).tag(workspace.id)
                    }
                }
                .font(MichiFont.row)
                TextField("Title", text: $model.createTitle)
                    .font(MichiFont.row)
                    .textInputAutocapitalization(.sentences)
                Picker("Template", selection: $model.createTemplate) {
                    Text("Blank").tag("blank")
                    Text("Release").tag("release")
                    Text("Research").tag("research")
                    Text("Travel").tag("travel")
                }
                .font(MichiFont.row)
                if let error = model.createError {
                    FeatureStatusBanner(title: "Couldn’t create", message: error)
                }
            }
            .scrollContentBackground(.hidden)
            .background(tokens.bg)
            .navigationTitle("New Space")
            .navigationBarTitleDisplayMode(.inline)
            .michiToolbarBackground()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            if let page = await model.create() {
                                model.createdPage = page
                                dismiss()
                            }
                        }
                    }
                    .disabled(model.createTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.creating)
                }
            }
            .featureBusy(model.creating)
        }
    }
}

@MainActor
final class FeatureSpacesModel: ObservableObject {
    let api: MichiAPI
    @Published var workspaces: [JSONValue]

    @Published var spaces: [JSONValue] = []
    @Published var workspaceFilter: String?
    @Published var loading = false
    @Published var error: String?
    @Published var showingCreate = false
    @Published var creating = false
    @Published var createTitle = ""
    @Published var createWorkspaceId = ""
    @Published var createTemplate = "blank"
    @Published var createError: String?
    @Published var createdPage: JSONValue?
    @Published var openedPage: FeatureOpenedPage?

    init(api: MichiAPI, workspaces: [JSONValue]) {
        self.api = api
        self.workspaces = workspaces
        createWorkspaceId = workspaces.first?.id ?? ""
    }

    var contentWorkspaces: [JSONValue] {
        workspaces.filter { !$0.id.isEmpty }
    }

    var filtered: [JSONValue] {
        guard let workspaceFilter else { return spaces }
        return spaces.filter { $0["workspaceId"].stringValue == workspaceFilter }
    }

    var filterLabel: String {
        guard let workspaceFilter,
              let match = contentWorkspaces.first(where: { $0.id == workspaceFilter })
        else { return "All" }
        return featureWorkspaceName(match)
    }

    func prepareCreate() {
        createTitle = ""
        createTemplate = "blank"
        createError = nil
        if createWorkspaceId.isEmpty { createWorkspaceId = contentWorkspaces.first?.id ?? "" }
        showingCreate = true
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        var collected: [JSONValue] = []
        var cursor: String?
        var seen = Set<String>()
        do {
            repeat {
                var path = "/spaces"
                if let cursor {
                    path += "?cursor=\(FeatureAPI.segment(cursor))"
                }
                let payload = try await FeatureAPI.get(api, path)
                let items = featureItems(payload)
                collected.append(contentsOf: items)
                cursor = payload["nextCursor"].optionalString
                if let cursor {
                    if seen.contains(cursor) { throw FeatureRequestError(message: "Spaces pagination did not advance") }
                    seen.insert(cursor)
                }
            } while cursor != nil
            spaces = collected
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func create() async -> JSONValue? {
        let title = createTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !createWorkspaceId.isEmpty else { return nil }
        creating = true
        defer { creating = false }
        do {
            let page = featureUnwrap(try await FeatureAPI.send(
                api,
                "/workspaces/\(FeatureAPI.segment(createWorkspaceId))/pages",
                method: "POST",
                body: [
                    "title": .string(title),
                    "template": .string(createTemplate),
                ]
            ), "page")
            await refresh()
            createError = nil
            return page
        } catch {
            createError = featureErrorMessage(error)
            return nil
        }
    }
}
