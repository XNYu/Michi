import Foundation
import Combine
import MichiCore

struct WorkspaceOverviewRow: Identifiable {
    let node: JSONValue
    let depth: Int
    var id: String { node.id }
}

@MainActor final class WorkspaceOverviewModel: ObservableObject {
    let api: MichiAPI
    @Published private(set) var graph: WorkspaceGraph
    @Published private(set) var selectedTreeID: String
    @Published private(set) var selection = Set<String>()
    @Published private(set) var selectedDigestID: String?
    @Published var guidance = ""
    @Published private(set) var hydrated = false
    @Published private(set) var loading = false
    @Published private(set) var generating = false
    @Published private(set) var saving = false
    @Published private(set) var generatedContent = ""
    @Published private(set) var generationThought = ""
    @Published private(set) var generationStatus = ""
    @Published private(set) var uncertainGeneration = false
    /// Completed paid output is retained even before a save can be prepared.
    @Published private(set) var pendingOutput: JSONValue?
    @Published private(set) var pendingSave: JSONValue?
    @Published private(set) var error: String?
    @Published private(set) var notice: String?
    @Published var followUpDraft = ""
    @Published private(set) var creatingFollowUp = false
    @Published private(set) var pendingFollowUp: JSONValue?
    @Published private(set) var followUpError: String?
    private var followUpRecoveryBlocked = false
    private let followUpRecovery: NativeDigestFollowUpRecovery
    var openQuestions: [String] { NativeDigestFollowUp.questions(selectedDigest?["digest"].parsedJSON["content"].stringValue ?? "") }
    var canExploreDigest: Bool { hydrated && !readOnly && !creatingFollowUp && !generating && !saving && pendingFollowUp == nil && !followUpRecoveryBlocked && selectedDigest?["digest"].parsedJSON["status"] == "idle" }
    private var generationTask: Task<Void, Never>?
    private var generationIdentity: UUID?
    private var requestStarted = false
    private var terminalReceived = false
    private var markerKey: String { "michi.\(api.baseURL.absoluteString).\(graph.id).digest-generation" }
    private var saveKey: String { "michi.\(api.baseURL.absoluteString).\(graph.id).digest-save" }
    private var outputKey: String { "michi.\(api.baseURL.absoluteString).\(graph.id).digest-output" }
    var selectedTree: JSONValue? { graph.trees.first { $0.id == selectedTreeID && owns($0) } }
    var readOnly: Bool { graph.isDeleted || graph.isArchived || selectedTree == nil || !(selectedTree?["archived_at"].isNull ?? false) }
    var hasUnsavedOutput: Bool { pendingOutput != nil || pendingSave != nil }
    var canGenerate: Bool { hydrated && !readOnly && !generating && !saving && !creatingFollowUp && !uncertainGeneration && !hasUnsavedOutput && !sourceNodes.isEmpty }
    var recoveryReadOnly: Bool {
        let id = pendingSave?["treeId"].stringValue ?? pendingOutput?["treeId"].stringValue ?? ""
        return !hydrated || graph.isDeleted || graph.isArchived || !graph.trees.contains { $0.id == id && owns($0) && $0["archived_at"].isNull }
    }
    var trees: [JSONValue] { graph.trees.filter(owns).sorted { $0["created_at"].doubleValue < $1["created_at"].doubleValue } }
    var digestNodes: [JSONValue] {
        graph.nodes.filter { node in
            owns(node) && node["kind"].stringValue == "digest" && node["deleted_at"].isNull &&
            node["digest"].parsedJSON["sources"].arrayValue.contains { source in graph.node(source.stringValue)?["tree_id"].stringValue == selectedTreeID }
        }.sorted { $0["digest"].parsedJSON["generatedAt"].doubleValue > $1["digest"].parsedJSON["generatedAt"].doubleValue }
    }
    var selectedDigest: JSONValue? { digestNodes.first { $0.id == selectedDigestID } }
    var sourceNodes: [JSONValue] {
        rows.map(\.node).filter { $0["tree_id"].stringValue == selectedTreeID && (selection.isEmpty || selection.contains($0.id)) }
    }
    var rows: [WorkspaceOverviewRow] { Self.mapRows(graph: graph, treeID: selectedTreeID) }

    init(api: MichiAPI, graph: WorkspaceGraph, followUpRecoveryDirectory: URL? = nil) {
        self.api = api; self.graph = graph
        followUpRecovery = NativeDigestFollowUpRecovery(api: api, workspaceID: graph.id, directory: followUpRecoveryDirectory)
        selectedTreeID = graph.workspace["active_tree_id"].optionalString ?? graph.trees.first?.id ?? ""
        do { pendingFollowUp = try followUpRecovery.load(workspaceID: graph.id) }
        catch { followUpRecoveryBlocked = true; followUpError = error.localizedDescription }
        uncertainGeneration = UserDefaults.standard.string(forKey: markerKey) != nil
        if let data = UserDefaults.standard.data(forKey: outputKey), let output = try? JSONDecoder().decode(JSONValue.self, from: data),
           Self.validPendingOutput(output, workspaceID: graph.id) {
            pendingOutput = output; generatedContent = output["digest"]["content"].stringValue
            selectedTreeID = output["treeId"].stringValue
            selectedDigestID = output["existingNodeId"].optionalString
            guidance = output["digest"]["customPrompt"].stringValue
            // The durable local result proves this generation reached done.
            clearGenerationMarker()
        }
        if let data = UserDefaults.standard.data(forKey: saveKey), let pending = try? JSONDecoder().decode(JSONValue.self, from: data),
           Self.validPendingSave(pending, workspaceID: graph.id) {
            pendingSave = pending
            generatedContent = Self.pendingDigest(pending)["content"].stringValue
            selectedTreeID = pending["treeId"].stringValue
            clearGenerationMarker()
        }
    }

