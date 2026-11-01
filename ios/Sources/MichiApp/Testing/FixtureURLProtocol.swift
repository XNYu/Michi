#if DEBUG
import Foundation
import MichiCore

/// Explicit UI-test-only backend. Every request is intercepted; unknown routes
/// fail closed. It cannot invoke a real agent or read the user's Michi database.
final class FixtureURLProtocol: URLProtocol, @unchecked Sendable {
    /// Fresh synthetic server per process. Persisted unknown turns from an
    /// earlier fixture cannot be reconciled against newly reset fake history.
    static let baseURL = URL(string: "https://fixture-\(UUID().uuidString.lowercased()).michi.test")!
    private static let lock = NSRecursiveLock()
    private static var graph: JSONValue = {
        var value: JSONValue = [
        "workspace": ["id": "ws-preview", "name": "Michi Studio", "cwd": "/tmp/michi-ios-fixture", "created_at": 1, "settings": "{}", "deleted_at": .null, "archived_at": .null],
        "trees": [["id": "tree-preview", "workspace_id": "ws-preview", "root_node_id": "n-preview", "created_at": 1, "last_active_at": 1, "archived_at": .null]],
        "nodes": [["id": "n-preview", "workspace_id": "ws-preview", "tree_id": "tree-preview", "title": "A native home for your ideas", "kind": "chat", "status": "idle", "deleted_at": .null, "created_at": 1]],
        "edges": [], "contexts": [["id": "artifact-preview", "name": "Project notes", "file_path": "notes.md", "type": "doc"]], "messages": []
        ]
        if ProcessInfo.processInfo.arguments.contains("--preview-digest") {
            let digest: JSONValue = ["status": "idle", "generatedAt": .number(Date().timeIntervalSince1970 * 1000 - 720_000), "viewedAt": 0, "sources": ["n-preview"], "content": "# A native home for Michi\n\nChats, pages and agent controls share a native interface.\n\n## Open Questions\n- How should we validate the next milestone?\n- What belongs in the first iPhone release?"]
            value["nodes"] = .array(value["nodes"].arrayValue + [["id": "digest-preview", "workspace_id": "ws-preview", "tree_id": .null, "parent_node_id": .null, "kind": "digest", "title": "Native iOS direction", "digest": .string(digest.prettyPrinted), "deleted_at": .null, "created_at": 1000]])
        }
        return DesignWriteFixtures.augment(DesignPreviewFixtures.augment(DesignSurfaceFixtures.augment(ReferenceParityFixtures.augment(ContinuationFixtures.augment(value)))))
    }()
    private static var extraGraphs: [JSONValue] = []
    private static var history: [JSONValue] = NativeParityFixtures.seededMessages() ?? [["id": "welcome", "node_id": "n-preview", "role": "assistant", "content": "Welcome to **Michi**. Your conversations, branches, and agents are together in a native iOS app.\n\nWhat would you like to explore?", "seq": 0, "created_at": 1]]
    private static var active: [String: FixtureURLProtocol] = [:]
    private var stopped = false
    private var heartbeat: DispatchSourceTimer?
    private var streamTimer: DispatchSourceTimer?
    private var streamAnswer = ""
    private var streamNode = ""
    private var streamTurn = ""
    private var streamAssistant = ""
    private var streamText = ""
    private var streamSeq = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {
        Self.lock.lock(); defer { Self.lock.unlock() }
        stopped = true
        heartbeat?.cancel(); heartbeat = nil
        streamTimer?.cancel(); streamTimer = nil
    }
    override func startLoading() {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let url = request.url, url.host == Self.baseURL.host, url.path.hasPrefix("/api/") else { json(["error": "Fixture refuses external requests"], status: 403); return }
        let path = String(url.path.dropFirst(4)), method = request.httpMethod ?? "GET"
        var raw = request.httpBody
        if raw == nil, let stream = request.httpBodyStream { stream.open(); defer { stream.close() }; var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096); while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }; raw = data }
        let body = raw.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
        if let response = NativeParityFixtures.response(path: path, method: method, url: url, body: body) { json(response.value, status: response.status); return }
        if let response = TaskUpkeepFixtures.response(path: path, method: method) { json(response.value, status: response.status); return }
        if let response = ReferenceParityFixtures.response(path: path, method: method, url: url) { json(response.value, status: response.status); return }
        if let value = ContentParityFixtures.response(path: path, method: method) { json(value); return }
        if let value = ContinuationFixtures.response(path: path, method: method, url: url) { json(value); return }
        if let response = NativeComponentRuntimeFixtures.response(path: path, method: method, url: url, body: body) {
            if response.transportFailure {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            json(response.value, status: response.status, empty: response.empty || response.status == 204)
            return
        }
        if let value = DesignPreviewFixtures.response(path: path, method: method, url: url) { json(value); return }
        if let value = DesignSurfaceFixtures.response(path: path, method: method) { json(value); return }
        if let response = DesignWriteFixtures.response(path: path, method: method, url: url, body: body) { json(response.value, status: response.status); return }
        if let value = PagesHomeFixtures.response(path: path, method: method, url: url) { json(value); return }
        if path == "/health" { json(["service": "michi-backend"]); return }
        if path == "/workspaces/ws-preview" { json(Self.graph); return }
        if path == "/workspaces/ws-preview/nodes/digest-preview/digest/viewed", method == "POST" {
            let now = Date().timeIntervalSince1970 * 1000
            if let index = Self.graph["nodes"].arrayValue.firstIndex(where: { $0.id == "digest-preview" }) {
                var nodes = Self.graph["nodes"].arrayValue, digest = nodes[index]["digest"].parsedJSON
                digest["viewedAt"] = .number(now); nodes[index]["digest"] = .string(digest.prettyPrinted); Self.graph["nodes"] = .array(nodes)
                json(["workspaceId": "ws-preview", "nodeId": "digest-preview", "generatedAt": digest["generatedAt"], "viewedAt": .number(now), "changed": true]); return
            }
        }
        if path == "/chats/background/subscribe" {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
            guard !stopped else { return }
            // Match the real idle SSE feed: bytes keep URLSession's idle
            // timeout alive without inventing any product events.
            client?.urlProtocol(self, didLoad: Data(": keepalive\n\n".utf8))
            guard !stopped else { return }
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + 15, repeating: 15)
            timer.setEventHandler { [weak self] in
                Self.lock.lock(); defer { Self.lock.unlock() }
                guard let self, !self.stopped else { return }
                self.client?.urlProtocol(self, didLoad: Data(": keepalive\n\n".utf8))
            }
            heartbeat = timer
            timer.resume()
            return
        }
        if path == "/persistence/capabilities" { json(["protocolVersion": 2, "authoritativeTurnPersistence": true, "explicitCommands": true, "digestReadMarkers": "v1"]); return }
        if path == "/workspaces/all" {
            if ProcessInfo.processInfo.arguments.contains("--fail-hydration") { json(["error": "Fixture backend unavailable"], status: 503); return }
            json(["workspaces": .array([Self.graph] + Self.extraGraphs)]); return
        }
        if path.hasSuffix("/messages") && method == "GET" {
            if let message = ContentParityFixtures.message {
                json(["messages": [["id": "content-parity-preview", "node_id": "n-preview", "role": "assistant", "content": .string(message), "seq": 0, "created_at": 1]]]); return
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-sequence") || ProcessInfo.processInfo.arguments.contains("--preview-state") {
                let diagram = ProcessInfo.processInfo.arguments.contains("--preview-state")
                    ? "stateDiagram-v2\n[*] --> Draft\nDraft --> Review: Submit\nReview --> Draft: Revise\nReview --> Done: Approve\nDone --> [*]"
                    : "sequenceDiagram\nparticipant You\nparticipant Michi\nparticipant Agent\nYou->>Michi: Ask a question\nMichi->>Agent: Start turn\nAgent-->>Michi: Stream response\nMichi-->>You: Save and display"
                json(["messages": [["id": "welcome", "node_id": "n-preview", "role": "assistant", "content": .string("A native diagram of your workflow.\n\n```mermaid\n" + diagram + "\n```"), "seq": 0]]]); return
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-math") {
                let content = #"Native formulas: $E=mc^2$, with selectable TeX source."# + "\n\n$$\n" + #"x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}"# + "\n$$\n\n$$\n" + #"\int_0^1 x^2\,dx=\frac{1}{3}"# + "\n$$\n\nAn unsupported command keeps its exact source: $\\unknowncommand{x}$."
                json(["messages": [["id": "welcome", "node_id": "n-preview", "role": "assistant", "content": .string(content), "seq": 0]]]); return
            }
            if ProcessInfo.processInfo.arguments.contains("--preview-markdown") {
                json(["messages": [["id": "welcome", "node_id": "n-preview", "role": "assistant", "content": "# Michi, in native UI\n\n| Area | Implementation |\n| --- | --- |\n| Conversations | SwiftUI + SSE |\n| Pages and tasks | Native forms |\n\n```mermaid\nflowchart LR\nA[Your question] --> B[Agent]\nB --> C[Saved response]\n```\n\n```diff\n- Web-only interface\n+ Native iPhone interface\n```", "seq": 0]]]); return
            }
            json(["messages": .array(Self.history)]); return
        }
        if path == "/node-ids/allocate" { json(["nodeIds": [.string("n-" + UUID().uuidString.lowercased())]]); return }
        if path == "/uploads/web-cwd" { json(["cwd": "/tmp/michi-ios-fixture"]); return }
        if path.hasSuffix("/graph/nodes/ensure") {
            guard !body["node"].id.isEmpty, !body["workspace"].id.isEmpty else { json(["error": "Missing prerequisite"], status: 400); return }
            let source = body["node"]
            let row: JSONValue = ["id": source["id"], "workspace_id": body["workspace"]["id"], "tree_id": source["treeId"], "parent_node_id": source["parentNodeId"], "title": source["title"], "kind": "chat", "status": "idle", "created_at": source["createdAt"], "deleted_at": .null]
            Self.graph["nodes"] = .array(Self.graph["nodes"].arrayValue + [row])
            if !body["tree"].isNull { let tree = body["tree"]; Self.graph["trees"] = .array(Self.graph["trees"].arrayValue + [["id": tree["id"], "workspace_id": body["workspace"]["id"], "root_node_id": tree["rootNodeId"], "archived_at": .null, "created_at": tree["createdAt"], "last_active_at": tree["lastActiveAt"]]]) }
            json(["ok": true]); return
        }
        if path.hasSuffix("/commands") {
            guard !body["operationId"].stringValue.isEmpty, !body["commands"].arrayValue.isEmpty else { json(["error": "Missing commands"], status: 400); return }
            for command in body["commands"].arrayValue {
                let payload = command["payload"]
                switch command["type"].stringValue {
                case "workspace.upsert":
                    if payload.id == Self.graph["workspace"].id { Self.graph["workspace"] = Self.graph["workspace"].merging(payload.objectValue) }
                    else { Self.extraGraphs.append(["workspace": payload, "trees": [], "nodes": [], "edges": [], "messages": [], "contexts": []]) }
                case "node.patch":
                    Self.graph["nodes"] = .array(Self.graph["nodes"].arrayValue.map { node in
                        guard node.id == payload.id else { return node }
                        var patch = payload.objectValue
                        if let window = payload["composer_draft_window_id"].optionalString {
                            var drafts = node["composer_draft"].parsedJSON["__michiWindowDrafts"].objectValue
                            drafts[window] = payload["composer_draft"]
                            patch["composer_draft"] = .string(JSONValue.object(["__michiWindowDrafts": .object(drafts)]).prettyPrinted)
                            patch.removeValue(forKey: "composer_draft_window_id")
                        }
                        return node.merging(patch)
                    })
                case "tree.upsert": Self.graph["trees"] = .array(Self.graph["trees"].arrayValue.map { $0.id == payload.id ? $0.merging(payload.objectValue) : $0 })
                default: json(["error": "Unsupported fixture command"], status: 400); return
                }
            }; json(["ok": true]); return
        }
        if path.hasSuffix("/ensure-session") { json(["chatId": .string(path.split(separator: "/")[1].description), "runtimeId": "codex", "resumeStrategy": "live"]); return }
        if path.hasSuffix("/message") && method == "POST" {
            streamNode = body["nodeId"].stringValue; streamTurn = body["turnId"].stringValue; streamAssistant = "a-" + streamTurn; streamText = body["text"].stringValue
            guard !streamNode.isEmpty && !streamTurn.isEmpty && !streamText.isEmpty else { json(["error": "Invalid send contract"], status: 400); return }
            Self.history.append(["id": .string("u-" + streamTurn), "node_id": .string(streamNode), "role": "user", "content": body["displayText"].isNull ? .string(streamText) : body["displayText"], "metadata": body["userMetadata"], "seq": .number(Double(Self.history.count)), "created_at": 2])
            Self.active[streamNode] = self
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
            streamSeq = 0
            if NativeParityFixtures.stream {
                startParityStream()
            } else if let frames = DesignPreviewFixtures.openingStreamFrames(text: streamText) {
                for item in frames { emit(item.event, item.body) }
            } else {
                emit("turn_start", ["userText": .string(streamText)])
                emit("chunk", ["text": "I can help with that. "])
                emit("permission_request", ["requestId": 7, "title": "Run the native preview check", "detail": "This is a synthetic simulator fixture. No commands will run.", "options": [["optionId": "allow-once", "name": "Allow once", "kind": "allow_once"], ["optionId": "reject", "name": "Reject", "kind": "reject_once"]]])
            }
            return
        }
        if path.hasSuffix("/permission-response") {
            let id = path.split(separator: "/")[1].description
            json(["ok": true])
            if let active = Self.active.removeValue(forKey: id) {
                let text = body["optionId"].stringValue == "allow-once" ? "Your native interface is ready. The approval and streaming flow both work." : "The request was declined."
                if let frames = DesignPreviewFixtures.permissionCompletionFrames(text: text) {
                    for item in frames { active.emit(item.event, item.body) }
                } else {
                    active.emit("permission_resolved", ["requestId": 7])
                    active.emit("chunk", ["text": .string(text)])
                    active.emit("done", ["stopReason": "end_turn", "persisted": true])
                }
                Self.history.append(["id": .string(active.streamAssistant), "node_id": .string(id), "role": "assistant", "content": .string("I can help with that. " + text), "seq": .number(Double(Self.history.count)), "created_at": 3])
                active.client?.urlProtocolDidFinishLoading(active)
            }; return
        }
        if path.hasSuffix("/user-input-response") {
            let id = path.split(separator: "/")[1].description
            json(["ok": true])
            if let active = Self.active.removeValue(forKey: id) {
                let text = body["skip"].boolValue ? "The question was skipped." : "Thanks — I can continue from that choice."
                active.emit("user_input_resolved", [
                    "requestId": body["requestId"],
                    "interactionId": body["interactionId"],
                    "answers": body["answers"],
                    "outcome": body["skip"].boolValue ? "skipped" : "answered"
                ])
                active.emit("chunk", ["text": .string(text)])
                for item in DesignPreviewFixtures.trailingTurnFrames() { active.emit(item.event, item.body) }
                active.emit("done", ["stopReason": "end_turn", "persisted": true])
                Self.history.append(["id": .string(active.streamAssistant), "node_id": .string(id), "role": "assistant", "content": .string("I need a choice from you. " + text), "seq": .number(Double(Self.history.count)), "created_at": 3])
                active.client?.urlProtocolDidFinishLoading(active)
            }; return
        }
        if path.hasSuffix("/cancel") && path.hasPrefix("/chats/") {
            let id = path.split(separator: "/")[1].description
            if let active = Self.active[id], active.streamTurn == body["turnId"].stringValue {
                active.streamTimer?.cancel(); active.streamTimer = nil
                if NativeParityFixtures.matchesStream(node: id, turn: body["turnId"].stringValue) {
                    NativeParityFixtures.markStreamFinished()
                    Self.upsertAssistant(id: active.streamAssistant, node: id, content: NativeParityFixtures.currentAnswer())
                }
                active.emit("done", ["stopReason": "cancelled", "persisted": true])
                active.client?.urlProtocolDidFinishLoading(active)
                Self.active.removeValue(forKey: id)
            }
            json(["ok": true]); return
        }
        if path.hasSuffix("/stream") {
            if NativeParityFixtures.stream, resumeParityStream(path: path, url: url) { return }
            json(["error": "Fixture replay unavailable", "code": "turn_replay_unavailable"], status: 410); return
        }
        if path == "/agent/status" { json(["runtime": "codex", "availableRuntimes": [["id": "codex", "label": "Codex"], ["id": "claude", "label": "Claude"]], "provider": "openai", "model": "default", "hasRequiredKey": true, "customAgentsEnabled": true]); return }
        if path.hasSuffix("/modes") { json(["availableModes": [["id": "default", "name": "Default"]]]); return }
        if path == "/home/cards" {
            json(["greeting": ["text": "A place for your next idea", "detail": "Your work stays connected across devices."], "sets": [["cards": [
                ["id": "card-preview", "kind": "continue", "label": "Continue · Michi Studio", "source": ["workspaceId": "ws-preview", "threadNodeId": "n-preview"], "title": "Bring your ideas into focus", "reason": "Pick up where you left off, with your context close at hand.", "buttonText": "Explore this", "prompt": "Help me explore the next step.", "workspaceId": "ws-preview"]
            ]]], "generatedAt": 1, "inputFingerprint": "fixture"]); return
        }
        if path.hasPrefix("/home/cards/") && path.hasSuffix("/used") { json(["cardId": .string(String(path.split(separator: "/")[2])), "usedAt": 1]); return }
        if path == "/spaces-home/all-tasks" { json(["sources": [], "rows": [], "views": [["id": "tasks-board", "name": "Board", "type": "board", "config": ["group": "status", "filters": [], "sorts": []]]], "viewsRevision": 1]); return }
        if path.hasSuffix("/pages/trash") { json(["items": [], "nextCursor": .null]); return }
        if path.hasSuffix("/changes") { json(["changes": [], "hasMore": false]); return }
        if path == "/spaces" { json(["items": [["id": "page-preview", "workspaceId": "ws-preview", "workspaceName": "Michi Studio", "title": "Native iOS roadmap", "pageCount": 1]], "nextCursor": .null]); return }
        if path.hasSuffix("/databases") && method == "GET" { json(["items": [], "nextCursor": .null]); return }
        if path.hasSuffix("/task-database") && method == "GET" { json(["databaseId": .null]); return }
        if path == "/workspaces/\(PagesHomeFixtures.homeWorkspaceID)/pages" && method == "GET" { json(["items": [], "nextCursor": .null]); return }
        if path.hasSuffix("/pages") && method == "GET" { json(["items": [["id": "page-preview", "workspaceId": "ws-preview", "title": "Native iOS roadmap", "revision": 1]], "nextCursor": .null]); return }
        if path == "/pages/page-preview", ProcessInfo.processInfo.arguments.contains("--preview-math") {
            json(PagesHomeFixtures.workspaceHomePage(title: "Native mathematics", blocks: [
                ["id": "b-quadratic", "rev": 1, "type": "math", "tex": #"x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}"#, "display": true],
                ["id": "b-integral", "rev": 1, "type": "math", "tex": #"\int_0^1 x^2\,dx=\frac{1}{3}"#, "display": true],
                ["id": "b-matrix", "rev": 1, "type": "math", "tex": #"\begin{pmatrix}a&b\\c&d\end{pmatrix}"#, "display": true],
                ["id": "b-invalid", "rev": 1, "type": "math", "tex": #"\unknowncommand{x}"#, "display": true]
            ])); return
        }
        if path == "/pages/page-preview", ProcessInfo.processInfo.arguments.contains("--preview-page") {
            json(PagesHomeFixtures.workspaceHomePage(title: "A native workspace", blocks: [
                ["id": "b-stats", "rev": 1, "type": "metrics", "items": [["label": "Milestones", "value": "4", "delta": "Completed"], ["label": "Next step", "value": "iPhone", "delta": "Validation"]]],
                ["id": "b-chart", "rev": 1, "type": "chart", "title": "Weekly progress", "kind": "bar", "series": [["label": "Completed", "points": [["x": "Mon", "y": 3], ["x": "Tue", "y": 5], ["x": "Wed", "y": 4], ["x": "Thu", "y": 8]]]]],
                ["id": "b-callout", "rev": 1, "type": "callout", "tone": "info", "text": "Your pages, charts, and controls use native iOS views."],
                ["id": "b-checklist", "rev": 1, "type": "checklist", "items": [["text": "Shared conversations", "checked": true], ["text": "Verify on a physical iPhone", "checked": false]]]
            ])); return
        }
        if path == "/pages/page-preview" {
            json(PagesHomeFixtures.workspaceHomePage(title: "Native iOS roadmap", blocks: [
                ["id": "b-preview", "type": "markdown", "text": "A native place for your ideas.", "rev": 1]
            ])); return
        }
        if path == "/scheduled-jobs" && method == "GET" { json(["jobs": [], "scheduler": ["active": true, "serviceMode": false, "blockedExecutions": []]]); return }
        if path == "/agents" && method == "GET" { json(["definitions": []]); return }
        if path == "/agent-capabilities" { json(["version": 1, "items": []]); return }
        if path == "/prefs" { json(method == "GET" ? ["prefs": [:]] : ["ok": true]); return }
        if path == "/search", method == "GET" {
            json(["totalNodes": 1, "results": [["nodeId": "n-preview", "nodeTitle": "A native home for your ideas", "workspaceId": "ws-preview", "workspaceName": "Michi Studio",
                "treeId": "tree-preview", "lastMessageAt": 1, "totalMatches": 1, "breadcrumb": ["A native home for your ideas"],
                "snippets": [["messageId": "welcome", "role": "assistant", "snippet": "Welcome to <mark>Michi</mark>."]]]]])
            return
        }
        if path.hasPrefix("/artifacts/") { json(["content": "# Project notes\n\nNative UI. Shared conversations.", "path": "notes.md", "basename": "notes.md", "extension": "md", "modifiedAt": 1, "size": 43]); return }
        json(["error": .string("Unimplemented fixture route: \(method) \(path)")], status: 404)
    }
    private func json(_ value: JSONValue, status: Int = 200, empty: Bool = false) {
        guard !stopped, let url = request.url else { return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: empty ? [:] : ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        if !empty { client?.urlProtocol(self, didLoad: (try? JSONEncoder().encode(value)) ?? Data()) }
        client?.urlProtocolDidFinishLoading(self)
    }
    fileprivate func emit(_ event: String, _ body: JSONValue) {
        frame(event, body, seq: streamSeq)
        if NativeParityFixtures.matchesStream(node: streamNode, turn: streamTurn) {
            NativeParityFixtures.recordFrame(event: event, body: body, seq: streamSeq)
        }
        streamSeq += 1
    }
    private func startParityStream() {
        NativeParityFixtures.beginStream(node: streamNode, turn: streamTurn, assistant: streamAssistant)
        streamAnswer = NativeParityFixtures.streamOpening
        emit("turn_start", ["userText": .string(streamText)])
        emit("chunk", ["text": .string(NativeParityFixtures.streamOpening)])
        Self.upsertAssistant(id: streamAssistant, node: streamNode, content: streamAnswer)
        startParityTimer()
    }
    private func resumeParityStream(path: String, url: URL) -> Bool {
        let node = path.split(separator: "/").dropFirst().first.map(String.init) ?? ""
        let turn = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "fromTurnId" })?.value ?? ""
        let fromSeq = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "fromSeq" })?.value.flatMap(Int.init) ?? 0
        guard NativeParityFixtures.matchesStream(node: node, turn: turn), let identity = NativeParityFixtures.streamIdentity() else { return false }
        streamNode = identity.node; streamTurn = identity.turn; streamAssistant = identity.assistant
        streamAnswer = NativeParityFixtures.currentAnswer()
        streamSeq = NativeParityFixtures.nextStreamSeq()
        Self.active[node] = self
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        for item in NativeParityFixtures.recordedFrames() where item.seq >= fromSeq { replay(item) }
        if NativeParityFixtures.isStreamFinished() {
            guard !stopped else { return true }
            client?.urlProtocolDidFinishLoading(self)
        } else {
            startParityTimer()
        }
        return true
    }
    private func startParityTimer() {
        streamTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + NativeParityFixtures.chunkInterval, repeating: NativeParityFixtures.chunkInterval)
        timer.setEventHandler { [weak self] in
            Self.lock.lock(); defer { Self.lock.unlock() }
            guard let self, !self.stopped else { return }
            self.advanceParityStream()
        }
        streamTimer = timer
        timer.resume()
    }
    private func advanceParityStream() {
        guard let row = NativeParityFixtures.popStreamRow() else {
            finishParityStream(stopReason: "end_turn")
            return
        }
        NativeParityFixtures.appendAnswer(row)
        streamAnswer = NativeParityFixtures.currentAnswer()
        emit("chunk", ["text": .string(row)])
        Self.upsertAssistant(id: streamAssistant, node: streamNode, content: streamAnswer)
        if !NativeParityFixtures.hasRemainingRows() { finishParityStream(stopReason: "end_turn") }
    }
    private func finishParityStream(stopReason: String) {
        streamTimer?.cancel(); streamTimer = nil
        NativeParityFixtures.markStreamFinished()
        emit("done", ["stopReason": .string(stopReason), "persisted": true])
        Self.upsertAssistant(id: streamAssistant, node: streamNode, content: streamAnswer)
        Self.active.removeValue(forKey: streamNode)
        guard !stopped else { return }
        client?.urlProtocolDidFinishLoading(self)
    }
    private func replay(_ item: NativeParityFixtures.StreamFrame) {
        guard !stopped else { return }
        let payload = item.body.merging(["nodeId": .string(streamNode), "turnId": .string(streamTurn), "assistantId": .string(streamAssistant), "seq": .number(Double(item.seq))])
        guard let encoded = try? JSONEncoder().encode(payload), let json = String(data: encoded, encoding: .utf8) else { return }
        client?.urlProtocol(self, didLoad: Data("event: \(item.event)\ndata: \(json)\n\n".utf8))
    }
    private static func upsertAssistant(id: String, node: String, content: String) {
        // The fixture has one answer projection block. Persist the same durable
        // identity as the backend so fullscreen presentation can prove continuity.
        let blocks: JSONValue = [["id": .string("\(id)-b-0"), "kind": "answer", "rawText": .string(content), "text": .string(content)]]
        if let index = history.firstIndex(where: { $0.id.utf8.elementsEqual(id.utf8) && $0["node_id"].stringValue.utf8.elementsEqual(node.utf8) }) {
            var row = history[index]
            row["content"] = .string(content)
            row["blocks"] = blocks
            history[index] = row
            return
        }
        history.append(["id": .string(id), "node_id": .string(node), "role": "assistant", "content": .string(content), "blocks": blocks, "seq": .number(Double(history.count)), "created_at": 3])
    }
    private func frame(_ event: String, _ body: JSONValue, seq: Int) {
        guard !stopped else { return }
        let payload = body.merging(["nodeId": .string(streamNode), "turnId": .string(streamTurn), "assistantId": .string(streamAssistant), "seq": .number(Double(seq))])
        guard let encoded = try? JSONEncoder().encode(payload), let json = String(data: encoded, encoding: .utf8) else { return }
        let data = Data("event: \(event)\ndata: \(json)\n\n".utf8)
        // Fragment frames to exercise the actual streaming parser in the app.
        let midpoint = data.count / 2
        client?.urlProtocol(self, didLoad: data.prefix(midpoint))
        client?.urlProtocol(self, didLoad: data.suffix(data.count - midpoint))
    }
}

