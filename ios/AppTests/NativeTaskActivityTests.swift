import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class NativeTaskActivityTests: XCTestCase {
    func testOriginTextMatchesSharedTaskOriginSentences() {
        XCTAssertEqual(nativeTaskOriginText(NativeTaskOrigin(by: .you, conversations: 2, at: 1)), "Created by you")
        XCTAssertEqual(
            nativeTaskOriginText(NativeTaskOrigin(by: .metaAgent, conversations: 3, at: 1)),
            "Created by Meta agent from 3 conversations"
        )
        XCTAssertEqual(
            nativeTaskOriginText(NativeTaskOrigin(by: .agent, conversations: 1, at: 1)),
            "Created by an agent from 1 conversation"
        )
        XCTAssertEqual(nativeTaskOriginText(NativeTaskOrigin(by: .agent, conversations: 0, at: 1)), "Created by an agent")
        XCTAssertNotEqual(nativeTaskOriginRowKey(databaseId: "db-a", rowId: "r1"), nativeTaskOriginRowKey(databaseId: "db-b", rowId: "r1"))
    }

    func testRowIdentityIsAByteExactPairNotADelimitedOrNormalizedJoin() {
        let shared = nativeTaskOriginRowKey(databaseId: "db-a", rowId: "r1")
        XCTAssertEqual(shared, NativeTaskRowIdentity(databaseId: "db-a", rowId: "r1"))
        XCTAssertNotEqual(shared, NativeTaskRowIdentity(databaseId: "db-b", rowId: "r1"))
        XCTAssertNotEqual(
            nativeTaskOriginRowKey(databaseId: "a\u{1e}b", rowId: "c"),
            nativeTaskOriginRowKey(databaseId: "a", rowId: "b\u{1e}c")
        )
        let composed = "é"
        let decomposed = "e\u{0301}"
        XCTAssertEqual(composed, decomposed, "Swift String equality is Unicode-normalized")
        XCTAssertFalse(composed.utf8.elementsEqual(decomposed.utf8))
        XCTAssertNotEqual(
            nativeTaskOriginRowKey(databaseId: composed, rowId: "r"),
            nativeTaskOriginRowKey(databaseId: decomposed, rowId: "r")
        )
        XCTAssertNotEqual(
            nativeTaskOriginRowKey(databaseId: "db", rowId: composed),
            nativeTaskOriginRowKey(databaseId: "db", rowId: decomposed)
        )
        let nfcRow: JSONValue = ["id": .string(composed), "databaseId": "db"]
        let nfdRow: JSONValue = ["id": .string(decomposed), "databaseId": "db"]
        XCTAssertNotEqual(nfcRow.nativeTaskRowIdentity, nfdRow.nativeTaskRowIdentity)
        XCTAssertEqual(Set([nfcRow.nativeTaskRowIdentity, nfdRow.nativeTaskRowIdentity]).count, 2)
    }

    func testAllTasksSameRowIdInTwoDatabasesKeepsOriginAndUpdateOnTheSourceDatabase() async throws {
        let shared = "shared-row"
        let alphaRow: JSONValue = ["id": .string(shared), "rev": 2, "values": ["task": "Alpha", "status": "todo"], "body": ""]
        let betaRow: JSONValue = ["id": .string(shared), "rev": 3, "values": ["task": "Beta", "status": "doing"], "body": ""]
        var payload: JSONValue = [
            "sources": [
                ["workspaceId": "ws-a", "workspaceName": "Alpha", "databaseId": "db-a", "revision": 5, "statuses": []],
                ["workspaceId": "ws-b", "workspaceName": "Beta", "databaseId": "db-b", "revision": 7, "statuses": []],
            ],
            "rows": [
                ["databaseId": "db-a", "row": alphaRow],
                ["databaseId": "db-b", "row": betaRow],
            ],
            "views": [], "viewsRevision": 1,
        ]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/spaces-home/all-tasks" { return .json(payload) }
            if request.path == "/api/databases/db-a/rows/\(shared)/origin" {
                return .json(["origin": ["by": "you", "conversations": 0, "at": 3]])
            }
            if request.path == "/api/databases/db-b/rows/\(shared)/origin" {
                return .json(["origin": ["by": "agent", "conversations": 1, "at": 4]])
            }
            if request.path == "/api/databases/db-b/edits" {
                XCTAssertEqual(request.body["revision"], 7)
                XCTAssertEqual(request.body["ops"].arrayValue[0]["id"], .string(shared))
                var updated = betaRow
                updated["rev"] = 4
                updated["values"]["task"] = "Beta saved"
                payload["sources"] = .array(payload["sources"].arrayValue.map { source in
                    source["databaseId"].stringValue.utf8.elementsEqual("db-b".utf8)
                        ? source.merging(["revision": 8]) : source
                })
                payload["rows"] = .array(payload["rows"].arrayValue.map { entry in
                    entry["databaseId"].stringValue.utf8.elementsEqual("db-b".utf8)
                        ? entry.merging(["row": updated]) : entry
                })
                return .json(["database": ["id": "db-b", "revision": 8, "rows": [updated], "columns": [], "views": []], "changes": ["rejected": []]])
            }
            return .json(["error": .string("unexpected \(request.path)")], status: 500)
        }
        defer { transport.close() }
        let model = FeatureAllTasksModel(api: transport.api)
        await model.refresh()
        XCTAssertEqual(model.displayRows.map(\.id), [shared, shared])
        XCTAssertEqual(Set(model.displayRows.map(\.id)).count, 1)
        XCTAssertEqual(Set(model.displayRows.map(\.nativeTaskRowIdentity)).count, 2)
        XCTAssertEqual(model.displayRows.first { $0.id == shared }?["values"]["task"], "Alpha")
        let betaIdentity = NativeTaskRowIdentity(databaseId: "db-b", rowId: shared)
        let alphaIdentity = NativeTaskRowIdentity(databaseId: "db-a", rowId: shared)
        XCTAssertEqual(model.displayRow(matching: betaIdentity)?["values"]["task"], "Beta")
        XCTAssertEqual(model.displayRow(matching: alphaIdentity)?["values"]["task"], "Alpha")
        let operation: JSONValue = ["op": "row.update", "id": .string(shared), "expectRev": 3, "values": ["task": "Beta saved"]]
        let saved = await model.updateSourceRow(databaseId: "db-b", operation: operation)
        XCTAssertTrue(saved)
        XCTAssertEqual(model.displayRow(matching: betaIdentity)?["values"]["task"], "Beta saved")
        XCTAssertEqual(model.displayRow(matching: betaIdentity)?["databaseId"], "db-b")
        XCTAssertEqual(model.displayRow(matching: alphaIdentity)?["values"]["task"], "Alpha")
        XCTAssertEqual(model.displayRows.first { $0.id == shared }?["values"]["task"], "Alpha")

        let loader = NativeTaskOriginLoader(api: transport.api, databaseId: "db-a")
        await loader.load(databaseId: "db-a", rowId: shared)
        XCTAssertEqual(loader.currentRowKey, alphaIdentity)
        XCTAssertEqual(loader.readyOrigin.map(nativeTaskOriginText), "Created by you")
        await loader.load(databaseId: "db-b", rowId: shared)
        XCTAssertEqual(loader.currentRowKey, betaIdentity)
        XCTAssertEqual(loader.readyOrigin.map(nativeTaskOriginText), "Created by an agent from 1 conversation")
        XCTAssertEqual(transport.requests.map(\.path).filter { $0.contains("/origin") }, [
            "/api/databases/db-a/rows/\(shared)/origin",
            "/api/databases/db-b/rows/\(shared)/origin",
        ])
        XCTAssertFalse(transport.requests.contains { $0.path.contains("/databases/db-a/edits") })
    }

    func testMalformedOriginAndActivityAreUnsupported() {
        XCTAssertTrue(failed(nativeTaskParseOriginEnvelope(["by": "you"])))
        XCTAssertTrue(failed(nativeTaskParseOrigin(["by": "robot", "conversations": 2, "at": 1])))
        XCTAssertTrue(failed(nativeTaskParseOrigin(["by": "you", "conversations": -1, "at": 1])))
        if case .ok(let empty) = nativeTaskParseOriginEnvelope(["origin": .null]) {
            XCTAssertNil(empty)
        } else { XCTFail("null origin") }
        if case .ok(let origin) = nativeTaskParseOriginEnvelope(["origin": ["by": "you", "conversations": 0, "at": 9]]) {
            XCTAssertEqual(origin?.by, .you)
        } else { XCTFail("you origin") }
        XCTAssertTrue(failed(nativeTaskParseActivity("nope")))
        XCTAssertTrue(failed(nativeTaskParseActivity(["suggestions": "nope"])))
        let parsed = ok(nativeTaskParseActivity([
            "suggestions": [suggestion(id: "ok", rowId: "docs"), ["id": "bare"]],
            "marks": [["rowId": "notes", "kind": "new", "at": 2], ["kind": "new"]],
            "latestUpkeep": ["batchId": "b1", "added": 1, "updated": 0, "removed": 0, "suggested": 1],
        ]))
        XCTAssertEqual(parsed?.suggestions.map { $0.id }, ["ok"])
        XCTAssertEqual(parsed?.marks.map { $0.rowId }, ["notes"])
        XCTAssertEqual(parsed?.unsupported.count, 2)
        XCTAssertEqual(nativeTaskUpkeepSummary(parsed!.latestUpkeep!), "Meta agent added 1 task and suggested 1 change")
    }

    func testSuggestionsAndMarksStayOnTheirOwnRow() {
        let snapshot = ok(nativeTaskParseActivity([
            "suggestions": [suggestion(id: "chg-docs", rowId: "docs"), suggestion(id: "chg-notes", rowId: "notes")],
            "marks": [
                ["rowId": "notes", "kind": "new", "at": 2],
                ["rowId": "ship", "kind": "updated", "at": 3],
            ],
        ]))
        XCTAssertEqual(nativeTaskSuggestionsOf(snapshot, rowId: "docs").map { $0.id }, ["chg-docs"])
        XCTAssertEqual(nativeTaskSuggestionsOf(snapshot, rowId: "notes").map { $0.id }, ["chg-notes"])
        XCTAssertTrue(nativeTaskSuggestionsOf(snapshot, rowId: "ship").isEmpty)
        XCTAssertEqual(nativeTaskMarkOf(snapshot, rowId: "notes"), NativeTaskMarkKind.new)
        XCTAssertEqual(nativeTaskMarkOf(snapshot, rowId: "ship"), NativeTaskMarkKind.updated)
        XCTAssertNil(nativeTaskMarkOf(snapshot, rowId: "docs"))
    }

    func testOriginLoaderClearsPreviousRowBeforeTheNextAnswer() async {
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/rows/row-a/origin") {
                return .delayedJSON(["origin": ["by": "you", "conversations": 0, "at": 11]], status: 200, delay: 0.2)
            }
            if request.path.contains("/rows/row-b/origin") {
                return .json(["origin": ["by": "meta-agent", "conversations": 2, "at": 22]])
            }
            return .json(["error": .string("unexpected \(request.path)")], status: 500)
        }
        defer { transport.close() }
        let loader = NativeTaskOriginLoader(api: transport.api, databaseId: "db-1")
        async let first: Void = loader.load(rowId: "row-a")
        try? await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(loader.currentRowKey, nativeTaskOriginRowKey(databaseId: "db-1", rowId: "row-a"))
        XCTAssertFalse(loader.presentation.isReady, "Must not keep a previous origin while the next row is loading")
        await loader.load(rowId: "row-b")
        XCTAssertEqual(loader.readyOrigin?.by, NativeTaskOriginBy.metaAgent)
        XCTAssertEqual(loader.readyOrigin?.conversations, 2)
        await first
        XCTAssertEqual(loader.readyOrigin?.by, NativeTaskOriginBy.metaAgent)
        XCTAssertEqual(loader.currentRowKey, nativeTaskOriginRowKey(databaseId: "db-1", rowId: "row-b"))
        XCTAssertFalse(transport.requests.contains { $0.path.contains("task-activity") })
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

    func testAllTasksOriginUsesTheSourceDatabaseAndIgnoresTheOtherWorkspaceRow() async {
        let transport = AppContractTransport { request, _ in
            if request.path.contains("/databases/db-a/rows/r1/origin") {
                return .json(["origin": ["by": "you", "conversations": 0, "at": 3]])
            }
            if request.path.contains("/databases/db-b/rows/r1/origin") {
                return .json(["origin": ["by": "agent", "conversations": 1, "at": 4]])
            }
            return .json(["error": .string("unexpected \(request.path)")], status: 500)
        }
        defer { transport.close() }
        let alpha = NativeTaskOriginLoader(api: transport.api, databaseId: "db-a")
        let beta = NativeTaskOriginLoader(api: transport.api, databaseId: "db-b")
        await alpha.load(rowId: "r1")
        await beta.load(rowId: "r1")
        XCTAssertEqual(alpha.readyOrigin.map(nativeTaskOriginText), "Created by you")
        XCTAssertEqual(beta.readyOrigin.map(nativeTaskOriginText), "Created by an agent from 1 conversation")
        XCTAssertEqual(transport.requests.map { $0.path }, [
            "/api/databases/db-a/rows/r1/origin",
            "/api/databases/db-b/rows/r1/origin",
        ])
    }

    func testAcceptHitsPageChangeRouteAndConflictRefreshReloadsActivity() async {
        let pending = suggestion(id: "chg-docs", rowId: "docs")
        let next = suggestion(id: "chg-next", rowId: "docs")
        var activity: JSONValue = ["suggestions": [pending], "marks": []]
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/task-activity") { return .json(activity) }
            if request.path.hasSuffix("/page-changes/chg-docs/accept") {
                XCTAssertEqual(request.body, [:])
                activity = ["suggestions": [], "marks": []]
                return .json(["change": pending.merging(["proposalState": "accepted", "applicationState": "applied"])])
            }
            if request.path.hasSuffix("/page-changes/chg-next/dismiss") {
                XCTAssertEqual(request.body, [:])
                activity = ["suggestions": [pending], "marks": [["rowId": "docs", "kind": "updated", "at": 9]]]
                return .json(["error": ["code": "undo_conflict", "message": "Only pending proposals can be dismissed"]], status: 409)
            }
            return .json(["error": .string("unexpected \(request.path)")], status: 500)
        }
        defer { transport.close() }
        let model = NativeTaskActivityModel(api: transport.api, databaseId: "db-tasks", workspaceId: "workspace-1")
        await model.load()
        XCTAssertEqual(model.suggestions(for: "docs").map { $0.id }, ["chg-docs"])
        let accepted = await model.decide(pending, action: FeaturePageChangeAction.accept)
        XCTAssertTrue(accepted)
        XCTAssertEqual(try nativeTaskDecideBody(action: FeaturePageChangeAction.accept), [:])
        XCTAssertEqual(try nativeTaskDecideBody(action: FeaturePageChangeAction.dismiss), [:])
        XCTAssertThrowsError(try nativeTaskDecideBody(action: FeaturePageChangeAction.revert))
        XCTAssertEqual(featurePageChangeActionPath("chg-docs", action: FeaturePageChangeAction.accept), "/page-changes/chg-docs/accept")
        activity = ["suggestions": [next], "marks": []]
        await model.load()
        let dismissed = await model.decide(next, action: FeaturePageChangeAction.dismiss)
        XCTAssertFalse(dismissed)
        XCTAssertNotNil(model.error)
        await model.load()
        XCTAssertEqual(nativeTaskMarkOf(model.snapshot, rowId: "docs"), .updated)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/accept") }.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/dismiss") }.count, 1)
        XCTAssertFalse(transport.requests.contains { $0.path.contains("/edits") })
        XCTAssertFalse(transport.requests.contains { $0.path.contains("all-tasks") })
    }

    func testTaskDecisionsRejectForeignStaleAndAlreadyResolvedSuggestions() async {
        let pending = suggestion(id: "owned", rowId: "docs")
        var foreign = pending; foreign["id"] = "foreign"; foreign["target"]["databaseId"] = "db-other"
        var accepted = pending; accepted["id"] = "resolved"; accepted["proposalState"] = "accepted"
        let transport = AppContractTransport { _, _ in .json(["error": "No request expected"], status: 500) }
        defer { transport.close() }
        let model = NativeTaskActivityModel(api: transport.api, databaseId: "db-tasks", workspaceId: "workspace-1")
        model.adopt(["suggestions": [pending, foreign, accepted], "marks": []])
        XCTAssertEqual(model.suggestions(for: "docs").map(\.id), ["owned"])
        XCTAssertNotNil(model.unsupported)
        let wrong = await model.decide(foreign, action: .accept)
        let stale = await model.decide(accepted, action: .dismiss)
        model.adopt(["suggestions": [], "marks": []])
        let removed = await model.decide(pending, action: .accept)
        XCTAssertFalse(wrong); XCTAssertFalse(stale); XCTAssertFalse(removed)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testFailedActivityRefreshRemovesOldActionableSuggestions() async {
        let transport = AppContractTransport { _, _ in .json(["error": "offline"], status: 503) }
        defer { transport.close() }
        let model = NativeTaskActivityModel(api: transport.api, databaseId: "db-tasks", workspaceId: "workspace-1")
        model.adopt(["suggestions": [suggestion(id: "owned", rowId: "docs")], "marks": []])
        await model.load()
        XCTAssertTrue(model.suggestions(for: "docs").isEmpty); XCTAssertNotNil(model.error)
        XCTAssertTrue(failed(nativeTaskParseActivity([:])))
    }

    func testEditedTaskSuggestionUsesSameScopedDecisionRouteAsTheCard() async throws {
        let pending = suggestion(id: "owned", rowId: "docs")
        let edited = try featurePageDraftPayload(change: pending, draft: ["values": ["status": "done"]])
        let transport = AppContractTransport { request, _ in
            guard request.path == "/api/page-changes/owned/accept", request.method == "POST" else { return .json(["error": "Unexpected route"], status: 500) }
            XCTAssertEqual(request.body, ["editedContent": edited])
            return .json(["change": pending.merging(["proposalState": "accepted", "applicationState": "applied"])])
        }
        defer { transport.close() }
        let model = NativeTaskActivityModel(api: transport.api, databaseId: "db-tasks", workspaceId: "workspace-1")
        model.adopt(["suggestions": [pending], "marks": []])
        let ok = await model.decide(pending, action: .accept, edited: edited)
        XCTAssertTrue(ok); XCTAssertTrue(model.suggestions(for: "docs").isEmpty)
        let repeated = await model.decide(pending, action: .accept, edited: edited)
        XCTAssertFalse(repeated); XCTAssertEqual(transport.requests.count, 1)
        XCTAssertThrowsError(try featurePageDraftPayload(change: pending, draft: ["values": ["status": "done"], "unexpected": true]))
        XCTAssertThrowsError(try featurePageDraftPayload(change: pending, draft: ["values": ["owner": "changed"]]))
        XCTAssertThrowsError(try featurePageDraftPayload(change: pending, draft: ["body": "Outside this proposal"]))
    }

    func testDatabaseRefreshAdoptsActivityAndConflictDecisionReloadsTheBoard() async {
        let pending = suggestion(id: "chg-docs", rowId: "docs")
        var database: JSONValue = [
            "id": "db-tasks", "workspaceId": "workspace-1", "title": "Tasks", "role": "tasks",
            "revision": 5, "columns": [], "views": [], "rows": [["id": "docs", "rev": 2, "values": ["task": "Review"]]],
        ]
        var activity: JSONValue = ["suggestions": [pending], "marks": [["rowId": "docs", "kind": "updated", "at": 8]]]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/databases/db-tasks" { return .json(["database": database]) }
            if request.path.hasSuffix("/task-activity") { return .json(activity) }
            if request.path.hasSuffix("/page-changes/chg-docs/dismiss") {
                activity = ["suggestions": [], "marks": []]
                database["revision"] = 6
                return .json(["error": ["code": "undo_conflict", "message": "Only pending proposals can be dismissed"]], status: 409)
            }
            return .json(["error": .string("unexpected \(request.path)")], status: 500)
        }
        defer { transport.close() }
        let model = FeatureDatabaseModel(api: transport.api, databaseId: "db-tasks", workspaceId: "workspace-1")
        await model.refresh()
        XCTAssertEqual(model.taskActivity.suggestions(for: "docs").map { $0.id }, ["chg-docs"])
        XCTAssertEqual(model.taskActivity.mark(for: "docs"), NativeTaskMarkKind.updated)
        model.taskActivity.seen("docs")
        XCTAssertNil(model.taskActivity.mark(for: "docs"))
        let result = await model.decideTaskSuggestion(pending, action: FeaturePageChangeAction.dismiss)
        XCTAssertFalse(result)
        XCTAssertEqual(model.revision, 6)
        XCTAssertTrue(model.taskActivity.suggestions(for: "docs").isEmpty)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/task-activity") }.count, 2)
        XCTAssertFalse(transport.requests.contains { $0.path.contains("/edits") })
    }

    private func ok<T>(_ parsed: NativeTaskParse<T>) -> T? {
        if case .ok(let value) = parsed { return value }
        return nil
    }

    private func failed<T>(_ parsed: NativeTaskParse<T>) -> Bool {
        if case .unsupported = parsed { return true }
        return false
    }

    private func suggestion(id: String, rowId: String) -> JSONValue {
        [
            "id": .string(id), "seq": 9, "batchId": "batch-upkeep",
            "target": ["kind": "row", "databaseId": "db-tasks", "rowId": .string(rowId), "columnIds": ["status"]],
            "op": "row",
            "before": .null, "after": .null,
            "forward": ["kind": "row", "op": "patch", "id": .string(rowId), "values": ["status": "waiting"]],
            "inverse": ["kind": "row", "op": "patch", "id": .string(rowId), "values": ["status": "doing"]],
            "baseRev": 2, "appliedRev": .null, "previousHeadId": .null,
            "source": ["kind": "maintenance", "nodeId": "run", "turnId": "run-turn", "assistantId": "run-a"],
            "proposalState": "pending", "applicationState": .null, "createdAt": 1, "resolvedAt": .null,
        ]
    }
}