    func selectTree(_ id: String) {
        guard !generating && !saving && !creatingFollowUp, trees.contains(where: { $0.id == id }) else { return }
        selectedTreeID = id; selection = []; selectedDigestID = nil; guidance = ""; notice = nil
    }
    func selectDigest(_ id: String?) {
        guard !generating && !saving && !creatingFollowUp else { return }
        followUpDraft = ""
        selectedDigestID = id
        guidance = selectedDigest?["digest"].parsedJSON["customPrompt"].stringValue ?? ""
    }
    func toggleSource(_ id: String) {
        guard !generating && !saving, sourceCandidate(id) else { return }
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
    }
    private func sourceCandidate(_ id: String) -> Bool {
        rows.contains { $0.id == id && $0.node["tree_id"].stringValue == selectedTreeID }
    }
    private func owns(_ row: JSONValue) -> Bool { row["workspace_id"].stringValue == graph.id }

    @discardableResult func refresh() async -> Bool {
        guard !loading else { return false }; loading = true; defer { loading = false }
        do {
            let current = try await freshGraph()
            graph = current; hydrated = true; error = nil
            selection = selection.filter(sourceCandidate)
            if let pendingSave, let node = graph.node(pendingSave["nodeId"].stringValue),
               node["workspace_id"].stringValue == graph.id, node["kind"].stringValue == "digest", node["deleted_at"].isNull,
               Self.sameDigestVersion(node["digest"].parsedJSON, Self.pendingDigest(pendingSave)) {
                clearPendingSave(); notice = "The generated digest is saved."
            }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    private func freshGraph() async throws -> WorkspaceGraph {
        let result = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))")
        guard result["workspace"].id == graph.id, case .array(let nodes) = result["nodes"],
              case .array(let trees) = result["trees"], case .array = result["edges"],
              nodes.allSatisfy({ !$0.id.isEmpty && $0["workspace_id"].stringValue == graph.id }),
              trees.allSatisfy({ !$0.id.isEmpty && $0["workspace_id"].stringValue == graph.id }),
              Set(nodes.map(\.id)).count == nodes.count, Set(trees.map(\.id)).count == trees.count else {
            throw NativeFailure("The workspace overview could not be read. Existing content has been kept.")
        }
        return WorkspaceGraph(raw: result)
    }

    /// Explicit navigation creates only a durable blank branch with a draft.
    /// It never creates a runtime session or sends the question to an agent.
    func exploreDigest(question: String, digestID requestedID: String? = nil) async -> String? {
        guard canExploreDigest, let digestID = selectedDigestID, requestedID == nil || requestedID == digestID, let displayed = selectedDigest else { return nil }
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 32_000 else { followUpError = "Enter a question of at most 32,000 characters."; return nil }
        creatingFollowUp = true; followUpError = nil; defer { creatingFollowUp = false }
        do {
            graph = try await freshGraph()
            let before = try NativeDigestFollowUp.anchor(graph: graph, digestID: digestID)
            guard before.digest["digest"].parsedJSON["content"] == displayed["digest"].parsedJSON["content"],
                  before.digest["digest"].parsedJSON["generatedAt"] == displayed["digest"].parsedJSON["generatedAt"] else {
                throw NativeFailure("This digest was rebuilt on another device. Review its current content before exploring.")
            }
            let allocation = try await api.request("/node-ids/allocate", method: "POST", body: ["count": 1])
            guard let id = allocation["nodeIds"].arrayValue.first?.optionalString, !id.isEmpty else { throw NativeFailure("The backend did not allocate a conversation ID.") }
            graph = try await freshGraph()
            let after = try NativeDigestFollowUp.anchor(graph: graph, digestID: digestID)
            guard before.root.id == after.root.id, before.tree.id == after.tree.id,
                  before.digest["digest"].parsedJSON["content"] == after.digest["digest"].parsedJSON["content"],
                  before.digest["digest"].parsedJSON["generatedAt"] == after.digest["digest"].parsedJSON["generatedAt"] else {
                throw NativeFailure("The digest or its originating thread changed. Review it before exploring.")
            }
            let payload = try NativeDigestFollowUp.creation(graph: graph, digestID: digestID, nodeID: id, question: text)
            try followUpRecovery.save(payload, workspaceID: graph.id); pendingFollowUp = payload
            do {
                _ = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/graph/nodes/ensure", method: "POST", body: payload)
            } catch {
                // Graph ensure is atomic. Known transaction/auth rejections have
                // no graph effects; a lost acknowledgment retains the exact ID.
                if let status = (error as? MichiAPIError)?.statusCode, [400, 401, 403, 404, 409, 422].contains(status) {
                    try followUpRecovery.clear(payload, workspaceID: graph.id); pendingFollowUp = nil
                }
                throw error
            }
            return try await confirmFollowUp(payload)
        } catch {
            if pendingFollowUp == nil { pendingFollowUp = try? followUpRecovery.load(workspaceID: graph.id) }
            followUpError = error.localizedDescription; return nil
        }
    }
    /// Reconciliation is read-only even when an earlier ensure response was lost.
    func checkPendingFollowUp() async -> String? {
        guard !creatingFollowUp, let pendingFollowUp else { return nil }
        creatingFollowUp = true; defer { creatingFollowUp = false }
        do { return try await confirmFollowUp(pendingFollowUp) }
        catch { followUpError = error.localizedDescription; return nil }
    }
    private func confirmFollowUp(_ payload: JSONValue) async throws -> String {
        graph = try await freshGraph()
        guard NativeDigestFollowUp.confirmed(payload: payload, graph: graph) else {
            throw NativeFailure("The follow-up has not been confirmed. Its original draft and conversation ID are saved; checking again only reads the workspace.")
        }
        try followUpRecovery.clear(payload, workspaceID: graph.id); pendingFollowUp = nil; followUpError = nil
        return payload["node"].id
    }
    func applyDigestReadReceipt(_ receipt: NativeDigestReadReceipt) {
        graph.raw["nodes"] = .array(graph.nodes.map { receipt.applying(to: $0) })
    }

