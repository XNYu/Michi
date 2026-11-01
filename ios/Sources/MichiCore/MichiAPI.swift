import Foundation
import CryptoKit

/// A structured failure from the Michi backend, an ingress in front of it, or
/// the transport. `statusCode` is nil when no HTTP response arrived; for a
/// request that changes data the outcome is then unknown and it must not be
/// resent blindly. Backend machine codes such as `turn_active` pass through.
public struct MichiAPIError: Error, Equatable, Sendable, LocalizedError, CustomStringConvertible {
    public let statusCode: Int?
    public let code: String?
    public let message: String

    public init(statusCode: Int?, code: String?, message: String) {
        self.statusCode = statusCode
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }

    public var description: String {
        let detail = [statusCode.map { "HTTP \($0)" }, code].compactMap { $0 }
        return detail.isEmpty ? message : "\(message) (\(detail.joined(separator: ", ")))"
    }

    /// A confirmed busy turn: the only conflict proving a message never started.
    public var isTurnActive: Bool { statusCode == 409 && code == "turn_active" }

    /// Local client refusals that occur before any chat send is attempted.
    /// Requires a nil HTTP status: codes that can appear after URLSession or a
    /// stream writer has been asked to send (network, timeout, HTML, redirects,
    /// invalid responses, backpressure) stay unknown-outcome.
    public var isPreDispatchRefusal: Bool {
        statusCode == nil && [
            Code.invalidConfiguration,
            Code.insecureURL,
            Code.invalidPath,
            Code.invalidRequest,
            Code.gatewayAccessExpired,
        ].contains(code ?? "")
    }

    /// Codes for failures the client detects itself.
    public enum Code {
        public static let invalidConfiguration = "invalid_configuration"
        public static let insecureURL = "insecure_url"
        public static let invalidPath = "invalid_path"
        public static let invalidRequest = "invalid_request"
        public static let redirectBlocked = "redirect_blocked"
        public static let htmlResponse = "html_response"
        public static let invalidResponse = "invalid_response"
        public static let streamLimitExceeded = "stream_limit_exceeded"
        public static let timedOut = "timed_out"
        public static let network = "network_error"
        public static let gatewayAccessExpired = "gateway_access_expired"
    }
}

private typealias ErrorCode = MichiAPIError.Code

/// HTTP client for one Michi server. Paths are relative to the server's `/api`
/// root (`/workspaces/all?meta=1`); encode identifiers with `pathSegment(_:)`
/// and query values with `queryComponent(_:)`. Every request carries the
/// server's Origin, never follows a redirect off that origin, and is never
/// retried automatically. Optional `gatewayAccess` is an in-memory HTTPS
/// gateway bearer for this origin only and cannot be combined with `bearerToken`.
public final class MichiAPI: @unchecked Sendable {
    /// Read-idle limit for event streams. Healthy streams send a keepalive at
    /// least every 25 seconds, and the limit restarts with every byte received.
    public static let streamIdleTimeout: TimeInterval = 90
    static let maxErrorBodyBytes = 64 * 1024

    /// Normalized server root: origin plus optional path prefix, without `/api`.
    public let baseURL: URL
    /// Non-reversible credential scope for local recovery records. Never contains
    /// the token itself; switching credentials must not inherit another identity's writes.
    public let credentialIdentityFingerprint: String
    /// Opaque per-instance stream owner. Not derived from origin or credentials,
    /// so a replacement client cannot inherit another instance's socket.
    let instanceID = UUID()
    /// Why the server URL or token cannot be used; every call throws it.
    public let configurationError: MichiAPIError?

    let session: URLSession
    private let endpoint: MichiEndpoint?
    private let bearerToken: String?
    let gatewayAccess: GatewayAccess?
    private let streamTransport: MichiStreamTransport?
    /// Evaluation time for prepared-gateway expiry. Tests replace this to avoid clock races.
    package var now: @Sendable () -> Date = { Date() }

