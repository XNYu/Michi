import Foundation
import Security
import SwiftUI
import MichiCore

protocol ConnectionCredentialVault: AnyObject {
    func read(_ id: String) -> String?
    func save(_ token: String, id: String) throws
    func remove(_ id: String)
}

enum CredentialStore {
    private static let service = "app.michi.ios.connection"
    static func read(_ id: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: id,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ token: String, id: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: id]
        if token.isEmpty { SecItemDelete(query as CFDictionary); return }
        let attrs: [String: Any] = [kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attrs) { _, value in value } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw NativeFailure("Unable to save connection credentials in Keychain (\(status)).") }
    }
    static func remove(_ id: String) { try? save("", id: id) }
}

final class KeychainCredentialVault: ConnectionCredentialVault {
    func read(_ id: String) -> String? { CredentialStore.read(id) }
    func save(_ token: String, id: String) throws { try CredentialStore.save(token, id: id) }
    func remove(_ id: String) { CredentialStore.remove(id) }
}

final class MemoryCredentialVault: ConnectionCredentialVault {
    private var tokens: [String: String] = [:]
    func read(_ id: String) -> String? { tokens[id] }
    func save(_ token: String, id: String) throws {
        if token.isEmpty { tokens.removeValue(forKey: id) } else { tokens[id] = token }
    }
    func remove(_ id: String) { tokens.removeValue(forKey: id) }
}

typealias ConnectionPreflightHandler = @Sendable (
    _ identity: MichiAPI,
    _ authenticated: MichiAPI,
    _ onStage: (@Sendable (ConnectionPreflight.Stage) async -> Void)?
) async -> ConnectionPreflight.Result

#if DEBUG
enum ConnectionStoreTesting {
    static var uiTestingFactory: (() -> (MichiAPI, ConnectionProfile))?
}
#endif

@MainActor final class ConnectionStore: ObservableObject {
    @Published var profiles: [ConnectionProfile] = []
    @Published var selected: ConnectionProfile?
    @Published var api: MichiAPI?
    @Published var connecting = false
    @Published var error: String?
    @Published var preflightStage: ConnectionPreflight.Stage?
    #if DEBUG
    @Published var previewReady = false
    #endif
    private var coordinator = ConnectionCoordinator()
    private var connectTask: Task<Void, Never>?
    private let defaults: UserDefaults
    private let processArguments: [String]
    private let credentials: ConnectionCredentialVault
    private let urlSession: URLSession?
    private let preflight: ConnectionPreflightHandler?
    private static let profilesKey = "michi.connections.v1"
    private static let autoReconnectKey = "michi.connections.autoReconnect.v1"

    init(
        defaults: UserDefaults = .standard,
        arguments: [String] = ProcessInfo.processInfo.arguments,
        credentials: ConnectionCredentialVault = KeychainCredentialVault(),
        urlSession: URLSession? = nil,
        preflight: ConnectionPreflightHandler? = nil,
        startLaunchReconnect: Bool = true
    ) {
        self.defaults = defaults
        self.processArguments = arguments
        self.credentials = credentials
        self.urlSession = urlSession
        self.preflight = preflight
        if let data = defaults.data(forKey: Self.profilesKey) {
            coordinator.session.profiles = (try? JSONDecoder().decode([ConnectionProfile].self, from: data)) ?? []
        }
        coordinator.session.lastAutoReconnectID = defaults.string(forKey: Self.autoReconnectKey)
        publishSession()
        #if DEBUG
        if arguments.contains("--uitesting"), let factory = ConnectionStoreTesting.uiTestingFactory {
            let fixture = factory()
            api = fixture.0
            selected = fixture.1
            coordinator.session.selectedID = fixture.1.id
            coordinator.session.manualHold = true
            return
        } else if ConnectionPreview.active(arguments) {
            applyConnectionPreviewIfNeeded()
            return
        }
        #endif
        if startLaunchReconnect, coordinator.session.launchReconnectProfileID(arguments: arguments) != nil {
            Task { await restoreOnLaunch() }
        }
    }

    func connect(address: String, name: String, token: String, profileID: String? = nil) async {
        let request = coordinator.startConnect(address: address, name: name, token: token, profileID: profileID)
        connecting = true
        error = nil
        preflightStage = nil
        connectTask?.cancel()
        let task = Task { await performConnect(request) }
        connectTask = task
        await task.value
    }

    func connect(_ profile: ConnectionProfile) async {
        await connect(address: profile.address, name: profile.name, token: "", profileID: profile.id)
    }

    func disconnect() {
        connectTask?.cancel()
        connectTask = nil
        let previous = api
        api = nil
        error = nil
        preflightStage = nil
        connecting = false
        coordinator.disconnect()
        persist()
        publishSession()
        Task { await previous?.closeStreams() }
    }

    func remove(_ profile: ConnectionProfile) {
        let inFlight = coordinator.current?.profileID == profile.id
        let wasSelected = selected?.id == profile.id || coordinator.session.selectedID == profile.id
        if inFlight || wasSelected {
            connectTask?.cancel()
            connectTask = nil
            let previous = api
            api = nil
            error = nil
            preflightStage = nil
            connecting = false
            Task { await previous?.closeStreams() }
        }
        coordinator.remove(profileID: profile.id)
        credentials.remove(profile.id)
        persist()
        publishSession()
    }

    func setAutoReconnect(_ profile: ConnectionProfile, enabled: Bool) {
        coordinator.session.setAutoReconnect(profileID: profile.id, enabled: enabled)
        persist()
        publishSession()
    }

