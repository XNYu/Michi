import Foundation
import XCTest
@testable import MichiCore

final class IsolatedSessionTests: XCTestCase {
    private let originURL = URL(string: "https://michi.example.test")!

    func testHelperIsolationFlagsAndFreshProfilesDoNotShareStores() {
        let first = MichiIsolatedSession.make()
        let second = MichiIsolatedSession.make()
        defer {
            first.invalidateAndCancel()
            second.invalidateAndCancel()
        }
        assertIsolated(first.configuration)
        assertIsolated(second.configuration)
        XCTAssertFalse(first === second)
        XCTAssertFalse(first.configuration === second.configuration)
        XCTAssertFalse(first === URLSession.shared)
        XCTAssertNil(first.configuration.httpCookieStorage)
        XCTAssertNil(second.configuration.httpCookieStorage)
        XCTAssertNil(first.configuration.urlCredentialStorage)
        XCTAssertNil(second.configuration.urlCredentialStorage)
    }

    func testIsolationCopiesProtocolClassesAndDoesNotUseSharedStores() {
        let source = URLSessionConfiguration.default
        source.httpShouldSetCookies = true
        source.httpCookieAcceptPolicy = .always
        source.httpCookieStorage = .shared
        source.urlCredentialStorage = .shared
        source.protocolClasses = [TransportMockURLProtocol.self]
        let isolated = MichiIsolatedSession.configuration(copying: source)
        assertIsolated(isolated)
        XCTAssertTrue(containsProtocol(TransportMockURLProtocol.self, in: isolated))
        XCTAssertFalse(isolated === source)
        XCTAssertFalse(isolated.httpCookieStorage === HTTPCookieStorage.shared)
        XCTAssertFalse(isolated.urlCredentialStorage === URLCredentialStorage.shared)
    }

    func testDefaultMichiAPISessionIsIsolatedAndExplicitSharedIsReplaced() {
        let plain = MichiAPI(baseURL: originURL)
        XCTAssertFalse(plain.session === URLSession.shared)
        assertIsolated(plain.session.configuration)

        let shared = MichiAPI(baseURL: originURL, session: .shared)
        XCTAssertFalse(shared.session === URLSession.shared)
        assertIsolated(shared.session.configuration)
    }

    func testInjectedFixtureSessionIsPreservedWithoutGateway() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TransportMockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = MichiAPI(baseURL: originURL, session: session)
        XCTAssertTrue(client.session === session)
    }

    func testCopiedProtocolClassesStillServeFixtures() async throws {
        TransportMockURLProtocol.reset()
        defer { TransportMockURLProtocol.reset() }
        let source = URLSessionConfiguration.ephemeral
        source.protocolClasses = [TransportMockURLProtocol.self]
        let session = MichiIsolatedSession.make(copying: source)
        defer { session.invalidateAndCancel() }
        TransportMockURLProtocol.install { _ in
            .respond(status: 200, headers: ["Content-Type": "application/json"], chunks: [.init(#"{"ok":true}"#)])
        }
        let value = try await MichiAPI(baseURL: originURL, session: session).request("/agents")
        XCTAssertTrue(value["ok"].boolValue)
        XCTAssertEqual(TransportMockURLProtocol.requests.count, 1)
    }

    func testHTMLAndRedirectCopyIsNeutralAndDoesNotAskToSignIn() {
        let html = MichiAPI.htmlError(status: 200)
        let redirect = MichiRedirectGuard.crossOriginError(status: 302)
        for message in [html.message, redirect.message] {
            XCTAssertFalse(message.localizedCaseInsensitiveContains("sign in and try"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("sign in first"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("try again"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("SSO"))
            XCTAssertFalse(message.contains("http"))
            XCTAssertFalse(message.contains("<html"))
            XCTAssertTrue(message.localizedCaseInsensitiveContains("browser"))
            XCTAssertTrue(message.localizedCaseInsensitiveContains("native"))
            XCTAssertTrue(message.localizedCaseInsensitiveContains("company-managed")
                          || message.localizedCaseInsensitiveContains("supported native"))
        }
        XCTAssertTrue(html.message.localizedCaseInsensitiveContains("page"))
        XCTAssertTrue(redirect.message.localizedCaseInsensitiveContains("redirect"))
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
