import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

// A unique origin and registry entry per test keep URLProtocol fixtures isolated,
// including when XCTest runs tests concurrently. Unknown requests fail closed.
struct AppContractRequest: Sendable {
    let method: String
    let path: String
    let query: [String: String]
    let body: JSONValue
    var idempotencyKey: String? = nil
}

enum AppContractResponse: Sendable {
    case json(JSONValue, status: Int = 200)
    case delayedJSON(JSONValue, status: Int, delay: TimeInterval)
    case events([(String, JSONValue)], delay: TimeInterval = 0)
    case failure(URLError.Code)
}

final class AppContractTransport: @unchecked Sendable {
    typealias Handler = (AppContractRequest, [AppContractRequest]) -> AppContractResponse
    private let lock = NSRecursiveLock()
    private var captured: [AppContractRequest] = []
    private let handler: Handler
    let baseURL: URL
    let session: URLSession
    let api: MichiAPI

    init(handler: @escaping Handler) {
        self.handler = handler
        baseURL = URL(string: "https://contract-\(UUID().uuidString.lowercased()).michi.test")!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppContractURLProtocol.self]
        config.urlCache = nil
        config.timeoutIntervalForRequest = 3
        session = URLSession(configuration: config)
        api = MichiAPI(baseURL: baseURL, session: session)
        AppContractURLProtocol.register(self)
    }

    var requests: [AppContractRequest] {
        lock.lock(); defer { lock.unlock() }
        return captured
    }

    func response(to request: AppContractRequest) -> AppContractResponse {
        lock.lock(); defer { lock.unlock() }
        captured.append(request)
        return handler(request, captured)
    }

    func close() {
        session.invalidateAndCancel()
        AppContractURLProtocol.unregister(host: baseURL.host!)
    }
}

private final class AppContractURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var transports: [String: AppContractTransport] = [:]

    static func register(_ transport: AppContractTransport) {
        lock.lock(); defer { lock.unlock() }
        transports[transport.baseURL.host!] = transport
    }

    static func unregister(host: String) {
        lock.lock(); defer { lock.unlock() }
        transports.removeValue(forKey: host)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private let stateLock = NSLock()
    private var stopped = false
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }

    override func startLoading() {
        Self.lock.lock()
        let transport = request.url?.host.flatMap { Self.transports[$0] }
        Self.lock.unlock()
        guard let transport, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                bytes.append(buffer, count: count)
            }
            data = bytes
        }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let captured = AppContractRequest(
            method: request.httpMethod ?? "GET", path: url.path,
            query: Dictionary(query.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, new in new }),
            body: data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null,
            idempotencyKey: request.value(forHTTPHeaderField: "x-idempotency-key")
        )
        let response = transport.response(to: captured)
        let status: Int, contentType: String, bytes: Data
        var delay: TimeInterval = 0
        switch response {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code)); return
        case .json(let value, let code):
            status = code; contentType = "application/json"
            bytes = (try? JSONEncoder().encode(value)) ?? Data()
        case .delayedJSON(let value, let code, let wait):
            status = code; contentType = "application/json"; bytes = (try? JSONEncoder().encode(value)) ?? Data(); delay = wait
        case .events(let events, let wait):
            delay = wait
            status = 200; contentType = "text/event-stream"
            bytes = events.reduce(into: Data()) { result, event in
                guard let encoded = try? JSONEncoder().encode(event.1), let json = String(data: encoded, encoding: .utf8) else { return }
                result.append(Data("event: \(event.0)\ndata: \(json)\n\n".utf8))
            }
        }
        let http = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": contentType])!
        let emit = { [self] in
            stateLock.lock(); let cancelled = stopped; stateLock.unlock()
            guard !cancelled else { return }
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: bytes)
            client?.urlProtocolDidFinishLoading(self)
        }
        if delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: emit) }
        else { emit() }
    }
}

func appContractGraph(workspaceArchived: Bool = false, treeArchived: Bool = false, nodeDeleted: Bool = false) -> WorkspaceGraph {
    WorkspaceGraph(raw: [
        "workspace": ["id": "workspace-1", "name": "Fixture", "cwd": "/tmp/michi-contract", "created_at": 1,
                      "archived_at": workspaceArchived ? 2 : .null, "deleted_at": .null],
        "trees": [["id": "tree-1", "workspace_id": "workspace-1", "root_node_id": "node-1", "archived_at": treeArchived ? 2 : .null]],
        "nodes": [["id": "node-1", "workspace_id": "workspace-1", "tree_id": "tree-1", "title": "Conversation", "status": "idle", "deleted_at": nodeDeleted ? 2 : .null]],
        "edges": [], "contexts": [],
    ])
}

