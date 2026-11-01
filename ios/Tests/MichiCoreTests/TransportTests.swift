import XCTest
@testable import MichiCore

/// Deterministic in-process backend: every request is answered by the installed
/// handler and recorded. Nothing reaches the network.
final class TransportMockURLProtocol: URLProtocol {
    struct Recorded {
        let method: String
        let url: URL
        let headers: [String: String]
        let body: Data
    }

    struct Chunk {
        var data: Data
        /// Delivery waits for this signal (or `stopLoading`) before sending the chunk.
        var waitFor: DispatchSemaphore?

        init(_ text: String, waitFor: DispatchSemaphore? = nil) {
            self.data = Data(text.utf8)
            self.waitFor = waitFor
        }
    }

    enum Reply {
        case respond(status: Int, headers: [String: String], chunks: [Chunk])
        case redirect(status: Int, location: String)
        case fail(URLError.Code)
    }

    private static let lock = NSLock()
    private static var handler: ((Recorded) -> Reply)?
    private static var recorded: [Recorded] = []
    private static var stops = 0

    static func install(_ handler: @escaping (Recorded) -> Reply) {
        lock.lock()
        defer { lock.unlock() }
        self.handler = handler
        recorded = []
        stops = 0
    }

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        handler = nil
        recorded = []
        stops = 0
    }

    static var requests: [Recorded] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    static var stopCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return stops
    }

    private let stateLock = NSLock()
    private var stopped = false
    private var gates: [DispatchSemaphore] = []

    private var isStopped: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stopped
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url ?? URL(string: "about:blank")!
        let entry = Recorded(method: request.httpMethod ?? "GET", url: url,
                             headers: request.allHTTPHeaderFields ?? [:], body: Self.body(of: request))
        Self.lock.lock()
        Self.recorded.append(entry)
        let handler = Self.handler
        Self.lock.unlock()

        switch handler?(entry) ?? .fail(.unsupportedURL) {
        case .fail(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .redirect(let status, let location):
            let target = URL(string: location, relativeTo: url)!.absoluteURL
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Location": target.absoluteString])!
            // Like a real redirect, the follow-up request would carry the original headers.
            var next = URLRequest(url: target)
            next.httpMethod = entry.method
            next.allHTTPHeaderFields = entry.headers
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
        case .respond(let status, let headers, let chunks):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            stateLock.lock()
            gates = chunks.compactMap(\.waitFor)
            stateLock.unlock()
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            DispatchQueue.global().async { [self] in
                for chunk in chunks {
                    if let gate = chunk.waitFor { _ = gate.wait(timeout: .now() + 10) }
                    guard !isStopped else { return }
                    client?.urlProtocol(self, didLoad: chunk.data)
                }
                guard !isStopped else { return }
                client?.urlProtocolDidFinishLoading(self)
            }
        }
    }

    override func stopLoading() {
        stateLock.lock()
        stopped = true
        let pendingGates = gates
        stateLock.unlock()
        pendingGates.forEach { $0.signal() }
        Self.lock.lock()
        Self.stops += 1
        Self.lock.unlock()
    }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// A session-level delegate that would follow every redirect.
final class TransportFollowingDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(request)
    }
}

struct TransportTestTimeout: Error {}

final class TransportTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Date
    init(_ stored: Date) { self.stored = stored }
    func date() -> Date { lock.lock(); defer { lock.unlock() }; return stored }
    func set(_ stored: Date) { lock.lock(); self.stored = stored; lock.unlock() }
}

actor TransportEventRecorder {
    private(set) var events: [SSEEvent] = []
    func append(_ event: SSEEvent) { events.append(event) }
    var count: Int { events.count }
}

func transportWithTimeout<T: Sendable>(_ seconds: Double = 5, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask(operation: operation)
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw TransportTestTimeout()
        }
        defer { group.cancelAll() }
        guard let result = try await group.next() else { throw TransportTestTimeout() }
        return result
    }
}

func transportWaitUntil(_ seconds: Double = 5, _ condition: @Sendable () async -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !(await condition()) {
        guard Date() < deadline else { throw TransportTestTimeout() }
        try await Task.sleep(nanoseconds: 10_000_000)
    }
}