enum DesignSurfaceFixtures {
    static var args: [String] { ProcessInfo.processInfo.arguments }
    static var empty: Bool { args.contains("--preview-empty") }
    static var bone: Bool { args.contains("--preview-bone") }
    static var design: Bool { args.contains("--preview-design") || args.contains("--preview-home") || args.contains("--preview-schedule") }

    static func augment(_ graph: JSONValue) -> JSONValue {
        guard !empty, design || args.contains("--uitesting") else { return graph }
        var next = graph
        var trees = next["trees"].arrayValue
        var nodes = next["nodes"].arrayValue
        let now = Date().timeIntervalSince1970 * 1000
        if !nodes.contains(where: { $0.id == "n-waiting" }) {
            trees.append(["id": "tree-waiting", "workspace_id": "ws-preview", "root_node_id": "n-waiting", "created_at": .number(now - 7_200_000), "last_active_at": .number(now - 7_200_000), "archived_at": .null])
            nodes.append(["id": "n-waiting", "workspace_id": "ws-preview", "tree_id": "tree-waiting", "title": "Approve workspace edit", "kind": "chat", "status": "waiting", "deleted_at": .null, "created_at": .number(now - 7_200_000)])
        }
        if !nodes.contains(where: { $0.id == "n-running" }) {
            trees.append(["id": "tree-running", "workspace_id": "ws-preview", "root_node_id": "n-running", "created_at": .number(now - 1_200_000), "last_active_at": .number(now - 1_200_000), "archived_at": .null])
            nodes.append(["id": "n-running", "workspace_id": "ws-preview", "tree_id": "tree-running", "title": "Draft the weekly digest", "kind": "chat", "status": "streaming", "deleted_at": .null, "created_at": .number(now - 1_200_000)])
        }
        if !nodes.contains(where: { $0.id == "n-waiting-branch" }) {
            nodes.append(["id": "n-waiting-branch", "workspace_id": "ws-preview", "tree_id": "tree-waiting", "parent_node_id": "n-waiting", "title": "Branch needs a decision", "kind": "chat", "status": "waiting", "deleted_at": .null, "created_at": .number(now - 2_700_000)])
        }
        if !nodes.contains(where: { $0.id == "n-waiting-remote" }) {
            trees.append(["id": "tree-waiting-remote", "workspace_id": "ws-preview", "root_node_id": "n-waiting-remote", "created_at": .number(now - 600_000), "last_active_at": .number(now - 600_000), "archived_at": .null])
            nodes.append(["id": "n-waiting-remote", "workspace_id": "ws-preview", "tree_id": "tree-waiting-remote", "title": "Approve a file edit", "kind": "chat", "status": "waiting", "deleted_at": .null, "created_at": .number(now - 600_000)])
        }
        next["trees"] = .array(trees)
        next["nodes"] = .array(nodes)
        return next
    }

