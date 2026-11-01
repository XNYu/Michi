import XCTest

/// Authored for the native task screens; not executed on this host because the
/// existing XCTest runner cannot bootstrap DTServiceHub/lockdown.
final class TaskUpkeepUITests: XCTestCase {
    private func launch(_ flag: String) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", flag]
        app.launch()
        return app
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<8 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.waitForExistence(timeout: 10), file: file, line: line)
        XCTAssertTrue(element.isHittable, file: file, line: line)
    }

    func testTaskBoardShowsUpkeepMarksAndOpensTheRealTaskRow() {
        let app = launch("--preview-task-board")
        XCTAssertTrue(app.navigationBars["Workspace tasks"].waitForExistence(timeout: 15))
        reveal(app.staticTexts["Meta agent added 1 task and suggested 1 change"].firstMatch, in: app)
        reveal(app.staticTexts["Verify saved sources"].firstMatch, in: app)
        XCTAssertTrue(app.staticTexts["New"].firstMatch.exists)
        let task = app.staticTexts["Review release checklist"].firstMatch
        reveal(task, in: app)
        XCTAssertTrue(app.staticTexts["Suggestion"].firstMatch.exists)
        task.tap()
        XCTAssertTrue(app.navigationBars["Task"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testFocusedProposalPreviewShowsApplyRejectAndOrigin() {
        let app = launch("--preview-task-proposal")
        XCTAssertTrue(app.navigationBars["Task proposal"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Apply proposal"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Reject proposal"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Created by Meta agent from 2 conversations")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testTaskRowShowsPendingReviewActionsAndActualOrigin() {
        let app = launch("--preview-task-upkeep")
        XCTAssertTrue(app.navigationBars["Task"].waitForExistence(timeout: 15))
        let apply = app.buttons["Apply proposal"].firstMatch
        reveal(apply, in: app)
        XCTAssertTrue(apply.isEnabled)
        let reject = app.buttons["Reject proposal"].firstMatch
        reveal(reject, in: app)
        XCTAssertTrue(reject.isEnabled)
        // Inspect the real actions without making a synthetic write appear accepted.
        let origin = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Created by Meta agent from 2 conversations")).firstMatch
        reveal(origin, in: app)
        XCTAssertEqual(app.webViews.count, 0)
    }
}