    public init(baseURL: URL, bearerToken: String? = nil, session: URLSession = .shared, streamTransport: MichiStreamTransport? = nil, gatewayAccess: GatewayAccess? = nil) {
        if session === URLSession.shared {
            self.session = MichiIsolatedSession.make()
        } else if gatewayAccess != nil {
            self.session = MichiIsolatedSession.make(copying: session.configuration)
        } else {
            self.session = session
        }
        self.streamTransport = streamTransport
        self.gatewayAccess = gatewayAccess
        let token = bearerToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.bearerToken = token.isEmpty ? nil : token
        let identity: String
        if let gatewayAccess, !token.isEmpty {
            identity = "michi-credential-v1\0conflict\0" + gatewayAccess.origin + "\0" + gatewayAccess.bearer + "\0" + token
        } else if let gatewayAccess {
            identity = "michi-credential-v1\0gateway\0" + gatewayAccess.origin + "\0" + gatewayAccess.bearer
        } else if token.isEmpty {
            identity = "michi-credential-v1\0none"
        } else {
            identity = "michi-credential-v1\0bearer\0" + token
        }
        self.credentialIdentityFingerprint = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        switch MichiEndpoint.parse(baseURL) {
        case .success(let endpoint):
            self.endpoint = endpoint
            self.baseURL = endpoint.rootURL
            if gatewayAccess != nil && !token.isEmpty {
                self.configurationError = MichiAPIError(
                    statusCode: nil, code: ErrorCode.invalidConfiguration,
                    message: "A gateway access credential cannot be combined with a direct access token.")
            } else if let gatewayAccess, gatewayAccess.origin != endpoint.origin {
                self.configurationError = MichiAPIError(
                    statusCode: nil, code: ErrorCode.invalidConfiguration,
                    message: "The gateway access credential is not valid for this server origin.")
            } else {
                self.configurationError = token.utf8.allSatisfy({ $0 > 0x20 && $0 < 0x7F }) ? nil : MichiAPIError(
                    statusCode: nil, code: ErrorCode.invalidConfiguration,
                    message: "The access token contains characters that cannot be sent in a header.")
            }
        case .failure(let error):
            self.endpoint = nil
            self.baseURL = baseURL
            self.configurationError = error
        }
    }

