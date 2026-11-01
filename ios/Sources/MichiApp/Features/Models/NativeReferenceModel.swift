import Foundation
import Combine
import MichiCore

enum NativeReferenceResolution {
    case page(id: String, workspaceID: String, blockID: String?)
    case conversation(NativeReferenceConversation)
}

struct NativeReferenceConversation {
    let graph: WorkspaceGraph
    let node: JSONValue
    let messages: [NativeMessage]
    let targetMessageID: String?
    /// Helper and maintenance history remains readable without ordinary-chat
    /// activation, session recovery, or a running runtime.
    let kind: String
    var canOpenConversation: Bool { Self.canOpenConversation(graph: graph, node: node) }
    static func canOpenConversation(graph: WorkspaceGraph, node: JSONValue) -> Bool {
        guard !graph.isSystem, !graph.isDeleted, graph.workspace["purged_at"].isNull,
              node["kind"].stringValue == "chat", graph.isConversation(node),
              graph.nodes.filter({ $0.id == node.id }).count == 1,
              node["workspace_id"].stringValue == graph.id, node["deleted_at"].isNull, node["purged_at"].isNull,
              graph.trees.filter({ $0.id == node["tree_id"].stringValue }).count == 1,
              let tree = graph.tree(node["tree_id"].stringValue), tree["workspace_id"].stringValue == graph.id,
              tree["deleted_at"].isNull, tree["purged_at"].isNull else { return false }
        return true
    }
}

/// Reads one exact reference from the selected backend. This owns no chat
/// controller and never creates, activates, recovers or starts a conversation.
@MainActor final class NativeReferenceModel: ObservableObject {
    let api: MichiAPI
    @Published private(set) var resolved: NativeReferenceResolution?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private var generation = UUID()
    private var task: Task<NativeReferenceResolution, Error>?
    private var opened: NativeMichiReference?

    init(api: MichiAPI) { self.api = api }

    func open(_ reference: NativeMichiReference) async {
        // Child navigation can re-enter `.task` while cancel() still holds the
        // rendered destination. Keep that identity; Retry and a new reference
        // still replace it.
        if opened == reference, resolved != nil || loading { return }
        task?.cancel()
        let identity = UUID(); generation = identity
        opened = reference
        resolved = nil; error = nil; loading = true
        let api = api
        let work = Task { try await Self.resolve(reference, api: api) }
        task = work
        await withTaskCancellationHandler {
            do {
                let value = try await work.value
                try Task.checkCancellation()
                guard generation == identity else { return }
                resolved = value; loading = false; task = nil
            } catch {
                guard generation == identity else { return }
                loading = false; task = nil
                if !(error is CancellationError) && !Task.isCancelled && !work.isCancelled {
                    self.error = error.localizedDescription
                }
            }
        } onCancel: { work.cancel() }
    }

    func cancel() {
        generation = UUID(); task?.cancel(); task = nil
        // A destination can disappear while its NavigationLink pushes a child.
        // Retain that rendered identity; only a new open replaces it.
        loading = false; error = nil
    }

    private static func resolve(_ reference: NativeMichiReference, api: MichiAPI) async throws -> NativeReferenceResolution {
        guard reference.isValid else { throw NativeFailure("This Michi reference is invalid.") }
        try Task.checkCancellation()
        switch reference {
        case .page(let id, let blockID):
            let payload = try await api.request("/pages/\(MichiAPI.pathSegment(id))")
            let page = try featureRequirePage(payload)
            try Task.checkCancellation()
            guard sameID(page.id, id), let workspaceID = page["workspaceId"].optionalString, !workspaceID.isEmpty,
                  page["deletedAt"].isNull, page["deleted_at"].isNull,
                  page["purged_at"].isNull, case .array = page["blocks"] else {
                throw NativeFailure("The referenced page is unavailable or its identity changed.")
            }
            if let blockID {
                guard case .scroll = PageNavigation.resolveOnPage(targetID: blockID, blocks: page["blocks"].arrayValue) else {
                    throw NativeFailure("The exact referenced page block is missing, ambiguous, or no longer navigable.")
                }
            }
            let graphs = try await readGraphs(api)
            let matches = graphs.filter { sameID($0.id, workspaceID) }
            guard matches.count == 1, let graph = matches.first, live(graph.workspace) else {
                throw NativeFailure("The referenced page's workspace is unavailable.")
            }
            return .page(id: id, workspaceID: workspaceID, blockID: blockID)
        case .node(let nodeID, let messageID):
            return try await conversation(nodeID: nodeID, messageID: messageID, turnID: nil, api: api)
        case .source(let nodeID, let turnID, let assistantID):
            return try await conversation(nodeID: nodeID, messageID: assistantID, turnID: turnID, api: api)
        }
    }

