import Foundation
import SwiftUI
import MichiCore

struct WorkspaceGraph: Identifiable {
    var raw: JSONValue
    var workspace: JSONValue { raw["workspace"] }
    var id: String { workspace.id }
    var name: String { workspace["name"].stringValue }
    var nodes: [JSONValue] { raw["nodes"].arrayValue }
    var trees: [JSONValue] { raw["trees"].arrayValue }
    var edges: [JSONValue] { raw["edges"].arrayValue }
    var contexts: [JSONValue] { raw["contexts"].arrayValue }
    var isDeleted: Bool { !workspace["deleted_at"].isNull }
    var isArchived: Bool { !workspace["archived_at"].isNull }
    var isSystem: Bool { !workspace["settings"].parsedJSON["system"].stringValue.isEmpty }
    func node(_ id: String) -> JSONValue? { nodes.first { $0.id == id } }
    func title(_ node: JSONValue) -> String { node["title"].stringValue.isEmpty ? "New conversation" : node["title"].stringValue }
    func visibleNodes(tree: String? = nil) -> [JSONValue] {
        nodes.filter { $0["deleted_at"].isNull && (tree == nil || $0["tree_id"].stringValue == tree) }
    }
    func branchRows(tree: String) -> [(node: JSONValue, depth: Int)] {
        let candidates = visibleNodes(tree: tree).enumerated().sorted { a, b in
            let ap = a.element["pinned_at"], bp = b.element["pinned_at"]
            if ap.isNull != bp.isNull { return !ap.isNull }
            if !ap.isNull && ap.doubleValue != bp.doubleValue { return ap.doubleValue > bp.doubleValue }
            return a.offset < b.offset
        }.map(\.element)
        let ids = Set(candidates.map(\.id)); var visited = Set<String>(); var result: [(JSONValue, Int)] = []
        func walk(_ node: JSONValue, _ depth: Int) {
            guard visited.insert(node.id).inserted else { return }
            result.append((node, depth))
            candidates.filter { $0["parent_node_id"].stringValue == node.id }.forEach { walk($0, depth + 1) }
        }
        candidates.filter { !ids.contains($0["parent_node_id"].stringValue) }.forEach { walk($0, 0) }
        candidates.filter { !visited.contains($0.id) }.forEach { walk($0, 0) }
        return result
    }
}

