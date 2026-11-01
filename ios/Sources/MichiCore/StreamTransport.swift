import Foundation

/// One multiplexed connection per authenticated MichiAPI instance. Ownership is
/// that instance's opaque UUID, so a replacement client cannot inherit the
/// socket even with the same origin and credentials. A positive capability
/// selects WebSocket; a valid legacy capability selects HTTP SSE. Transport
/// failures never retry an open or resend a POST over another transport.
public actor MichiStreamTransport {
    public struct Limits: Sendable {
        public var maxChannels = 64
        public var maxBodyBytes = 50 * 1024 * 1024
        public var maxFrameBytes = 100 * 1024 * 1024 + 64 * 1024
        public var maxBufferedBytes = 8 * 1024 * 1024
        public var maxEventBytes = 8 * 1024 * 1024
        public var ticketTimeout: TimeInterval = 10
        public var headerTimeout: TimeInterval = 30
        public var idleTimeout: TimeInterval = 90
        public init() {}
    }

    private struct Connection: Sendable {
        let id: UUID
        let socket: any MichiStreamSocket
        let writer: MichiStreamSocketWriter
    }
    private struct Channel {
        let bytes: MichiStreamBytes
        let url: URL
        var connectionID: UUID?
        var status: Int?
        var errorBody = Data()
        var timer: Task<Void, Never>?
    }
    private let limits: Limits
    private let factory: MichiStreamSocketFactory
    private var owner: UUID?
    private var closed = false
    private var capability: Bool?
    private var probing: Task<Bool, Error>?
    private var connecting: Task<Connection, Error>?
    private var connectingID: UUID?
    private var connection: Connection?
    private var receiver: Task<Void, Never>?
    private var channels: [String: Channel] = [:]

    public init(limits: Limits = Limits()) {
        self.limits = limits
        self.factory = { request, configuration, maximum in
            MichiURLSessionStreamSocket(request: request, configuration: configuration, maximum: maximum)
        }
    }

    init(limits: Limits = Limits(), socketFactory: @escaping MichiStreamSocketFactory) {
        self.limits = limits
        self.factory = socketFactory
    }

    /// Seed with the already authenticated boot probe to avoid another request.
    /// A failed or malformed probe must not be converted to a legacy capability.
    public func configure(capabilities: JSONValue) throws {
        capability = try Self.supportsWebSocket(capabilities)
    }

    public static func supportsWebSocket(_ capabilities: JSONValue) throws -> Bool {
        guard case .object = capabilities,
              capabilities["protocolVersion"].intValue > 0 else {
            throw streamFailure("The stream capability response is invalid.")
        }
        return capabilities["streamTransport"].optionalString == "websocket-v1"
    }

    /// Lazy: opening the returned sequence does not send anything until next().
    public nonisolated func stream(api: MichiAPI, path: String, method: String = "GET", body: JSONValue? = nil) -> AsyncThrowingStream<SSEEvent, Error> {
        let pump = MichiMultiplexedEventPump(transport: self, api: api, path: path, method: method, body: body, limits: limits)
        return AsyncThrowingStream(unfolding: { try await pump.next() })
    }

    /// Cancels only subscribers and the shared connection, never a durable turn.
    public func close() async {
        guard !closed else { return }
        closed = true
        probing?.cancel(); probing = nil
        connecting?.cancel(); connecting = nil; connectingID = nil
        receiver?.cancel(); receiver = nil
        let previous = connection; connection = nil
        let pending = channels; channels.removeAll()
        for channel in pending.values {
            channel.timer?.cancel()
            await channel.bytes.finish(streamFailure("The stream transport closed."))
        }
        if let previous { await previous.socket.close() }
    }

    fileprivate enum Source: Sendable {
        case http(MichiEventStreamPump)
        case websocket(MichiStreamBytes)
    }

    fileprivate func open(api: MichiAPI, id: String, path: String, method: String, body: JSONValue?) async throws -> Source {
        try Task.checkCancellation()
        guard !closed else { throw streamFailure("The stream transport closed.") }
        if let owner, owner != api.instanceID { throw streamFailure("A stream transport cannot be shared between API identities.") }
        owner = api.instanceID
        let (request, _) = try api.makeRequest(path, method: method, body: body, kind: .eventStream)
        let method = request.httpMethod ?? "GET"
        // Routes outside the backend's stream allowlist retain their HTTP path.
        guard Self.supports(path: path, method: method) else {
            return .http(MichiEventStreamPump(api: api, path: path, method: method, body: body))
        }
        if let data = request.httpBody, data.count > limits.maxBodyBytes {
            throw MichiAPIError(statusCode: 413, code: nil, message: "The stream request is too large.")
        }
        guard try await negotiate(api: api) else {
            try Task.checkCancellation()
            return .http(MichiEventStreamPump(api: api, path: path, method: method, body: body))
        }
        try Task.checkCancellation()
        guard !closed else { throw streamFailure("The stream transport closed.") }
        guard channels.count < limits.maxChannels else {
            throw MichiAPIError(statusCode: 429, code: nil, message: "Too many open stream subscribers.")
        }
        let bytes = MichiStreamBytes(maximum: limits.maxBufferedBytes)
        channels[id] = Channel(bytes: bytes, url: request.url!)
        do {
            let connected = try await connect(api: api)
            try Task.checkCancellation()
            guard channels[id] != nil, connection?.id == connected.id else { throw CancellationError() }
            channels[id]?.connectionID = connected.id
            armTimer(id: id, seconds: limits.headerTimeout)
            var envelope: JSONValue = ["type": "open", "id": .string(id), "path": .string("/api" + path), "method": .string(method)]
            if let body = request.httpBody { envelope["body"] = .string(String(decoding: body, as: UTF8.self)) }
            let text = try Self.encode(envelope, maximum: limits.maxFrameBytes)
            // Once send is attempted its outcome may be unknown. Never fall back
            // to HTTP or allocate a replacement turn from this catch path.
            do { try await connected.writer.send(text) }
            catch {
                if ![413, 429].contains((error as? MichiAPIError)?.statusCode ?? -1) {
                    await connectionFailed(connected.id, error: MichiAPI.transportError(error))
                }
                throw error
            }
            return .websocket(bytes)
        } catch {
            await finish(id: id, error: error, detach: true)
            throw error
        }
    }

    private func negotiate(api: MichiAPI) async throws -> Bool {
        if let capability { return capability }
        let task: Task<Bool, Error>
        if let probing { task = probing }
        else {
            let timeout = limits.ticketTimeout
            task = Task {
                try await withThrowingTaskGroup(of: Bool.self) { group in
                    group.addTask { try Self.supportsWebSocket(try await api.request("/persistence/capabilities")) }
                    group.addTask {
                        try await Task.sleep(for: .seconds(max(0.01, timeout)))
                        throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.timedOut, message: "The stream capability request timed out.")
                    }
                    defer { group.cancelAll() }
                    return try await group.next()!
                }
            }
            probing = task
        }
        do {
            let result = try await task.value
            capability = result; probing = nil
            return result
        } catch {
            probing = nil // A later subscriber may retry the probe, not the POST.
            throw error
        }
    }

    private func connect(api: MichiAPI) async throws -> Connection {
        if let connection { return connection }
        let task: Task<Connection, Error>
        let attemptID: UUID
        if let existing = connecting, let id = connectingID { task = existing; attemptID = id }
        else {
            let id = UUID(), factory = factory, limits = limits
            attemptID = id
            task = Task {
                let ticket = try await withThrowingTaskGroup(of: JSONValue.self) { group in
                    group.addTask { try await api.request("/stream-transport", method: "POST") }
                    group.addTask {
                        try await Task.sleep(for: .seconds(max(0.01, limits.ticketTimeout)))
                        throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.timedOut, message: "The stream ticket request timed out.")
                    }
                    defer { group.cancelAll() }
                    return try await group.next()!
                }
                try Task.checkCancellation()
                let (target, endpoint) = try api.makeRequest("/stream-transport", method: "GET", body: nil, kind: .json)
                let upgrade = try Self.upgradeRequest(ticket: ticket, target: target, origin: endpoint.origin, gatewayAccess: api.gatewayAccess)
                let socket = try await factory(upgrade, MichiIsolatedSession.configuration(copying: api.session.configuration), limits.maxFrameBytes)
                if Task.isCancelled { await socket.close(); throw CancellationError() }
                return Connection(id: id, socket: socket, writer: MichiStreamSocketWriter(socket: socket, maximum: limits.maxBufferedBytes))
            }
            connecting = task; connectingID = id
        }
        do {
            let connected = try await task.value
            if closed { await connected.socket.close(); throw CancellationError() }
            if connection?.id == connected.id { return connected }
            guard connectingID == attemptID else { await connected.socket.close(); throw CancellationError() }
            connecting = nil; connectingID = nil; connection = connected
            receiver = Task { [weak self] in
                do {
                    while !Task.isCancelled {
                        let text = try await connected.socket.receive()
                        guard let self else { return }
                        try await self.receive(text, connectionID: connected.id)
                    }
                } catch {
                    await self?.connectionFailed(connected.id, error: MichiAPI.transportError(error))
                }
            }
            return connected
        } catch {
            if connectingID == attemptID { connecting = nil; connectingID = nil }
            throw error
        }
    }

    fileprivate func cancel(id: String) async { await finish(id: id, error: CancellationError(), detach: true) }

    private func finish(id: String, error: Error?, detach: Bool) async {
        guard let channel = channels.removeValue(forKey: id) else { return }
        channel.timer?.cancel()
        await channel.bytes.finish(error)
        if detach, let current = connection, channel.connectionID == current.id {
            let envelope: JSONValue = ["type": "cancel", "id": .string(id)]
            if let text = try? Self.encode(envelope, maximum: limits.maxFrameBytes) {
                do { try await current.writer.send(text) }
                catch { await connectionFailed(current.id, error: MichiAPI.transportError(error)) }
            }
        }
    }

    private func connectionFailed(_ id: UUID, error: Error) async {
        guard let previous = connection, previous.id == id else { return }
        connection = nil; receiver?.cancel(); receiver = nil
        let affected = channels.filter { $0.value.connectionID == id }.map(\.key)
        for channelID in affected { await finish(id: channelID, error: error, detach: false) }
        await previous.socket.close()
    }

    private func armTimer(id: String, seconds: TimeInterval) {
        channels[id]?.timer?.cancel()
        channels[id]?.timer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0.01, seconds))) } catch { return }
            await self?.finish(id: id, error: MichiAPIError(statusCode: nil, code: MichiAPIError.Code.timedOut,
                message: "The stream stopped responding. Reconnect using its saved turn cursor."), detach: true)
        }
    }

    private func receive(_ text: String, connectionID: UUID) async throws {
        guard connection?.id == connectionID else { return }
        let frame = try MichiStreamFrame.parse(text, maximum: limits.maxFrameBytes)
        guard let current = channels[frame.id], current.connectionID == connectionID else { return }
        switch frame {
        case .headers(let id, let status):
            guard current.status == nil else { throw streamFailure("Duplicate stream headers.") }
            channels[id]?.status = status
            armTimer(id: id, seconds: limits.idleTimeout)
        case .data(let id, let text):
            guard let status = current.status else { throw streamFailure("Stream data arrived before its headers.") }
            armTimer(id: id, seconds: limits.idleTimeout)
            let data = Data(text.utf8)
            if (200..<300).contains(status) {
                do { try await current.bytes.push(data) }
                catch { await finish(id: id, error: error, detach: true) }
            } else {
                let room = max(0, MichiAPI.maxErrorBodyBytes - current.errorBody.count)
                channels[id]?.errorBody.append(contentsOf: data.prefix(room))
                if data.count > room {
                    let response = HTTPURLResponse(url: current.url, statusCode: status, httpVersion: nil, headerFields: [:])!
                    let error = MichiAPI.httpError(response, body: channels[id]?.errorBody ?? Data())
                    await finish(id: id, error: error, detach: true)
                }
            }
        case .end(let id):
            guard let status = current.status else { throw streamFailure("Stream ended before its headers.") }
            var error: Error?
            if !(200..<300).contains(status) {
                let response = HTTPURLResponse(url: current.url, statusCode: status, httpVersion: nil, headerFields: [:])!
                error = MichiAPI.httpError(response, body: current.errorBody)
            }
            await finish(id: id, error: error, detach: false)
        case .error(let id, let message):
            await finish(id: id, error: streamFailure(String(message.prefix(1024))), detach: false)
        }
    }

    static func encode(_ frame: JSONValue, maximum: Int) throws -> String {
        let data = try JSONEncoder().encode(frame)
        guard data.count <= maximum else { throw streamLimit("The stream envelope is too large.") }
        return String(decoding: data, as: UTF8.self)
    }

    static func upgradeRequest(ticket: JSONValue, target: URLRequest, origin: String, gatewayAccess: GatewayAccess? = nil) throws -> URLRequest {
        let token = ticket["token"].stringValue
        guard token.utf8.count == 64, token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let url = target.url, MichiEndpoint.origin(of: url)?.serialized == origin,
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https" || parts.scheme == "http", parts.user == nil, parts.password == nil else {
            throw streamFailure("The one-use stream ticket or its origin is invalid.")
        }
        let httpScheme = parts.scheme
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let socketURL = parts.url else { throw streamFailure("The stream upgrade URL is invalid.") }
        // Backend authentication was captured by the ticket. Never put a direct
        // backend bearer in the URL or copy one onto the upgrade. An optional
        // HTTPS gateway credential is a separate Authorization, applied only
        // when explicitly prepared for this origin.
        var request = URLRequest(url: socketURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpShouldHandleCookies = false
        request.setValue(origin, forHTTPHeaderField: "Origin")
        if let gatewayAccess {
            guard httpScheme == "https" else {
                throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidConfiguration,
                                    message: "Gateway access requires an HTTPS stream upgrade.")
            }
            request.setValue(try gatewayAccess.authorizationHeader(matching: origin), forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// Mirrors backend STREAM_PATH and method rules. No general HTTP proxy.
    static func supports(path: String, method: String) -> Bool {
        guard (try? MichiAPI.apiTarget(path)) != nil else { return false }
        let pathname = String(path.split(separator: "?", maxSplits: 1)[0])
        let pattern = "^/(?:backend-connections/[a-zA-Z0-9_-]+/proxy/)?(chats/background/subscribe|chats/[a-zA-Z0-9_-]+/(message|stream)|workspaces/[a-zA-Z0-9_-]+/watch/stream|agent-runs/subscribe|workflow-runs/subscribe|digests/stream|panes/subscribe|panes/presence/keepalive)$"
        guard pathname.range(of: pattern, options: .regularExpression) != nil else { return false }
        let post = ["/message", "/background/subscribe", "/digests/stream", "/panes/presence/keepalive"].contains { pathname.hasSuffix($0) }
        return method == (post ? "POST" : "GET")
    }
}

private func streamFailure(_ message: String) -> MichiAPIError {
    MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidResponse, message: message)
}
private func streamLimit(_ message: String) -> MichiAPIError {
    MichiAPIError(statusCode: nil, code: MichiAPIError.Code.streamLimitExceeded, message: message)
}

