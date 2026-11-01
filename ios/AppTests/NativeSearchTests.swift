import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func nativeSearchFixture(_ nodeID: String = "node-1", matches: Int = 5) -> JSONValue {
    ["nodeId": .string(nodeID), "nodeTitle": "Release plan", "workspaceId": "workspace-1",
     "workspaceName": "Fixture", "treeId": "tree-1", "lastMessageAt": 1000,
     "totalMatches": .number(Double(matches)), "breadcrumb": ["Root", "Release plan"],
     "snippets": matches == 0
        ? [["messageId": "", "role": "assistant", "snippet": "<mark>Release</mark> plan"]]
        : [["messageId": "message-1", "role": "user", "snippet": "First <mark>release</mark> match"],
           ["messageId": "message-2", "role": "assistant", "snippet": "Second release match"],
           ["messageId": "message-3", "role": "assistant", "snippet": "Third release match"]],
     "futureField": ["preserved": true]]
}

private func nativeSearchAnswer(_ records: [JSONValue] = [nativeSearchFixture()]) -> JSONValue {
    ["results": .array(records), "totalNodes": .number(Double(records.count))]
}

@MainActor final class NativeSearchTests: XCTestCase {
    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func readyStore(_ transport: AppContractTransport) -> MichiStore {
        let store = MichiStore(api: transport.api)
        store.graphs = [appContractGraph()]; store.hydrated = true
        return store
    }

