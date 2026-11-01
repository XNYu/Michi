import Foundation
import Combine
import MichiCore

/// Opaque identifiers compare byte for byte; Swift `==` on String would let
/// distinct NFC and NFD spellings of an id select each other.
private func trashExact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

enum DesignTrashSegment: String, CaseIterable, Identifiable {
    case archived, deleted
    var id: String { rawValue }
    var title: String { self == .archived ? "Archived" : "Deleted" }
}

/// One restorable entry, by exact workspace and entity identity.
struct DesignTrashKey: Hashable {
    enum Kind: String {
        case trashGroup, deletedWorkspace, archivedGroup, archivedThread, archivedWorkspace, trashPage
        var segment: DesignTrashSegment {
            self == .trashGroup || self == .deletedWorkspace || self == .trashPage ? .deleted : .archived
        }
        /// Permanent deletion uses the store's conditional purge; archived
        /// threads and workspaces have no purge of their own here.
        var canPurge: Bool { self == .trashGroup || self == .deletedWorkspace || self == .archivedGroup || self == .trashPage }
    }
    let kind: Kind
    let workspaceID: String
    let entityID: String
    /// Page id for `.trashPage`; empty for chat/workspace keys.
    let qualifier: String

    init(kind: Kind, workspaceID: String, entityID: String, qualifier: String = "") {
        self.kind = kind
        self.workspaceID = workspaceID
        self.entityID = entityID
        self.qualifier = qualifier
    }

    static func == (a: Self, b: Self) -> Bool {
        a.kind == b.kind && trashExact(a.workspaceID, b.workspaceID) && trashExact(a.entityID, b.entityID) && trashExact(a.qualifier, b.qualifier)
    }
    func hash(into hasher: inout Hasher) {
        hasher.combine(kind.rawValue); hasher.combine(Data(workspaceID.utf8)); hasher.combine(Data(entityID.utf8)); hasher.combine(Data(qualifier.utf8))
    }
}

enum DesignTrashPayload {
    case group(DeletionGroup)
    case workspace(WorkspaceGraph)
    case thread(tree: JSONValue, graph: WorkspaceGraph)
    case page(JSONValue)
}

struct DesignTrashItem: Identifiable {
    let key: DesignTrashKey
    let payload: DesignTrashPayload
    var id: DesignTrashKey { key }
    var canPurge: Bool { key.kind.canPurge }
    var title: String {
        switch payload {
        case .group(let group): return group.title
        case .workspace(let graph): return graph.name.isEmpty ? "Untitled workspace" : graph.name
        case .thread(let tree, let graph): return graph.threadTitle(tree)
        case .page(let group): return DesignTrashPages.title(group)
        }
    }
}

struct DesignTrashSectionID: Hashable {
    let raw: String
    static func == (a: Self, b: Self) -> Bool { trashExact(a.raw, b.raw) }
    func hash(into hasher: inout Hasher) { hasher.combine(Data(raw.utf8)) }
}

struct DesignTrashSection: Identifiable {
    let id: DesignTrashSectionID
    let title: String
    let items: [DesignTrashItem]
}

