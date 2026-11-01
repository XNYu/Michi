import XCTest

/// Added for the native-reference/provenance flow. Not executed on this host:
/// the existing XCTest runner cannot bootstrap DTServiceHub/lockdown. These
/// cases must not be reported as passing until a working UI-test host runs them.
final class ReferenceParityUITests: XCTestCase {
    private func launch(_ flag: String) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", flag]
        app.launch()
        return app
    }
    private func requireVisible(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 15), file: file, line: line)
        let visible = NSPredicate { _, _ in element.isHittable }
        expectation(for: visible, evaluatedWith: nil)
        waitForExpectations(timeout: 5)
    }
    private func tapMarkdownLink(_ label: String, in app: XCUIApplication) {
        // Text(AttributedString) is exposed as a link on some SDKs and as its
        // standalone paragraph text on others; both tap the actual Markdown.
        let link = app.links[label].firstMatch
        if link.waitForExistence(timeout: 3) { requireVisible(link); link.tap() }
        else { let text = app.staticTexts[label].firstMatch; requireVisible(text); text.tap() }
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<5 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
        requireVisible(element)
    }

    func testExactSavedMessageIsPositionedAmongEarlierAndLaterReplies() {
        let app = launch("--preview-reference-message")
        let target = app.descendants(matching: .any).matching(identifier: "reference-message-source-answer").firstMatch
        requireVisible(target)
        XCTAssertTrue(app.staticTexts["Referenced message"].exists)
        XCTAssertTrue(app.buttons["reference-open-conversation"].exists)
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "composer").firstMatch.exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testHelperReferenceReadsTheExactTurnWithoutActivatingChat() {
        let app = launch("--preview-reference-helper")
        let target = app.descendants(matching: .any).matching(identifier: "reference-message-helper-answer").firstMatch
        requireVisible(target)
        XCTAssertTrue(app.staticTexts["The exact helper evidence from the saved turn."].exists)
        XCTAssertTrue(app.staticTexts["Saved assistant conversation"].exists)
        XCTAssertFalse(app.buttons["reference-open-conversation"].exists)
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "composer").firstMatch.exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testPageReferenceOpensTheRequestedBlockInNativePage() {
        let app = launch("--preview-reference-page")
        let target = app.descendants(matching: .any).matching(identifier: "page-nav-block-source-body").firstMatch
        requireVisible(target)
        XCTAssertTrue(app.navigationBars["Cited native page"].exists)
        XCTAssertTrue(app.staticTexts["Cited conclusion"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testMissingExactMessageNeverFallsBackToNewestReply() {
        let app = launch("--preview-reference-missing")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "reference-unavailable").firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["The exact referenced message is no longer available."].exists)
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "reference-message-source-answer").firstMatch.exists)
        XCTAssertFalse(app.buttons["reference-open-conversation"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testActualMarkdownMichiPageLinkOpensNestedNativeReader() {
        let app = launch("--preview-reference-message")
        requireVisible(app.descendants(matching: .any).matching(identifier: "reference-message-source-answer").firstMatch)
        tapMarkdownLink("Open linked page", in: app)
        requireVisible(app.descendants(matching: .any).matching(identifier: "page-nav-block-source-body").firstMatch)
        XCTAssertTrue(app.navigationBars["Cited native page"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testPageSourcesOpensTheExactOrdinaryPassage() {
        let app = launch("--preview-page-sources")
        let sources = app.descendants(matching: .any).matching(identifier: "page-sources-source-body").firstMatch
        XCTAssertTrue(sources.waitForExistence(timeout: 15))
        reveal(sources, in: app); sources.tap()
        let passage = app.staticTexts["page-source-passage-source-body-0"]
        reveal(passage, in: app)
        XCTAssertEqual(passage.label, "The native page retains exact source passages.")
        let open = app.buttons["page-source-open-source-body-0-0"]
        reveal(open, in: app); open.tap()
        requireVisible(app.descendants(matching: .any).matching(identifier: "reference-message-source-answer").firstMatch)
        XCTAssertTrue(app.staticTexts["Referenced message"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testFocusedTableReferencePreviewHostsTheRealTableComponent() {
        let app = launch("--preview-reference-table")
        XCTAssertTrue(app.navigationBars["Table references"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Nested table references"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "table.fullscreen").firstMatch.exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testMarkdownTableMichiLinkOpensItsExactNativePageBlock() {
        let app = launch("--preview-reference-message")
        requireVisible(app.descendants(matching: .any).matching(identifier: "reference-message-source-answer").firstMatch)
        let link = app.links["Open table page"].firstMatch
        let cell = app.staticTexts["Open table page"].firstMatch
        if link.exists { reveal(link, in: app); link.tap() }
        else { reveal(cell, in: app); cell.tap() }
        requireVisible(app.descendants(matching: .any).matching(identifier: "page-nav-block-source-body").firstMatch)
        XCTAssertTrue(app.navigationBars["Cited native page"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testPageSourcesUsesExactHelperTurnForItsListPassage() {
        let app = launch("--preview-page-sources")
        let sources = app.descendants(matching: .any).matching(identifier: "page-sources-source-body").firstMatch
        XCTAssertTrue(sources.waitForExistence(timeout: 15))
        reveal(sources, in: app); sources.tap()
        let passage = app.staticTexts["page-source-passage-source-body-2"]
        reveal(passage, in: app)
        XCTAssertEqual(passage.label, "- Helper evidence from the saved turn.")
        let open = app.buttons["page-source-open-source-body-2-0"]
        reveal(open, in: app); open.tap()
        requireVisible(app.descendants(matching: .any).matching(identifier: "reference-message-helper-answer").firstMatch)
        XCTAssertFalse(app.buttons["reference-open-conversation"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testSearchTypingAndExactSnippetOpenTheNativeReferencedMessage() {
        let app = launch("--preview-search")
        let field = app.searchFields["Search conversations"]
        requireVisible(field)
        field.tap(); field.typeText(" evidence")
        XCTAssertTrue((field.value as? String ?? "").contains("evidence"))
        if app.keyboards.buttons["Search"].exists { app.keyboards.buttons["Search"].tap() }
        let snippet = app.buttons["search.snippet.n-preview.source-answer"]
        let loading = app.descendants(matching: .any).matching(identifier: "search.loading").firstMatch
        let ready = NSPredicate { _, _ in snippet.exists && snippet.isHittable && !loading.exists }
        expectation(for: ready, evaluatedWith: nil)
        waitForExpectations(timeout: 15)
        snippet.tap()
        requireVisible(app.descendants(matching: .any).matching(identifier: "reference-message-source-answer").firstMatch)
        XCTAssertTrue(app.staticTexts["Referenced message"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }
}
