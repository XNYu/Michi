import Foundation
import CryptoKit
import MichiCore

/// Lifecycle rules shared by the conversation list, branch map, Archive and
/// Trash. They follow the web client: a node's parent pointer owns its branch,
/// while merge, link and digest-source edges are references that a deletion
/// never follows. Trash and Archive share the soft-delete markers; a group id
/// with the `arch-` prefix routes to Archive and is exempt from Empty Trash.
enum WorkspaceLifecycle {
    static let archivePrefix = "arch-"
    static func isArchiveGroup(_ id: String) -> Bool { id.hasPrefix(archivePrefix) }

    /// Milliseconds since 1970, as the backend and web client stamp rows.
    static func now() -> JSONValue { .number((Date().timeIntervalSince1970 * 1000).rounded()) }

    /// `del-…` for a subtree, `trim-…` or `arch-…` for a single node, shaped
    /// like the web client's group ids.
    static func groupID(_ lane: String) -> String {
        "\(lane)-\(Int64(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8).lowercased())"
    }

    /// `tree.upsert` replaces every column it names, so the row is rebuilt from
    /// a tree read just before the write and differs from it only by `changes`.
    static func treeUpsert(_ tree: JSONValue, _ changes: [String: JSONValue]) -> JSONValue {
        let row: [String: JSONValue] = [
            "id": .string(tree.id), "workspace_id": tree["workspace_id"], "root_node_id": tree["root_node_id"],
            "name": tree["name"], "archived_at": tree["archived_at"], "pinned_at": tree["pinned_at"],
            "last_active_at": tree["last_active_at"], "created_at": tree["created_at"],
        ]
        return ["type": "tree.upsert", "payload": .object(row.merging(changes) { _, new in new })]
    }

    /// Partial commands: the backend keeps every column a payload leaves out.
    static func nodePatch(_ id: String, _ fields: [String: JSONValue]) -> JSONValue {
        ["type": "node.patch", "payload": .object(fields.merging(["id": .string(id)]) { _, id in id })]
    }
    static func workspaceUpsert(_ id: String, _ fields: [String: JSONValue]) -> JSONValue {
        ["type": "workspace.upsert", "payload": .object(fields.merging(["id": .string(id)]) { _, id in id })]
    }
}

/// Nodes soft-removed together, shown as one Trash or Archive entry.
struct DeletionGroup: Identifiable, Equatable {
    let id: String
    let workspaceID: String
    let members: [JSONValue]
    /// The member whose parent is not in the group.
    let root: JSONValue
    let deletedAt: Double

    init?(id: String, workspaceID: String, members: [JSONValue]) {
        guard let first = members.first else { return nil }
        let ids = Set(members.map(\.id))
        self.id = id; self.workspaceID = workspaceID; self.members = members
        root = members.first { !ids.contains($0["parent_node_id"].stringValue) } ?? first
        deletedAt = members.map { $0["deleted_at"].doubleValue }.max() ?? 0
    }

    var isArchive: Bool { WorkspaceLifecycle.isArchiveGroup(id) }
    /// A single trimmed or archived node restores through its trim snapshot.
    var isTrim: Bool { members.count == 1 && !(root["trim_snapshot"].optionalString ?? "").isEmpty }
    var title: String { root["title"].optionalString.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled thread" }
}

extension WorkspaceGraph {
    var isPinned: Bool { !workspace["pinned_at"].isNull }
    /// Archived and deleted workspaces are read-only, as on the web.
    var isReadOnly: Bool { isArchived || isDeleted }
    var activeTreeID: String? { workspace["active_tree_id"].optionalString.flatMap { $0.isEmpty ? nil : $0 } }
    func tree(_ id: String) -> JSONValue? { trees.first { $0.id == id } }
    func ownedTree(rootedAt nodeID: String) -> JSONValue? { trees.first { $0["root_node_id"].stringValue == nodeID } }
    func isTreeArchived(_ id: String) -> Bool { tree(id).map { !$0["archived_at"].isNull } ?? false }