    static func response(path: String, method: String) -> JSONValue? {
        if empty, path == "/workspaces/all" { return ["workspaces": []] }
        if path == "/prefs", method == "GET", bone { return ["prefs": ["terminalPalette": "bone"]] }
        if path == "/agent/status" {
            return [
                "runtime": "codex", "model": "default", "reasoning": "medium",
                "provider": "openai", "hasRequiredKey": true, "customAgentsEnabled": true,
                "availableRuntimes": [
                    ["id": "codex", "label": "Codex", "available": true],
                    ["id": "claude", "label": "Claude Code", "available": true],
                    ["id": "kiro", "label": "Kiro", "available": false]
                ],
                "modelByRuntime": ["codex": "default"],
                "reasoningByRuntime": ["codex": "medium"],
                "capabilities": ["supportedReasoningLevels": ["low", "medium", "high"]]
            ]
        }
        if path.hasPrefix("/agent/models") {
            return ["models": [["id": "default", "label": "Default", "name": "Default"]]]
        }
        if path.hasPrefix("/agent/runtime-catalog") {
            return [
                "providers": [["id": "openai", "label": "OpenAI"]],
                "models": [["id": "default", "label": "Default", "name": "Default"]],
                "capabilities": ["supportedReasoningLevels": ["low", "medium", "high"]]
            ]
        }
        if path == "/permissions/settings", method == "GET" {
            return ["global": false, "mode": "ask", "approveForMe": false]
        }
        if path == "/scheduled-jobs", method == "GET" {
            let next = Date().timeIntervalSince1970 * 1000 + 3_600_000
            return [
                "jobs": [[
                    "id": "job-preview", "name": "Inbox triage", "enabled": true, "autoPaused": false,
                    "workspaceId": "ws-preview", "persistentNodeId": "n-preview",
                    "nextRunAt": .number(next), "lastStatus": "succeeded", "lastRunAt": .number(Date().timeIntervalSince1970 * 1000 - 3_600_000),
                    "schedule": ["kind": "cron", "expression": "0 * * * *"],
                    "permissionMode": "ask"
                ]],
                "scheduler": ["active": true, "serviceMode": false, "blockedExecutions": []]
            ]
        }
        if path == "/spaces-home/workspaces" {
            return ["items": [PagesHomeFixtures.workspaceSummary(pendingProposals: design ? 1 : 0)]]
        }
        if path == "/spaces-home/sections" {
            return [
                "waiting": design ? section(items: [
                    conversationSection(id: "n-waiting-remote", title: "Approve a file edit", summary: "Unopened chat"),
                    proposalSection(change: "chg-preview", page: "page-preview", title: "Review suggested page change", summary: "Meta agent")
                ], total: 2) : section(items: [], total: 0),
                "stalled": section(items: [], total: 0),
                "done": design ? section(items: [
                    conversationSection(id: "n-preview", title: "Weekly digest saved", summary: "Just now")
                ], total: 1) : section(items: [], total: 0),
                "conversations": ["available": true]
            ]
        }
        return nil
    }

