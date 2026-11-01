import XCTest
import Combine
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class NativeMarkdownTablePresentationTests: XCTestCase {
    private let node = "node-1"
    /// Streaming answer block of turn 1; projection ids are `<assistantId>-b-<n>`.
    private let live = NativeMarkdownTableDocument.live(nodeID: "node-1", turnID: "turn-1", assistantID: "assistant-1", blockID: "assistant-1-b-0")
    /// The same block after persistence: durable blocks keep the projection id.
    private let saved = NativeMarkdownTableDocument.message(nodeID: "node-1", messageID: "assistant-1", fragment: 0, blockID: "assistant-1-b-0")

    private func snapshot(_ rows: [[String]], headers: [String] = ["Name", "Value"]) -> NativeMarkdownTableSnapshot {
        NativeMarkdownTableSnapshot(headers: headers, alignments: Array(repeating: .leading, count: headers.count), rows: rows)
    }

    private func occurrence(_ document: NativeMarkdownTableDocument, _ rows: [[String]], headers: [String] = ["Name", "Value"], ordinal: Int = 0) -> NativeMarkdownTableOccurrence {
        let snap = snapshot(rows, headers: headers)
        return .init(identity: .init(document: document, ordinal: ordinal, signature: snap.signature), snapshot: snap)
    }

    private func presented(_ document: NativeMarkdownTableDocument, ordinal: Int = 0, rows: [[String]] = [["a", "1"]]) -> NativeMarkdownTablePresenter {
        let presenter = NativeMarkdownTablePresenter()
        XCTAssertEqual(presenter.present(document: document, snapshot: snapshot(rows), ordinal: ordinal), .presented)
        return presenter
    }

    // MARK: Same table

    func testPresentKeepsOneSessionAcrossTokenRowRebuild() {
        let presenter = presented(live)
        let id = presenter.session?.id
        XCTAssertEqual(presenter.present(document: live, snapshot: snapshot([["a", "1"], ["b", "2"]]), ordinal: 0), .updated)
        presenter.sync(document: live, snapshot: snapshot([["a", "1"], ["b", "2"], ["c", "3"]]), ordinal: 0)
        presenter.reconcile([occurrence(live, [["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]])], currentNodeID: node)
        XCTAssertEqual(presenter.session?.id, id)
        XCTAssertEqual(presenter.session?.snapshot.rows.count, 4)
        XCTAssertEqual(presenter.session?.snapshot.rows.last, ["d", "4"])
    }

    func testIdenticalRendersDoNotRepublishTheSession() {
        let presenter = presented(live)
        var changes = 0
        let watch = presenter.objectWillChange.sink { _ in changes += 1 }
        defer { watch.cancel() }
        presenter.sync(document: live, snapshot: snapshot([["a", "1"]]), ordinal: 0)
        presenter.reconcile([occurrence(live, [["a", "1"]])], currentNodeID: node)
        XCTAssertEqual(presenter.present(document: live, snapshot: snapshot([["a", "1"]]), ordinal: 0), .updated)
        XCTAssertEqual(changes, 0)
        presenter.reconcile([occurrence(live, [["a", "1"], ["b", "2"]])], currentNodeID: node)
        XCTAssertEqual(changes, 1)
    }

    func testLateAssistantIDRefinesTheLiveSourceWithoutDismissing() {
        let early = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-1", assistantID: nil, blockID: "turn-1-b-0")
        let known = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-1", assistantID: "assistant-1", blockID: "turn-1-b-0")
        let presenter = presented(early)
        let id = presenter.session?.id
        presenter.reconcile([occurrence(known, [["a", "1"], ["b", "2"]])], currentNodeID: node)
        XCTAssertEqual(presenter.session?.id, id)
        XCTAssertEqual(presenter.session?.identity.document, known)
        // A later render without the turn id keeps what is already known.
        let turnless = NativeMarkdownTableDocument.live(nodeID: node, turnID: nil, assistantID: "assistant-1", blockID: "turn-1-b-0")
        presenter.reconcile([occurrence(turnless, [["a", "1"], ["b", "2"]])], currentNodeID: node)
        XCTAssertEqual(presenter.session?.identity.document, known)
    }

    // MARK: Never adopt another table

    func testPresentAndSyncIgnoreAnotherBlockOrOrdinal() {
        let presenter = presented(live)
        let id = presenter.session?.id
        let otherBlock = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-1", assistantID: "assistant-1", blockID: "assistant-1-b-2")
        XCTAssertEqual(presenter.present(document: otherBlock, snapshot: snapshot([["x", "9"]]), ordinal: 0), .ignored)
        presenter.sync(document: otherBlock, snapshot: snapshot([["x", "9"]]), ordinal: 0)
        XCTAssertEqual(presenter.present(document: live, snapshot: snapshot([["y", "8"]]), ordinal: 1), .ignored)
        presenter.sync(document: live, snapshot: snapshot([["y", "8"]]), ordinal: 1)
        presenter.sync(document: saved, snapshot: snapshot([["z", "7"]]), ordinal: 0)
        XCTAssertEqual(presenter.session?.id, id)
        XCTAssertEqual(presenter.session?.identity.document, live)
        XCTAssertEqual(presenter.session?.snapshot.rows, [["a", "1"]])
    }

    func testDifferentDocumentWithIdenticalHeadersIsNeverAdopted() {
        let first = NativeMarkdownTableDocument.message(nodeID: node, messageID: "assistant-1", fragment: 0, blockID: "assistant-1-b-0")
        let second = NativeMarkdownTableDocument.message(nodeID: node, messageID: "assistant-2", fragment: 0, blockID: "assistant-2-b-0")
        let otherLive = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-3", assistantID: "assistant-3", blockID: "assistant-3-b-0")
        let presenter = presented(first)
        let id = presenter.session?.id
        presenter.reconcile([
            occurrence(first, [["a", "1"]]),
            occurrence(second, [["x", "9"], ["y", "8"]]),
            occurrence(otherLive, [["z", "7"]]),
        ], currentNodeID: node)
        XCTAssertEqual(presenter.session?.id, id)
        XCTAssertEqual(presenter.session?.identity.document, first)
        XCTAssertEqual(presenter.session?.snapshot.rows, [["a", "1"]])
        presenter.reconcile([occurrence(second, [["x", "9"]]), occurrence(otherLive, [["z", "7"]])], currentNodeID: node)
        XCTAssertNil(presenter.session)
    }

    func testOrdinalMismatchOrDifferentHeadersAtTheOrdinalDismisses() {
        let byOrdinal = presented(live, ordinal: 0)
        byOrdinal.reconcile([occurrence(live, [["a", "1"], ["b", "2"]], ordinal: 1)], currentNodeID: node)
        XCTAssertNil(byOrdinal.session, "Same headers at another index are another table")

        let byHeaders = presented(live, ordinal: 0)
        byHeaders.reconcile([occurrence(live, [["a", "1"]], headers: ["Other", "Col"], ordinal: 0)], currentNodeID: node)
        XCTAssertNil(byHeaders.session)

        let duplicated = presented(live, ordinal: 0)
        duplicated.reconcile([occurrence(live, [["a", "1"]]), occurrence(live, [["b", "2"]])], currentNodeID: node)
        XCTAssertNil(duplicated.session, "Two sources claiming one block are not provably the open table")
    }

    func testNextTurnIdenticalTableDoesNotReplaceTheOpenTable() {
        let nextLive = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-2", assistantID: "assistant-2", blockID: "assistant-2-b-0")
        let savedSession = presented(saved)
        let id = savedSession.session?.id
        savedSession.reconcile([occurrence(saved, [["a", "1"]]), occurrence(nextLive, [["a", "1"], ["b", "2"]])], currentNodeID: node)
        XCTAssertEqual(savedSession.session?.id, id)
        XCTAssertEqual(savedSession.session?.identity.document, saved)
        XCTAssertEqual(savedSession.session?.snapshot.rows, [["a", "1"]])

        // A live table of turn 1 never follows turn 2, even with the same block index.
        let liveSession = presented(live)
        let reusedIndex = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-2", assistantID: "assistant-1", blockID: "assistant-1-b-0")
        liveSession.reconcile([occurrence(nextLive, [["a", "1"]]), occurrence(reusedIndex, [["a", "1"]])], currentNodeID: node)
        XCTAssertNil(liveSession.session)
    }

    func testSourceRemovalDismissesWhileAnotherSameHeaderTableRemains() {
        let sibling = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-1", assistantID: "assistant-1", blockID: "assistant-1-b-2")
        let historical = NativeMarkdownTableDocument.message(nodeID: node, messageID: "assistant-0", fragment: 0, blockID: "assistant-0-b-0")
        let presenter = presented(live)
        presenter.reconcile([occurrence(sibling, [["a", "1"]]), occurrence(historical, [["a", "1"]])], currentNodeID: node)
        XCTAssertNil(presenter.session)
        XCTAssertFalse(presenter.isPresenting)
    }

    func testCanonicallyEquivalentNodeIDIsAnotherSource() {
        let composed = "caf\u{00E9}"
        let decomposed = "cafe\u{0301}"
        let liveNFC = NativeMarkdownTableDocument.live(nodeID: composed, turnID: "turn-1", assistantID: "assistant-1", blockID: "assistant-1-b-0")
        let liveNFD = NativeMarkdownTableDocument.live(nodeID: decomposed, turnID: "turn-1", assistantID: "assistant-1", blockID: "assistant-1-b-0")
        XCTAssertTrue(composed == decomposed, "Swift String == folds NFC/NFD; the presenter must not")
        XCTAssertFalse(DesignChatOpaqueID.same(composed, decomposed))
        XCTAssertNotEqual(liveNFC, liveNFD)

        let byNode = presented(liveNFC)
        byNode.reconcile([occurrence(liveNFC, [["a", "1"], ["b", "2"]])], currentNodeID: decomposed)
        XCTAssertNil(byNode.session)

        let bySource = presented(liveNFC)
        bySource.reconcile([occurrence(liveNFD, [["a", "1"], ["b", "2"]])], currentNodeID: composed)
        XCTAssertNil(bySource.session)
    }

    // MARK: Stream completion

    func testCompletionTransfersOnlyToTheProvenPersistedFragment() {
        let presenter = presented(live, ordinal: 1)
        let id = presenter.session?.id
        let unrelated = NativeMarkdownTableDocument.message(nodeID: node, messageID: "assistant-0", fragment: 0, blockID: "assistant-0-b-0")
        presenter.reconcile([
            occurrence(unrelated, [["old", "0"]], ordinal: 1),
            occurrence(saved, [["a", "1"], ["b", "2"], ["c", "3"]], ordinal: 1),
        ], currentNodeID: node)
        XCTAssertEqual(presenter.session?.id, id)
        XCTAssertEqual(presenter.session?.identity.document, saved)
        XCTAssertEqual(presenter.session?.identity.ordinal, 1)
        XCTAssertEqual(presenter.session?.snapshot.rows.count, 3)

        // Once saved, the session is that message's table; inline syncs from it apply.
        presenter.sync(document: saved, snapshot: snapshot([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]), ordinal: 1)
        XCTAssertEqual(presenter.session?.snapshot.rows.count, 4)
        presenter.reconcile([], currentNodeID: node)
        XCTAssertNil(presenter.session)
    }

    func testCompletionWithoutAProvableMappingDismisses() {
        let unproven: [(String, NativeMarkdownTableDocument, Int)] = [
            ("no durable block id", .message(nodeID: node, messageID: "assistant-1", fragment: 0, blockID: nil), 0),
            ("another block", .message(nodeID: node, messageID: "assistant-1", fragment: 2, blockID: "assistant-1-b-2"), 0),
            ("another message", .message(nodeID: node, messageID: "assistant-2", fragment: 0, blockID: "assistant-1-b-0"), 0),
            ("legacy message without blocks", .message(nodeID: node, messageID: "assistant-1"), 0),
            ("another ordinal", saved, 1),
        ]
        for (reason, document, ordinal) in unproven {
            let presenter = presented(live)
            presenter.reconcile([occurrence(document, [["a", "1"], ["b", "2"]], ordinal: ordinal)], currentNodeID: node)
            XCTAssertNil(presenter.session, reason)
        }

        let liveNFC = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-1", assistantID: "caf\u{00E9}", blockID: "caf\u{00E9}-b-0")
        let savedNFD = NativeMarkdownTableDocument.message(nodeID: node, messageID: "cafe\u{0301}", fragment: 0, blockID: "cafe\u{0301}-b-0")
        let normalized = presented(liveNFC)
        normalized.reconcile([occurrence(savedNFD, [["a", "1"], ["b", "2"]])], currentNodeID: node)
        XCTAssertNil(normalized.session, "A canonically equivalent message id is another message")

        let unknownAssistant = NativeMarkdownTableDocument.live(nodeID: node, turnID: "turn-1", assistantID: nil, blockID: "assistant-1-b-0")
        let presenter = presented(unknownAssistant)
        presenter.reconcile([occurrence(saved, [["a", "1"], ["b", "2"]])], currentNodeID: node)
        XCTAssertNil(presenter.session, "Without the assistant id the persisted message cannot be proven")
    }

    func testTracksOnlyItsOwnSourceAndProvablePersistedForm() {
        let presenter = NativeMarkdownTablePresenter()
        XCTAssertFalse(presenter.tracks(live))
        presenter.present(document: live, snapshot: snapshot([["a", "1"]]), ordinal: 0)
        XCTAssertTrue(presenter.tracks(live))
        XCTAssertTrue(presenter.tracks(saved))
        XCTAssertFalse(presenter.tracks(.message(nodeID: node, messageID: "assistant-1", fragment: 2, blockID: "assistant-1-b-2")))
        XCTAssertFalse(presenter.tracks(.message(nodeID: node, messageID: "assistant-1")))
        XCTAssertFalse(presenter.tracks(.live(nodeID: node, turnID: "turn-2", assistantID: "assistant-2", blockID: "assistant-2-b-0")))
    }

    func testProjectionBlockIDsUseTheDurableIDScheme() {
        // The transfer proof relies on TurnProjection minting the same block ids
        // the backend persists (shared/src/turnProjection.ts nextBlockId).
        var projection = TurnProjection(nodeId: node, turnId: "turn-1")
        projection.apply(SSEEvent(event: "turn_start", data: ["nodeId": "node-1", "turnId": "turn-1", "assistantId": "assistant-1", "seq": 0]))
        projection.apply(SSEEvent(event: "chunk", data: ["nodeId": "node-1", "turnId": "turn-1", "assistantId": "assistant-1", "seq": 1, "text": "| A |\n| --- |\n| 1 |"]))
        XCTAssertEqual(projection.assistantId, "assistant-1")
        XCTAssertEqual(projection.blocks.map(\.id), ["assistant-1-b-0"])
    }

    // MARK: Catalog and export

    func testCatalogWalksQuotedTablesInRenderOrder() {
        let markdown = """
        | A | B |
        | --- | --- |
        | 1 | 2 |

        > | Q | R |
        > | --- | --- |
        > | 3 | 4 |
        """
        let items = NativeMarkdownTableCatalog.occurrences(in: markdown, document: live)
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].identity.ordinal, 0)
        XCTAssertEqual(items[0].snapshot.headers, ["A", "B"])
        XCTAssertEqual(items[1].identity.ordinal, 1)
        XCTAssertEqual(items[1].snapshot.headers, ["Q", "R"])
        XCTAssertEqual(items[1].snapshot.rows, [["3", "4"]])
        let sources = [NativeMarkdownTableSource(document: live, markdown: markdown), NativeMarkdownTableSource(document: saved, markdown: markdown)]
        XCTAssertEqual(NativeMarkdownTableCatalog.occurrences(in: sources).map(\.identity.ordinal), [0, 1, 0, 1])
    }

    func testCatalogNumbersTablesExactlyLikeNativeMarkdownIncludingHTML() {
        let markdown = """
        | A | B |
        | --- | --- |
        | 1 | 2 |

        > | Q | R |
        > | --- | --- |
        > | 3 | 4 |

        <table><tr><th>H</th></tr><tr><td>1</td></tr></table>

        <details>
        <summary>Note</summary>
        <table><tr><th>D</th></tr><tr><td>2</td></tr></table>
        </details>
        """
        let items = NativeMarkdownTableCatalog.occurrences(in: markdown, document: live)
        XCTAssertEqual(items.map(\.identity.ordinal), [0, 1, 2, 3])
        XCTAssertEqual(items.map(\.snapshot.headers), [["A", "B"], ["Q", "R"], ["H"], ["D"]])
        XCTAssertEqual(items.count, NativeMarkdownTableOrder.count(in: MarkdownDocument(markdown).blocks))

        // An HTML table before a Markdown table shifts the Markdown table's number.
        let shifted = NativeMarkdownTableCatalog.occurrences(in: "<table><tr><th>H</th></tr><tr><td>1</td></tr></table>\n\n| A |\n| --- |\n| 1 |", document: live)
        XCTAssertEqual(shifted.last?.snapshot.headers, ["A"])
        XCTAssertEqual(shifted.last?.identity.ordinal, 1)
    }

    func testHostedHTMLTablePreservesLiteralAndSemanticCellFragments() throws {
        let source = "<table><tr><th>H</th></tr><tr><td>&lt;sub&gt;2&lt;/sub&gt;</td></tr><tr><td>H<sub>2</sub>O</td></tr></table>"
        let item = try XCTUnwrap(NativeMarkdownTableCatalog.occurrences(in: source, document: live).first)
        let cells = try XCTUnwrap(item.snapshot.rowCells)
        XCTAssertEqual(cells.count, 2)
        XCTAssertEqual(cells[0][0], [.text("<sub>2</sub>")])
        XCTAssertNotEqual(cells[0][0], cells[1][0])
        let presenter = NativeMarkdownTablePresenter()
        presenter.present(document: live, snapshot: item.snapshot, ordinal: 0)
        XCTAssertEqual(presenter.session?.snapshot.rowCells, cells)
        presenter.reconcile(NativeMarkdownTableCatalog.occurrences(in: source, document: live), currentNodeID: node)
        XCTAssertEqual(presenter.session?.snapshot.rowCells, cells)
    }

    func testCatalogAndSnapshotKeepByteExactHeaders() {
        let composed = "caf\u{00E9}"
        let decomposed = "cafe\u{0301}"
        let markdown = """
        | \(composed) |
        | --- |
        | x |
        """
        let items = NativeMarkdownTableCatalog.occurrences(in: markdown, document: live)
        XCTAssertEqual(items.count, 1)
        XCTAssertTrue(items[0].snapshot.headers[0].utf8.elementsEqual(composed.utf8))
        XCTAssertFalse(items[0].snapshot.signature == NativeMarkdownTableSnapshot(headers: [decomposed], alignments: [.leading], rows: [["x"]]).signature)
    }

    func testWatchIsByteExact() {
        let composed = NativeMarkdownTableSource(document: live, markdown: "caf\u{00E9}")
        let decomposed = NativeMarkdownTableSource(document: live, markdown: "cafe\u{0301}")
        XCTAssertNotEqual(NativeMarkdownTableWatch(nodeID: node, sources: [composed]), NativeMarkdownTableWatch(nodeID: node, sources: [decomposed]))
        XCTAssertEqual(NativeMarkdownTableWatch(nodeID: node, sources: [composed]), NativeMarkdownTableWatch(nodeID: node, sources: [composed]))
        XCTAssertNotEqual(NativeMarkdownTableWatch.idle, NativeMarkdownTableWatch(nodeID: node, sources: []))
    }

    func testExportSnapshotIsTheCompleteTableNotAPage() throws {
        let rows = (0..<25).map { [String($0), "v\($0)"] }
        let presenter = presented(live, rows: Array(rows.prefix(3)))
        presenter.sync(document: live, snapshot: snapshot(rows), ordinal: 0)
        let session = try XCTUnwrap(presenter.session)
        XCTAssertEqual(session.snapshot.rows.count, 25)
        XCTAssertEqual(session.snapshot.rows.first, ["0", "v0"])
        XCTAssertEqual(session.snapshot.rows.last, ["24", "v24"])
        let markdown = try MarkdownTableExport.serialize(
            headers: session.snapshot.headers,
            alignments: session.snapshot.alignments,
            rows: session.snapshot.rows
        )
        XCTAssertEqual(markdown.split(separator: "\n").count, 27)
    }
}