enum DesignTrashCatalog {
    /// Deleted: thread groups of live workspaces, then that workspace's deleted
    /// page groups, then deleted workspaces. Archived: archived workspaces, and
    /// for writable workspaces their archived threads and archived branches.
    /// Archived workspaces show only the workspace itself.
    static func sections(_ graphs: [WorkspaceGraph], segment: DesignTrashSegment, pages: DesignTrashPagesSnapshot = .empty) -> [DesignTrashSection] {
        let user = graphs.filter { !$0.isSystem }
        switch segment {
        case .deleted:
            var sections: [DesignTrashSection] = user.filter { !$0.isDeleted }.compactMap { graph in
                var items = graph.deletionGroups(archive: false).map {
                    DesignTrashItem(key: DesignTrashKey(kind: .trashGroup, workspaceID: graph.id, entityID: $0.id), payload: .group($0))
                }
                items += pages.groups(for: graph.id).compactMap { DesignTrashPages.item($0, workspaceID: graph.id) }
                return items.isEmpty ? nil : DesignTrashSection(id: DesignTrashSectionID(raw: "workspace:" + graph.id), title: graph.name, items: items)
            }
            let workspaces = user.filter(\.isDeleted).map {
                DesignTrashItem(key: DesignTrashKey(kind: .deletedWorkspace, workspaceID: $0.id, entityID: $0.id), payload: .workspace($0))
            }
            if !workspaces.isEmpty {
                sections.append(DesignTrashSection(id: DesignTrashSectionID(raw: "deleted-workspaces"), title: "Deleted workspaces", items: workspaces))
            }
            return sections
        case .archived:
            return user.filter { !$0.isDeleted }.compactMap { graph in
                var items: [DesignTrashItem] = []
                if graph.isArchived {
                    items.append(DesignTrashItem(key: DesignTrashKey(kind: .archivedWorkspace, workspaceID: graph.id, entityID: graph.id), payload: .workspace(graph)))
                } else {
                    items += graph.archivedTrees.map {
                        DesignTrashItem(key: DesignTrashKey(kind: .archivedThread, workspaceID: graph.id, entityID: $0.id), payload: .thread(tree: $0, graph: graph))
                    }
                    items += graph.deletionGroups(archive: true).map {
                        DesignTrashItem(key: DesignTrashKey(kind: .archivedGroup, workspaceID: graph.id, entityID: $0.id), payload: .group($0))
                    }
                }
                return items.isEmpty ? nil : DesignTrashSection(id: DesignTrashSectionID(raw: "workspace:" + graph.id), title: graph.name, items: items)
            }
        }
    }

    /// The entry with this exact key in the given snapshot, if it is still listed.
    static func resolve(_ key: DesignTrashKey, in graphs: [WorkspaceGraph], pages: DesignTrashPagesSnapshot = .empty) -> DesignTrashItem? {
        for section in sections(graphs, segment: key.kind.segment, pages: pages) {
            if let item = section.items.first(where: { $0.key == key }) { return item }
        }
        return nil
    }
}

/// The store's lifecycle methods each check hydration, one change at a time,
/// and (except the workspace flag writes) re-read the workspace before writing.
@MainActor protocol DesignTrashOperations: AnyObject {
    var graphs: [WorkspaceGraph] { get }
    var hydrated: Bool { get }
    var lifecycleBusy: Bool { get }
    /// Reloads the saved snapshot; false when it could not be read.
    func refreshTrashSnapshot() async -> Bool
    func restoreGroup(_ group: DeletionGroup) async throws -> String
    func purgeGroup(_ group: DeletionGroup) async throws
    func restoreWorkspace(_ graph: WorkspaceGraph) async throws
    func purgeWorkspace(_ graph: WorkspaceGraph) async throws
    func archiveTree(_ tree: JSONValue, archived: Bool) async throws
    func setWorkspaceArchived(_ graph: WorkspaceGraph, archived: Bool) async throws
    var pageSnapshot: DesignTrashPagesSnapshot { get }
    func restorePageGroup(_ group: JSONValue, workspaceID: String) async throws
    func purgePageGroup(_ group: JSONValue, workspaceID: String) async throws
}

extension DesignTrashOperations {
    var pageSnapshot: DesignTrashPagesSnapshot { .empty }
    func restorePageGroup(_ group: JSONValue, workspaceID: String) async throws {
        throw NativeFailure("This item can only be restored here.")
    }
    func purgePageGroup(_ group: JSONValue, workspaceID: String) async throws {
        throw NativeFailure("This item can only be restored here.")
    }
}

extension MichiStore: DesignTrashOperations {
    func refreshTrashSnapshot() async -> Bool {
        await reload()
        return hydrated && error == nil
    }
}

enum DesignTrashBatchAction: Equatable {
    case restore, purge
}

enum DesignTrashBatchOutcome: Equatable {
    case completed(count: Int, action: DesignTrashBatchAction)
    /// Stopped at `title`, which raised a known error. Later items were not sent.
    case failed(completed: Int, title: String, message: String)
    /// The request for `title` has no confirmed result. It was not retried.
    case unknown(completed: Int, title: String, message: String)
    /// `title` changed or disappeared before its turn; nothing was sent for it.
    case unavailable(completed: Int, title: String)
    case cancelled(completed: Int, remaining: Int)
    /// Refused before any request.
    case refused(String)