    private static func section(items: [JSONValue], total: Int) -> JSONValue {
        ["items": .array(items), "total": .number(Double(total))]
    }

    private static func conversationSection(id: String, title: String, summary: String) -> JSONValue {
        [
            "id": .string("conversation:\(id)"), "kind": "conversation",
            "title": .string(title), "summary": .string(summary),
            "workspaceId": "ws-preview", "workspaceName": "Michi Studio",
            "agentClaim": false, "at": .number(Date().timeIntervalSince1970 * 1000 - 600_000),
            "target": ["kind": "conversation", "nodeId": .string(id), "workspaceId": "ws-preview"]
        ]
    }

    private static func proposalSection(change: String, page: String, title: String, summary: String) -> JSONValue {
        [
            "id": .string("change:\(change)"), "kind": "proposal",
            "title": .string(title), "summary": .string(summary),
            "workspaceId": "ws-preview", "workspaceName": "Michi Studio",
            "agentClaim": false, "at": .number(Date().timeIntervalSince1970 * 1000 - 300_000),
            "target": ["kind": "page", "pageId": .string(page), "changeId": .string(change)]
        ]
    }
}

/// Optional `--uitesting` surfaces. Default fixture routes stay unchanged
/// unless one of these launch flags is present.
enum DesignPreviewFixtures {
    static var args: [String] { ProcessInfo.processInfo.arguments }
    static var schedule: Bool { args.contains("--preview-schedule") }
    static var settings: Bool { args.contains("--preview-settings") }
    static var agents: Bool { args.contains("--preview-agents") }
    static var files: Bool { args.contains("--preview-files") }
    static var trash: Bool { args.contains("--preview-trash") }
    static var ask: Bool { args.contains("--preview-ask") }
    static var permission: Bool { args.contains("--preview-permission") }
    static var capabilities: Bool { args.contains("--preview-capabilities") || agents }
    static var bone: Bool { args.contains("--preview-bone") }