    /// Generation is an explicit agent operation. This endpoint has no durable
    /// turn/job identifier or replay API; disconnecting cannot imply cancellation.
    func generate(rebuildDigestID: String? = nil) {
        guard canGenerate else { return }
        generating = true; error = nil; notice = nil; generatedContent = ""; generationThought = ""; generationStatus = "Loading source conversations…"
        requestStarted = false; terminalReceived = false
        let identity = UUID(); generationIdentity = identity
        let treeID = selectedTreeID, prompt = guidance
        generationTask = Task {
            defer { if generationIdentity == identity { generating = false; generationTask = nil; generationIdentity = nil } }
            do {
                graph = try await freshGraph()
                try assertWritableTree(treeID)
                // Rebuild follows the originating thread's current live set,
                // including branches created since the saved digest.
                let sources = rebuildDigestID == nil ? sourceNodes : rows.map(\.node).filter { $0["tree_id"].stringValue == treeID }
                guard !sources.isEmpty, sources.count <= 200 else { throw NativeFailure("Select between 1 and 200 source conversations.") }
                let existing = rebuildDigestID.flatMap { id in digestNodes.first { $0.id == id } }
                if rebuildDigestID != nil && existing == nil { throw NativeFailure("This digest no longer belongs to this thread.") }
                let baseline = existing?["digest"].parsedJSON ?? .null
                let sourceSnapshot = try await loadSources(sources, treeID: treeID)
                let payload = try Self.generationPayload(graph: graph, treeID: treeID, sources: sourceSnapshot, previous: baseline["content"].stringValue, guidance: prompt)
                try Task.checkCancellation()
                guard generationIdentity == identity else { return }
                // Recheck metadata after history hydration, before starting paid work.
                graph = try await freshGraph(); try assertWritableTree(treeID)
                try Task.checkCancellation()
                guard generationIdentity == identity else { return }
                guard sources.allSatisfy({ sourceCandidate($0.id) }) else { throw NativeFailure("The source conversations changed. Refresh before generating.") }
                requestStarted = true
                UserDefaults.standard.set(identity.uuidString, forKey: markerKey)
                for try await frame in api.stream("/digests/stream", method: "POST", body: payload) {
                    try Task.checkCancellation()
                    guard generationIdentity == identity else { return }
                    switch frame.event {
                    case "chunk":
                        let chunk = frame.data["text"].stringValue
                        guard generatedContent.utf8.count + chunk.utf8.count <= 2 * 1024 * 1024 else { throw NativeFailure("The generated digest exceeded the native preview limit. The server may still be working.") }
                        generatedContent += chunk
                    case "thought": generationThought = String((generationThought + frame.data["text"].stringValue).suffix(64_000))
                    case "status": generationStatus = frame.data["text"].stringValue
                    case "done":
                        guard let markdown = frame.data["markdown"].optionalString, !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                              markdown.utf8.count <= 2 * 1024 * 1024 else { throw NativeFailure("The digest stream did not return valid final content.") }
                        generatedContent = markdown; terminalReceived = true
                        // Persist before the first fallible metadata read or ID
                        // allocation. Closing this screen cannot lose the result.
                        try retainCompletedOutput(existing: existing, baseline: baseline, sources: sourceSnapshot, treeID: treeID, prompt: prompt)
                    case "error":
                        terminalReceived = true; clearGenerationMarker()
                        throw NativeFailure(frame.data["message"].optionalString ?? "Digest generation failed.")
                    default: break
                    }
                    if terminalReceived { break }
                }
                guard terminalReceived else { throw NativeFailure("The digest connection ended before its result was confirmed.") }
                clearGenerationMarker()
                generationStatus = "Saving digest…"
                await retrySave()
                generationStatus = ""
            } catch {
                guard generationIdentity == identity else { return }
                let rejected = (error as? MichiAPIError)?.statusCode.map { (400..<500).contains($0) } == true
                if requestStarted && !terminalReceived && !rejected {
                    uncertainGeneration = true
                    self.error = "Generation status is unknown. The server may still be working; this request was not retried. " + error.localizedDescription
                } else {
                    if !requestStarted || rejected { clearGenerationMarker() }
                    if !(error is CancellationError) { self.error = error.localizedDescription }
                }
                generationStatus = ""
            }
        }
    }

