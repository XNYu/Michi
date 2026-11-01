import XCTest

final class MichiUITests: XCTestCase {
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launchArguments = ["--uitesting"] + extra; app.launch(); return app
    }
    /// Home is the first tab; workspaces and thread trees live in Chats.
    private func openChats(_ app: XCUIApplication) {
        let tab = app.tabBars.buttons["Chats"]
        XCTAssertTrue(tab.waitForExistence(timeout: 15)); tab.tap()
    }
    func testNativeNavigationAndConversation() {
        let app = launch()
        openChats(app)
        XCTAssertTrue(app.buttons["thread-n-preview"].waitForExistence(timeout: 15))
        app.buttons["thread-n-preview"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "composer").firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["branches"].exists)
        app.buttons["branches"].tap()
        XCTAssertTrue(app.navigationBars["Branches"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "composer").firstMatch.exists)
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testStreamingPermissionAndDurableReply() {
        let app = launch()
        openChats(app)
        let conversation = app.buttons["thread-n-preview"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 15)); conversation.tap()
        let composer = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10)); composer.tap(); composer.typeText("Check the native app")
        app.buttons["send-message"].tap()
        let approve = app.buttons["Allow once"]
        XCTAssertTrue(approve.waitForExistence(timeout: 15)); approve.tap()
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Your native interface is ready")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["stop-response"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Native conversation after approval"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    func testCreateWorkspace() {
        let app = launch()
        openChats(app)
        XCTAssertTrue(app.buttons["chat-menu"].waitForExistence(timeout: 15)); app.buttons["chat-menu"].tap()
        app.buttons["New workspace"].tap()
        let field = app.textFields["workspace-name"]; XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("iOS acceptance")
        app.buttons["save-workspace"].tap()
        // The workspace appears as a Chats group header (a button that makes it current).
        XCTAssertTrue(app.buttons["iOS acceptance"].waitForExistence(timeout: 10) || app.staticTexts["iOS acceptance"].waitForExistence(timeout: 10))
    }
    func testHydrationFailureDoesNotBecomeEmptyWorkspace() {
        let app = launch(["--fail-hydration"])
        openChats(app)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Fixture backend unavailable")).firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["New workspace"].exists)
        XCTAssertFalse(app.buttons["new-conversation"].exists)
    }
    func testFeatureTabsAreNative() {
        let app = launch()
        for title in ["Home", "Chats", "Pages", "Scheduled", "Search"] {
            let tab = app.tabBars.buttons[title]; XCTAssertTrue(tab.waitForExistence(timeout: 10)); tab.tap()
            XCTAssertEqual(app.webViews.count, 0)
        }
    }
    func testWorkspaceArchiveAndTrashAreNative() {
        let app = launch()
        openChats(app)
        XCTAssertTrue(app.buttons["chat-menu"].waitForExistence(timeout: 15))
        app.buttons["chat-menu"].tap(); app.buttons["Workspaces"].tap()
        XCTAssertTrue(app.navigationBars["Workspaces"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testNativeContextPickerAndStructuredQuote() {
        let app = launch(["--preview-chat", "--preview-composer"])
        XCTAssertTrue(app.buttons["Remove quote"].waitForExistence(timeout: 15))
        app.buttons["Add context"].tap(); app.buttons["Mention a chat or file"].tap()
        XCTAssertTrue(app.navigationBars["Add a reference"].waitForExistence(timeout: 10))
        app.buttons["Project notes"].tap()
        XCTAssertTrue(app.buttons["Remove quote"].exists)
        let field = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        XCTAssertTrue((field.value as? String ?? "").contains("@Project notes"))
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testNativeAppearanceForm() {
        let app = launch(["--preview-settings"])
        XCTAssertTrue(app.buttons["Appearance"].waitForExistence(timeout: 15))
        app.buttons["Appearance"].tap()
        XCTAssertTrue(app.navigationBars["Appearance"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.switches["Wrap long code lines"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    // These cases compile with build-for-testing. This host's DTServiceHub
    // failure prevents executing them; they are not counted as passing tests.
    func testHomeContentsOpensExactNativePageTarget() {
        let app = launch(["--preview-home-navigation"])
        let toc = app.buttons["page-nav-toc-start-heading"]
        XCTAssertTrue(toc.waitForExistence(timeout: 15))
        toc.tap()
        let target = app.descendants(matching: .any).matching(identifier: "page-nav-block-start-heading").firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10))
        XCTAssertTrue(target.isHittable)
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testNativePageJumpMaterializesDistantTarget() {
        let app = launch(["--preview-navigation"])
        let target = app.staticTexts["The requested destination"]
        XCTAssertTrue(target.waitForExistence(timeout: 15))
        XCTAssertTrue(target.isHittable)
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testNativeMarkdownJumpReachesTheActualInnerHeading() {
        let app = launch(["--preview-navigation-markdown"])
        let target = app.staticTexts["A deeper heading"]
        XCTAssertTrue(target.waitForExistence(timeout: 15))
        let predicate = NSPredicate { _, _ in target.isHittable && target.frame.minY < app.frame.height / 2 }
        expectation(for: predicate, evaluatedWith: nil)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testNativePageJumpRevealsSecondTab() {
        let app = launch(["--preview-navigation-tab"])
        let target = app.staticTexts["Inside the second tab"]
        XCTAssertTrue(target.waitForExistence(timeout: 15))
        XCTAssertTrue(target.isHittable)
    }
    func testNativePageJumpRevealsToggle() {
        let app = launch(["--preview-navigation-toggle"])
        let target = app.staticTexts["Inside the toggle"]
        XCTAssertTrue(target.waitForExistence(timeout: 15))
        XCTAssertTrue(target.isHittable)
    }
    func testTableCopyAndFullscreenKeepNativeUI() {
        let app = launch(["--preview-chat", "--preview-table"])
        let copy = app.buttons["table.copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 15)); copy.tap()
        XCTAssertTrue(app.staticTexts["Copied the complete table as Markdown."].waitForExistence(timeout: 5))
        app.buttons["table.fullscreen"].tap()
        XCTAssertTrue(app.navigationBars["Table"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.webViews.count, 0)
    }
    /// Composer chips: permission Menu titled for this chat, and the model
    /// popover's summary / runtime list / effort slider (no full-page sheet).
    func testComposerPermissionMenuAndModelPopover() {
        let app = launch(["--preview-chat"])
        let composer = app.descendants(matching: .any).matching(identifier: "composer").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 15)); composer.tap()
        let permissions = app.descendants(matching: .any).matching(identifier: "composer-permissions").firstMatch
        XCTAssertTrue(permissions.waitForExistence(timeout: 10)); permissions.tap()
        let trust = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Trust")).firstMatch
        XCTAssertTrue(trust.waitForExistence(timeout: 5)); trust.tap()
        XCTAssertEqual(permissions.value as? String, "Trust")
        let model = app.descendants(matching: .any).matching(identifier: "composer-model").firstMatch
        XCTAssertTrue(model.waitForExistence(timeout: 5)); model.tap()
        XCTAssertTrue(app.staticTexts["Thinking effort"].waitForExistence(timeout: 10))
        let runtime = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Runtime:")).firstMatch
        XCTAssertTrue(runtime.exists); runtime.tap()
        XCTAssertTrue(app.buttons["Workspace default"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.webViews.count, 0)
    }
    /// A conversation opened from Home is presented once, in Chats.
    func testHomePresentationOpensChatsOnly() {
        let app = launch(["--preview-chat"])
        XCTAssertTrue(app.buttons["branches"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.tabBars.buttons["Chats"].isSelected)
        app.tabBars.buttons["Home"].tap()
        // Home keeps its own overview; it must not hold a second pushed copy.
        XCTAssertFalse(app.buttons["branches"].waitForExistence(timeout: 2))
    }
    func testProviderMediaUsesExplicitExternalEntry() {
        let app = launch(["--preview-provider-video"])
        XCTAssertTrue(app.buttons["Open on YouTube"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Open on Vimeo"].exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

}