final class TransportTests: XCTestCase {
    func testCommandReceiptRetriesHaveCanonicalWireBodies() throws {
        let api = MichiAPI(baseURL: URL(string: "https://michi.example.test")!)
        let first: JSONValue = ["operationId": "stable", "commands": [["type": "node.patch", "patch": ["title": "标题", "draft": "same"]]], "workspaceId": "w1"]
        let second = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"workspaceId":"w1","commands":[{"patch":{"draft":"same","title":"标题"},"type":"node.patch"}],"operationId":"stable"}"#.utf8))
        let bodies = try (0..<30).map { index in
            try api.makeRequest("/workspaces/w1/commands", method: "POST", body: index.isMultiple(of: 2) ? first : second, kind: .json).0.httpBody!
        }
        XCTAssertTrue(bodies.allSatisfy { $0 == bodies[0] })
        XCTAssertEqual(String(decoding: bodies[0], as: UTF8.self), #"{"commands":[{"patch":{"draft":"same","title":"标题"},"type":"node.patch"}],"operationId":"stable","workspaceId":"w1"}"#)
    }
    private let base = URL(string: "https://michi.example.test")!
    private let jsonHeaders = ["Content-Type": "application/json"]
    private let sseHeaders = ["Content-Type": "text/event-stream"]
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        TransportMockURLProtocol.reset()
        session = makeSession()
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        TransportMockURLProtocol.reset()
        super.tearDown()
    }

    private func makeSession(delegate: URLSessionDelegate? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TransportMockURLProtocol.self]
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    private func makeAPI(_ url: URL? = nil, token: String? = "secret-token", session: URLSession? = nil) -> MichiAPI {
        MichiAPI(baseURL: url ?? base, bearerToken: token, session: session ?? self.session!)
    }

    private func respondJSON(_ body: String) -> TransportMockURLProtocol.Reply { respondJSON(200, body) }

    private func respondJSON(_ status: Int, _ body: String) -> TransportMockURLProtocol.Reply {
        .respond(status: status, headers: jsonHeaders, chunks: [.init(body)])
    }

    @discardableResult
    private func expectError<T: Sendable>(_ code: String?, status: Int?, file: StaticString = #filePath, line: UInt = #line,
                                          _ operation: @escaping @Sendable () async throws -> T) async -> MichiAPIError? {
        do {
            _ = try await transportWithTimeout(5, operation)
            XCTFail("Expected MichiAPIError \(code ?? "nil")", file: file, line: line)
        } catch let error as MichiAPIError {
            XCTAssertEqual(error.code, code, "\(error)", file: file, line: line)
            XCTAssertEqual(error.statusCode, status, "\(error)", file: file, line: line)
            return error
        } catch {
            XCTFail("Unexpected error \(error)", file: file, line: line)
        }
        return nil
    }

    private func collect(_ stream: AsyncThrowingStream<SSEEvent, Error>) async throws -> [SSEEvent] {
        try await transportWithTimeout {
            var events: [SSEEvent] = []
            for try await event in stream { events.append(event) }
            return events
        }
    }

    // MARK: - Requests

    func testGETPrefixesAPIOnceAndSendsIdentityHeaders() async throws {
        TransportMockURLProtocol.install { _ in self.respondJSON(#"{"workspaces":[{"id":"w1"}],"meta":{"count":1}}"#) }
        let api = makeAPI()
        let value = try await transportWithTimeout { try await api.request("/workspaces/all?meta=1") }

        XCTAssertEqual(value["workspaces"].arrayValue.first?.id, "w1")
        XCTAssertEqual(value["meta"]["count"].intValue, 1)
        let request = try XCTUnwrap(TransportMockURLProtocol.requests.first)
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.url.absoluteString, "https://michi.example.test/api/workspaces/all?meta=1")
        XCTAssertEqual(request.headers["Origin"], "https://michi.example.test")
        XCTAssertEqual(request.headers["Authorization"], "Bearer secret-token")
        XCTAssertEqual(request.headers["Accept"], "application/json")
        XCTAssertNil(request.headers["Content-Type"])
        XCTAssertTrue(request.body.isEmpty)
    }

    func testBaseURLIsNormalizedToTheServerRoot() async throws {
        TransportMockURLProtocol.install { _ in self.respondJSON("[]") }
        let api = makeAPI(URL(string: "https://Michi.Example.TEST:443/root/api/")!)
        XCTAssertNil(api.configurationError)
        XCTAssertEqual(api.baseURL.absoluteString, "https://michi.example.test/root")
        _ = try await transportWithTimeout { try await api.request("/agents") }

        let request = try XCTUnwrap(TransportMockURLProtocol.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://michi.example.test/root/api/agents")
        XCTAssertEqual(request.headers["Origin"], "https://michi.example.test")
    }

    func testOriginKeepsANonDefaultPortAndOmitsAuthorizationWithoutAToken() async throws {
        TransportMockURLProtocol.install { _ in self.respondJSON("{}") }
        let api = makeAPI(URL(string: "https://michi.example.test:8443")!, token: "  ")
        _ = try await transportWithTimeout { try await api.request("/agents") }

        let request = try XCTUnwrap(TransportMockURLProtocol.requests.first)
        XCTAssertEqual(request.headers["Origin"], "https://michi.example.test:8443")
        XCTAssertNil(request.headers["Authorization"])
    }

    func testPOSTEncodesTheJSONBody() async throws {
        TransportMockURLProtocol.install { _ in self.respondJSON(#"{"ok":true}"#) }
        let api = makeAPI()
        let body: JSONValue = ["text": "hello ☕️", "turnId": "t1", "count": 2, "flag": false, "none": .null]
        let value = try await transportWithTimeout { try await api.request("/chats/n1/steer", method: "post", body: body) }

        XCTAssertTrue(value["ok"].boolValue)
        let request = try XCTUnwrap(TransportMockURLProtocol.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: request.body), body)
    }

    func testNoContentAndEmptyBodiesReturnNull() async throws {
        let api = makeAPI()
        TransportMockURLProtocol.install { _ in .respond(status: 204, headers: [:], chunks: []) }
        let noContent = try await transportWithTimeout { try await api.request("/chats/n1/release", method: "POST") }
        XCTAssertEqual(noContent, .null)

        TransportMockURLProtocol.install { _ in self.respondJSON(" \n") }
        let empty = try await transportWithTimeout { try await api.request("/agents") }
        XCTAssertEqual(empty, .null)
    }

    func testHTTPErrorsPreserveStatusAndMachineCode() async {
        TransportMockURLProtocol.install { _ in
            self.respondJSON(409, #"{"error":"Waiting for the previous response to finish.","code":"turn_active"}"#)
        }
        let api = makeAPI()
        let error = await expectError("turn_active", status: 409) {
            try await api.request("/chats/n1/message", method: "POST", body: ["text": "hi"])
        }
        XCTAssertEqual(error?.message, "Waiting for the previous response to finish.")
        XCTAssertEqual(error?.isTurnActive, true)
        XCTAssertEqual(error?.localizedDescription, "Waiting for the previous response to finish.")
        // A rejected POST is never retried automatically.
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)

        TransportMockURLProtocol.install { _ in self.respondJSON(500, "{}") }
        let fallback = await expectError(nil, status: 500) { try await api.request("/agents") }
        XCTAssertEqual(fallback?.message, "Request failed with HTTP 500.")
        XCTAssertEqual(fallback?.isTurnActive, false)
    }

    func testPlainTextIngressRefusalBecomesTheMessage() async {
        TransportMockURLProtocol.install { _ in
            .respond(status: 403, headers: ["Content-Type": "text/plain"],
                     chunks: [.init("Mobile access is restricted to the tunnel owner.")])
        }
        let api = makeAPI()
        let error = await expectError(nil, status: 403) { try await api.request("/agents") }
        XCTAssertEqual(error?.message, "Mobile access is restricted to the tunnel owner.")
    }

    func testHTMLSignInPagesAreErrors() async {
        let api = makeAPI()
        TransportMockURLProtocol.install { _ in
            .respond(status: 200, headers: ["Content-Type": "text/html; charset=utf-8"],
                     chunks: [.init("<!doctype html><title>Sign in</title>")])
        }
        await expectError(MichiAPIError.Code.htmlResponse, status: 200) { try await api.request("/agents") }

        TransportMockURLProtocol.install { _ in .respond(status: 401, headers: [:], chunks: [.init("\n  <html><body>Login</body></html>")]) }
        await expectError(MichiAPIError.Code.htmlResponse, status: 401) { try await api.request("/agents") }
    }

    func testInvalidJSONIsAnInvalidResponse() async {
        TransportMockURLProtocol.install { _ in self.respondJSON("{not json") }
        let api = makeAPI()
        await expectError(MichiAPIError.Code.invalidResponse, status: 200) { try await api.request("/agents") }
    }

    func testNetworkFailureIsReportedOnceWithoutAStatus() async {
        TransportMockURLProtocol.install { _ in .fail(.networkConnectionLost) }
        let api = makeAPI()
        await expectError(MichiAPIError.Code.network, status: nil) {
            try await api.request("/chats/n1/message", method: "POST", body: ["text": "hi"])
        }
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)
    }

    func testPreDispatchRefusalRequiresNilStatusAndKnownLocalCodes() {
        let local = [
            MichiAPIError.Code.invalidConfiguration,
            MichiAPIError.Code.insecureURL,
            MichiAPIError.Code.invalidPath,
            MichiAPIError.Code.invalidRequest,
            MichiAPIError.Code.gatewayAccessExpired,
        ]
        for code in local {
            XCTAssertTrue(MichiAPIError(statusCode: nil, code: code, message: "local").isPreDispatchRefusal, code)
            XCTAssertFalse(MichiAPIError(statusCode: 400, code: code, message: "http").isPreDispatchRefusal, code)
        }
        for code in [MichiAPIError.Code.network, MichiAPIError.Code.timedOut, MichiAPIError.Code.redirectBlocked,
                     MichiAPIError.Code.htmlResponse, MichiAPIError.Code.invalidResponse, MichiAPIError.Code.streamLimitExceeded] {
            XCTAssertFalse(MichiAPIError(statusCode: nil, code: code, message: "after send").isPreDispatchRefusal, code)
        }
        XCTAssertFalse(MichiAPIError(statusCode: 413, code: nil, message: "too large").isPreDispatchRefusal)
        XCTAssertFalse(MichiAPIError(statusCode: 429, code: "stream_backpressure", message: "busy").isPreDispatchRefusal)
        XCTAssertFalse(MichiAPIError(statusCode: nil, code: nil, message: "unknown").isPreDispatchRefusal)
    }

    func testRequestValidationHappensBeforeAnyNetworkAccess() async {
        TransportMockURLProtocol.install { _ in self.respondJSON("{}") }
        let api = makeAPI()
        await expectError(MichiAPIError.Code.invalidRequest, status: nil) {
            try await api.request("/agents", method: "GET", body: ["x": 1])
        }
        await expectError(MichiAPIError.Code.invalidRequest, status: nil) { try await api.request("/agents", method: "TRACE") }
        XCTAssertTrue(TransportMockURLProtocol.requests.isEmpty)
    }

    // MARK: - Paths

    func testUnsafePathsAreRefused() async {
        TransportMockURLProtocol.install { _ in self.respondJSON("{}") }
        let api = makeAPI()
        let unsafe = [
            "", "agents", "//evil.example.test/steal", "https://evil.example.test/steal", "/", "/a//b", "/agents/",
            "/../admin", "/chats/../../mobile-access", "/chats/./x", "/chats/%2e%2e/x", "/chats/.%2E", "/chats/%2F",
            "/chats/a%5Cb", "/chats/%00", "/a\\b", "/a b", "/agents#fragment", "/agents?q=a b", "/agents?x=1#y",
            "/x%zz", "/x%", "/é", "/api/agents", "/API/agents",
        ]
        for path in unsafe {
            await expectError(MichiAPIError.Code.invalidPath, status: nil) { try await api.request(path) }
        }
        XCTAssertTrue(TransportMockURLProtocol.requests.isEmpty)
    }

    func testPathSegmentsAndQueryValuesAreEncoded() async throws {
        XCTAssertEqual(MichiAPI.pathSegment("node_1-A.b~"), "node_1-A.b~")
        XCTAssertEqual(MichiAPI.pathSegment("a b/c?d#e%f"), "a%20b%2Fc%3Fd%23e%25f")
        XCTAssertEqual(MichiAPI.pathSegment("é😀"), "%C3%A9%F0%9F%98%80")
        XCTAssertEqual(MichiAPI.queryComponent("a b&c=d+e/é"), "a%20b%26c%3Dd%2Be%2F%C3%A9")

        TransportMockURLProtocol.install { _ in self.respondJSON("{}") }
        let api = makeAPI()
        let path = "/chats/\(MichiAPI.pathSegment("ノード 1"))/stream?fromSeq=0&fromTurnId=\(MichiAPI.queryComponent("t&1"))"
        _ = try await transportWithTimeout { try await api.request(path) }
        XCTAssertEqual(TransportMockURLProtocol.requests.first?.url.absoluteString,
                       "https://michi.example.test/api/chats/%E3%83%8E%E3%83%BC%E3%83%89%201/stream?fromSeq=0&fromTurnId=t%261")

        // Identifiers that would navigate are refused rather than sent.
        for id in ["..", ".", "a/b"] {
            await expectError(MichiAPIError.Code.invalidPath, status: nil) {
                try await api.request("/chats/\(MichiAPI.pathSegment(id))/message")
            }
        }
    }

    // MARK: - Server URL policy

    func testPlaintextRemoteServersAndUnsafeURLsAreRefused() async {
        TransportMockURLProtocol.install { _ in self.respondJSON("{}") }
        let insecure = makeAPI(URL(string: "http://michi.example.test")!)
        XCTAssertEqual(insecure.configurationError?.code, MichiAPIError.Code.insecureURL)
        await expectError(MichiAPIError.Code.insecureURL, status: nil) { try await insecure.request("/agents") }
        await expectError(MichiAPIError.Code.insecureURL, status: nil) {
            try await self.collect(insecure.stream("/chats/n1/stream?fromSeq=0&fromTurnId=t1"))
        }

        for url in ["ftp://michi.example.test", "https://user:pass@michi.example.test", "file:///tmp/michi"] {
            let api = makeAPI(URL(string: url)!)
            XCTAssertEqual(api.configurationError?.code, MichiAPIError.Code.invalidConfiguration, url)
        }

        let badToken = makeAPI(token: "secret\r\nX-Injected: 1")
        let error = await expectError(MichiAPIError.Code.invalidConfiguration, status: nil) { try await badToken.request("/agents") }
        XCTAssertFalse(error?.message.contains("secret") ?? true)
        XCTAssertTrue(TransportMockURLProtocol.requests.isEmpty)
    }

    func testLoopbackPlaintextIsDevelopmentOnly() async throws {
        TransportMockURLProtocol.install { _ in self.respondJSON("{}") }
        let cases = [
            ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
            ("http://localhost:3000/", "http://localhost:3000"),
            ("http://[::1]:3000", "http://[::1]:3000"),
        ]
        for (url, origin) in cases {
            let api = makeAPI(URL(string: url)!)
            #if DEBUG
            XCTAssertNil(api.configurationError, url)
            _ = try await transportWithTimeout { try await api.request("/agents") }
            XCTAssertEqual(TransportMockURLProtocol.requests.last?.headers["Origin"], origin)
            #else
            XCTAssertEqual(api.configurationError?.code, MichiAPIError.Code.insecureURL, url)
            #endif
        }
    }

    // MARK: - Redirects

    func testCrossOriginRedirectIsBlockedBeforeTheTokenLeaves() async {
        TransportMockURLProtocol.install { request in
            request.url.host == "michi.example.test"
                ? .redirect(status: 302, location: "https://login.evil.example.test/signin")
                : self.respondJSON(#"{"stolen":true}"#)
        }
        let api = makeAPI()
        await expectError(MichiAPIError.Code.redirectBlocked, status: 302) { try await api.request("/agents") }
        XCTAssertEqual(TransportMockURLProtocol.requests.map(\.url.host), ["michi.example.test"])
    }

    func testRedirectPolicyHoldsWhenTheInjectedSessionFollowsRedirects() async {
        let permissive = makeSession(delegate: TransportFollowingDelegate())
        defer { permissive.invalidateAndCancel() }
        TransportMockURLProtocol.install { request in
            request.url.host == "michi.example.test"
                ? .redirect(status: 307, location: "https://evil.example.test/api/agents")
                : self.respondJSON("{}")
        }
        let api = makeAPI(session: permissive)
        await expectError(MichiAPIError.Code.redirectBlocked, status: 307) { try await api.request("/agents") }
        await expectError(MichiAPIError.Code.redirectBlocked, status: 307) {
            try await self.collect(api.stream("/chats/n1/stream?fromSeq=0&fromTurnId=t1"))
        }
        XCTAssertFalse(TransportMockURLProtocol.requests.contains { $0.url.host == "evil.example.test" })
    }

    func testSameOriginGETRedirectIsFollowedWithIdentityHeaders() async throws {
        TransportMockURLProtocol.install { request in
            request.url.path == "/api/old" ? .redirect(status: 307, location: "/api/new") : self.respondJSON(#"{"moved":true}"#)
        }
        let api = makeAPI()
        let value = try await transportWithTimeout { try await api.request("/old") }

        XCTAssertTrue(value["moved"].boolValue)
        let requests = TransportMockURLProtocol.requests
        XCTAssertEqual(requests.map(\.url.path), ["/api/old", "/api/new"])
        XCTAssertEqual(requests.last?.headers["Authorization"], "Bearer secret-token")
        XCTAssertEqual(requests.last?.headers["Origin"], "https://michi.example.test")
    }

    func testRedirectedPOSTIsNeverResent() async {
        TransportMockURLProtocol.install { request in
            request.url.path == "/api/chats/n1/message" ? .redirect(status: 307, location: "/api/chats/n2/message") : self.respondJSON("{}")
        }
        let api = makeAPI()
        await expectError(MichiAPIError.Code.redirectBlocked, status: 307) {
            try await api.request("/chats/n1/message", method: "POST", body: ["text": "hi"])
        }
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)
    }

    // MARK: - Streams

    func testStreamRequestsUseAnIdleTimeoutAboveTheKeepaliveInterval() throws {
        let api = makeAPI()
        let (request, _) = try api.makeRequest("/chats/n1/stream?fromSeq=0&fromTurnId=t1", method: "GET", body: nil, kind: .eventStream)
        XCTAssertEqual(request.timeoutInterval, MichiAPI.streamIdleTimeout)
        // Backend keepalives arrive every 10-25 s; the idle limit restarts with each byte.
        XCTAssertGreaterThanOrEqual(MichiAPI.streamIdleTimeout, 75)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
    }

    func testStreamDeliversEventsBeforeTheResponseEnds() async throws {
        let gate = DispatchSemaphore(value: 0)
        TransportMockURLProtocol.install { _ in
            .respond(status: 200, headers: self.sseHeaders, chunks: [
                .init(": keepalive\n\nevent: turn_start\ndata: {\"turnId\":\"t1\",\"seq\":0}\n\n"),
                .init("event: chunk\r\ndata: {\"text\":\"h", waitFor: gate),
                .init("i\"}\r\n\r\nevent: future_event\ndata: {\"nested\":[1,true,null]}\n\n"),
                .init("event: done\ndata: {\"stopReason\":\"end_turn\"}\n\n"),
            ])
        }
        let api = makeAPI()
        let recorder = TransportEventRecorder()
        let consumer = Task {
            for try await event in api.stream("/chats/n1/stream?fromSeq=0&fromTurnId=t1") { await recorder.append(event) }
        }
        defer {
            gate.signal()
            consumer.cancel()
        }

        // The first event arrives while the server is still holding the rest back.
        try await transportWaitUntil { await recorder.count == 1 }
        gate.signal()
        try await transportWaitUntil { await recorder.count == 4 }
        try await transportWithTimeout { try await consumer.value }

        let events = await recorder.events
        XCTAssertEqual(events.map(\.event), ["turn_start", "chunk", "future_event", "done"])
        XCTAssertEqual(events[1].data["text"].stringValue, "hi")
        XCTAssertEqual(events[2].data, .object(["nested": .array([.number(1), .bool(true), .null])]))
        let request = try XCTUnwrap(TransportMockURLProtocol.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://michi.example.test/api/chats/n1/stream?fromSeq=0&fromTurnId=t1")
        XCTAssertEqual(request.headers["Accept"], "text/event-stream")
        XCTAssertEqual(request.headers["Origin"], "https://michi.example.test")
        XCTAssertEqual(request.headers["Authorization"], "Bearer secret-token")
    }

    func testPOSTStreamSendsItsBodyOnce() async throws {
        TransportMockURLProtocol.install { _ in
            .respond(status: 200, headers: ["Content-Type": "text/event-stream; charset=utf-8"],
                     chunks: [.init("event: done\ndata: {}\n\n")])
        }
        let api = makeAPI()
        let body: JSONValue = ["text": "hi", "turnId": "t1", "nodeId": "n1"]
        let events = try await collect(api.stream("/chats/n1/message", method: "POST", body: body))

        XCTAssertEqual(events.map(\.event), ["done"])
        let requests = TransportMockURLProtocol.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.method, "POST")
        XCTAssertEqual(requests.first?.headers["Content-Type"], "application/json")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: requests.first?.body ?? Data()), body)
    }

    func testStreamHTTPErrorsPreserveStatusAndCode() async {
        TransportMockURLProtocol.install { _ in
            self.respondJSON(410, #"{"error":"turn replay unavailable","code":"turn_replay_unavailable"}"#)
        }
        let api = makeAPI()
        let error = await expectError("turn_replay_unavailable", status: 410) {
            try await self.collect(api.stream("/chats/n1/stream?fromSeq=4&fromTurnId=t1"))
        }
        XCTAssertEqual(error?.message, "turn replay unavailable")

        TransportMockURLProtocol.install { _ in self.respondJSON(500, #"{"error":"boom"}"#) }
        await expectError(nil, status: 500) {
            try await self.collect(api.stream("/chats/n1/message", method: "POST", body: ["text": "hi"]))
        }
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)
    }

    func testStreamRejectsHTMLAndNonEventStreamBodies() async {
        let api = makeAPI()
        TransportMockURLProtocol.install { _ in
            .respond(status: 200, headers: ["Content-Type": "text/html"], chunks: [.init("<html>Sign in</html>")])
        }
        await expectError(MichiAPIError.Code.htmlResponse, status: 200) { try await self.collect(api.stream("/digests/stream")) }

        TransportMockURLProtocol.install { _ in .respond(status: 200, headers: [:], chunks: [.init("\n<!doctype html><p>Sign in</p>")]) }
        await expectError(MichiAPIError.Code.htmlResponse, status: 200) { try await self.collect(api.stream("/digests/stream")) }

        TransportMockURLProtocol.install { _ in self.respondJSON(#"{"ok":true}"#) }
        await expectError(MichiAPIError.Code.invalidResponse, status: 200) { try await self.collect(api.stream("/digests/stream")) }
    }

    func testStreamEndsAtEOFAndDropsAnUnterminatedEvent() async throws {
        TransportMockURLProtocol.install { _ in
            .respond(status: 200, headers: self.sseHeaders,
                     chunks: [.init("event: chunk\ndata: {\"text\":\"a\"}\n\nevent: chunk\ndata: {\"text\":\"partial\"}")])
        }
        let events = try await collect(makeAPI().stream("/chats/n1/stream?fromSeq=0&fromTurnId=t1"))
        XCTAssertEqual(events, [SSEEvent(event: "chunk", data: ["text": "a"])])
    }

    func testStreamRefusesUnsafePathsWithoutARequest() async {
        TransportMockURLProtocol.install { _ in .respond(status: 200, headers: self.sseHeaders, chunks: []) }
        let api = makeAPI()
        await expectError(MichiAPIError.Code.invalidPath, status: nil) {
            try await self.collect(api.stream("/chats/%2e%2e/stream"))
        }
        XCTAssertTrue(TransportMockURLProtocol.requests.isEmpty)
    }

    func testCancellingAStreamOnlyClosesTheConnection() async throws {
        let held = DispatchSemaphore(value: 0)
        TransportMockURLProtocol.install { _ in
            .respond(status: 200, headers: self.sseHeaders, chunks: [
                .init("event: chunk\ndata: {\"text\":\"a\"}\n\n"),
                .init("event: done\ndata: {}\n\n", waitFor: held),
            ])
        }
        let api = makeAPI()
        let recorder = TransportEventRecorder()
        let consumer = Task {
            for try await event in api.stream("/chats/n1/message", method: "POST", body: ["text": "hi"]) {
                await recorder.append(event)
            }
        }
        try await transportWaitUntil { await recorder.count == 1 }
        consumer.cancel()

        let result = await consumer.result
        if case .failure(let error) = result { XCTAssertTrue(error is CancellationError, "\(error)") }
        // The connection closes; no cancel request is sent and the turn is left running.
        try await transportWaitUntil { TransportMockURLProtocol.stopCount >= 1 }
        XCTAssertEqual(TransportMockURLProtocol.requests.map(\.url.path), ["/api/chats/n1/message"])
        let count = await recorder.count
        XCTAssertEqual(count, 1)
    }
}