    /// Page helpers and scheduled maintenance transcripts stay out of conversation surfaces.
    func isConversation(_ node: JSONValue) -> Bool {
        (node["page_id"].optionalString ?? "").isEmpty && (node["maintenance_job_id"].optionalString ?? "").isEmpty
    }
    func threadTitle(_ tree: JSONValue) -> String {
        if let name = tree["name"].optionalString, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return node(tree["root_node_id"].stringValue).map(title) ?? "New conversation"
    }

    private func isListed(_ tree: JSONValue) -> Bool {
        guard let root = node(tree["root_node_id"].stringValue) else { return false }
        return root["deleted_at"].isNull && isConversation(root)
    }
    private static func byRecency(_ a: JSONValue, _ b: JSONValue) -> Bool {
        func recency(_ tree: JSONValue) -> Double { tree["last_active_at"].isNull ? tree["created_at"].doubleValue : tree["last_active_at"].doubleValue }
        let (x, y) = (recency(a), recency(b))
        return x != y ? x > y : a["created_at"].doubleValue > b["created_at"].doubleValue
    }

    /// Live threads in the web sidebar's order: pinned (newest pin first), then recent activity.
    var threadTrees: [JSONValue] {
        let live = trees.filter { $0["archived_at"].isNull && isListed($0) }
        let pinned = live.filter { !$0["pinned_at"].isNull }.sorted { a, b in
            let (x, y) = (a["pinned_at"].doubleValue, b["pinned_at"].doubleValue)
            return x != y ? x > y : Self.byRecency(a, b)
        }
        return pinned + live.filter { $0["pinned_at"].isNull }.sorted(by: Self.byRecency)
    }
    var archivedTrees: [JSONValue] {
        trees.filter { !$0["archived_at"].isNull && isListed($0) }.sorted { $0["archived_at"].doubleValue > $1["archived_at"].doubleValue }
    }

    /// `id` followed by the live branches its parent pointers own in its thread.
    /// Deleted nodes are neither included nor walked through, so an earlier
    /// deletion keeps its own group.
    func liveSubtree(_ id: String) -> [String] {
        guard let start = node(id), start["deleted_at"].isNull else { return [] }
        var children: [String: [JSONValue]] = [:]
        for candidate in nodes where candidate["deleted_at"].isNull {
            children[candidate["parent_node_id"].stringValue, default: []].append(candidate)
        }
        var result = [id], seen: Set<String> = [id], index = 0
        while index < result.count {
            let parent = result[index]; index += 1
            let thread = node(parent)?["tree_id"].stringValue ?? ""
            for child in children[parent] ?? [] where child["tree_id"].stringValue == thread {
                if seen.insert(child.id).inserted { result.append(child.id) }
            }
        }
        return result
    }

    /// The thread a workspace lands on when its current one is no longer
    /// eligible: the most recently active listed thread.
    func fallbackActiveTree(excluding retired: Set<String> = []) -> String? {
        trees.filter { !retired.contains($0.id) && $0["archived_at"].isNull && isListed($0) }.sorted(by: Self.byRecency).first?.id
    }
    /// The `active_tree_id` a batch must also write, or nil when none is needed.
    /// The backend refuses every batch for a workspace whose current thread is
    /// missing, so a missing one is replaced as well as a retired one.
    func activeTreeFix(retiring retired: Set<String> = []) -> JSONValue? {
        guard let active = activeTreeID, tree(active) == nil || retired.contains(active) else { return nil }
        return fallbackActiveTree(excluding: retired).map(JSONValue.string) ?? .null
    }

