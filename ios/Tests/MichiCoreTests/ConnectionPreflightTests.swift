import XCTest
@testable import MichiCore

/// In-process GET fixture. Nothing leaves this process.
final class ConnectionPreflightURLProtocol: URLProtocol {
    struct Recorded: Equatable {
        let method: String
        let path: String
        let query: String
        let authorization: String?
        let url: String
    }

    enum Reply {
        case json(JSONValue, status: Int = 200)
        case html(String, status: Int = 200, contentType: String = "text/html; charset=utf-8")
        case text(String, status: Int)
        case redirect(location: String, status: Int = 302)
        case fail(URLError.Code)
        case hang
    }

    private static let lock = NSLock()
    private static var handler: ((Recorded) -> Reply)?
    private static var recorded: [Recorded] = []

    static func install(_ handler: @escaping (Recorded) -> Reply) {
        lock.lock()
        defer { lock.unlock() }
        self.handler = handler
        recorded = []
    }

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        handler = nil
        recorded = []
    }

    static var requests: [Recorded] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url ?? URL(string: "about:blank")!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let entry = Recorded(
            method: request.httpMethod ?? "GET",
            path: url.path,
            query: components?.percentEncodedQuery ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            url: url.absoluteString
        )
        Self.lock.lock()
        Self.recorded.append(entry)
        let handler = Self.handler
        Self.lock.unlock()

        switch handler?(entry) ?? .fail(.unsupportedURL) {
        case .hang:
            return
        case .fail(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .redirect(let location, let status):
            let target = URL(string: location, relativeTo: url)!.absoluteURL
            let response = HTTPURLResponse(
                url: url, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Location": target.absoluteString]
            )!
            var next = URLRequest(url: target)
            next.httpMethod = entry.method
            next.allHTTPHeaderFields = request.allHTTPHeaderFields
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
        case .json(let value, let status):
            let body = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
            finish(status: status, headers: ["Content-Type": "application/json"], body: body)
        case .html(let text, let status, let contentType):
            finish(status: status, headers: ["Content-Type": contentType], body: Data(text.utf8))
        case .text(let text, let status):
            finish(status: status, headers: ["Content-Type": "text/plain"], body: Data(text.utf8))
        }
    }

    override func stopLoading() {}

    private func finish(status: Int, headers: [String: String], body: Data) {
        let url = request.url ?? URL(string: "about:blank")!
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class ConnectionPreflightTests: XCTestCase {
    private let base = URL(string: "https://michi.example.test")!
    private let token = "secret-token-xyz"
    private let leakNeedles = [
        "secret-token-xyz",
        "michi.example.test",
        "login.evil.example",
        "next=/api/health?token=",
        "<html",
        "<!doctype",
        "SSO",
        "CorpIdP",
        "sign in and try again",
        "LEAKED-BODY",
        "authorization=Bearer",
    ]
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        ConnectionPreflightURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConnectionPreflightURLProtocol.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        ConnectionPreflightURLProtocol.reset()
        super.tearDown()
    }

    func testSuccessfulPreflightUsesGetOnlyProbesAndKeepsCapabilities() async throws {
        let stages = StageRecorder()
        ConnectionPreflightURLProtocol.install { request in
            switch request.path {
            case "/api/health":
                return .json(["service": "michi-backend"])
            case "/api/persistence/capabilities":
                return .json(Self.capabilities)
            case "/api/workspaces/all":
                XCTAssertEqual(request.query, "meta=1")
                return .json(["workspaces": [["id": "ws-1"]]])
            default:
                return .text("unexpected", status: 404)
            }
        }

        let result = try await runPreflight { await stages.append($0) }
        guard case .success(let success) = result else {
            return XCTFail("Expected success, got \(result)")
        }

        let recordedStages = await stages.snapshot()
        XCTAssertEqual(recordedStages, [.identity, .capabilities, .workspaces])
        XCTAssertEqual(success.capabilities, Self.capabilities)
        XCTAssertEqual(success.workspaces["workspaces"].arrayValue.first?.id, "ws-1")
        try await MichiStreamTransport().configure(capabilities: success.capabilities)
        XCTAssertEqual(try MichiStreamTransport.supportsWebSocket(success.capabilities), false)

        let requests = ConnectionPreflightURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["GET", "GET", "GET"])
        XCTAssertEqual(requests.map(\.path), [
            "/api/health",
            "/api/persistence/capabilities",
            "/api/workspaces/all",
        ])
        XCTAssertEqual(requests.map(\.query), ["", "", "meta=1"])
        XCTAssertEqual(requests.map(\.authorization), [nil, "Bearer secret-token-xyz", "Bearer secret-token-xyz"])
    }

    func testDirectBearerIdentitySendsAuthorizationOnFirstHealthOnlyForThatOrigin() async throws {
        ConnectionPreflightURLProtocol.install { request in
            switch request.path {
            case "/api/health":
                return .json(["service": "michi-backend"])
            case "/api/persistence/capabilities":
                return .json(Self.capabilities)
            case "/api/workspaces/all":
                return .json(["workspaces": []])
            default:
                return .text("unexpected", status: 404)
            }
        }

        let identity = MichiAPI(baseURL: base, bearerToken: token, session: session)
        let authenticated = MichiAPI(baseURL: base, bearerToken: token, session: session)
        let result = try await withTimeout {
            await ConnectionPreflight.run(identity: identity, authenticated: authenticated)
        }
        guard case .success = result else {
            return XCTFail("Expected success, got \(result)")
        }
        let requests = ConnectionPreflightURLProtocol.requests
        XCTAssertEqual(requests.map(\.method), ["GET", "GET", "GET"])
        XCTAssertEqual(requests.map(\.path), [
            "/api/health",
            "/api/persistence/capabilities",
            "/api/workspaces/all",
        ])
        XCTAssertEqual(requests.map(\.authorization), [
            "Bearer secret-token-xyz",
            "Bearer secret-token-xyz",
            "Bearer secret-token-xyz",
        ])
        XCTAssertTrue(requests.allSatisfy { $0.url.hasPrefix("https://michi.example.test/") })
    }

    func testCancelledIdentityDoesNotRequestLaterStagesOrReplayWrites() async throws {
        ConnectionPreflightURLProtocol.install { _ in .hang }
        let identity = MichiAPI(baseURL: base, bearerToken: token, session: session)
        let authenticated = MichiAPI(baseURL: base, bearerToken: token, session: session)
        let task = Task {
            await ConnectionPreflight.run(identity: identity, authenticated: authenticated)
        }
        try await Task.sleep(nanoseconds: 80_000_000)
        task.cancel()
        let result = await task.value
        assertFailure(result, stage: .identity, kind: .unavailable)
        XCTAssertTrue(ConnectionPreflightURLProtocol.requests.allSatisfy { $0.path == "/api/health" && $0.method == "GET" })
        XCTAssertFalse(ConnectionPreflightURLProtocol.requests.contains { $0.url.contains("login.evil.example") })
    }

    func testDirectBearerIdentityStillBlocksCrossOriginRedirects() async throws {
        ConnectionPreflightURLProtocol.install { request in
            request.path == "/api/health"
                ? .redirect(location: "https://login.evil.example/sso?next=/api/health?token=secret-token-xyz")
                : .json(["stolen": true])
        }
        let identity = MichiAPI(baseURL: base, bearerToken: token, session: session)
        let authenticated = MichiAPI(baseURL: base, bearerToken: token, session: session)
        let result = try await withTimeout {
            await ConnectionPreflight.run(identity: identity, authenticated: authenticated)
        }
        assertFailure(result, stage: .identity, kind: .webPageOrBlockedRedirect)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), ["/api/health"])
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.first?.authorization, "Bearer secret-token-xyz")
        XCTAssertFalse(ConnectionPreflightURLProtocol.requests.contains { $0.url.contains("login.evil.example") })
        if case .failure(let failure) = result {
            assertClean(failure.message)
        }
    }

    func testIdentityFailureDoesNotRequestLaterStages() async throws {
        ConnectionPreflightURLProtocol.install { _ in
            .html("<!doctype html><title>Sign in</title><a href=\"https://login.evil.example/sso?next=/api/health?token=secret-token-xyz\">login</a>")
        }

        let result = try await runPreflight()
        assertFailure(result, stage: .identity, kind: .webPageOrBlockedRedirect)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), ["/api/health"])
        XCTAssertNil(ConnectionPreflightURLProtocol.requests.first?.authorization)
    }

    func testCapabilitiesFailureDoesNotRequestWorkspaces() async throws {
        ConnectionPreflightURLProtocol.install { request in
            if request.path == "/api/health" { return .json(["service": "michi-backend"]) }
            return .json(["error": "LEAKED-BODY token=secret-token-xyz"], status: 401)
        }

        let result = try await runPreflight()
        assertFailure(result, stage: .capabilities, kind: .unauthorized)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), [
            "/api/health",
            "/api/persistence/capabilities",
        ])
    }

    func testRefusesIncorrectServiceIdentity() async throws {
        ConnectionPreflightURLProtocol.install { _ in .json(["service": "other-backend"]) }
        let result = try await runPreflight()
        assertFailure(result, stage: .identity, kind: .unavailable)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), ["/api/health"])
        if case .failure(let failure) = result {
            XCTAssertTrue(failure.message.contains("Michi backend"))
        }
    }

    func testRefusesIncorrectCapabilitiesShape() async throws {
        ConnectionPreflightURLProtocol.install { request in
            request.path == "/api/health"
                ? .json(["service": "michi-backend"])
                : .json(["items": ["explicitCommands"]])
        }
        let result = try await runPreflight()
        assertFailure(result, stage: .capabilities, kind: .outdatedBackend)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), [
            "/api/health",
            "/api/persistence/capabilities",
        ])
    }

    func testRefusesMissingCapabilityFlagsAsOutdated() async throws {
        ConnectionPreflightURLProtocol.install { request in
            request.path == "/api/health"
                ? .json(["service": "michi-backend"])
                : .json(["protocolVersion": 2, "explicitCommands": false])
        }
        let result = try await runPreflight()
        assertFailure(result, stage: .capabilities, kind: .outdatedBackend)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), [
            "/api/health",
            "/api/persistence/capabilities",
        ])
    }

    func testInvalidStreamProtocolStopsAtCapabilitiesBeforeWorkspaceHydration() async throws {
        for protocolVersion in [JSONValue.null, 0, -1, "invalid"] {
            var capabilities = Self.capabilities
            capabilities["protocolVersion"] = protocolVersion
            ConnectionPreflightURLProtocol.install { request in
                request.path == "/api/health"
                    ? .json(["service": "michi-backend"])
                    : .json(capabilities)
            }
            assertFailure(try await runPreflight(), stage: .capabilities, kind: .outdatedBackend)
            XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), [
                "/api/health", "/api/persistence/capabilities",
            ])
        }
    }

    func testRefusesIncorrectWorkspaceShape() async throws {
        ConnectionPreflightURLProtocol.install { request in
            switch request.path {
            case "/api/health": return .json(["service": "michi-backend"])
            case "/api/persistence/capabilities": return .json(Self.capabilities)
            default: return .json(["workspace": ["id": "ws-1"]])
            }
        }
        let result = try await runPreflight()
        assertFailure(result, stage: .workspaces, kind: .unavailable)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), [
            "/api/health",
            "/api/persistence/capabilities",
            "/api/workspaces/all",
        ])
    }

    func testHTMLAndBlockedRedirectAreNotConfirmedSSO() async throws {
        ConnectionPreflightURLProtocol.install { _ in
            .html("<html><title>Corporate portal</title></html>", status: 200)
        }
        let html = try await runPreflight()
        assertFailure(html, stage: .identity, kind: .webPageOrBlockedRedirect)
        if case .failure(let failure) = html {
            XCTAssertFalse(failure.message.localizedCaseInsensitiveContains("SSO"))
            XCTAssertTrue(failure.message.localizedCaseInsensitiveContains("browser"))
            XCTAssertTrue(failure.message.localizedCaseInsensitiveContains("not transfer"))
        }

        ConnectionPreflightURLProtocol.install { request in
            request.path == "/api/health"
                ? .redirect(location: "https://login.evil.example/sso?next=/api/health?token=secret-token-xyz")
                : .json(["stolen": true])
        }
        let redirect = try await runPreflight()
        assertFailure(redirect, stage: .identity, kind: .webPageOrBlockedRedirect)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), ["/api/health"])
        XCTAssertFalse(ConnectionPreflightURLProtocol.requests.contains { $0.url.contains("login.evil.example") })
        if case .failure(let failure) = redirect {
            XCTAssertFalse(failure.message.localizedCaseInsensitiveContains("SSO"))
            XCTAssertFalse(failure.message.contains("try again"))
        }
    }

    func testUnauthorizedAndForbiddenClassification() async throws {
        ConnectionPreflightURLProtocol.install { request in
            request.path == "/api/health"
                ? .json(["service": "michi-backend"])
                : .json(["error": "LEAKED-BODY"], status: 401)
        }
        assertFailure(try await runPreflight(), stage: .capabilities, kind: .unauthorized)

        ConnectionPreflightURLProtocol.install { request in
            request.path == "/api/health"
                ? .json(["service": "michi-backend"])
                : .text("Mobile access is restricted to the tunnel owner. LEAKED-BODY", status: 403)
        }
        assertFailure(try await runPreflight(), stage: .capabilities, kind: .forbidden)
    }

    func testExpiredPreparedGatewayStopsAtIdentityWithZeroDispatch() async throws {
        ConnectionPreflightURLProtocol.install { _ in .json(["service": "michi-backend"]) }
        let access = try GatewayAccess(endpoint: base, bearer: "fixture-gateway-bearer", expiresAt: Date().addingTimeInterval(-30))
        let identity = MichiAPI(baseURL: base, session: session, gatewayAccess: access)
        let authenticated = MichiAPI(baseURL: base, session: session, gatewayAccess: access)
        let result = try await withTimeout {
            await ConnectionPreflight.run(identity: identity, authenticated: authenticated)
        }
        assertFailure(result, stage: .identity, kind: .gatewayAccessExpired)
        XCTAssertTrue(ConnectionPreflightURLProtocol.requests.isEmpty)
        if case .failure(let failure) = result {
            XCTAssertFalse(failure.message.localizedCaseInsensitiveContains("network"))
            XCTAssertFalse(failure.message.localizedCaseInsensitiveContains("sign in"))
            XCTAssertFalse(failure.message.localizedCaseInsensitiveContains("log in"))
            XCTAssertFalse(failure.message.localizedCaseInsensitiveContains("button"))
            XCTAssertTrue(failure.message.localizedCaseInsensitiveContains("expired"))
            XCTAssertTrue(failure.message.localizedCaseInsensitiveContains("renew"))
            XCTAssertFalse(failure.message.contains("fixture-gateway-bearer"))
            assertClean(failure.message)
        }
    }

    func testInvalidGatewayConfigurationIsDistinctFromUnavailable() async throws {
        ConnectionPreflightURLProtocol.install { _ in .json(["service": "michi-backend"]) }
        let access = try GatewayAccess(endpoint: base, bearer: "fixture-gateway-bearer", expiresAt: Date().addingTimeInterval(60))
        let identity = MichiAPI(baseURL: base, bearerToken: "secret-token-xyz", session: session, gatewayAccess: access)
        let authenticated = MichiAPI(baseURL: base, session: session, gatewayAccess: access)
        let result = try await withTimeout {
            await ConnectionPreflight.run(identity: identity, authenticated: authenticated)
        }
        assertFailure(result, stage: .identity, kind: .invalidConfiguration)
        XCTAssertTrue(ConnectionPreflightURLProtocol.requests.isEmpty)
        if case .failure(let failure) = result {
            XCTAssertFalse(failure.message.localizedCaseInsensitiveContains("network"))
            XCTAssertTrue(failure.message.localizedCaseInsensitiveContains("configuration"))
            assertClean(failure.message)
        }
    }

    func testUnavailableNetworkTLSAndServerErrors() async throws {
        ConnectionPreflightURLProtocol.install { _ in .fail(.serverCertificateUntrusted) }
        assertFailure(try await runPreflight(), stage: .identity, kind: .unavailable)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), ["/api/health"])

        ConnectionPreflightURLProtocol.install { _ in .fail(.cannotFindHost) }
        assertFailure(try await runPreflight(), stage: .identity, kind: .unavailable)

        ConnectionPreflightURLProtocol.install { request in
            request.path == "/api/health"
                ? .json(["service": "michi-backend"])
                : .json(["error": "LEAKED-BODY"], status: 503)
        }
        assertFailure(try await runPreflight(), stage: .capabilities, kind: .unavailable)
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), [
            "/api/health",
            "/api/persistence/capabilities",
        ])
    }

    func testSameOriginGetRedirectIsNotClassifiedAsALoginPage() async throws {
        ConnectionPreflightURLProtocol.install { request in
            switch request.path {
            case "/api/health":
                return .redirect(location: "/api/health-current")
            case "/api/health-current":
                return .json(["service": "michi-backend"])
            case "/api/persistence/capabilities":
                return .json(Self.capabilities)
            case "/api/workspaces/all":
                return .json(["workspaces": []])
            default:
                return .text("unexpected", status: 404)
            }
        }

        let result = try await runPreflight()
        guard case .success = result else {
            return XCTFail("Same-origin GET redirect should succeed, got \(result)")
        }
        XCTAssertEqual(ConnectionPreflightURLProtocol.requests.map(\.path), [
            "/api/health",
            "/api/health-current",
            "/api/persistence/capabilities",
            "/api/workspaces/all",
        ])
    }

    func testDiagnosticsOmitCredentialsURLsQueryTokensAndBodies() async throws {
        let cases: [(ConnectionPreflightURLProtocol.Reply, ConnectionPreflight.FailureKind)] = [
            (.html("<!doctype html><form action=\"https://login.evil.example/sso?next=/api/health?token=secret-token-xyz\">LEAKED-BODY CorpIdP</form>"), .webPageOrBlockedRedirect),
            (.redirect(location: "https://login.evil.example/sso?next=/api/health?token=secret-token-xyz&authorization=Bearer%20secret-token-xyz"), .webPageOrBlockedRedirect),
            (.json(["error": "LEAKED-BODY token=secret-token-xyz"], status: 401), .unauthorized),
            (.text("Forbidden host michi.example.test LEAKED-BODY", status: 403), .forbidden),
            (.fail(.secureConnectionFailed), .unavailable),
        ]

        for (reply, kind) in cases {
            ConnectionPreflightURLProtocol.install { request in
                if kind == .unauthorized || kind == .forbidden {
                    return request.path == "/api/health" ? .json(["service": "michi-backend"]) : reply
                }
                return reply
            }
            let result = try await runPreflight()
            guard case .failure(let failure) = result else {
                return XCTFail("Expected \(kind) failure")
            }
            XCTAssertEqual(failure.kind, kind)
            assertClean(failure.message)
            XCTAssertFalse(failure.message.contains("http"))
        }
    }

    private static let capabilities: JSONValue = [
        "protocolVersion": 2,
        "authoritativeTurnPersistence": true,
        "explicitCommands": true,
        "digestReadMarkers": "v1",
    ]

    private func runPreflight(
        onStage: ((ConnectionPreflight.Stage) async -> Void)? = nil
    ) async throws -> ConnectionPreflight.Result {
        let identity = MichiAPI(baseURL: base, session: session)
        let authenticated = MichiAPI(baseURL: base, bearerToken: token, session: session)
        return try await withTimeout {
            await ConnectionPreflight.run(identity: identity, authenticated: authenticated, onStage: onStage)
        }
    }

    private func assertFailure(
        _ result: ConnectionPreflight.Result,
        stage: ConnectionPreflight.Stage,
        kind: ConnectionPreflight.FailureKind,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard case .failure(let failure) = result else {
            return XCTFail("Expected \(kind) at \(stage), got \(result)", file: file, line: line)
        }
        XCTAssertEqual(failure.stage, stage, file: file, line: line)
        XCTAssertEqual(failure.kind, kind, file: file, line: line)
        XCTAssertFalse(failure.message.isEmpty, file: file, line: line)
        assertClean(failure.message, file: file, line: line)
    }

    private func assertClean(_ message: String, file: StaticString = #filePath, line: UInt = #line) {
        let haystack = message
        for needle in leakNeedles {
            XCTAssertFalse(
                haystack.localizedCaseInsensitiveContains(needle),
                "Diagnostic leaked \(needle): \(message)",
                file: file, line: line
            )
        }
    }

    private func withTimeout<T: Sendable>(
        _ seconds: Double = 5,
        _ operation: @escaping @Sendable () async -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw ConnectionPreflightTestTimeout()
            }
            defer { group.cancelAll() }
            guard let value = try await group.next() else { throw ConnectionPreflightTestTimeout() }
            return value
        }
    }
}

private struct ConnectionPreflightTestTimeout: Error {}

private actor StageRecorder {
    private var stored: [ConnectionPreflight.Stage] = []
    func append(_ stage: ConnectionPreflight.Stage) { stored.append(stage) }
    func snapshot() -> [ConnectionPreflight.Stage] { stored }
}
