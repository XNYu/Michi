import Foundation
import Combine
import MichiCore

/// Compound identity for one deleted page group: workspace + deletion group +
/// the page id FeaturePageTrashModel would restore or purge. Compared as UTF-8
/// so NFC and NFD spellings never select each other.
struct DesignTrashPagesIdentity: Hashable {
    let workspaceID: DesignPageOpaqueID
    let deletionGroupID: DesignPageOpaqueID
    let pageID: DesignPageOpaqueID

    init(workspaceID: String, deletionGroupID: String, pageID: String) {
        self.workspaceID = DesignPageOpaqueID(raw: workspaceID)
        self.deletionGroupID = DesignPageOpaqueID(raw: deletionGroupID)
        self.pageID = DesignPageOpaqueID(raw: pageID)
    }
}

struct DesignTrashPagesRef: Identifiable {
    let identity: DesignTrashPagesIdentity
    let group: JSONValue
    var id: DesignTrashPagesIdentity { identity }
}

struct DesignTrashPagesWorkspace: Identifiable {
    let id: DesignPageOpaqueID
    let name: String
    let groups: [JSONValue]
    let error: String?
}

struct DesignTrashPagesError: Identifiable {
    let id: DesignPageOpaqueID
    let workspaceName: String
    let message: String
}

struct DesignTrashPagesSnapshot {
    var workspaces: [DesignTrashPagesWorkspace]
    static let empty = DesignTrashPagesSnapshot(workspaces: [])

    var errors: [DesignTrashPagesError] {
        workspaces.compactMap { workspace in
            guard let message = workspace.error, !message.isEmpty else { return nil }
            return DesignTrashPagesError(id: workspace.id, workspaceName: workspace.name, message: message)
        }
    }
    var hasGroups: Bool { workspaces.contains { !$0.groups.isEmpty } }

    func workspace(matching id: String) -> DesignTrashPagesWorkspace? {
        workspaces.first { DesignPageOpaqueID.same($0.id.raw, id) }
    }
    func groups(for workspaceID: String) -> [JSONValue] {
        workspace(matching: workspaceID)?.groups ?? []
    }
    func refreshFailed(for workspaceID: String) -> Bool {
        workspace(matching: workspaceID)?.error != nil
    }
}

/// Read, restore, and purge contracts used by FeaturePageTrashModel
/// (SpacesHomeModel.swift). Paths, empty bodies, pagination, and restored /
/// purged id checks are the same; writes throw so the trash batch can classify
/// known vs unconfirmed outcomes.
enum DesignTrashPages {
    /// Same page id FeaturePageTrashModel.restore / purge send.
    static func actionPageID(_ group: JSONValue) -> String {
        group["root"].id.isEmpty ? group["pages"].arrayValue.first?.id ?? "" : group["root"].id
    }
    static func deletionGroupID(_ group: JSONValue) -> String { group["deletionGroupId"].stringValue }
    static func title(_ group: JSONValue) -> String { featureNamed(group["root"], fallback: "Deleted page") }
    static func deletedAt(_ group: JSONValue) -> Double { group["deletedAt"].doubleValue }

    static func identity(_ group: JSONValue, workspaceID: String) -> DesignTrashPagesIdentity {
        DesignTrashPagesIdentity(workspaceID: workspaceID, deletionGroupID: deletionGroupID(group), pageID: actionPageID(group))
    }
    static func key(_ group: JSONValue, workspaceID: String) -> DesignTrashKey {
        DesignTrashKey(kind: .trashPage, workspaceID: workspaceID, entityID: deletionGroupID(group), qualifier: actionPageID(group))
    }
    static func item(_ group: JSONValue, workspaceID: String) -> DesignTrashItem? {
        let pageID = actionPageID(group), groupID = deletionGroupID(group)
        guard !pageID.isEmpty, !groupID.isEmpty else { return nil }
        return DesignTrashItem(key: key(group, workspaceID: workspaceID), payload: .page(group))
    }

    static func restore(_ group: JSONValue, api: MichiAPI) async throws {
        let pageId = actionPageID(group)
        guard !pageId.isEmpty else { throw NativeFailure("Pages did not identify this deleted page.") }
        let result = try await FeatureAPI.send(api, featurePageRestorePath(pageId), method: "POST", body: [:])
        try featureRequireRestoredPageIds(result, pageId: pageId)
    }

    static func purge(_ group: JSONValue, api: MichiAPI) async throws {
        let pageId = actionPageID(group)
        guard !pageId.isEmpty else { throw NativeFailure("Pages did not identify this deleted page.") }
        let result = try await FeatureAPI.send(api, featurePagePurgePath(pageId), method: "DELETE", body: [:])
        try featureRequirePurgedPageIds(result, pageId: pageId)
    }
}