    /// Sends one JSON request. 204 and empty bodies return `.null`.
    public func request(_ path: String, method: String = "GET", body: JSONValue? = nil, idempotencyKey: String? = nil) async throws -> JSONValue {
        var (request, endpoint) = try makeRequest(path, method: method, body: body, kind: .json)
        if let idempotencyKey {
            guard !idempotencyKey.isEmpty, idempotencyKey.utf8.count <= 256,
                  idempotencyKey.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else { throw Self.invalidRequest("The idempotency key must contain 1–256 visible ASCII characters.") }
            request.setValue(idempotencyKey, forHTTPHeaderField: "x-idempotency-key")
        }
        let redirects = MichiRedirectGuard(endpoint: endpoint, method: request.httpMethod ?? "GET",
                                           identityHeaders: identityHeaders(endpoint),
                                           gatewayAccess: gatewayAccess, now: now)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request, delegate: redirects)
        } catch {
            throw Self.transportError(redirects.blocked.map { $0 as Error } ?? error)
        }
        if let blocked = redirects.blocked { throw blocked }
        let http = try Self.validated(response, endpoint: endpoint)
        guard (200..<300).contains(http.statusCode) else { throw Self.httpError(http, body: data) }
        return try Self.decodeJSON(data, response: http)
    }

    /// Opens a Server-Sent Events request when iteration begins and yields each
    /// event as it arrives. Cancelling the consuming task only closes this HTTP
    /// connection: the backend detaches the subscriber and a durable turn keeps
    /// running. Iterate from one task at a time.
    public func stream(_ path: String, method: String = "GET", body: JSONValue? = nil) -> AsyncThrowingStream<SSEEvent, Error> {
        if let streamTransport { return streamTransport.stream(api: self, path: path, method: method, body: body) }
        let pump = MichiEventStreamPump(api: self, path: path, method: method, body: body)
        return AsyncThrowingStream<SSEEvent, Error>(unfolding: { try await pump.next() })
    }

    public func closeStreams() async { await streamTransport?.close() }

    /// Percent-encodes an identifier as one path segment. Identifiers that are
    /// `.`/`..` or contain `/` are refused by `request`/`stream`.
    public static func pathSegment(_ id: String) -> String { URLCharacters.percentEncode(id) }

    /// Percent-encodes one query name or value, including `&`, `=` and `+`.
    public static func queryComponent(_ value: String) -> String { URLCharacters.percentEncode(value) }

    // MARK: - Request construction

    enum RequestKind { case json, eventStream }

    private static let methods: Set<String> = ["GET", "POST", "PUT", "PATCH", "DELETE"]

    func makeRequest(_ path: String, method: String, body: JSONValue?, kind: RequestKind) throws -> (URLRequest, MichiEndpoint) {
        if let configurationError { throw configurationError }
        guard let endpoint else {
            throw MichiAPIError(statusCode: nil, code: ErrorCode.invalidConfiguration, message: "The server URL is invalid.")
        }
        if let gatewayAccess {
            _ = try gatewayAccess.authorizationHeader(now: now(), matching: endpoint.origin)
        }
        let verb = method.uppercased()
        guard Self.methods.contains(verb) else { throw Self.invalidRequest("This HTTP method is not supported.") }
        if verb == "GET", body != nil { throw Self.invalidRequest("A GET request cannot carry a body.") }
        let target = try Self.apiTarget(path)
        guard let url = URL(string: endpoint.origin + endpoint.basePath + "/api" + target), endpoint.isSameOrigin(url) else {
            throw Self.invalidPath("The API path does not form a valid URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = verb
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        for (field, value) in identityHeaders(endpoint) { request.setValue(value, forHTTPHeaderField: field) }
        switch kind {
        case .json:
            request.setValue("application/json", forHTTPHeaderField: "Accept")
        case .eventStream:
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.timeoutInterval = Self.streamIdleTimeout
        }
        if let body {
            do {
                // Command receipts hash the parsed object in insertion order.
                // Stable keys make an explicit retry of an identical operation
                // resolve its receipt instead of looking like a new payload.
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                request.httpBody = try encoder.encode(body)
            } catch {
                throw Self.invalidRequest("The request body cannot be encoded as JSON.")
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return (request, endpoint)
    }

    /// Headers stamped on the request and on every permitted same-origin redirect.
    /// Gateway and direct bearers are never mixed into the same Authorization.
    func identityHeaders(_ endpoint: MichiEndpoint) -> [String: String] {
        var headers = ["Origin": endpoint.origin]
        if gatewayAccess != nil && bearerToken != nil {
            return headers
        }
        if let gatewayAccess, gatewayAccess.origin == endpoint.origin {
            headers["Authorization"] = "Bearer \(gatewayAccess.bearer)"
        } else if let bearerToken {
            headers["Authorization"] = "Bearer \(bearerToken)"
        }
        return headers
    }

    /// Validates a caller path relative to `/api`; returns it unchanged.
    static func apiTarget(_ target: String) throws -> String {
        guard target.hasPrefix("/"), !target.hasPrefix("//") else {
            throw invalidPath("API paths must start with a single \"/\".")
        }
        guard !target.contains("#") else { throw invalidPath("API paths cannot contain a fragment.") }
        let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(parts[0])
        try validatePath(path)
        if path.dropFirst().split(separator: "/").first?.lowercased() == "api" {
            throw invalidPath("API paths are relative to /api; remove the /api prefix.")
        }
        if parts.count == 2, !URLCharacters.isEncoded(parts[1], allowing: URLCharacters.query) {
            throw invalidPath("Encode query values with MichiAPI.queryComponent(_:).")
        }
        return target
    }

    /// Requires percent-encoded, non-empty segments that cannot navigate: a
    /// decoded `.`/`..`, `/` or `\` is refused because proxies may normalize it.
    static func validatePath(_ path: String) throws {
        guard path.hasPrefix("/") else { throw invalidPath("API paths must start with \"/\".") }
        for segment in path.dropFirst().split(separator: "/", omittingEmptySubsequences: false) {
            guard !segment.isEmpty else { throw invalidPath("API paths cannot contain empty segments.") }
            guard URLCharacters.isEncoded(segment, allowing: URLCharacters.segment),
                  let decoded = segment.removingPercentEncoding else {
                throw invalidPath("Encode identifiers with MichiAPI.pathSegment(_:).")
            }
            if decoded == "." || decoded == ".." || decoded.contains(where: { $0 == "/" || $0 == "\\" })
                || decoded.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) {
                throw invalidPath("API path segments cannot navigate outside the API.")
            }
        }
    }

    private static func invalidPath(_ message: String) -> MichiAPIError {
        MichiAPIError(statusCode: nil, code: ErrorCode.invalidPath, message: message)
    }

    private static func invalidRequest(_ message: String) -> MichiAPIError {
        MichiAPIError(statusCode: nil, code: ErrorCode.invalidRequest, message: message)
    }

    // MARK: - Response handling

    /// The final response must still come from the server's origin.
    static func validated(_ response: URLResponse, endpoint: MichiEndpoint) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw MichiAPIError(statusCode: nil, code: ErrorCode.invalidResponse, message: "The server response was not HTTP.")
        }
        if let url = http.url, !endpoint.isSameOrigin(url) {
            throw MichiRedirectGuard.crossOriginError(status: http.statusCode)
        }
        return http
    }

    static func decodeJSON(_ data: Data, response: HTTPURLResponse) throws -> JSONValue {
        let status = response.statusCode
        if status == 204 || status == 205 { return .null }
        if looksLikeHTML(contentType: response.value(forHTTPHeaderField: "Content-Type"), body: data) {
            throw htmlError(status: status)
        }
        guard firstSignificantByte(data) != nil else { return .null }
        do { return try JSONDecoder().decode(JSONValue.self, from: data) } catch {
            throw MichiAPIError(statusCode: status, code: ErrorCode.invalidResponse,
                                message: "The server returned data that is not valid JSON.")
        }
    }

    /// Backend errors are `{ error, code? }`; ingress refusals are often plain text.
    static func httpError(_ response: HTTPURLResponse, body: Data) -> MichiAPIError {
        let status = response.statusCode
        if looksLikeHTML(contentType: response.value(forHTTPHeaderField: "Content-Type"), body: body) {
            return htmlError(status: status)
        }
        let fallback = "Request failed with HTTP \(status)."
        if let json = try? JSONDecoder().decode(JSONValue.self, from: body) {
            let error = json["error"]
            let message = error.optionalString ?? error["message"].optionalString ?? json["message"].optionalString
            let code = json["code"].optionalString ?? error["code"].optionalString
            return MichiAPIError(statusCode: status, code: code, message: message.flatMap { $0.isEmpty ? nil : $0 } ?? fallback)
        }
        let text = String(decoding: body.prefix(1024), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return MichiAPIError(statusCode: status, code: nil, message: text.isEmpty ? fallback : String(text.prefix(300)))
    }

    static func htmlError(status: Int?) -> MichiAPIError {
        MichiAPIError(statusCode: status, code: ErrorCode.htmlResponse,
                      message: "The server returned an unexpected page instead of Michi data. Signing in through a browser does not automatically authorize native requests. If this address is company-managed, use a supported native integration.")
    }

    static func looksLikeHTML(contentType: String?, body: Data) -> Bool {
        if let type = contentType?.lowercased(), type.contains("text/html") || type.contains("application/xhtml") {
            return true
        }
        return firstSignificantByte(body) == UInt8(ascii: "<")
    }

    /// First byte that is not JSON whitespace or a UTF-8 byte-order mark.
    static func firstSignificantByte<Bytes: Sequence>(_ bytes: Bytes) -> UInt8? where Bytes.Element == UInt8 {
        bytes.first { ![0x20, 0x09, 0x0A, 0x0D, 0xEF, 0xBB, 0xBF].contains($0) }
    }

    /// Cancellation stays `CancellationError`; other failures become `MichiAPIError`.
    static func transportError(_ error: Error) -> Error {
        if error is MichiAPIError || error is CancellationError { return error }
        guard let urlError = error as? URLError else {
            return MichiAPIError(statusCode: nil, code: ErrorCode.network, message: error.localizedDescription)
        }
        switch urlError.code {
        case .cancelled:
            return CancellationError()
        case .timedOut:
            return MichiAPIError(statusCode: nil, code: ErrorCode.timedOut, message: "The server stopped responding.")
        case .appTransportSecurityRequiresSecureConnection:
            return MichiAPIError(statusCode: nil, code: ErrorCode.insecureURL, message: "This connection requires HTTPS.")
        default:
            return MichiAPIError(statusCode: nil, code: ErrorCode.network, message: urlError.localizedDescription)
        }
    }
}

// MARK: - Origin

/// A validated server root: one origin and an optional path prefix.
struct MichiEndpoint: Equatable, Sendable {
    let origin: String
    let basePath: String
    let rootURL: URL

    #if DEBUG
    static let allowsLoopbackPlaintext = true
    #else
    static let allowsLoopbackPlaintext = false
    #endif

    struct Origin: Equatable {
        let scheme: String
        /// Lowercased; IPv6 without brackets.
        let host: String
        /// Nil for the scheme's default port.
        let port: Int?

        /// Serialized like a browser Origin header.
        var serialized: String {
            let name = host.contains(":") ? "[\(host)]" : host
            return "\(scheme)://\(name)" + (port.map { ":\($0)" } ?? "")
        }
    }

    func isSameOrigin(_ url: URL) -> Bool { Self.origin(of: url)?.serialized == origin }

    static func origin(of url: URL) -> Origin? {
        URLComponents(url: url, resolvingAgainstBaseURL: true).flatMap { origin(of: $0) }
    }

    static func origin(of components: URLComponents) -> Origin? {
        guard let scheme = components.scheme?.lowercased(), var host = components.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        let defaultPort: Int? = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
        return Origin(scheme: scheme, host: host, port: components.port == defaultPort ? nil : components.port)
    }

    static func parse(_ url: URL) -> Result<MichiEndpoint, MichiAPIError> {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let origin = origin(of: components) else {
            return .failure(configurationError("The server URL needs a scheme and a host."))
        }
        guard components.user == nil, components.password == nil else {
            return .failure(configurationError("The server URL cannot contain a user name or password."))
        }
        guard origin.scheme == "https" || origin.scheme == "http" else {
            return .failure(configurationError("The server URL must use HTTPS."))
        }
        guard origin.host.utf8.allSatisfy(isHostByte) else {
            return .failure(configurationError("The server host name is invalid."))
        }
        if origin.scheme == "http", !(allowsLoopbackPlaintext && isLoopback(origin.host)) {
            return .failure(MichiAPIError(statusCode: nil, code: ErrorCode.insecureURL,
                                          message: "Use an HTTPS server URL. Plain HTTP is only allowed for a loopback development server."))
        }
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/api") { path.removeLast(4) }
        if !path.isEmpty {
            do { try MichiAPI.validatePath(path) } catch {
                return .failure(configurationError("The server URL path is invalid."))
            }
        }
        guard let root = URL(string: origin.serialized + path) else {
            return .failure(configurationError("The server URL is invalid."))
        }
        return .success(MichiEndpoint(origin: origin.serialized, basePath: path, rootURL: root))
    }

    static func isLoopback(_ host: String) -> Bool {
        if host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1" { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        return octets.count == 4 && octets[0] == "127" && octets.allSatisfy { UInt8($0) != nil }
    }

    private static func isHostByte(_ byte: UInt8) -> Bool {
        (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39) || [0x2D, 0x2E, 0x5F, 0x3A].contains(byte)
    }

    private static func configurationError(_ message: String) -> MichiAPIError {
        MichiAPIError(statusCode: nil, code: ErrorCode.invalidConfiguration, message: message)
    }
}

// MARK: - Redirects

/// Per-task redirect policy. It is attached to every task, so it applies even
/// when an injected session has its own delegate. Only same-origin GET
/// redirects are followed; anything else is cancelled before the redirected
/// request (and its bearer token) is sent.
final class MichiRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let endpoint: MichiEndpoint
    private let method: String
    private let identityHeaders: [String: String]
    private let gatewayAccess: GatewayAccess?
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var blockedError: MichiAPIError?

    init(endpoint: MichiEndpoint, method: String, identityHeaders: [String: String],
         gatewayAccess: GatewayAccess? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.endpoint = endpoint
        self.method = method
        self.identityHeaders = identityHeaders
        self.gatewayAccess = gatewayAccess
        self.now = now
    }

    var blocked: MichiAPIError? {
        lock.lock()
        defer { lock.unlock() }
        return blockedError
    }

    static func crossOriginError(status: Int?) -> MichiAPIError {
        MichiAPIError(statusCode: status, code: ErrorCode.redirectBlocked,
                      message: "The server redirected to a different site. The redirect was blocked so credentials stay with this server. Signing in through a browser does not automatically authorize native requests. If this address is company-managed, use a supported native integration.")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        let sameOrigin = request.url.map(endpoint.isSameOrigin) ?? false
        if sameOrigin, method == "GET" {
            var next = request
            next.httpShouldHandleCookies = false
            for (field, value) in identityHeaders { next.setValue(value, forHTTPHeaderField: field) }
            if let gatewayAccess {
                do {
                    next.setValue(try gatewayAccess.authorizationHeader(now: now(), matching: endpoint.origin),
                                  forHTTPHeaderField: "Authorization")
                } catch let error as MichiAPIError {
                    lock.lock()
                    blockedError = error
                    lock.unlock()
                    task.cancel()
                    completionHandler(nil)
                    return
                } catch {
                    task.cancel()
                    completionHandler(nil)
                    return
                }
            }
            completionHandler(next)
            return
        }
        let error = sameOrigin
            ? MichiAPIError(statusCode: response.statusCode, code: ErrorCode.redirectBlocked,
                            message: "The server redirected a request that changes data. It was not resent.")
            : Self.crossOriginError(status: response.statusCode)
        lock.lock()
        blockedError = error
        lock.unlock()
        // Do not read the redirect body either: it is usually a sign-in page.
        task.cancel()
        completionHandler(nil)
    }
}