@MainActor final class MichiStore: ObservableObject {
    let api: MichiAPI
    @Published var graphs: [WorkspaceGraph] = []
    @Published var selectedWorkspaceID: String?
    @Published var selectedNodeID: String?
    @Published var loading = false
    @Published var hydrated = false
    @Published var error: String?
    @Published private(set) var searchResults: [NativeSearchResult] = []
    @Published private(set) var searchQuery = ""
    @Published private(set) var searchLoading = false
    @Published private(set) var searchCompleted = false
    @Published private(set) var searchError: String?
    @Published private(set) var openingSearchResult = false
    @Published var customAgentsEnabled = false
    @Published var synchronizationError: String?
    var onScheduledJobRun: ((JSONValue) -> Void)?
    /// One lifecycle change at a time, so a repeated tap sends nothing.
    @Published private(set) var lifecycleBusy = false
    /// Tree ids kept across an uncertain extraction so a retry finds the committed result.
    private var pendingExtractions: [String: String] = [:]
    private var snapshotGeneration = 0
    private var lastSnapshotSucceeded = false
    private var observerCursors: [String: JSONValue] = [:]
    private var observerTask: Task<Void, Never>?
    private var observerIdentity: UUID?
    private var chats: [String: ChatController] = [:]
    private var searchTask: Task<Void, Never>?
    private var searchIdentity = UUID()
    private var reloadTask: Task<Void, Never>?
    private var reloadAgain = false
    var visibleGraphs: [WorkspaceGraph] { graphs.filter { !$0.isDeleted && !$0.isArchived && !$0.isSystem } }
    var workspaceRows: [JSONValue] { visibleGraphs.map(\.workspace) }
    var selectedGraph: WorkspaceGraph? { graphs.first { $0.id == selectedWorkspaceID } }
    init(api: MichiAPI) { self.api = api }
    deinit { searchTask?.cancel() }
    func reload() async {
        if let reloadTask { reloadAgain = true; await reloadTask.value; return }
        let task = Task {
            repeat { reloadAgain = false; await fetchSnapshot() } while reloadAgain
        }
        reloadTask = task; await task.value; reloadTask = nil
    }
    private func fetchSnapshot() async {
        loading = true; defer { loading = false }
        do {
            let answer = try await api.request("/workspaces/all?meta=1")
            guard case .array(let records) = answer["workspaces"], records.allSatisfy({ !$0["workspace"].id.isEmpty }) else {
                throw NativeFailure("Michi returned an invalid workspace snapshot. Your existing data has been kept.")
            }
            graphs = records.map { WorkspaceGraph(raw: $0) }; hydrated = true; error = nil; snapshotGeneration += 1; lastSnapshotSucceeded = true
            for (id, controller) in chats {
                if let updatedGraph = graph(for: id), let updatedNode = updatedGraph.node(id) { controller.refresh(graph: updatedGraph, node: updatedNode) }
                else { controller.detach(); chats.removeValue(forKey: id) }
            }
            if selectedWorkspaceID == nil { selectedWorkspaceID = visibleGraphs.first?.id }
            if let status = try? await api.request("/agent/status") { customAgentsEnabled = status["customAgentsEnabled"].boolValue }
        } catch { self.error = error.localizedDescription; lastSnapshotSucceeded = false }
    }
    func graph(for nodeID: String) -> WorkspaceGraph? { graphs.first { $0.node(nodeID) != nil } }
    func select(_ node: JSONValue, workspace: String) {
        selectedWorkspaceID = workspace; selectedNodeID = node.id
    }
    func existingChat(for nodeID: String) -> ChatController? { chats[nodeID] }
    /// Home and Search increment this instead of pushing on `selectedNodeID`.
    /// NativeShell switches to Chats; only that tab should present the conversation.
    @Published private(set) var chatsPresentationEpoch = 0
    func presentConversation(_ node: JSONValue, workspace: String) {
        select(node, workspace: workspace)
        chatsPresentationEpoch += 1
    }
    func chat(for nodeID: String) -> ChatController? {
        if let existing = chats[nodeID] { return existing }
        guard let graph = graph(for: nodeID), let node = graph.node(nodeID) else { return nil }
        let controller = ChatController(api: api, graph: graph, node: node)
        controller.onGraphChanged = { [weak self] in Task { await self?.reload() } }
        chats[nodeID] = controller
        return controller
    }
    func disconnectStreams() {
        observerTask?.cancel(); observerTask = nil; observerIdentity = nil
        chats.values.forEach { $0.detach() }
    }
    func resumeStreams() { chats.values.forEach { $0.resumeIfNeeded() }; startObserving() }

