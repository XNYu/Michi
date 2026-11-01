import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class InlineHomeParityTests: XCTestCase {
    private func fixtureCard(_ id: String) -> JSONValue {
        [
            "id": .string(id),
            "kind": "continue",
            "label": "Continue",
            "source": ["workspaceId": "p1", "threadNodeId": .string("n-" + id)],
            "title": .string("Title " + id),
            "reason": "Two cases left.",
            "buttonText": "Continue",
            "prompt": .string("Prompt " + id),
            "workspaceId": "p1",
        ]
    }

    private func cardsAnswer(extra: [String: JSONValue] = [:]) -> JSONValue {
        var body: [String: JSONValue] = [
            "greeting": ["text": "早上好。昨晚 3 条线有进展。", "detail": "Michi 0.9 还有 5 天发布。"],
            "sets": [["cards": [fixtureCard("a0"), fixtureCard("a1")]]],
            "generatedAt": 1,
            "inputFingerprint": "fp",
        ]
        for (key, value) in extra { body[key] = value }
        return .object(body)
    }

    private func page(
        id: String = "home-page",
        workspace: String = "p1",
        title: String = "My home layout",
        revision: Int = 4,
        extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        .object([
            "id": .string(id),
            "workspaceId": .string(workspace),
            "title": .string(title),
            "revision": .number(Double(revision)),
            "color": .null,
            "keptUnknown": ["nested": true],
            "blocks": .array([
                ["id": "focus", "rev": 1, "type": "heading", "text": "My weekly focus", "future": true],
                ["id": "note", "rev": 2, "type": "markdown", "text": "Keep this space personal."],
                ["id": "check", "rev": 1, "type": "checklist", "items": [["text": "Review the plan", "done": false]]],
            ]),
        ].merging(extra) { _, new in new })
    }

    private func transport(
        _ respond: @escaping (AppContractRequest, [AppContractRequest]) -> AppContractResponse
    ) -> AppContractTransport {
        AppContractTransport { request, history in respond(request, history) }
    }

    func testCardsSnapshotKeepsFullPageUnknownFieldsWithoutFetching() async throws {
        let content = page()
        let transport = transport { _, _ in
            .json(self.cardsAnswer(extra: ["contentMode": "page", "contentPage": content]))
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"], hasConversation: true)
        await model.reload()
        XCTAssertEqual(model.snapshot.contentMode, "page")
        XCTAssertEqual(model.snapshot.contentPageID, "home-page")
        XCTAssertEqual(model.snapshot.contentPageWorkspaceID, "p1")
        XCTAssertEqual(model.snapshot.contentPageTitle, "My home layout")
        XCTAssertEqual(model.snapshot.contentPage["keptUnknown"], ["nested": true])
        XCTAssertEqual(model.snapshot.contentPage["revision"].intValue, 4)
        XCTAssertEqual(model.snapshot.contentPage["blocks"].arrayValue.count, 3)
        XCTAssertEqual(model.snapshot.contentPage["blocks"].arrayValue[0]["future"], true)
        XCTAssertTrue(model.showsInlineHomeDocument)
        XCTAssertTrue(model.showsCustomPageStatus)
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertFalse(model.showsDefaultHeadline)
        XCTAssertTrue(model.showsGreetingChrome)
        XCTAssertEqual(transport.requests.map(\.path), ["/api/home/cards"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testPageModeGreetingAndHiddenNeverFallBackToRecommendationCards() async {
        let transport = transport { _, history in
            switch history.count {
            case 1:
                return .json(self.cardsAnswer(extra: [
                    "greeting": .null,
                    "contentMode": "page",
                    "contentPage": self.page(),
                ]))
            case 2:
                return .json(self.cardsAnswer(extra: ["contentMode": "page", "contentPage": .null]))
            default:
                return .json(self.cardsAnswer(extra: ["contentMode": "hidden"]))
            }
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, hasConversation: true)
        await model.reload()
        XCTAssertTrue(model.showsInlineHomeDocument)
        XCTAssertTrue(model.showsGreetingChrome)
        XCTAssertFalse(model.showsDefaultHeadline)
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertTrue(model.customPageUnavailableMessage.contains("Open it in Pages"))
        await model.reload()
        XCTAssertFalse(model.showsInlineHomeDocument)
        XCTAssertTrue(model.showsCustomPageStatus)
        XCTAssertTrue(model.customPageUnavailableMessage.contains("unavailable"))
        XCTAssertTrue(model.visibleCards.isEmpty)
        await model.reload()
        XCTAssertFalse(model.showsCustomPageStatus)
        XCTAssertFalse(model.showsInlineHomeDocument)
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertEqual(model.snapshot.contentMode, "hidden")
        XCTAssertFalse(transport.requests.contains { $0.path.hasPrefix("/api/pages/") })
    }

    func testOwnedPageParserPreservesUnknownKeysAndRejectsForeignIdentity() throws {
        let owned = try NativeInlineHomeContract.ownedPage(
            ["page": page(extra: ["opaque": ["keep": true]])],
            expectedID: "home-page"
        )
        XCTAssertEqual(owned.id, "home-page")
        XCTAssertEqual(owned["workspaceId"].stringValue, "p1")
        XCTAssertEqual(owned["opaque"], ["keep": true])
        XCTAssertEqual(owned["blocks"].arrayValue[0]["future"], true)
        XCTAssertThrowsError(try NativeInlineHomeContract.ownedPage(page(id: "other"), expectedID: "home-page"))
        XCTAssertThrowsError(try NativeInlineHomeContract.ownedPage(
            page(extra: ["workspaceId": ""]),
            expectedID: "home-page"
        ))
        XCTAssertThrowsError(try NativeInlineHomeContract.ownedPage(page(extra: ["revision": 0]), expectedID: "home-page"))
        XCTAssertThrowsError(try NativeInlineHomeContract.ownedPage(page(extra: ["revision": .number(1.5)]), expectedID: "home-page"))
        XCTAssertThrowsError(try NativeInlineHomeContract.ownedPage(page(extra: ["revision": .null]), expectedID: "home-page"))
        XCTAssertThrowsError(try NativeInlineHomeContract.ownedPage(page(extra: ["blocks": "nope"]), expectedID: "home-page"))
        XCTAssertThrowsError(try NativeInlineHomeContract.ownedPage(
            page(extra: ["blocks": [["type": "heading", "text": "no-id"]]]),
            expectedID: "home-page"
        ))
        XCTAssertNil(NativeInlineHomeContract.positiveInt(.number(4.7)))
        XCTAssertNil(NativeInlineHomeContract.positiveInt(.number(.nan)))
        XCTAssertEqual(NativeInlineHomeContract.positiveInt(.number(4)), 4)
        XCTAssertEqual(
            try NativeInlineHomeContract.pagePath("home-page"),
            "/pages/home-page"
        )
        XCTAssertEqual(
            try NativeInlineHomeContract.editPath("home-page"),
            "/pages/home-page/edits"
        )
    }

    func testInitialCardsPageIsReadOnlyUntilLiveGetConfirmsRevision() async {
        let initial = page(revision: 4)
        let live = page(revision: 5, extra: ["title": "Renamed layout", "fresh": true])
        let transport = transport { request, _ in
            XCTAssertEqual(request.path, "/api/pages/home-page")
            XCTAssertEqual(request.method, "GET")
            return .json(live)
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: initial
        )
        XCTAssertTrue(model.hasPreview)
        XCTAssertTrue(model.canRender)
        XCTAssertTrue(model.readOnly)
        XCTAssertFalse(model.liveOwned)
        XCTAssertEqual(model.page["keptUnknown"], ["nested": true])
        XCTAssertEqual(model.visibleBlocks.map(\.id), ["focus", "note", "check"])
        await model.refresh()
        XCTAssertTrue(model.liveOwned)
        XCTAssertFalse(model.readOnly)
        XCTAssertEqual(model.revision, 5)
        XCTAssertEqual(model.title, "Renamed layout")
        XCTAssertEqual(model.page["fresh"], true)
        XCTAssertEqual(model.page["keptUnknown"], ["nested": true])
        XCTAssertEqual(transport.requests.map(\.path), ["/api/pages/home-page"])
    }

    func testFailedLiveGetKeepsCardsPreviewAndLeavesEditingClosed() async {
        let initial = page()
        let transport = transport { _, _ in .json(["error": "Unavailable"], status: 503) }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: initial
        )
        await model.refresh()
        XCTAssertTrue(model.hasPreview)
        XCTAssertTrue(model.canRender)
        XCTAssertTrue(model.readOnly)
        XCTAssertFalse(model.liveOwned)
        XCTAssertEqual(model.page["keptUnknown"], ["nested": true])
        XCTAssertEqual(model.visibleBlocks.map(\.id), ["focus", "note", "check"])
        XCTAssertNotNil(model.error)
        XCTAssertTrue(model.needsOpenPageFallback)
        XCTAssertTrue(model.canOpenPage)
        let updateResult1 = await model.updateBlock(id: "check", expectRev: 1, input: ["type": "checklist", "items": []])
        XCTAssertFalse(updateResult1)
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
    }

    func testForeignLivePageDoesNotReplaceOwnedPreview() async {
        let initial = page()
        let transport = transport { _, _ in
            .json(["id": "other-page", "workspaceId": "p1", "revision": 9, "blocks": []])
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: initial
        )
        await model.refresh()
        XCTAssertEqual(model.page.id, "home-page")
        XCTAssertEqual(model.page["keptUnknown"], ["nested": true])
        XCTAssertFalse(model.liveOwned)
        XCTAssertTrue(model.readOnly)
        XCTAssertNotNil(model.error)
        XCTAssertTrue(model.needsOpenPageFallback)
    }

    func testMissingWorkspaceIsAdoptedFromOwnedGet() async {
        let initial = page(extra: ["workspaceId": .null])
        let transport = transport { _, _ in .json(self.page()) }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: nil, initial: initial
        )
        XCTAssertEqual(model.workspaceID, "")
        await model.refresh()
        XCTAssertEqual(model.workspaceID, "p1")
        XCTAssertTrue(model.liveOwned)
        guard case .page(let id, let workspace) = model.pageDestination("linked") else {
            return XCTFail("owned Home should open linked pages in its workspace")
        }
        XCTAssertEqual(id, "linked")
        XCTAssertEqual(workspace, "p1")
    }

    func testCardsRefreshDoesNotOverwriteLiveOwnedPage() async {
        let initial = page(title: "My home layout")
        let live = page(title: "Live title", revision: 6)
        let transport = transport { _, _ in .json(live) }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: initial
        )
        await model.refresh()
        model.adoptCardsPage(page(title: "Stale cards title"))
        XCTAssertEqual(model.title, "Live title")
        XCTAssertTrue(model.liveOwned)
        XCTAssertEqual(model.revision, 6)
    }

    func testBindToAnotherPageDropsPreviousOwnership() async {
        let first = page(id: "home-a", title: "A")
        let second = page(id: "home-b", title: "B", revision: 2)
        let transport = transport { request, _ in
            if request.path.hasSuffix("/home-b") { return .json(second) }
            return .json(first)
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-a", workspaceID: "p1", initial: first
        )
        await model.refresh()
        XCTAssertEqual(model.expectedID, "home-a")
        await model.bind(pageID: "home-b", workspaceID: "p1", initial: page(id: "home-b", title: "B preview", revision: 1))
        XCTAssertEqual(model.expectedID, "home-b")
        XCTAssertEqual(model.title, "B")
        XCTAssertEqual(model.revision, 2)
        XCTAssertTrue(model.liveOwned)
        XCTAssertEqual(model.page.id, "home-b")
    }

    func testStructuredEditSendsPageRevisionAndBlockExpectRev() async {
        let initial = page(revision: 4)
        var stored = page(revision: 5, extra: [
            "blocks": .array([
                ["id": "focus", "rev": 1, "type": "heading", "text": "My weekly focus", "future": true],
                ["id": "note", "rev": 2, "type": "markdown", "text": "Keep this space personal."],
                ["id": "check", "rev": 2, "type": "checklist", "items": [["text": "Review the plan", "done": true]], "opaque": "keep"],
            ]),
        ])
        let transport = transport { request, _ in
            if request.path.hasSuffix("/edits") {
                XCTAssertEqual(request.method, "POST")
                XCTAssertEqual(request.body["revision"].intValue, 4)
                let op = request.body["ops"].arrayValue[0]
                XCTAssertEqual(op["op"].stringValue, "update")
                XCTAssertEqual(op["id"].stringValue, "check")
                XCTAssertEqual(op["expectRev"].intValue, 1)
                XCTAssertEqual(op["block"]["items"].arrayValue[0]["done"], true)
                XCTAssertNil(op["block"].objectValue["id"])
                XCTAssertNil(op["block"].objectValue["rev"])
                return .json(["page": stored])
            }
            return .json(self.page(revision: 4))
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: initial
        )
        await model.refresh()
        let input = featureBlockInput(from: [
            "id": "check", "rev": 1, "type": "checklist",
            "items": [["text": "Review the plan", "done": true]],
        ])
        let saved = await model.updateBlock(id: "check", expectRev: 1, input: input)
        XCTAssertTrue(saved)
        XCTAssertEqual(model.revision, 5)
        XCTAssertEqual(model.page["blocks"].arrayValue.first { $0.id == "check" }?["opaque"], "keep")
        XCTAssertEqual(model.page["keptUnknown"], ["nested": true])
        XCTAssertFalse(model.readOnly)
        XCTAssertEqual(transport.requests.map(\.method), ["GET", "POST"])
    }

    func testReadOnlyAndUnknownEditOutcomeNeverRetryAutomatically() async {
        let initial = page()
        var edits = 0
        let transport = transport { request, _ in
            if request.path.hasSuffix("/edits") {
                edits += 1
                return .failure(.networkConnectionLost)
            }
            return .json(self.page())
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", initial: initial
        )
        XCTAssertTrue(model.readOnly)
        let updateResult2 = await model.updateBlock(id: "check", expectRev: 1, input: ["type": "checklist"])
        XCTAssertFalse(updateResult2)
        XCTAssertEqual(edits, 0)
        await model.refresh()
        XCTAssertFalse(model.readOnly)
        let updateResult3 = await model.updateBlock(id: "check", expectRev: 1, input: ["type": "checklist"])
        XCTAssertFalse(updateResult3)
        XCTAssertEqual(edits, 1)
        XCTAssertTrue(model.unknownWrite)
        XCTAssertTrue(model.readOnly)
        XCTAssertFalse(model.liveOwned)
        XCTAssertTrue(model.error?.contains("unknown") == true)
        XCTAssertEqual(model.revision, 4)
        model.adoptCardsPage(page(title: "Cards must not clear an unknown write"))
        XCTAssertEqual(model.title, "My home layout")
        XCTAssertTrue(model.unknownWrite)
        XCTAssertTrue(model.readOnly)
        await model.refresh()
        XCTAssertEqual(edits, 1, "An unknown edit is not replayed by refresh")
        XCTAssertFalse(model.unknownWrite)
        XCTAssertTrue(model.liveOwned)
        XCTAssertFalse(model.readOnly)
        XCTAssertEqual(model.revision, 4)
    }

    func testRevisionConflictMarksStaleAndRefreshesWithoutApplyingForeignReceipt() async {
        let transport = transport { request, history in
            if request.path.hasSuffix("/edits") {
                return .json(["error": ["code": "revision_conflict", "message": "stale"]], status: 409)
            }
            return .json(self.page(revision: history.contains { $0.path.hasSuffix("/edits") } ? 8 : 4))
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: page()
        )
        await model.refresh()
        let saved = await model.updateBlock(id: "note", expectRev: 2, input: ["type": "markdown", "text": "Nope"])
        XCTAssertFalse(saved)
        XCTAssertTrue(model.stale || model.revision == 8)
        XCTAssertEqual(model.page.id, "home-page")
        XCTAssertNotEqual(model.page["blocks"].arrayValue.first { $0.id == "note" }?["text"].stringValue, "Nope")
        XCTAssertTrue(transport.requests.contains { $0.path == "/api/pages/home-page" && $0.method == "GET" })
    }

    func testCustomJavascriptIsIdentifiedAndNotLabeledSupported() {
        let custom: JSONValue = [
            "id": "widget",
            "rev": 1,
            "type": "component",
            "componentId": "weather",
            "html": "<script>alert(1)</script>",
            "javascript": "alert(1)",
        ]
        let document = page(extra: ["blocks": .array([
            ["id": "focus", "rev": 1, "type": "heading", "text": "Focus"],
            custom,
        ])])
        XCTAssertTrue(featureIsUnsupportedCustomBlock(custom))
        XCTAssertTrue(NativeInlineHomeContract.hasUnsupportedCustom(in: document))
        XCTAssertEqual(
            NativeInlineHomeContract.visibleBlocks(in: document).map(\.id),
            ["focus", "widget"]
        )
        XCTAssertEqual(NativeInlineHomeContract.unsupportedCustomMessage, "Custom HTML/JS cannot run here.")
        XCTAssertFalse(NativeInlineHomeContract.unsupportedCustomMessage.lowercased().contains("supported"))
        XCTAssertFalse(NativeInlineHomeContract.unsupportedCustomMessage.contains("WebView"))
    }

    func testMissingPageIdentityCannotRenderOrOpen() {
        let transport = transport { _, _ in .json(["error": "unused"], status: 500) }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(api: transport.api, pageID: "", initial: .null)
        XCTAssertFalse(model.canRender)
        XCTAssertFalse(model.canOpenPage)
        XCTAssertEqual(model.statusMessage, NativeInlineHomeContract.unavailableMessage)
        XCTAssertFalse(model.needsOpenPageFallback)
    }

    func testLinkedPageAndComposeSelectionsDoNotMarkUsedOrSend() {
        let transport = transport { _, _ in .json(self.cardsAnswer()) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api)
        let page = model.linkedPageSelection(pageID: "other", workspaceID: "p2")
        XCTAssertEqual(page.kind, .contentPage)
        XCTAssertEqual(page.contentPageID, "other")
        XCTAssertEqual(page.contentPageWorkspaceID, "p2")
        XCTAssertFalse(page.sends)
        XCTAssertNil(page.prompt)
        let compose = model.composeFromDocument("Arrange my Home")
        XCTAssertEqual(compose.kind, .compose)
        XCTAssertEqual(compose.prompt, "Arrange my Home")
        XCTAssertFalse(compose.sends)
        XCTAssertFalse(compose.usedConfirmed)
    }

    func testDetailViewsStayOutOfInlineMainContent() {
        let document = page(extra: ["blocks": .array([
            ["id": "focus", "rev": 1, "type": "heading", "text": "Focus"],
            ["id": "hidden", "rev": 1, "type": "markdown", "text": "Detail", "visibility": "detail"],
            ["id": "named", "rev": 1, "type": "view", "viewId": "panel", "title": "Panel", "blockIds": ["hidden"]],
        ])])
        XCTAssertEqual(NativeInlineHomeContract.visibleBlocks(in: document).map(\.id), ["focus"])
        XCTAssertEqual(NativeInlineHomeContract.blockAnchorID(document["blocks"].arrayValue[0], index: 0), "focus")
    }

    func testRefreshFailureAfterLiveSuccessKeepsPreviewAndClosesEdits() async {
        let transport = transport { _, history in
            if history.count == 1 { return .json(self.page(revision: 6, extra: ["title": "Live title"])) }
            return .json(["error": "Unavailable"], status: 503)
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: page()
        )
        await model.refresh()
        XCTAssertTrue(model.liveOwned)
        XCTAssertFalse(model.readOnly)
        await model.refresh()
        XCTAssertEqual(model.title, "Live title")
        XCTAssertEqual(model.page["keptUnknown"], ["nested": true])
        XCTAssertFalse(model.liveOwned)
        XCTAssertTrue(model.stale)
        XCTAssertTrue(model.readOnly)
        XCTAssertTrue(model.canRetryLiveRefresh)
        let updateResult4 = await model.updateBlock(id: "note", expectRev: 2, input: ["type": "markdown", "text": "Nope"])
        XCTAssertFalse(updateResult4)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 0)
    }

    func testMalformedAndForeignWriteReceiptsLockUntilExplicitGet() async {
        var step = 0
        let transport = transport { request, _ in
            if request.path.hasSuffix("/edits") {
                step += 1
                if step == 1 { return .json(["page": self.page(id: "other-page", revision: 9)]) }
                return .json(["page": ["id": "home-page", "workspaceId": "p1", "revision": 5]])
            }
            return .json(self.page(revision: 4))
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: page()
        )
        await model.refresh()
        let updateResult5 = await model.updateBlock(id: "note", expectRev: 2, input: ["type": "markdown", "text": "Nope"])
        XCTAssertFalse(updateResult5)
        XCTAssertEqual(model.page.id, "home-page")
        XCTAssertEqual(model.revision, 4)
        XCTAssertTrue(model.unknownWrite)
        XCTAssertTrue(model.readOnly)
        XCTAssertFalse(model.liveOwned)
        XCTAssertNotEqual(model.page["blocks"].arrayValue.first { $0.id == "note" }?["text"].stringValue, "Nope")
        model.adoptCardsPage(page(title: "Must not unlock"))
        XCTAssertEqual(model.title, "My home layout")
        XCTAssertTrue(model.unknownWrite)
        let updateResult6 = await model.updateBlock(id: "note", expectRev: 2, input: ["type": "markdown", "text": "Still no"])
        XCTAssertFalse(updateResult6)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        await model.refresh()
        XCTAssertFalse(model.unknownWrite)
        XCTAssertTrue(model.liveOwned)
        let updateResult7 = await model.updateBlock(id: "note", expectRev: 2, input: ["type": "markdown", "text": "Missing blocks"])
        XCTAssertFalse(updateResult7)
        XCTAssertEqual(model.revision, 4)
        XCTAssertTrue(model.unknownWrite)
        XCTAssertTrue(model.readOnly)
    }

    func testFiveHundredWriteLocksEditsUntilExplicitGet() async {
        let transport = transport { request, _ in
            if request.path.hasSuffix("/edits") { return .json(["error": "write failed"], status: 503) }
            return .json(self.page())
        }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: "p1", initial: page()
        )
        await model.refresh()
        let updateResult8 = await model.updateBlock(id: "check", expectRev: 1, input: ["type": "checklist"])
        XCTAssertFalse(updateResult8)
        XCTAssertTrue(model.unknownWrite)
        XCTAssertTrue(model.readOnly)
        XCTAssertFalse(model.liveOwned)
        XCTAssertEqual(model.page["keptUnknown"], ["nested": true])
        await model.refresh()
        XCTAssertFalse(model.unknownWrite)
        XCTAssertFalse(model.readOnly)
    }

    func testDestinationsUseConfirmedHomeWorkspaceNotChatPicker() async {
        let homeWorkspace = "home-ws"
        let transport = transport { _, _ in .json(self.page(workspace: homeWorkspace)) }
        defer { transport.close() }
        let model = NativeInlineHomeDocumentModel(
            api: transport.api, pageID: "home-page", workspaceID: nil, initial: page(extra: ["workspaceId": .null])
        )
        XCTAssertNil(model.databaseDestination(id: "db-1", viewID: "board"))
        XCTAssertNil(model.tasksDestination(viewID: "today"))
        XCTAssertNil(model.fileDestination(path: "notes.md"))
        XCTAssertNil(model.componentDestination(id: "weather", version: "2"))
        await model.refresh()
        XCTAssertEqual(model.workspaceID, homeWorkspace)
        XCTAssertEqual(model.databaseDestination(id: "db-1", viewID: "board"), .database(id: "db-1", viewID: "board", workspaceID: homeWorkspace))
        XCTAssertEqual(model.tasksDestination(viewID: "today"), .tasks(viewID: "today", workspaceID: homeWorkspace))
        XCTAssertEqual(model.fileDestination(path: "notes.md"), .file(path: "notes.md", workspaceID: homeWorkspace))
        XCTAssertEqual(model.componentDestination(id: "weather", version: "2"), .component(id: "weather", version: "2", workspaceID: homeWorkspace))
        XCTAssertEqual(model.pageDestination("linked"), .page(id: "linked", workspaceID: homeWorkspace))
        XCTAssertEqual(model.threadDestination("node-1"), .thread(id: "node-1", workspaceID: homeWorkspace))
        XCTAssertNotEqual(homeWorkspace, "p1")
    }
}