@MainActor
final class ChatContractTests: XCTestCase {
    private func makeChat(_ transport: AppContractTransport, graph: WorkspaceGraph = appContractGraph()) -> ChatController {
        ChatController(api: transport.api, graph: graph, node: graph.nodes[0])
    }

    private func cleanUp(_ chat: ChatController, transport: AppContractTransport) {
        chat.detach()
        let key = "michi.\(transport.api.baseURL.absoluteString).\(chat.node.id)"
        UserDefaults.standard.removeObject(forKey: key + ".draft")
        UserDefaults.standard.removeObject(forKey: key + ".activeTurn")
        transport.close()
    }

    private func eventually(_ message: String, timeout: TimeInterval = 8, condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), message, file: file, line: line)
    }

    func testFailedHistoryHydrationPreventsSendAndKeepsDraft() async {
        let transport = AppContractTransport { _, _ in .json(["error": "Unavailable"], status: 503) }
        let chat = makeChat(transport)
        defer { cleanUp(chat, transport: transport) }
        chat.draft = "Keep this unsent message"
        await chat.load()
        XCTAssertFalse(chat.loaded)
        XCTAssertNotNil(chat.error)
        chat.send()
        await Task.yield()
        XCTAssertFalse(chat.busy)
        XCTAssertEqual(chat.draft, "Keep this unsent message")
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
    }

    func testArchivedAndDeletedConversationsCannotSend() async {
        let graphs = [appContractGraph(workspaceArchived: true), appContractGraph(treeArchived: true), appContractGraph(nodeDeleted: true)]
        for graph in graphs {
            let transport = AppContractTransport { _, _ in .json(["messages": []]) }
            let chat = makeChat(transport, graph: graph)
            await chat.load()
            XCTAssertTrue(chat.loaded)
            XCTAssertTrue(chat.isReadOnly)
            chat.draft = "Must remain unsent"
            chat.send()
            XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
            XCTAssertEqual(chat.draft, "Must remain unsent")
            cleanUp(chat, transport: transport)
        }
    }

    func testArchivingAnActiveConversationBlocksSteer() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/ensure-session") { return .json(["sessionState": [:]]) }
            if request.path.hasSuffix("/message") {
                return .events([("turn_start", request.body.merging(["seq": 0]))])
            }
            if request.path.hasSuffix("/stream") { return .json(["error": "Replay unavailable"], status: 410) }
            var current = appContractGraph().raw
            current["nodes"] = .array(current["nodes"].arrayValue.map { $0.merging(["status": "streaming"]) })
            return .json(current)
        }
        let chat = makeChat(transport)
        defer { cleanUp(chat, transport: transport) }
        await chat.load()
        chat.draft = "Start a durable turn"
        chat.send()
        await eventually("The active turn should remain pending after unavailable replay") {
            chat.statusText == "Response status unknown" && !chat.reconnecting
        }
        XCTAssertNotNil(chat.turnID)
        XCTAssertTrue(chat.busy)
        let archived = appContractGraph(treeArchived: true)
        chat.refresh(graph: archived, node: archived.nodes[0])
        chat.draft = "Do not steer an archived turn"
        await chat.steer()
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/steer") })
        XCTAssertEqual(chat.draft, "Do not steer an archived turn")
    }

    func testTurnActiveRetriesExactlyTheSameTurnAndPayload() async {
        let attachment: JSONValue = ["name": "notes.txt", "absPath": "/tmp/notes.txt"]
        let transport = AppContractTransport { request, history in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/ensure-session") { return .json(["sessionState": ["status": "ready"]]) }
            if request.path.hasSuffix("/message") {
                let attempts = history.filter { $0.path.hasSuffix("/message") }.count
                if attempts == 1 { return .json(["error": "Still running", "code": "turn_active"], status: 409) }
                let frame = request.body.merging(["seq": 0, "assistantId": "answer-1"])
                return .events([("turn_start", frame), ("done", frame.merging(["seq": 1, "stopReason": "end_turn"]))])
            }
            return .json(["error": "Unexpected request"], status: 404)
        }
        let chat = makeChat(transport)
        defer { cleanUp(chat, transport: transport) }
        await chat.load()
        chat.draft = "Retry only when explicitly refused"
        chat.attachments = [attachment]
        chat.send()
        await eventually("The busy refusal should retry once, then finish") {
            transport.requests.filter { $0.path.hasSuffix("/message") }.count >= 2 && !chat.busy
        }
        let posts = transport.requests.filter { $0.path.hasSuffix("/message") }
        XCTAssertEqual(posts.count, 2)
        guard posts.count == 2 else { return }
        XCTAssertEqual(posts[0].method, "POST")
        XCTAssertEqual(posts[0].body, posts[1].body)
        XCTAssertFalse(posts[0].body["turnId"].stringValue.isEmpty)
        XCTAssertEqual(posts[0].body["displayText"], "Retry only when explicitly refused")
        XCTAssertEqual(posts[0].body["userMetadata"]["attachments"], .array([attachment]))
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/ensure-session") }.count, 1)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/stream") })
        XCTAssertNil(chat.turnID)
    }

    func testDirectClientRejectionRestoresDraftAndAttachmentsWithoutReplay() async {
        let attachment: JSONValue = ["name": "notes.txt", "absPath": "/tmp/notes.txt"]
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/ensure-session") { return .json(["sessionState": [:]]) }
            return .json(["error": "Invalid model", "code": "invalid_model"], status: 400)
        }
        let chat = makeChat(transport)
        var completed = 0
        chat.onGraphChanged = { completed += 1 }
        defer { cleanUp(chat, transport: transport) }
        await chat.load()
        chat.draft = "Preserve this draft"
        chat.attachments = [attachment]
        chat.send()
        await eventually("A confirmed 400 refusal should restore the composer") { !chat.busy && chat.error != nil && completed == 1 }
        XCTAssertEqual(chat.draft, "Preserve this draft")
        XCTAssertEqual(chat.attachments, [attachment])
        XCTAssertNil(chat.turnID)
        XCTAssertFalse(chat.messages.contains { $0.id.hasPrefix("pending-") })
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/stream") })
    }

    func testAmbiguousDisconnectReplaysSameTurnAndNeverRepostsMessage() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/ensure-session") { return .json(["sessionState": [:]]) }
            if request.path.hasSuffix("/message") { return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("/stream") { return .json(["error": "Replay unavailable", "code": "turn_replay_unavailable"], status: 410) }
            // A failed snapshot cannot prove that the original turn was rejected.
            return .json(["error": "Snapshot unavailable"], status: 503)
        }
        let chat = makeChat(transport)
        defer { cleanUp(chat, transport: transport) }
        await chat.load()
        chat.draft = "A potentially accepted turn"
        chat.send()
        await eventually("Ambiguous acceptance should preserve the pending turn") {
            chat.statusText == "Response status unknown" && !chat.reconnecting
        }
        let post = transport.requests.first { $0.path.hasSuffix("/message") }
        let replay = transport.requests.first { $0.path.hasSuffix("/stream") }
        XCTAssertNotNil(post)
        XCTAssertNotNil(replay)
        XCTAssertEqual(replay?.method, "GET")
        XCTAssertEqual(replay?.query["fromTurnId"], post?.body["turnId"].stringValue)
        XCTAssertEqual(replay?.query["fromSeq"], "0")
        XCTAssertEqual(chat.turnID, post?.body["turnId"].stringValue)
        XCTAssertTrue(chat.busy)
        chat.draft = "A second message must wait"
        chat.send()
        await Task.yield()
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
        XCTAssertEqual(chat.draft, "A second message must wait")
    }

    func testUnavailableReplayReconcilesAuthoritativeIdleSnapshotOnlyOnce() async {
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/ensure-session") { return .json(["sessionState": [:]]) }
            if request.path.hasSuffix("/message") { return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("/stream") { return .json(["error": "Replay expired"], status: 410) }
            var graph = appContractGraph().raw
            let turn = requests.last(where: { $0.path.hasSuffix("/message") })?.body["turnId"] ?? .null
            graph["nodes"] = .array(graph["nodes"].arrayValue.map { $0.merging(["last_applied_turn_id": turn, "last_applied_seq": 4]) })
            return .json(graph)
        }
        let chat = makeChat(transport)
        var completed = 0
        chat.onGraphChanged = { completed += 1 }
        defer { cleanUp(chat, transport: transport) }
        await chat.load()
        chat.draft = "Reconcile this turn"
        chat.send()
        await eventually("An authoritative idle snapshot should settle the turn once") { completed == 1 && !chat.busy }
        XCTAssertNil(chat.turnID)
        XCTAssertEqual(completed, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/messages") }.count, 2, "One initial history read and one terminal reconciliation")
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }

    func testIncompleteReconciliationCannotClearAnUnknownTurn() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/ensure-session") { return .json(["sessionState": [:]]) }
            if request.path.hasSuffix("/message") { return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("/stream") { return .json(["error": "Replay expired"], status: 410) }
            return .json(["workspace": ["id": "workspace-1"], "nodes": [["id": "node-1"]]])
        }
        let chat = makeChat(transport)
        defer { cleanUp(chat, transport: transport) }
        await chat.load()
        chat.draft = "Potentially accepted"
        chat.send()
        await eventually("The reconciliation attempt should finish") {
            transport.requests.contains { $0.path == "/api/workspaces/workspace-1" }
                && chat.error != nil && !chat.reconnecting
        }
        XCTAssertTrue(chat.busy, "A missing status is not authoritative proof that the turn ended")
        XCTAssertNotNil(chat.turnID)
        XCTAssertEqual(chat.statusText, "Response status unknown")
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }

    func testIdleSnapshotForAnOlderTurnDoesNotClearUnknownSend() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/ensure-session") { return .json([:]) }
            if request.path.hasSuffix("/message") { return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("/stream") { return .json(["error": "Not registered yet"], status: 410) }
            var graph = appContractGraph().raw
            graph["nodes"] = .array(graph["nodes"].arrayValue.map { $0.merging(["last_applied_turn_id": "older-turn", "last_applied_seq": 7]) })
            return .json(graph)
        }
        let chat = makeChat(transport); defer { cleanUp(chat, transport: transport) }
        await chat.load(); chat.draft = "An uncertain send"; chat.send()
        await eventually("Reconciliation should read the old idle node") { transport.requests.contains { $0.path == "/api/workspaces/workspace-1" } }
        XCTAssertTrue(chat.busy); XCTAssertNotNil(chat.turnID)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }

    func testBackgroundDetachRestoresMessageAfterConfirmedBusyRejection() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/message") { return .json(["error": "Busy", "code": "turn_active"], status: 409) }
            return .json([:])
        }
        let chat = makeChat(transport); defer { cleanUp(chat, transport: transport) }
        await chat.load(); chat.draft = "Keep this draft"; chat.send()
        await eventually("Wait for confirmed busy rejection") { chat.statusText.contains("previous response") }
        chat.detach()
        XCTAssertEqual(chat.draft, "Keep this draft"); XCTAssertFalse(chat.busy); XCTAssertNil(chat.turnID)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }

    func testStopDuringBusyPostPreventsRetryAfter409Arrives() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/message") { return .delayedJSON(["error": "Busy", "code": "turn_active"], status: 409, delay: 0.15) }
            return .json(["ok": true])
        }
        let chat = makeChat(transport); defer { cleanUp(chat, transport: transport) }
        await chat.load(); chat.draft = "Do not retry after Stop"; chat.send()
        await eventually("Initial POST must be in flight") { transport.requests.contains { $0.path.hasSuffix("/message") } }
        await chat.stop()
        await eventually("409 confirms the stopped turn was never started") { !chat.busy }
        XCTAssertEqual(chat.draft, "Do not retry after Stop")
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 1)
    }

    func testSendWorksAfterBackgroundResumeCompletesTurn() async {
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/message") { return .failure(.networkConnectionLost) }
            if request.path.hasSuffix("/stream") {
                if requests.filter({ $0.path.hasSuffix("/stream") }).count == 1 { return .failure(.networkConnectionLost) }
                let turn = requests.last(where: { $0.path.hasSuffix("/message") })?.body["turnId"] ?? .null
                return .events([("done", ["nodeId": "node-1", "turnId": turn, "seq": 1, "persisted": true])])
            }
            return .json([:])
        }
        let chat = makeChat(transport); defer { cleanUp(chat, transport: transport) }
        await chat.load(); chat.draft = "First"; chat.send()
        await eventually("First replay should be in backoff") { transport.requests.contains { $0.path.hasSuffix("/stream") } }
        chat.detach(); chat.resumeIfNeeded()
        await eventually("Resume should settle first turn") { !chat.busy && chat.turnID == nil }
        chat.draft = "Second"; chat.send()
        await eventually("Second send must not be silently blocked by old sending flag") { transport.requests.filter { $0.path.hasSuffix("/message") }.count == 2 }
    }

}