    func detachGeneration() {
        // A completed generation has a separate, persisted save operation. Let
        // that operation finish instead of losing its acknowledgment on close.
        guard generating && !terminalReceived else { return }
        if requestStarted && !terminalReceived {
            uncertainGeneration = true
            error = "The preview disconnected. Digest generation may continue on the server; its result cannot be replayed by this endpoint."
        }
        generationTask?.cancel(); generationTask = nil; generationIdentity = nil; generating = false
        generationStatus = ""
    }

    /// Only a separate, confirmed user action may start another operation when
    /// the previous one has no observable terminal result.
    func acknowledgeUnknownGeneration() {
        guard !generating else { return }; clearGenerationMarker(); error = nil
        notice = "A new generation can be started. The previous server operation was not cancelled."
    }
    private func clearGenerationMarker() { UserDefaults.standard.removeObject(forKey: markerKey); uncertainGeneration = false }

    private func assertWritableTree(_ id: String) throws {
        guard hydrated, !graph.isDeleted, !graph.isArchived,
              let tree = graph.trees.first(where: { $0.id == id && owns($0) }), tree["archived_at"].isNull else {
            throw NativeFailure("This workspace or thread is read-only.")
        }
    }

    private func loadSources(_ nodes: [JSONValue], treeID: String) async throws -> [DigestSourceSnapshot] {
        let response = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/trees/\(MichiAPI.pathSegment(treeID))/messages")
        guard case .array(let messages) = response["messages"] else { throw NativeFailure("Conversation history could not be loaded. No digest was started.") }
        return try nodes.map { node in
            guard owns(node), node["tree_id"].stringValue == treeID, node["kind"].stringValue == "chat", node["deleted_at"].isNull else {
                throw NativeFailure("Digest sources must be live conversations in the same thread.")
            }
            let history = messages.filter { $0["node_id"].stringValue == node.id }.sorted { $0["seq"].doubleValue < $1["seq"].doubleValue }
            return DigestSourceSnapshot(node: node, messages: history)
        }
    }

    static func generationPayload(graph: WorkspaceGraph, treeID: String, sources: [DigestSourceSnapshot], previous: String, guidance: String) throws -> JSONValue {
        guard let tree = graph.trees.first(where: { $0.id == treeID }), !sources.isEmpty else { throw NativeFailure("Choose a thread with source conversations.") }
        let cwd = graph.workspace["cwd"].stringValue
        let created = graph.workspace["created_at"].doubleValue
        guard created.isFinite, created >= 0, created <= 253_402_300_799_000 else { throw NativeFailure("Workspace creation metadata is invalid.") }
        var workspace: JSONValue = ["name": .string(graph.name), "createdAt": .number(created)]
        var payload: JSONValue = ["workspaceId": .string(graph.id), "workspace": workspace,
                                  "rootTitle": graph.node(tree["root_node_id"].stringValue).map { .string(graph.title($0)) } ?? .string(graph.name),
                                  "nodes": .array(sources.map(\.payload))]
        if !cwd.isEmpty { workspace["cwd"] = .string(cwd); payload["workspace"] = workspace; payload["cwd"] = .string(cwd) }
        if !previous.isEmpty { payload["previousContent"] = .string(previous) }
        if !guidance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { payload["customPrompt"] = .string(guidance) }
        guard try JSONEncoder().encode(payload).count <= 4 * 1024 * 1024 else { throw NativeFailure("These conversations exceed the native digest request limit. Select fewer sources.") }
        return payload
    }

    private func retainCompletedOutput(existing: JSONValue?, baseline: JSONValue, sources: [DigestSourceSnapshot], treeID: String, prompt: String) throws {
        let now = (Date().timeIntervalSince1970 * 1000).rounded()
        var digest: JSONValue = existing == nil ? ["viewedAt": 0] : baseline
        digest = digest.merging([
                                  "content": .string(generatedContent), "sources": .array(sources.map { .string($0.id) }),
                                  "sourceFingerprints": .object(Dictionary(uniqueKeysWithValues: sources.map { ($0.id, .string($0.fingerprint)) })),
                                  "generatedAt": .number(now), "status": "idle"])
        var fields = digest.objectValue; fields.removeValue(forKey: "error"); fields.removeValue(forKey: "generation")
        if prompt.isEmpty { fields.removeValue(forKey: "customPrompt") } else { fields["customPrompt"] = .string(prompt) }
        digest = .object(fields)
        let output: JSONValue = ["version": 1, "workspaceId": .string(graph.id), "treeId": .string(treeID),
            "existingNodeId": existing.map { .string($0.id) } ?? .null, "nodeId": existing.map { .string($0.id) } ?? .null,
            "operationId": .string(UUID().uuidString), "digest": digest, "baseline": baseline]
        try persistOutput(output)
    }

    private func persistOutput(_ output: JSONValue) throws {
        let data = try JSONEncoder().encode(output)
        UserDefaults.standard.set(data, forKey: outputKey)
        pendingOutput = output
    }