    /// A connection-wide observer discovers turns started on another device.
    /// Those turns then use the same durable replay path as local turns.
    private func durableCursor(_ node: JSONValue) -> JSONValue? {
        guard let turn = node["last_applied_turn_id"].optionalString, !turn.isEmpty,
              case .number(let sequence) = node["last_applied_seq"], sequence >= 0, sequence.rounded(.down) == sequence else { return nil }
        return ["turnId": .string(turn), "seq": .number(sequence)]
    }
    private func reconcileObservedNode(_ id: String, required: JSONValue? = nil) async throws {
        guard let node = graph(for: id)?.node(id) else { throw NativeFailure("Live synchronization is waiting for the saved conversation.") }
        let cursor = durableCursor(node)
        if let required {
            guard let cursor, cursor["turnId"] == required["turnId"],
                  !required["seq"].isNull, cursor["seq"].intValue >= required["seq"].intValue else {
                throw NativeFailure("The saved conversation has not reached the replay checkpoint yet.")
            }
        }
        if let controller = chats[id] {
            guard await controller.load() else { throw NativeFailure("Live synchronization could not refresh this conversation.") }
        }
        // Only this node passed its own history barrier. Cursors for every
        // other cached conversation remain unchanged, even across app suspension.
        if let cursor { observerCursors[id] = cursor }
    }
    func startObserving() {
        guard observerTask == nil, hydrated else { return }
        let identity = UUID(); observerIdentity = identity
        observerTask = Task { [weak self] in
            guard let self else { return }
            defer { if observerIdentity == identity { observerTask = nil } }
            var attempt = 0
            while !Task.isCancelled && observerIdentity == identity {
                do {
                    // A controller with no established observer cursor needs
                    // a history barrier before its first subscription, too.
                    let unseeded = chats.keys.filter { self.observerCursors[$0] == nil }
                    if !unseeded.isEmpty {
                        let previous = snapshotGeneration
                        await reload()
                        guard lastSnapshotSucceeded, snapshotGeneration > previous else { throw NativeFailure("Live synchronization could not refresh the saved workspace.") }
                        for id in unseeded { try await reconcileObservedNode(id) }
                    }
                    for graph in graphs {
                        for node in graph.nodes where chats[node.id] == nil && observerCursors[node.id] == nil {
                            if let cursor = durableCursor(node) { observerCursors[node.id] = cursor }
                        }
                    }
                    for try await frame in api.stream("/chats/background/subscribe", method: "POST", body: ["cursors": .object(observerCursors), "includeForeground": true]) {
                        guard !Task.isCancelled, observerIdentity == identity else { return }
                        synchronizationError = nil; attempt = 0
                        let event = frame.event == "foreground_event" ? frame.data["event"].stringValue : frame.event
                        let data = frame.event == "foreground_event" ? frame.data["data"] : frame.data
                        if event == "scheduled_job_run" { onScheduledJobRun?(data) }
                        let nodeID = data["nodeId"].optionalString ?? data["chatId"].stringValue
                        let isGap = event == "background_sync_required"
                        let isCheckpoint = ["turn_start", "done", "error", "title", "spawn_branches", "artifact_saved", "artifact_updated", "scheduled_job_run", "scheduled_jobs_changed"].contains(event)
                        guard isGap || isCheckpoint else { continue }
                        let previous = snapshotGeneration
                        await reload()
                        guard lastSnapshotSucceeded, snapshotGeneration > previous else { throw NativeFailure("Live synchronization could not refresh the saved workspace.") }
                        if !nodeID.isEmpty { try await reconcileObservedNode(nodeID, required: isGap ? data : nil) }
                    }
                    if !Task.isCancelled { synchronizationError = "Live connection interrupted. Reconnecting…" }
                } catch let failure as MichiAPIError where failure.statusCode.map({ (400..<500).contains($0) }) == true {
                    synchronizationError = failure.localizedDescription; return
                } catch {
                    if Task.isCancelled { return }; synchronizationError = error.localizedDescription
                }
                attempt = min(attempt + 1, 5)
                do { try await Task.sleep(for: .seconds(min(15, 1 << attempt))) } catch { return }
            }
        }
    }
    @discardableResult func command(workspace: String, type: String, payload: JSONValue) async throws -> JSONValue {
        try await sendCommands(workspace: workspace, [["type": .string(type), "payload": payload]])
    }
    @discardableResult func sendCommands(workspace: String, _ commands: [JSONValue]) async throws -> JSONValue {
        guard hydrated else { throw NativeFailure("Wait for your workspaces to load before making changes.") }
        return try await api.request("/workspaces/\(MichiAPI.pathSegment(workspace))/commands", method: "POST", body: [
            "operationId": .string(UUID().uuidString), "commands": .array(commands)
        ])
    }
    func createWorkspace(name: String, cwd: String) async throws {
        let id = "ws-" + UUID().uuidString.lowercased()
        _ = try await command(workspace: id, type: "workspace.upsert", payload: ["id": .string(id), "name": .string(name), "cwd": cwd.isEmpty ? .null : .string(cwd), "created_at": .number(Date().timeIntervalSince1970 * 1000)])
        selectedWorkspaceID = id; await reload()
    }
    func createThread(in graph: WorkspaceGraph, parent: JSONValue? = nil, anchor: String? = nil, title: String = "") async throws -> String {
        guard hydrated && !graph.isDeleted && !graph.isArchived else { throw NativeFailure("This workspace is read-only.") }
        if let parent, !parent["deleted_at"].isNull || graph.trees.contains(where: { $0.id == parent["tree_id"].stringValue && !$0["archived_at"].isNull }) { throw NativeFailure("Archived conversations are read-only.") }
        let answer = try await api.request("/node-ids/allocate", method: "POST", body: ["count": 1])
        guard let id = answer["nodeIds"].arrayValue.first?.optionalString, !id.isEmpty else { throw NativeFailure("The backend did not allocate a conversation ID.") }
        let treeID = parent?["tree_id"].optionalString ?? "tree-" + UUID().uuidString.lowercased()
        let now = JSONValue.number(Date().timeIntervalSince1970 * 1000)
        let w = graph.workspace
        // The backend refuses a current thread it does not hold (one moved or purged elsewhere).
        let activeTree = parent == nil ? nil : graph.activeTreeID.flatMap { graph.tree($0) == nil ? nil : JSONValue.string($0) }
        var body: JSONValue = [
            "workspace": ["id": .string(graph.id), "name": .string(graph.name), "cwd": w["cwd"], "createdAt": w["created_at"], "activeTreeId": activeTree ?? .string(treeID)],
            "node": ["id": .string(id), "treeId": .string(treeID), "parentNodeId": parent.map { .string($0.id) } ?? .null, "kind": "chat", "title": title.isEmpty ? .null : .string(title), "createdAt": now],
            "edges": []
        ]
        if let parent {
            body["edges"] = [["id": .string("branch-\(parent.id)-\(id)"), "sourceNodeId": .string(parent.id), "targetNodeId": .string(id), "kind": "branch", "anchorMessageId": anchor.map(JSONValue.string) ?? .null, "createdAt": now]]
        } else {
            body["tree"] = ["id": .string(treeID), "rootNodeId": .string(id), "name": title.isEmpty ? .null : .string(title), "createdAt": now, "lastActiveAt": now]
        }
        _ = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/graph/nodes/ensure", method: "POST", body: body)
        await reload(); selectedWorkspaceID = graph.id; selectedNodeID = id; return id
    }
    func patchNode(_ node: JSONValue, fields: [String: JSONValue]) async throws {
        _ = try await command(workspace: node["workspace_id"].stringValue, type: "node.patch", payload: .object(fields.merging(["id": .string(node.id)]) { _, n in n }))
        await reload()
    }

