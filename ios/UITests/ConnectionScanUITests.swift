import XCTest

final class ConnectionScanUITests: XCTestCase {
    private func retainScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launchConnection(_ extra: [String]) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = extra
        app.launch()
        return app
    }

    func testScanUnavailableShowsManualAddressFallback() {
        let app = launchConnection(["--connection-preview", "--connection-scan-unavailable"])
        let scan = app.buttons["connection-scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 10))
        scan.tap()
        let manual = app.buttons["connection-scan-manual"]
        XCTAssertTrue(manual.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Enter the Phone access address")).firstMatch.exists)
        retainScreenshot(app, name: "connection-scanner-unavailable")
        manual.tap()
        XCTAssertTrue(app.textFields["connection-address"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["connect"].exists)
        XCTAssertFalse(app.alerts["Use this computer?"].exists)
    }

    func testInjectedScanPayloadConfirmsNormalizedDestinationWithoutConnecting() {
        let app = launchConnection([
            "--connection-preview",
            "--connection-scan-payload=https://desktop.example.test:8443/",
        ])
        let scan = app.buttons["connection-scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 10))
        scan.tap()
        let alert = app.alerts["Use this computer?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "desktop.example.test:8443")).firstMatch.exists)
        retainScreenshot(app, name: "connection-scan-confirmation-fixture")
        alert.buttons["Use this address"].tap()
        let field = app.textFields["connection-address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "https://desktop.example.test:8443")
        XCTAssertTrue(app.buttons["connect"].exists)
        XCTAssertFalse(app.tabBars.buttons["Home"].exists)
    }

    func testCancelledScanConfirmationDoesNotResurfaceUntilNextScan() {
        let app = launchConnection([
            "--connection-preview",
            "--connection-scan-payload=https://desktop.example.test:8443/",
        ])
        let scan = app.buttons["connection-scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 10))
        scan.tap()
        let alert = app.alerts["Use this computer?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        retainScreenshot(app, name: "connection-scan-confirmation-before-cancel")
        alert.buttons["Cancel"].tap()

        let field = app.textFields["connection-address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertFalse(app.alerts["Use this computer?"].exists)
        XCTAssertEqual(field.value as? String, "https://michi.example.test")
        XCTAssertTrue(app.buttons["connect"].exists)
        XCTAssertFalse(app.tabBars.buttons["Home"].exists)

        scan.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "desktop.example.test:8443")).firstMatch.exists)
        retainScreenshot(app, name: "connection-scan-confirmation-after-repeat")
        alert.buttons["Use this address"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "https://desktop.example.test:8443")
        XCTAssertTrue(app.buttons["connect"].exists)
        XCTAssertFalse(app.tabBars.buttons["Home"].exists)
    }
}