enum MichiStreamFrame: Equatable, Sendable {
    case headers(String, Int), data(String, String), end(String), error(String, String)
    var id: String {
        switch self { case .headers(let id, _), .data(let id, _), .end(let id), .error(let id, _): return id }
    }
    static func parse(_ text: String, maximum: Int) throws -> Self {
        guard text.utf8.count <= maximum else { throw streamLimit("The incoming stream frame is too large.") }
        guard let raw = try? JSONValue.parse(text), case .object = raw,
              let id = raw["id"].optionalString, (1...80).contains(id.utf8.count),
              id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw streamFailure("Invalid stream envelope.")
        }
        switch raw["type"].stringValue {
        case "headers":
            guard case .number(let status) = raw["status"], status.isFinite, status.rounded() == status, (200...599).contains(status) else { throw streamFailure("Invalid stream status.") }
            return .headers(id, Int(status))
        case "data":
            guard let text = raw["text"].optionalString else { throw streamFailure("Invalid stream data.") }
            return .data(id, text)
        case "end": return .end(id)
        case "error":
            guard let message = raw["message"].optionalString else { throw streamFailure("Invalid stream error.") }
            return .error(id, message)
        default: throw streamFailure("Unknown stream envelope.")
        }
    }
}

protocol MichiStreamSocket: Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close() async
}
typealias MichiStreamSocketFactory = @Sendable (URLRequest, URLSessionConfiguration, Int) async throws -> any MichiStreamSocket

