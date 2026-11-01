import Foundation
import XCTest
@testable import MichiCore

private actor MultiplexSocketFixture: MichiStreamSocket {
    private(set) var sent: [JSONValue] = []
    private var incoming: [Result<String, Error>] = []
    private var waiter: CheckedContinuation<String, Error>?
    private(set) var closed = false
    func send(_ text: String) async throws {
        guard !closed else { throw URLError(.networkConnectionLost) }
        sent.append(try JSONValue.parse(text))
    }
    func receive() async throws -> String {
        if !incoming.isEmpty { return try incoming.removeFirst().get() }
        if closed { throw URLError(.networkConnectionLost) }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func close() async {
        closed = true
        waiter?.resume(throwing: URLError(.networkConnectionLost)); waiter = nil
    }
    func push(_ frame: JSONValue) throws {
        let text = String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
        if let waiter { self.waiter = nil; waiter.resume(returning: text) }
        else { incoming.append(.success(text)) }
    }
    func loseConnection() {
        closed = true
        if let waiter { self.waiter = nil; waiter.resume(throwing: URLError(.networkConnectionLost)) }
        else { incoming.append(.failure(URLError(.networkConnectionLost))) }
    }
}

private actor MultiplexSocketPool {
    private(set) var upgrades: [URLRequest] = []
    private(set) var sockets: [MultiplexSocketFixture] = []
    func make(_ request: URLRequest) -> any MichiStreamSocket {
        let socket = MultiplexSocketFixture()
        upgrades.append(request); sockets.append(socket)
        return socket
    }
}

private final class MultiplexHTTPFixture: @unchecked Sendable {
    struct Reply { let status: Int; let contentType: String; let data: Data }
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    private let handler: (URLRequest) -> Reply
    let api: MichiAPI
    let session: URLSession
    let baseURL: URL
    init(capabilities: JSONValue = ["protocolVersion": 2, "streamTransport": "websocket-v1"], streamTransport: MichiStreamTransport? = nil, handler: ((URLRequest) -> Reply)? = nil) {
        baseURL = URL(string: "https://multiplex-\(UUID().uuidString.lowercased()).michi.test")!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MultiplexTicketProtocol.self]
        config.urlCache = nil
        session = URLSession(configuration: config)
        api = MichiAPI(baseURL: baseURL, bearerToken: "synthetic-test-token", session: session, streamTransport: streamTransport)
        self.handler = handler ?? { request in
            if request.url?.path == "/api/persistence/capabilities" { return Self.json(capabilities) }
            if request.url?.path == "/api/stream-transport" { return Self.json(["token": .string(String(repeating: "a", count: 64))]) }
            return Self.json(["error": "Unexpected request"], status: 404)
        }
        MultiplexTicketProtocol.register(self)
    }
    static func json(_ value: JSONValue, status: Int = 200) -> Reply {
        Reply(status: status, contentType: "application/json", data: (try? JSONEncoder().encode(value)) ?? Data())
    }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return recorded }
    func answer(_ request: URLRequest) -> Reply {
        lock.lock(); recorded.append(request); lock.unlock()
        return handler(request)
    }
    func close() { session.invalidateAndCancel(); MultiplexTicketProtocol.unregister(baseURL.host!) }
}