// MARK: - Streaming

/// Pull-based SSE reader behind `MichiAPI.stream`: bytes are read only while
/// the consumer asks for the next event, so buffering stays bounded.
final class MichiEventStreamPump: @unchecked Sendable {
    private static let chunkBytes = 16 * 1024

    private let api: MichiAPI
    private let path: String
    private let method: String
    private let body: JSONValue?

    // Touched only by the single consuming task.
    private var redirects: MichiRedirectGuard?
    private var iterator: URLSession.AsyncBytes.AsyncIterator?
    private var parser = SSEParser()
    private var pending: [SSEEvent] = []
    private var pendingIndex = 0
    private var chunk: [UInt8] = []
    private var status: Int?
    private var sniffedHTML = false
    private var finished = false

    // Shared with the cancellation handler.
    private let lock = NSLock()
    private var dataTask: URLSessionDataTask?
    private var closed = false

    init(api: MichiAPI, path: String, method: String, body: JSONValue?) {
        self.api = api
        self.path = path
        self.method = method
        self.body = body
    }

    deinit { dataTask?.cancel() }

    func next() async throws -> SSEEvent? {
        try await withTaskCancellationHandler {
            try await produce()
        } onCancel: { [self] in
            closeTransport()
        }
    }

    private func produce() async throws -> SSEEvent? {
        if let event = popPending() { return event }
        if finished { return nil }
        do {
            try Task.checkCancellation()
            if iterator == nil { try await open() }
            guard var bytes = iterator else { return nil }
            defer { iterator = bytes }
            while true {
                guard let byte = try await bytes.next() else {
                    // A trailing event without its blank line is discarded, per the SSE spec.
                    try deliverChunk()
                    finish()
                    return popPending()
                }
                chunk.append(byte)
                if byte == 0x0A || byte == 0x0D || chunk.count >= Self.chunkBytes {
                    try deliverChunk()
                    if let event = popPending() { return event }
                }
            }
        } catch {
            finish()
            throw MichiAPI.transportError(redirects?.blocked.map { $0 as Error } ?? error)
        }
    }