    // MARK: Workspace and thread lifecycle
    //
    // Commands name only the fields they change, except `tree.upsert`, which
    // replaces a tree row; that row and every change derived from graph shape
    // are computed from a snapshot read just before the write. Nothing leaves
    // the local graph until the backend confirms it and a reload shows it.

    private func lifecycle<T>(_ change: () async throws -> T) async throws -> T {
        guard hydrated else { throw NativeFailure("Wait for your workspaces to load before making changes.") }
        guard !lifecycleBusy else { throw NativeFailure("Another change is still being saved.") }
        lifecycleBusy = true; defer { lifecycleBusy = false }
        return try await change()
    }
    private func refreshSnapshot() async throws {
        let previous = snapshotGeneration
        await reload()
        guard lastSnapshotSucceeded, snapshotGeneration > previous else {
            throw NativeFailure("Michi could not read the latest saved workspaces, so nothing was changed.")
        }
    }
    private func freshGraph(_ id: String) async throws -> WorkspaceGraph {
        try await refreshSnapshot()
        guard let graph = graphs.first(where: { $0.id == id }) else { throw NativeFailure("This workspace is no longer available.") }
        return graph
    }
    private func freshTree(_ tree: JSONValue) async throws -> (graph: WorkspaceGraph, tree: JSONValue) {
        let graph = try await freshGraph(tree["workspace_id"].stringValue)
        guard let current = graph.tree(tree.id) else { throw NativeFailure("This conversation changed on another device. Review it and try again.") }
        return (graph, current)
    }
    private func requireWritable(_ graph: WorkspaceGraph) throws {
        if graph.isSystem || graph.isReadOnly { throw NativeFailure("This workspace is read-only.") }
    }
    private func requireIdle(_ ids: some Sequence<String>, in graph: WorkspaceGraph, _ message: String) throws {
        if ids.contains(where: { graph.node($0)?["status"].stringValue == "streaming" || chats[$0]?.busy == true }) { throw NativeFailure(message) }
    }
    /// One batch for `graph`, plus the workspace's replacement current thread
    /// when the batch retires it or the saved one no longer exists.
    private func apply(_ commands: [JSONValue], to graph: WorkspaceGraph, retiring: Set<String> = []) async throws {
        var batch = commands
        if let fix = graph.activeTreeFix(retiring: retiring) { batch.append(WorkspaceLifecycle.workspaceUpsert(graph.id, ["active_tree_id": fix])) }
        try await sendCommands(workspace: graph.id, batch)
    }
    /// A purge, trim or move can remove the tree a workspace names as current.
    private func repairActiveTree(_ id: String) async throws {
        guard let graph = graphs.first(where: { $0.id == id }), !graph.isDeleted, let fix = graph.activeTreeFix() else { return }
        try await sendCommands(workspace: id, [WorkspaceLifecycle.workspaceUpsert(id, ["active_tree_id": fix])])
        await reload()
    }
    private func reconcileSelection() {
        if let id = selectedNodeID, graph(for: id).map({ $0.isDeleted || $0.node(id)?["deleted_at"].isNull == false }) ?? true { selectedNodeID = nil }
        if let id = selectedWorkspaceID, !visibleGraphs.contains(where: { $0.id == id }) { selectedWorkspaceID = visibleGraphs.first?.id }
    }
    private func updateWorkspace(_ graph: WorkspaceGraph, _ fields: [String: JSONValue]) async throws {
        try await apply([WorkspaceLifecycle.workspaceUpsert(graph.id, fields)], to: graph)
        await reload(); reconcileSelection()
    }

