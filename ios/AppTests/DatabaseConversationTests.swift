import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func databaseConversationFixture(_ id: String = "node-1", workspace: String = "workspace-1", state: String = "waiting", title: String = "Review release plan") -> JSONValue {
    ["nodeId": .string(id), "workspaceId": .string(workspace), "title": .string(title),
     "state": .string(state), "summary": "Choose a release date", "at": 1000, "messageId": .null,
     "futureField": ["preserved": true]]
}

private func databaseConversationScope(_ ids: [String], workspace: String = "workspace-1") -> [String: Set<String>] {
    Dictionary(ids.map { ($0, Set([workspace])) }, uniquingKeysWith: { previous, next in previous.union(next) })
}

@MainActor final class DatabaseConversationTests: XCTestCase {
    private let columns: [JSONValue] = [["id": "threads", "type": "threads"], ["id": "task", "type": "text"]]
    private func row(_ id: String, links: [String]) -> JSONValue {
        ["id": .string(id), "values": ["threads": .array(links.map(JSONValue.string))], "position": 0]
    }

    func testRefreshReadsSortedUniqueIDsAndPreservesFutureFields() async {
        let transport = AppContractTransport { request, _ in
            XCTAssertEqual(request.method, "POST")
            XCTAssertEqual(request.path, "/api/spaces-home/thread-states")
            XCTAssertEqual(request.body, ["nodeIds": ["a", "b"]])
            return .json(["items": [databaseConversationFixture("a"), databaseConversationFixture("b", state: "running")]])
        }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        await model.refresh(workspaceID: "workspace-1", rows: [row("row-1", links: ["b", "a", "a"])], columns: columns)
        XCTAssertTrue(model.loaded); XCTAssertFalse(model.failed); XCTAssertFalse(model.loading)
        XCTAssertEqual(model.lookup("a"), FeatureConversationState(waiting: true, title: "Review release plan"))
        XCTAssertEqual(model.lookup("b")?.waiting, false)
        XCTAssertEqual(model.card(nodeID: "a")?.raw["futureField"], ["preserved": true])
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testBatchesAtBackendLimitWithoutDroppingAnyIDs() async {
        let ids = (0..<501).map { String(format: "node-%03d", $0) }
        let transport = AppContractTransport { request, _ in
            let batch = request.body["nodeIds"].arrayValue.map(\.stringValue)
            return .json(["items": .array(batch.map { databaseConversationFixture($0) })])
        }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        await model.refresh(expectedWorkspaces: databaseConversationScope(ids))
        XCTAssertEqual(transport.requests.map { $0.body["nodeIds"].arrayValue.count }, [500, 1])
        XCTAssertEqual(model.byNode.count, 501); XCTAssertTrue(model.loaded)
        XCTAssertEqual(Set(transport.requests.flatMap { $0.body["nodeIds"].arrayValue.map(\.stringValue) }), Set(ids))
    }

    func testEmptySetClearsLookupWithoutRequest() async {
        let transport = AppContractTransport { _, _ in .json(["items": [databaseConversationFixture()]]) }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        await model.refresh(expectedWorkspaces: databaseConversationScope(["node-1"]))
        await model.refresh(expectedWorkspaces: [:])
        XCTAssertTrue(model.loaded); XCTAssertTrue(model.byNode.isEmpty); XCTAssertEqual(transport.requests.count, 1)
    }

    func testSuccessfulOmissionMeansMissingButFailedReadKeepsPreviousAnswer() async {
        let transport = AppContractTransport { _, requests in
            if requests.count == 1 { return .json(["items": [databaseConversationFixture()]]) }
            if requests.count == 2 { return .failure(.networkConnectionLost) }
            return .json(["items": []])
        }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        let scope = databaseConversationScope(["node-1"])
        await model.refresh(expectedWorkspaces: scope)
        await model.refresh(expectedWorkspaces: scope)
        XCTAssertTrue(model.loaded); XCTAssertTrue(model.failed); XCTAssertNotNil(model.lookup("node-1"))
        await model.refresh(expectedWorkspaces: scope)
        XCTAssertTrue(model.loaded); XCTAssertFalse(model.failed); XCTAssertNil(model.lookup("node-1"))
    }

    func testSecondBatchFailureDoesNotPartiallyReplacePreviousAnswer() async {
        let ids = (0..<501).map { String(format: "node-%03d", $0) }
        let transport = AppContractTransport { request, requests in
            if requests.count == 3 { return .json(["error": "offline"], status: 503) }
            let title = requests.count == 1 ? "Kept title" : "Uncommitted title"
            return .json(["items": .array(request.body["nodeIds"].arrayValue.map { databaseConversationFixture($0.stringValue, title: title) })])
        }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        await model.refresh(expectedWorkspaces: databaseConversationScope([ids[0]]))
        await model.refresh(expectedWorkspaces: databaseConversationScope(ids))
        XCTAssertFalse(model.loaded); XCTAssertTrue(model.failed)
        XCTAssertEqual(model.lookup(ids[0])?.title, "Kept title"); XCTAssertEqual(model.byNode.count, 1)
        XCTAssertEqual(transport.requests.count, 3)
    }

    func testWorkspaceScopeRejectsMovedConversation() async {
        let transport = AppContractTransport { _, _ in .json(["items": [databaseConversationFixture(workspace: "elsewhere")]]) }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        await model.refresh(workspaceID: "workspace-1", rows: [row("row-1", links: ["node-1"])], columns: columns)
        XCTAssertTrue(model.loaded); XCTAssertNil(model.lookup("node-1")); XCTAssertNil(model.card(nodeID: "node-1"))
    }

    func testAllTasksUsesSourceOwnershipAndAllowsSharedLinksOnlyInMatchingWorkspaces() async {
        let payload: JSONValue = [
            "sources": [["databaseId": "db-a", "workspaceId": "workspace-1"], ["databaseId": "db-b", "workspaceId": "workspace-2"]],
            "rows": [
                ["databaseId": "db-a", "row": ["values": ["threads": ["shared", "moved"], "workspace": "elsewhere"]]],
                ["databaseId": "db-b", "row": ["values": ["threads": ["shared", "b"]]]],
                ["databaseId": "deleted-db", "row": ["values": ["threads": ["orphan"]]]],
            ],
        ]
        let transport = AppContractTransport { request, _ in
            XCTAssertEqual(request.body, ["nodeIds": ["b", "moved", "shared"]])
            return .json(["items": [databaseConversationFixture("b", workspace: "workspace-2"),
                databaseConversationFixture("moved", workspace: "elsewhere"), databaseConversationFixture("shared", workspace: "workspace-2")]])
        }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api); await model.refresh(allTasks: payload)
        XCTAssertEqual(Set(model.byNode.keys), Set(["b", "shared"]))
        XCTAssertNil(model.card(nodeID: "shared", workspaceID: "workspace-1"))
        XCTAssertEqual(model.card(nodeID: "shared", workspaceID: "workspace-2")?.workspaceID, "workspace-2")
        XCTAssertNil(model.lookup("moved")); XCTAssertNil(model.lookup("orphan"))
    }

