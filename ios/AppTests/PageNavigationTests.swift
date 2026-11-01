import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class PageNavigationTests: XCTestCase {
    private func heading(_ id: String, text: String = "Heading") -> JSONValue {
        ["id": .string(id), "rev": 1, "type": "heading", "text": .string(text)]
    }

    private func markdown(_ id: String, text: String = "Body") -> JSONValue {
        ["id": .string(id), "rev": 1, "type": "markdown", "text": .string(text)]
    }

    private func detail(_ id: String) -> JSONValue {
        ["id": .string(id), "rev": 2, "type": "markdown", "visibility": "detail", "text": "Hidden"]
    }

    private func namedView(_ id: String = "view-definition", viewID: String = "details", blockIDs: [String] = ["hidden-note"]) -> JSONValue {
        ["id": .string(id), "rev": 1, "type": "view", "viewId": .string(viewID), "title": "Details", "blockIds": .array(blockIDs.map(JSONValue.string))]
    }

    private func pageBlocks() -> [JSONValue] {
        [heading("focus", text: "Weekly focus"), markdown("note"), namedView(), detail("hidden-note")]
    }

    private func target(_ decision: PageNavigation.Decision) throws -> PageNavigationTarget {
        guard case .scroll(let target) = decision else {
            XCTFail("expected a same-page scroll, got \(decision)")
            throw NSError(domain: "PageNavigationTests", code: 1)
        }
        return target
    }

    func testOnPageScrollsUniqueMainHeadingWithoutRevealingNamedViews() throws {
        let found = try target(PageNavigation.resolveOnPage(targetID: "focus", blocks: pageBlocks()))
        XCTAssertEqual(found.scrollID, "focus")
        XCTAssertEqual(found.blockID, "focus")
        XCTAssertNil(found.segmentIndex)
        XCTAssertTrue(found.reveals.isEmpty)
        XCTAssertFalse(found.revealNamedViews)
    }

    func testOnPageRevealsUniqueNamedViewAndDetailTargets() throws {
        let hidden = try target(PageNavigation.resolveOnPage(targetID: "hidden-note", blocks: pageBlocks()))
        XCTAssertEqual(hidden.scrollID, "hidden-note")
        XCTAssertTrue(hidden.revealNamedViews)
        let definition = try target(PageNavigation.resolveOnPage(targetID: "view-definition", blocks: pageBlocks()))
        XCTAssertEqual(definition.scrollID, "view-definition")
        XCTAssertTrue(definition.revealNamedViews)
    }

    func testOnPageRejectsEmptyMissingAndDuplicateTargets() throws {
        let blocks = pageBlocks()
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "", blocks: blocks), .rejected(.emptyTarget))
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "   ", blocks: blocks), .rejected(.emptyTarget))
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "gone", blocks: blocks), .rejected(.missingTarget))
        let duplicated = [heading("focus"), heading("focus"), markdown("note")]
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "focus", blocks: duplicated), .rejected(.duplicateTarget))
        XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: "note", blocks: duplicated)).scrollID, "note")
    }

    func testStaleTargetIsRejectedAfterThePageDropsIt() throws {
        XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: "focus", blocks: pageBlocks())).scrollID, "focus")
        XCTAssertEqual(
            PageNavigation.resolveOnPage(targetID: "focus", blocks: [markdown("note"), detail("hidden-note")]),
            .rejected(.missingTarget)
        )
    }

    func testHomeJumpUsesConfirmedPageWorkspaceAndExactBlock() {
        let decision = PageNavigation.resolveHomeJump(
            targetID: "focus",
            pageID: "home-page",
            workspaceID: "page-workspace",
            blocks: pageBlocks()
        )
        XCTAssertEqual(
            decision,
            .openPage(PageNavigationJump(pageID: "home-page", workspaceID: "page-workspace", blockID: "focus"))
        )
        if case .openPage(let jump) = decision {
            XCTAssertNotEqual(jump.workspaceID, "chat-picker")
            XCTAssertEqual(jump.id, "home-page\u{1e}page-workspace\u{1e}focus")
        } else {
            XCTFail("Home TOC must jump to the exact native page block")
        }
    }

    func testHomeJumpRejectsUnscopedOrInvalidTargetsInsteadOfGuessing() {
        let blocks = pageBlocks()
        XCTAssertEqual(
            PageNavigation.resolveHomeJump(targetID: "focus", pageID: "", workspaceID: "page-workspace", blocks: blocks),
            .rejected(.missingPageIdentity)
        )
        XCTAssertEqual(
            PageNavigation.resolveHomeJump(targetID: "focus", pageID: "home-page", workspaceID: "", blocks: blocks),
            .rejected(.missingWorkspace)
        )
        XCTAssertEqual(
            PageNavigation.resolveHomeJump(targetID: "focus", pageID: "home-page", workspaceID: "   ", blocks: blocks),
            .rejected(.missingWorkspace)
        )
        XCTAssertEqual(
            PageNavigation.resolveHomeJump(targetID: "", pageID: "home-page", workspaceID: "page-workspace", blocks: blocks),
            .rejected(.emptyTarget)
        )
        XCTAssertEqual(
            PageNavigation.resolveHomeJump(targetID: "gone", pageID: "home-page", workspaceID: "page-workspace", blocks: blocks),
            .rejected(.missingTarget)
        )
        XCTAssertEqual(
            PageNavigation.resolveHomeJump(
                targetID: "focus",
                pageID: "home-page",
                workspaceID: "page-workspace",
                blocks: [heading("focus"), heading("focus")]
            ),
            .rejected(.duplicateTarget)
        )
    }

    func testHomeJumpDoesNotBecomeALocalScroll() {
        if case .scroll = PageNavigation.resolveHomeJump(
            targetID: "focus",
            pageID: "home-page",
            workspaceID: "page-workspace",
            blocks: pageBlocks()
        ) {
            XCTFail("Nested Home list rows cannot scroll the conversations list")
        }
    }

    func testJumpFactoryRejectsIncompleteIdentities() {
        XCTAssertNil(PageNavigationJump.make(pageID: "", workspaceID: "ws", blockID: "focus"))
        XCTAssertNil(PageNavigationJump.make(pageID: "page", workspaceID: "", blockID: "focus"))
        XCTAssertNil(PageNavigationJump.make(pageID: "page", workspaceID: "ws", blockID: " "))
        XCTAssertEqual(
            PageNavigationJump.make(pageID: " page ", workspaceID: " ws ", blockID: " focus "),
            PageNavigationJump(pageID: "page", workspaceID: "ws", blockID: "focus")
        )
    }

    func testAccessibilityIdentifiersStayStableForLaterUIVerification() {
        XCTAssertEqual(PageNavigation.blockAccessibilityID("focus"), "page-nav-block-focus")
        XCTAssertEqual(PageNavigation.blockAccessibilityID("view-definition"), "page-nav-block-view-definition")
        XCTAssertEqual(PageNavigation.tocAccessibilityID("intro~2"), "page-nav-toc-intro~2")
        XCTAssertEqual(PageNavigation.namedViewsAccessibilityID, "page-nav-named-views")
        XCTAssertEqual(PageNavigation.screenAccessibilityID, "page-nav-screen")
        XCTAssertEqual(PageNavigation.normalizedTarget("  focus  "), "focus")
        XCTAssertNil(PageNavigation.normalizedTarget(" \n "))
        XCTAssertNil(PageNavigation.normalizedTarget(nil))
    }

    func testRoutingIsPureAndNeverEncodesAWrite() throws {
        let blocks = pageBlocks()
        let first = PageNavigation.resolveHomeJump(
            targetID: "hidden-note",
            pageID: "home-page",
            workspaceID: "page-workspace",
            blocks: blocks
        )
        let second = PageNavigation.resolveHomeJump(
            targetID: "hidden-note",
            pageID: "home-page",
            workspaceID: "page-workspace",
            blocks: blocks
        )
        XCTAssertEqual(first, second)
        XCTAssertEqual(
            first,
            .openPage(PageNavigationJump(pageID: "home-page", workspaceID: "page-workspace", blockID: "hidden-note"))
        )
        XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: "hidden-note", blocks: blocks)).scrollID, "hidden-note")
    }

    func testOutlineIncludesMarkdownAndNestedContainerHeadings() {
        let blocks: [JSONValue] = [
            markdown("intro", text: "# Alpha\n\npara\n\n# Beta"),
            [
                "id": "group", "type": "tabs",
                "tabs": [
                    ["label": "Overview", "blocks": [markdown("overview", text: "Overview")]],
                    ["label": "Details", "blocks": [[
                        "id": "hidden", "type": "toggle", "title": "Hidden",
                        "blocks": [heading("destination", text: "Destination")],
                    ]]],
                ],
            ],
            [
                "id": "cols", "type": "columns",
                "columns": [[heading("left", text: "Left")], [heading("right", text: "Right")]],
            ],
            [
                "id": "board", "type": "grid",
                "regions": [["id": "main", "blocks": [heading("grid-head", text: "Grid")]]],
            ],
        ]
        XCTAssertEqual(PageNavigation.outline(blocks).map(\.id), ["intro~0", "intro~2", "destination", "left", "right", "grid-head"])
        XCTAssertEqual(PageNavigation.outline(blocks).map(\.text), ["Alpha", "Beta", "Destination", "Left", "Right", "Grid"])
    }

    func testMarkdownFenceDoesNotCreateAHeadingAndKeepsSegmentIndexes() throws {
        let text = "```\n# not a heading\n```\n\n# Real"
        XCTAssertEqual(PageNavigation.headingAnchorIDs(blockID: "intro", text: text, topLevel: true), ["intro~1"])
        XCTAssertEqual(PageNavigation.outline([markdown("intro", text: text)]).map(\.id), ["intro~1"])
        XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: "intro~1", blocks: [markdown("intro", text: text)])).segmentIndex, 1)
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "intro~0", blocks: [markdown("intro", text: text)]), .rejected(.staleTarget))
    }

    func testNestedMarkdownHeadingsShareTheBlockIdentity() throws {
        let nested = markdown("inside", text: "# One\n\n# Two")
        let toggle: JSONValue = ["id": "fold", "type": "toggle", "title": "More", "blocks": [nested]]
        XCTAssertEqual(PageNavigation.outline([toggle]).map(\.id), ["inside", "inside"])
        // The outer block owns the one anchor. Its two rendered headings must
        // not each attach the same .id again.
        XCTAssertEqual(PageNavigation.headingAnchorIDs(blockID: "inside", text: nested["text"].stringValue, topLevel: false), [])
        let found = try target(PageNavigation.resolveOnPage(targetID: "inside", blocks: [toggle]))
        XCTAssertEqual(found.scrollID, "inside")
        XCTAssertEqual(found.reveals, [.toggle("fold")])
        XCTAssertEqual(found.topLevelID, "fold")
        XCTAssertNil(found.segmentIndex)
    }

    func testHiddenTabAndToggleRevealsUseTheCurrentSnapshotPath() throws {
        func tabs(_ order: [String]) -> JSONValue {
            [
                "id": "group", "type": "tabs",
                "tabs": .array(order.map { label in
                    ["label": .string(label), "blocks": [heading(label == "Details" ? "destination" : "other", text: label)]]
                }),
            ]
        }
        let first = try target(PageNavigation.resolveOnPage(targetID: "destination", blocks: [tabs(["Overview", "Details"])]))
        XCTAssertEqual(first.reveals, [.tab("group", 1)])
        let reordered = try target(PageNavigation.resolveOnPage(targetID: "destination", blocks: [tabs(["Details", "Overview"])]))
        XCTAssertEqual(reordered.reveals, [.tab("group", 0)])
        XCTAssertEqual(reordered.scrollID, "destination")
    }

    func testStaleMarkdownSegmentIsRejectedAfterReorder() throws {
        let before = markdown("intro", text: "# Alpha\n\npara\n\n# Beta")
        XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: "intro~2", blocks: [before])).scrollID, "intro~2")
        let after = markdown("intro", text: "# Beta\n\n# Alpha")
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "intro~2", blocks: [after]), .rejected(.staleTarget))
        XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: "intro~0", blocks: [after])).scrollID, "intro~0")
    }

    func testNamedViewScopeScrollsOnlyDisplayedContent() throws {
        let parentHeading = heading("parent-only", text: "On the page")
        let viewHeading = heading("in-view", text: "Inside the view")
        let page = [parentHeading, namedView(blockIDs: ["in-view"]), viewHeading]
        XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: "parent-only", blocks: page)).scrollID, "parent-only")
        let scoped = try target(PageNavigation.resolveInScope(targetID: "in-view", blocks: [viewHeading]))
        XCTAssertEqual(scoped.scrollID, "in-view")
        XCTAssertFalse(scoped.revealNamedViews)
        XCTAssertEqual(PageNavigation.resolveInScope(targetID: "parent-only", blocks: [viewHeading]), .rejected(.missingTarget))
        XCTAssertEqual(
            PageNavigation.resolveHomeJump(targetID: "in-view", pageID: "home-page", workspaceID: "page-workspace", blocks: page),
            .openPage(PageNavigationJump(pageID: "home-page", workspaceID: "page-workspace", blockID: "in-view"))
        )
    }

    func testColumnsAndGridHeadingsDoNotRequireAHiddenReveal() throws {
        let columns: JSONValue = ["id": "cols", "type": "columns", "columns": [[heading("left", text: "Left")]]]
        let grid: JSONValue = ["id": "board", "type": "grid", "regions": [["id": "main", "blocks": [heading("grid-head", text: "Grid")]]]]
        let column = try target(PageNavigation.resolveOnPage(targetID: "left", blocks: [columns]))
        XCTAssertTrue(column.reveals.isEmpty)
        XCTAssertEqual(column.scrollID, "left")
        let region = try target(PageNavigation.resolveOnPage(targetID: "grid-head", blocks: [grid]))
        XCTAssertTrue(region.reveals.isEmpty)
        XCTAssertEqual(region.scrollID, "grid-head")
    }

    func testSetextAndOtherCanonicalBlocksUseActualRenderedIndexes() throws {
        let text = "Title\n=====\n\n---\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| x | y |\n\n> # Quoted, not a top-level anchor\n\n$$x^2$$\n\n## Last"
        let canonical = MarkdownDocument(text).blocks
        let indices = canonical.enumerated().compactMap { index, block -> Int? in
            if case .heading = block { return index }; return nil
        }
        XCTAssertEqual(indices.count, 2)
        let ids = indices.map { "md~\($0)" }
        XCTAssertEqual(PageNavigation.headingAnchorIDs(blockID: "md", text: text, topLevel: true), ids)
        XCTAssertEqual(PageNavigation.outline([markdown("md", text: text)]).map(\.id), ids)
        XCTAssertEqual(PageNavigation.outline([markdown("md", text: text)]).map(\.text), ["Title", "Last"])
        for (id, index) in zip(ids, indices) {
            XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: id, blocks: [markdown("md", text: text)])).segmentIndex, index)
        }
    }

    func testFourSpaceFenceCloserCannotInventAnAnchor() {
        let text = "```text\ncode\n    ```\n# Still inside the fence\n```\n\nAfter\n-----"
        let document = MarkdownDocument(text).blocks
        XCTAssertEqual(document.count, 2)
        guard case .heading(level: 2, text: "After") = document[1] else { return XCTFail("Fixture must match canonical parser") }
        let blocks = [markdown("md", text: text)]
        XCTAssertEqual(PageNavigation.headingAnchorIDs(blockID: "md", text: text, topLevel: true), ["md~1"])
        XCTAssertEqual(PageNavigation.outline(blocks).map(\.text), ["After"])
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "md~2", blocks: blocks), .rejected(.staleTarget))
    }

    func testSinglePartNestedAndEditedMarkdownDoNotResolveUnrenderedSegments() throws {
        let single = markdown("single", text: "# Only")
        XCTAssertEqual(PageNavigation.headingAnchorIDs(blockID: "single", text: "# Only", topLevel: true), [])
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "single~0", blocks: [single]), .rejected(.staleTarget))
        let nested = markdown("inside", text: "# One\n\n# Two")
        let wrapper: JSONValue = ["id": "fold", "type": "toggle", "blocks": [nested]]
        XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "inside~1", blocks: [wrapper]), .rejected(.staleTarget))
        let markers: [JSONValue] = [true, ["at": 1], [:]]
        for marker in markers {
            var edited = markdown("md", text: "# One\n\n# Two"); edited["edit"] = marker
            XCTAssertTrue(PageNavigation.hasEditMarker(edited))
            XCTAssertEqual(PageNavigation.outline([edited]).map(\.id), ["md", "md"])
            XCTAssertEqual(PageNavigation.headingAnchorIDs(blockID: "md", text: edited["text"].stringValue, topLevel: true, editing: PageNavigation.hasEditMarker(edited)), [])
            XCTAssertEqual(PageNavigation.resolveOnPage(targetID: "md~1", blocks: [edited]), .rejected(.staleTarget))
            XCTAssertEqual(try target(PageNavigation.resolveOnPage(targetID: "md", blocks: [edited])).topLevelID, "md")
        }
    }

    func testCanonicalHeadingTextIsNotParsedAsAnotherHeading() {
        let text = "# # A literal leading hash\n\nBody"
        XCTAssertEqual(PageNavigation.outline([markdown("md", text: text)]).map(\.text), ["# A literal leading hash"])
    }

    func testNamedViewTopLevelSegmentationUsesOnlyItsDisplayedSnapshot() throws {
        let shown = markdown("shown", text: "Title\n=====\n\nBody\n\n## Details")
        let found = try target(PageNavigation.resolveInScope(targetID: "shown~2", blocks: [shown]))
        XCTAssertEqual(found.topLevelID, "shown")
        XCTAssertFalse(found.revealNamedViews)
        XCTAssertEqual(PageNavigation.resolveInScope(targetID: "outside~1", blocks: [shown]), .rejected(.missingTarget))
    }

    func testScrollProgressMaterializesAncestorBeforeWaitingForNestedLayout() throws {
        let nested: JSONValue = ["id": "outer", "type": "toggle", "blocks": [["id": "tabs", "type": "tabs", "tabs": [["label": "First", "blocks": []], ["label": "Second", "blocks": [heading("destination")]]]]]]
        let found = try target(PageNavigation.resolveOnPage(targetID: "destination", blocks: [nested]))
        XCTAssertEqual(found.reveals, [.toggle("outer"), .tab("tabs", 1)])
        var progress = PageNavigationScrollProgress(target: found)
        XCTAssertEqual(progress.next(available: []), .init(anchor: .block("outer"), completes: false))
        XCTAssertNil(progress.next(available: []), "Do not spin or repeatedly scroll an unmounted ancestor")
        XCTAssertNil(progress.next(available: [.block("outer")]), "An ancestor alone does not prove its collapsed target is laid out")
        XCTAssertNil(progress.next(available: [.block("outer"), .block("tabs")]))
        XCTAssertEqual(progress.next(available: [.block("outer"), .block("destination")]), .init(anchor: .block("destination"), completes: true))
        XCTAssertTrue(progress.completed)
        XCTAssertNil(progress.next(available: [.block("outer"), .block("destination")]))
    }

    func testHiddenSectionAndMarkdownHeadingHaveSeparateMaterializationStages() throws {
        var block = markdown("hidden", text: "# First\n\nBody\n\n# Last"); block["visibility"] = "detail"
        let found = try target(PageNavigation.resolveOnPage(targetID: "hidden~2", blocks: [block]))
        var progress = PageNavigationScrollProgress(target: found)
        XCTAssertEqual(progress.next(available: []), .init(anchor: .namedViews, completes: false))
        XCTAssertEqual(progress.next(available: [.namedViews]), .init(anchor: .block("hidden"), completes: false))
        XCTAssertNil(progress.next(available: [.namedViews, .block("hidden")]))
        XCTAssertEqual(progress.next(available: [.namedViews, .block("hidden"), .block("hidden~2")]), .init(anchor: .block("hidden~2"), completes: true))
    }
}