private final class MichiURLSessionStreamSocket: @unchecked Sendable, MichiStreamSocket {
    private let session: URLSession
    private let task: URLSessionWebSocketTask
    init(request: URLRequest, configuration: URLSessionConfiguration, maximum: Int) {
        session = URLSession(configuration: configuration, delegate: MichiUpgradeRedirectGuard(), delegateQueue: nil)
        task = session.webSocketTask(with: request)
        task.maximumMessageSize = maximum
        task.resume()
    }
    func send(_ text: String) async throws { try await task.send(.string(text)) }
    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data: throw streamFailure("Binary stream envelopes are not supported.")
        @unknown default: throw streamFailure("Unknown WebSocket message.")
        }
    }
    func close() async { task.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
}

/// Tickets are single use. Even same-origin redirects cannot replay an upgrade
/// or forward a gateway Authorization header.
private final class MichiUpgradeRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        task.cancel(); completionHandler(nil)
    }
}

/// Serializes sends, including a detach racing with a still-pending open.
private actor MichiStreamSocketWriter {
    private let socket: any MichiStreamSocket
    private let maximum: Int
    private var queuedBytes = 0
    private var tail: Task<Void, Error>?
    private var tailID: UUID?
    init(socket: any MichiStreamSocket, maximum: Int) { self.socket = socket; self.maximum = maximum }
    func send(_ text: String) async throws {
        let size = text.utf8.count
        guard size <= maximum else {
            throw MichiAPIError(statusCode: 413, code: "stream_request_too_large", message: "The stream request exceeds the native connection buffer limit.")
        }
        guard queuedBytes <= maximum - size else {
            throw MichiAPIError(statusCode: 429, code: "stream_backpressure", message: "The stream connection is busy. The request was not sent.")
        }
        let previous = tail, socket = socket, id = UUID()
        let task = Task { if let previous { try await previous.value }; try await socket.send(text) }
        tail = task; tailID = id; queuedBytes += size
        defer { queuedBytes -= size; if tailID == id { tail = nil; tailID = nil } }
        try await task.value
    }
}

