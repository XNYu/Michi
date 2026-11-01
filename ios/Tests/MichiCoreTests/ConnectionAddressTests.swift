import XCTest
@testable import MichiCore

final class ConnectionAddressTests: XCTestCase {
    private let leakNeedles = [
        "secret-token-xyz",
        "Bearer ",
        "authorization=",
        "user:pass",
        "%40",
    ]

    func testAcceptsDesktopPhoneAccessRootURLs() {
        for raw in [
            "https://michi.tail123.ts.net",
            "https://michi.tail123.ts.net/",
            "https://michi.tail123.ts.net/api",
            "https://michi.tail123.ts.net/api/",
            "  https://desktop.example.test  ",
        ] {
            guard case .success(let parsed) = ConnectionAddress.parse(raw) else {
                return XCTFail("Expected to accept \(raw)")
            }
            XCTAssertEqual(parsed.host, parsed.confirmationHost)
            XCTAssertFalse(parsed.confirmationHost.contains("/"))
            XCTAssertFalse(parsed.url.absoluteString.contains("?"))
            XCTAssertFalse(parsed.url.absoluteString.contains("#"))
            XCTAssertEqual(parsed.origin.hasPrefix("https://"), true)
            assertClean(parsed.confirmationHost)
        }
    }

    func testRejectsCredentialsFragmentsQuerySchemesPathsAndEncodedTricks() {
        let rejected: [(String, ConnectionAddress.Failure)] = [
            ("", .empty),
            ("https://user:pass@michi.tail123.ts.net", .credentials),
            ("https://user@michi.tail123.ts.net", .credentials),
            ("https://user%3Apass@michi.tail123.ts.net", .credentials),
            ("https://michi.tail123.ts.net?next=1", .query),
            ("https://michi.tail123.ts.net/?token=secret-token-xyz", .query),
            ("https://michi.tail123.ts.net#fragment", .fragment),
            ("https://michi.tail123.ts.net/mobile-connect#fixture", .fragment),
            ("http://michi.tail123.ts.net", .unsafeScheme),
            ("javascript:alert(1)", .unsafeScheme),
            ("file:///tmp/michi", .unsafeScheme),
            ("data:text/plain,https://michi.tail123.ts.net", .unsafeScheme),
            ("michi://node/1", .unsafeScheme),
            ("https://michi.tail123.ts.net/mobile-connect", .unsafePath),
            ("https://michi.tail123.ts.net/settings", .unsafePath),
            ("https://michi.tail123.ts.net/%2e%2e", .encodedTrick),
            ("https://michi.tail123.ts.net/%2fadmin", .encodedTrick),
            ("https://michi.tail123.ts.net\\@evil.example", .credentials),
            ("https://michi.tail123.ts.net%40evil.example", .encodedTrick),
            ("https://michi.tail123.ts.net/%00", .encodedTrick),
            (String(repeating: "https://michi.tail123.ts.net/", count: 200), .oversize),
        ]
        for (raw, expected) in rejected {
            guard case .failure(let failure) = ConnectionAddress.parse(raw) else {
                return XCTFail("Expected \(expected) for \(raw.prefix(80))")
            }
            XCTAssertEqual(failure, expected, raw)
            assertClean(failure.message(scanned: true))
            assertClean(failure.message(scanned: false))
            XCTAssertFalse(failure.message(scanned: true).contains(raw))
        }
    }

    func testScanSessionIgnoresDuplicateCallbacksAfterTheFirstValidCode() {
        var session = ConnectionScanSession()
        let first = session.handle("https://michi.tail123.ts.net")
        let duplicate = session.handle("https://michi.tail123.ts.net")
        let other = session.handle("https://other.example.test")
        guard case .success(let parsed) = first else {
            return XCTFail("First valid QR should parse")
        }
        XCTAssertEqual(parsed.host, "michi.tail123.ts.net")
        XCTAssertNil(duplicate)
        XCTAssertNil(other)
        XCTAssertTrue(session.accepted)
    }

    func testScanSessionKeepsListeningAfterARejectedCode() {
        var session = ConnectionScanSession()
        guard case .failure(.credentials) = session.handle("https://user:pass@michi.tail123.ts.net") else {
            return XCTFail("Credential QR should be rejected")
        }
        XCTAssertFalse(session.accepted)
        guard case .success(let parsed) = session.handle("https://michi.tail123.ts.net") else {
            return XCTFail("A later valid QR should still be accepted")
        }
        XCTAssertEqual(parsed.host, "michi.tail123.ts.net")
    }

    func testManualParseKeepsLoopbackAndAPIAliasesWhileScanRejectsThem() {
        XCTAssertNotNil(success("http://127.0.0.1", mode: .manual))
        XCTAssertNotNil(success("https://michi.tail123.ts.net/api", mode: .manual))
        XCTAssertEqual(failure("http://127.0.0.1", mode: .scan), .unsafeScheme)
        XCTAssertEqual(failure("https://michi.tail123.ts.net/api", mode: .scan), .unsafePath)
        XCTAssertEqual(failure("https://michi.tail123.ts.net/api/", mode: .scan), .unsafePath)
    }