/// One FeaturePageTrashModel per live workspace, keyed by exact UTF-8 id.
@MainActor
final class DesignTrashPagesModel: ObservableObject {
    @Published private(set) var snapshot = DesignTrashPagesSnapshot.empty
    @Published private(set) var loading = false
    @Published private(set) var saving = false
    private var api: MichiAPI?
    private var models: [DesignPageOpaqueID: FeaturePageTrashModel] = [:]

    func refresh(api: MichiAPI, graphs: [WorkspaceGraph]) async {
        self.api = api
        loading = true
        defer { loading = false }
        let targets = graphs.filter { !$0.isSystem && !$0.isDeleted }
        var next: [DesignPageOpaqueID: FeaturePageTrashModel] = [:]
        var workspaces: [DesignTrashPagesWorkspace] = []
        for graph in targets {
            let key = DesignPageOpaqueID(raw: graph.id)
            let model = models[key] ?? FeaturePageTrashModel(api: api, workspaceId: graph.id)
            next[key] = model
            await model.refresh()
            workspaces.append(DesignTrashPagesWorkspace(id: key, name: graph.name, groups: model.groups, error: model.error))
        }
        models = next
        snapshot = DesignTrashPagesSnapshot(workspaces: workspaces)
    }

    func restore(_ group: JSONValue, workspaceID: String) async throws {
        try await mutate(group, workspaceID: workspaceID, DesignTrashPages.restore)
    }
    func purge(_ group: JSONValue, workspaceID: String) async throws {
        try await mutate(group, workspaceID: workspaceID, DesignTrashPages.purge)
    }

    private func mutate(_ group: JSONValue, workspaceID: String, _ write: (JSONValue, MichiAPI) async throws -> Void) async throws {
        guard let api else { throw NativeFailure("Pages trash has not loaded yet.") }
        guard !saving else { throw NativeFailure("Another page change is still being saved.") }
        saving = true
        defer { saving = false }
        try await write(group, api)
        if let model = model(for: workspaceID) {
            await model.refresh()
            rewriteSnapshot(from: model)
        }
    }

    private func model(for workspaceID: String) -> FeaturePageTrashModel? {
        models.first { DesignPageOpaqueID.same($0.key.raw, workspaceID) }?.value
    }

    private func rewriteSnapshot(from model: FeaturePageTrashModel) {
        snapshot.workspaces = snapshot.workspaces.map { workspace in
            guard DesignPageOpaqueID.same(workspace.id.raw, model.workspaceId) else { return workspace }
            return DesignTrashPagesWorkspace(id: workspace.id, name: workspace.name, groups: model.groups, error: model.error)
        }
    }
}

/// Store lifecycle plus page trash. Chat snapshot failure still fails the
/// combined refresh; page errors stay on the page snapshot and do not clear graphs.
@MainActor
final class DesignTrashScreenOperations: DesignTrashOperations {
    let store: MichiStore
    let pages: DesignTrashPagesModel

    init(store: MichiStore, pages: DesignTrashPagesModel) {
        self.store = store
        self.pages = pages
    }

    var graphs: [WorkspaceGraph] { store.graphs }
    var hydrated: Bool { store.hydrated }
    var lifecycleBusy: Bool { store.lifecycleBusy }
    var pageSnapshot: DesignTrashPagesSnapshot { pages.snapshot }

    func refreshTrashSnapshot() async -> Bool {
        let chatOK = await store.refreshTrashSnapshot()
        await pages.refresh(api: store.api, graphs: store.graphs)
        return chatOK
    }
    func restoreGroup(_ group: DeletionGroup) async throws -> String { try await store.restoreGroup(group) }
    func purgeGroup(_ group: DeletionGroup) async throws { try await store.purgeGroup(group) }
    func restoreWorkspace(_ graph: WorkspaceGraph) async throws { try await store.restoreWorkspace(graph) }
    func purgeWorkspace(_ graph: WorkspaceGraph) async throws { try await store.purgeWorkspace(graph) }
    func archiveTree(_ tree: JSONValue, archived: Bool) async throws { try await store.archiveTree(tree, archived: archived) }
    func setWorkspaceArchived(_ graph: WorkspaceGraph, archived: Bool) async throws {
        try await store.setWorkspaceArchived(graph, archived: archived)
    }
    func restorePageGroup(_ group: JSONValue, workspaceID: String) async throws {
        try await pages.restore(group, workspaceID: workspaceID)
    }
    func purgePageGroup(_ group: JSONValue, workspaceID: String) async throws {
        try await pages.purge(group, workspaceID: workspaceID)
    }
}