    /// Saturday 31 Oct 2026, 00:28 UTC (09:28 JST) — Design 10's reply time.
    static let nowMs: Double = {
        var parts = DateComponents()
        parts.calendar = Calendar(identifier: .gregorian)
        parts.timeZone = TimeZone(secondsFromGMT: 0)
        parts.year = 2026; parts.month = 10; parts.day = 31
        parts.hour = 0; parts.minute = 28
        return (parts.date?.timeIntervalSince1970 ?? 1_793_406_480) * 1000
    }()

    static func augment(_ graph: JSONValue) -> JSONValue {
        var next = graph
        if files { next = withFiles(next) }
        if trash { next = withTrash(next) }
        if ask { next = withQuotedBranch(next) }
        return next
    }

    static func response(path: String, method: String, url: URL) -> JSONValue? {
        if settings || bone, path == "/prefs", method == "GET" {
            if bone { return ["prefs": ["terminalPalette": "bone"]] }
            return ["prefs": [:]]
        }
        if capabilities, path == "/agent/status" { return agentStatus() }
        if capabilities, path.hasPrefix("/agent/models") {
            return ["models": [
                ["id": "default", "label": "Default", "name": "Default"],
                ["id": "gpt-5.4", "label": "GPT-5.4", "name": "GPT-5.4"]
            ]]
        }
        if capabilities, path.hasPrefix("/agent/runtime-catalog") {
            return [
                "providers": [["id": "openai", "label": "OpenAI"]],
                "models": [
                    ["id": "default", "label": "Default", "name": "Default"],
                    ["id": "gpt-5.4", "label": "GPT-5.4", "name": "GPT-5.4"]
                ],
                "capabilities": ["reasoning": true, "supportedReasoningLevels": ["low", "medium", "high", "max"]]
            ]
        }
        if schedule, path == "/scheduled-jobs", method == "GET" { return scheduledJobs() }
        if schedule, path.hasPrefix("/scheduled-jobs/"), method == "GET" {
            if path.hasSuffix("/runs") {
                let id = String(path.split(separator: "/")[1])
                return ["runs": .array(scheduledRuns(jobId: id))]
            }
            if path == "/scheduled-jobs/settings" { return ["sessionMode": "persistent"] }
            let id = String(path.split(separator: "/").last ?? "")
            return scheduledJobs()["jobs"].arrayValue.first { $0.id == id }
        }
        if schedule, path == "/scheduled-jobs/preview", method == "POST" {
            return ["valid": true, "nextRuns": [.number(nowMs + 86_400_000), .number(nowMs + 172_800_000)]]
        }
        if schedule, path == "/scheduled-jobs/settings", method == "PUT" {
            return ["sessionMode": "persistent"]
        }
        if schedule, path.hasPrefix("/scheduled-jobs/"), ["POST", "PATCH", "DELETE"].contains(method) {
            if method == "POST", path.hasSuffix("/run") || path.hasSuffix("/cancel") || path.hasSuffix("/confirm-stopped") {
                return ["ok": true]
            }
            if method == "DELETE" { return ["ok": true] }
            if method == "PATCH", let job = scheduledJobs()["jobs"].arrayValue.first(where: { path.contains($0.id) }) {
                return job
            }
        }
        if settings || schedule, path == "/meta-agent/overview" { return metaOverview() }
        if settings || schedule, path == "/meta-agent/run-now" { return ["workspaces": []] }
        if settings || schedule, (path == "/meta-agent/pause" || path == "/meta-agent/resume"), method == "POST" {
            return metaOverview().merging(["state": path.hasSuffix("pause") ? "paused" : "running"])
        }
        if agents, path == "/agents", method == "GET" {
            return ["definitions": [agentDefinition()]]
        }
        if agents, path == "/agent-runs" || path.hasPrefix("/agent-runs?") {
            return ["runs": .array(agentRuns())]
        }
        if agents, path.hasPrefix("/agent-runs/") {
            let id = String(path.split(separator: "/").last ?? "")
            return agentRuns().first { $0.id == id }
        }
        if agents, path == "/workflow-runs" || path.hasPrefix("/workflow-runs?") {
            return ["runs": [workflowRun()]]
        }
        if agents, path.hasPrefix("/workflow-runs/") {
            let id = String(path.split(separator: "/").last ?? "")
            return id == "wf-preview" ? workflowRun() : nil
        }
        if ask, path.hasSuffix("/messages"), path.contains("n-preview-branch") {
            return ["messages": [[
                "id": "quote-user", "node_id": "n-preview-branch", "role": "user",
                "content": "Continue from that line",
                "metadata": ["quotedText": "Welcome to **Michi**."],
                "seq": 0, "created_at": .number(nowMs - 1_800_000)
            ]]]
        }
        if files, path.hasPrefix("/artifacts/"), path.hasSuffix("/read") {
            return artifactRead(url: url)
        }
        return nil
    }

