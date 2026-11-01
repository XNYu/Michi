#if DEBUG
import Foundation
import MichiCore

/// Read-only fixtures for the real same-connection reference resolver. These
/// are enabled only with --uitesting and never intercept writes or real hosts.
enum ReferenceParityFixtures {
    struct Response {
        let value: JSONValue
        var status = 200
    }
    static let previewFlags = ["--preview-reference-message", "--preview-reference-helper", "--preview-reference-page", "--preview-reference-missing", "--preview-page-sources"]
    private static var arguments: [String] { ProcessInfo.processInfo.arguments }
    static var active: Bool { arguments.contains("--uitesting") && (previewFlags.contains { arguments.contains($0) } || arguments.contains("--preview-reference-links") || arguments.contains("--preview-reference-table") || arguments.contains("--preview-search") || TaskUpkeepFixtures.active) }
    static var reference: NativeMichiReference? {
        guard active else { return nil }
        if arguments.contains("--preview-reference-helper") { return .source(nodeID: "source-helper", turnID: "helper-turn", assistantID: "helper-answer") }
        if arguments.contains("--preview-reference-page") { return .page(id: "page-reference", blockID: "source-body") }
        if arguments.contains("--preview-reference-missing") { return .node(id: "n-preview", messageID: "missing-answer") }
        if arguments.contains("--preview-reference-message") { return .node(id: "n-preview", messageID: "source-answer") }
        return nil
    }
    static let ordinarySource: JSONValue = ["nodeId": "n-preview", "turnId": "source-turn", "assistantId": "source-answer"]
    static let helperSource: JSONValue = ["nodeId": "source-helper", "turnId": "helper-turn", "assistantId": "helper-answer"]
    static let segments: [JSONValue] = [
        ["text": "## Cited conclusion", "sources": []],
        ["text": "The native page retains exact source passages.", "sources": [ordinarySource]],
        ["text": "- Ordinary conversation evidence.", "sources": [ordinarySource]],
        ["text": "- Helper evidence from the saved turn.", "sources": [helperSource]],
    ]
    static var page: JSONValue {
        let leading: [JSONValue] = (1...8).map { index in
            ["id": .string("reference-context-\(index)"), "rev": 1, "type": "markdown",
             "text": .string("Context \(index). The cited conclusion is farther down this page.")]
        }
        let cited: [JSONValue] = [
        ["id": "source-body", "rev": 3, "type": "markdown", "text": .string(segments.map { $0["text"].stringValue }.joined(separator: "\n\n")),
         "segmentSources": .array(segments), "sources": [ordinarySource, helperSource], "edit": ["at": 1_700_000_004_000]],
        ["id": "reference-links", "rev": 1, "type": "markdown", "text": "[Open original reply](michi://node/n-preview?message=source-answer)\n\n[Open linked page](michi://page/page-reference?block=source-body)"],
        ["id": "source-footer", "rev": 1, "type": "callout", "tone": "info", "text": "Source actions read saved content. They do not send a message or start a helper."]
        ]
        return ["id": "page-reference", "workspaceId": "ws-preview", "title": "Cited native page", "revision": 3, "blocks": .array(leading + cited)]
    }

