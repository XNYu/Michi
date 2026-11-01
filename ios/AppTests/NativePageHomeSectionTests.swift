import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class NativePageHomeSectionTests: XCTestCase {
    func testPreviewKeepsGlobalScopeServerRuleLimitsAndUnfilteredTotal() async throws {
        let payload = Self.snapshot(waiting: [Self.conversation("one", workspace: "other-workspace")], total: 19)
        let transport = AppContractTransport { request, _ in
            XCTAssertEqual(request.method, "GET")
            XCTAssertEqual(request.path, "/api/spaces-home/sections")
            XCTAssertTrue(request.query.isEmpty, "A workspace page must not narrow connection-global reminders")
            return .json(payload)
        }
        defer { transport.close() }
        let model = NativePageHomeSectionModel(api: transport.api)
        await model.refresh()
        XCTAssertNil(model.error)
        XCTAssertEqual(model.sections[.waiting]?.total, 19)
        XCTAssertEqual(model.sections[.waiting]?.ruleIDs, ["rule-limit"])
        XCTAssertEqual(model.items(in: .waiting).map(\.workspaceID), ["other-workspace"])
        XCTAssertEqual(model.items(in: .waiting).count, 1, "Do not expand or replace a server-filtered preview")
        XCTAssertEqual(model.items(in: .waiting).first?.target, .conversation(nodeID: "one", workspaceID: "other-workspace"))
    }

    func testExpandedConversationsMergeWithoutDroppingProposalOrDuplicatingPreview() async {
        let preview = Self.snapshot(waiting: [Self.proposal(), Self.conversation("one")], total: 25)
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/sections") { return .json(preview) }
            XCTAssertEqual(request.path, "/api/spaces-home/conversations")
            XCTAssertEqual(request.method, "GET")
            XCTAssertEqual(request.query, ["state": "waiting", "limit": "500"])
            return .json(["items": .array([Self.conversation("one"), Self.conversation("two", workspace: "different")]), "total": 24])
        }
        defer { transport.close() }
        let model = NativePageHomeSectionModel(api: transport.api)
        await model.refresh()
        await model.setExpanded(.waiting, true)
        XCTAssertEqual(model.items(in: .waiting).map(\.id), ["change:change-1", "conversation:one", "conversation:two"])
        XCTAssertEqual(model.sections[.waiting]?.total, 25, "Conversation count must not replace the combined proposal+conversation total")
        await model.setExpanded(.waiting, false)
        XCTAssertEqual(model.items(in: .waiting).map(\.id), ["change:change-1", "conversation:one"])
    }

    func testFailedAndMalformedRefreshPreserveLastKnownReminders() async {
        let good = Self.snapshot(waiting: [Self.conversation("one")], total: 1)
        let transport = AppContractTransport { _, requests in
            if requests.count == 1 { return .json(good) }
            if requests.count == 2 { return .json(["error": "temporarily unavailable"], status: 503) }
            var malformed = good
            malformed["waiting"]["items"] = .array([Self.conversation("wrong").merging(["workspaceId": "unrelated"])])
            return .json(malformed)
        }
        defer { transport.close() }
        let model = NativePageHomeSectionModel(api: transport.api)
        await model.refresh()
        for _ in 0..<2 {
            await model.refresh()
            XCTAssertNotNil(model.error)
            XCTAssertEqual(model.items(in: .waiting).map(\.id), ["conversation:one"])
            XCTAssertFalse(model.loading)
        }
    }

    func testStopCancelsInflightReadAndPreventsLatePublication() async {
        let response = Self.snapshot(waiting: [Self.conversation("late")], total: 1)
        let transport = AppContractTransport { _, _ in .delayedJSON(response, status: 200, delay: 0.2) }
        defer { transport.close() }
        let model = NativePageHomeSectionModel(api: transport.api)
        let load = Task { await model.refresh() }
        for _ in 0..<100 where transport.requests.isEmpty { try? await Task.sleep(for: .milliseconds(2)) }
        XCTAssertEqual(transport.requests.count, 1)
        model.stop()
        await load.value
        XCTAssertTrue(model.sections.isEmpty)
        XCTAssertNil(model.error)
        XCTAssertFalse(model.loading)
    }

    func testUnavailableConversationSourceRetainsPageProposals() async {
        var payload = Self.snapshot(waiting: [Self.proposal()], total: 1)
        payload["conversations"] = ["available": false, "reason": "Backend is offline"]
        let response = payload
        let transport = AppContractTransport { _, _ in .json(response) }
        defer { transport.close() }
        let model = NativePageHomeSectionModel(api: transport.api)
        await model.refresh()
        XCTAssertNil(model.error)
        XCTAssertEqual(model.sourceIssue, "Backend is offline")
        XCTAssertEqual(model.items(in: .waiting).first?.target, .page(pageID: "page-global", changeID: "change-1", blockID: "block-1"))
        XCTAssertNil(model.items(in: .waiting).first?.workspaceID)
    }

    func testRejectsMismatchedOwnersAndExpansionStateAndDetectsNestedSections() throws {
        let valid = Self.conversation("one")
        XCTAssertThrowsError(try NativeHomeSectionItem.parse(valid.merging(["workspaceId": "wrong"])))
        XCTAssertThrowsError(try NativeHomeSectionItem.parse(valid.merging(["id": "conversation:other"])))
        XCTAssertThrowsError(try NativeHomeSectionSnapshot.parse(["items": .array([valid]), "total": 1], maximum: 500, state: .done))
        XCTAssertThrowsError(try NativeHomeSectionSnapshot.parse(["items": .array([valid, valid]), "total": 2], maximum: 8))
        XCTAssertTrue(NativePageHomeSectionModel.containsSection(in: [
            ["type": "grid", "regions": [["id": "r", "blocks": [["type": "toggle", "blocks": [["type": "home-section", "section": "done"]]]]]]],
        ]))
        XCTAssertFalse(NativePageHomeSectionModel.containsSection(in: [["type": "markdown", "text": "home-section"]]))
    }

    private nonisolated static func conversation(_ id: String, workspace: String = "workspace-a") -> JSONValue {
        ["id": .string("conversation:\(id)"), "kind": "conversation", "workspaceId": .string(workspace),
         "workspaceName": .string(workspace), "title": .string(id), "summary": "Review the reply", "at": 1_700_000_000_000,
         "agentClaim": false, "state": "waiting",
         "target": ["kind": "conversation", "nodeId": .string(id), "workspaceId": .string(workspace), "messageId": .null]]
    }
    private nonisolated static func proposal() -> JSONValue {
        ["id": "change:change-1", "kind": "proposal", "workspaceId": .null, "workspaceName": "Spaces Home", "title": "Global page",
         "summary": "Suggested update", "at": .null, "agentClaim": false,
         "target": ["kind": "page", "pageId": "page-global", "blockId": "block-1", "changeId": "change-1"]]
    }
    private nonisolated static func snapshot(waiting: [JSONValue], total: Int) -> JSONValue {
        ["waiting": ["items": .array(waiting), "total": .number(Double(total)), "ruleIds": ["rule-limit"]],
         "stalled": ["items": [], "total": 0], "done": ["items": [], "total": 0], "conversations": ["available": true]]
    }
}