    private func prepareSave() async throws {
        guard var output = pendingOutput, Self.validPendingOutput(output, workspaceID: graph.id) else {
            throw NativeFailure("No completed digest is available to save.")
        }
        let treeID = output["treeId"].stringValue, baseline = output["baseline"]
        var digest = output["digest"]
        graph = try await freshGraph(); hydrated = true; try assertWritableTree(treeID)
        let eligible = Set(Self.mapRows(graph: graph, treeID: treeID).filter { $0.node["tree_id"].stringValue == treeID }.map(\.id))
        guard digest["sources"].arrayValue.allSatisfy({ eligible.contains($0.stringValue) }) else {
            throw NativeFailure("Sources changed while generating. The completed output is kept locally and has not been saved.")
        }
        let existingID = output["existingNodeId"].optionalString
        if let existingID {
            // node.patch has no revision/CAS. This fresh comparison prevents
            // known conflicts but cannot make the final GET→POST race atomic.
            guard let current = graph.node(existingID), owns(current), current["kind"].stringValue == "digest", current["deleted_at"].isNull,
                  Self.sameDigestVersion(current["digest"].parsedJSON, baseline) else {
                throw NativeFailure("This digest changed on another device. The generated output has been kept here; the saved version was not overwritten.")
            }
            // Preserve auxiliary fields changed while generation was running.
            // This is still preparation: once commands are persisted below,
            // every retry uses that exact body instead of merging again.
            var fields = current["digest"].parsedJSON.objectValue
            for key in ["content", "sources", "sourceFingerprints", "generatedAt", "status", "customPrompt"] {
                if let value = digest.objectValue[key] { fields[key] = value } else { fields.removeValue(forKey: key) }
            }
            fields.removeValue(forKey: "error"); fields.removeValue(forKey: "generation")
            digest = .object(fields); output["digest"] = digest
            try persistOutput(output)
        }
        if output["nodeId"].stringValue.isEmpty {
            // Allocation creates no digest or agent work. If its response is
            // lost, retrying allocation can consume an unused ID, not duplicate
            // a generation. Once an ID is known, persist and reuse it.
            let allocation = try await api.request("/node-ids/allocate", method: "POST", body: ["count": 1])
            guard let allocated = allocation["nodeIds"].arrayValue.first?.optionalString, !allocated.isEmpty else {
                throw NativeFailure("Could not allocate a saved digest ID. Retry saving the retained output.")
            }
            output["nodeId"] = .string(allocated)
            try persistOutput(output)
        }
        let id = output["nodeId"].stringValue, now = digest["generatedAt"].doubleValue
        let title = digest["content"].stringValue.components(separatedBy: "\n").first(where: { $0.hasPrefix("# ") }).map { String($0.dropFirst(2)).trimmingCharacters(in: .whitespaces) } ?? "Thread digest"
        var node: JSONValue = ["id": .string(id), "title": .string(title), "digest": .string(digest.prettyPrinted)]
        if existingID == nil {
            node = node.merging(["workspace_id": .string(graph.id), "tree_id": .null, "parent_node_id": .null, "kind": "digest", "created_at": .number(now)])
        }
        var commands: [JSONValue] = [["type": existingID == nil ? "node.upsert" : "node.patch", "payload": node]]
        for source in digest["sources"].arrayValue {
            commands.append(["type": "edge.upsert", "payload": ["id": .string("digest-source-\(source.stringValue)-\(id)"), "workspace_id": .string(graph.id),
                                                                      "source_node_id": source, "target_node_id": .string(id), "kind": "digest-source", "created_at": .number(now)]])
        }
        let pending: JSONValue = ["workspaceId": .string(graph.id), "treeId": .string(treeID), "nodeId": .string(id),
                                  "operationId": output["operationId"], "commands": .array(commands), "baseline": baseline]
        UserDefaults.standard.set(try JSONEncoder().encode(pending), forKey: saveKey)
        pendingSave = pending
    }

