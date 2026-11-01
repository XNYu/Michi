import Foundation
import MichiCore

extension ChatController {
    /// Only records from the already hydrated owning workspace are eligible.
    func artifactManifest(for composer: NativeComposer?) throws -> (all: [JSONValue], selected: [JSONValue]) {
        var all: [JSONValue] = [], selected: [JSONValue] = []
        let explicit = Set(composer?.mentions.filter { $0["kind"] == "context" }.map { $0["refId"].stringValue } ?? [])
        let text = composer?.expandedText ?? ""
        for artifact in graph.contexts {
            let name = artifact["name"].stringValue, path = artifact["file_path"].stringValue, url = artifact["url"].stringValue
            guard !name.isEmpty, name.count <= 64, !path.isEmpty || !url.isEmpty else { continue }
            var row: JSONValue = ["name": .string(name), "filePath": .string(path)]
            if !path.isEmpty { row["filePath"] = .string(path) }
            if !url.isEmpty { row["url"] = .string(url) }
            if ["embedded", "reference", "symlink"].contains(artifact["kind"].stringValue) { row["kind"] = artifact["kind"] }
            if case .number(let size) = artifact["size"], size >= 0 { row["size"] = .number(size) }
            all.append(row)
            let pattern = "(?:^|\\s)@" + NSRegularExpression.escapedPattern(for: name) + "(?=$|[^\\p{L}\\p{N}_.-])"
            if explicit.contains(artifact.id) || text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil { selected.append(row) }
        }
        guard selected.count <= 20 else { throw NativeFailure("Reference at most 20 artifacts in one message.") }
        return (Array(all.prefix(50)), selected)
    }
    func resolvedPrompt(_ composer: NativeComposer) async throws -> String {
        let ids = composer.mentions.filter { $0["kind"] == "node" }.map { $0["refId"].stringValue }
        var seen = Set<String>(), blocks: [String] = [], histories: [String: [JSONValue]] = [:]
        var clean = composer.wireText
        guard ids.count <= 20 else { throw NativeFailure("Reference at most 20 conversations in one message.") }
        for id in ids where seen.insert(id).inserted {
            guard let reference = graph.nodes.first(where: { $0.id == id && $0["deleted_at"].isNull }) else { throw NativeFailure("A referenced conversation is no longer available in this workspace. Remove its mention before sending.") }
            let treeID = reference["tree_id"].stringValue
            guard !treeID.isEmpty else { throw NativeFailure("The referenced conversation has no saved tree.") }
            if histories[treeID] == nil {
                let history = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/trees/\(MichiAPI.pathSegment(treeID))/messages")
                guard case .array(let rows) = history["messages"] else { throw NativeFailure("Could not read the referenced conversation.") }
                histories[treeID] = rows
            }
            let messages = histories[treeID]!.filter { $0["node_id"].stringValue == id }.sorted { $0["seq"].intValue < $1["seq"].intValue }
            let title = graph.title(reference)
            let transcript = messages.map { row in
                let content = row["role"] == "assistant" ? AssistantText.visible(row["content"].stringValue) : row["content"].stringValue
                return (row["role"] == "user" ? "User: " : "Assistant: ") + content
            }.joined(separator: "\n\n")
            let full = "=== Referenced node: \(title) ===\n" + transcript
            if full.utf16.count <= 2048 { blocks.append(full) }
            else {
                let journal = reference["branch_overview"].parsedJSON.arrayValue.map { $0["text"].stringValue }.joined(separator: " ")
                let summary = journal.isEmpty ? String((messages.first { $0["role"] == "user" }?["content"].stringValue ?? "(no summary)").prefix(200)) : journal
                let encodedID = JSONValue.string(id).prettyPrinted
                blocks.append("=== Referenced node: \(title) (\(id), \(messages.count) messages) ===\nSummary: \(summary)\nTo read the full conversation, use: read_node_overview(\(encodedID)) for the journal, or read_node(\(encodedID)) for the transcript.")
            }
            clean = clean.replacingOccurrences(of: NativeComposer.nodeToken(id), with: "")
        }
        guard !blocks.isEmpty else { return clean }
        return "The user referenced the following chat nodes. Short conversations are included in full; for longer ones, use read_node or read_node_overview to retrieve full content when needed:\n\n" + blocks.joined(separator: "\n\n") + "\n\n---\n\n" + clean
    }
}