    var message: String {
        switch self {
        case .completed(let count, let action):
            return "\(action == .restore ? "Restored" : "Permanently deleted") \(count) item\(count == 1 ? "" : "s")."
        case .failed(let completed, let title, let message):
            return "Stopped at “\(title)” after \(completed) item\(completed == 1 ? "" : "s"): \(message) Items after it were not changed."
        case .unknown(let completed, let title, let message):
            return "The result for “\(title)” couldn't be confirmed (\(message)), and it was not retried. \(completed) item\(completed == 1 ? "" : "s") finished before it; items after it were not changed. Check its current state before trying again."
        case .unavailable(let completed, let title):
            return "“\(title)” changed on another device, so Michi stopped after \(completed) item\(completed == 1 ? "" : "s"). Nothing was sent for it or the items after it."
        case .cancelled(let completed, let remaining):
            return "Stopped after \(completed) item\(completed == 1 ? "" : "s"). \(remaining) item\(remaining == 1 ? " was" : "s were") not changed."
        case .refused(let message):
            return message
        }
    }
}

/// Multi-select restore and permanent delete. Items run one at a time in the
/// displayed order, each re-resolved by exact identity from a fresh snapshot
/// just before its request. The batch stops at the first failure, never
/// retries, and Stop takes effect only between requests.
@MainActor final class DesignTrashBatchModel: ObservableObject {
    @Published private(set) var segment: DesignTrashSegment
    @Published private(set) var selecting = false
    @Published private(set) var selection: [DesignTrashKey] = []
    @Published private(set) var running: DesignTrashBatchAction?
    @Published private(set) var completedInRun = 0
    @Published private(set) var totalInRun = 0
    @Published private(set) var stopRequested = false
    @Published private(set) var outcome: DesignTrashBatchOutcome?

    init(segment: DesignTrashSegment = .deleted) { self.segment = segment }

    func setSegment(_ next: DesignTrashSegment) {
        guard running == nil, next != segment else { return }
        segment = next; selection = []; outcome = nil
    }
    func setSelecting(_ on: Bool) {
        guard running == nil else { return }
        selecting = on
        if !on { selection = [] }
    }
    func isSelected(_ key: DesignTrashKey) -> Bool { selection.contains(key) }
    func toggle(_ key: DesignTrashKey) {
        guard running == nil, selecting, key.kind.segment == segment else { return }
        if let index = selection.firstIndex(of: key) { selection.remove(at: index) } else { selection.append(key) }
    }
    func selectAll(_ sections: [DesignTrashSection]) {
        guard running == nil, selecting else { return }
        selection = sections.flatMap(\.items).map(\.key).filter { $0.kind.segment == segment }
    }
    func deselectAll() { if running == nil { selection = [] } }
    func clearOutcome() { if running == nil { outcome = nil } }

    /// The selected entries still listed, in display order.
    func selectedItems(in sections: [DesignTrashSection]) -> [DesignTrashItem] {
        sections.flatMap(\.items).filter { selection.contains($0.key) }
    }
    func canRun(_ action: DesignTrashBatchAction, items: [DesignTrashItem], operations: DesignTrashOperations) -> Bool {
        running == nil && operations.hydrated && !operations.lifecycleBusy && !items.isEmpty
            && (action == .restore || items.allSatisfy(\.canPurge))
    }

    func requestStop() {
        guard running != nil else { return }
        stopRequested = true
    }

    func start(_ action: DesignTrashBatchAction, operations: DesignTrashOperations, confirmedPermanentDeletion: Bool = false) {
        guard running == nil else { return }
        Task { await perform(action, operations: operations, confirmedPermanentDeletion: confirmedPermanentDeletion) }
    }