    private func open() async throws {
        let (request, endpoint) = try api.makeRequest(path, method: method, body: body, kind: .eventStream)
        let redirects = MichiRedirectGuard(endpoint: endpoint, method: request.httpMethod ?? "GET",
                                           identityHeaders: api.identityHeaders(endpoint),
                                           gatewayAccess: api.gatewayAccess, now: api.now)
        self.redirects = redirects
        let (bytes, response) = try await api.session.bytes(for: request, delegate: redirects)
        attach(bytes.task)
        if let blocked = redirects.blocked { throw blocked }
        let http = try MichiAPI.validated(response, endpoint: endpoint)
        status = http.statusCode
        guard (200..<300).contains(http.statusCode) else {
            let body = (try? await Self.prefix(of: bytes, limit: MichiAPI.maxErrorBodyBytes)) ?? Data()
            throw MichiAPI.httpError(http, body: body)
        }
        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        if contentType.contains("text/html") || contentType.contains("application/xhtml") {
            throw MichiAPI.htmlError(status: http.statusCode)
        }
        if !contentType.isEmpty, !contentType.contains("text/event-stream") {
            throw MichiAPIError(statusCode: http.statusCode, code: MichiAPIError.Code.invalidResponse,
                                message: "The server did not return an event stream.")
        }
        iterator = bytes.makeAsyncIterator()
    }

