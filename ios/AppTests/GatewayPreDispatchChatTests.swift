import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class GatewayPreDispatchChatTests: XCTestCase {
    func testExpiredGatewayHTTPSendLeavesSubmissionUnstartedAndSendsNoChatRequest() async throws {
        try await assertExpiredSendLeavesUnstarted(multiplexed: false)
    }

    func testExpiredGatewayMultiplexedSendLeavesSubmissionUnstartedAndSendsNoChatRequest() async throws {
        try await assertExpiredSendLeavesUnstarted(multiplexed: true)
    }

    private func assertExpiredSendLeavesUnstarted(multiplexed: Bool) async throws {
        let issued = Date(timeIntervalSince1970: 1_700_000_000)
        let expires = issued.addingTimeInterval(60)
        let clock = ChatTestClock(issued)
        let access = try GatewayAccess(
            endpoint: URL(string: "https://predispatch-\(UUID().uuidString.lowercased()).michi.test")!,
            bearer: "fixture-gateway-bearer",
            expiresAt: expires
        )
        let streamTransport = multiplexed ? MichiStreamTransport() : nil
        let transport = ChatGatewayTransport(access: access, streamTransport: streamTransport) { request, _ in
            if request.path.hasSuffix("/messages") { return .json(["messages": []]) }
            if request.path.hasSuffix("/agent/status") { return .json(["runtime": "pi"]) }
            if request.path.hasSuffix("/ensure-session") {
                clock.set(expires.addingTimeInterval(1))
                return .json(["sessionState": [:]])
            }
            if request.path.hasSuffix("/message") || request.path.hasSuffix("/stream-transport") || request.path.hasSuffix("/stream") {
                return .json(["error": "chat send must not run"], status: 500)
            }
            return .json(["error": "Unexpected request"], status: 404)
        }
        transport.api.now = { clock.date() }
        let chat = ChatController(api: transport.api, graph: appContractGraph(), node: appContractGraph().nodes[0],
                                  recoveryStore: recoveryStore(), windowID: "predispatch-\(UUID().uuidString)")
        defer {
            chat.detach()
            transport.close()
            Task { await streamTransport?.close() }
        }

        await chat.load()
        XCTAssertTrue(chat.loaded)
        chat.draft = "A never-started expired send"
        chat.send()
        await eventually("Expired gateway access must reject the unstarted send") {
            !chat.busy && chat.error != nil && chat.turnID == nil
        }

        XCTAssertEqual(chat.draft, "A never-started expired send")
        XCTAssertFalse(chat.busy)
        XCTAssertNil(chat.turnID)
        XCTAssertNil(chat.pendingSubmission)
        XCTAssertFalse(chat.messages.contains { $0.id.hasPrefix("pending-") })
        XCTAssertNotEqual(chat.statusText, "Response status unknown")
        XCTAssertTrue(chat.error?.localizedCaseInsensitiveContains("expired") == true)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/message") }.count, 0)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/stream") }.count, 0)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/stream-transport") }.count, 0)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/ensure-session") }.count, 1)
    }

    private func recoveryStore() -> NativeComposerRecoveryStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("MichiGatewayChat-" + UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return NativeComposerRecoveryStore(directory: directory)
    }

    private func eventually(_ message: String, timeout: TimeInterval = 8, condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), message, file: file, line: line)
    }
}

private final class ChatTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Date
    init(_ stored: Date) { self.stored = stored }
    func date() -> Date { lock.lock(); defer { lock.unlock() }; return stored }
    func set(_ stored: Date) { lock.lock(); self.stored = stored; lock.unlock() }
}

private final class ChatGatewayTransport: @unchecked Sendable {
    typealias Handler = (AppContractRequest, [AppContractRequest]) -> AppContractResponse
    private let lock = NSRecursiveLock()
    private var captured: [AppContractRequest] = []
    private let handler: Handler
    let baseURL: URL
    let session: URLSession
    let api: MichiAPI

    init(access: GatewayAccess, streamTransport: MichiStreamTransport?, handler: @escaping Handler) {
        self.handler = handler
        baseURL = URL(string: access.origin)!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatGatewayURLProtocol.self]
        config.urlCache = nil
        config.timeoutIntervalForRequest = 3
        session = URLSession(configuration: config)
        api = MichiAPI(baseURL: baseURL, session: session, streamTransport: streamTransport, gatewayAccess: access)
        ChatGatewayURLProtocol.register(self)
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
        ChatGatewayURLProtocol.unregister(host: baseURL.host!)
    }
}

private final class ChatGatewayURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var transports: [String: ChatGatewayTransport] = [:]

    static func register(_ transport: ChatGatewayTransport) {
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
        switch response {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code)); return
        case .json(let value, let code):
            status = code; contentType = "application/json"
            bytes = (try? JSONEncoder().encode(value)) ?? Data()
        case .delayedJSON(let value, let code, _):
            status = code; contentType = "application/json"
            bytes = (try? JSONEncoder().encode(value)) ?? Data()
        case .events(let events, _):
            status = 200; contentType = "text/event-stream"
            bytes = events.reduce(into: Data()) { result, event in
                guard let encoded = try? JSONEncoder().encode(event.1), let json = String(data: encoded, encoding: .utf8) else { return }
                result.append(Data("event: \(event.0)\ndata: \(json)\n\n".utf8))
            }
        }
        let http = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": contentType])!
        stateLock.lock(); let cancelled = stopped; stateLock.unlock()
        guard !cancelled else { return }
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
}