    /// Trash (`archive == false`) or Archive entries, newest first. Page helpers
    /// and maintenance transcripts are not listed, as on the web.
    func deletionGroups(archive: Bool) -> [DeletionGroup] {
        var members: [String: [JSONValue]] = [:], order: [String] = []
        for candidate in nodes where !candidate["deleted_at"].isNull && isConversation(candidate) {
            let group = candidate["deletion_group_id"].stringValue
            guard !group.isEmpty, WorkspaceLifecycle.isArchiveGroup(group) == archive else { continue }
            if members[group] == nil { order.append(group) }
            members[group, default: []].append(candidate)
        }
        return order.compactMap { DeletionGroup(id: $0, workspaceID: id, members: members[$0] ?? []) }
            .sorted { $0.deletedAt > $1.deletedAt }
    }
    /// Every row still soft-deleted under `group` in this snapshot, hidden rows included.
    func groupMembers(_ group: String) -> [JSONValue] {
        nodes.filter { !$0["deleted_at"].isNull && $0["deletion_group_id"].stringValue == group }
    }
    /// Whether Empty Trash has rows to purge here; Archive rows never count.
    var hasTrash: Bool {
        nodes.contains { !$0["deleted_at"].isNull && !WorkspaceLifecycle.isArchiveGroup($0["deletion_group_id"].stringValue) }
    }

    /// Every node an extraction rewrites (the branch it owns plus its parent
    /// chain), or nil unless the node is a live chat branch, not a thread
    /// root, in an active thread of a writable workspace.
    func extractionScope(_ id: String) -> Set<String>? {
        guard !isReadOnly, !isSystem, let target = node(id), target["deleted_at"].isNull, target["kind"].stringValue == "chat",
              !target["parent_node_id"].stringValue.isEmpty, ownedTree(rootedAt: id) == nil,
              let thread = self.tree(target["tree_id"].stringValue), thread["archived_at"].isNull else { return nil }
        var scope = Set(liveSubtree(id))
        var parent = target["parent_node_id"].stringValue
        while !parent.isEmpty, scope.insert(parent).inserted { parent = node(parent)?["parent_node_id"].stringValue ?? "" }
        return scope
    }