    func testUnrequestedDuplicateAndMalformedCardsAreRejectedAtomically() throws {
        let requested: Set<String> = ["node-1", "node-2"]
        XCTAssertThrowsError(try FeatureDatabaseConversationContract.cards(["items": [databaseConversationFixture("foreign")]], requested: requested))
        XCTAssertThrowsError(try FeatureDatabaseConversationContract.cards(["items": [databaseConversationFixture(), databaseConversationFixture()]], requested: requested))
        XCTAssertThrowsError(try FeatureDatabaseConversationContract.cards(["items": [databaseConversationFixture().merging(["state": "invented"]) ]], requested: requested))
        XCTAssertThrowsError(try FeatureDatabaseConversationContract.cards(["items": [databaseConversationFixture().merging(["at": -1])]], requested: requested))
        XCTAssertThrowsError(try FeatureDatabaseConversationContract.cards(["items": .null], requested: requested))
    }

    func testInvalidIDsDoNotSendNetworkRequest() async {
        let transport = AppContractTransport { _, _ in .json(["items": []]) }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        await model.refresh(expectedWorkspaces: [String(repeating: "x", count: 201): ["workspace-1"]])
        XCTAssertFalse(model.loaded); XCTAssertTrue(model.failed); XCTAssertTrue(transport.requests.isEmpty)
        await model.refresh(expectedWorkspaces: ["node-1": []])
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testNewerIDSetSupersedesOlderResponse() async {
        let transport = AppContractTransport { request, requests in
            let items = request.body["nodeIds"].arrayValue.map { databaseConversationFixture($0.stringValue) }
            return requests.count == 1 ? .delayedJSON(["items": .array(items)], status: 200, delay: 0.15) : .json(["items": .array(items)])
        }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        let old = Task { await model.refresh(expectedWorkspaces: databaseConversationScope(["old"])) }
        let deadline = Date().addingTimeInterval(2)
        while transport.requests.isEmpty && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        await model.refresh(expectedWorkspaces: databaseConversationScope(["new"]))
        let oldCommitted = await old.value
        XCTAssertFalse(oldCommitted); XCTAssertTrue(model.loaded); XCTAssertFalse(model.loading)
        XCTAssertEqual(Set(model.byNode.keys), Set(["new"]))
    }

    func testWaitingFilterUsesLiveStateAndDoesNotTreatStalledAsWaiting() async {
        let transport = AppContractTransport { _, _ in .json(["items": [databaseConversationFixture("a"), databaseConversationFixture("b", state: "stalled")]]) }; defer { transport.close() }
        let model = FeatureDatabaseConversationModel(api: transport.api)
        let rows = [row("wait", links: ["a"]), row("stalled", links: ["b"]), row("gone", links: ["gone"])]
        await model.refresh(workspaceID: "workspace-1", rows: rows, columns: columns)
        let config: JSONValue = ["filters": [["column": "threads", "op": "waiting"]], "match": "all", "sorts": []]
        XCTAssertEqual(featureApplyView(rows: rows, columns: columns, config: config, conversation: model.lookup).map(\.id), ["wait"])
        XCTAssertEqual(featureApplyView(rows: rows, columns: columns, config: config), [])
        XCTAssertFalse(featureRowMatches(["column": "task", "op": "waiting"], row: rows[0], columns: columns, conversation: model.lookup))
    }

    func testContainsMatchesTrimmedCaseInsensitiveTitlesAndExactIDs() {
        let row = row("row-1", links: ["node-1"])
        let lookup: FeatureConversationLookup = { $0 == "node-1" ? FeatureConversationState(waiting: false, title: "Review release plan") : nil }
        XCTAssertTrue(featureRowMatches(["column": "threads", "op": "contains", "value": "  RELEASE  "], row: row, columns: columns, conversation: lookup))
        XCTAssertFalse(featureRowMatches(["column": "threads", "op": "not-contains", "value": "release"], row: row, columns: columns, conversation: lookup))
        XCTAssertTrue(featureRowMatches(["column": "threads", "op": "contains", "value": " NODE-1 "], row: row, columns: columns))
        XCTAssertFalse(featureRowMatches(["column": "threads", "op": "contains", "value": "node"], row: row, columns: columns))
        XCTAssertFalse(featureRowMatches(["column": "threads", "op": "contains", "value": "release"], row: row, columns: columns))
    }

    func testAnyAndAllFiltersKeepTheirMeaningWithLiveLookup() {
        let rows = [row("waiting", links: ["a"]), row("named", links: ["b"]), row("neither", links: ["c"])]
        let lookup: FeatureConversationLookup = { id in FeatureConversationState(waiting: id == "a", title: id == "b" ? "Release plan" : "Other") }
        var config: JSONValue = ["filters": [["column": "threads", "op": "waiting"], ["column": "threads", "op": "contains", "value": "Release"]], "match": "any", "sorts": []]
        XCTAssertEqual(Set(featureApplyView(rows: rows, columns: columns, config: config, conversation: lookup).map(\.id)), Set(["waiting", "named"]))
        config["match"] = "all"
        XCTAssertTrue(featureApplyView(rows: rows, columns: columns, config: config, conversation: lookup).isEmpty)
    }

    func testDateInputRejectsImpossibleGregorianDates() throws {
        for day in ["2026-02-29", "2026-04-31", "2026-02-31", "1900-02-29"] {
            XCTAssertFalse(featureIsDayString(day))
            XCTAssertThrowsError(try featureParseDateCell(start: day, end: nil))
        }
        XCTAssertTrue(featureIsDayString("2000-02-29")); XCTAssertTrue(featureIsDayString("2028-02-29"))
        XCTAssertThrowsError(try featureParseDateCell(start: "2026-04-30", end: "2026-04-31"))
        XCTAssertEqual(try featureParseDateCell(start: "2026-05-01", end: "2026-04-30"), ["start": "2026-04-30", "end": "2026-05-01"])
    }
}
