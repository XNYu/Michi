import Foundation
import XCTest
@testable import MichiCore

private actor GatewaySocketFixture: MichiStreamSocket {
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
}

private actor GatewaySocketPool {
    private(set) var upgrades: [URLRequest] = []
    private(set) var sockets: [GatewaySocketFixture] = []
    private(set) var configurations: [URLSessionConfiguration] = []
    func make(_ request: URLRequest, configuration: URLSessionConfiguration? = nil) -> any MichiStreamSocket {
        let socket = GatewaySocketFixture()
        upgrades.append(request); sockets.append(socket)
        if let configuration { configurations.append(configuration) }
        return socket
    }
    func firstUpgrade() -> URLRequest? { upgrades.first }
    func firstSocket() -> GatewaySocketFixture? { sockets.first }
    func firstConfiguration() -> URLSessionConfiguration? { configurations.first }
}

final class GatewayAccessTests: XCTestCase {
    private let originURL = URL(string: "https://michi.example.test")!
    private let jsonHeaders = ["Content-Type": "application/json"]
    private let sseHeaders = ["Content-Type": "text/event-stream"]
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        TransportMockURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TransportMockURLProtocol.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        TransportMockURLProtocol.reset()
        super.tearDown()
    }

    private func futureAccess(origin: URL? = nil, bearer: String = "fixture-gateway-bearer") throws -> GatewayAccess {
        try GatewayAccess(endpoint: origin ?? originURL, bearer: bearer, expiresAt: Date().addingTimeInterval(600))
    }

    private func expiredAccess(origin: URL? = nil) throws -> GatewayAccess {
        try GatewayAccess(endpoint: origin ?? originURL, bearer: "fixture-gateway-bearer", expiresAt: Date().addingTimeInterval(-30))
    }

    private func api(access: GatewayAccess, token: String? = nil, url: URL? = nil) -> MichiAPI {
        MichiAPI(baseURL: url ?? originURL, bearerToken: token, session: session, gatewayAccess: access)
    }

    private func respondJSON(_ body: String, status: Int = 200) -> TransportMockURLProtocol.Reply {
        .respond(status: status, headers: jsonHeaders, chunks: [.init(body)])
    }

    private var ticket: JSONValue { ["token": .string(String(repeating: "a", count: 64))] }

    private func expectCode(_ code: String, _ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            XCTAssertEqual((error as? MichiAPIError)?.code, code, "\(error)", file: file, line: line)
            XCTAssertFalse(String(describing: error).contains("fixture-gateway-bearer"), file: file, line: line)
        }
    }

    @discardableResult
    private func expectRequestError(_ code: String, file: StaticString = #filePath, line: UInt = #line,
                                    _ operation: @escaping @Sendable () async throws -> Void) async -> MichiAPIError? {
        do {
            _ = try await transportWithTimeout(5, operation)
            XCTFail("Expected MichiAPIError \(code)", file: file, line: line)
        } catch let error as MichiAPIError {
            XCTAssertEqual(error.code, code, "\(error)", file: file, line: line)
            XCTAssertFalse(error.message.contains("fixture-gateway-bearer"), file: file, line: line)
            return error
        } catch {
            XCTFail("Unexpected error \(error)", file: file, line: line)
        }
        return nil
    }

    // MARK: - Origin and credential construction

    func testGatewayOriginRejectsHTTPIncludingLoopbackAndUnsafeURLs() {
        let rejected = [
            "http://michi.example.test",
            "http://127.0.0.1",
            "http://localhost:3000",
            "http://[::1]",
            "https://user:pass@michi.example.test",
            "https://michi.example.test/path",
            "https://michi.example.test?q=1",
            "https://michi.example.test#frag",
            "ftp://michi.example.test",
        ]
        for value in rejected {
            expectCode(value.hasPrefix("http://") ? MichiAPIError.Code.insecureURL : MichiAPIError.Code.invalidConfiguration) {
                _ = try GatewayAccess(endpoint: URL(string: value)!, bearer: "fixture-gateway-bearer", expiresAt: Date().addingTimeInterval(60))
            }
        }
    }

    func testGatewayOriginNormalizesHTTPSAndAllowsExplicitPort() throws {
        let access = try GatewayAccess(endpoint: URL(string: "https://Michi.Example.TEST:443/")!,
                                       bearer: "fixture-gateway-bearer", expiresAt: Date().addingTimeInterval(60))
        XCTAssertEqual(access.origin, "https://michi.example.test")
        let ported = try GatewayAccess(endpoint: URL(string: "https://michi.example.test:8443")!,
                                       bearer: "fixture-gateway-bearer", expiresAt: Date().addingTimeInterval(60))
        XCTAssertEqual(ported.origin, "https://michi.example.test:8443")
    }

    func testInvalidHeaderAndEmptyBearerAreRejectedWithoutLeakingValues() {
        expectCode(MichiAPIError.Code.invalidConfiguration) {
            _ = try GatewayAccess(endpoint: self.originURL, bearer: "fixture-gateway-bearer\r\nX-Injected: 1", expiresAt: Date().addingTimeInterval(60))
        }
        expectCode(MichiAPIError.Code.invalidConfiguration) {
            _ = try GatewayAccess(endpoint: self.originURL, bearer: "   ", expiresAt: Date().addingTimeInterval(60))
        }
    }

    func testConflictingDirectAndGatewayCredentialsAreRejectedBeforeDispatch() async {
        TransportMockURLProtocol.install { _ in self.respondJSON("{}") }
        let client = api(access: try! futureAccess(), token: "fixture-direct-bearer")
        XCTAssertEqual(client.configurationError?.code, MichiAPIError.Code.invalidConfiguration)
        XCTAssertFalse(client.configurationError?.message.contains("fixture-") ?? true)
        await expectRequestError(MichiAPIError.Code.invalidConfiguration) {
            _ = try await client.request("/agents")
        }
        XCTAssertThrowsError(try client.makeRequest("/artifacts/ws/download?path=file.txt", method: "GET", body: nil, kind: .json))
        XCTAssertTrue(TransportMockURLProtocol.requests.isEmpty)
        XCTAssertNil(client.identityHeaders(try XCTUnwrap(MichiEndpoint.parse(self.originURL).get()))["Authorization"])
    }

    func testWrongOriginAndExpiredCredentialsDispatchNothing() async {
        TransportMockURLProtocol.install { _ in self.respondJSON("{}") }
        let other = try! futureAccess(origin: URL(string: "https://other.example.test")!)
        let mismatched = api(access: other)
        XCTAssertEqual(mismatched.configurationError?.code, MichiAPIError.Code.invalidConfiguration)
        await expectRequestError(MichiAPIError.Code.invalidConfiguration) { _ = try await mismatched.request("/agents") }
        await expectRequestError(MichiAPIError.Code.invalidConfiguration) {
            for try await _ in mismatched.stream("/chats/n1/stream") {}
        }

        let expired = api(access: try! expiredAccess())
        XCTAssertNil(expired.configurationError)
        await expectRequestError(MichiAPIError.Code.gatewayAccessExpired) { _ = try await expired.request("/agents") }
        await expectRequestError(MichiAPIError.Code.gatewayAccessExpired) {
            for try await _ in expired.stream("/chats/n1/stream") {}
        }
        XCTAssertThrowsError(try expired.makeRequest("/artifacts/ws/download?path=x", method: "GET", body: nil, kind: .json)) { error in
            XCTAssertEqual((error as? MichiAPIError)?.code, MichiAPIError.Code.gatewayAccessExpired)
        }
        XCTAssertTrue(TransportMockURLProtocol.requests.isEmpty)
    }

    // MARK: - Request construction

    func testMakeRequestAppliesGatewayAuthorizationForJSONSSEAndDownload() throws {
        let client = api(access: try futureAccess())
        let json = try client.makeRequest("/agents", method: "GET", body: nil, kind: .json).0
        let sse = try client.makeRequest("/chats/n1/stream", method: "GET", body: nil, kind: .eventStream).0
        let download = try client.makeRequest("/artifacts/ws/download?path=file.txt", method: "GET", body: nil, kind: .json).0
        for request in [json, sse, download] {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-gateway-bearer")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://michi.example.test")
            XCTAssertFalse(request.httpShouldHandleCookies)
            XCTAssertFalse(request.url!.absoluteString.contains("fixture-gateway-bearer"))
            XCTAssertEqual(request.url?.scheme, "https")
            XCTAssertEqual(request.url?.host, "michi.example.test")
        }
        XCTAssertEqual(json.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertEqual(sse.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(download.url?.path, "/api/artifacts/ws/download")
    }

    func testGatewayJSONAndSSEDispatchUseHeaderNotURL() async throws {
        TransportMockURLProtocol.install { request in
            if request.url.path.hasSuffix("/stream") {
                return .respond(status: 200, headers: self.sseHeaders, chunks: [.init("event: done\ndata: {}\n\n")])
            }
            return self.respondJSON(#"{"ok":true}"#)
        }
        let client = api(access: try futureAccess())
        _ = try await transportWithTimeout { try await client.request("/agents") }
        var events: [SSEEvent] = []
        for try await event in client.stream("/chats/n1/stream") { events.append(event) }
        XCTAssertEqual(events.map(\.event), ["done"])
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 2)
        XCTAssertTrue(TransportMockURLProtocol.requests.allSatisfy { $0.headers["Authorization"] == "Bearer fixture-gateway-bearer" })
        XCTAssertTrue(TransportMockURLProtocol.requests.allSatisfy { !$0.url.absoluteString.contains("fixture-gateway-bearer") })
        XCTAssertEqual(TransportMockURLProtocol.requests.map(\.url.path), ["/api/agents", "/api/chats/n1/stream"])
    }

    func testGatewayDownloadUsesSameIdentityHeaders() async throws {
        TransportMockURLProtocol.install { _ in
            .respond(status: 200, headers: ["Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=\"a.bin\""],
                     chunks: [.init("abc")])
        }
        let file = try await transportWithTimeout {
            try await self.api(access: try self.futureAccess()).downloadArtifact(workspaceID: "ws", path: "a.bin")
        }
        defer { file.removeTemporaryFile() }
        let request = try XCTUnwrap(TransportMockURLProtocol.requests.first)
        XCTAssertEqual(request.headers["Authorization"], "Bearer fixture-gateway-bearer")
        XCTAssertEqual(request.headers["Origin"], "https://michi.example.test")
        XCTAssertFalse(request.url.absoluteString.contains("fixture-gateway-bearer"))
    }

    func testDefaultDirectBearerPathsRemainUnchanged() throws {
        let direct = MichiAPI(baseURL: originURL, bearerToken: "fixture-direct-bearer", session: session)
        let request = try direct.makeRequest("/agents", method: "GET", body: nil, kind: .json).0
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-direct-bearer")
        let none = MichiAPI(baseURL: originURL, session: session)
        XCTAssertNil(try none.makeRequest("/agents", method: "GET", body: nil, kind: .json).0.value(forHTTPHeaderField: "Authorization"))
    }

    // MARK: - Redirects

    func testCrossOriginRedirectCannotDiscloseGatewayCredential() async {
        TransportMockURLProtocol.install { request in
            request.url.host == "michi.example.test"
                ? .redirect(status: 302, location: "https://login.evil.example.test/signin")
                : self.respondJSON(#"{"stolen":true}"#)
        }
        let client = api(access: try! futureAccess())
        await expectRequestError(MichiAPIError.Code.redirectBlocked) { _ = try await client.request("/agents") }
        await expectRequestError(MichiAPIError.Code.redirectBlocked) {
            _ = try await client.downloadArtifact(workspaceID: "ws", path: "x")
        }
        XCTAssertEqual(Set(TransportMockURLProtocol.requests.map(\.url.host)), ["michi.example.test"])
        XCTAssertFalse(TransportMockURLProtocol.requests.contains { $0.url.host == "login.evil.example.test" })
    }

    func testSameOriginGETRedirectRechecksExpiryBeforeRestampingAuthorization() async {
        let issued = Date(timeIntervalSince1970: 1_700_000_000)
        let expires = issued.addingTimeInterval(60)
        let clock = TransportTestClock(issued)
        let client = api(access: try! GatewayAccess(endpoint: originURL, bearer: "fixture-gateway-bearer", expiresAt: expires))
        client.now = { clock.date() }
        TransportMockURLProtocol.install { request in
            if request.url.path == "/api/old" {
                clock.set(expires.addingTimeInterval(1))
                return .redirect(status: 302, location: "/api/new")
            }
            return self.respondJSON(#"{"moved":true}"#)
        }
        await expectRequestError(MichiAPIError.Code.gatewayAccessExpired) { _ = try await client.request("/old") }
        XCTAssertEqual(TransportMockURLProtocol.requests.map(\.url.path), ["/api/old"])
        clock.set(issued)
        await expectRequestError(MichiAPIError.Code.gatewayAccessExpired) {
            for try await _ in client.stream("/old") {}
        }
        XCTAssertEqual(TransportMockURLProtocol.requests.map(\.url.path), ["/api/old", "/api/old"])
        XCTAssertFalse(TransportMockURLProtocol.requests.contains { $0.url.path == "/api/new" })
    }

    func testSameOriginGETRedirectKeepsGatewayAuthorization() async throws {
        TransportMockURLProtocol.install { request in
            request.url.path == "/api/old" ? .redirect(status: 307, location: "/api/new") : self.respondJSON(#"{"moved":true}"#)
        }
        let value = try await transportWithTimeout { try await self.api(access: try self.futureAccess()).request("/old") }
        XCTAssertTrue(value["moved"].boolValue)
        XCTAssertEqual(TransportMockURLProtocol.requests.map(\.url.path), ["/api/old", "/api/new"])
        XCTAssertTrue(TransportMockURLProtocol.requests.allSatisfy { $0.headers["Authorization"] == "Bearer fixture-gateway-bearer" })
    }

    // MARK: - WebSocket upgrade

    func testDirectBearerUpgradeRemainsAbsentAndTicketStaysInQuery() throws {
        var target = URLRequest(url: URL(string: "https://michi.test/prefix/api/stream-transport")!)
        target.setValue("Bearer fixture-direct-bearer", forHTTPHeaderField: "Authorization")
        let upgrade = try MichiStreamTransport.upgradeRequest(ticket: ticket, target: target, origin: "https://michi.test")
        XCTAssertEqual(upgrade.url?.scheme, "wss")
        XCTAssertNil(upgrade.value(forHTTPHeaderField: "Authorization"))
        XCTAssertFalse(upgrade.httpShouldHandleCookies)
        XCTAssertEqual(URLComponents(url: upgrade.url!, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "token", value: ticket["token"].stringValue)])
        XCTAssertFalse(upgrade.url!.absoluteString.contains("fixture-direct-bearer"))
    }

    func testGatewayUpgradeAddsAuthorizationAndOnlyStreamTicketInURL() throws {
        var target = URLRequest(url: URL(string: "https://michi.example.test/api/stream-transport")!)
        target.setValue("Bearer fixture-direct-bearer", forHTTPHeaderField: "Authorization")
        let access = try futureAccess()
        let upgrade = try MichiStreamTransport.upgradeRequest(ticket: ticket, target: target, origin: "https://michi.example.test", gatewayAccess: access)
        XCTAssertEqual(upgrade.url?.scheme, "wss")
        XCTAssertEqual(upgrade.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-gateway-bearer")
        XCTAssertEqual(upgrade.value(forHTTPHeaderField: "Origin"), "https://michi.example.test")
        XCTAssertFalse(upgrade.httpShouldHandleCookies)
        XCTAssertEqual(URLComponents(url: upgrade.url!, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "token", value: ticket["token"].stringValue)])
        XCTAssertNotEqual(upgrade.value(forHTTPHeaderField: "Authorization"), "Bearer \(ticket["token"].stringValue)")
        XCTAssertFalse(upgrade.url!.absoluteString.contains("fixture-gateway-bearer"))
        XCTAssertFalse(upgrade.url!.absoluteString.contains("fixture-direct-bearer"))
    }

    func testExpiredOrMisScopedGatewayUpgradeIsNotPrepared() throws {
        var target = URLRequest(url: URL(string: "https://michi.example.test/api/stream-transport")!)
        target.setValue("Bearer fixture-direct-bearer", forHTTPHeaderField: "Authorization")
        expectCode(MichiAPIError.Code.gatewayAccessExpired) {
            _ = try MichiStreamTransport.upgradeRequest(ticket: self.ticket, target: target, origin: "https://michi.example.test", gatewayAccess: try self.expiredAccess())
        }
        expectCode(MichiAPIError.Code.invalidConfiguration) {
            _ = try MichiStreamTransport.upgradeRequest(ticket: self.ticket, target: target, origin: "https://michi.example.test",
                                                        gatewayAccess: try self.futureAccess(origin: URL(string: "https://other.example.test")!))
        }
    }

    func testGatewayConnectPathUpgradeCarriesAuthorizationAndOmitsCredentialFromFrames() async throws {
        let ticketToken = String(repeating: "b", count: 64)
        TransportMockURLProtocol.install { request in
            if request.url.path == "/api/stream-transport" {
                return self.respondJSON("{\"token\":\"\(ticketToken)\"}")
            }
            return self.respondJSON("{\"error\":\"Unexpected request\"}", status: 404)
        }
        let pool = GatewaySocketPool()
        let transport = MichiStreamTransport(socketFactory: { request, configuration, _ in await pool.make(request, configuration: configuration) })
        let client = MichiAPI(baseURL: originURL, session: session, streamTransport: transport, gatewayAccess: try futureAccess())
        defer { Task { await transport.close() } }
        try await transport.configure(capabilities: ["protocolVersion": 2, "streamTransport": "websocket-v1"])
        let reading = Task { () -> [SSEEvent] in
            var events: [SSEEvent] = []
            for try await event in client.stream("/chats/one/stream") { events.append(event) }
            return events
        }
        let deadline = Date().addingTimeInterval(3)
        while await pool.upgrades.isEmpty, Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        let preparedUpgrade = await pool.firstUpgrade()
        let upgrade = try XCTUnwrap(preparedUpgrade)
        XCTAssertEqual(upgrade.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-gateway-bearer")
        XCTAssertFalse(upgrade.httpShouldHandleCookies)
        XCTAssertEqual(upgrade.url?.scheme, "wss")
        XCTAssertEqual(URLComponents(url: upgrade.url!, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "token", value: ticketToken)])
        XCTAssertFalse(upgrade.url!.absoluteString.contains("fixture-gateway-bearer"))
        let preparedSocket = await pool.firstSocket()
        let socket = try XCTUnwrap(preparedSocket)
        while await socket.sent.isEmpty, Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        let frames = await socket.sent
        let id = try XCTUnwrap(frames.first?["id"].optionalString)
        XCTAssertFalse(String(describing: frames).contains("fixture-gateway-bearer"))
        try await socket.push(["type": "headers", "id": .string(id), "status": 200])
        try await socket.push(["type": "data", "id": .string(id), "text": "event: done\ndata: {}\n\n"])
        try await socket.push(["type": "end", "id": .string(id)])
        let events = try await reading.value
        XCTAssertEqual(events.map(\.event), ["done"])
        let ticketRequest = try XCTUnwrap(TransportMockURLProtocol.requests.first { $0.url.path == "/api/stream-transport" })
        XCTAssertEqual(ticketRequest.headers["Authorization"], "Bearer fixture-gateway-bearer")
        XCTAssertNotEqual(ticketRequest.headers["Authorization"], "Bearer \(ticketToken)")
    }

    // MARK: - Identity

    func testFingerprintsSeparateGatewayNoneAndDirectBearer() throws {
        let none = MichiAPI(baseURL: originURL)
        let direct = MichiAPI(baseURL: originURL, bearerToken: "fixture-shared-secret")
        let gateway = MichiAPI(baseURL: originURL, gatewayAccess: try futureAccess(bearer: "fixture-shared-secret"))
        let again = MichiAPI(baseURL: originURL, gatewayAccess: try futureAccess(bearer: "  fixture-shared-secret  "))
        XCTAssertNotEqual(none.credentialIdentityFingerprint, direct.credentialIdentityFingerprint)
        XCTAssertNotEqual(none.credentialIdentityFingerprint, gateway.credentialIdentityFingerprint)
        XCTAssertNotEqual(direct.credentialIdentityFingerprint, gateway.credentialIdentityFingerprint)
        XCTAssertEqual(gateway.credentialIdentityFingerprint, again.credentialIdentityFingerprint)
        XCTAssertFalse(gateway.credentialIdentityFingerprint.contains("fixture-shared-secret"))
        XCTAssertFalse(none.credentialIdentityFingerprint.contains("none"))
    }

    func testGatewayDescriptionsRedactTheCredential() throws {
        let access = try futureAccess()
        XCTAssertFalse(String(describing: access).contains("fixture-gateway-bearer"))
        XCTAssertFalse(String(reflecting: access).contains("fixture-gateway-bearer"))
        XCTAssertTrue(String(describing: access).contains("<redacted>"))
        XCTAssertTrue(access.origin.hasPrefix("https://"))
        var reflected = ""
        dump(access, to: &reflected)
        XCTAssertFalse(reflected.contains("fixture-gateway-bearer"))
        XCTAssertTrue(reflected.contains("<redacted>"))
    }

    // MARK: - Session isolation

    func testGatewayModeIsolatesInjectedConfigurationAndKeepsProtocolClasses() async throws {
        let dirty = URLSessionConfiguration.default
        dirty.httpShouldSetCookies = true
        dirty.httpCookieAcceptPolicy = .always
        dirty.httpCookieStorage = .shared
        dirty.urlCredentialStorage = .shared
        dirty.protocolClasses = [TransportMockURLProtocol.self]
        let injected = URLSession(configuration: dirty)
        defer { injected.invalidateAndCancel() }
        let client = MichiAPI(baseURL: originURL, session: injected, gatewayAccess: try futureAccess())
        XCTAssertFalse(client.session === injected)
        XCTAssertFalse(client.session === URLSession.shared)
        assertIsolated(client.session.configuration)
        XCTAssertTrue(containsProtocol(TransportMockURLProtocol.self, in: client.session.configuration))

        TransportMockURLProtocol.install { _ in self.respondJSON(#"{"ok":true}"#) }
        let value = try await transportWithTimeout { try await client.request("/agents") }
        XCTAssertTrue(value["ok"].boolValue)
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)
        XCTAssertEqual(TransportMockURLProtocol.requests.first?.headers["Authorization"], "Bearer fixture-gateway-bearer")
    }

    func testGatewaySocketCloneIsolatesInjectedConfiguration() async throws {
        let ticketToken = String(repeating: "c", count: 64)
        TransportMockURLProtocol.install { request in
            if request.url.path == "/api/stream-transport" {
                return self.respondJSON("{\"token\":\"\(ticketToken)\"}")
            }
            return self.respondJSON("{\"error\":\"Unexpected request\"}", status: 404)
        }
        let dirty = URLSessionConfiguration.ephemeral
        dirty.httpShouldSetCookies = true
        dirty.httpCookieAcceptPolicy = .always
        dirty.httpCookieStorage = .shared
        dirty.urlCredentialStorage = .shared
        dirty.protocolClasses = [TransportMockURLProtocol.self]
        let injected = URLSession(configuration: dirty)
        defer { injected.invalidateAndCancel() }

        let pool = GatewaySocketPool()
        let transport = MichiStreamTransport(socketFactory: { request, configuration, _ in
            await pool.make(request, configuration: configuration)
        })
        let client = MichiAPI(baseURL: originURL, session: injected, streamTransport: transport, gatewayAccess: try futureAccess())
        defer { Task { await transport.close() } }
        try await transport.configure(capabilities: ["protocolVersion": 2, "streamTransport": "websocket-v1"])
        let reading = Task { () -> [SSEEvent] in
            var events: [SSEEvent] = []
            for try await event in client.stream("/chats/one/stream") { events.append(event) }
            return events
        }
        let deadline = Date().addingTimeInterval(3)
        while await pool.upgrades.isEmpty, Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        let preparedConfiguration = await pool.firstConfiguration()
        let configuration = try XCTUnwrap(preparedConfiguration)
        assertIsolated(configuration)
        XCTAssertTrue(containsProtocol(TransportMockURLProtocol.self, in: configuration))
        XCTAssertFalse(configuration.httpCookieStorage === HTTPCookieStorage.shared)
        XCTAssertFalse(configuration.urlCredentialStorage === URLCredentialStorage.shared)
        let preparedUpgrade = await pool.firstUpgrade()
        let upgrade = try XCTUnwrap(preparedUpgrade)
        XCTAssertFalse(upgrade.httpShouldHandleCookies)
        XCTAssertEqual(upgrade.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-gateway-bearer")
        XCTAssertFalse((upgrade.value(forHTTPHeaderField: "Authorization") ?? "").contains("fixture-direct-bearer"))
        XCTAssertFalse(upgrade.url!.absoluteString.contains("fixture-gateway-bearer"))
        let preparedSocket = await pool.firstSocket()
        let socket = try XCTUnwrap(preparedSocket)
        while await socket.sent.isEmpty, Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        let frames = await socket.sent
        let id = try XCTUnwrap(frames.first?["id"].optionalString)
        try await socket.push(["type": "headers", "id": .string(id), "status": 200])
        try await socket.push(["type": "data", "id": .string(id), "text": "event: done\ndata: {}\n\n"])
        try await socket.push(["type": "end", "id": .string(id)])
        let events = try await reading.value
        XCTAssertEqual(events.map(\.event), ["done"])
    }

    private func assertIsolated(_ configuration: URLSessionConfiguration, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(configuration.httpShouldSetCookies, file: file, line: line)
        XCTAssertEqual(configuration.httpCookieAcceptPolicy, .never, file: file, line: line)
        XCTAssertNil(configuration.httpCookieStorage, file: file, line: line)
        XCTAssertNil(configuration.urlCredentialStorage, file: file, line: line)
    }

    private func containsProtocol(_ type: AnyClass, in configuration: URLSessionConfiguration) -> Bool {
        configuration.protocolClasses?.contains { $0 == type } ?? false
    }
}