    func testTypedGroupsKeepEveryRealMessageAndUnknownData() throws {
        let result = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer()).first)
        XCTAssertEqual(result.nodeID, "node-1"); XCTAssertEqual(result.workspaceID, "workspace-1")
        XCTAssertEqual(result.treeID, "tree-1"); XCTAssertEqual(result.breadcrumb, ["Root", "Release plan"])
        XCTAssertEqual(result.snippets.compactMap(\.messageID), ["message-1", "message-2", "message-3"])
        XCTAssertEqual(result.snippets[0].text, "First release match")
        XCTAssertEqual(result.totalMatches, 5); XCTAssertEqual(result.remainingMatches, 2)
        XCTAssertEqual(result.raw["futureField"], ["preserved": true])
    }

    func testTitleOnlyResultNeverInventsAMessageTarget() throws {
        let raw = nativeSearchFixture(matches: 0).merging(["nodeTitle": .null, "treeId": .null])
        let result = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer([raw])).first)
        XCTAssertNil(result.snippets.first?.messageID); XCTAssertEqual(result.snippets.first?.text, "Release plan")
        XCTAssertEqual(result.title, "New conversation"); XCTAssertEqual(result.totalMatches, 0)
        XCTAssertEqual(result.remainingMatches, 0); XCTAssertNil(result.treeID)
    }

    func testHighlightMarkersArePlainTextWithoutInterpretingHTMLOrEntities() {
        XCTAssertEqual(NativeSearchContract.plainSnippet("<script>x</script> **bold** &lt;x&gt; <mark>中文</mark> / <mark>two</mark>"),
                       "<script>x</script> **bold** &lt;x&gt; 中文 / two")
        XCTAssertEqual(NativeSearchContract.plainSnippet("before <mark>unclosed"), "before <mark>unclosed")
        XCTAssertEqual(NativeSearchContract.plainSnippet("literal </mark> after"), "literal </mark> after")
    }

    func testMalformedReplyDoesNotMasqueradeAsSuccessfulEmptySearch() {
        for payload: JSONValue in [.null, ["error": "failure"], ["results": .null, "totalNodes": 0],
                                   ["results": [], "totalNodes": -1], ["results": [], "totalNodes": "0"],
                                   ["results": [], "totalNodes": 1]] {
            XCTAssertThrowsError(try NativeSearchContract.results(payload))
        }
        XCTAssertEqual(try NativeSearchContract.results(nativeSearchAnswer([])), [])
    }

    func testMalformedIdentityCountsAndDuplicateMessageIDsRejectWholeAnswer() {
        let bad: [JSONValue] = [
            nativeSearchFixture().merging(["nodeId": ""]),
            nativeSearchFixture().merging(["workspaceId": "wrong\nworkspace"]),
            nativeSearchFixture().merging(["treeId": true]),
            nativeSearchFixture().merging(["lastMessageAt": -1]),
            nativeSearchFixture().merging(["totalMatches": 1]),
            nativeSearchFixture().merging(["totalMatches": .number(2.5)]),
            nativeSearchFixture().merging(["breadcrumb": ["Root", 5]]),
            nativeSearchFixture().merging(["snippets": [["messageId": "", "role": "user", "snippet": "bad"]]]),
            nativeSearchFixture().merging(["snippets": [["messageId": "message", "role": "tool", "snippet": "bad"]]]),
            nativeSearchFixture().merging(["snippets": [["messageId": "message", "role": "user", "snippet": 5]]]),
            nativeSearchFixture().merging(["snippets": .array(Array(repeating: ["messageId": "same", "role": "user", "snippet": "x"], count: 2))]),
        ]
        for item in bad { XCTAssertThrowsError(try NativeSearchContract.results(nativeSearchAnswer([nativeSearchFixture("valid"), item]))) }
        XCTAssertThrowsError(try NativeSearchContract.results(nativeSearchAnswer([nativeSearchFixture(), nativeSearchFixture()])))
    }

    func testServerBoundsAreValidatedWithoutSilentlyTruncatingSnippets() {
        let tooManySnippets = nativeSearchFixture().merging(["snippets": .array((0..<4).map { ["messageId": .string("m-\($0)"), "role": "assistant", "snippet": "x"] })])
        XCTAssertThrowsError(try NativeSearchContract.results(nativeSearchAnswer([tooManySnippets])))
        XCTAssertThrowsError(try NativeSearchContract.results(nativeSearchAnswer((0..<31).map { nativeSearchFixture("n-\($0)") })))
        let deep = nativeSearchFixture().merging(["breadcrumb": .array(Array(repeating: "x", count: 51))])
        XCTAssertThrowsError(try NativeSearchContract.results(nativeSearchAnswer([deep])))
    }

    func testVisibilityRequiresCurrentWorkspaceNodeAndTreeOwnership() throws {
        let result = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer()).first)
        XCTAssertNotNil(NativeSearchContract.destination(result, graphs: [appContractGraph()]))
        XCTAssertNil(NativeSearchContract.destination(result, graphs: []))
        for changes: [String: JSONValue] in [
            ["deleted_at": 2], ["purged_at": 2], ["page_id": "page"], ["maintenance_job_id": "job"],
            ["kind": "digest"], ["workspace_id": "elsewhere"], ["tree_id": "elsewhere"],
        ] {
            var graph = appContractGraph(); graph.raw["nodes"] = .array([graph.nodes[0].merging(changes)])
            XCTAssertNil(NativeSearchContract.destination(result, graphs: [graph]))
        }
        for changes: [String: JSONValue] in [["deleted_at": 2], ["purged_at": 2], ["settings": ["system": "assistant"]], ["settings": ["system": true]]] {
            var graph = appContractGraph(); graph.raw["workspace"] = graph.workspace.merging(changes)
            XCTAssertNil(NativeSearchContract.destination(result, graphs: [graph]))
        }
        var graph = appContractGraph(); graph.raw["trees"] = .array([graph.trees[0].merging(["workspace_id": "elsewhere"])])
        XCTAssertNil(NativeSearchContract.destination(result, graphs: [graph]))
    }

    func testArchivedWorkspaceAndTreeRemainReadableSearchTargets() throws {
        let result = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer()).first)
        for graph in [appContractGraph(workspaceArchived: true), appContractGraph(treeArchived: true)] {
            XCTAssertNotNil(NativeSearchContract.destination(result, graphs: [graph]))
        }
    }

    func testDuplicateOwnersAndCanonicallyEquivalentOpaqueIDsCannotRedirectSearch() throws {
        let result = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer()).first)
        let graph = appContractGraph()
        XCTAssertNil(NativeSearchContract.destination(result, graphs: [graph, graph]))
        var duplicate = graph; duplicate.raw["nodes"] = .array(graph.nodes + graph.nodes)
        XCTAssertNil(NativeSearchContract.destination(result, graphs: [duplicate]))
        let composed = "caf\u{00E9}", decomposed = "cafe\u{0301}"
        let unicodeResult = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer([nativeSearchFixture(composed)])).first)
        var different = graph
        different.raw["nodes"] = .array([graph.nodes[0].merging(["id": .string(decomposed)])])
        different.raw["trees"] = .array([graph.trees[0].merging(["root_node_id": .string(decomposed)])])
        XCTAssertNil(NativeSearchContract.destination(unicodeResult, graphs: [different]))
        different.raw["nodes"] = .array([graph.nodes[0].merging(["id": .string(composed)])])
        different.raw["trees"] = .array([graph.trees[0].merging(["root_node_id": .string(composed)])])
        XCTAssertNotNil(NativeSearchContract.destination(unicodeResult, graphs: [different]))
    }

    func testSearchSendsTrimmedEncodedGroupedGETAndTracksLoading() async {
        let transport = AppContractTransport { request, _ in
            XCTAssertEqual(request.method, "GET"); XCTAssertEqual(request.path, "/api/search")
            XCTAssertEqual(request.query, ["q": "map + a&b #中文", "mode": "grouped", "limit": "30"])
            return .json(nativeSearchAnswer())
        }; defer { transport.close() }
        let store = readyStore(transport)
        store.search(" \nmap + a&b #中文\t")
        XCTAssertTrue(store.searchLoading); XCTAssertFalse(store.searchCompleted); XCTAssertTrue(store.searchResults.isEmpty)
        await waitUntil { store.searchCompleted }
        XCTAssertFalse(store.searchLoading); XCTAssertNil(store.searchError)
        XCTAssertEqual(store.visibleSearchResults.count, 1); XCTAssertEqual(transport.requests.count, 1)
    }

    func testDebounceCancelsSupersededInputBeforeAnyRequest() async {
        let transport = AppContractTransport { request, _ in
            XCTAssertEqual(request.query["q"], "new"); return .json(nativeSearchAnswer())
        }; defer { transport.close() }
        let store = readyStore(transport)
        store.search("old"); store.search("new")
        await waitUntil { store.searchCompleted }
        XCTAssertEqual(transport.requests.count, 1); XCTAssertEqual(store.searchQuery, "new")
    }

    func testNewQueryImmediatelyClearsOldRowsAndEmptyInputCancelsLoading() async {
        let transport = AppContractTransport { _, _ in .json(nativeSearchAnswer()) }; defer { transport.close() }
        let store = readyStore(transport)
        store.search("old"); await waitUntil { store.searchCompleted }
        XCTAssertFalse(store.searchResults.isEmpty)
        store.search("new")
        XCTAssertTrue(store.searchResults.isEmpty); XCTAssertTrue(store.searchLoading); XCTAssertFalse(store.searchCompleted)
        store.search(" \n\t ")
        XCTAssertTrue(store.searchResults.isEmpty); XCTAssertFalse(store.searchLoading); XCTAssertFalse(store.searchCompleted)
        XCTAssertEqual(store.searchQuery, "")
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testLateOldReplyCannotReplaceNewQueryResultsOrFailure() async {
        let transport = AppContractTransport { request, _ in
            if request.query["q"] == "old" { return .delayedJSON(nativeSearchAnswer([nativeSearchFixture("old-node")]), status: 200, delay: 0.6) }
            return .json(nativeSearchAnswer())
        }; defer { transport.close() }
        let store = readyStore(transport)
        store.search("old"); await waitUntil { transport.requests.count == 1 }
        store.search("new"); await waitUntil { store.searchCompleted }
        try? await Task.sleep(for: .milliseconds(650))
        XCTAssertEqual(store.searchQuery, "new"); XCTAssertEqual(store.searchResults.map(\.nodeID), ["node-1"])
        XCTAssertFalse(store.searchLoading); XCTAssertNil(store.searchError); XCTAssertEqual(transport.requests.count, 2)
    }

    func testReturningToActiveSearchRerunsSameVisibleQueryAfterCancellation() async {
        let transport = AppContractTransport { request, _ in
            XCTAssertEqual(request.query["q"], "release"); return .json(nativeSearchAnswer())
        }; defer { transport.close() }
        let store = readyStore(transport)
        store.search("release"); await waitUntil { store.searchCompleted }
        store.cancelSearch()
        XCTAssertFalse(store.searchCompleted); XCTAssertTrue(store.searchResults.isEmpty)
        // ConversationsScreen keeps its search field and reissues it only when
        // appearing or transitioning back to scenePhase.active.
        store.search("release"); await waitUntil { store.searchCompleted }
        XCTAssertEqual(transport.requests.count, 2); XCTAssertEqual(store.visibleSearchResults.count, 1)
        XCTAssertFalse(store.searchLoading); XCTAssertNil(store.searchError)
    }

    func testClearingQueryDuringRequestCannotRestoreRowsOrShowCancellationError() async {
        let transport = AppContractTransport { _, _ in .delayedJSON(nativeSearchAnswer(), status: 200, delay: 0.3) }
        defer { transport.close() }
        let store = readyStore(transport)
        store.search("release"); await waitUntil { transport.requests.count == 1 }
        store.search("")
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(store.searchQuery, ""); XCTAssertTrue(store.searchResults.isEmpty)
        XCTAssertFalse(store.searchLoading); XCTAssertFalse(store.searchCompleted); XCTAssertNil(store.searchError)
    }

    func testSearchFailureUsesOwnErrorAndRetryDoesNotKeepStaleResults() async {
        let transport = AppContractTransport { _, requests in
            requests.count == 1 ? .failure(.networkConnectionLost) : .json(nativeSearchAnswer([]))
        }; defer { transport.close() }
        let store = readyStore(transport); store.error = "Existing workspace error"
        store.search("release"); await waitUntil { store.searchCompleted }
        XCTAssertNotNil(store.searchError); XCTAssertTrue(store.searchResults.isEmpty)
        XCTAssertEqual(store.error, "Existing workspace error")
        store.search("release"); XCTAssertNil(store.searchError); XCTAssertTrue(store.searchLoading)
        await waitUntil { store.searchCompleted }
        XCTAssertNil(store.searchError); XCTAssertTrue(store.searchResults.isEmpty)
    }

    func testMalformedServerReplySurfacesErrorInsteadOfNoResults() async {
        let transport = AppContractTransport { _, _ in .json(["error": "unknown response"]) }; defer { transport.close() }
        let store = readyStore(transport); store.search("release")
        await waitUntil { store.searchCompleted }
        XCTAssertEqual(store.searchError, NativeSearchContract.malformedMessage)
        XCTAssertFalse(store.searchLoading); XCTAssertTrue(store.searchResults.isEmpty)
    }

    func testStoreDeallocationCancelsPendingDebounce() async {
        let transport = AppContractTransport { _, _ in XCTFail("Released search must not send"); return .json(nativeSearchAnswer()) }
        defer { transport.close() }
        var store: MichiStore? = readyStore(transport)
        weak var released = store
        store?.search("release"); store = nil
        XCTAssertNil(released)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testConversationTapRechecksAuthoritativeGraphAndRefusesDeletedNode() async throws {
        let transport = AppContractTransport { request, _ in
            switch request.path {
            case "/api/search": return .json(nativeSearchAnswer())
            case "/api/workspaces/all": return .json(["workspaces": .array([appContractGraph(nodeDeleted: true).raw])])
            case "/api/agent/status": return .json([:])
            default: XCTFail("Unexpected request"); return .failure(.unsupportedURL)
            }
        }; defer { transport.close() }
        let store = readyStore(transport); store.search("release"); await waitUntil { store.searchCompleted }
        let result = try XCTUnwrap(store.visibleSearchResults.first)
        await store.openSearchResult(result)
        XCTAssertNil(store.selectedNodeID); XCTAssertNotNil(store.searchError)
        XCTAssertTrue(store.visibleSearchResults.isEmpty); XCTAssertFalse(store.openingSearchResult)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testArchivedConversationTapSelectsVerifiedWorkspaceWithoutMutation() async throws {
        let archived = appContractGraph(workspaceArchived: true)
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/search" { return .json(nativeSearchAnswer()) }
            if request.path == "/api/workspaces/all" { return .json(["workspaces": .array([archived.raw])]) }
            if request.path == "/api/agent/status" { return .json([:]) }
            XCTFail("Unexpected request"); return .failure(.unsupportedURL)
        }; defer { transport.close() }
        let store = readyStore(transport); store.search("release"); await waitUntil { store.searchCompleted }
        await store.openSearchResult(try XCTUnwrap(store.visibleSearchResults.first))
        XCTAssertEqual(store.selectedNodeID, "node-1"); XCTAssertEqual(store.selectedWorkspaceID, "workspace-1")
        XCTAssertTrue(store.selectedGraph?.isReadOnly == true); XCTAssertNil(store.searchError)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testFailedFreshSnapshotCannotOpenFromKeptCachedGraph() async throws {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/search" { return .json(nativeSearchAnswer()) }
            return .failure(.networkConnectionLost)
        }; defer { transport.close() }
        let store = readyStore(transport); store.search("release"); await waitUntil { store.searchCompleted }
        await store.openSearchResult(try XCTUnwrap(store.visibleSearchResults.first))
        XCTAssertEqual(store.graphs.first?.id, "workspace-1", "Failed refresh keeps the last good snapshot")
        XCTAssertNil(store.selectedNodeID); XCTAssertNotNil(store.searchError)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testMarkRangesStayPairedAndLeaveUnmatchedTags() {
        let marked = NativeSearchHighlight.marks(in: "<script>x</script> **bold** &lt;x&gt; <mark>中文</mark> / <mark>two</mark>")
        XCTAssertEqual(marked.plain, "<script>x</script> **bold** &lt;x&gt; 中文 / two")
        let runs = NativeSearchHighlight.runs(in: marked.plain, ranges: marked.ranges)
        XCTAssertEqual(runs.filter(\.isMatch).map(\.text), ["中文", "two"])
        XCTAssertEqual(NativeSearchHighlight.marks(in: "before <mark>unclosed").plain, "before <mark>unclosed")
        XCTAssertEqual(NativeSearchHighlight.marks(in: "before <mark>unclosed").ranges, [])
        XCTAssertEqual(NativeSearchHighlight.marks(in: "literal </mark> after").plain, "literal </mark> after")
    }

    func testQueryHighlightsAreCaseAndDiacriticInsensitiveWithoutSplittingClusters() {
        let locale = Locale(identifier: "en_US_POSIX")
        let text = "Café cafe\u{0301} CAFÉ and 中文"
        let runs = NativeSearchHighlight.displayRuns(plain: text, query: "CAFE", locale: locale)
        XCTAssertEqual(runs.filter(\.isMatch).map(\.text), ["Café", "cafe\u{0301}", "CAFÉ"])
        XCTAssertTrue(runs.contains { $0.text.contains("中文") && !$0.isMatch })
        let cluster = NativeSearchHighlight.queryRanges(in: "e\u{0301}", query: "é", locale: locale)
        XCTAssertEqual(cluster.count, 1)
        XCTAssertEqual(NativeSearchHighlight.runs(in: "e\u{0301}", ranges: cluster).map(\.text), ["e\u{0301}"])
        XCTAssertEqual(NativeSearchHighlight.displayRuns(plain: text, query: "   ", locale: locale), [NativeSearchHighlight.Run(text: text, isMatch: false)])
    }

    func testTitleAndSnippetHighlightsUseQueryAndServerMarksTogether() throws {
        let result = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer()).first)
        XCTAssertEqual(result.snippets[0].text, "First release match")
        XCTAssertEqual(result.snippets[0].markRanges.count, 1)
        let title = NativeSearchHighlight.displayRuns(plain: result.title, query: "release")
        XCTAssertEqual(title.filter(\.isMatch).map(\.text), ["Release"])
        let snippet = NativeSearchHighlight.displayRuns(plain: result.snippets[0].text, query: "RELEASE", marks: result.snippets[0].markRanges)
        XCTAssertEqual(snippet.filter(\.isMatch).map(\.text), ["release"])
    }

    func testHighlightRunsWidenSplitClustersAndKeepEveryByte() {
        typealias Range16 = NativeSearchHighlight.UTF16Range
        let family = "\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}"
        let samples: [(text: String, ranges: [Range16], match: String)] = [
            ("cafe\u{0301} au lait", [Range16(location: 3, length: 1)], "e\u{0301}"),
            ("x\u{0301}y", [Range16(location: 1, length: 1)], "x\u{0301}"),
            ("hi \(family) there", [Range16(location: 4, length: 2)], family),
            ("\u{1F1EF}\u{1F1F5}\u{1F1FA}\u{1F1F8}", [Range16(location: 2, length: 2)], "\u{1F1EF}\u{1F1F5}"),
            ("abc", [Range16(location: -2, length: 3)], "a"),
            ("abc", [Range16(location: 2, length: 10)], "c"),
        ]
        for sample in samples {
            let runs = NativeSearchHighlight.runs(in: sample.text, ranges: sample.ranges)
            XCTAssertTrue(runs.map(\.text).joined().utf8.elementsEqual(sample.text.utf8), "Runs must reproduce \(sample.text) exactly")
            XCTAssertEqual(runs.filter(\.isMatch).count, 1)
            XCTAssertTrue(runs.first(where: \.isMatch).map { $0.text.utf8.elementsEqual(sample.match.utf8) } ?? false, "\(sample.text)")
            var offset = 0
            for run in runs {
                offset += run.text.utf16.count
                let index = sample.text.utf16.index(sample.text.utf16.startIndex, offsetBy: offset)
                XCTAssertNotNil(String.Index(index, within: sample.text), "Run boundary splits a grapheme in \(sample.text)")
            }
        }
        XCTAssertEqual(NativeSearchHighlight.runs(in: "abc", ranges: []), [NativeSearchHighlight.Run(text: "abc", isMatch: false)])
        XCTAssertEqual(NativeSearchHighlight.runs(in: "", ranges: [Range16(location: 0, length: 1)]), [])
    }

    func testServerMarkThatSplitsAClusterHighlightsTheWholeCluster() {
        let marked = NativeSearchHighlight.marks(in: "e<mark>\u{0301}</mark>x")
        XCTAssertTrue(marked.plain.utf8.elementsEqual("e\u{0301}x".utf8))
        let runs = NativeSearchHighlight.runs(in: marked.plain, ranges: marked.ranges)
        XCTAssertEqual(runs.count, 2)
        XCTAssertTrue(runs[0].isMatch && runs[0].text.utf8.elementsEqual("e\u{0301}".utf8))
        XCTAssertEqual(runs[1], NativeSearchHighlight.Run(text: "x", isMatch: false))

        // `</mark>` directly before a combining accent: its `>` and the accent form
        // one Character, so the tag must still be found by scalar.
        let trailing = NativeSearchHighlight.marks(in: "caf<mark>e</mark>\u{0301} ok")
        XCTAssertTrue(trailing.plain.utf8.elementsEqual("cafe\u{0301} ok".utf8))
        XCTAssertEqual(trailing.ranges, [NativeSearchHighlight.UTF16Range(location: 3, length: 1)])
        let widened = NativeSearchHighlight.runs(in: trailing.plain, ranges: trailing.ranges)
        XCTAssertTrue(widened.first(where: \.isMatch).map { $0.text.utf8.elementsEqual("e\u{0301}".utf8) } ?? false)
        XCTAssertFalse(NativeSearchContract.plainSnippet("caf<mark>e</mark>\u{0301}").contains("mark"))
    }

    func testSnippetAndTitleRunsKeepHTMLLiteralAndNeverHighlightThePlaceholderTitle() throws {
        let raw = nativeSearchFixture().merging(["snippets": [["messageId": "message-1", "role": "assistant", "snippet": "<b>bold</b> <mark>&lt;tag&gt;</mark> <img src=x>"]]])
        let result = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer([raw])).first)
        let snippet = NativeSearchHighlight.snippetRuns(result.snippets[0], query: "img")
        XCTAssertEqual(snippet.map(\.text).joined(), "<b>bold</b> &lt;tag&gt; <img src=x>")
        XCTAssertEqual(snippet.filter(\.isMatch).map(\.text), ["&lt;tag&gt;", "img"])
        XCTAssertEqual(NativeSearchHighlight.titleRuns(result, query: "PLAN").filter(\.isMatch).map(\.text), ["plan"])

        let untitled = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer([nativeSearchFixture().merging(["nodeTitle": .null])])).first)
        XCTAssertEqual(untitled.title, "New conversation")
        XCTAssertEqual(NativeSearchHighlight.titleRuns(untitled, query: "new conversation"), [NativeSearchHighlight.Run(text: "New conversation", isMatch: false)])
    }

    func testNavigationIdentityStaysByteExactAndIgnoresHighlightFolding() throws {
        let composed = "caf\u{00E9}"
        let decomposed = "cafe\u{0301}"
        let result = try XCTUnwrap(NativeSearchContract.results(nativeSearchAnswer([nativeSearchFixture(composed)])).first)
        let target = NativeSearchNavigationTarget.of(result, snippet: result.snippets[0])
        XCTAssertTrue(NativeSearchContract.sameOpaque(target.nodeID, composed))
        XCTAssertEqual(target.messageID, "message-1")
        let folded = NativeSearchNavigationTarget(workspaceID: result.workspaceID, nodeID: decomposed, messageID: "message-1")
        XCTAssertNotEqual(target, folded)
        XCTAssertTrue(target.nodeID == folded.nodeID)
        XCTAssertFalse(NativeSearchContract.sameOpaque(target.nodeID, folded.nodeID))
        XCTAssertNotEqual(NativeSearchNavigationTarget.of(result, snippet: result.snippets[0]), NativeSearchNavigationTarget.of(result))
    }

    func testUnhydratedUnknownAndSupersededSearchRowsCannotOpen() async throws {
        let transport = AppContractTransport { _, _ in .json(nativeSearchAnswer()) }; defer { transport.close() }
        let store = readyStore(transport); store.search("release"); await waitUntil { store.searchCompleted }
        let result = try XCTUnwrap(store.visibleSearchResults.first)
        store.hydrated = false
        XCTAssertTrue(store.visibleSearchResults.isEmpty); XCTAssertFalse(store.canOpenSearchResult(result))
        await store.openSearchResult(result); XCTAssertEqual(transport.requests.count, 1)
        store.hydrated = true; store.cancelSearch()
        XCTAssertFalse(store.canOpenSearchResult(result)); await store.openSearchResult(result)
        XCTAssertEqual(transport.requests.count, 1); XCTAssertNil(store.selectedNodeID)
    }
}
