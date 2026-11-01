import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

/// A minimal page store answering /pages and /edits like the backend contract.
private final class FakePageServer: @unchecked Sendable {
    private let lock = NSLock()
    private var revision = 1
    private var blocks: [JSONValue] = [["id": "block-0", "rev": 1, "type": "markdown", "text": ""]]
    private var next = 1
    var pageID = "page-1"
    var workspaceID = "workspace-1"
    var title = ""

    func page() -> JSONValue {
        ["id": .string(pageID), "workspaceId": .string(workspaceID), "title": .string(title), "revision": .number(Double(revision)), "blocks": .array(blocks)]
    }
    func create(_ body: JSONValue) -> JSONValue {
        lock.lock(); defer { lock.unlock() }
        title = body["title"].stringValue
        return page()
    }
    func edit(_ body: JSONValue) -> AppContractResponse {
        lock.lock(); defer { lock.unlock() }
        guard body["revision"].intValue == revision, let op = body["ops"].arrayValue.first else {
            return .json(["error": "Page revision changed", "code": "stale_revision"], status: 409)
        }
        let block: JSONValue = ["type": "markdown", "text": op["block"]["text"]]
        if op["op"] == "update", let index = blocks.firstIndex(where: { $0.id == op["id"].stringValue }) {
            blocks[index] = block.merging(["id": .string(op["id"].stringValue), "rev": .number(Double(blocks[index]["rev"].intValue + 1))])
        } else if op["op"] == "insert", let anchor = blocks.firstIndex(where: { $0.id == op["after"].stringValue }) {
            blocks.insert(block.merging(["id": .string("block-\(next)"), "rev": 1]), at: anchor + 1); next += 1
        } else {
            return .json(["error": "Invalid operation", "code": "invalid"], status: 400)
        }
        revision += 1
        return .json(["page": page(), "changes": ["applied": [], "rejected": []]])
    }
}

private func digestNode(id: String = "digest-1", content: String = "Settled: ship the native digest.", generatedAt: Double = 1_000,
                        viewedAt: JSONValue = .null, status: String = "idle") -> JSONValue {
    ["id": .string(id), "workspace_id": "workspace-1", "tree_id": "tree-1", "kind": "digest", "title": "Research journal", "status": "idle",
     "deleted_at": .null, "purged_at": .null,
     "digest": ["status": .string(status), "content": .string(content), "generatedAt": .number(generatedAt), "viewedAt": viewedAt, "sources": []]]
}

private func snapshot(_ nodes: [JSONValue]) -> JSONValue {
    ["workspace": ["id": "workspace-1", "name": "Fixture", "deleted_at": .null, "archived_at": .null],
     "nodes": .array(nodes), "trees": [], "edges": []]
}

/// Paragraphs of words, each `count` characters long and flush left.
private func paragraph(_ label: String, length: Int) -> String {
    var text = label
    while text.utf16.count + 5 <= length { text += " word" }
    return text
}