fileprivate actor MichiStreamBytes {
    private let maximum: Int
    private var chunks: [Data] = []
    private var index = 0
    private var buffered = 0
    private var ended = false
    private var error: Error?
    private var waiter: CheckedContinuation<Data?, Error>?
    init(maximum: Int) { self.maximum = max(1, maximum) }
    func push(_ data: Data) throws {
        guard !ended else { return }
        guard data.count <= maximum else { throw streamLimit("The incoming stream chunk is too large.") }
        if let waiter { self.waiter = nil; waiter.resume(returning: data); return }
        guard buffered <= maximum - data.count else { throw streamLimit("The stream consumer is too slow. Reconnect using its saved cursor.") }
        chunks.append(data); buffered += data.count
    }
    func next() async throws -> Data? {
        if let error { throw error }
        if index < chunks.count {
            let value = chunks[index]; chunks[index] = Data(); index += 1; buffered -= value.count
            if index == chunks.count { chunks = []; index = 0 }
            else if index >= 32, index * 2 >= chunks.count { chunks.removeFirst(index); index = 0 }
            return value
        }
        if ended { return nil }
        guard waiter == nil else { throw streamFailure("Read each stream from one task at a time.") }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func finish(_ error: Error?) {
        guard !ended else { return }
        ended = true; self.error = error
        if let error { chunks = []; index = 0; buffered = 0; waiter?.resume(throwing: error) }
        else { waiter?.resume(returning: nil) }
        waiter = nil
    }
}

private final class MichiMultiplexedEventPump: @unchecked Sendable {
    private let transport: MichiStreamTransport
    private let api: MichiAPI
    private let path: String
    private let method: String
    private let body: JSONValue?
    private let id = UUID().uuidString.lowercased()
    private var source: MichiStreamTransport.Source?
    private var parser: SSEParser
    private var pending: [SSEEvent] = []
    private var index = 0
    private var sniffedContent = false
    init(transport: MichiStreamTransport, api: MichiAPI, path: String, method: String, body: JSONValue?, limits: MichiStreamTransport.Limits) {
        self.transport = transport; self.api = api; self.path = path; self.method = method; self.body = body
        parser = SSEParser(maxLineBytes: limits.maxEventBytes, maxEventBytes: limits.maxEventBytes)
    }
    deinit { let transport = transport, id = id; Task { await transport.cancel(id: id) } }
    func next() async throws -> SSEEvent? {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            if source == nil { source = try await transport.open(api: api, id: id, path: path, method: method, body: body) }
            guard let source else { return nil }
            switch source {
            case .http(let pump): return try await pump.next()
            case .websocket(let bytes):
                while true {
                    if index < pending.count {
                        let event = pending[index]; index += 1
                        if index == pending.count { pending = []; index = 0 }
                        return event
                    }
                    guard let chunk = try await bytes.next() else { return nil }
                    if !sniffedContent, let first = MichiAPI.firstSignificantByte(chunk) {
                        sniffedContent = true
                        if first == UInt8(ascii: "<") { await transport.cancel(id: id); throw MichiAPI.htmlError(status: 200) }
                    }
                    do { pending = try parser.feed(chunk) }
                    catch { await transport.cancel(id: id); throw error }
                }
            }
        } onCancel: { [transport, id] in Task { await transport.cancel(id: id) } }
    }
}