    /// Name and folder edits; settings keys change through their own endpoints.
    func updateWorkspaceDetails(_ graph: WorkspaceGraph, fields: [String: JSONValue]) async throws {
        try await lifecycle {
            if graph.isSystem || graph.isDeleted { throw NativeFailure("Restore this workspace from Trash first.") }
            try await updateWorkspace(graph, fields)
        }
    }
    /// The backend merges this flag into the workspace settings it holds.
    func setAIGlobalContext(_ graph: WorkspaceGraph, enabled: Bool) async throws {
        guard hydrated else { throw NativeFailure("Wait for your workspaces to load before making changes.") }
        _ = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/ai-global-context", method: "POST", body: ["enabled": .bool(enabled)])
    }
    func setWorkspacePinned(_ graph: WorkspaceGraph, pinned: Bool) async throws {
        try await lifecycle {
            if graph.isSystem || (pinned && graph.isReadOnly) { throw NativeFailure("Only active workspaces can be pinned.") }
            try await updateWorkspace(graph, ["pinned_at": pinned ? WorkspaceLifecycle.now() : .null])
        }
    }
    func setWorkspaceArchived(_ graph: WorkspaceGraph, archived: Bool) async throws {
        try await lifecycle {
            if graph.isSystem || graph.isDeleted { throw NativeFailure("Restore this workspace from Trash first.") }
            try await updateWorkspace(graph, ["archived_at": archived ? WorkspaceLifecycle.now() : .null])
        }
    }
    /// Soft delete: the workspace and its threads wait in Trash.
    func trashWorkspace(_ graph: WorkspaceGraph) async throws {
        try await lifecycle {
            if graph.isSystem || graph.isDeleted { throw NativeFailure("This workspace is already in Trash.") }
            try await updateWorkspace(graph, ["deleted_at": WorkspaceLifecycle.now()])
        }
    }
    func restoreWorkspace(_ graph: WorkspaceGraph) async throws {
        try await lifecycle {
            guard graph.isDeleted, !graph.isSystem else { throw NativeFailure("This workspace is not in Trash.") }
            try await updateWorkspace(graph, ["deleted_at": .null])
        }
    }
    private func requireConditionalPurge() async throws {
        let capabilities = try await api.request("/persistence/capabilities")
        guard capabilities["conditionalTrashPurge"] == "v1" else {
            throw NativeFailure("Update the connected Michi backend before permanently deleting items. This server cannot atomically protect items restored on another device.")
        }
    }
    private func deletionSnapshot(_ nodes: [JSONValue]) -> JSONValue {
        .array(nodes.map { ["id": $0["id"], "deletedAt": $0["deleted_at"], "deletionGroupId": $0["deletion_group_id"]] })
    }
    /// Permanent; the caller has confirmed. The workspace is purged only while
    /// the server still has it in Trash, so a restore elsewhere is kept.
    func purgeWorkspace(_ graph: WorkspaceGraph) async throws {
        try await lifecycle {
            try await requireConditionalPurge()
            let current = try await freshGraph(graph.id)
            guard current.isDeleted, !current.isSystem else { throw NativeFailure("This workspace is no longer in Trash, so it was kept.") }
            _ = try await api.request("/workspaces/\(MichiAPI.pathSegment(current.id))", method: "DELETE", body: ["expectedDeletedAt": current.workspace["deleted_at"]])
            await reload(); reconcileSelection()
        }
    }