    static func openingStreamFrames(text: String) -> [(event: String, body: JSONValue)]? {
        if ask && !permission {
            return [
                (event: "turn_start", body: ["userText": .string(text)]),
                (event: "chunk", body: ["text": "I need a choice from you. "]),
                (event: "user_input_request", body: [
                    "requestId": 11, "interactionId": "turn-preview:input:11:0",
                    "questions": [[
                        "question": "Which surface should we inspect next?",
                        "multiSelect": false,
                        "options": [
                            ["label": "Appearance", "recommended": true, "description": "Palette and Match system"],
                            ["label": "Scheduled jobs"],
                            ["label": "Agent runs"]
                        ]
                    ]]
                ])
            ]
        }
        if permission {
            return [
                (event: "turn_start", body: ["userText": .string(text)]),
                (event: "chunk", body: ["text": "I can help with that. "]),
                (event: "tool_call", body: ["toolCallId": "tool-read", "title": "Read notes.md", "status": "completed", "kind": "read", "output": "Project notes"]),
                (event: "tool_call", body: ["toolCallId": "tool-search", "title": "Search launch plan", "status": "completed", "kind": "search", "output": "2 matches"]),
                (event: "permission_request", body: ["requestId": 7, "title": "Run the native preview check", "detail": "This is a synthetic simulator fixture. No commands will run.", "options": [["optionId": "allow-once", "name": "Allow once", "kind": "allow_once"], ["optionId": "reject", "name": "Reject", "kind": "reject_once"]]])
            ]
        }
        return nil
    }

    static func permissionCompletionFrames(text: String) -> [(event: String, body: JSONValue)]? {
        guard permission else { return nil }
        return [
            (event: "permission_resolved", body: ["requestId": 7]),
            (event: "chunk", body: ["text": .string(text)])
        ] + trailingTurnFrames() + [
            (event: "done", body: ["stopReason": "end_turn", "persisted": true])
        ]
    }

    static func trailingTurnFrames() -> [(event: String, body: JSONValue)] {
        guard permission || ask else { return [] }
        return [
            (event: "follow_ups", body: ["followUps": ["Open the weekly digest", "Review the launch plan"]]),
            (event: "context_usage", body: ["contextUsagePercentage": 42])
        ]
    }

    private static func withFiles(_ graph: JSONValue) -> JSONValue {
        var next = graph
        var contexts = next["contexts"].arrayValue
        let extras: [JSONValue] = [
            ["id": "artifact-notes", "name": "Project notes", "file_path": "notes.md", "type": "doc", "size": 1280],
            ["id": "artifact-shot", "name": "Launch shot", "file_path": "launch.jpg", "type": "image", "size": 20_480],
            ["id": "artifact-csv", "name": "Metrics", "file_path": "metrics.csv", "type": "doc", "size": 512],
            ["id": "artifact-html", "name": "Preview page", "file_path": "preview.html", "type": "doc", "size": 256]
        ]
        for item in extras where !contexts.contains(where: { $0.id == item.id }) { contexts.append(item) }
        next["contexts"] = .array(contexts)
        return next
    }

    private static func withTrash(_ graph: JSONValue) -> JSONValue {
        var next = graph
        var trees = next["trees"].arrayValue
        var nodes = next["nodes"].arrayValue
        if !trees.contains(where: { $0.id == "tree-trashed" }) {
            trees.append(["id": "tree-trashed", "workspace_id": "ws-preview", "root_node_id": "n-trashed", "created_at": .number(nowMs - 172_800_000), "last_active_at": .number(nowMs - 86_400_000), "archived_at": .null])
        }
        if !nodes.contains(where: { $0.id == "n-trashed" }) {
            nodes.append(["id": "n-trashed", "workspace_id": "ws-preview", "tree_id": "tree-trashed", "title": "Retired launch thread", "kind": "chat", "status": "idle", "deleted_at": .number(nowMs - 3_600_000), "deletion_group_id": "del-preview-1", "created_at": .number(nowMs - 172_800_000)])
            nodes.append(["id": "n-trashed-branch", "workspace_id": "ws-preview", "tree_id": "tree-trashed", "parent_node_id": "n-trashed", "title": "Branch that went with it", "kind": "chat", "status": "idle", "deleted_at": .number(nowMs - 3_600_000), "deletion_group_id": "del-preview-1", "created_at": .number(nowMs - 86_400_000)])
            nodes.append(["id": "n-archived", "workspace_id": "ws-preview", "tree_id": "tree-preview", "title": "Archived weekly notes", "kind": "chat", "status": "idle", "deleted_at": .number(nowMs - 7_200_000), "deletion_group_id": "arch-preview-1", "created_at": .number(nowMs - 259_200_000)])
        }
        next["trees"] = .array(trees)
        next["nodes"] = .array(nodes)
        return next
    }