    @discardableResult
    func perform(_ action: DesignTrashBatchAction, operations: DesignTrashOperations, confirmedPermanentDeletion: Bool = false) async -> DesignTrashBatchOutcome {
        guard running == nil else { return .refused("Another batch is still running.") }
        guard operations.hydrated, !operations.lifecycleBusy else {
            return finish(.refused("Wait for your workspaces to load and for other changes to finish."))
        }
        let items = selectedItems(in: DesignTrashCatalog.sections(operations.graphs, segment: segment, pages: operations.pageSnapshot))
        guard !items.isEmpty else { return finish(.refused("Select at least one item.")) }
        if action == .purge {
            guard confirmedPermanentDeletion else { return finish(.refused("Confirm permanent deletion first.")) }
            guard items.allSatisfy(\.canPurge) else {
                return finish(.refused("Archived threads and workspaces can only be restored here. Deselect them to delete the rest permanently."))
            }
        }
        // Exact keys and their titles as the user confirmed them.
        let planned = items.map { (key: $0.key, title: $0.title) }
        running = action; stopRequested = false; outcome = nil; completedInRun = 0; totalInRun = planned.count
        defer { running = nil; stopRequested = false }
        var completed = 0
        for (index, entry) in planned.enumerated() {
            if stopRequested { return finish(.cancelled(completed: completed, remaining: planned.count - index)) }
            guard await operations.refreshTrashSnapshot() else {
                return finish(.failed(completed: completed, title: entry.title, message: "Michi couldn't read the latest saved state, so nothing was sent for it."))
            }
            if entry.key.kind == .trashPage, operations.pageSnapshot.refreshFailed(for: entry.key.workspaceID) {
                return finish(.failed(completed: completed, title: entry.title, message: "Michi couldn't read the latest saved state, so nothing was sent for it."))
            }
            if stopRequested { return finish(.cancelled(completed: completed, remaining: planned.count - index)) }
            guard let item = DesignTrashCatalog.resolve(entry.key, in: operations.graphs, pages: operations.pageSnapshot), action == .restore || item.canPurge else {
                return finish(.unavailable(completed: completed, title: entry.title))
            }
            do {
                try await run(action, item, operations)
            } catch {
                let message = featureErrorMessage(error)
                let result: DesignTrashBatchOutcome = Self.isKnownFailure(error)
                    ? .failed(completed: completed, title: entry.title, message: message)
                    : .unknown(completed: completed, title: entry.title, message: message)
                _ = await operations.refreshTrashSnapshot() // Read-only, so the list shows the saved state.
                return finish(result)
            }
            completed += 1; completedInRun = completed
            selection.removeAll { $0 == entry.key }
        }
        if selection.isEmpty { selecting = false }
        return finish(.completed(count: completed, action: action))
    }

    private func run(_ action: DesignTrashBatchAction, _ item: DesignTrashItem, _ operations: DesignTrashOperations) async throws {
        switch (action, item.payload) {
        case (.restore, .group(let group)): _ = try await operations.restoreGroup(group)
        case (.restore, .workspace(let graph)):
            if item.key.kind == .archivedWorkspace { try await operations.setWorkspaceArchived(graph, archived: false) }
            else { try await operations.restoreWorkspace(graph) }
        case (.restore, .thread(let tree, _)): try await operations.archiveTree(tree, archived: false)
        case (.restore, .page(let group)): try await operations.restorePageGroup(group, workspaceID: item.key.workspaceID)
        case (.purge, .group(let group)): try await operations.purgeGroup(group)
        case (.purge, .workspace(let graph)) where item.key.kind == .deletedWorkspace: try await operations.purgeWorkspace(graph)
        case (.purge, .page(let group)): try await operations.purgePageGroup(group, workspaceID: item.key.workspaceID)
        case (.purge, _): throw NativeFailure("This item can only be restored here.")
        }
    }

    /// A refusal the client or server reported. Anything else, including a
    /// lost response or a cancelled request, may have been applied.
    static func isKnownFailure(_ error: Error) -> Bool {
        if error is NativeFailure { return true }
        guard let failure = error as? MichiAPIError else { return false }
        if let status = failure.statusCode {
            return (400..<500).contains(status) && failure.code != MichiAPIError.Code.htmlResponse && failure.code != MichiAPIError.Code.invalidResponse
        }
        return [MichiAPIError.Code.invalidConfiguration, MichiAPIError.Code.invalidPath, MichiAPIError.Code.invalidRequest,
                MichiAPIError.Code.insecureURL].contains(failure.code ?? "")
    }

    private func finish(_ result: DesignTrashBatchOutcome) -> DesignTrashBatchOutcome {
        outcome = result
        return result
    }
}