    private func restoreOnLaunch() async {
        guard let id = coordinator.session.launchReconnectProfileID(arguments: processArguments),
              let profile = coordinator.session.profile(id: id) else { return }
        await connect(profile)
    }

    private func stillActive(_ request: ConnectionConnectRequest) -> Bool {
        coordinator.isActive(request)
    }

    private func performConnect(_ request: ConnectionConnectRequest) async {
        #if DEBUG
        if ConnectionPreview.active(processArguments) {
            applyConnectionPreviewIfNeeded()
            return
        }
        #endif
        guard stillActive(request) else {
            if coordinator.current?.id == request.id {
                connecting = false
                coordinator.abandonIfCurrent(request)
            }
            return
        }
        defer {
            if coordinator.current?.id == request.id {
                connecting = false
                coordinator.abandonIfCurrent(request)
            }
        }
        do {
            let parsed: ConnectionAddress.Parsed
            switch ConnectionAddress.parse(request.address) {
            case .success(let value):
                parsed = value
            case .failure(let failure):
                throw NativeFailure(failure.message(scanned: false))
            }
            guard stillActive(request) else { return }
            let stored = request.profileID.flatMap(credentials.read)
            let storedAddress = request.profileID.flatMap { id in coordinator.session.profile(id: id)?.address }
            let tokenToUse = ConnectionTokenReuse.tokenToSend(
                explicit: request.explicitToken,
                stored: stored,
                storedAddress: storedAddress,
                requestedAddress: parsed.url.absoluteString
            )
            let bearer = ConnectionIdentity.directBearer(token: tokenToUse, selected: parsed)
            let sessionClient = urlSession ?? MichiIsolatedSession.make()
            let probe = MichiAPI(baseURL: parsed.url, bearerToken: bearer, session: sessionClient)
            let transport = MichiStreamTransport()
            let client = MichiAPI(baseURL: parsed.url, bearerToken: bearer, session: sessionClient, streamTransport: transport)
            let runner = preflight ?? { identity, authenticated, onStage in
                await ConnectionPreflight.run(identity: identity, authenticated: authenticated, onStage: onStage)
            }
            let result = await runner(probe, client) { [weak self] stage in
                guard let store = self else { return }
                await MainActor.run {
                    guard store.stillActive(request) else { return }
                    store.preflightStage = stage
                }
            }
            guard stillActive(request) else { return }
            switch result {
            case .success(let success):
                try await transport.configure(capabilities: success.capabilities)
            case .failure(let failure):
                guard stillActive(request) else { return }
                preflightStage = failure.stage
                throw failure
            }
            guard stillActive(request) else { return }
            let existing = request.profileID.flatMap { id in coordinator.session.profile(id: id) }
            let profile = ConnectionProfile(
                id: request.profileID ?? UUID().uuidString,
                name: request.name.isEmpty ? parsed.host : request.name,
                address: parsed.url.absoluteString,
                autoReconnect: existing?.autoReconnect ?? false
            )
            if let previous = api { await previous.closeStreams() }
            guard stillActive(request) else { return }
            // Keep credential persistence and profile publication in one actor turn.
            try credentials.save(tokenToUse, id: profile.id)
            guard stillActive(request) else {
                credentials.remove(profile.id)
                return
            }
            guard coordinator.finish(request, profile: profile) else { return }
            connecting = false
            persist()
            publishSession()
            selected = profile
            api = client
        } catch {
            guard stillActive(request) else { return }
            self.error = error.localizedDescription
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(coordinator.session.profiles) {
            defaults.set(data, forKey: Self.profilesKey)
        }
        if let id = coordinator.session.lastAutoReconnectID {
            defaults.set(id, forKey: Self.autoReconnectKey)
        } else {
            defaults.removeObject(forKey: Self.autoReconnectKey)
        }
        profiles = coordinator.session.profiles
    }

    private func publishSession() {
        profiles = coordinator.session.profiles
        if let id = coordinator.session.selectedID {
            selected = coordinator.session.profile(id: id) ?? selected
        } else if api == nil {
            selected = nil
        }
    }

    #if DEBUG
    private func applyConnectionPreviewIfNeeded() {
        guard ConnectionPreview.active(processArguments) else { return }
        previewReady = false
        connecting = false
        error = nil
        preflightStage = nil
        coordinator.session.manualHold = true
        let args = processArguments
        if args.contains("--connection-preview-success") {
            preflightStage = .workspaces
            previewReady = true
        } else if args.contains("--connection-preview-failure-webpage") {
            applyPreviewFailure(.webPageOrBlockedRedirect, stage: .identity)
        } else if args.contains("--connection-preview-failure-unauthorized") {
            applyPreviewFailure(.unauthorized, stage: .capabilities)
        } else if args.contains("--connection-preview-failure-forbidden") {
            applyPreviewFailure(.forbidden, stage: .capabilities)
        } else if args.contains("--connection-preview-failure-unavailable") {
            applyPreviewFailure(.unavailable, stage: .identity)
        } else if args.contains("--connection-preview-failure-outdated") {
            applyPreviewFailure(.outdatedBackend, stage: .capabilities)
        }
    }

    private func applyPreviewFailure(_ kind: ConnectionPreflight.FailureKind, stage: ConnectionPreflight.Stage) {
        let failure = ConnectionPreflight.classified(kind, stage: stage)
        preflightStage = failure.stage
        error = failure.message
    }
    #endif
}

#if DEBUG
enum ConnectionPreview {
    static func active(_ arguments: [String]) -> Bool {
        !arguments.contains("--uitesting") && arguments.contains(where: { $0.hasPrefix("--connection-preview") })
    }
}
#endif
