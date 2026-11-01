import Foundation

/// Cookie- and credential-isolated sessions for native Michi requests.
///
/// Browser cookies and the shared `URLCredentialStorage` must not survive a
/// profile switch. `protocolClasses` from an injected configuration are copied
/// so in-process fixtures keep working. This helper never reads or clears the
/// process-wide cookie store.
public enum MichiIsolatedSession {
    public static func configuration(copying source: URLSessionConfiguration? = nil) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        if let source {
            configuration.protocolClasses = source.protocolClasses
        }
        applyIsolation(to: configuration)
        return configuration
    }

    public static func applyIsolation(to configuration: URLSessionConfiguration) {
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
    }

    public static func make(copying source: URLSessionConfiguration? = nil) -> URLSession {
        URLSession(configuration: configuration(copying: source))
    }
}