    private func deliverChunk() throws {
        guard !chunk.isEmpty else { return }
        if !sniffedHTML, let first = MichiAPI.firstSignificantByte(chunk) {
            sniffedHTML = true
            if first == UInt8(ascii: "<") { throw MichiAPI.htmlError(status: status) }
        }
        let events = try parser.feed(chunk)
        pending.append(contentsOf: events)
        chunk.removeAll(keepingCapacity: true)
    }

    private func popPending() -> SSEEvent? {
        guard pendingIndex < pending.count else {
            if !pending.isEmpty {
                pending.removeAll(keepingCapacity: true)
                pendingIndex = 0
            }
            return nil
        }
        defer { pendingIndex += 1 }
        return pending[pendingIndex]
    }

    private func finish() {
        finished = true
        chunk = []
        closeTransport()
    }

    private func attach(_ task: URLSessionDataTask) {
        lock.lock()
        dataTask = task
        let isClosed = closed
        lock.unlock()
        if isClosed { task.cancel() }
    }

    private func closeTransport() {
        lock.lock()
        closed = true
        let task = dataTask
        lock.unlock()
        task?.cancel()
    }

    private static func prefix(of bytes: URLSession.AsyncBytes, limit: Int) async throws -> Data {
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count >= limit { break }
        }
        return data
    }
}