@MainActor
final class DesignDigestExportTests: XCTestCase {
    private var directories: [URL] = []
    override func tearDown() {
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        directories = []
        super.tearDown()
    }
    private func temporary() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("michi-digest-export-\(UUID().uuidString)", isDirectory: true)
        directories.append(url)
        return url
    }
    private struct Harness {
        let journal: NativeDigestPageExportJournal
        let insertions: NativeBlockInsertionJournal
    }
    private func harness() -> Harness {
        let root = temporary()
        return Harness(journal: NativeDigestPageExportJournal(directory: root.appendingPathComponent("exports")),
                       insertions: NativeBlockInsertionJournal(directory: root.appendingPathComponent("insertions")))
    }
    private func model(_ transport: AppContractTransport, _ harness: Harness) -> NativeDigestPageExportModel {
        NativeDigestPageExportModel(api: transport.api, workspaceID: "workspace-1", journal: harness.journal, insertionJournal: harness.insertions,
                                    clock: { Date(timeIntervalSince1970: 1_700_000_000) })
    }
    private func eventually(_ message: String, timeout: TimeInterval = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), message)
    }
    private func twoPartDigest() -> (digest: JSONValue, parts: [String]) {
        let first = paragraph("First", length: 1_500), second = paragraph("Second", length: 1_200)
        return (digestNode(content: first + "\n\n" + second), [first, second])
    }

    // MARK: Content

    func testShortDigestIsOneExactPart() throws {
        let text = "Settled\n\n- one\n- two"
        XCTAssertEqual(try NativeDigestPageExport.parts(text), [text])
    }

    func testLongDigestSplitsLosslesslyAtParagraphBoundaries() throws {
        let paragraphs = (1...5).map { paragraph("Paragraph \($0)", length: 900) }
        let text = paragraphs.joined(separator: "\n\n")
        let parts = try NativeDigestPageExport.parts(text)
        XCTAssertGreaterThan(parts.count, 1)
        XCTAssertTrue(parts.allSatisfy { $0.utf16.count <= NativeDigestPageExport.blockTextLimit })
        XCTAssertTrue(parts.joined(separator: "\n\n").utf8.elementsEqual(text.utf8))
        XCTAssertTrue(parts.allSatisfy { part in paragraphs.contains { part.hasPrefix($0) } })
    }

    func testOverlongParagraphIsRefusedNotTruncated() {
        let text = paragraph("Huge", length: 2_500)
        XCTAssertThrowsError(try NativeDigestPageExport.parts(text)) { error in
            XCTAssertTrue(error.localizedDescription.contains("2000"), error.localizedDescription)
        }
    }

    func testFencedCodeIsNeverSplit() throws {
        let code = "```swift\n" + (1...40).map { "let value\($0) = \($0)\n" }.joined(separator: "\n") + "```"
        let lead = paragraph("Lead", length: 1_400)
        let text = lead + "\n\n" + code + "\n\nAfter the code."
        let parts = try NativeDigestPageExport.parts(text)
        XCTAssertEqual(parts.first, lead)
        XCTAssertTrue(parts.allSatisfy { $0.components(separatedBy: "```").count % 2 == 1 }, "every part keeps whole fences")
        XCTAssertTrue(parts.joined(separator: "\n\n").utf8.elementsEqual(text.utf8))

        let hugeFence = "```\n" + String(repeating: "x\n\n", count: 800) + "```"
        XCTAssertThrowsError(try NativeDigestPageExport.parts(lead + "\n\n" + hugeFence))
    }

    func testReferenceDefinitionsAndHTMLRefuseOnlyWhenSplitting() throws {
        let short = "See [the plan][p].\n\n[p]: https://example.com/plan"
        XCTAssertEqual(try NativeDigestPageExport.parts(short), [short])
        let long = paragraph("Long", length: 1_900) + "\n\n" + paragraph("More", length: 900) + "\n\n[p]: https://example.com/plan"
        XCTAssertThrowsError(try NativeDigestPageExport.parts(long))
        let html = paragraph("Long", length: 1_990) + "\n\n<details>\n\nHidden\n\n</details>"
        XCTAssertThrowsError(try NativeDigestPageExport.parts(html))
        let autolink = paragraph("Long", length: 1_990) + "\n\n<https://example.com> is fine."
        XCTAssertEqual(try NativeDigestPageExport.parts(autolink).count, 2)
    }

    func testTitleLimitCountsUTF16AndNeverTruncates() throws {
        XCTAssertEqual(try NativeDigestPageExport.validatedTitle("  Research journal \n"), "Research journal")
        XCTAssertNoThrow(try NativeDigestPageExport.validatedTitle(String(repeating: "a", count: 200)))
        XCTAssertNoThrow(try NativeDigestPageExport.validatedTitle(String(repeating: "😀", count: 100)))
        XCTAssertThrowsError(try NativeDigestPageExport.validatedTitle(String(repeating: "😀", count: 101))) { error in
            XCTAssertTrue(error.localizedDescription.contains("202"), error.localizedDescription)
        }
        XCTAssertThrowsError(try NativeDigestPageExport.validatedTitle(String(repeating: "a", count: 201)))
        XCTAssertThrowsError(try NativeDigestPageExport.validatedTitle(" \n\t"))
    }

    func testReadStateFollowsTheVisibleGeneration() {
        XCTAssertFalse(NativeDigestPageExport.isRead(digestNode()))
        XCTAssertFalse(NativeDigestPageExport.isRead(digestNode(generatedAt: 1_000, viewedAt: 999)))
        XCTAssertTrue(NativeDigestPageExport.isRead(digestNode(generatedAt: 1_000, viewedAt: 1_000)))
    }

    // MARK: Writes

    func testSaveJournalsBeforeCreatingAndWritesEachPartOnce() async throws {
        let harness = harness(), server = FakePageServer(), sample = twoPartDigest()
        var journaledBeforeCreate = false
        var transport: AppContractTransport!
        transport = AppContractTransport { request, _ in
            switch (request.method, request.path) {
            case ("GET", "/api/workspaces/workspace-1"): return .json(snapshot([sample.digest]))
            case ("POST", "/api/workspaces/workspace-1/pages"):
                journaledBeforeCreate = (try? harness.journal.load(api: transport.api, workspaceID: "workspace-1", digestID: "digest-1")) != nil
                return .json(server.create(request.body), status: 201)
            case ("POST", "/api/pages/page-1/edits"): return server.edit(request.body)
            default: return .json(["error": "Unexpected route"], status: 500)
            }
        }
        defer { transport.close() }
        let exporter = model(transport, harness)
        let saved = await exporter.save(digest: sample.digest, title: "Research journal")
        XCTAssertTrue(saved, exporter.error ?? "")
        XCTAssertTrue(journaledBeforeCreate, "the record exists before the create request")
        XCTAssertEqual(exporter.openedPage, NativeDigestExportedPage(id: "page-1", workspaceID: "workspace-1", title: "Research journal"))
        XCTAssertNil(exporter.pending)
        XCTAssertNil(try harness.journal.load(api: transport.api, workspaceID: "workspace-1", digestID: "digest-1"))
        XCTAssertNil(try harness.insertions.load(api: transport.api, pageID: "page-1"))

        let requests = transport.requests
        XCTAssertEqual(requests.map { "\($0.method) \($0.path)" }, [
            "GET /api/workspaces/workspace-1", "POST /api/workspaces/workspace-1/pages",
            "POST /api/pages/page-1/edits", "POST /api/pages/page-1/edits",
        ])
        XCTAssertEqual(requests[1].body, ["title": "Research journal", "template": "blank"])
        let update = requests[2].body["ops"].arrayValue[0], insert = requests[3].body["ops"].arrayValue[0]
        XCTAssertEqual(update, ["op": "update", "id": "block-0", "expectRev": 1, "block": ["type": "markdown", "text": .string(sample.parts[0])]])
        XCTAssertEqual(insert, ["op": "insert", "after": "block-0", "block": ["type": "markdown", "text": .string(sample.parts[1])]])
        XCTAssertEqual(requests[3].body["revision"], 2)
        XCTAssertTrue(server.page()["blocks"].arrayValue.map { $0["text"].stringValue }.joined(separator: "\n\n").utf8
            .elementsEqual(NativeDigestPageExport.visibleMarkdown(sample.digest["digest"]["content"].stringValue).utf8))
    }

    func testOverlongTitleSendsNothing() async {
        let harness = harness()
        let transport = AppContractTransport { _, _ in .json(["error": "Unexpected route"], status: 500) }
        defer { transport.close() }
        let exporter = model(transport, harness)
        let saved = await exporter.save(digest: digestNode(), title: String(repeating: "t", count: 201))
        XCTAssertFalse(saved)
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertTrue(exporter.error?.contains("201") == true)
    }

    func testChangedDigestIsNotSaved() async throws {
        let harness = harness()
        let transport = AppContractTransport { request, _ in
            request.path == "/api/workspaces/workspace-1" ? .json(snapshot([digestNode(content: "Rebuilt elsewhere")])) : .json(["error": "Unexpected"], status: 500)
        }
        defer { transport.close() }
        let exporter = model(transport, harness)
        let saved = await exporter.save(digest: digestNode(), title: "Research journal")
        XCTAssertFalse(saved)
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
        XCTAssertNil(try harness.journal.load(api: transport.api, workspaceID: "workspace-1", digestID: "digest-1"))
    }

    func testKnownCreateRejectionClearsTheRecord() async throws {
        let harness = harness()
        let transport = AppContractTransport { request, _ in
            if request.method == "GET" { return .json(snapshot([digestNode()])) }
            return .json(["error": "Workspace page limit reached", "code": "invalid"], status: 409)
        }
        defer { transport.close() }
        let exporter = model(transport, harness)
        let saved = await exporter.save(digest: digestNode(), title: "Research journal")
        XCTAssertFalse(saved)
        XCTAssertEqual(exporter.error, "Workspace page limit reached")
        XCTAssertNil(exporter.pending)
        XCTAssertNil(exporter.openedPage)
        XCTAssertNil(try harness.journal.load(api: transport.api, workspaceID: "workspace-1", digestID: "digest-1"))
    }

    func testAmbiguousCreateIsNeverRepostedAndReviewIsReadOnly() async throws {
        let harness = harness()
        let transport = AppContractTransport { request, _ in
            switch (request.method, request.path) {
            case ("GET", "/api/workspaces/workspace-1"): return .json(snapshot([digestNode()]))
            case ("POST", "/api/workspaces/workspace-1/pages"): return .failure(.networkConnectionLost)
            case ("GET", "/api/workspaces/workspace-1/pages"):
                return .json(["items": [
                    ["id": "page-old", "workspaceId": "workspace-1", "title": "Research journal", "updatedAt": 1_000],
                    ["id": "page-new", "workspaceId": "workspace-1", "title": "Research journal", "updatedAt": 1_700_000_000_500],
                    ["id": "page-other", "workspaceId": "workspace-1", "title": "Other", "updatedAt": 1_700_000_000_500],
                ], "nextCursor": .null])
            default: return .json(["error": "Unexpected route"], status: 500)
            }
        }
        defer { transport.close() }
        let first = model(transport, harness)
        let saved = await first.save(digest: digestNode(), title: "Research journal")
        XCTAssertFalse(saved)
        XCTAssertTrue(first.error?.contains("won't be created again") == true)
        let record = try XCTUnwrap(try harness.journal.load(api: transport.api, workspaceID: "workspace-1", digestID: "digest-1"))
        XCTAssertNil(record.pageID)

        // A new screen (new model) still refuses to post again.
        let second = model(transport, harness)
        second.load(digestID: "digest-1")
        XCTAssertNotNil(second.pending)
        let again = await second.save(digest: digestNode(), title: "Research journal")
        XCTAssertFalse(again)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1, "the create is never resent")

        await second.checkPendingCreation()
        XCTAssertEqual(second.candidates.map(\.id), ["page-new"])
        XCTAssertEqual(transport.requests.last?.query["parentId"], "null")
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1, "checking only reads")
        XCTAssertNotNil(second.pending)

        second.dismissPending()
        XCTAssertNil(second.pending)
        XCTAssertNil(try harness.journal.load(api: transport.api, workspaceID: "workspace-1", digestID: "digest-1"))
    }

    func testUnconfirmableCreateResponseKeepsTheRecord() async throws {
        let harness = harness()
        let transport = AppContractTransport { request, _ in
            if request.method == "GET" { return .json(snapshot([digestNode()])) }
            if request.path == "/api/workspaces/workspace-1/pages" {
                // The returned title differs from the requested one only by Unicode normalization (NFD vs NFC).
                return .json(["id": "page-1", "workspaceId": "workspace-1", "title": "Cafe\u{301} notes", "revision": 1,
                              "blocks": [["id": "block-0", "rev": 1, "type": "markdown", "text": ""]]], status: 201)
            }
            return .json(["error": "Unexpected route"], status: 500)
        }
        defer { transport.close() }
        XCTAssertEqual("Caf\u{E9} notes", "Cafe\u{301} notes", "Swift String equality would accept this response")
        let exporter = model(transport, harness)
        let saved = await exporter.save(digest: digestNode(), title: "Caf\u{E9} notes")
        XCTAssertFalse(saved)
        XCTAssertNil(exporter.openedPage)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/edits") })
        XCTAssertNotNil(try harness.journal.load(api: transport.api, workspaceID: "workspace-1", digestID: "digest-1"))
    }

    func testSecondWriteWithUnknownOutcomeOpensThePartialPage() async throws {
        let harness = harness(), server = FakePageServer(), sample = twoPartDigest()
        let transport = AppContractTransport { request, history in
            switch (request.method, request.path) {
            case ("GET", "/api/workspaces/workspace-1"): return .json(snapshot([sample.digest]))
            case ("POST", "/api/workspaces/workspace-1/pages"): return .json(server.create(request.body), status: 201)
            case ("POST", "/api/pages/page-1/edits"):
                return history.filter { $0.path.hasSuffix("/edits") }.count == 1 ? server.edit(request.body) : .failure(.timedOut)
            default: return .json(["error": "Unexpected route"], status: 500)
            }
        }
        defer { transport.close() }
        let exporter = model(transport, harness)
        let saved = await exporter.save(digest: sample.digest, title: "Research journal")
        XCTAssertFalse(saved)
        XCTAssertEqual(exporter.openedPage?.id, "page-1", "the known partial page is opened")
        XCTAssertTrue(exporter.error?.contains("won't be sent again") == true)
        let record = try XCTUnwrap(exporter.pending)
        XCTAssertEqual(record.pageID, "page-1")
        XCTAssertEqual(record.savedParts, 1)
        XCTAssertEqual(record.inFlightPart, 1)
        XCTAssertNotNil(try harness.insertions.load(api: transport.api, pageID: "page-1"), "the page screen shows insertion recovery")
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/edits") }.count, 2)
    }

    func testStaleRevisionOnSecondWriteClearsItsInsertionRecord() async throws {
        let harness = harness(), server = FakePageServer(), sample = twoPartDigest()
        let transport = AppContractTransport { request, history in
            switch (request.method, request.path) {
            case ("GET", "/api/workspaces/workspace-1"): return .json(snapshot([sample.digest]))
            case ("POST", "/api/workspaces/workspace-1/pages"): return .json(server.create(request.body), status: 201)
            case ("POST", "/api/pages/page-1/edits"):
                return history.filter { $0.path.hasSuffix("/edits") }.count == 1 ? server.edit(request.body)
                    : .json(["error": "Page revision changed", "code": "stale_revision"], status: 409)
            default: return .json(["error": "Unexpected route"], status: 500)
            }
        }
        defer { transport.close() }
        let exporter = model(transport, harness)
        let saved = await exporter.save(digest: sample.digest, title: "Research journal")
        XCTAssertFalse(saved)
        XCTAssertEqual(exporter.openedPage?.id, "page-1")
        XCTAssertTrue(exporter.error?.contains("wasn't saved") == true)
        XCTAssertNil(try harness.insertions.load(api: transport.api, pageID: "page-1"))
        XCTAssertEqual(exporter.pending?.savedParts, 1)
        XCTAssertNil(exporter.pending?.inFlightPart)
    }

    func testStopTakesEffectOnlyBetweenParts() async throws {
        let harness = harness(), server = FakePageServer(), sample = twoPartDigest()
        let transport = AppContractTransport { request, _ in
            switch (request.method, request.path) {
            case ("GET", "/api/workspaces/workspace-1"): return .json(snapshot([sample.digest]))
            case ("POST", "/api/workspaces/workspace-1/pages"): return .json(server.create(request.body), status: 201)
            case ("POST", "/api/pages/page-1/edits"):
                guard case .json(let value, let status) = server.edit(request.body) else { return .json(["error": "Unexpected"], status: 500) }
                return .delayedJSON(value, status: status, delay: 0.4)
            default: return .json(["error": "Unexpected route"], status: 500)
            }
        }
        defer { transport.close() }
        let exporter = model(transport, harness)
        let save = Task { await exporter.save(digest: sample.digest, title: "Research journal") }
        await eventually("the first part is in flight") { transport.requests.contains { $0.path.hasSuffix("/edits") } }
        XCTAssertTrue(exporter.canStop)
        exporter.requestStop()
        let saved = await save.value
        XCTAssertFalse(saved)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/edits") }.count, 1, "the in-flight part finishes; the next is not sent")
        XCTAssertTrue(exporter.notice?.contains("1 of 2") == true, exporter.notice ?? "")
        XCTAssertEqual(exporter.openedPage?.id, "page-1")
        XCTAssertEqual(exporter.pending?.savedParts, 1)
    }

    func testDigestAndRecordIdentityIsExactUTF8() async throws {
        let harness = harness()
        let nfc = "digest-\u{E9}", nfd = "digest-e\u{301}"
        XCTAssertEqual(nfc, nfd, "Swift String equality treats these as the same")
        let transport = AppContractTransport { request, _ in
            request.path == "/api/workspaces/workspace-1" ? .json(snapshot([digestNode(id: nfd)])) : .json(["error": "Unexpected"], status: 500)
        }
        defer { transport.close() }
        XCTAssertNotEqual(try harness.journal.fileURL(api: transport.api, workspaceID: "workspace-1", digestID: nfc),
                          try harness.journal.fileURL(api: transport.api, workspaceID: "workspace-1", digestID: nfd))
        XCTAssertNotEqual(NativeDigestExportedPage(id: "page-\u{E9}", workspaceID: "workspace-1", title: "T"),
                          NativeDigestExportedPage(id: "page-e\u{301}", workspaceID: "workspace-1", title: "T"))

        let exporter = model(transport, harness)
        let saved = await exporter.save(digest: digestNode(id: nfc), title: "Research journal")
        XCTAssertFalse(saved, "a node with a differently encoded id is not the displayed digest")
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
        XCTAssertNil(try harness.journal.load(api: transport.api, workspaceID: "workspace-1", digestID: nfc))
    }
}
