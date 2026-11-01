import Foundation

/// Phone-access root URL shared by paste and QR. Desktop encodes the existing
/// HTTPS origin only; this parser never accepts a token.
public enum ConnectionAddress: Sendable {
    public static let maximumUTF8Bytes = 2048

    public struct Parsed: Equatable, Sendable {
        public let url: URL
        public let host: String
        public let origin: String

        public init(url: URL, host: String, origin: String) {
            self.url = url
            self.host = host
            self.origin = origin
        }

        /// Hostname only. Prefer `confirmationDestination` when a port matters.
        public var confirmationHost: String { host }

        /// Normalized destination shown on first-scan confirmation: host, plus a
        /// non-default port, using the same unambiguous form as the origin.
        /// Never a token or raw payload.
        public var confirmationDestination: String {
            if origin.hasPrefix("https://") { return String(origin.dropFirst("https://".count)) }
            if origin.hasPrefix("http://") { return String(origin.dropFirst("http://".count)) }
            return host
        }
    }

    public enum Mode: String, Equatable, Sendable {
        /// Paste/manual entry: DEBUG loopback HTTP and `/api` aliases stay valid.
        case manual
        /// Camera QR: existing desktop HTTPS root only.
        case scan
    }

    public enum Failure: String, Equatable, Sendable, Error {
        case empty
        case oversize
        case credentials
        case query
        case fragment
        case unsafeScheme
        case unsafePath
        case encodedTrick
        case invalid

        public func message(scanned: Bool) -> String {
            if scanned {
                return self == .oversize
                    ? "That code is too large to be a Phone access address."
                    : "This code is not a Michi Phone access address."
            }
            switch self {
            case .empty, .credentials, .unsafeScheme, .invalid:
                return "Enter the HTTPS address from Michi → Settings → Phone access. Credentials must not appear in the URL."
            case .oversize:
                return "That address is too large to be a Phone access address."
            case .query, .fragment, .unsafePath, .encodedTrick:
                return "Use the backend's root address, without a page or API path."
            }
        }
    }

    public static func parse(_ raw: String, mode: Mode = .manual) -> Result<Parsed, Failure> {
        if raw.utf8.count > maximumUTF8Bytes { return .failure(.oversize) }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .failure(.empty) }
        if trimmed.utf8.count > maximumUTF8Bytes { return .failure(.oversize) }
        if trimmed.contains("?") { return .failure(.query) }
        if trimmed.contains("#") { return .failure(.fragment) }

        guard let components = URLComponents(string: trimmed) else { return .failure(.invalid) }
        if hasCredentials(components) || trimmed.contains("@") { return .failure(.credentials) }
        if containsEncodedTrick(trimmed) { return .failure(.encodedTrick) }
        if components.query != nil || components.percentEncodedQuery != nil { return .failure(.query) }
        if components.fragment != nil || components.percentEncodedFragment != nil { return .failure(.fragment) }

        guard let scheme = components.scheme?.lowercased(), !scheme.isEmpty else {
            return .failure(.unsafeScheme)
        }
        if scheme != "https" && scheme != "http" { return .failure(.unsafeScheme) }
        guard let host = components.host?.lowercased(), !host.isEmpty else { return .failure(.invalid) }
        if host.contains("%") || host.contains("/") || host.contains("\\") || host.contains("@") {
            return .failure(.encodedTrick)
        }

        let loopback = MichiEndpoint.isLoopback(host)
        if scheme == "https" {
            // Phone-access QR and pasted Tailscale / tunnel addresses.
        } else if mode == .manual && scheme == "http" && loopback {
            // Loopback development only; MichiAPI still refuses plaintext in Release.
        } else {
            return .failure(.unsafeScheme)
        }

        var next = components
        next.scheme = scheme
        next.user = nil
        next.password = nil
        next.query = nil
        next.fragment = nil
        let path = components.percentEncodedPath
        let allowedRoot = path.isEmpty || path == "/"
        let allowedManualAlias = mode == .manual && (path == "/api" || path == "/api/")
        if allowedRoot || allowedManualAlias {
            next.percentEncodedPath = ""
        } else {
            return .failure(.unsafePath)
        }

        guard let url = next.url, case .success(let endpoint) = MichiEndpoint.parse(url) else {
            return .failure(.invalid)
        }
        return .success(Parsed(url: endpoint.rootURL, host: host, origin: endpoint.origin))
    }

    private static func hasCredentials(_ components: URLComponents) -> Bool {
        components.user != nil
            || components.password != nil
            || components.percentEncodedUser != nil
            || components.percentEncodedPassword != nil
    }

    private static func containsEncodedTrick(_ raw: String) -> Bool {
        if raw.contains("\\") { return true }
        if raw.contains("\0") || raw.contains("\t") || raw.contains("\n") || raw.contains("\r") {
            return true
        }
        if raw.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) { return true }
        if raw.contains("%00") || raw.contains("%2e") || raw.contains("%2E") { return true }
        if raw.contains("%2f") || raw.contains("%2F") { return true }
        if raw.contains("%5c") || raw.contains("%5C") { return true }
        if raw.contains("%40") { return true }
        if raw.contains("%3a") || raw.contains("%3A") { return true }
        if raw.contains("%23") || raw.contains("%3f") || raw.contains("%3F") { return true }
        return false
    }
}