    func retrySave() async {
        guard !saving, hasUnsavedOutput else { return }
        saving = true; defer { saving = false }
        do {
            if pendingSave == nil { try await prepareSave() }
            guard let pending = pendingSave, Self.validPendingSave(pending, workspaceID: graph.id) else {
                throw NativeFailure("The pending save is invalid. The completed output has been kept.")
            }
            graph = try await freshGraph(); hydrated = true; try assertWritableTree(pending["treeId"].stringValue)
            let digest = Self.pendingDigest(pending), nodeID = pending["nodeId"].stringValue
            if let current = graph.node(nodeID) {
                guard owns(current), current["kind"].stringValue == "digest", current["deleted_at"].isNull else {
                    throw NativeFailure("The saved digest is no longer available for editing.")
                }
                if Self.sameDigestVersion(current["digest"].parsedJSON, digest) {
                    selectedDigestID = nodeID; clearPendingSave(); error = nil; notice = "Digest saved."; return
                }
                guard pending["commands"].arrayValue.first?["type"].stringValue == "node.patch",
                      Self.sameDigestVersion(current["digest"].parsedJSON, pending["baseline"]) else {
                    throw NativeFailure("The saved digest changed on another device. The pending output has been kept without overwriting it.")
                }
            } else if pending["commands"].arrayValue.first?["type"].stringValue == "node.patch" {
                throw NativeFailure("The digest to update no longer exists.")
            }
            guard digest["sources"].arrayValue.allSatisfy({ source in
                guard let node = graph.node(source.stringValue) else { return false }
                return owns(node) && node["tree_id"] == pending["treeId"] && node["kind"].stringValue == "chat" && node["deleted_at"].isNull
            }) else { throw NativeFailure("Digest sources changed. The output has been kept without saving.") }
            let response = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/commands", method: "POST",
                                                 body: ["operationId": pending["operationId"], "commands": pending["commands"]])
            guard response["ok"].boolValue, response["operationId"] == pending["operationId"],
                  response["applied"].arrayValue.contains(where: { $0.id == pending["nodeId"].stringValue }) else {
                throw NativeFailure("The save acknowledgment was incomplete. The exact save operation has been retained for retry.")
            }
            selectedDigestID = pending["nodeId"].stringValue
            clearPendingSave(); error = nil; notice = "Digest saved."
            _ = await refresh()
        } catch {
            self.error = "The completed digest is kept locally but has not been confirmed saved. Retry saving without regenerating. " + error.localizedDescription
        }
    }
    func discardPendingSave() {
        guard !generating && !saving else { return }
        clearPendingSave(); error = nil
        notice = "The pending save was discarded. You can still copy the displayed output."
    }
    private static func sameDigestVersion(_ first: JSONValue, _ second: JSONValue) -> Bool {
        ["content", "generatedAt", "customPrompt", "sources", "sourceFingerprints"].allSatisfy { first[$0] == second[$0] }
    }
    private func clearPendingSave() {
        pendingSave = nil; pendingOutput = nil
        UserDefaults.standard.removeObject(forKey: saveKey); UserDefaults.standard.removeObject(forKey: outputKey)
    }
    private static func validPendingOutput(_ output: JSONValue, workspaceID: String) -> Bool {
        let digest = output["digest"], sources = digest["sources"].arrayValue.map(\.stringValue)
        guard output["version"] == 1, output["workspaceId"].stringValue == workspaceID, !output["treeId"].stringValue.isEmpty,
              UUID(uuidString: output["operationId"].stringValue) != nil, !digest["content"].stringValue.isEmpty,
              digest["content"].stringValue.utf8.count <= 2 * 1024 * 1024,
              case .number(let at) = digest["generatedAt"], at.isFinite, at >= 0, at <= 253_402_300_799_000,
              !sources.isEmpty, sources.count <= 200, !sources.contains(""), Set(sources).count == sources.count,
              sources.allSatisfy({ digest["sourceFingerprints"][$0].stringValue.hasPrefix("v2:") }),
              output["existingNodeId"].isNull || (!output["existingNodeId"].stringValue.isEmpty && output["existingNodeId"] == output["nodeId"]) else { return false }
        return output["nodeId"].isNull || !output["nodeId"].stringValue.isEmpty
    }
    private static func pendingDigest(_ pending: JSONValue) -> JSONValue { pending["commands"].arrayValue.first?["payload"]["digest"].parsedJSON ?? .null }
    private static func validPendingSave(_ pending: JSONValue, workspaceID: String) -> Bool {
        guard pending["workspaceId"].stringValue == workspaceID, !pending["nodeId"].stringValue.isEmpty, !pending["treeId"].stringValue.isEmpty,
              UUID(uuidString: pending["operationId"].stringValue) != nil,
              let first = pending["commands"].arrayValue.first, ["node.upsert", "node.patch"].contains(first["type"].stringValue),
              first["payload"].id == pending["nodeId"].stringValue, !pendingDigest(pending)["content"].stringValue.isEmpty else { return false }
        return pending["commands"].arrayValue.count <= 500 && pending["commands"].arrayValue.allSatisfy {
            let payload = $0["payload"]
            switch $0["type"].stringValue {
            case "node.patch": return payload.id == pending["nodeId"].stringValue && Set(payload.objectValue.keys).isSubset(of: ["id", "title", "digest"])
            case "node.upsert": return payload.id == pending["nodeId"].stringValue && payload["workspace_id"].stringValue == workspaceID && payload["kind"].stringValue == "digest"
            case "edge.upsert": return payload["workspace_id"].stringValue == workspaceID && payload["target_node_id"].stringValue == pending["nodeId"].stringValue && payload["kind"].stringValue == "digest-source"
            default: return false
            }
        }
    }

    static func mapRows(graph: WorkspaceGraph, treeID: String) -> [WorkspaceOverviewRow] {
        guard let tree = graph.trees.first(where: { $0.id == treeID && $0["workspace_id"].stringValue == graph.id }),
              tree["archived_at"].isNull else { return [] }
        let candidates = graph.nodes.filter { $0["workspace_id"].stringValue == graph.id && $0["deleted_at"].isNull &&
            $0["kind"].stringValue == "chat" && $0["page_id"].isNull && $0["maintenance_job_id"].isNull }
        let nodes = Dictionary(candidates.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard nodes[tree["root_node_id"].stringValue] != nil else { return [] }
        let edges = graph.edges.filter { ($0["workspace_id"].isNull || $0["workspace_id"].stringValue == graph.id) &&
            ["", "branch", "merge"].contains($0["kind"].stringValue) && nodes[$0["source_node_id"].stringValue] != nil && nodes[$0["target_node_id"].stringValue] != nil }
        var seeds = [tree["root_node_id"].stringValue]
        let branchParents = Dictionary(edges.filter { ["", "branch"].contains($0["kind"].stringValue) }.map {
            ($0["target_node_id"].stringValue, $0["source_node_id"].stringValue)
        }, uniquingKeysWith: { _, last in last })
        // TreeRow has no `kind` column. Web hydration derives a merge tree and
        // its sources from incoming merge edges at the persisted root node.
        for edge in edges where edge["kind"].stringValue == "merge" && edge["target_node_id"].stringValue == tree["root_node_id"].stringValue {
            var next: String? = edge["source_node_id"].stringValue; var walked = Set<String>()
            while let id = next, nodes[id] != nil, walked.insert(id).inserted {
                seeds.append(id); next = branchParents[id]
            }
        }
        let children = Dictionary(grouping: edges, by: { $0["source_node_id"].stringValue })
        var seen = Set<String>(), rows: [WorkspaceOverviewRow] = []
        var stack = seeds.reversed().map { ($0, 0) }
        while let (id, depth) = stack.popLast() {
            guard seen.insert(id).inserted, let node = nodes[id] else { continue }
            rows.append(WorkspaceOverviewRow(node: node, depth: min(depth, 20)))
            for edge in (children[id] ?? []).reversed() { stack.append((edge["target_node_id"].stringValue, min(depth + 1, 20))) }
        }
        return rows
    }

    static func overview(_ node: JSONValue) -> String {
        overviewTrail(node).last?["text"].stringValue ?? ""
    }
    static func overviewTrail(_ node: JSONValue) -> [JSONValue] {
        let raw = node["branch_overview"]
        if case .array(let entries) = raw.parsedJSON {
            return entries.compactMap { entry in
                guard case .number(let at) = entry["at"], at.isFinite,
                      let text = entry["text"].optionalString, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return ["at": .number(at), "text": .string(text.trimmingCharacters(in: .whitespacesAndNewlines))]
            }
        }
        let text = raw.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? [] : [["at": 0, "text": .string(text)]]
    }
    static func treeTitle(_ tree: JSONValue, graph: WorkspaceGraph) -> String {
        let name = tree["name"].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = name.isEmpty ? graph.node(tree["root_node_id"].stringValue).map(graph.title) ?? "Thread" : name
        return title + (tree["archived_at"].isNull ? "" : " · Archived")
    }
    /// GET /workspaces/:id returns MessageRow.created_at alongside NodeRow.
    /// NodeRow has no last_assistant_at. Journal timestamps also record actual
    /// branch activity; created_at is the fallback for empty conversations.
    static func activityDates(graph: WorkspaceGraph) -> [String: Double] {
        var result: [String: Double] = [:]
        func valid(_ value: JSONValue) -> Double? {
            guard case .number(let at) = value, at.isFinite, at >= 0, at <= 253_402_300_799_000 else { return nil }
            return at
        }
        for node in graph.nodes where node["workspace_id"].stringValue == graph.id {
            let trailAt = overviewTrail(node).compactMap { valid($0["at"]) }.max() ?? 0
            result[node.id] = max(valid(node["created_at"]) ?? 0, trailAt)
        }
        for message in graph.raw["messages"].arrayValue {
            let id = message["node_id"].stringValue
            guard let previous = result[id], let at = valid(message["created_at"]) else { continue }
            result[id] = max(previous, at)
        }
        return result
    }
}

