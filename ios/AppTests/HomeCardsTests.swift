import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class HomeCardsTests: XCTestCase {
    private func fixtureCard(_ id: String, extra: [String: JSONValue] = [:]) -> JSONValue {
        let identifier = JSONValue.string(id)
        let node = JSONValue.string("n-" + id)
        let prompt = JSONValue.string("Prompt " + id)
        let title = JSONValue.string("Title " + id)
        var row: [String: JSONValue] = [
            "id": identifier,
            "kind": "continue",
            "label": "接着做 · garden-notes",
            "source": ["workspaceId": "p1", "threadNodeId": node],
            "title": title,
            "reason": "Two cases left.",
            "buttonText": "接着做",
            "prompt": prompt,
            "workspaceId": "p1",
        ]
        for (key, value) in extra { row[key] = value }
        return .object(row)
    }

    private func fixtureAnswer(cards: [[JSONValue]]? = nil, extra: [String: JSONValue] = [:]) -> JSONValue {
        let sets = (cards ?? [[fixtureCard("a0"), fixtureCard("a1")], [fixtureCard("b0")]]).map { row in
            JSONValue.object(["cards": .array(row)])
        }
        var body: [String: JSONValue] = [
            "greeting": ["text": "早上好。昨晚 3 条线有进展。", "detail": "Michi 0.9 还有 5 天发布。"],
            "sets": .array(sets),
            "generatedAt": 1,
            "inputFingerprint": "fp",
        ]
        for (key, value) in extra { body[key] = value }
        return .object(body)
    }

    private func emptyAnswer() -> JSONValue {
        ["greeting": .null, "sets": [], "generatedAt": .null, "inputFingerprint": .null]
    }

    private func cardsTransport(
        _ respond: @escaping (AppContractRequest, [AppContractRequest]) -> AppContractResponse
    ) -> AppContractTransport {
        AppContractTransport { request, history in respond(request, history) }
    }

    func testFirstLoadIsGetOnlyWithoutQueryOrMutation() async {
        let answer = fixtureAnswer()
        let transport = cardsTransport { _, _ in .json(answer) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"], hasConversation: true)
        await model.reload()
        XCTAssertTrue(model.loaded)
        XCTAssertEqual(model.visibleCards.map(\.id), ["a0", "a1"])
        XCTAssertEqual(model.snapshot.greeting?.text, "早上好。昨晚 3 条线有进展。")
        XCTAssertEqual(model.snapshot.greeting?.detail, "Michi 0.9 还有 5 天发布。")
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
        XCTAssertEqual(transport.requests.map(\.path), ["/api/home/cards"])
        XCTAssertTrue(transport.requests[0].query.isEmpty)
        XCTAssertEqual(transport.requests[0].body, .null)
    }

    func testFailedFirstReadShowsNoCardsAndSendsNoMutation() async {
        let transport = cardsTransport { _, _ in .json(["error": "Unavailable"], status: 503) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api)
        await model.reload()
        XCTAssertTrue(model.loaded)
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertNil(model.error)
        XCTAssertTrue(model.showsDefaultHeadline)
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
    }

    func testInvalidSnapshotIsRejectedAndLaterRefreshKeepsPrevious() async {
        let answer = fixtureAnswer()
        let transport = cardsTransport { _, history in
            history.count == 1 ? .json(answer) : .json(["greeting": .null, "sets": "broken"])
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, hasConversation: true)
        await model.reload()
        XCTAssertEqual(model.visibleCards.map(\.id), ["a0", "a1"])
        await model.reload()
        XCTAssertEqual(model.visibleCards.map(\.id), ["a0", "a1"])
        XCTAssertNotNil(model.error)
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testMalformedFirstPayloadDoesNotBecomeVisibleCards() async {
        let transport = cardsTransport { _, _ in
            .json(["greeting": .null, "sets": [["cards": [self.fixtureCard("a0", extra: ["kind": "news"])]]]])
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api)
        await model.reload()
        XCTAssertFalse(model.loaded)
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertNotNil(model.error)
    }

    func testDuplicateUnknownKindAndTipLimitsAreRejected() throws {
        XCTAssertThrowsError(try HomeCardsContract.parse(fixtureAnswer(cards: [[fixtureCard("a"), fixtureCard("a")]])))
        XCTAssertThrowsError(try HomeCardsContract.parse(fixtureAnswer(cards: [[fixtureCard("a0", extra: ["kind": "news"])]])))
        XCTAssertThrowsError(try HomeCardsContract.parse(fixtureAnswer(cards: [[
            fixtureCard("t1", extra: ["kind": "tip", "workspaceId": .null, "source": [:], "prompt": ""]),
            fixtureCard("t2", extra: ["kind": "tip", "workspaceId": .null, "source": [:], "prompt": ""]),
        ]])))
        let seven = (0..<7).map { fixtureCard("c\($0)") }
        XCTAssertThrowsError(try HomeCardsContract.parse(fixtureAnswer(cards: [seven])))
        let nine = (0..<9).map { [fixtureCard("s\($0)")] }
        XCTAssertThrowsError(try HomeCardsContract.parse(fixtureAnswer(cards: nine)))
    }

    func testShuffleRotatesLocallyWithoutAskingTheBackend() async {
        let answer = fixtureAnswer()
        let transport = cardsTransport { _, _ in .json(answer) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, hasConversation: true)
        await model.reload()
        XCTAssertTrue(model.canShuffle)
        model.shuffle()
        XCTAssertEqual(model.visibleCards.map(\.id), ["b0"])
        model.shuffle()
        XCTAssertEqual(model.visibleCards.map(\.id), ["a0", "a1"])
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(transport.requests[0].method, "GET")
    }

    func testPickFillsPromptMarksUsedAndKeepsCardUntilNextRead() async {
        let cardId = "a0"
        let usedAt = 7000.0
        let answer = fixtureAnswer()
        let transport = cardsTransport { request, _ in
            if request.method == "POST" {
                return .json(["cardId": JSONValue.string(cardId), "usedAt": JSONValue.number(usedAt)])
            }
            return .json(answer)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"], hasConversation: true)
        await model.reload()
        let pick = await model.pick(model.visibleCards[0])
        XCTAssertEqual(pick.kind, .recommendation)
        XCTAssertEqual(pick.cardID, cardId)
        XCTAssertEqual(pick.prompt, "Prompt a0")
        XCTAssertEqual(pick.workspaceID, "p1")
        XCTAssertEqual(pick.nodeID, "n-a0")
        XCTAssertFalse(pick.startMention)
        XCTAssertFalse(pick.openPagesHome)
        XCTAssertFalse(pick.sends)
        let usedConfirmed = pick.usedConfirmed
        XCTAssertTrue(usedConfirmed)
        XCTAssertEqual(model.visibleCards.map(\.id), ["a0", "a1"])
        XCTAssertTrue(model.confirmedUsed.contains(cardId))
        XCTAssertEqual(transport.requests.map(\.method), ["GET", "POST"])
        XCTAssertEqual(transport.requests.last?.path, "/api/home/cards/a0/used")
        XCTAssertEqual(transport.requests.last?.body, .null)
        XCTAssertTrue(transport.requests.last?.query.isEmpty ?? false)
        XCTAssertFalse(transport.requests.contains { $0.method == "PUT" })
    }

    func testUsedResponseForAnotherCardIsNotApplied() async {
        let expected = "a0"
        let foreign = "foreign-card"
        let usedAt = 7000.0
        let answer = fixtureAnswer()
        let transport = cardsTransport { request, _ in
            if request.method == "POST" {
                return .json(["cardId": JSONValue.string(foreign), "usedAt": JSONValue.number(usedAt)])
            }
            return .json(answer)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"])
        await model.reload()
        let pick = await model.pick(model.visibleCards[0])
        XCTAssertEqual(pick.prompt, "Prompt a0")
        XCTAssertFalse(pick.usedConfirmed)
        XCTAssertFalse(model.confirmedUsed.contains(expected))
        XCTAssertFalse(model.confirmedUsed.contains(foreign))
        XCTAssertNotNil(model.error)
    }

    func testConfirmedMissingCardDoesNotMarkUsed() async {
        let answer = fixtureAnswer()
        let transport = cardsTransport { request, _ in
            request.method == "POST"
                ? .json(["error": ["code": "not_found", "message": "Card not found"]], status: 404)
                : .json(answer)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"])
        await model.reload()
        let pick = await model.pick(model.visibleCards[0])
        XCTAssertFalse(pick.usedConfirmed)
        XCTAssertFalse(pick.usedUnknown)
        XCTAssertTrue(model.confirmedUsed.isEmpty)
        XCTAssertEqual(model.visibleCards.map(\.id), ["a0", "a1"])
        XCTAssertNotNil(model.error)
    }

    func testUnknownUsedOutcomeIsNotRetriedBlindly() async {
        let answer = fixtureAnswer()
        let transport = cardsTransport { request, _ in
            request.method == "POST" ? .failure(.notConnectedToInternet) : .json(answer)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"])
        await model.reload()
        let first = await model.pick(model.visibleCards[0])
        XCTAssertTrue(first.usedUnknown)
        XCTAssertFalse(first.usedConfirmed)
        XCTAssertTrue(model.unknownUsed.contains("a0"))
        let second = await model.pick(model.visibleCards[0])
        XCTAssertTrue(second.usedUnknown)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(model.visibleCards.map(\.id), ["a0", "a1"])
    }

    func testUnknownWorkspaceStillPromptsAndDoesNotOpen() async {
        let gone = "gone"
        let answer = fixtureAnswer(cards: [[
            fixtureCard("x", extra: ["workspaceId": JSONValue.string(gone), "source": ["workspaceId": JSONValue.string(gone)]]),
            fixtureCard("z", extra: ["kind": "tip", "workspaceId": .null, "source": [:], "prompt": ""]),
        ]])
        let transport = cardsTransport { request, _ in
            request.method == "POST"
                ? .json(["cardId": request.path.split(separator: "/").dropLast().last.map { JSONValue.string(String($0)) } ?? "x", "usedAt": 1])
                : .json(answer)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"], hasConversation: true)
        await model.reload()
        let foreign = await model.pick(model.visibleCards[0])
        XCTAssertEqual(foreign.prompt, "Prompt x")
        XCTAssertNil(foreign.workspaceID)
        XCTAssertNil(foreign.nodeID)
        let tip = await model.pick(model.visibleCards[1])
        XCTAssertEqual(tip.prompt, "")
        XCTAssertNil(tip.workspaceID)
    }

    func testOnboardingReplacesBackendCardsAndNeverMarksUsed() async {
        let answer = fixtureAnswer()
        let transport = cardsTransport { _, _ in .json(answer) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"], hasConversation: false)
        await model.reload()
        XCTAssertEqual(model.visibleCards.map(\.title), ["Start a conversation", "Try branching", "@ a page", "Open Pages"])
        XCTAssertFalse(model.canShuffle)
        let compose = await model.pick(model.visibleCards[0])
        XCTAssertEqual(compose.prompt, "Help me plan what to work on today.")
        XCTAssertNil(compose.unsupported)
        let mention = await model.pick(model.visibleCards[2])
        XCTAssertEqual(mention.unsupported, "mention")
        XCTAssertNil(mention.prompt)
        let spaces = await model.pick(model.visibleCards[3])
        XCTAssertEqual(spaces.unsupported, "spaces")
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
    }

    func testCustomizedEmptyHomeDoesNotSubstituteOnboarding() async {
        let answer = fixtureAnswer(cards: [], extra: [
            "greeting": .null,
            "sets": [],
            "cardsCustomized": true,
        ])
        let transport = cardsTransport { _, _ in .json(answer) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, hasConversation: false)
        await model.reload()
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertFalse(model.showsOnboarding)
        XCTAssertFalse(model.showsDefaultHeadline)
        XCTAssertFalse(model.canShuffle)
    }

    func testPageAndHiddenModesNeverFallBackToRecommendationCards() async {
        let page = fixtureAnswer(extra: [
            "contentMode": "page",
            "contentPage": ["id": "home", "title": "My home layout"],
        ])
        let missing = fixtureAnswer(extra: ["contentMode": "page", "contentPage": .null])
        let hidden = fixtureAnswer(extra: ["contentMode": "hidden"])
        let transport = cardsTransport { _, history in
            switch history.count {
            case 1: return .json(page)
            case 2: return .json(missing)
            default: return .json(hidden)
            }
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, hasConversation: true)
        await model.reload()
        XCTAssertTrue(model.showsCustomPageStatus)
        XCTAssertTrue(model.canOpenContentPage)
        XCTAssertEqual(model.snapshot.contentPageID, "home")
        XCTAssertNil(model.snapshot.contentPageWorkspaceID)
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertTrue(model.customPageUnavailableMessage.contains("Open it in Pages"))
        XCTAssertFalse(transport.requests.contains { $0.path.hasPrefix("/api/pages/") })
        await model.reload()
        XCTAssertFalse(model.canOpenContentPage)
        XCTAssertTrue(model.customPageUnavailableMessage.contains("unavailable"))
        XCTAssertTrue(model.visibleCards.isEmpty)
        await model.reload()
        XCTAssertFalse(model.showsCustomPageStatus)
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertEqual(model.snapshot.contentMode, "hidden")
    }

    func testEmptyOwnerAnswerAndGreetingEyebrowMatchWeb() async {
        let transport = cardsTransport { _, _ in .json(self.emptyAnswer()) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, hasConversation: true)
        await model.reload()
        XCTAssertTrue(model.loaded)
        XCTAssertTrue(model.visibleCards.isEmpty)
        XCTAssertNil(model.snapshot.greeting)
        XCTAssertTrue(model.showsDefaultHeadline)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 20))!
        XCTAssertEqual(HomeCardsFormat.eyebrow(now: date, calendar: calendar), "Tue, Oct 20")
    }

    func testUsedPathRejectsOversizedIdentity() {
        let oversized = String(repeating: "a", count: 201)
        XCTAssertThrowsError(try HomeCardsContract.usedPath(oversized))
        XCTAssertEqual(try HomeCardsContract.usedPath("a0"), "/home/cards/a0/used")
    }

    func testUsedAtMustBeAFiniteOwnedTimestamp() throws {
        let cardId = "a0"
        let usedAt = 7000.0
        let ok = try HomeCardsContract.parseUsed(
            ["cardId": JSONValue.string(cardId), "usedAt": JSONValue.number(usedAt)],
            expectedID: cardId
        )
        XCTAssertEqual(ok.cardId, cardId)
        XCTAssertEqual(ok.usedAt, usedAt)
        XCTAssertThrowsError(try HomeCardsContract.parseUsed(
            ["cardId": JSONValue.string(cardId), "usedAt": .null],
            expectedID: cardId
        ))
        XCTAssertThrowsError(try HomeCardsContract.parseUsed(
            ["cardId": "other", "usedAt": JSONValue.number(usedAt)],
            expectedID: cardId
        ))
    }

    func testUnifiedPickCarriesDestinationAndPromptInOneResult() async {
        let cardId = "a0"
        let usedAt = 8_000.0
        let answer = fixtureAnswer()
        let transport = cardsTransport { request, _ in
            request.method == "POST"
                ? .json(["cardId": JSONValue.string(cardId), "usedAt": JSONValue.number(usedAt)])
                : .json(answer)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1", "p2"], hasConversation: true)
        await model.reload()
        let pick = await model.pick(model.visibleCards[0])
        XCTAssertEqual(pick, HomeCardPickResult(
            kind: .recommendation, cardID: cardId, prompt: "Prompt a0", workspaceID: "p1", nodeID: "n-a0",
            startMention: false, openPagesHome: false, contentPageID: nil, contentPageWorkspaceID: nil,
            unsupported: nil, usedConfirmed: true, usedUnknown: false, sends: false
        ))
    }

    func testWorkspaceOnlyCardPreservesKnownWorkspaceWithoutOpeningAThread() async {
        let workspace = "p2"
        let answer = fixtureAnswer(cards: [[
            fixtureCard("w", extra: [
                "workspaceId": JSONValue.string(workspace),
                "source": ["workspaceId": JSONValue.string(workspace)],
            ]),
        ]])
        let transport = cardsTransport { request, _ in
            request.method == "POST"
                ? .json(["cardId": "w", "usedAt": 1])
                : .json(answer)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1", "p2"], hasConversation: true)
        await model.reload()
        let pick = await model.pick(model.visibleCards[0])
        XCTAssertEqual(pick.prompt, "Prompt w")
        XCTAssertEqual(pick.workspaceID, workspace)
        XCTAssertNil(pick.nodeID)
        XCTAssertFalse(pick.sends)
        XCTAssertEqual(pick.kind, .recommendation)
    }

    func testOnboardingMentionAndPagesHomeAreTypedActionsWithoutMutation() async {
        let transport = cardsTransport { _, _ in .json(self.fixtureAnswer()) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"], hasConversation: false)
        await model.reload()
        let mention = await model.pick(model.visibleCards[2])
        XCTAssertEqual(mention.kind, .mention)
        XCTAssertEqual(mention.cardID, "onboarding:mention")
        XCTAssertTrue(mention.startMention)
        XCTAssertNil(mention.prompt)
        XCTAssertFalse(mention.sends)
        let spaces = await model.pick(model.visibleCards[3])
        XCTAssertEqual(spaces.kind, .pagesHome)
        XCTAssertTrue(spaces.openPagesHome)
        XCTAssertFalse(spaces.sends)
        let summary = model.pagesHomeSelection()
        XCTAssertEqual(summary.kind, .pagesHome)
        XCTAssertTrue(summary.openPagesHome)
        XCTAssertFalse(summary.sends)
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
    }

    func testContentPageIdentityComesFromCardsGetWithoutFetchingThePage() async {
        let pageID = "home-page"
        let workspace = "p1"
        let title = "My home layout"
        let answer = fixtureAnswer(extra: [
            "contentMode": "page",
            "contentPage": [
                "id": JSONValue.string(pageID),
                "workspaceId": JSONValue.string(workspace),
                "title": JSONValue.string(title),
            ],
        ])
        let transport = cardsTransport { _, _ in .json(answer) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api, workspaceIDs: ["p1"], hasConversation: true)
        await model.reload()
        XCTAssertEqual(model.snapshot.contentPageID, pageID)
        XCTAssertEqual(model.snapshot.contentPageWorkspaceID, workspace)
        XCTAssertEqual(model.snapshot.contentPageTitle, title)
        XCTAssertTrue(model.canOpenContentPage)
        let opened = await model.openContentPage()
        XCTAssertEqual(opened.kind, .contentPage)
        XCTAssertEqual(opened.contentPageID, pageID)
        XCTAssertEqual(opened.contentPageWorkspaceID, workspace)
        XCTAssertFalse(opened.sends)
        XCTAssertNil(opened.prompt)
        XCTAssertEqual(transport.requests.map(\.path), ["/api/home/cards"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testContentPageTapResolvesWorkspaceOnceAndGuardsReturnedIdentity() async {
        let pageID = "home-page"
        let workspace = "p1"
        let cards = fixtureAnswer(extra: [
            "contentMode": "page",
            "contentPage": ["id": JSONValue.string(pageID), "title": "Layout"],
        ])
        let ownedPage: JSONValue = [
            "id": JSONValue.string(pageID),
            "workspaceId": JSONValue.string(workspace),
            "title": "Layout",
            "revision": 4,
        ]
        let transport = cardsTransport { request, _ in
            if request.path.hasPrefix("/api/pages/") { return .json(ownedPage) }
            return .json(cards)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api)
        await model.reload()
        XCTAssertNil(model.snapshot.contentPageWorkspaceID)
        let opened = await model.openContentPage()
        XCTAssertEqual(opened.contentPageID, pageID)
        XCTAssertEqual(opened.contentPageWorkspaceID, workspace)
        XCTAssertEqual(transport.requests.map(\.path), ["/api/home/cards", "/api/pages/home-page"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
        let again = await model.openContentPage()
        XCTAssertEqual(again.contentPageWorkspaceID, workspace)
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testForeignContentPageGetDoesNotInventAnOpenDestination() async {
        let pageID = "home-page"
        let cards = fixtureAnswer(extra: [
            "contentMode": "page",
            "contentPage": ["id": JSONValue.string(pageID)],
        ])
        let transport = cardsTransport { request, _ in
            if request.path.hasPrefix("/api/pages/") {
                return .json(["id": "other-page", "workspaceId": "p1"])
            }
            return .json(cards)
        }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api)
        await model.reload()
        let opened = await model.openContentPage()
        XCTAssertEqual(opened.kind, .contentPage)
        XCTAssertNil(opened.contentPageID)
        XCTAssertNil(opened.contentPageWorkspaceID)
        XCTAssertNotNil(model.error)
        XCTAssertTrue(model.canOpenContentPage)
    }

    func testMissingContentPageDoesNotClaimOpenSuccess() async {
        let answer = fixtureAnswer(extra: ["contentMode": "page", "contentPage": .null])
        let transport = cardsTransport { _, _ in .json(answer) }
        defer { transport.close() }
        let model = HomeCardsModel(api: transport.api)
        await model.reload()
        XCTAssertFalse(model.canOpenContentPage)
        let opened = await model.openContentPage()
        XCTAssertNil(opened.contentPageID)
        XCTAssertNil(opened.contentPageWorkspaceID)
        XCTAssertEqual(opened.kind, .contentPage)
        XCTAssertFalse(opened.sends)
        XCTAssertEqual(transport.requests.map(\.path), ["/api/home/cards"])
    }

    func testOwnedPageParserRejectsMismatchedIdentity() {
        let expected = "home-page"
        XCTAssertThrowsError(try HomeCardsContract.ownedPage(["id": "other", "workspaceId": "p1"], expectedID: expected))
        XCTAssertThrowsError(try HomeCardsContract.ownedPage(["page": ["id": JSONValue.string(expected), "workspaceId": ""]], expectedID: expected))
        let owned = try? HomeCardsContract.ownedPage(
            ["page": ["id": JSONValue.string(expected), "workspaceId": "p1"]],
            expectedID: expected
        )
        XCTAssertEqual(owned?.id, expected)
        XCTAssertEqual(owned?.workspaceID, "p1")
    }
}