    static var messages: [JSONValue] {
        var rows: [JSONValue] = []
        func message(_ id: String, node: String = "n-preview", role: String, text: String, seq: Int) -> JSONValue {
            ["id": .string(id), "node_id": .string(node), "role": .string(role), "content": .string(text), "seq": .number(Double(seq)),
             "created_at": .number(1_700_000_000_000 + Double(seq) * 1000), "blocks": "[]", "tool_calls": "[]", "metadata": "{}"]
        }
        // Surround the target with genuine, distinct rows: a reader must scroll
        // to its exact identity instead of selecting the newest assistant reply.
        for index in 0..<7 {
            rows.append(message("source-before-\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant", text: index == 0 ? "Can we retain the native source evidence?" : "Earlier context \(index + 1). This is not the cited reply.", seq: index))
        }
        rows.append(message("source-answer", role: "assistant", text: "The exact original source reply.\n\nNative pages preserve the cited evidence.\n\n[Open linked page](michi://page/page-reference?block=source-body)\n\n| Source |\n| --- |\n| [Open table page](michi://page/page-reference?block=source-body) |", seq: 7))
        for index in 8..<13 {
            rows.append(message("source-after-\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant", text: "Later context \(index). This is not the cited reply.", seq: index))
        }
        rows.append(message("source-links", role: "assistant", text: "[Open original reply](michi://node/n-preview?message=source-answer)\n\n[Open linked page](michi://page/page-reference?block=source-body)", seq: 13))
        rows.append(message("helper-question", node: "source-helper", role: "user", text: "Read the saved evidence for the page.", seq: 0))
        rows.append(message("helper-older-answer", node: "source-helper", role: "assistant", text: "An older helper reply, from another turn.", seq: 1))
        rows.append(message("helper-answer", node: "source-helper", role: "assistant", text: "The exact helper evidence from the saved turn.", seq: 2))
        rows.append(message("helper-newer-answer", node: "source-helper", role: "assistant", text: "A newer helper reply must not replace the cited turn.", seq: 3))
        return rows
    }

    static func augment(_ original: JSONValue) -> JSONValue {
        guard active else { return original }
        var graph = original
        graph["nodes"] = .array(original["nodes"].arrayValue + [["id": "source-helper", "workspace_id": "ws-preview", "tree_id": "tree-preview", "parent_node_id": "n-preview",
            "page_id": "page-reference", "kind": "chat", "title": "Saved page helper", "status": "idle", "deleted_at": .null, "purged_at": .null, "created_at": 1_700_000_000_000]])
        return graph
    }

    static func response(path: String, method: String, url: URL) -> Response? {
        guard active, method == "GET" else { return nil }
        if path == "/search", arguments.contains("--preview-search") {
            return Response(value: ["totalNodes": 1, "results": [[
                "nodeId": "n-preview", "nodeTitle": "A native home for your ideas", "workspaceId": "ws-preview", "workspaceName": "Michi Studio",
                "treeId": "tree-preview", "lastMessageAt": 1_700_000_013_000, "totalMatches": 2, "breadcrumb": ["A native home for your ideas"],
                "snippets": [
                    ["messageId": "source-answer", "role": "assistant", "snippet": "The exact original source reply. <mark>Native</mark> pages preserve the cited evidence."],
                    ["messageId": "source-before-0", "role": "user", "snippet": "Can we retain the <mark>native</mark> source evidence?"]
                ]
            ]]])
        }
        if path == "/pages/page-reference" { return Response(value: page) }
        if path == "/workspaces/ws-preview/trees/tree-preview/messages" { return Response(value: ["messages": .array(messages)]) }
        if path == "/spaces-home/source" {
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let node = query.first { $0.name == "nodeId" }?.value
            let message = query.first { $0.name == "messageId" }?.value
            let source: JSONValue
            if node == "n-preview", message == "source-answer" { source = ordinarySource }
            else if node == "source-helper", message == "helper-answer" { source = helperSource }
            else { return Response(value: ["error": ["code": "not_found", "message": "The exact fixture source is unavailable."]], status: 404) }
            let row = messages.first { $0.id == message && $0["node_id"].stringValue == node }!
            return Response(value: ["nodeId": source["nodeId"], "workspaceId": "ws-preview", "workspaceName": "Michi Studio",
                "title": .string(node == "source-helper" ? "Saved page helper" : "A native home for your ideas"), "runtimeId": "codex", "state": "live",
                "message": ["id": row["id"], "role": row["role"], "text": row["content"], "truncated": false, "turnId": source["turnId"], "at": row["created_at"]]])
        }
        return nil
    }
}
#endif