private final class MultiplexTicketProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var fixtures: [String: MultiplexHTTPFixture] = [:]
    static func register(_ fixture: MultiplexHTTPFixture) { lock.lock(); defer { lock.unlock() }; fixtures[fixture.baseURL.host!] = fixture }
    static func unregister(_ host: String) { lock.lock(); defer { lock.unlock() }; fixtures.removeValue(forKey: host) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        Self.lock.lock(); let fixture = request.url?.host.flatMap { Self.fixtures[$0] }; Self.lock.unlock()
        guard let fixture, let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return }
        let reply = fixture.answer(request)
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": reply.contentType])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class StreamTransportTests: XCTestCase {
    private func makeTransport(pool: MultiplexSocketPool, limits: MichiStreamTransport.Limits = .init()) -> MichiStreamTransport {
        MichiStreamTransport(limits: limits, socketFactory: { request, _, _ in await pool.make(request) })
    }
    private func waitFor(_ message: String, condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !(await condition()), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        let satisfied = await condition()
        XCTAssertTrue(satisfied, message, file: file, line: line)
    }
    private func collect(_ stream: AsyncThrowingStream<SSEEvent, Error>) async throws -> [SSEEvent] {
        var events: [SSEEvent] = []
        for try await event in stream { events.append(event) }
        return events
    }
    private func complete(_ socket: MultiplexSocketFixture, id: String, text: String = "event: done\ndata: {}\n\n") async throws {
        try await socket.push(["type": "headers", "id": .string(id), "status": 200])
        try await socket.push(["type": "data", "id": .string(id), "text": .string(text)])
        try await socket.push(["type": "end", "id": .string(id)])
    }

    func testMichiAPIHookUsesConfiguredWebSocketAndClosesIt() async throws {
        let pool = MultiplexSocketPool(), transport = makeTransport(pool: pool)
        let fixture = MultiplexHTTPFixture(streamTransport: transport)
        defer { fixture.close(); Task { await transport.close() } }
        try await transport.configure(capabilities: ["protocolVersion": 2, "streamTransport": "websocket-v1"])
        let reading = Task { try await self.collect(fixture.api.stream("/chats/one/stream?fromSeq=2")) }
        await waitFor("API stream must use its configured WebSocket transport") {
            guard let socket = await pool.sockets.first else { return false }
            return await socket.sent.count == 1
        }
        let sockets = await pool.sockets, socket = try XCTUnwrap(sockets.first)
        let frames = await socket.sent
        XCTAssertEqual(frames.first?["path"], "/api/chats/one/stream?fromSeq=2")
        try await complete(socket, id: try XCTUnwrap(frames.first).id)
        let events = try await reading.value
        XCTAssertEqual(events.map(\.event), ["done"])
        XCTAssertEqual(fixture.requests.map { $0.url?.path }, ["/api/stream-transport"], "Seeded boot negotiation must not repeat the capability probe")
        await fixture.api.closeStreams()
        let closed = await socket.closed
        XCTAssertTrue(closed)
    }

    func testAllowlistMatchesGatewayRoutesAndMethodsWithoutGeneralProxy() {
        XCTAssertTrue(MichiStreamTransport.supports(path: "/chats/node-1/message", method: "POST"))
        XCTAssertTrue(MichiStreamTransport.supports(path: "/backend-connections/remote/proxy/chats/node-1/stream?fromSeq=8&fromTurnId=t", method: "GET"))
        XCTAssertTrue(MichiStreamTransport.supports(path: "/chats/background/subscribe", method: "POST"))
        XCTAssertTrue(MichiStreamTransport.supports(path: "/agent-runs/subscribe", method: "GET"))
        XCTAssertFalse(MichiStreamTransport.supports(path: "/chats/node-1/cancel", method: "POST"))
        XCTAssertFalse(MichiStreamTransport.supports(path: "/chats/node-1/message", method: "GET"))
        XCTAssertFalse(MichiStreamTransport.supports(path: "/panes/presence", method: "POST"))
        XCTAssertFalse(MichiStreamTransport.supports(path: "//other.example/api/chats/a/stream", method: "GET"))
        XCTAssertFalse(MichiStreamTransport.supports(path: "/chats/%2e%2e/stream", method: "GET"))
    }

    func testCapabilityAndTicketValidationFailClosed() throws {
        XCTAssertTrue(try MichiStreamTransport.supportsWebSocket(["protocolVersion": 2, "streamTransport": "websocket-v1"]))
        XCTAssertFalse(try MichiStreamTransport.supportsWebSocket(["protocolVersion": 1]))
        XCTAssertThrowsError(try MichiStreamTransport.supportsWebSocket(.null))
        var target = URLRequest(url: URL(string: "https://michi.test/prefix/api/stream-transport")!)
        target.setValue("Bearer do-not-forward", forHTTPHeaderField: "Authorization")
        let ticket: JSONValue = ["token": .string(String(repeating: "a", count: 64))]
        let upgrade = try MichiStreamTransport.upgradeRequest(ticket: ticket, target: target, origin: "https://michi.test")
        XCTAssertEqual(upgrade.url?.scheme, "wss")
        XCTAssertEqual(upgrade.url?.path, "/prefix/api/stream-transport")
        XCTAssertEqual(upgrade.value(forHTTPHeaderField: "Origin"), "https://michi.test")
        XCTAssertNil(upgrade.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(URLComponents(url: upgrade.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, ticket["token"].stringValue)
        XCTAssertThrowsError(try MichiStreamTransport.upgradeRequest(ticket: ticket, target: target, origin: "https://other.test"))
        XCTAssertThrowsError(try MichiStreamTransport.upgradeRequest(ticket: ["token": "a&origin=evil"], target: target, origin: "https://michi.test"))
    }

    func testFrameParserBoundsAndValidatesEnvelopeBeforeDispatch() throws {
        XCTAssertEqual(try MichiStreamFrame.parse("{\"type\":\"headers\",\"id\":\"one\",\"status\":409}", maximum: 100), .headers("one", 409))
        for bad in ["[]", "{}", "{\"type\":\"end\",\"id\":\"a/b\"}", "{\"type\":\"headers\",\"id\":\"a\",\"status\":200.5}", "{\"type\":\"data\",\"id\":\"a\",\"text\":1}"] {
            XCTAssertThrowsError(try MichiStreamFrame.parse(bad, maximum: 1000), bad)
        }
        XCTAssertThrowsError(try MichiStreamFrame.parse(String(repeating: "x", count: 101), maximum: 100))
    }

    func testConcurrentSubscribersShareOneTicketAndKeepBodiesAndReplayCursor() async throws {
        let fixture = MultiplexHTTPFixture(), pool = MultiplexSocketPool()
        let transport = makeTransport(pool: pool)
        defer { fixture.close(); Task { await transport.close() } }
        let payload: JSONValue = ["text": "Hello", "turnId": "turn-one", "nodeId": "one"]
        let first = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/one/message", method: "POST", body: payload)) }
        let second = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/two/stream?fromTurnId=two&fromSeq=9")) }
        await waitFor("One socket should carry both opens") {
            guard let socket = await pool.sockets.first else { return false }
            return await socket.sent.count == 2
        }
        let sockets = await pool.sockets
        XCTAssertEqual(sockets.count, 1)
        let socket = try XCTUnwrap(sockets.first)
        let sent = await socket.sent
        let firstOpen = try XCTUnwrap(sent.first { $0["method"].stringValue == "POST" })
        XCTAssertEqual(try JSONValue.parse(firstOpen["body"].stringValue), payload)
        XCTAssertTrue(sent.contains { $0["path"].stringValue == "/api/chats/two/stream?fromTurnId=two&fromSeq=9" })
        for frame in sent { try await complete(socket, id: frame.id) }
        let a = try await first.value, b = try await second.value
        XCTAssertEqual(a.map(\.event), ["done"])
        XCTAssertEqual(b.map(\.event), ["done"])
        XCTAssertEqual(fixture.requests.filter { $0.url?.path == "/api/stream-transport" }.count, 1)
        let ticketRequest = try XCTUnwrap(fixture.requests.first { $0.url?.path == "/api/stream-transport" })
        XCTAssertEqual(ticketRequest.httpMethod, "POST")
        XCTAssertEqual(ticketRequest.value(forHTTPHeaderField: "Origin"), fixture.baseURL.absoluteString)
        XCTAssertEqual(ticketRequest.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-test-token")
    }

    func testFragmentedSSEAndHTTPBusyCodeSurviveMultiplexing() async throws {
        let fixture = MultiplexHTTPFixture(), pool = MultiplexSocketPool()
        let transport = makeTransport(pool: pool)
        defer { fixture.close(); Task { await transport.close() } }
        let stream = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/one/stream")) }
        await waitFor("Open") { guard let s = await pool.sockets.first else { return false }; return await s.sent.count == 1 }
        let sockets = await pool.sockets, socket = try XCTUnwrap(sockets.first)
        let opens = await socket.sent, id = try XCTUnwrap(opens.first).id
        try await socket.push(["type": "headers", "id": .string(id), "status": 200])
        for piece in ["event: chu", "nk\r", "\ndata: {\"text\":\"你好\"}\r\n", "\r\n"] {
            try await socket.push(["type": "data", "id": .string(id), "text": .string(piece)])
        }
        try await socket.push(["type": "end", "id": .string(id)])
        let events = try await stream.value
        XCTAssertEqual(events, [SSEEvent(event: "chunk", data: ["text": "你好"])])
        let refused = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/one/message", method: "POST", body: ["turnId": "next"])) }
        await waitFor("Second open") { await socket.sent.count == 2 }
        let frames = await socket.sent, next = try XCTUnwrap(frames.last).id
        try await socket.push(["type": "headers", "id": .string(next), "status": 409])
        try await socket.push(["type": "data", "id": .string(next), "text": "{\"error\":\"Busy\",\"code\":\"turn_active\"}"])
        try await socket.push(["type": "end", "id": .string(next)])
        do { _ = try await refused.value; XCTFail("Expected HTTP refusal") }
        catch let error as MichiAPIError { XCTAssertEqual(error.statusCode, 409); XCTAssertEqual(error.code, "turn_active") }
    }

    func testCancellationDetachesOnlyItsChannelAndDoesNotCancelAgent() async throws {
        let fixture = MultiplexHTTPFixture(), pool = MultiplexSocketPool()
        let transport = makeTransport(pool: pool)
        defer { fixture.close(); Task { await transport.close() } }
        let first = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/one/stream")) }
        let second = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/two/stream")) }
        await waitFor("Two opens") { guard let s = await pool.sockets.first else { return false }; return await s.sent.count == 2 }
        let sockets = await pool.sockets, socket = try XCTUnwrap(sockets.first)
        let opens = await socket.sent
        let one = try XCTUnwrap(opens.first { $0["path"].stringValue.contains("/one/") }).id
        let two = try XCTUnwrap(opens.first { $0["path"].stringValue.contains("/two/") }).id
        first.cancel()
        do { _ = try await first.value; XCTFail("Expected cancellation") } catch is CancellationError {}
        await waitFor("Detach frame") { await socket.sent.contains { $0["type"] == "cancel" && $0.id == one } }
        let closed = await socket.closed
        XCTAssertFalse(closed)
        try await complete(socket, id: two)
        _ = try await second.value
        XCTAssertFalse(fixture.requests.contains { $0.url?.path.hasSuffix("/cancel") == true })
    }

    func testSocketLossNeverRepostsAndNextGetUsesNewTicket() async throws {
        let fixture = MultiplexHTTPFixture(), pool = MultiplexSocketPool()
        let transport = makeTransport(pool: pool)
        defer { fixture.close(); Task { await transport.close() } }
        let post = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/one/message", method: "POST", body: ["turnId": "durable-one"])) }
        await waitFor("Initial open") { guard let s = await pool.sockets.first else { return false }; return await s.sent.count == 1 }
        let firstSockets = await pool.sockets, socket = try XCTUnwrap(firstSockets.first)
        await socket.loseConnection()
        do { _ = try await post.value; XCTFail("Expected ambiguous connection failure") } catch {}
        XCTAssertEqual(fixture.requests.filter { $0.url?.path.hasSuffix("/message") == true }.count, 0, "No HTTP fallback POST")
        let replay = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/one/stream?fromTurnId=durable-one&fromSeq=0")) }
        await waitFor("Fresh ticket and replay socket") { guard await pool.sockets.count == 2, let s = await pool.sockets.last else { return false }; return await s.sent.count == 1 }
        let nextSockets = await pool.sockets, next = try XCTUnwrap(nextSockets.last)
        let frames = await next.sent
        XCTAssertEqual(frames.first?["method"], "GET")
        XCTAssertTrue(frames.first?["path"].stringValue.contains("fromTurnId=durable-one") == true)
        try await complete(next, id: try XCTUnwrap(frames.first).id)
        _ = try await replay.value
        XCTAssertEqual(fixture.requests.filter { $0.url?.path == "/api/stream-transport" }.count, 2)
    }

    func testExplicitLegacyCapabilityUsesOriginalSSEWithoutSocket() async throws {
        let fixture = MultiplexHTTPFixture(handler: { request in
            if request.url?.path == "/api/persistence/capabilities" { return MultiplexHTTPFixture.json(["protocolVersion": 1]) }
            return .init(status: 200, contentType: "text/event-stream", data: Data("event: done\ndata: {}\n\n".utf8))
        })
        let pool = MultiplexSocketPool(), transport = makeTransport(pool: pool)
        defer { fixture.close(); Task { await transport.close() } }
        let result = try await collect(transport.stream(api: fixture.api, path: "/chats/one/stream"))
        XCTAssertEqual(result.map(\.event), ["done"])
        let sockets = await pool.sockets
        XCTAssertTrue(sockets.isEmpty)
        XCTAssertFalse(fixture.requests.contains { $0.url?.path == "/api/stream-transport" })
    }

    func testFailedCapabilityProbeDoesNotDowngradeOrPost() async throws {
        let fixture = MultiplexHTTPFixture(handler: { _ in MultiplexHTTPFixture.json(["error": "Unavailable"], status: 503) })
        let pool = MultiplexSocketPool(), transport = makeTransport(pool: pool)
        defer { fixture.close(); Task { await transport.close() } }
        do { _ = try await collect(transport.stream(api: fixture.api, path: "/chats/one/message", method: "POST", body: ["turnId": "never-started"])); XCTFail("Expected negotiation failure") }
        catch let error as MichiAPIError { XCTAssertEqual(error.statusCode, 503) }
        XCTAssertEqual(fixture.requests.count, 1)
        XCTAssertEqual(fixture.requests.first?.httpMethod, "GET")
        let sockets = await pool.sockets
        XCTAssertTrue(sockets.isEmpty)
    }

    func testOversizedConsumerChunkDetachesWithoutUnboundedBuffering() async throws {
        let fixture = MultiplexHTTPFixture(), pool = MultiplexSocketPool()
        var limits = MichiStreamTransport.Limits(); limits.maxBufferedBytes = 1024
        let transport = makeTransport(pool: pool, limits: limits)
        defer { fixture.close(); Task { await transport.close() } }
        let stream = Task { try await self.collect(transport.stream(api: fixture.api, path: "/chats/one/stream")) }
        await waitFor("Open") { guard let s = await pool.sockets.first else { return false }; return await s.sent.count == 1 }
        let sockets = await pool.sockets, socket = try XCTUnwrap(sockets.first)
        let frames = await socket.sent, id = try XCTUnwrap(frames.first).id
        try await socket.push(["type": "headers", "id": .string(id), "status": 200])
        try await socket.push(["type": "data", "id": .string(id), "text": .string(String(repeating: "x", count: 1025))])
        do { _ = try await stream.value; XCTFail("Expected bounded buffer failure") }
        catch let error as MichiAPIError { XCTAssertEqual(error.code, MichiAPIError.Code.streamLimitExceeded) }
        await waitFor("Oversized channel detached") { await socket.sent.contains { $0["type"] == "cancel" && $0.id == id } }
        let closed = await socket.closed
        XCTAssertFalse(closed)
    }

    func testHeaderTimeoutDetachesWithoutResendingPost() async throws {
        let fixture = MultiplexHTTPFixture(), pool = MultiplexSocketPool()
        var limits = MichiStreamTransport.Limits(); limits.headerTimeout = 0.05
        let transport = makeTransport(pool: pool, limits: limits)
        defer { fixture.close(); Task { await transport.close() } }
        do { _ = try await collect(transport.stream(api: fixture.api, path: "/chats/one/message", method: "POST", body: ["turnId": "one"])); XCTFail("Expected timeout") }
        catch let error as MichiAPIError { XCTAssertEqual(error.code, MichiAPIError.Code.timedOut) }
        let sockets = await pool.sockets, socket = try XCTUnwrap(sockets.first)
        await waitFor("Timeout detach") { await socket.sent.contains { $0["type"] == "cancel" } }
        let frames = await socket.sent
        XCTAssertEqual(frames.filter { $0["type"] == "open" }.count, 1)
        XCTAssertFalse(fixture.requests.contains { $0.url?.path.hasSuffix("/message") == true })
    }
    func testPositiveCapabilityTicketRefusalDoesNotFallbackToHTTPPost() async throws {
        let fixture = MultiplexHTTPFixture(handler: { request in
            if request.url?.path == "/api/persistence/capabilities" {
                return MultiplexHTTPFixture.json(["protocolVersion": 2, "streamTransport": "websocket-v1"])
            }
            return MultiplexHTTPFixture.json(["error": "Ticket refused"], status: 403)
        })
        let pool = MultiplexSocketPool(), transport = makeTransport(pool: pool)
        defer { fixture.close(); Task { await transport.close() } }
        do { _ = try await collect(transport.stream(api: fixture.api, path: "/chats/one/message", method: "POST", body: ["turnId": "one"])); XCTFail("Expected ticket refusal") }
        catch let error as MichiAPIError { XCTAssertEqual(error.statusCode, 403) }
        XCTAssertEqual(fixture.requests.map { $0.url?.path }, ["/api/persistence/capabilities", "/api/stream-transport"])
        let sockets = await pool.sockets
        XCTAssertTrue(sockets.isEmpty)
    }

    func testTransportOwnershipUsesOpaqueInstanceIdentityNotCredentials() async throws {
        let pool = MultiplexSocketPool(), transport = makeTransport(pool: pool)
        let first = MultiplexHTTPFixture(streamTransport: transport)
        defer { first.close(); Task { await transport.close() } }
        try await transport.configure(capabilities: ["protocolVersion": 2, "streamTransport": "websocket-v1"])
        let reading = Task { try await self.collect(first.api.stream("/chats/one/stream")) }
        await waitFor("the first API must bind the transport") {
            guard let socket = await pool.sockets.first else { return false }
            return await socket.sent.count == 1
        }
        let second = MichiAPI(baseURL: first.baseURL, bearerToken: "synthetic-test-token", session: first.session, streamTransport: transport)
        XCTAssertEqual(second.credentialIdentityFingerprint, first.api.credentialIdentityFingerprint)
        XCTAssertNotEqual(second.instanceID, first.api.instanceID)
        do {
            _ = try await collect(second.stream("/chats/two/stream"))
            XCTFail("A replacement client must not inherit the socket")
        } catch let error as MichiAPIError {
            XCTAssertTrue(error.message.contains("cannot be shared"), "\(error)")
        }
        let sockets = await pool.sockets
        XCTAssertEqual(sockets.count, 1)
        XCTAssertFalse(first.requests.contains { $0.url?.path.hasSuffix("/chats/two/stream") == true })
        let socket = try XCTUnwrap(sockets.first)
        let frames = await socket.sent
        try await complete(socket, id: try XCTUnwrap(frames.first).id)
        let events = try await reading.value
        XCTAssertEqual(events.map(\.event), ["done"])
    }

    func testOversizedOutboundEnvelopeIsAnExplicitUnsentRefusal() async throws {
        let fixture = MultiplexHTTPFixture(), pool = MultiplexSocketPool()
        var limits = MichiStreamTransport.Limits(); limits.maxBufferedBytes = 512
        let transport = makeTransport(pool: pool, limits: limits)
        defer { fixture.close(); Task { await transport.close() } }
        do {
            _ = try await collect(transport.stream(api: fixture.api, path: "/chats/one/message", method: "POST", body: ["text": .string(String(repeating: "x", count: 1024)), "turnId": "one"]))
            XCTFail("Expected local body refusal")
        } catch let error as MichiAPIError {
            XCTAssertEqual(error.statusCode, 413, "Composer must be able to restore an explicitly unsent draft")
        }
        let sockets = await pool.sockets, socket = try XCTUnwrap(sockets.first)
        let frames = await socket.sent
        XCTAssertFalse(frames.contains { $0["type"] == "open" })
        XCTAssertFalse(fixture.requests.contains { $0.url?.path.hasSuffix("/message") == true })
    }

}
