import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class RichPageBlockTests: XCTestCase {
    func testVisibleReorderUsesFullPagePositionsAndKeepsDetailReferences() throws {
        let blocks: [JSONValue] = [
            ["id": "view-definition", "type": "view"],
            ["id": "first", "type": "heading"],
            ["id": "detail", "type": "table", "visibility": "detail"],
            ["id": "second", "type": "markdown"],
            ["id": "last-detail", "type": "markdown", "visibility": "detail"],
        ]
        let up = try RichPageBlockModel.moveInFullPage(source: IndexSet(integer: 1), destination: 0, blocks: blocks)
        XCTAssertEqual(up.source, IndexSet(integer: 3))
        XCTAssertEqual(up.destination, 1)
        let down = try RichPageBlockModel.moveInFullPage(source: IndexSet(integer: 0), destination: 2, blocks: blocks)
        XCTAssertEqual(down.source, IndexSet(integer: 1))
        XCTAssertEqual(down.destination, blocks.count)
        XCTAssertThrowsError(try RichPageBlockModel.moveInFullPage(source: IndexSet([0, 1]), destination: 0, blocks: blocks))
    }
    func testViewsResolveOnlyActualPageBlocksInDeclaredOrder() throws {
        let a: JSONValue = ["id": "a", "rev": 3, "type": "markdown", "text": "A", "visibility": "detail"]
        let b: JSONValue = ["id": "b", "rev": 9, "type": "table", "columns": ["Value"], "rows": [["B"]]]
        let view: JSONValue = ["type": "view", "viewId": "detail", "title": "Details", "blockIds": ["b", "a"]]
        let action: JSONValue = ["type": "open-view", "viewId": "detail", "presentation": "inline"]
        let result = try RichPageBlockModel.view(action: action, blocks: [a, view, b])
        XCTAssertEqual(result.blocks, [b, a])
        XCTAssertEqual(result.blocks.map { $0["rev"] }, [9, 3], "Referenced blocks retain their own revision for editing")
        XCTAssertEqual(result.presentation, "inline")
        XCTAssertFalse(RichPageBlockModel.isMainContent(a))
        XCTAssertFalse(RichPageBlockModel.isMainContent(view))
        XCTAssertTrue(RichPageBlockModel.isMainContent(b))
        XCTAssertThrowsError(try RichPageBlockModel.view(action: action, blocks: [a, view]))
        XCTAssertThrowsError(try RichPageBlockModel.view(action: action, blocks: [a, b, view, view]))
        XCTAssertThrowsError(try RichPageBlockModel.view(action: action, blocks: [a, b, view], visited: ["detail"]))
        XCTAssertThrowsError(try RichPageBlockModel.view(action: action, blocks: [a, b, view.merging(["blockIds": ["a", "a"]])]))
        XCTAssertThrowsError(try RichPageBlockModel.view(action: action, blocks: [view.merging(["id": "view-row", "blockIds": ["view-row"]])]))
    }

    func testNestedEditRebuildsItsOwnerWithoutDroppingSiblingOrGridIdentity() throws {
        let original: JSONValue = [
            "id": "owner", "rev": 12, "sources": [["nodeId": "source"]], "type": "grid",
            "regions": [
                ["id": "main", "span": 8, "tabletSpan": 6, "blocks": [
                    ["type": "checklist", "items": [["text": "Review", "done": false]]],
                    ["type": "markdown", "text": "Keep this sibling"],
                ]],
                ["id": "side", "span": 4, "blocks": [["type": "markdown", "text": "Keep this region"]]],
            ],
        ]
        let changed: JSONValue = ["type": "checklist", "items": [["text": "Review", "done": true]]]
        let result = try RichPageBlockModel.replacingChild(in: original, collection: "regions", group: 0, index: 0, with: changed)
        XCTAssertTrue(result["id"].isNull)
        XCTAssertTrue(result["rev"].isNull)
        XCTAssertTrue(result["sources"].isNull)
        XCTAssertEqual(result["regions"].arrayValue[0]["id"], "main")
        XCTAssertEqual(result["regions"].arrayValue[0]["tabletSpan"], 6)
        XCTAssertEqual(result["regions"].arrayValue[0]["blocks"].arrayValue[0], changed)
        XCTAssertEqual(result["regions"].arrayValue[0]["blocks"].arrayValue[1], original["regions"].arrayValue[0]["blocks"].arrayValue[1])
        XCTAssertEqual(result["regions"].arrayValue[1], original["regions"].arrayValue[1])
        XCTAssertThrowsError(try RichPageBlockModel.replacingChild(in: original, collection: "regions", group: 9, index: 0, with: changed))
    }

    func testColumnsAndTogglesUseTheirActualNestedShapes() throws {
        let changed: JSONValue = ["type": "markdown", "text": "Changed"]
        let columns: JSONValue = ["type": "columns", "columns": [
            [["type": "markdown", "text": "Left"]], [["type": "markdown", "text": "Right"]],
        ]]
        let updated = try RichPageBlockModel.replacingChild(in: columns, collection: "columns", group: 1, index: 0, with: changed)
        XCTAssertEqual(updated["columns"].arrayValue[0], columns["columns"].arrayValue[0])
        XCTAssertEqual(updated["columns"].arrayValue[1].arrayValue, [changed])
        let toggle: JSONValue = ["type": "toggle", "title": "Details", "blocks": [changed]]
        XCTAssertEqual(try RichPageBlockModel.replacingChild(in: toggle, collection: "blocks", group: nil, index: 0, with: ["type": "divider"])["blocks"], [["type": "divider"]])
    }

    func testLegacyAndRichChartsPreserveZeroNegativeAndNumericAxes() throws {
        let legacy: JSONValue = ["type": "chart", "kind": "bar", "labels": ["Mon", "Tue"], "series": [["label": "Count", "values": [0, 8]]]]
        let legacyPoints = try RichPageBlockModel.chartPoints(legacy)
        XCTAssertEqual(legacyPoints.map(\.label), ["Mon", "Tue"])
        XCTAssertEqual(legacyPoints.map(\.y), [0, 8])
        let rich: JSONValue = ["type": "chart", "kind": "composite", "series": [
            ["label": "Balance", "as": "line", "points": [["x": 1, "y": -2], ["x": 5, "y": 0]]],
            ["label": "Costs", "as": "bar", "points": [["x": 1, "y": 3]]],
        ]]
        let points = try RichPageBlockModel.chartPoints(rich)
        XCTAssertEqual(points.map(\.x), [1, 5, 1])
        XCTAssertEqual(points.map(\.y), [-2, 0, 3])
        XCTAssertEqual(points.map(\.kind), ["line", "line", "bar"])
        XCTAssertThrowsError(try RichPageBlockModel.chartPoints(legacy.merging(["series": [["label": "Bad", "values": [1]]]])))
        XCTAssertThrowsError(try RichPageBlockModel.chartPoints(["kind": "line", "series": [["points": [["x": "Mon"]]]]]))
        XCTAssertThrowsError(try RichPageBlockModel.chartPoints(["kind": "line", "series": [["points": [["x": "Mon", "y": true]]]]]))
    }

    func testFormPromptUsesBackendTypesAndRequiresExplicitAnswers() throws {
        let form: JSONValue = ["type": "form", "prompt": "Plan this", "fields": [
            ["key": "budget", "label": "Budget", "type": "number", "required": true],
            ["key": "agree", "label": "Approval", "type": "checkbox", "required": true],
            ["key": "mode", "label": "Mode", "type": "select", "options": ["Fast", "Careful"]],
            ["key": "notes", "label": "Notes", "type": "text"],
            ["key": "day", "label": "Date", "type": "date", "required": true],
        ]]
        let values: [String: JSONValue] = ["budget": "0", "agree": true, "mode": "Fast", "notes": "  Keep this  ", "day": "2026-10-31"]
        let prompt = try RichPageBlockModel.formPrompt(form, values: values)
        let json = try JSONValue.parse(String(prompt.dropFirst("Plan this\n\n".count)))
        XCTAssertEqual(json, ["budget": 0, "agree": true, "mode": "Fast", "notes": "Keep this", "day": "2026-10-31"])
        XCTAssertThrowsError(try RichPageBlockModel.formPrompt(form, values: values.merging(["agree": false]) { _, new in new }))
        XCTAssertThrowsError(try RichPageBlockModel.formPrompt(form, values: values.merging(["budget": "NaN"]) { _, new in new }))
        XCTAssertThrowsError(try RichPageBlockModel.formPrompt(form, values: values.merging(["day": "2026-02-30"]) { _, new in new }))
        XCTAssertThrowsError(try RichPageBlockModel.formPrompt(form.merging(["fields": [form["fields"].arrayValue[0], form["fields"].arrayValue[0]]]), values: values))
    }

    func testMediaRejectsPrivateInsecureCredentialAndLegacyNumericAddresses() {
        for raw in [
            "http://example.com/a.png", "file:///tmp/a.png", "data:image/png;base64,AA",
            "https://localhost/a", "https://printer/a", "https://camera.home.arpa/a",
            "https://192.168.1.4/a", "https://127.0.0.1/a", "https://100.64.0.1/a", "https://169.254.1.1/a",
            "https://2130706433/a", "https://127.1/a", "https://0x7f000001/a", "https://0177.0.0.1/a",
            "https://[::1]/a", "https://[0:0:0:0:0:0:0:1]/a", "https://[fc00::1]/a",
            "https://[::ffff:192.168.1.1]/a", "https://[64:ff9b::a00:1]/a", "https://[fec0::1]/a",
            "https://person:secret@example.com/a",
        ] { XCTAssertNil(RichPageBlockModel.mediaURL(raw), raw) }
        XCTAssertNotNil(RichPageBlockModel.mediaURL("https://images.example.com/a.png"))
        XCTAssertNotNil(RichPageBlockModel.mediaURL("https://8.8.8.8/a.png"))
        XCTAssertNotNil(RichPageBlockModel.mediaURL("https://[2001:4860:4860::8888]/a.png"))
    }

    func testStaticHTMLKeepsVisibleMarkdownViewActionsWithoutPromotingScriptSource() {
        let links = RichPageBlockModel.markdownViewLinks("<details><summary>More</summary><p>[Details](#view/release?presentation=drawer)</p></details>")
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links.first?.action, ["type": "open-view", "viewId": "release", "presentation": "drawer"])
        XCTAssertTrue(RichPageBlockModel.markdownViewLinks("<script>[Hidden](#view/release)</script>").isEmpty)
    }

    func testMarkdownViewActionsStayLocalAndUnsupportedCustomBlocksRemainUnsupported() {
        let links = RichPageBlockModel.markdownViewLinks("[Details](#view/release?presentation=modal) [Outside](https://example.com)")
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links.first?.label, "Details")
        XCTAssertEqual(links.first?.action, ["type": "open-view", "viewId": "release", "presentation": "modal"])
        let fence = String(repeating: "\u{0060}", count: 3)
        XCTAssertTrue(RichPageBlockModel.markdownViewLinks(fence + "\n[Example](#view/release)\n" + fence).isEmpty, "Code examples are not navigation actions")
        XCTAssertNil(RichPageBlockModel.viewAction(href: URL(string: "https://example.com/#view/release")!))
        XCTAssertTrue(RichPageBlockModel.supportedTypes.contains("component"))
        XCTAssertFalse(RichPageBlockModel.supportedTypes.contains("javascript"))
        for type in ["metrics", "timeline", "compare", "conflict", "criteria", "chart", "gallery", "forgot", "threads", "grid", "tabs"] {
            XCTAssertTrue(RichPageBlockModel.supportedTypes.contains(type), type)
        }
    }
}
