import Foundation

public struct ConnectionProfile: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var address: String
    public var autoReconnect: Bool

    public init(id: String, name: String, address: String, autoReconnect: Bool = false) {
        self.id = id
        self.name = name
        self.address = address
        self.autoReconnect = autoReconnect
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        address = try container.decode(String.self, forKey: .address)
        autoReconnect = try container.decodeIfPresent(Bool.self, forKey: .autoReconnect) ?? false
    }
}

/// Saved-profile and launch reconnect policy. Persistence and Keychain stay in the app.
public struct ConnectionSessionState: Equatable, Sendable {
    public var profiles: [ConnectionProfile]
    public var selectedID: String?
    public var lastAutoReconnectID: String?
    public var connecting: Bool
    /// Set by an explicit disconnect or removal so the same launch cannot reconnect.
    public var manualHold: Bool

    public init(
        profiles: [ConnectionProfile] = [],
        selectedID: String? = nil,
        lastAutoReconnectID: String? = nil,
        connecting: Bool = false,
        manualHold: Bool = false
    ) {
        self.profiles = profiles
        self.selectedID = selectedID
        self.lastAutoReconnectID = lastAutoReconnectID
        self.connecting = connecting
        self.manualHold = manualHold
    }

    public func profile(id: String) -> ConnectionProfile? {
        profiles.first { $0.id == id }
    }

    public mutating func upsert(_ profile: ConnectionProfile) {
        profiles.removeAll { $0.id == profile.id }
        profiles.append(profile)
    }

    public mutating func setAutoReconnect(profileID: String, enabled: Bool) {
        guard let index = profiles.firstIndex(where: { $0.id == profileID }) else { return }
        profiles[index].autoReconnect = enabled
        if enabled {
            lastAutoReconnectID = profileID
        } else if lastAutoReconnectID == profileID {
            lastAutoReconnectID = nil
        }
    }

    public mutating func markSuccessfulConnection(_ profile: ConnectionProfile) {
        upsert(profile)
        selectedID = profile.id
        connecting = false
        manualHold = false
        lastAutoReconnectID = profile.autoReconnect ? profile.id : nil
    }

    public mutating func disconnect(profileID: String? = nil) {
        let target = profileID ?? selectedID
        connecting = false
        selectedID = nil
        manualHold = true
        if let target, let index = profiles.firstIndex(where: { $0.id == target }) {
            profiles[index].autoReconnect = false
        }
        if lastAutoReconnectID == target { lastAutoReconnectID = nil }
    }

    public mutating func remove(profileID: String, inFlight: Bool = false) {
        let wasSelected = selectedID == profileID
        profiles.removeAll { $0.id == profileID }
        if lastAutoReconnectID == profileID { lastAutoReconnectID = nil }
        if wasSelected || inFlight {
            selectedID = nil
            connecting = false
            manualHold = true
        }
    }

    public func launchReconnectProfileID(arguments: [String]) -> String? {
        if ConnectionLaunchPolicy.ignoresAutomaticReconnect(arguments) { return nil }
        if manualHold || connecting || selectedID != nil { return nil }
        guard let id = lastAutoReconnectID, let profile = profile(id: id), profile.autoReconnect else {
            return nil
        }
        return id
    }
}

public enum ConnectionLaunchPolicy: Sendable {
    public static func ignoresAutomaticReconnect(_ arguments: [String]) -> Bool {
        arguments.contains("--uitesting")
            || arguments.contains(where: { $0.hasPrefix("--connection-preview") })
    }
}

public enum ConnectionTokenReuse: Sendable {
    /// Explicit token is for this connect attempt's address only. A stored token
    /// is reused only when the saved profile still points at the same origin.
    public static func tokenToSend(
        explicit: String,
        stored: String?,
        storedAddress: String?,
        requestedAddress: String
    ) -> String {
        let supplied = explicit.trimmingCharacters(in: .whitespacesAndNewlines)
        if !supplied.isEmpty { return supplied }
        guard let stored, !stored.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let storedAddress, sameOrigin(storedAddress, requestedAddress) else {
            return ""
        }
        return stored
    }

    public static func sameOrigin(_ lhs: String, _ rhs: String) -> Bool {
        guard case .success(let left) = ConnectionAddress.parse(lhs),
              case .success(let right) = ConnectionAddress.parse(rhs) else {
            return false
        }
        return left.origin == right.origin
    }
}

public struct ConnectionConnectRequest: Equatable, Sendable {
    public let id: UInt64
    public let profileID: String?
    public let address: String
    public let name: String
    public let explicitToken: String

    public init(id: UInt64, profileID: String?, address: String, name: String, explicitToken: String) {
        self.id = id
        self.profileID = profileID
        self.address = address
        self.name = name
        self.explicitToken = explicitToken
    }
}

/// Generation and active-target tracking so a late preflight cannot publish
/// after an explicit disconnect, removal, or newer connect.
public struct ConnectionCoordinator: Equatable, Sendable {
    public var session: ConnectionSessionState
    public private(set) var current: ConnectionConnectRequest?
    public private(set) var removedIDs: Set<String>
    private var nextID: UInt64

    public init(session: ConnectionSessionState = ConnectionSessionState()) {
        self.session = session
        current = nil
        removedIDs = []
        nextID = 1
    }

    public mutating func startConnect(address: String, name: String, token: String, profileID: String?) -> ConnectionConnectRequest {
        let request = ConnectionConnectRequest(
            id: nextID, profileID: profileID, address: address, name: name, explicitToken: token
        )
        nextID += 1
        current = request
        session.connecting = true
        return request
    }

    public func isActive(_ request: ConnectionConnectRequest) -> Bool {
        guard current?.id == request.id else { return false }
        if let id = request.profileID, removedIDs.contains(id) { return false }
        return true
    }

    public mutating func disconnect() {
        current = nil
        session.disconnect()
    }

    public mutating func remove(profileID: String) {
        let inFlight = current?.profileID == profileID
        if inFlight || session.selectedID == profileID {
            current = nil
        }
        removedIDs.insert(profileID)
        session.remove(profileID: profileID, inFlight: inFlight)
    }

    public mutating func finish(_ request: ConnectionConnectRequest, profile: ConnectionProfile) -> Bool {
        guard isActive(request) else { return false }
        session.markSuccessfulConnection(profile)
        current = nil
        return true
    }

    public mutating func abandonIfCurrent(_ request: ConnectionConnectRequest) {
        if current?.id == request.id {
            session.connecting = false
            current = nil
        }
    }
}

public enum ConnectionIdentity: Sendable {
    /// Direct bearer for the first GET /health, only for this selected origin.
    /// Gateway access is a separate client configuration and is never mixed here.
    public static func directBearer(token: String, selected: ConnectionAddress.Parsed) -> String? {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard case .success(let parsed) = ConnectionAddress.parse(selected.url.absoluteString),
              parsed.origin == selected.origin else {
            return nil
        }
        return trimmed
    }
}
