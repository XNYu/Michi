import Foundation

/// GET-only connection diagnosis: identity, persistence capabilities, then
/// authenticated workspace hydration. Failures stop the later requests.
public enum ConnectionPreflight: Sendable {
    public enum Stage: String, Sendable, CaseIterable, Comparable {
        case identity
        case capabilities
        case workspaces

        public var title: String {
            switch self {
            case .identity: return "Checking the server"
            case .capabilities: return "Checking conversation saving"
            case .workspaces: return "Loading workspaces"
            }
        }

        public static func < (lhs: Self, rhs: Self) -> Bool {
            allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
        }
    }

    public enum FailureKind: String, Sendable {
        /// A web page or a blocked cross-origin redirect. Not a confirmed SSO proof.
        case webPageOrBlockedRedirect
        case unauthorized
        case forbidden
        case unavailable
        case outdatedBackend
        /// Prepared gateway access is past its local expiry. Not a network failure.
        case gatewayAccessExpired
        /// The client cannot form a native request. Not a network failure.
        case invalidConfiguration
    }

    public struct Failure: Error, Equatable, Sendable, LocalizedError {
        public let stage: Stage
        public let kind: FailureKind
        public let message: String
        public var errorDescription: String? { message }
    }

    public struct Success: Equatable, Sendable {
        public let capabilities: JSONValue
        public let workspaces: JSONValue

        public init(capabilities: JSONValue, workspaces: JSONValue) {
            self.capabilities = capabilities
            self.workspaces = workspaces
        }
    }

    public enum Result: Equatable, Sendable {
        case success(Success)
        case failure(Failure)
    }

    public static let browserSessionGuidance =
        "Signing in with a browser does not transfer that session into this app. Company-managed connections need a supported native integration."

    public static func classified(_ kind: FailureKind, stage: Stage) -> Failure {
        Failure(stage: stage, kind: kind, message: message(for: kind))
    }

    public static func run(
        identity: MichiAPI,
        authenticated: MichiAPI,
        onStage: ((Stage) async -> Void)? = nil
    ) async -> Result {
        var stage = Stage.identity
        do {
            if let onStage { await onStage(.identity) }
            let health = try await identity.request("/health")
            guard health["service"].stringValue == "michi-backend" else {
                return .failure(Failure(
                    stage: .identity,
                    kind: .unavailable,
                    message: "This address did not identify itself as a Michi backend."
                ))
            }

            stage = .capabilities
            if let onStage { await onStage(.capabilities) }
            let capabilities = try await authenticated.request("/persistence/capabilities")
            guard case .object = capabilities,
                  capabilities["explicitCommands"].boolValue,
                  capabilities["authoritativeTurnPersistence"].boolValue,
                  (try? MichiStreamTransport.supportsWebSocket(capabilities)) != nil else {
                return .failure(classified(.outdatedBackend, stage: .capabilities))
            }

            stage = .workspaces
            if let onStage { await onStage(.workspaces) }
            let workspaces = try await authenticated.request("/workspaces/all?meta=1")
            guard case .array = workspaces["workspaces"] else {
                return .failure(Failure(
                    stage: .workspaces,
                    kind: .unavailable,
                    message: "The address did not return a Michi workspace response."
                ))
            }
            return .success(Success(capabilities: capabilities, workspaces: workspaces))
        } catch {
            return .failure(classify(error, stage: stage))
        }
    }

    static func message(for kind: FailureKind) -> String {
        switch kind {
        case .webPageOrBlockedRedirect:
            return "This address returned a web page or sent the app to a different site. \(browserSessionGuidance)"
        case .unauthorized:
            return "This server requires authentication that the app does not have. \(browserSessionGuidance)"
        case .forbidden:
            return "This server refused access. The native app cannot use a browser session to continue. Company-managed connections need a supported native integration."
        case .unavailable:
            return "The app could not reach a compatible Michi server. Check the address and network, and keep the computer running Michi."
        case .outdatedBackend:
            return "This backend needs an update before the native app can safely save conversations."
        case .gatewayAccessExpired:
            return "The prepared gateway access credential has expired. An approved native integration must renew it before connecting."
        case .invalidConfiguration:
            return "This connection is not configured for a native request. That is a local configuration problem."
        }
    }

    private static func classify(_ error: Error, stage: Stage) -> Failure {
        if error is CancellationError {
            return classified(.unavailable, stage: stage)
        }
        guard let api = error as? MichiAPIError else {
            return classified(.unavailable, stage: stage)
        }
        if api.code == MichiAPIError.Code.htmlResponse || api.code == MichiAPIError.Code.redirectBlocked {
            return classified(.webPageOrBlockedRedirect, stage: stage)
        }
        if api.code == MichiAPIError.Code.gatewayAccessExpired {
            return classified(.gatewayAccessExpired, stage: stage)
        }
        if api.code == MichiAPIError.Code.invalidConfiguration {
            return classified(.invalidConfiguration, stage: stage)
        }
        if api.statusCode == 401 {
            return classified(.unauthorized, stage: stage)
        }
        if api.statusCode == 403 {
            return classified(.forbidden, stage: stage)
        }
        return classified(.unavailable, stage: stage)
    }
}