    /// Live conversations a node references or is referenced by through merge,
    /// link and digest-source edges: navigation only, never ownership.
    func references(of id: String) -> [(node: JSONValue, kind: String)] {
        edges.compactMap { edge in
            let kind = edge["kind"].stringValue
            guard !kind.isEmpty, kind != "branch" else { return nil }
            let source = edge["source_node_id"].stringValue, target = edge["target_node_id"].stringValue
            guard let other = source == id ? target : (target == id ? source : nil), other != id,
                  let peer = self.node(other), peer["deleted_at"].isNull else { return nil }
            return (node: peer, kind: kind)
        }
    }
}

extension Array where Element == WorkspaceGraph {
    /// Live workspaces for pickers and the manager: pinned first (newest pin
    /// first), then the backend's recent-activity order.
    var orderedLive: [WorkspaceGraph] {
        let live = filter { !$0.isDeleted && !$0.isArchived && !$0.isSystem }
        let pinned = live.filter(\.isPinned).sorted { $0.workspace["pinned_at"].doubleValue > $1.workspace["pinned_at"].doubleValue }
        return pinned + live.filter { !$0.isPinned }
    }
}


/// A digest follow-up is a normal branch plus a non-owning, durable link to
/// its saved digest. The opaque composer field retains the selected version;
/// window-scoped draft patches preserve this reference on the server.
enum NativeDigestFollowUp {
    static let referenceKey = "__michiDigestFollowUp"
    static func hash(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
    static func edgeID(digestID: String, nodeID: String) -> String { "michi-digest-followup-" + hash(digestID + "\n" + nodeID) }
    static func questions(_ markdown: String) -> [String] {
        guard markdown.utf8.count <= 2 * 1024 * 1024 else { return [] }
        func capture(_ pattern: String, options: NSRegularExpression.Options = []) -> String? {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options),
                  let match = regex.firstMatch(in: markdown, range: NSRange(markdown.startIndex..., in: markdown)),
                  let range = Range(match.range(at: 1), in: markdown) else { return nil }
            return String(markdown[range])
        }
        let section = capture(#"^##\s+Open Questions.*?\n([\s\S]*?)(?=\n##|\z)"#, options: .anchorsMatchLines)
            ?? capture(#"Open Threads:\s*([\s\S]*?)(?=\n##|$)"#) ?? ""
        return Array(section.components(separatedBy: "\n").map {
            $0.replacingOccurrences(of: #"^[-*]\s*"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }.prefix(100))
    }
    static func anchor(graph: WorkspaceGraph, digestID: String) throws -> (digest: JSONValue, root: JSONValue, tree: JSONValue) {
        guard !graph.isReadOnly, !graph.isSystem, let digest = graph.node(digestID), digest["workspace_id"].stringValue == graph.id,
              digest["kind"] == "digest", digest["deleted_at"].isNull, digest["digest"].parsedJSON["status"] == "idle",
              let content = digest["digest"].parsedJSON["content"].optionalString, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              content.utf8.count <= 2 * 1024 * 1024,
              case .number(let generated) = digest["digest"].parsedJSON["generatedAt"], generated.isFinite, generated > 0 else { throw NativeFailure("Choose a saved, completed digest in a writable workspace.") }
        let sources = digest["digest"].parsedJSON["sources"].arrayValue
        guard let source = sources.compactMap({ graph.node($0.stringValue) }).first(where: { $0["deleted_at"].isNull }),
              source["workspace_id"].stringValue == graph.id, source["kind"] == "chat",
              let tree = graph.tree(source["tree_id"].stringValue), tree["workspace_id"].stringValue == graph.id, tree["archived_at"].isNull,
              let root = graph.node(tree["root_node_id"].stringValue), root["workspace_id"].stringValue == graph.id,
              root["kind"] == "chat", root["deleted_at"].isNull, root["tree_id"].stringValue == tree.id else {
            throw NativeFailure("The digest’s originating conversation is missing or archived. No follow-up was created.")
        }
        return (digest, root, tree)
    }
    static func reference(digest: JSONValue, root: JSONValue, tree: JSONValue, nodeID: String) -> JSONValue {
        let data = digest["digest"].parsedJSON
        return ["version": 1, "digestId": .string(digest.id), "treeId": .string(tree.id), "rootNodeId": .string(root.id),
                "generatedAt": data["generatedAt"], "contentHash": .string(hash(data["content"].stringValue)),
                "edgeId": .string(edgeID(digestID: digest.id, nodeID: nodeID))]
    }
    static func creation(graph: WorkspaceGraph, digestID: String, nodeID: String, question: String) throws -> JSONValue {
        let (digest, root, tree) = try anchor(graph: graph, digestID: digestID)
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 32_000, !nodeID.isEmpty, graph.node(nodeID) == nil else { throw NativeFailure("The follow-up text or allocated conversation ID is invalid.") }
        let reference = reference(digest: digest, root: root, tree: tree, nodeID: nodeID)
        let draft: JSONValue = ["value": .string(text), "mentions": [], referenceKey: reference]
        let now = WorkspaceLifecycle.now()
        return ["workspace": ["id": .string(graph.id), "name": .string(graph.name), "cwd": graph.workspace["cwd"],
                              "createdAt": graph.workspace["created_at"], "activeTreeId": .string(tree.id)],
                "node": ["id": .string(nodeID), "treeId": .string(tree.id), "parentNodeId": .string(root.id), "kind": "chat",
                         "title": .string(String(text.prefix(120))), "createdAt": now, "composerDraft": .string(draft.prettyPrinted)],
                "edges": [["id": .string("branch-" + root.id + "-" + nodeID), "sourceNodeId": .string(root.id), "targetNodeId": .string(nodeID), "kind": "branch", "createdAt": now],
                          ["id": reference["edgeId"], "sourceNodeId": .string(digestID), "targetNodeId": .string(nodeID), "kind": "link", "createdAt": now]]]
    }
    static func savedReference(node: JSONValue, graph: WorkspaceGraph) throws -> JSONValue? {
        let reference = node["composer_draft"].parsedJSON[referenceKey]
        let nativeLinks = graph.edges.filter { $0["target_node_id"].stringValue == node.id && $0["kind"] == "link" && $0.id == edgeID(digestID: $0["source_node_id"].stringValue, nodeID: node.id) }
        if reference.isNull && nativeLinks.isEmpty { return nil }
        guard reference["version"] == 1, !reference["digestId"].stringValue.isEmpty,
              reference["edgeId"].stringValue == edgeID(digestID: reference["digestId"].stringValue, nodeID: node.id),
              !reference["treeId"].stringValue.isEmpty, !reference["rootNodeId"].stringValue.isEmpty,
              reference["generatedAt"].doubleValue > 0, reference["contentHash"].stringValue.count == 64 else {
            throw NativeFailure("The saved digest reference is incomplete. Open the digest and start a new follow-up; this draft has been kept.")
        }
        return reference
    }
    static func context(reference: JSONValue, nodeID: String, graph: WorkspaceGraph) throws -> String {
        let (digest, root, tree) = try anchor(graph: graph, digestID: reference["digestId"].stringValue)
        guard let node = graph.node(nodeID), node["workspace_id"].stringValue == graph.id, node["kind"] == "chat", node["deleted_at"].isNull,
              node["tree_id"].stringValue == tree.id, node["parent_node_id"].stringValue == root.id,
              reference == self.reference(digest: digest, root: root, tree: tree, nodeID: nodeID),
              graph.edges.contains(where: { $0.id == reference["edgeId"].stringValue && $0["workspace_id"].stringValue == graph.id && $0["kind"] == "link" && $0["source_node_id"].stringValue == digest.id && $0["target_node_id"].stringValue == nodeID }) else {
            throw NativeFailure("The digest version or source relationship changed. Review the saved digest before creating another follow-up; this draft has been kept.")
        }
        let title = digest["title"].stringValue.isEmpty ? "Workspace digest" : digest["title"].stringValue
        return "=== Digest: " + title + " ===\n" + digest["digest"].parsedJSON["content"].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func confirmed(payload: JSONValue, graph: WorkspaceGraph) -> Bool {
        let id = payload["node"].id
        guard let node = graph.node(id), node["workspace_id"].stringValue == graph.id,
              node["kind"] == "chat", node["deleted_at"].isNull, node["parent_node_id"] == payload["node"]["parentNodeId"],
              node["tree_id"] == payload["node"]["treeId"],
              node["composer_draft"].parsedJSON[referenceKey] == payload["node"]["composerDraft"].parsedJSON[referenceKey] else { return false }
        return payload["edges"].arrayValue.allSatisfy { edge in graph.edges.contains {
            $0.id == edge.id && $0["workspace_id"].stringValue == graph.id && $0["source_node_id"] == edge["sourceNodeId"] && $0["target_node_id"] == edge["targetNodeId"] && $0["kind"] == edge["kind"]
        } }
    }
}

/// An ambiguous graph ensure is reconciled by reading its allocated node; it is
/// never replaced with another allocation or replayed automatically.
struct NativeDigestFollowUpRecovery {
    let url: URL
    init(api: MichiAPI, workspaceID: String, directory: URL? = nil) {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Michi/DigestFollowUps.v1")
        url = root.appendingPathComponent(NativeDigestFollowUp.hash(api.baseURL.absoluteString + "\n" + workspaceID) + ".json")
    }
    func load(workspaceID: String) throws -> JSONValue? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard ((try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? Int.max) <= 4_194_304 else { throw NativeFailure("Saved follow-up recovery is unreadable.") }
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        guard value["workspace"].id == workspaceID, !value["node"].id.isEmpty,
              value["node"]["composerDraft"].parsedJSON[NativeDigestFollowUp.referenceKey]["version"] == 1 else { throw NativeFailure("Saved follow-up recovery has an invalid identity.") }
        return value
    }
    func save(_ payload: JSONValue, workspaceID: String) throws {
        guard try load(workspaceID: workspaceID) == nil else { throw NativeFailure("A previous follow-up still needs reconciliation.") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(payload)
        guard data.count <= 4_194_304 else { throw NativeFailure("The follow-up is too large to retain safely.") }
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }; try handle.synchronize()
    }
    func clear(_ payload: JSONValue, workspaceID: String) throws {
        guard try load(workspaceID: workspaceID) == payload else { throw NativeFailure("Saved follow-up recovery changed and was kept.") }
        try FileManager.default.removeItem(at: url)
    }
}
