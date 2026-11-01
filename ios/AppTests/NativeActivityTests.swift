import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class NativeActivityTests: XCTestCase {
    private func fixtureRun(_ id: String = "run-1", started: Int = 1000) -> JSONValue {
        ["id": .string(id), "jobId": "job-1", "workspaceId": "workspace-1", "nodeId": "node-1", "treeId": "tree-1",
         "status": "succeeded", "trigger": "scheduled", "startedAt": .number(Double(started)), "finishedAt": 3200,
         "summary": "Run result", "error": .null, "future": ["kept": true]]
    }
    func testHistoryLoadsAndSortsWithoutAcknowledgingDesktopNotification() async {
        let records: JSONValue = [fixtureRun("old", started: 1000), fixtureRun("new", started: 2000)]
        let transport = AppContractTransport { _, _ in .json(["runs": records]) }; defer { transport.close() }
        let model = NativeRunHistoryModel(api: transport.api, jobID: "job-1"); await model.reload()
        XCTAssertEqual(model.runs.map(\.id), ["new", "old"])
        XCTAssertEqual(transport.requests.map(\.path), ["/api/scheduled-jobs/job-1/runs"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
        XCTAssertEqual(model.runs[0]["future"], ["kept": true])
    }
    func testInvalidHistoryRefreshKeepsPreviousRuns() async {
        let record = fixtureRun()
        let transport = AppContractTransport { _, requests in requests.count == 1 ? .json(["runs": [record]]) : .json(["runs": "broken"]) }; defer { transport.close() }
        let model = NativeRunHistoryModel(api: transport.api, jobID: "job-1")
        await model.reload(); await model.reload()
        XCTAssertTrue(model.loaded); XCTAssertEqual(model.runs.map(\.id), ["run-1"]); XCTAssertNotNil(model.error)
    }
    func testForeignJobRunsAreRejectedAsOneInvalidSnapshot() async {
        let record = fixtureRun().merging(["jobId": "other-job"])
        let transport = AppContractTransport { _, _ in .json(["runs": [record]]) }; defer { transport.close() }
        let model = NativeRunHistoryModel(api: transport.api, jobID: "job-1"); await model.reload()
        XCTAssertFalse(model.loaded); XCTAssertTrue(model.runs.isEmpty); XCTAssertNotNil(model.error)
    }
    func testDuplicateRunIDsAreNotShownAsDistinctExecutions() async {
        let record = fixtureRun()
        let transport = AppContractTransport { _, _ in .json(["runs": [record, record]]) }; defer { transport.close() }
        let model = NativeRunHistoryModel(api: transport.api, jobID: "job-1"); await model.reload()
        XCTAssertFalse(model.loaded); XCTAssertNotNil(model.error)
    }
    func testRunDetailValidatesRequestedIdentityBeforeNavigation() async {
        let record = fixtureRun("different-run")
        let transport = AppContractTransport { _, _ in .json(record) }; defer { transport.close() }
        let model = NativeScheduledRunModel(api: transport.api, runID: "run-1")
        let target = await model.conversationTarget()
        XCTAssertNil(target); XCTAssertFalse(model.loaded)
        XCTAssertEqual(transport.requests.count, 1)
    }
    func testOpenConversationResolvesCurrentTreeAfterNodeWasMoved() async {
        let record = fixtureRun()
        var workspace = appContractGraph().raw
        workspace["nodes"] = [.object(workspace["nodes"].arrayValue[0].objectValue.merging(["tree_id": "tree-new"]) { _, next in next })]
        workspace["trees"] = [["id": "tree-new", "workspace_id": "workspace-1", "archived_at": .null]]
        let snapshot = workspace
        let transport = AppContractTransport { request, _ in request.path.contains("/scheduled-jobs/") ? .json(record) : .json(snapshot) }; defer { transport.close() }
        let model = NativeScheduledRunModel(api: transport.api, runID: "run-1")
        let target = await model.conversationTarget()
        XCTAssertEqual(target, NativeRunConversationTarget(workspaceID: "workspace-1", treeID: "tree-new", nodeID: "node-1", readOnly: false))
        XCTAssertEqual(transport.requests.map(\.path), ["/api/scheduled-jobs/runs/run-1", "/api/workspaces/workspace-1"])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }
    func testArchivedRunConversationCanOpenReadOnly() async {
        let record = fixtureRun(), snapshot = appContractGraph(treeArchived: true).raw
        let transport = AppContractTransport { request, _ in request.path.contains("/scheduled-jobs/") ? .json(record) : .json(snapshot) }; defer { transport.close() }
        let model = NativeScheduledRunModel(api: transport.api, runID: "run-1")
        let target = await model.conversationTarget()
        XCTAssertEqual(target?.readOnly, true)
    }
    func testDeletedNodeCannotBeOpenedFromOldRun() async {
        let record = fixtureRun(), snapshot = appContractGraph(nodeDeleted: true).raw
        let transport = AppContractTransport { request, _ in request.path.contains("/scheduled-jobs/") ? .json(record) : .json(snapshot) }; defer { transport.close() }
        let model = NativeScheduledRunModel(api: transport.api, runID: "run-1")
        let target = await model.conversationTarget(); XCTAssertNil(target)
        XCTAssertNotNil(model.error)
    }
    func testForeignWorkspaceSnapshotCannotRedirectNavigation() async {
        let record = fixtureRun()
        var workspace = appContractGraph().raw; workspace["workspace"]["id"] = "foreign"
        let snapshot = workspace
        let transport = AppContractTransport { request, _ in request.path.contains("/scheduled-jobs/") ? .json(record) : .json(snapshot) }; defer { transport.close() }
        let model = NativeScheduledRunModel(api: transport.api, runID: "run-1")
        let target = await model.conversationTarget(); XCTAssertNil(target); XCTAssertNotNil(model.error)
    }
    func testMissingConversationDoesNotFetchWorkspace() async {
        let record = fixtureRun().merging(["nodeId": .null, "treeId": .null, "status": "running"])
        let transport = AppContractTransport { _, _ in .json(record) }; defer { transport.close() }
        let model = NativeScheduledRunModel(api: transport.api, runID: "run-1")
        let target = await model.conversationTarget(); XCTAssertNil(target)
        XCTAssertFalse(model.hasConversation); XCTAssertEqual(transport.requests.count, 1)
    }
    func testRunReloadFailureNeverNavigatesUsingPreviouslyValidData() async {
        let record = fixtureRun()
        let transport = AppContractTransport { _, requests in requests.count == 1 ? .json(record) : .json(["error": "offline"], status: 503) }; defer { transport.close() }
        let model = NativeScheduledRunModel(api: transport.api, runID: "run-1"); await model.reload()
        XCTAssertTrue(model.loaded)
        let target = await model.conversationTarget(); XCTAssertNil(target)
        XCTAssertEqual(model.run.id, "run-1"); XCTAssertEqual(transport.requests.count, 2)
    }
    func testDurationRetainsSecondsAndRejectsInvalidTimes() async {
        XCTAssertEqual(NativeScheduledRunContract.duration(fixtureRun().merging(["startedAt": 1000, "finishedAt": 91500])), "1m 30s")
        XCTAssertNil(NativeScheduledRunContract.duration(fixtureRun().merging(["finishedAt": 100])))
        XCTAssertNil(NativeScheduledRunContract.duration(fixtureRun().merging(["finishedAt": .null])))
    }
}