    private static func withQuotedBranch(_ graph: JSONValue) -> JSONValue {
        var next = graph
        var nodes = next["nodes"].arrayValue
        if !nodes.contains(where: { $0.id == "n-preview-branch" }) {
            nodes.append(["id": "n-preview-branch", "workspace_id": "ws-preview", "tree_id": "tree-preview", "parent_node_id": "n-preview", "title": "Quoted follow-up", "kind": "chat", "status": "idle", "deleted_at": .null, "created_at": .number(nowMs - 1_800_000)])
        }
        next["nodes"] = .array(nodes)
        return next
    }

    private static func scheduledJobs() -> JSONValue {
        let zone = TimeZone.current.identifier
        return [
            "jobs": [
                job(
                    id: "job-digest", name: "Morning digest", enabled: true,
                    schedule: ["kind": "cron", "expression": "0 8 * * *", "timezone": .string(zone)],
                    lastStatus: "succeeded", lastRunAt: nowMs - 3_600_000, nextRunAt: nowMs + 86_400_000,
                    lastError: nil
                ),
                job(
                    id: "job-inbox", name: "Inbox triage", enabled: true,
                    schedule: ["kind": "every", "everySeconds": 3600],
                    lastStatus: "failed", lastRunAt: nowMs - 1_800_000, nextRunAt: nowMs + 1_800_000,
                    lastError: "runtime timed out"
                ),
                job(
                    id: "job-weekly", name: "Weekly review", enabled: false,
                    schedule: ["kind": "cron", "expression": "0 18 * * 0", "timezone": .string(zone)],
                    lastStatus: "succeeded", lastRunAt: nowMs - 259_200_000, nextRunAt: nowMs + 345_600_000,
                    lastError: nil
                )
            ],
            "scheduler": ["active": true, "serviceMode": false, "blockedExecutions": []]
        ]
    }

    private static func job(id: String, name: String, enabled: Bool, schedule: JSONValue, lastStatus: String, lastRunAt: Double, nextRunAt: Double, lastError: String?) -> JSONValue {
        var row: [String: JSONValue] = [
            "id": .string(id), "name": .string(name), "enabled": .bool(enabled), "autoPaused": false,
            "workspaceId": "ws-preview", "persistentNodeId": "n-preview",
            "prompt": .string("Inspect the native \(name.lowercased()) fixture."),
            "schedule": schedule, "permissionMode": "ask", "sessionMode": "persistent",
            "notify": true, "timeoutSeconds": 1800, "activeRunId": .null, "runtimeId": .null,
            "lastStatus": .string(lastStatus), "lastRunAt": .number(lastRunAt), "nextRunAt": .number(nextRunAt)
        ]
        if let lastError { row["lastError"] = .string(lastError) }
        return .object(row)
    }

    private static func scheduledRuns(jobId: String) -> [JSONValue] {
        [
            ["id": .string(jobId + "-run-1"), "jobId": .string(jobId), "workspaceId": "ws-preview",
             "status": jobId == "job-inbox" ? "failed" : "succeeded", "trigger": "schedule",
             "startedAt": .number(nowMs - 3_600_000), "finishedAt": .number(nowMs - 3_400_000),
             "error": jobId == "job-inbox" ? "runtime timed out" : .null]
        ]
    }

    private static func metaOverview() -> JSONValue {
        [
            "state": "running",
            "runtime": ["label": "Codex"],
            "today": ["checks": 4, "checksTruncated": false, "modelCalls": 12, "writes": 1, "pendingProposals": 1],
            "cursors": [],
            "recentRuns": []
        ]
    }

    private static func agentStatus() -> JSONValue {
        [
            "runtime": "codex", "model": "default", "reasoning": "medium",
            "provider": "openai", "hasRequiredKey": true, "customAgentsEnabled": true,
            "availableRuntimes": [
                ["id": "codex", "label": "Codex", "available": true, "approveForMe": true],
                ["id": "claude", "label": "Claude Code", "available": true],
                ["id": "kiro", "label": "Kiro", "available": false, "unavailableReason": "CLI is not installed on this computer"]
            ],
            "modelByRuntime": ["codex": "default"],
            "reasoningByRuntime": ["codex": "medium"],
            "capabilities": ["reasoning": true, "supportedReasoningLevels": ["low", "medium", "high", "max"]]
        ]
    }

    private static func agentDefinition() -> JSONValue {
        ["id": "agent-preview", "name": "Inbox helper", "enabled": true, "revision": 1]
    }

    private static func agentRuns() -> [JSONValue] {
        [
            ["id": "run-waiting", "version": 1, "workspaceId": "ws-preview", "status": "waiting", "latestEventSeq": 4,
             "effectiveDefinition": ["name": "Inbox helper"], "task": "Triage the inbox",
             "waitingReason": "permission", "startedAt": .number(nowMs - 3_600_000), "createdAt": .number(nowMs - 7_200_000), "completedAt": .null],
            ["id": "run-running", "version": 1, "workspaceId": "ws-preview", "status": "running", "latestEventSeq": 8,
             "effectiveDefinition": ["name": "Inbox helper"], "task": "Draft the weekly digest",
             "startedAt": .number(nowMs - 900_000), "createdAt": .number(nowMs - 1_800_000), "completedAt": .null],
            ["id": "run-done", "version": 1, "workspaceId": "ws-preview", "status": "completed", "latestEventSeq": 12,
             "effectiveDefinition": ["name": "Inbox helper"], "task": "Summarize launch notes",
             "startedAt": .number(nowMs - 86_400_000), "createdAt": .number(nowMs - 90_000_000), "completedAt": .number(nowMs - 85_800_000)],
            ["id": "run-failed", "version": 1, "workspaceId": "ws-preview", "status": "failed", "latestEventSeq": 6,
             "effectiveDefinition": ["name": "Inbox helper"], "task": "Retry the stalled export",
             "startedAt": .number(nowMs - 172_800_000), "createdAt": .number(nowMs - 176_400_000), "completedAt": .number(nowMs - 172_200_000)]
        ]
    }

    private static func workflowRun() -> JSONValue {
        [
            "id": "wf-preview", "version": 1, "workspaceId": "ws-preview", "status": "running", "revision": 2,
            "name": "Weekly review",
            "nodes": [
                ["id": "step-1", "title": "Gather sources", "status": "completed"],
                ["id": "step-2", "title": "Write summary", "status": "running"]
            ]
        ]
    }

    private static func artifactRead(url: URL) -> JSONValue {
        let file = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value ?? "notes.md"
        let samples: [String: (text: String, ext: String, size: Int)] = [
            "notes.md": ("# Project notes\n\nNative UI. Shared conversations.", "md", 1280),
            "launch.jpg": ("JPEG preview is shown as source in this fixture.", "jpg", 20_480),
            "metrics.csv": ("date,count\n2026-10-31,4\n", "csv", 512),
            "preview.html": ("<html><body>Native preview</body></html>", "html", 256)
        ]
        let sample = samples[file] ?? ("# Project notes\n\nNative UI. Shared conversations.", "md", 43)
        return [
            "content": .string(sample.0), "path": .string(file),
            "basename": .string((file as NSString).lastPathComponent),
            "extension": .string(sample.1), "modifiedAt": .number(nowMs - 3_600_000), "size": .number(Double(sample.2))
        ]
    }
}

/// Isolated Pages Home contract. Distinct global Spaces Home vs workspace-home
/// `page-preview`. GET shapes follow backend/routes + shared DTOs. No live
/// backend, scheduler, or Meta-agent execution is claimed.
enum PagesHomeFixtures {
    static let homePageID = "page-spaces-home"
    static let homeWorkspaceID = "ws-spaces-home"
    static let previewPageID = "page-preview"
    static let previewWorkspaceID = "ws-preview"