    func setTreePinned(_ tree: JSONValue, pinned: Bool) async throws {
        try await lifecycle {
            let (graph, current) = try await freshTree(tree)
            try requireWritable(graph)
            if pinned && !current["archived_at"].isNull { throw NativeFailure("Unarchive this conversation before pinning it.") }
            try await apply([WorkspaceLifecycle.treeUpsert(current, ["pinned_at": pinned ? WorkspaceLifecycle.now() : .null])], to: graph)
            await reload()
        }
    }
    func renameTree(_ tree: JSONValue, name: String) async throws {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        try await lifecycle {
            guard !name.isEmpty else { throw NativeFailure("Enter a name for this conversation.") }
            let (graph, current) = try await freshTree(tree)
            try requireWritable(graph)
            try await apply([WorkspaceLifecycle.treeUpsert(current, ["name": .string(name)])], to: graph)
            await reload()
        }
    }
    func archiveTree(_ tree: JSONValue, archived: Bool) async throws {
        try await lifecycle {
            let (graph, current) = try await freshTree(tree)
            try requireWritable(graph)
            if archived {
                try requireIdle(graph.nodes.filter { $0["tree_id"].stringValue == current.id }.map(\.id), in: graph,
                                "Stop the running reply in this conversation before archiving it.")
            }
            let now = WorkspaceLifecycle.now()
            let changes: [String: JSONValue] = archived ? ["archived_at": now] : ["archived_at": .null, "last_active_at": now]
            try await apply([WorkspaceLifecycle.treeUpsert(current, changes)], to: graph, retiring: archived ? [current.id] : [])
            await reload(); reconcileSelection()
        }
    }
    /// Moves a branch and the live branches its parent pointers own to Trash as
    /// one restorable group. A thread's root takes the whole thread with it.
    func trashNode(_ node: JSONValue, graph: WorkspaceGraph) async throws {
        try await lifecycle {
            let fresh = try await freshGraph(graph.id)
            try requireWritable(fresh)
            guard let current = fresh.node(node.id), current["deleted_at"].isNull else { throw NativeFailure("This conversation is already in Trash.") }
            let thread = fresh.ownedTree(rootedAt: current.id)
            if thread == nil && fresh.isTreeArchived(current["tree_id"].stringValue) { throw NativeFailure("Archived conversations are read-only.") }
            let ids = fresh.liveSubtree(current.id)
            try requireIdle(ids, in: fresh, "Stop the running reply before moving this conversation to Trash.")
            let at = WorkspaceLifecycle.now(), group = JSONValue.string(WorkspaceLifecycle.groupID("del"))
            let retired: Set<String> = thread.map { [$0.id] } ?? []
            try await apply(ids.map { WorkspaceLifecycle.nodePatch($0, ["deleted_at": at, "deletion_group_id": group]) }, to: fresh, retiring: retired)
            if ids.contains(selectedNodeID ?? "") { selectedNodeID = nil }
            await reload(); reconcileSelection()
        }
    }
    /// Removes one node and slides its children up to its parent (the backend
    /// trim). `archive` routes it to Archive instead of Trash.
    func pruneNode(_ node: JSONValue, archive: Bool) async throws {
        try await lifecycle {
            let graph = try await freshGraph(node["workspace_id"].stringValue)
            try requireWritable(graph)
            guard let current = graph.node(node.id), current["deleted_at"].isNull else { throw NativeFailure("This conversation was already removed.") }
            if graph.isTreeArchived(current["tree_id"].stringValue) { throw NativeFailure("Archived conversations are read-only.") }
            try requireIdle([current.id], in: graph, "Stop the running reply before removing this conversation.")
            let answer = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/nodes/\(MichiAPI.pathSegment(current.id))/trim", method: "POST", body: [
                "deletedAt": WorkspaceLifecycle.now(), "groupId": .string(WorkspaceLifecycle.groupID(archive ? "arch" : "trim")),
            ])
            await reload()
            guard answer["trimmed"].intValue == 1 else { throw NativeFailure("This conversation was already removed on another device.") }
            if selectedNodeID == current.id { selectedNodeID = nil }
            try await repairActiveTree(graph.id)
        }
    }
    /// Node-level pins order branches; a thread root pins as its thread instead.
    func setNodePinned(_ node: JSONValue, pinned: Bool) async throws {
        try await lifecycle {
            guard let owner = self.graph(for: node.id), owner.node(node.id)?["deleted_at"].isNull == true else { throw NativeFailure("This conversation is no longer available.") }
            try requireWritable(owner)
            guard !owner.isTreeArchived(node["tree_id"].stringValue) else { throw NativeFailure("Archived conversations are read-only.") }
            if owner.ownedTree(rootedAt: node.id) != nil { throw NativeFailure("Pin this conversation from the conversation list.") }
            try await apply([WorkspaceLifecycle.nodePatch(node.id, ["pinned_at": pinned ? WorkspaceLifecycle.now() : .null])], to: owner)
            await reload()
        }
    }
    func moveTree(_ tree: JSONValue, to workspaceID: String) async throws {
        try await lifecycle {
            let (source, current) = try await freshTree(tree)
            try requireWritable(source)
            guard workspaceID != source.id, let target = graphs.first(where: { $0.id == workspaceID }), !target.isSystem, !target.isReadOnly else {
                throw NativeFailure("Choose another active workspace.")
            }
            try requireIdle(source.nodes.filter { $0["tree_id"].stringValue == current.id }.map(\.id), in: source,
                            "Stop the running reply in this conversation before moving it.")
            _ = try await api.request("/trees/\(MichiAPI.pathSegment(current.id))/move", method: "POST", body: [
                "fromWorkspaceId": .string(source.id), "toWorkspaceId": .string(target.id),
            ])
            await reload()
            try await repairActiveTree(source.id)
        }
    }
    /// Makes a branch its own thread with its parent history copied in. The
    /// backend releases the runtime session; no agent work starts.
    @discardableResult func extractTree(_ node: JSONValue) async throws -> String {
        try await lifecycle {
            let graph = try await freshGraph(node["workspace_id"].stringValue)
            let treeID: String
            if let committed = pendingExtractions[node.id], graph.tree(committed)?["root_node_id"].stringValue == node.id {
                treeID = committed // The previous attempt committed; only its answer was lost.
            } else {
                guard let scope = graph.extractionScope(node.id) else { throw NativeFailure("Only a branch of an active conversation can become its own conversation.") }
                try requireIdle(scope, in: graph, "Wait for replies to finish before extracting this branch.")
                let candidate = pendingExtractions[node.id] ?? "tree-" + UUID().uuidString.lowercased()
                pendingExtractions[node.id] = candidate
                let answer = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/nodes/\(MichiAPI.pathSegment(node.id))/extract-tree",
                                                   method: "POST", body: ["treeId": .string(candidate)])
                guard answer["tree"].id == candidate, answer["tree"]["root_node_id"].stringValue == node.id else {
                    throw NativeFailure("Michi returned an unexpected extraction result. Refresh before trying again.")
                }
                treeID = candidate
                await reload()
            }
            pendingExtractions[node.id] = nil
            if let chat = chats[node.id] { await chat.load() }
            selectedWorkspaceID = graph.id; selectedNodeID = node.id
            return treeID
        }
    }

    /// Restores a Trash or Archive group, and its workspace when that is in
    /// Trash too. Returns the group's top node.
    @discardableResult func restoreGroup(_ group: DeletionGroup) async throws -> String {
        try await lifecycle {
            let graph = try await freshGraph(group.workspaceID)
            guard let current = DeletionGroup(id: group.id, workspaceID: graph.id, members: graph.groupMembers(group.id)) else {
                throw NativeFailure("This item was already restored or deleted on another device.")
            }
            let workspace = graph.isDeleted ? [WorkspaceLifecycle.workspaceUpsert(graph.id, ["deleted_at": .null])] : []
            let clear = current.members.map { WorkspaceLifecycle.nodePatch($0.id, ["deleted_at": .null, "deletion_group_id": .null]) }
            if current.isTrim {
                if !workspace.isEmpty { try await apply(workspace, to: graph) }
                let answer = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/nodes/\(MichiAPI.pathSegment(current.root.id))/restore-trim", method: "POST")
                // A row without a trim snapshot is restored by clearing its markers.
                if !answer["restored"].boolValue { try await sendCommands(workspace: graph.id, clear) }
            } else {
                try await apply(workspace + clear, to: graph)
            }
            await reload(); reconcileSelection()
            return current.root.id
        }
    }
    /// Purging a root deletes its tree, whose foreign key cascades to every
    /// node in that tree. Never let that expand the selected deletion scope.
    private func requirePurgePreservesOtherNodes(_ ids: Set<String>, in graph: WorkspaceGraph) throws {
        let deletedTrees = Set(graph.trees.filter { ids.contains($0["root_node_id"].stringValue) }.map(\.id))
        if graph.nodes.contains(where: { deletedTrees.contains($0["tree_id"].stringValue) && !ids.contains($0.id) }) {
            throw NativeFailure("This conversation contains other branches that would also be deleted. Restore the conversation before deleting it permanently.")
        }
    }
    /// Permanent; the caller has confirmed. Recheck the current group and the
    /// backend's cascade scope before sending its explicit node ids.
    func purgeGroup(_ group: DeletionGroup) async throws {
        try await lifecycle {
            try await requireConditionalPurge()
            let graph = try await freshGraph(group.workspaceID)
            let ids = graph.groupMembers(group.id).map(\.id)
            guard !ids.isEmpty else { throw NativeFailure("This item was already restored or deleted on another device.") }
            try requirePurgePreservesOtherNodes(Set(ids), in: graph)
            _ = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/nodes", method: "DELETE", body: ["nodeIds": .array(ids.map(JSONValue.string)), "expectedNodes": deletionSnapshot(graph.groupMembers(group.id))])
            if ids.contains(selectedNodeID ?? "") { selectedNodeID = nil }
            await reload(); reconcileSelection()
            try await repairActiveTree(graph.id)
        }
    }
    /// Permanent; the caller has confirmed. Purges thread Trash per workspace,
    /// then workspaces in Trash, and stops at the first failure. Archive is kept.
    func emptyTrash() async throws {
        try await lifecycle {
            try await requireConditionalPurge()
            try await refreshSnapshot()
            let candidates = graphs.filter { !$0.isSystem }
            // Check every workspace before the first deletion, so a later unsafe
            // root cannot leave an earlier workspace's Trash partly emptied.
            for graph in candidates where graph.hasTrash && !graph.isDeleted {
                let ids = Set(graph.nodes.filter {
                    // Match SQLite's case-insensitive NOT LIKE 'arch-%'.
                    !$0["deleted_at"].isNull && !WorkspaceLifecycle.isArchiveGroup($0["deletion_group_id"].stringValue.lowercased())
                }.map(\.id))
                try requirePurgePreservesOtherNodes(ids, in: graph)
            }
            do {
                for graph in candidates where graph.hasTrash && !graph.isDeleted {
                    _ = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/trash/empty", method: "POST", body: ["expectedNodes": deletionSnapshot(graph.nodes.filter { !$0["deleted_at"].isNull && !WorkspaceLifecycle.isArchiveGroup($0["deletion_group_id"].stringValue.lowercased()) })])
                }
                for graph in candidates where graph.isDeleted {
                    _ = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))", method: "DELETE", body: ["expectedDeletedAt": graph.workspace["deleted_at"]])
                }
            } catch {
                await reload(); reconcileSelection()
                throw error
            }
            await reload(); reconcileSelection()
            for graph in candidates where !graph.isDeleted { try await repairActiveTree(graph.id) }
        }
    }
    func search(_ text: String) {
        cancelSearch()
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        searchQuery = query
        guard !query.isEmpty else { return }
        let identity = searchIdentity
        searchLoading = true
        searchTask = Task { [weak self, api] in
            do {
                try await Task.sleep(for: .milliseconds(250))
                try Task.checkCancellation()
                let q = query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                let payload = try await api.request("/search?q=\(q)&mode=grouped&limit=\(NativeSearchContract.resultLimit)")
                try Task.checkCancellation()
                let result = try NativeSearchContract.results(payload)
                guard let self, self.searchIdentity == identity else { return }
                self.searchResults = result
                self.searchLoading = false; self.searchCompleted = true; self.searchTask = nil
            } catch {
                guard !Task.isCancelled, let self, self.searchIdentity == identity else { return }
                self.searchResults = []; self.searchLoading = false; self.searchCompleted = true; self.searchTask = nil
                if let failure = error as? MichiAPIError, failure.statusCode == 400 {
                    self.searchError = "This search could not be processed. Try a different phrase."
                } else if error is NativeFailure { self.searchError = NativeSearchContract.malformedMessage }
                else { self.searchError = "Search could not be loaded. Try again." }
            }
        }
    }
    func cancelSearch() {
        searchIdentity = UUID()
        searchTask?.cancel(); searchTask = nil
        searchResults = []; searchQuery = ""; searchLoading = false; searchCompleted = false; searchError = nil
    }
    var visibleSearchResults: [NativeSearchResult] {
        guard hydrated else { return [] }
        return searchResults.filter { NativeSearchContract.destination($0, graphs: graphs) != nil }
    }
    func canOpenSearchResult(_ result: NativeSearchResult) -> Bool {
        hydrated && searchResults.contains(result) && NativeSearchContract.destination(result, graphs: graphs) != nil
    }
    func openSearchResult(_ result: NativeSearchResult) async {
        guard !openingSearchResult, canOpenSearchResult(result) else { return }
        openingSearchResult = true
        defer { openingSearchResult = false }
        let identity = searchIdentity
        // Recheck the authoritative snapshot on tap: cached search metadata may
        // refer to a node moved or deleted since the result arrived.
        await reload()
        guard identity == searchIdentity, !Task.isCancelled else { return }
        guard lastSnapshotSucceeded, hydrated,
              let destination = NativeSearchContract.destination(result, graphs: graphs) else {
            searchError = "This conversation moved or is no longer available. Refresh search to try again."
            return
        }
        presentConversation(destination.node, workspace: destination.graph.id)
    }
}