/// First accepted QR payload wins. Later metadata callbacks are ignored.
public struct ConnectionScanSession: Equatable, Sendable {
    public private(set) var accepted: Bool

    public init(accepted: Bool = false) {
        self.accepted = accepted
    }

    public mutating func handle(_ payload: String) -> Result<ConnectionAddress.Parsed, ConnectionAddress.Failure>? {
        if accepted { return nil }
        switch ConnectionAddress.parse(payload, mode: .scan) {
        case .success(let parsed):
            accepted = true
            return .success(parsed)
        case .failure(let failure):
            return .failure(failure)
        }
    }
}

/// Camera outcomes that the scanner UI must present without bypassing permission.
public enum ConnectionCameraAvailability: String, Equatable, Sendable {
    case ready
    case notDetermined
    case denied
    case restricted
    case noCamera
    case noQR
    case unavailable

    public var canStartSession: Bool { self == .ready }
    public var shouldRequestAccess: Bool { self == .notDetermined }

    public var message: String {
        switch self {
        case .ready, .notDetermined:
            return ""
        case .denied:
            return "Camera access is off. Enter the Phone access address instead, or allow Camera in Settings."
        case .restricted:
            return "Camera is restricted on this device. Enter the Phone access address instead."
        case .noCamera:
            return "This device has no camera. Enter the Phone access address instead."
        case .noQR:
            return "This camera cannot read QR codes. Enter the Phone access address instead."
        case .unavailable:
            return "The camera is not available. Enter the Phone access address instead."
        }
    }

    public static func classify(
        authorized: Bool,
        denied: Bool,
        restricted: Bool,
        notDetermined: Bool,
        hasCamera: Bool,
        supportsQR: Bool = true
    ) -> Self {
        if !hasCamera { return .noCamera }
        if !supportsQR { return .noQR }
        if restricted { return .restricted }
        if denied { return .denied }
        if notDetermined { return .notDetermined }
        if authorized { return .ready }
        return .unavailable
    }
}

/// Desired capture-session state. Late permission callbacks after dismiss do
/// not start the camera; background stops it; foreground/interruption recover
/// only while the scanner is still visible.
public struct ConnectionCaptureLifecycle: Equatable, Sendable {
    public enum Phase: String, Equatable, Sendable {
        case idle
        case awaitingPermission
        case readyToRun
        case running
        case backgrounded
        case interrupted
        case dismissed
        case unavailable
    }

    public private(set) var phase: Phase
    public private(set) var desiredVisible: Bool

    public init(phase: Phase = .idle, desiredVisible: Bool = false) {
        self.phase = phase
        self.desiredVisible = desiredVisible
    }

    public var shouldRunSession: Bool {
        desiredVisible && (phase == .readyToRun || phase == .running)
    }

    public mutating func appear() {
        guard phase != .dismissed else { return }
        desiredVisible = true
        switch phase {
        case .idle, .awaitingPermission:
            phase = .awaitingPermission
        case .backgrounded, .interrupted:
            phase = .readyToRun
        case .readyToRun, .running, .unavailable, .dismissed:
            break
        }
    }

    public mutating func disappear() {
        desiredVisible = false
        if phase == .dismissed || phase == .unavailable { return }
        phase = .idle
    }

    public mutating func dismiss() {
        desiredVisible = false
        phase = .dismissed
    }

    /// Late callbacks after dismiss or hide return nil and do not start capture.
    public mutating func applyAvailability(_ availability: ConnectionCameraAvailability) -> ConnectionCameraAvailability? {
        guard desiredVisible, phase != .dismissed else { return nil }
        if availability.shouldRequestAccess {
            phase = .awaitingPermission
            return nil
        }
        if !availability.canStartSession {
            phase = .unavailable
            return availability
        }
        phase = .readyToRun
        return nil
    }

    public mutating func markRunning() {
        guard desiredVisible, phase != .dismissed, phase == .readyToRun || phase == .running else { return }
        phase = .running
    }

    public mutating func enterBackground() {
        if phase == .running || phase == .readyToRun {
            phase = .backgrounded
        }
    }

    public mutating func enterForeground() {
        guard desiredVisible, phase == .backgrounded else { return }
        phase = .readyToRun
    }

    public mutating func interrupt() {
        if phase == .running { phase = .interrupted }
    }

    public mutating func endInterruption() {
        guard desiredVisible, phase == .interrupted else { return }
        phase = .readyToRun
    }
}
