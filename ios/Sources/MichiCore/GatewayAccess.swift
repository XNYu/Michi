import Foundation

/// In-memory HTTPS gateway access for exactly one normalized origin.
///
/// A future approved session supplies an already-issued short-lived bearer.
/// This type does not fetch, refresh, persist, parse, or verify credentials.
/// Expiry and origin binding are enforced when a request or WebSocket upgrade
/// is prepared for dispatch. An already-open stream is not closed when the
/// credential later expires, and no device-policy revocation is implemented.
public struct GatewayAccess: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    /// Browser-style origin (`https://host` or `https://host:port`).
    public let origin: String
    public let expiresAt: Date
    let bearer: String

    public init(endpoint: URL, bearer: String, expiresAt: Date) throws {
        let token = bearer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidConfiguration,
                                message: "The gateway access credential cannot be empty.")
        }
        guard token.utf8.allSatisfy({ $0 > 0x20 && $0 < 0x7F }) else {
            throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidConfiguration,
                                message: "The gateway access credential contains characters that cannot be sent in a header.")
        }
        self.origin = try Self.normalizedOrigin(endpoint)
        self.bearer = token
        self.expiresAt = expiresAt
    }

    public var description: String {
        "GatewayAccess(origin: \(origin), expiresAt: \(expiresAt.timeIntervalSince1970), credential: <redacted>)"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        let children: [Mirror.Child] = [("origin", origin), ("expiresAt", expiresAt), ("credential", "<redacted>")]
        return Mirror(self, children: children, displayStyle: .struct)
    }

    func isExpired(now: Date = Date()) -> Bool { now >= expiresAt }

    func authorizationHeader(now: Date = Date(), matching origin: String) throws -> String {
        guard self.origin == origin, origin.hasPrefix("https://") else {
            throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidConfiguration,
                                message: "The gateway access credential is not valid for this server origin.")
        }
        guard !isExpired(now: now) else {
            throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.gatewayAccessExpired,
                                message: "The gateway access credential has expired.")
        }
        return "Bearer \(bearer)"
    }

    /// Origin only: HTTPS, no userinfo, query, fragment, or non-root path.
    /// Redirect `Location` values are never used to compute this scope.
    static func normalizedOrigin(_ url: URL) throws -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: true) else {
            throw originError("The gateway origin is invalid.")
        }
        guard components.user == nil, components.password == nil else {
            throw originError("The gateway origin cannot contain a user name or password.")
        }
        guard components.query == nil, components.percentEncodedQuery == nil else {
            throw originError("The gateway origin cannot contain a query.")
        }
        guard components.fragment == nil, components.percentEncodedFragment == nil else {
            throw originError("The gateway origin cannot contain a fragment.")
        }
        let path = components.percentEncodedPath
        guard path.isEmpty || path == "/" else {
            throw originError("The gateway origin cannot contain a path.")
        }
        guard let origin = MichiEndpoint.origin(of: components) else {
            throw originError("The gateway origin needs a scheme and a host.")
        }
        guard origin.scheme == "https" || origin.scheme == "http" else {
            throw originError("The gateway origin must use HTTPS.")
        }
        guard origin.scheme == "https" else {
            throw MichiAPIError(statusCode: nil, code: MichiAPIError.Code.insecureURL,
                                message: "Gateway access requires an HTTPS origin. Plain HTTP, including loopback, is not accepted.")
        }
        guard origin.host.utf8.allSatisfy(isOriginHostByte) else {
            throw originError("The gateway host name is invalid.")
        }
        return origin.serialized
    }

    private static func originError(_ message: String) -> MichiAPIError {
        MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidConfiguration, message: message)
    }

    private static func isOriginHostByte(_ byte: UInt8) -> Bool {
        (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39) || [0x2D, 0x2E, 0x5F, 0x3A].contains(byte)
    }
}