struct DigestSourceSnapshot {
    let id: String
    let payload: JSONValue
    let canonicalJSON: String
    var fingerprint: String {
        var hash: UInt32 = 0x811c9dc5
        for unit in canonicalJSON.utf16 { hash ^= UInt32(unit); hash = hash &* 0x01000193 }
        return "v2:" + String(format: "%08x", hash)
    }
    init(node: JSONValue, messages: [JSONValue]) {
        id = node.id
        let visible: [JSONValue] = messages.compactMap { message in
            let role = message["role"].stringValue
            guard ["user", "assistant"].contains(role) else { return nil }
            let blocks = message["blocks"].parsedJSON.arrayValue
            let raw = role == "assistant" && !blocks.isEmpty && blocks.allSatisfy(Self.validBlock) ? blocks.filter { $0["kind"].stringValue == "answer" }.map { $0["rawText"].stringValue }.joined() : message["content"].stringValue
            let text = role == "assistant" ? Self.visibleAssistant(raw) : raw
            return text.isEmpty ? nil : ["role": .string(role), "text": .string(text)]
        }
        var value: JSONValue = ["nodeId": .string(id), "depth": 0, "messages": .array(visible)]
        var fields = ["\"nodeId\":\(Self.quote(id))"]
        for (wire, column) in [("parentNodeId", "parent_node_id"), ("title", "title")] where !node[column].stringValue.isEmpty {
            value[wire] = node[column]; fields.append("\"\(wire)\":\(Self.quote(node[column].stringValue))")
        }
        fields.append("\"depth\":0")
        fields.append("\"messages\":[" + visible.map { "{\"role\":\(Self.quote($0["role"].stringValue)),\"text\":\(Self.quote($0["text"].stringValue))}" }.joined(separator: ",") + "]")
        payload = value; canonicalJSON = "{" + fields.joined(separator: ",") + "}"
    }
    private static func validBlock(_ block: JSONValue) -> Bool {
        guard !block.id.isEmpty else { return false }
        switch block["kind"].stringValue {
        case "answer", "thinking": return block["rawText"].optionalString != nil
        case "image": return block["path"].optionalString != nil
        case "user-input":
            if case .number = block["requestId"], case .number(let offset) = block["rawOffset"] {
                return offset.isFinite && block["section"].stringValue == "answer"
            }
            return false
        case "tool":
            if case .number(let offset) = block["rawOffset"] {
                return offset.isFinite && block["toolCallId"].optionalString != nil && ["answer", "thinking"].contains(block["section"].stringValue)
            }
            return false
        default: return false
        }
    }
    private static func quote(_ string: String) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
        return (try? encoder.encode(string)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    /// Digest watermarks must fingerprint the web DTO, including its preserved
    /// whitespace. The chat display's trimming helper is not equivalent here.
    /// Mirrors stripSentinelsStreamingSafe after the bounded steering scanner.
    static func visibleAssistant(_ input: String) -> String {
        let raw = Array(DigestSteeringProjection.visible(input).unicodeScalars)
        let prefixes = ["[TITLE:", "[BRANCH-OVERVIEW:", "[FOLLOW-UP"]
        var index = 0, hold: Int?, cursor = 0, recognized = false, output = String.UnicodeScalarView()
        while index < raw.count {
            let char = raw[index]
            guard let start = hold else {
                if char == "[" { hold = index; recognized = false }
                index += 1; continue
            }
            if char == "]" {
                if recognized {
                    output.append(contentsOf: raw[cursor..<start])
                    index += 1
                    while index < raw.count && DigestSteeringProjection.isWhitespace(raw[index]) { index += 1 }
                    cursor = index
                } else { index += 1 }
                hold = nil; continue
            }
            // Once a complete prefix is recognized, later content cannot change
            // its classification. Avoid copying an arbitrarily long marker body.
            if !recognized {
                let candidate = String(String.UnicodeScalarView(raw[start...index])).uppercased()
                if prefixes.contains(where: { candidate.hasPrefix($0) }) { recognized = true }
                else if !prefixes.contains(where: { $0.hasPrefix(candidate) }) { hold = nil }
            }
            index += 1
        }
        output.append(contentsOf: raw[cursor..<(hold ?? raw.count)])
        return String(output)
    }
}

/// Native port of shared/src/kiroSteering.ts's text projection. Only a native
/// steering ID at an unquoted, non-code line start is metadata. The body is
/// bounded to 8,192 Unicode code points and a blank line, as on the web.
private enum DigestSteeringProjection {
    static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        // JavaScript /\s/ (not Foundation's additional U+0085 whitespace).
        scalar.value == 0xFEFF || [0x09...0x0D, 0x20...0x20, 0xA0...0xA0, 0x1680...0x1680,
                                 0x2000...0x200A, 0x2028...0x2029, 0x202F...0x202F, 0x205F...0x205F, 0x3000...0x3000].contains { $0.contains(Int(scalar.value)) }
    }
    static func visible(_ raw: String) -> String {
        let prefix = "[STEERING steer-"
        let nativeID = try? NSRegularExpression(pattern: #"^steer-(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$"#, options: .caseInsensitive)
        var header = "", report = false, bodyLength = 0, depth = 0, escaped = false, newline = false
        var indent = 0, phase = 0, fenceChar: Unicode.Scalar?, fenceCount = 0, fenceTailWhitespace = true
        var fence: (Unicode.Scalar, Int)?, output = String.UnicodeScalarView()
        func advance(_ ch: Unicode.Scalar) {
            if ch == "\n" {
                if let character = fenceChar, fenceCount >= 3 {
                    if fence == nil { fence = (character, fenceCount) }
                    else if fence?.0 == character && fenceCount >= (fence?.1 ?? 0) && fenceTailWhitespace { fence = nil }
                }
                indent = 0; phase = 0; fenceChar = nil; fenceCount = 0; fenceTailWhitespace = true
            } else if phase == 0 {
                if ch == " " && indent < 3 { indent += 1 }
                else if ch == "`" || ch == "~" { phase = 1; fenceChar = ch; fenceCount = 1 }
                else { phase = 2 }
            } else if phase == 1 && ch == fenceChar { fenceCount += 1 }
            else { phase = 2; if !isWhitespace(ch) { fenceTailWhitespace = false } }
        }
        for ch in raw.unicodeScalars {
            if report {
                if bodyLength >= 8192 || (ch == "\n" && newline) {
                    report = false; bodyLength = 0; depth = 0; escaped = false; newline = false
                    output.append(ch); advance(ch); continue
                }
                if ch == "]" && !escaped && depth == 0 {
                    report = false; bodyLength = 0; depth = 0; escaped = false; newline = false
                } else {
                    if !escaped && ch == "[" { depth += 1 }
                    if !escaped && ch == "]" { depth -= 1 }
                    bodyLength += 1; escaped = ch == "\\" && !escaped
                    if ch == "\n" { newline = true } else if !isWhitespace(ch) { newline = false }
                }
                if ch == "\n" { advance(ch) } else { phase = 2 }
                continue
            }
            if !header.isEmpty {
                header.unicodeScalars.append(ch)
                if header.utf16.count <= prefix.utf16.count {
                    if !prefix.hasPrefix(header) { output.append(contentsOf: header.unicodeScalars); header = "" }
                } else {
                    let id = String(header.dropFirst(10).dropLast())
                    if ch == ":" && nativeID?.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil {
                        report = true; header = ""
                    } else if !("0123456789abcdefABCDEF-".unicodeScalars.contains(ch)) || header.utf16.count > 52 {
                        output.append(contentsOf: header.unicodeScalars); header = ""
                    }
                }
                advance(ch); continue
            }
            if ch == "[" && phase == 0 && fence == nil { header = "[" }
            else { output.append(ch) }
            advance(ch)
        }
        if !report { output.append(contentsOf: header.unicodeScalars) }
        return String(output)
    }
}