// MARK: - Encoding

enum URLCharacters {
    static let segment = Set("!$&'()*+,;=:@".utf8)
    static let query = Set("!$&'()*+,;=:@/?".utf8)
    private static let hex = Array("0123456789ABCDEF".utf8)

    static func isUnreserved(_ byte: UInt8) -> Bool {
        (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39)
            || byte == 0x2D || byte == 0x2E || byte == 0x5F || byte == 0x7E
    }

    /// True when every byte is unreserved, in `extra`, or a valid `%XX` escape.
    static func isEncoded<Text: StringProtocol>(_ text: Text, allowing extra: Set<UInt8>) -> Bool {
        var bytes = text.utf8.makeIterator()
        while let byte = bytes.next() {
            if byte == 0x25 {
                guard let high = bytes.next(), let low = bytes.next(), isHex(high), isHex(low) else { return false }
            } else if !isUnreserved(byte), !extra.contains(byte) {
                return false
            }
        }
        return true
    }

    static func percentEncode(_ text: String) -> String {
        var out: [UInt8] = []
        out.reserveCapacity(text.utf8.count)
        for byte in text.utf8 {
            if isUnreserved(byte) {
                out.append(byte)
            } else {
                out.append(contentsOf: [0x25, hex[Int(byte >> 4)], hex[Int(byte & 0x0F)]])
            }
        }
        return String(decoding: out, as: UTF8.self)
    }

    private static func isHex(_ byte: UInt8) -> Bool {
        (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66)
    }
}
