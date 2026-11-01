import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class BlockCatalogTests: XCTestCase {
    private var directories: [URL] = []
    override func tearDown() {
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        directories = []
        super.tearDown()
    }
    private func journal() -> NativeBlockInsertionJournal {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("michi-block-test-" + UUID().uuidString)
        directories.append(directory)
        return NativeBlockInsertionJournal(directory: directory)
    }
    private func page(revision: Int = 4, blocks: [JSONValue] = [], id: String = "page-1", workspace: String = "workspace-1") -> JSONValue {
        ["id": .string(id), "workspaceId": .string(workspace), "title": "Page", "revision": .number(Double(revision)),
         "blocks": .array(blocks), "opaquePage": ["nested": ["future": true]]]
    }
    private func auxiliary(_ request: AppContractRequest) -> AppContractResponse {
        .json(["items": [], "changes": [], "databaseId": .null])
    }
    private func model(_ transport: AppContractTransport, journal: NativeBlockInsertionJournal? = nil, id: String = "page-1") -> FeaturePageModel {
        FeaturePageModel(api: transport.api, pageId: id, workspaceId: "workspace-1", insertionJournal: journal ?? self.journal())
    }

    func testCanonicalResourceIncludesAll59BrowsableExamplesInWebOrder() throws {
        let catalog = try NativeBlockCatalog()
        XCTAssertEqual(catalog.source["entries"].arrayValue.count, 65)
        XCTAssertEqual(catalog.entries.count, 59)
        XCTAssertEqual(catalog.categories.map(\.id), ["text", "data", "time", "decisions", "media", "conversations"])
        XCTAssertEqual(catalog.entries.first?.id, "heading")
        XCTAssertFalse(catalog.entries.contains { $0.category == "references" })
        XCTAssertEqual(catalog.filtered(query: "", category: "decisions").map(\.id), ["compare", "conflict", "actions", "form", "poll"])
        for entry in catalog.entries where entry.id != "threads" {
            XCTAssertNoThrow(try catalog.validate(entry.input), "Canonical example: \(entry.id)")
        }
    }
    func testSearchUsesNamesDescriptionsTypesAndCategoryLabels() throws {
        let catalog = try NativeBlockCatalog()
        XCTAssertEqual(catalog.filtered(query: "  CHECKLIST \n").map(\.id), ["checklist"])
        XCTAssertEqual(catalog.filtered(query: "data & metrics").map(\.id), catalog.entries.filter { $0.category == "data" }.map(\.id))
        XCTAssertTrue(catalog.filtered(query: "checklist", category: "media").isEmpty)
        XCTAssertEqual(catalog.filtered(query: "plan-actual").first?.id, "plan-actual")
    }
    func testThreadSampleIsVisibleButNeverInsertable() throws {
        let catalog = try NativeBlockCatalog()
        let entry = try XCTUnwrap(catalog.entries.first { $0.id == "threads" })
        XCTAssertNotNil(entry.addedBy)
        XCTAssertThrowsError(try catalog.validate(entry.input))
        XCTAssertNil(catalog.entries.first { $0.id == "heading" }?.addedBy)
    }
    func testPlanDatesUseLocalGregorianDaysAcrossDST() throws {
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-03-09T06:30:00Z")) // March 8 in LA
        let zone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let sample = NativeBlockCatalog.planSample(now: now, timeZone: zone)
        let rows = sample["items"].arrayValue
        XCTAssertEqual(rows[0]["planStart"], "2026-02-22")
        XCTAssertEqual(rows[2]["planEnd"], "2026-03-09")
        XCTAssertEqual(rows[3]["forecastEnd"], "2026-03-14")
        XCTAssertTrue(NativeBlockCatalog.validDay("2024-02-29"))
        XCTAssertFalse(NativeBlockCatalog.validDay("2026-02-29"))
        XCTAssertFalse(NativeBlockCatalog.validDay("2026-04-31"))
        XCTAssertNoThrow(try NativeBlockCatalog().validate(sample))
    }
    func testMalformedSourceAndMetadataAreRejectedWithoutNormalization() throws {
        let catalog = try NativeBlockCatalog()
        let invalid: [JSONValue] = [
            .null, [], ["type": "unknown", "text": "hello"], ["type": "heading", "text": 1],
            ["type": "heading", "text": "hello", "id": "forged"], ["type": "heading", "text": "hello", "rev": 2],
            ["type": "heading", "text": "hello", "edit": ["at": 1]],
            ["type": "checklist", "items": [["text": "Item", "done": "false"]]],
            ["type": "toggle", "title": "Nested", "blocks": [["type": "page-link", "pageId": "other"]]],
            ["type": "form", "title": "Bad", "fields": [["key": "city", "type": "unsupported"]], "prompt": "Draft"],
            ["type": "heading", "text": "hello", "surprise": true],
        ]
        for input in invalid { XCTAssertThrowsError(try catalog.validate(input), input.prettyPrinted) }
    }
    func testContainerKeepsRegionIdentityAndOpaqueInputContent() throws {
        let catalog = try NativeBlockCatalog()
        let entry = try XCTUnwrap(catalog.entries.first { $0.id == "grid" })
        let before = entry.input
        try catalog.validate(entry.input)
        XCTAssertEqual(before, entry.input)
        XCTAssertEqual(entry.input["regions"].arrayValue.first?.id, "main")
    }
    func testReferenceAndComponentInputsAreSupportedWithoutAppearingInCatalog() throws {
        let catalog = try NativeBlockCatalog()
        let component: JSONValue = ["type": "component", "componentId": "component-real", "pinnedVersion": 3,
            "props": ["future": ["nested": [1, "two", true]], "id": "application-prop-not-block-id"]]
        XCTAssertNoThrow(try catalog.validate(component))
        XCTAssertNoThrow(try catalog.validate(["type": "page-link", "pageId": "page-real"]))
        XCTAssertNoThrow(try catalog.validate(["type": "database-ref", "databaseId": "database-real", "viewId": "view-real"]))
        XCTAssertFalse(catalog.entries.contains { $0.id == "component" || $0.id == "page-link" || $0.id == "database-ref" })
        XCTAssertThrowsError(try catalog.validate(component.merging(["pinnedVersion": 0])))
        XCTAssertThrowsError(try catalog.validate(component.merging(["props": "invalid"])))
    }
    func testMalformedCatalogDoesNotAppearEmpty() {
        XCTAssertThrowsError(try NativeBlockCatalog(source: ["version": 1, "entries": []]))
    }
    func testUnhydratedPageCannotInsert() async {
        let transport = AppContractTransport { _, _ in .json([:]) }; defer { transport.close() }
        let page = model(transport)
        let inserted = await page.insertBlock(input: ["type": "heading", "text": "Hi"])
        XCTAssertFalse(inserted); XCTAssertNotNil(page.error); XCTAssertTrue(transport.requests.isEmpty)
    }
    func testFailedRefreshCannotInsertOverPreviouslyLoadedPage() async {
        var failed = false
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/pages/page-1" { return failed ? .failure(.timedOut) : .json(self.page()) }
            return self.auxiliary(request)
        }; defer { transport.close() }
        let model = model(transport); await model.refresh(); failed = true; await model.refresh()
        let inserted = await model.insertBlock(input: ["type": "heading", "text": "Hi"])
        XCTAssertFalse(inserted); XCTAssertEqual(model.revision, 4)
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }
    func testMalformedOrForeignPageIsNeverHydrated() async {
        for response in [page(id: "foreign"), page().merging(["revision": .number(4.5)]), page().merging(["blocks": "invalid"])] {
            let transport = AppContractTransport { request, _ in request.path == "/api/pages/page-1" ? .json(response) : self.auxiliary(request) }
            let model = model(transport); await model.refresh()
            let inserted = await model.insertBlock(input: ["type": "heading", "text": "Hi"])
            XCTAssertFalse(inserted); XCTAssertTrue(model.page.isNull)
            XCTAssertFalse(transport.requests.contains { $0.method == "POST" }); transport.close()
        }
    }
    func testInvalidInsertionMakesNoPost() async {
        let transport = AppContractTransport { request, _ in request.path == "/api/pages/page-1" ? .json(self.page()) : self.auxiliary(request) }
        defer { transport.close() }
        let model = model(transport); await model.refresh()
        let inserted = await model.insertBlock(input: ["type": "heading", "text": "Hi", "sources": []])
        XCTAssertFalse(inserted); XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }
    func testInsertionSendsExactContentRevisionAnchorAndPreservesOpaqueBlocks() async throws {
        let existing: JSONValue = ["id": "block-existing", "rev": 3, "type": "future-block", "opaque": ["deep": [1, 2, 3]], "sources": [["nodeId": "node-1"]]]
        let input = try XCTUnwrap(NativeBlockCatalog().entries.first { $0.id == "grid" }?.input)
        let journal = journal()
        var capturedPending: NativeBlockInsertion?
        var api: MichiAPI!
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/edits") {
                capturedPending = try? journal.load(api: api, pageID: "page-1")
                XCTAssertEqual(capturedPending?.body, request.body)
                XCTAssertEqual(request.body, ["revision": 4, "ops": [["op": "insert", "block": input, "after": "block-existing"]]])
                return .json(["page": self.page(revision: 5, blocks: [existing, input.merging(["id": "block-new", "rev": 5, "edit": ["at": 1]])]), "changes": ["rejected": []]])
            }
            return request.path == "/api/pages/page-1" ? .json(self.page(blocks: [existing])) : self.auxiliary(request)
        }; api = transport.api; defer { transport.close() }
        let model = model(transport, journal: journal); await model.refresh(); model.title = "Unsaved title"
        let inserted = await model.insertBlock(input: input)
        XCTAssertTrue(inserted); XCTAssertNotNil(capturedPending)
        XCTAssertEqual(model.blocks.first, existing); XCTAssertEqual(model.page["opaquePage"], ["nested": ["future": true]])
        XCTAssertEqual(model.title, "Unsaved title"); XCTAssertEqual(model.revision, 5)
        XCTAssertNil(try journal.load(api: transport.api, pageID: "page-1"))
    }
    func testLegacyFourTypeInsertionRetainsItsDefaults() async {
        for type in ["heading", "callout", "checklist", "markdown"] {
            let transport = AppContractTransport { request, _ in
                if request.path.hasSuffix("/edits") {
                    let input = request.body["ops"].arrayValue[0]["block"]
                    XCTAssertEqual(input["type"].stringValue, type)
                    if type == "markdown" { XCTAssertEqual(input["text"], "") }
                    return .json(["page": self.page(revision: 5, blocks: [input.merging(["id": "new", "rev": 5])])])
                }
                return request.path == "/api/pages/page-1" ? .json(self.page()) : self.auxiliary(request)
            }
            let model = model(transport); await model.refresh(); await model.insertBlock(type: type)
            XCTAssertEqual(model.blocks.count, 1); XCTAssertNil(model.error); transport.close()
        }
    }
    func testRevisionConflictKeepsDraftAndCanRetryOnlyAfterExplicitCall() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/edits") { return .json(["error": ["code": "stale_revision", "message": "Page revision changed"]], status: 409) }
            return request.path == "/api/pages/page-1" ? .json(self.page()) : self.auxiliary(request)
        }; defer { transport.close() }
        let model = model(transport); await model.refresh(); model.title = "Draft"
        let inserted = await model.insertBlock(input: ["type": "heading", "text": "Hi"])
        XCTAssertFalse(inserted); XCTAssertNil(model.insertionRecoveryMessage)
        XCTAssertEqual(model.title, "Draft"); XCTAssertEqual(model.revision, 4)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
    func testKnownInvalidRejectionClearsPendingInsertion() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/edits") { return .json(["error": ["code": "invalid", "message": "Invalid references"]], status: 400) }
            return request.path == "/api/pages/page-1" ? .json(self.page()) : self.auxiliary(request)
        }; defer { transport.close() }
        let model = model(transport); await model.refresh()
        let inserted = await model.insertBlock(input: ["type": "heading", "text": "Hi"])
        XCTAssertFalse(inserted); XCTAssertNil(model.insertionRecoveryMessage)
    }
    func testUnknownOutcomeSurvivesRecreationAndRefreshWithoutDuplicatePost() async throws {
        let journal = journal(), input: JSONValue = ["type": "heading", "text": "Hi"]
        var serverPage = page()
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/edits") {
                serverPage = self.page(revision: 5, blocks: [input.merging(["id": "inserted-but-response-lost", "rev": 5])])
                return .failure(.networkConnectionLost)
            }
            return request.path == "/api/pages/page-1" ? .json(serverPage) : self.auxiliary(request)
        }; defer { transport.close() }
        let first = model(transport, journal: journal); await first.refresh()
        let result = await first.insertBlock(input: input); XCTAssertFalse(result)
        XCTAssertNotNil(first.insertionRecoveryMessage)
        XCTAssertFalse(first.resolveUnknownInsertionAfterReview())
        let recreated = model(transport, journal: NativeBlockInsertionJournal(directory: journal.directory)); await recreated.refresh()
        XCTAssertEqual(recreated.blocks.count, 1); XCTAssertNotNil(recreated.insertionRecoveryMessage)
        let retry = await recreated.insertBlock(input: input); XCTAssertFalse(retry)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        let record = try XCTUnwrap(journal.load(api: transport.api, pageID: "page-1"))
        XCTAssertEqual(record.body, ["revision": 4, "ops": [["op": "insert", "block": input, "after": .null]]])
        XCTAssertTrue(recreated.resolveUnknownInsertionAfterReview())
        XCTAssertNil(recreated.insertionRecoveryMessage)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
    func testUnrecognized409DoesNotAuthorizeRetry() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/edits") { return .json(["error": ["code": "other_conflict", "message": "Unknown state"]], status: 409) }
            return request.path == "/api/pages/page-1" ? .json(self.page()) : self.auxiliary(request)
        }; defer { transport.close() }
        let model = model(transport); await model.refresh()
        _ = await model.insertBlock(input: ["type": "heading", "text": "Hi"])
        XCTAssertNotNil(model.insertionRecoveryMessage)
        _ = await model.insertBlock(input: ["type": "heading", "text": "Hi"])
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
    func testWrongPageOrUnconfirmedSuccessKeepsPendingAndOriginalContent() async {
        for response in [page(revision: 5, id: "other"), page(revision: 5), page(revision: 5, workspace: "other")] {
            let transport = AppContractTransport { request, _ in
                if request.path.hasSuffix("/edits") { return .json(["page": response]) }
                return request.path == "/api/pages/page-1" ? .json(self.page()) : self.auxiliary(request)
            }
            let model = model(transport); await model.refresh()
            let inserted = await model.insertBlock(input: ["type": "heading", "text": "Hi"])
            XCTAssertFalse(inserted); XCTAssertNotNil(model.insertionRecoveryMessage); XCTAssertEqual(model.revision, 4)
            transport.close()
        }
    }
    func testCorruptJournalFailsClosedBeforePost() async throws {
        let journal = journal()
        let transport = AppContractTransport { request, _ in request.path == "/api/pages/page-1" ? .json(self.page()) : self.auxiliary(request) }
        defer { transport.close() }
        try FileManager.default.createDirectory(at: XCTUnwrap(journal.directory), withIntermediateDirectories: true)
        try Data("broken".utf8).write(to: journal.fileURL(api: transport.api, pageID: "page-1"))
        let model = model(transport, journal: journal); await model.refresh()
        let inserted = await model.insertBlock(input: ["type": "heading", "text": "Hi"])
        XCTAssertFalse(inserted); XCTAssertNotNil(model.insertionRecoveryMessage)
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }
    func testPendingInsertionIsScopedByConnectionAndPage() throws {
        let journal = journal()
        let first = AppContractTransport { _, _ in .json([:]) }, second = AppContractTransport { _, _ in .json([:]) }
        defer { first.close(); second.close() }
        let record = NativeBlockInsertion(token: "pending", workspaceID: "workspace-1", body: ["revision": 4, "ops": [["op": "insert", "block": ["type": "heading", "text": "Hi"], "after": .null]]])
        try journal.reserve(record, api: first.api, pageID: "page-1")
        defer { journal.finish(record) }
        XCTAssertNotNil(try journal.load(api: first.api, pageID: "page-1"))
        XCTAssertNil(try journal.load(api: first.api, pageID: "page-2"))
        XCTAssertNil(try journal.load(api: second.api, pageID: "page-1"))
    }
    func testSecondControllerCannotSubmitWhileFirstInsertionIsInFlight() async {
        let journal = journal(), input: JSONValue = ["type": "heading", "text": "Hi"]
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/edits") { return .delayedJSON(["page": self.page(revision: 5, blocks: [input.merging(["id": "new", "rev": 5])])], status: 200, delay: 0.4) }
            return request.path == "/api/pages/page-1" ? .json(self.page()) : self.auxiliary(request)
        }; defer { transport.close() }
        let first = model(transport, journal: journal), second = model(transport, journal: journal)
        await first.refresh(); await second.refresh()
        let task = Task { await first.insertBlock(input: input) }
        for _ in 0..<100 {
            if transport.requests.contains(where: { $0.method == "POST" }) { break }
            try? await Task.sleep(for: .milliseconds(2))
        }
        await second.refresh()
        XCTAssertFalse(second.resolveUnknownInsertionAfterReview())
        let duplicate = await second.insertBlock(input: input)
        XCTAssertFalse(duplicate)
        let firstResult = await task.value; XCTAssertTrue(firstResult)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
    private func waitForRequest(_ transport: AppContractTransport, matching predicate: (AppContractRequest) -> Bool, count: Int = 1) async -> Bool {
        for _ in 0..<250 {
            if transport.requests.filter(predicate).count >= count { return true }
            try? await Task.sleep(for: .milliseconds(2))
        }
        return false
    }

    private func assertInFlightRefreshCannotResolveUnknownInsertion(sameController: Bool, getDelay: TimeInterval, postDelay: TimeInterval) async throws {
        let journal = journal(), input: JSONValue = ["type": "heading", "text": "Hi"]
        let stalePage = page()
        let committedPage = page(revision: 5, blocks: [input.merging(["id": "committed", "rev": 5])])
        var showCommittedPage = false
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("/edits") {
                return .delayedJSON(["error": ["code": "internal_error", "message": "Response lost after commit"]], status: 503, delay: postDelay)
            }
            if request.path == "/api/pages/page-1" {
                if showCommittedPage { return .json(committedPage) }
                if requests.filter({ $0.path == request.path }).count > 2 { return .delayedJSON(stalePage, status: 200, delay: getDelay) }
                return .json(stalePage)
            }
            return self.auxiliary(request)
        }; defer { transport.close() }
        let writer = model(transport, journal: journal), other = model(transport, journal: journal)
        await writer.refresh(); await other.refresh()
        let insertion = Task { await writer.insertBlock(input: input) }
        let started = await waitForRequest(transport, matching: { $0.method == "POST" })
        XCTAssertTrue(started)
        let pending = try XCTUnwrap(journal.load(api: transport.api, pageID: "page-1"))
        XCTAssertTrue(journal.isActive(pending.token))
        let reviewer = sameController ? writer : other
        await reviewer.refresh()
        XCTAssertEqual(reviewer.revision, 4)
        let result = await insertion.value
        XCTAssertFalse(result)
        XCTAssertFalse(journal.isActive(pending.token))
        // The prior GET began while the POST was active, even when it completed
        // after the POST. That snapshot cannot acknowledge the unknown result.
        XCTAssertFalse(reviewer.resolveUnknownInsertionAfterReview())
        XCTAssertEqual(try journal.load(api: transport.api, pageID: "page-1"), pending)
        let duplicate = await reviewer.insertBlock(input: input)
        XCTAssertFalse(duplicate)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        showCommittedPage = true
        await reviewer.refresh()
        XCTAssertEqual(reviewer.blocks.first?.id, "committed")
        XCTAssertTrue(reviewer.resolveUnknownInsertionAfterReview())
        XCTAssertNil(try journal.load(api: transport.api, pageID: "page-1"))
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testSameControllerRefreshDuringPostCannotResolveLaterUnknownResult() async throws {
        try await assertInFlightRefreshCannotResolveUnknownInsertion(sameController: true, getDelay: 0, postDelay: 0.25)
    }

    func testOtherControllerRefreshDuringPostCannotResolveLaterUnknownResult() async throws {
        try await assertInFlightRefreshCannotResolveUnknownInsertion(sameController: false, getDelay: 0, postDelay: 0.25)
    }

    func testOtherControllerGetStartedDuringPostCannotResolveWhenGetFinishesAfterUnknownResult() async throws {
        try await assertInFlightRefreshCannotResolveUnknownInsertion(sameController: false, getDelay: 0.25, postDelay: 0.1)
    }

    func testGetStartedBeforeInsertionCannotReviewNewPendingToken() async throws {
        let journal = journal(), input: JSONValue = ["type": "heading", "text": "Hi"]
        let stalePage = page()
        var delayPageRead = false
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/edits") {
                return .json(["error": ["code": "internal_error", "message": "Unknown result"]], status: 503)
            }
            if request.path == "/api/pages/page-1" {
                return delayPageRead ? .delayedJSON(stalePage, status: 200, delay: 0.25) : .json(stalePage)
            }
            return self.auxiliary(request)
        }; defer { transport.close() }
        let writer = model(transport, journal: journal), reviewer = model(transport, journal: journal)
        await writer.refresh(); await reviewer.refresh()
        delayPageRead = true
        let read = Task { await reviewer.refresh() }
        let readStarted = await waitForRequest(transport, matching: { $0.path == "/api/pages/page-1" }, count: 3)
        XCTAssertTrue(readStarted)
        XCTAssertNil(try journal.load(api: transport.api, pageID: "page-1"))
        let inserted = await writer.insertBlock(input: input)
        XCTAssertFalse(inserted)
        await read.value
        XCTAssertFalse(reviewer.resolveUnknownInsertionAfterReview())
        XCTAssertNotNil(try journal.load(api: transport.api, pageID: "page-1"))
        delayPageRead = false
        await reviewer.refresh()
        XCTAssertTrue(reviewer.resolveUnknownInsertionAfterReview())
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testPendingTokenChangedDuringReadIsNotAcknowledged() async throws {
        let journal = journal()
        let transport = AppContractTransport { request, _ in
            request.path == "/api/pages/page-1" ? .delayedJSON(self.page(), status: 200, delay: 0.15) : self.auxiliary(request)
        }; defer { transport.close() }
        let body: JSONValue = ["revision": 4, "ops": [["op": "insert", "block": ["type": "heading", "text": "Hi"], "after": .null]]]
        let first = NativeBlockInsertion(token: UUID().uuidString, workspaceID: "workspace-1", body: body)
        let replacement = NativeBlockInsertion(token: UUID().uuidString, workspaceID: "workspace-1", body: body)
        try journal.reserve(first, api: transport.api, pageID: "page-1"); journal.finish(first)
        let reviewer = model(transport, journal: journal)
        let read = Task { await reviewer.refresh() }
        let started = await waitForRequest(transport, matching: { $0.path == "/api/pages/page-1" })
        XCTAssertTrue(started)
        try journal.clear(first, api: transport.api, pageID: "page-1", requireInactive: true)
        try journal.reserve(replacement, api: transport.api, pageID: "page-1"); journal.finish(replacement)
        await read.value
        XCTAssertFalse(reviewer.resolveUnknownInsertionAfterReview())
        XCTAssertEqual(try journal.load(api: transport.api, pageID: "page-1"), replacement)
        await reviewer.refresh()
        XCTAssertTrue(reviewer.resolveUnknownInsertionAfterReview())
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

    func testFailedPageEditInvalidatesPreviouslyReviewedInsertion() async throws {
        let journal = journal()
        let existing: JSONValue = ["id": "existing", "rev": 4, "type": "heading", "text": "Existing"]
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/edits") { return .failure(.networkConnectionLost) }
            return request.path == "/api/pages/page-1" ? .json(self.page(blocks: [existing])) : self.auxiliary(request)
        }; defer { transport.close() }
        let pending = NativeBlockInsertion(token: UUID().uuidString, workspaceID: "workspace-1",
            body: ["revision": 4, "ops": [["op": "insert", "block": ["type": "heading", "text": "Hi"], "after": .null]]])
        try journal.reserve(pending, api: transport.api, pageID: "page-1"); journal.finish(pending)
        let model = model(transport, journal: journal)
        await model.refresh()
        let updated = await model.updateBlock(id: "existing", expectRev: 4, input: ["type": "heading", "text": "Updated"])
        XCTAssertFalse(updated)
        XCTAssertFalse(model.resolveUnknownInsertionAfterReview())
        XCTAssertEqual(try journal.load(api: transport.api, pageID: "page-1"), pending)
        await model.refresh()
        XCTAssertTrue(model.resolveUnknownInsertionAfterReview())
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

}