    static var clock: Double { DesignPreviewFixtures.nowMs }

    static func response(path: String, method: String, url: URL) -> JSONValue? {
        if path == "/spaces-home", method == "GET" {
            return ["role": "spaces-home", "page": spacesHomePage(), "layoutRules": []]
        }
        if path == "/spaces-home/first-run" && (method == "GET" || method == "POST") {
            return firstRunStatus()
        }
        if path == "/spaces-home/conversations", method == "GET" {
            let state = query(url, "state")
            if let state, !["waiting", "stalled", "done"].contains(state) { return nil }
            return conversations(state: state)
        }
        if path == "/workspaces/\(previewWorkspaceID)/home", method == "GET" {
            return workspaceHome()
        }
        if path == "/pages/\(homePageID)", method == "GET" {
            return spacesHomePage()
        }
        if method == "GET", pageMetadataID(path) != nil {
            if path.hasSuffix("/layout-preferences") {
                return ["text": "", "revision": 0, "updatedAt": .null, "updatedBy": .null]
            }
            if path.hasSuffix("/layout-rules") { return ["items": []] }
            if path.hasSuffix("/progress-cards") { return ["items": []] }
        }
        return nil
    }

    static func workspaceSummary(pendingProposals: Int) -> JSONValue {
        [
            "workspaceId": .string(previewWorkspaceID),
            "workspaceName": "Michi Studio",
            "homePageId": .string(previewPageID),
            "hasContent": true,
            "hiddenAt": .null,
            "firstRun": workspaceFirstRun(),
            "pendingProposals": .number(Double(pendingProposals))
        ]
    }

    static func workspaceHomePage(title: String, blocks: [JSONValue]) -> JSONValue {
        pageDTO(id: previewPageID, workspaceId: previewWorkspaceID, title: title, role: "workspace-home", blocks: blocks)
    }

    private static func spacesHomePage() -> JSONValue {
        pageDTO(
            id: homePageID,
            workspaceId: homeWorkspaceID,
            title: "Home",
            role: "spaces-home",
            blocks: [
                ["id": "b-home-heading", "rev": 1, "type": "heading", "text": "Home"],
                ["id": "b-home-waiting", "rev": 1, "type": "home-section", "section": "waiting"],
                ["id": "b-home-intro", "rev": 1, "type": "markdown", "text": "Global Spaces Home. Workspace homes stay on their own pages."]
            ]
        )
    }

    private static func workspaceHome() -> JSONValue {
        [
            "role": "workspace-home",
            "workspaceId": .string(previewWorkspaceID),
            "page": currentPreviewPage(),
            "layoutRules": [],
            "hiddenAt": .null,
            "firstRun": workspaceFirstRun(),
            "firstRunDays": .null,
            "incremental": .null
        ]
    }

    private static func currentPreviewPage() -> JSONValue {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--preview-math") {
            return workspaceHomePage(title: "Native mathematics", blocks: [
                ["id": "b-quadratic", "rev": 1, "type": "math", "tex": #"x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}"#, "display": true],
                ["id": "b-integral", "rev": 1, "type": "math", "tex": #"\int_0^1 x^2\,dx=\frac{1}{3}"#, "display": true],
                ["id": "b-matrix", "rev": 1, "type": "math", "tex": #"\begin{pmatrix}a&b\\c&d\end{pmatrix}"#, "display": true],
                ["id": "b-invalid", "rev": 1, "type": "math", "tex": #"\unknowncommand{x}"#, "display": true]
            ])
        }
        if args.contains("--preview-page") {
            return workspaceHomePage(title: "A native workspace", blocks: [
                ["id": "b-stats", "rev": 1, "type": "metrics", "items": [["label": "Milestones", "value": "4", "delta": "Completed"], ["label": "Next step", "value": "iPhone", "delta": "Validation"]]],
                ["id": "b-chart", "rev": 1, "type": "chart", "title": "Weekly progress", "kind": "bar", "series": [["label": "Completed", "points": [["x": "Mon", "y": 3], ["x": "Tue", "y": 5], ["x": "Wed", "y": 4], ["x": "Thu", "y": 8]]]]],
                ["id": "b-callout", "rev": 1, "type": "callout", "tone": "info", "text": "Your pages, charts, and controls use native iOS views."],
                ["id": "b-checklist", "rev": 1, "type": "checklist", "items": [["text": "Shared conversations", "checked": true], ["text": "Verify on a physical iPhone", "checked": false]]]
            ])
        }
        return workspaceHomePage(title: "Native iOS roadmap", blocks: [
            ["id": "b-preview", "type": "markdown", "text": "A native place for your ideas.", "rev": 1]
        ])
    }

    private static func firstRunStatus() -> JSONValue {
        [
            "requestedAt": .number(clock - 3_600_000),
            "workspaces": [workspaceSummary(pendingProposals: DesignSurfaceFixtures.design ? 1 : 0)],
            "summary": ["state": "done", "summarizedAt": .number(clock - 3_600_000)],
            "haltedReason": .null,
            "closed": true
        ]
    }

    private static func workspaceFirstRun() -> JSONValue {
        [
            "workspaceId": .string(previewWorkspaceID),
            "startedAt": .number(clock - 3_600_000),
            "startSeq": 0,
            "readCount": 0,
            "total": 0,
            "state": "done",
            "error": .null,
            "updatedAt": .number(clock - 3_600_000)
        ]
    }

    private static func conversations(state: String?) -> JSONValue {
        guard DesignSurfaceFixtures.design, let state, ["waiting", "stalled", "done"].contains(state) else {
            return ["items": [], "total": 0]
        }
        let items: [JSONValue]
        switch state {
        case "waiting":
            items = [conversation(id: "n-waiting-remote", title: "Approve a file edit", summary: "Unopened chat", state: state, age: 600_000)]
        case "done":
            items = [conversation(id: "n-preview", title: "Weekly digest saved", summary: "Just now", state: state, age: 600_000)]
        default:
            items = []
        }
        return ["items": .array(items), "total": .number(Double(items.count))]
    }

    private static func conversation(id: String, title: String, summary: String, state: String, age: Double) -> JSONValue {
        [
            "id": .string("conversation:\(id)"), "kind": "conversation",
            "title": .string(title), "summary": .string(summary),
            "workspaceId": .string(previewWorkspaceID), "workspaceName": "Michi Studio",
            "agentClaim": false, "at": .number(Date().timeIntervalSince1970 * 1000 - age),
            "state": .string(state),
            "target": ["kind": "conversation", "nodeId": .string(id), "workspaceId": .string(previewWorkspaceID), "messageId": .null]
        ]
    }

    private static func pageDTO(id: String, workspaceId: String, title: String, role: String, blocks: [JSONValue]) -> JSONValue {
        [
            "id": .string(id),
            "workspaceId": .string(workspaceId),
            "parentId": .null,
            "position": 0,
            "title": .string(title),
            "color": .null,
            "updatedAt": .number(clock),
            "updatedBy": "agent",
            "pendingProposals": 0,
            "helperNodeId": .null,
            "revision": 1,
            "viewVersion": 1,
            "blocks": .array(blocks),
            "role": .string(role)
        ]
    }

    private static func pageMetadataID(_ path: String) -> String? {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 3, parts[0] == "pages" else { return nil }
        let id = parts[1]
        guard id == homePageID || id == previewPageID else { return nil }
        guard ["layout-preferences", "layout-rules", "progress-cards"].contains(parts[2]) else { return nil }
        return id
    }

    private static func query(_ url: URL, _ name: String) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == name })?.value
    }
}
#endif