    func testScanConfirmationIncludesNondefaultPortAndUnambiguousHost() throws {
        let parsed = try XCTUnwrap(success("https://desktop.example.test:8443/", mode: .scan))
        XCTAssertEqual(parsed.confirmationDestination, "desktop.example.test:8443")
        XCTAssertEqual(parsed.origin, "https://desktop.example.test:8443")
        XCTAssertFalse(parsed.confirmationDestination.contains("secret"))
        let root = try XCTUnwrap(success("https://desktop.example.test", mode: .scan))
        XCTAssertEqual(root.confirmationDestination, "desktop.example.test")
    }

    func testScanSessionUsesScannerRulesNotManualAliases() {
        var session = ConnectionScanSession()
        guard case .failure(.unsafePath) = session.handle("https://michi.tail123.ts.net/api") else {
            return XCTFail("QR must reject /api aliases")
        }
        XCTAssertFalse(session.accepted)
    }

    func testCaptureLifecycleIgnoresLatePermissionAfterDismissAndRecoversForeground() {
        var life = ConnectionCaptureLifecycle()
        life.appear()
        XCTAssertEqual(life.applyAvailability(.notDetermined), nil)
        life.dismiss()
        XCTAssertNil(life.applyAvailability(.ready))
        XCTAssertFalse(life.shouldRunSession)

        life = ConnectionCaptureLifecycle()
        life.appear()
        XCTAssertNil(life.applyAvailability(.ready))
        XCTAssertTrue(life.shouldRunSession)
        life.markRunning()
        life.enterBackground()
        XCTAssertFalse(life.shouldRunSession)
        life.enterForeground()
        XCTAssertTrue(life.shouldRunSession)
        life.markRunning()
        life.interrupt()
        XCTAssertFalse(life.shouldRunSession)
        life.endInterruption()
        XCTAssertTrue(life.shouldRunSession)
        life.disappear()
        XCTAssertFalse(life.shouldRunSession)
        life.enterForeground()
        XCTAssertFalse(life.shouldRunSession)
    }

    func testCaptureLifecycleRejectsMissingQRCapability() {
        XCTAssertEqual(
            ConnectionCameraAvailability.classify(
                authorized: true, denied: false, restricted: false, notDetermined: false,
                hasCamera: true, supportsQR: false
            ),
            .noQR
        )
        var life = ConnectionCaptureLifecycle()
        life.appear()
        XCTAssertEqual(life.applyAvailability(.noQR), .noQR)
        XCTAssertFalse(life.shouldRunSession)
        XCTAssertTrue(ConnectionCameraAvailability.noQR.message.contains("Enter the Phone access address"))
    }

    func testCameraAvailabilityNeverImpliesAPermissionBypass() {
        XCTAssertEqual(
            ConnectionCameraAvailability.classify(
                authorized: false, denied: true, restricted: false, notDetermined: false, hasCamera: true
            ),
            .denied
        )
        XCTAssertEqual(
            ConnectionCameraAvailability.classify(
                authorized: false, denied: false, restricted: true, notDetermined: false, hasCamera: true
            ),
            .restricted
        )
        XCTAssertEqual(
            ConnectionCameraAvailability.classify(
                authorized: true, denied: false, restricted: false, notDetermined: false, hasCamera: false
            ),
            .noCamera
        )
        XCTAssertEqual(
            ConnectionCameraAvailability.classify(
                authorized: false, denied: false, restricted: false, notDetermined: false, hasCamera: true
            ),
            .unavailable
        )
        XCTAssertFalse(ConnectionCameraAvailability.denied.canStartSession)
        XCTAssertFalse(ConnectionCameraAvailability.restricted.canStartSession)
        XCTAssertFalse(ConnectionCameraAvailability.noCamera.canStartSession)
        XCTAssertTrue(ConnectionCameraAvailability.denied.message.contains("Enter the Phone access address"))
        XCTAssertTrue(ConnectionCameraAvailability.notDetermined.shouldRequestAccess)
        XCTAssertTrue(ConnectionCameraAvailability.ready.canStartSession)
    }

    private func success(_ raw: String, mode: ConnectionAddress.Mode = .manual) -> ConnectionAddress.Parsed? {
        if case .success(let parsed) = ConnectionAddress.parse(raw, mode: mode) { return parsed }
        return nil
    }

    private func failure(_ raw: String, mode: ConnectionAddress.Mode) -> ConnectionAddress.Failure? {
        if case .failure(let value) = ConnectionAddress.parse(raw, mode: mode) { return value }
        return nil
    }

    private func assertClean(_ message: String, file: StaticString = #filePath, line: UInt = #line) {
        for needle in leakNeedles {
            XCTAssertFalse(message.localizedCaseInsensitiveContains(needle), message, file: file, line: line)
        }
    }
}