    private static func conversation(nodeID: String, messageID: String?, turnID: String?, api: MichiAPI) async throws -> NativeReferenceResolution {
        let graphs = try await readGraphs(api)
        // Never pick the first of conflicting identities, nor infer ownership
        // from UI selection, edges, the active tree, or the first root.
        let matches = graphs.flatMap { graph in graph.nodes.filter { sameID($0.id, nodeID) }.map { (graph, $0) } }
        guard matches.count == 1, let (graph, node) = matches.first,
              live(graph.workspace), live(node), sameID(node["workspace_id"].stringValue, graph.id),
              let treeID = node["tree_id"].optionalString, !treeID.isEmpty else {
            throw NativeFailure("The referenced conversation is unavailable or no longer belongs to a saved tree.")
        }
        let trees = graph.trees.filter { sameID($0.id, treeID) }
        guard trees.count == 1, let tree = trees.first, live(tree), sameID(tree["workspace_id"].stringValue, graph.id) else {
            throw NativeFailure("The referenced conversation's saved tree is unavailable.")
        }
        let history = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/trees/\(MichiAPI.pathSegment(treeID))/messages")
        try Task.checkCancellation()
        guard case .array(let rows) = history["messages"] else { throw NativeFailure("The saved source history could not be read.") }
        let own = rows.filter { sameID($0["node_id"].stringValue, nodeID) }
        guard own.allSatisfy({ !$0.id.isEmpty && $0["role"].optionalString != nil && $0["content"].optionalString != nil && validSequence($0["seq"]) }),
              Set(own.map { Data($0.id.utf8) }).count == own.count else { throw NativeFailure("The saved source history has invalid message identities.") }
        // SwiftUI's String row IDs use canonical text equality. Until the
        // renderer has byte-keyed anchors, refuse two distinct opaque IDs that
        // would share one scrolling identity instead of jumping to either one.
        guard Set(own.map(\.id)).count == own.count else {
            throw NativeFailure("This history contains message identities that cannot be distinguished by native navigation.")
        }
        if let messageID {
            guard let target = own.first(where: { sameID($0.id, messageID) }) else { throw NativeFailure("The exact referenced message is no longer available.") }
            if let turnID {
                guard target["role"] == "assistant" else { throw NativeFailure("The source does not identify an assistant reply.") }
                // MessageRow does not contain turn identity. This owned GET
                // reads the durable turns table, not mutable message metadata.
                let preview = try await api.request("/spaces-home/source?nodeId=\(MichiAPI.queryComponent(nodeID))&messageId=\(MichiAPI.queryComponent(messageID))")
                try Task.checkCancellation()
                guard sameID(preview["nodeId"].stringValue, nodeID), sameID(preview["workspaceId"].stringValue, graph.id),
                      ["live", "archived"].contains(preview["state"].stringValue),
                      sameID(preview["message"].id, messageID), preview["message"]["role"] == "assistant",
                      sameID(preview["message"]["turnId"].stringValue, turnID) else {
                    throw NativeFailure("The exact source reply and turn could not be confirmed.")
                }
            }
        }
        let sorted = own.enumerated().sorted {
            let a = $0.element["seq"].doubleValue, b = $1.element["seq"].doubleValue
            return a == b ? $0.offset < $1.offset : a < b
        }.map { NativeMessage($0.element) }
        let kind = !node["maintenance_job_id"].stringValue.isEmpty ? "maintenance"
            : !node["page_id"].stringValue.isEmpty ? "helper" : node["kind"].optionalString ?? "chat"
        return .conversation(.init(graph: graph, node: node, messages: sorted, targetMessageID: messageID, kind: kind))
    }

    private static func readGraphs(_ api: MichiAPI) async throws -> [WorkspaceGraph] {
        let answer = try await api.request("/workspaces/all?meta=1")
        try Task.checkCancellation()
        guard case .array(let rows) = answer["workspaces"], rows.allSatisfy({ row in
            guard !row["workspace"].id.isEmpty, case .array = row["nodes"], case .array = row["trees"] else { return false }
            return true
        }), Set(rows.map { Data($0["workspace"].id.utf8) }).count == rows.count else {
            throw NativeFailure("The authoritative workspace snapshot could not be read.")
        }
        return rows.map { WorkspaceGraph(raw: $0) }
    }
    private static func live(_ row: JSONValue) -> Bool { row["deleted_at"].isNull && row["purged_at"].isNull }
    private static func sameID(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
    private static func validSequence(_ value: JSONValue) -> Bool {
        guard case .number(let number) = value else { return false }
        return number.isFinite && number >= 0 && number.rounded(.down) == number && number <= 9_007_199_254_740_991
    }
}
