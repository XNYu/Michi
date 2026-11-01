import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class NamedViewMutationTests: XCTestCase {
    private let checklist: JSONValue = ["id": "details-list", "rev": 9, "type": "checklist", "visibility": "detail", "items": [["text": "Review", "done": false]], "future": true]
    private let host: JSONValue = ["id": "grid", "rev": 7, "type": "grid", "future": ["preserved": true], "regions": [["id": "region", "blocks": [["type": "metrics", "items": []]]]]]
    private let definition: JSONValue = ["id": "view-definition", "rev": 1, "type": "view", "viewId": "details", "title": "Details", "blockIds": ["details-list"]]

    func testOpenSelectionReadsCurrentContentRevisionTitleAndOrder() throws {
        for presentation in ["inline", "drawer", "modal"] {
            let action: JSONValue = ["type": "open-view", "viewId": "details", "presentation": .string(presentation)]
            let selection = try RichPageViewSelection(action: action, blocks: [definition, checklist])
            let original = try XCTUnwrap(selection.resolve(blocks: [definition, checklist]))
            var updated = checklist
            updated["rev"] = 10; updated["items"] = [["text": "Review", "done": true]]
            let additional: JSONValue = ["id": "details-note", "rev": 2, "type": "markdown", "text": "Saved"]
            var currentDefinition = definition
            currentDefinition["title"] = "Updated details"
            currentDefinition["blockIds"] = ["details-note", "details-list"]
            let current = try XCTUnwrap(selection.resolve(blocks: [currentDefinition, updated, additional]))
            XCTAssertEqual(current.id, original.id)
            XCTAssertEqual(current.presentation, presentation)
            XCTAssertEqual(current.title, "Updated details")
            XCTAssertEqual(current.blocks.map(\.id), ["details-note", "details-list"])
            XCTAssertEqual(current.blocks[1]["rev"], 10)
            XCTAssertEqual(current.blocks[1]["items"].arrayValue[0]["done"], true)
            XCTAssertEqual(original.blocks[0]["rev"], 9)
        }
    }

    func testSelectionClosesWhenDefinitionOrTargetsNoLongerResolve() throws {
        let selection = try RichPageViewSelection(action: ["type": "open-view", "viewId": "details"], blocks: [definition, checklist])
        var renamed = definition; renamed["viewId"] = "renamed"
        var changedReference = definition; changedReference["blockIds"] = ["missing"]
        for blocks in [[checklist], [renamed, checklist], [definition], [changedReference, checklist], [definition, definition, checklist], [definition, checklist, checklist]] {
            XCTAssertNil(selection.resolve(blocks: blocks))
        }
        XCTAssertNil(selection.resolve(blocks: [definition, checklist], visited: ["details"]))
        XCTAssertThrowsError(try RichPageViewSelection(action: ["type": "open-view", "viewId": "missing"], blocks: [definition, checklist]))
    }

    func testSuccessiveEditsFromOpenNestedViewUseFreshPageRevisions() async throws {
        var current = checklist
        var calls: [(String, Int)] = []
        let apply: RichPageMutationRoute.Apply = { input, id, revision in
            XCTAssertEqual(id, self.checklist.id)
            XCTAssertEqual(revision, current["rev"].intValue)
            calls.append((id, revision))
            current = input; current["rev"] = .number(Double(revision + 1))
            return true
        }
        let route = RichPageMutationRoute(page: apply, local: apply)
            .nested(parent: host, collection: "regions", group: 0, index: 0, onError: { XCTFail($0) })
        let selection = try RichPageViewSelection(action: ["type": "open-view", "viewId": "details"], blocks: [definition, current])
        for done in [true, false] {
            let blocks = [definition, current, host]
            let view = try XCTUnwrap(selection.resolve(blocks: blocks))
            var next = view.blocks[0]; next["items"] = [["text": "Review", "done": .bool(done)]]
            let writable = route.namedView(view, pageBlocks: blocks, onError: { XCTFail($0) })
            let saved = await writable.local?(next, next.id, next["rev"].intValue)
            XCTAssertEqual(saved, true)
            XCTAssertEqual(selection.resolve(blocks: [definition, current])?.blocks[0]["items"].arrayValue[0]["done"], .bool(done))
        }
        XCTAssertEqual(calls.map(\.0), ["details-list", "details-list"])
        XCTAssertEqual(calls.map(\.1), [9, 10])
        XCTAssertEqual(current["rev"], 11)
    }

    func testFreshResolutionDoesNotWeakenStaleRevisionRejection() async throws {
        var writes = 0, failures = 0
        let route = RichPageMutationRoute(page: { _, _, _ in writes += 1; return true }, local: nil)
        let selection = try RichPageViewSelection(action: ["type": "open-view", "viewId": "details"], blocks: [definition, checklist])
        let oldView = try XCTUnwrap(selection.resolve(blocks: [definition, checklist]))
        var updated = checklist; updated["rev"] = 10
        let stale = route.namedView(oldView, pageBlocks: [definition, updated], onError: { _ in failures += 1 })
        let saved = await stale.local?(checklist, checklist.id, 9)
        XCTAssertEqual(saved, false)
        XCTAssertEqual(writes, 0); XCTAssertEqual(failures, 1)
        XCTAssertEqual(selection.resolve(blocks: [definition, updated])?.blocks[0]["rev"], 10)
    }

    func testNestedNamedViewEditsItsOwnPageBlockInsteadOfGridSlot() async {
        var calls: [(JSONValue, String, Int)] = []
        let apply: RichPageMutationRoute.Apply = { input, id, revision in calls.append((input, id, revision)); return true }
        let route = RichPageMutationRoute(page: apply, local: apply)
            .nested(parent: host, collection: "regions", group: 0, index: 0, onError: { XCTFail($0) })
        let view = RichPageView(id: "details", title: "Details", presentation: "drawer", blocks: [checklist])
        let viewRoute = route.namedView(view, pageBlocks: [host, checklist], onError: { XCTFail($0) })
        var changed = checklist; changed["items"] = [["text": "Review", "done": true]]
        let ok = await viewRoute.local?(changed, "details-list", 9)
        XCTAssertEqual(ok, true)
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.1, "details-list")
        XCTAssertEqual(calls.first?.2, 9)
        XCTAssertEqual(calls.first?.0["future"], true)
        XCTAssertEqual(host["regions"].arrayValue[0]["blocks"].arrayValue[0]["type"], "metrics")
    }

    func testNormalNestedMutationStillTargetsContainerAndPreservesOpaqueFields() async {
        var captured: (JSONValue, String, Int)?
        let apply: RichPageMutationRoute.Apply = { captured = ($0, $1, $2); return true }
        let route = RichPageMutationRoute(page: apply, local: apply)
            .nested(parent: host, collection: "regions", group: 0, index: 0, onError: { XCTFail($0) })
        let ok = await route.local?(["type": "metrics", "items": [["label": "Done", "value": "1"]]], "", 0)
        XCTAssertEqual(ok, true)
        XCTAssertEqual(captured?.1, "grid"); XCTAssertEqual(captured?.2, 7)
        XCTAssertEqual(captured?.0["future"], ["preserved": true])
        XCTAssertEqual(captured?.0["regions"].arrayValue[0]["blocks"].arrayValue[0]["items"].arrayValue[0]["value"], "1")
    }

    func testNamedViewRejectsForeignStaleMissingAndDuplicateTargets() async {
        var writes = 0, failures = 0
        let apply: RichPageMutationRoute.Apply = { _, _, _ in writes += 1; return true }
        let route = RichPageMutationRoute(page: apply, local: apply)
        let view = RichPageView(id: "details", title: "Details", presentation: "inline", blocks: [checklist])
        for (blocks, id, revision) in [([host, checklist], "grid", 7), ([checklist], "details-list", 8), ([], "details-list", 9), ([checklist, checklist], "details-list", 9)] {
            let target = route.namedView(view, pageBlocks: blocks, onError: { _ in failures += 1 })
            let ok = await target.local?(checklist, id, revision)
            XCTAssertEqual(ok, false)
        }
        XCTAssertEqual(writes, 0); XCTAssertEqual(failures, 4)
    }

    func testReadOnlyPageCannotAcquireWritableNamedViewRoute() {
        let route = RichPageMutationRoute(page: nil, local: nil)
        let view = RichPageView(id: "details", title: "Details", presentation: "modal", blocks: [checklist])
        XCTAssertNil(route.nested(parent: host, collection: "regions", group: 0, index: 0, onError: { _ in }).namedView(view, pageBlocks: [checklist], onError: { _ in }).local)
    }
}
