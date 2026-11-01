import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func nativeRunFixture(status: String = "running", seq: Int = -1, workflow: Bool = false, revision: Int = 1) -> JSONValue {
    var run: JSONValue = ["version": 1, "id": "run-1", "workspaceId": "workspace-1", "status": .string(status), "activeAttemptId": "attempt-1", "createdAt": 1, "startedAt": 2,
        "latestEventSeq": .number(Double(seq)), "effectiveDefinition": ["name": "Researcher", "runtimeProfile": ["runtimeId": "codex"], "permissionPolicy": ["preset": "research"]],
        "task": "Review the sources", "definitionId": .null, "resultBundle": .null, "contextManifest": ["version": 1, "entries": []]]
    if workflow { run = run.merging(["revision": .number(Double(revision)), "name": "Workflow", "runtime": "claude", "nativeId": "native-1", "nodes": [], "log": [], "actions": ["pause", "stop"]]) }
    return run
}

private func nativeRunResponse(_ run: JSONValue) -> JSONValue {
    ["run": run, "attempts": [], "events": [], "interactions": []]
}

private func nativeWritableWorkspace() -> JSONValue {
    ["workspace": ["id": "workspace-1", "deleted_at": .null, "archived_at": .null, "purged_at": .null, "settings": .null]]
}

@MainActor final class AgentRunsTests: XCTestCase {
    private func journal() -> NativeRunMutationJournal {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("MichiAgentRunsTests-" + UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return NativeRunMutationJournal(directory: directory)
    }
    private func spawnModel(_ transport: AppContractTransport, journal: NativeRunMutationJournal) -> AgentRunsModel {
        let model = AgentRunsModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        model.workspaces = [["id": "workspace-1"]]; model.customAgentsEnabled = true
        model.definitions = [["id": "agent-1", "scope": "global", "status": "enabled"]]
        return model
    }
    private func detail(_ transport: AppContractTransport, kind: NativeRunKind = .agent, journal: NativeRunMutationJournal? = nil) -> AgentRunDetailModel {
        AgentRunDetailModel(api: transport.api, target: .init(id: "run-1", workspaceID: "workspace-1", kind: kind), journal: journal ?? self.journal())
    }
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(2)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }
    func testDisabledCustomAgentsStillLoadsWorkflowActivity() async {
        let transport = AppContractTransport { request, _ in
            switch request.path {
            case "/api/workspaces/all": return .json(["workspaces": [["workspace": ["id": "workspace-1", "name": "Work", "deleted_at": .null]]]])
            case "/api/agent/status": return .json(["customAgentsEnabled": false])
            case "/api/workflow-runs": return .json(["runs": [nativeRunFixture(workflow: true)]])
            default: return .json(["error": "Unexpected request"], status: 400)
            }
        }
        defer { transport.close() }
        let model = AgentRunsModel(api: transport.api, journal: journal())
        await model.bootstrap()
        XCTAssertEqual(model.workflows.count, 1)
        XCTAssertFalse(transport.requests.contains { $0.path == "/api/agent-runs" || $0.path == "/api/agents" })
    }
    func testForeignWorkspaceSnapshotCannotReplaceRunList() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/agent-runs" { return .json(["runs": [nativeRunFixture().merging(["workspaceId": "foreign"]) ]]) }
            return .json(["runs": []])
        }
        defer { transport.close() }
        let model = AgentRunsModel(api: transport.api, workspaceID: "workspace-1", journal: journal())
        model.workspaces = [["id": "workspace-1"]]; model.customAgentsEnabled = true; model.runs = [nativeRunFixture()]
        await model.reload()
        XCTAssertEqual(model.runs[0]["workspaceId"], "workspace-1")
        XCTAssertNotNil(model.error)
    }
    func testWorkflowRefreshNeverRollsBackRevision() async {
        let transport = AppContractTransport { _, requests in .json(["run": nativeRunFixture(workflow: true, revision: requests.count == 1 ? 5 : 3)]) }
        defer { transport.close() }
        let model = detail(transport, kind: .workflow)
        await model.load(); await model.load()
        XCTAssertEqual(model.run["revision"], 5)
    }
    func testEventGapDoesNotAdvanceCursorOrDiscardHistory() async {
        let transport = AppContractTransport { request, requests in
            if request.path.hasSuffix("/events") {
                let count = requests.filter { $0.path.hasSuffix("/events") }.count
                let seq = count == 1 ? 1 : 0
                return .json(["events": [["version": 1, "runId": "run-1", "seq": .number(Double(seq)), "type": "assistant", "payload": ["text": "Hello"]]]])
            }
            return .json(nativeRunResponse(nativeRunFixture(seq: 1)))
        }
        defer { transport.close() }
        let model = detail(transport)
        await model.load()
        XCTAssertTrue(model.events.isEmpty); XCTAssertNotNil(model.error)
        await model.load()
        XCTAssertEqual(model.events.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/events") }.map { $0.query["afterSeq"] }, ["-1", "-1"])
    }
    func testWrongRunEventCannotEnterTranscript() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/events") { return .json(["events": [["version": 1, "runId": "foreign", "seq": 0, "type": "assistant", "payload": "Unrelated"]]]) }
            return .json(nativeRunResponse(nativeRunFixture(seq: 0)))
        }
        defer { transport.close() }
        let model = detail(transport); await model.load()
        XCTAssertTrue(model.events.isEmpty); XCTAssertNotNil(model.error)
    }
    func testInputRequiresConfirmationAndCarriesAttemptIdentity() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/input") { return .json(["accepted": true]) }
            if request.path.hasSuffix("/events") { return .json(["events": []]) }
            return .json(nativeRunResponse(nativeRunFixture()))
        }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture(); model.input = "Please examine this"
        await model.sendInput(mode: "queued", confirmed: false)
        XCTAssertTrue(transport.requests.isEmpty)
        await model.sendInput(mode: "queued", confirmed: true)
        let request = transport.requests.first { $0.path.hasSuffix("/input") }
        XCTAssertEqual(request?.body, ["version": 1, "text": "Please examine this", "mode": "queued", "expectedAttemptId": "attempt-1"])
        XCTAssertFalse(request?.idempotencyKey?.isEmpty ?? true)
        XCTAssertEqual(model.input, "")
    }
    func testInputAcceptedAfterEditingDoesNotClearNewDraft() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/input") { return .delayedJSON(["accepted": true], status: 202, delay: 0.15) }
            if request.path.hasSuffix("/events") { return .json(["events": []]) }
            return .json(nativeRunResponse(nativeRunFixture()))
        }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture(); model.input = "Submitted"
        let sending = Task { await model.sendInput(mode: "queued", confirmed: true) }
        await eventually { transport.requests.contains { $0.path.hasSuffix("/input") } }
        model.input = "Next draft"; await sending.value
        XCTAssertEqual(model.input, "Next draft")
    }
    func testUnknownInputNeverRetriesEvenWithAnOperationID() async {
        let transport = AppContractTransport { _, _ in .failure(.networkConnectionLost) }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture(); model.input = "Do this once"
        await model.sendInput(mode: "queued", confirmed: true)
        XCTAssertNotNil(model.pendingAction); XCTAssertFalse(model.pendingAction!.canReplay)
        await model.retryPending(); await model.sendInput(mode: "queued", confirmed: true)
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(model.input, "Do this once")
    }
    func testContinuationRetryKeepsExactPayloadAndIdempotencyKey() async {
        let transport = AppContractTransport { request, requests in
            if request.path == "/api/workspaces/workspace-1" { return .json(nativeWritableWorkspace()) }
            if request.path.hasSuffix("/continue-as-branch") {
                if requests.filter({ $0.path.hasSuffix("/continue-as-branch") }).count == 1 { return .failure(.networkConnectionLost) }
                return .json(["version": 1, "runId": "run-1", "workspaceId": "workspace-1", "nodeId": "created-node", "treeId": "tree-1", "mode": "branch"])
            }
            if request.path.hasSuffix("/events") { return .json(["events": []]) }
            return .json(nativeRunResponse(nativeRunFixture(status: "completed")))
        }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture(status: "completed")
        await model.continueRun(includeTask: true, includeResult: false, includeTranscript: true, newThread: false, confirmed: true)
        XCTAssertTrue(model.pendingAction?.canReplay == true)
        await model.retryPending()
        let requests = transport.requests.filter { $0.path.hasSuffix("/continue-as-branch") }
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].idempotencyKey, requests[1].idempotencyKey)
        XCTAssertEqual(requests[0].body, requests[1].body)
        XCTAssertEqual(requests[0].body["fallback"], "error")
        XCTAssertEqual(model.continuation?["nodeId"], "created-node")
        XCTAssertNil(model.pendingAction)
    }
    func testWorkflowControlsUseOnlyAdvertisedActionsAndNoPromptQueue() async {
        let transport = AppContractTransport { _, _ in .json(["run": nativeRunFixture(status: "paused", workflow: true, revision: 2)]) }
        defer { transport.close() }
        let model = detail(transport, kind: .workflow); model.run = nativeRunFixture(workflow: true)
        await model.workflowAction("retry", confirmed: true); await model.workflowAction("pause", confirmed: false)
        XCTAssertTrue(transport.requests.isEmpty)
        await model.workflowAction("pause", confirmed: true)
        XCTAssertEqual(transport.requests.first?.path, "/api/workflow-runs/run-1/actions")
        XCTAssertEqual(transport.requests.first?.body, ["action": "pause"])
        XCTAssertFalse(transport.requests.contains { $0.path.contains("/chats/") })
    }
    func testInteractionResponseRejectsOldAttempt() async {
        let transport = AppContractTransport { _, _ in .json(["accepted": true]) }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture()
        model.interactions = [["id": "i1", "runId": "run-1", "attemptId": "older-attempt", "kind": "permission", "status": "pending"]]
        await model.respond(id: "i1", response: ["decision": "allow"], confirmed: true)
        XCTAssertTrue(transport.requests.isEmpty)
    }
    func testWorkflowApprovalOnlySendsKnownOption() async {
        let transport = AppContractTransport { _, _ in .json(["run": nativeRunFixture(workflow: true, revision: 2)]) }
        defer { transport.close() }
        let model = detail(transport, kind: .workflow)
        model.run = nativeRunFixture(workflow: true).merging(["approvals": [["id": "approval-1", "options": [["optionId": "allow-once", "name": "Allow once"]]]]])
        await model.workflowApproval(id: "approval-1", optionID: "allow-all", confirmed: true)
        XCTAssertTrue(transport.requests.isEmpty)
        await model.workflowApproval(id: "approval-1", optionID: "allow-once", confirmed: true)
        XCTAssertEqual(transport.requests.first?.body, ["optionId": "allow-once"])
    }
    func testWatchRequestsNotifyWithoutCreatingParentWake() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/agent-run-watches" { return .json(["watch": ["id": "watch-1", "workspaceId": "workspace-1", "status": "active"]]) }
            if request.path.hasSuffix("/events") { return .json(["events": []]) }
            return .json(nativeRunResponse(nativeRunFixture()))
        }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture()
        await model.createWatch(confirmed: true)
        let body = transport.requests.first!.body
        XCTAssertEqual(body["completionMode"], "notify"); XCTAssertEqual(body["runIds"], ["run-1"])
        XCTAssertEqual(body["condition"], ["version": 1, "kind": "all"])
        XCTAssertEqual(body["parentRunId"], .null); XCTAssertEqual(body["parentNodeId"], .null)
    }
    func testSpawnUnknownOutcomeBlocksSecondStart() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "GET" { return .json(nativeWritableWorkspace()) }
            return .failure(.timedOut)
        }
        defer { transport.close() }
        let model = AgentRunsModel(api: transport.api, workspaceID: "workspace-1", journal: journal())
        model.workspaces = [["id": "workspace-1"]]; model.customAgentsEnabled = true; model.definitions = [["id": "agent-1", "scope": "global", "status": "enabled"]]
        let unconfirmed = await model.spawn(definitionID: "agent-1", task: "Task", environment: "read_only", confirmed: false)
        XCTAssertFalse(unconfirmed)
        XCTAssertTrue(transport.requests.isEmpty)
        let first = await model.spawn(definitionID: "agent-1", task: "Task", environment: "read_only", confirmed: true)
        XCTAssertFalse(first); XCTAssertTrue(model.spawnOutcomeUnknown)
        let second = await model.spawn(definitionID: "agent-1", task: "Task", environment: "read_only", confirmed: true)
        let posts = transport.requests.filter { $0.method == "POST" }
        XCTAssertFalse(second); XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(posts.first?.body["environment"], ["version": 1, "kind": "shared_workspace", "access": "read_only"])
        XCTAssertEqual(posts.first?.body["invocationMode"], "manual")
    }
    func testMalformedSpawnReceiptCannotPermitDuplicateStart() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "GET" { return .json(nativeWritableWorkspace()) }
            return .json(["run": nativeRunFixture().merging(["workspaceId": "foreign"])])
        }
        defer { transport.close() }
        let model = AgentRunsModel(api: transport.api, workspaceID: "workspace-1", journal: journal())
        model.workspaces = [["id": "workspace-1"]]; model.customAgentsEnabled = true
        model.definitions = [["id": "agent-1", "scope": "global", "status": "enabled"]]
        let accepted = await model.spawn(definitionID: "agent-1", task: "Task", environment: "auto", confirmed: true)
        XCTAssertFalse(accepted); XCTAssertTrue(model.spawnOutcomeUnknown)
        XCTAssertNil(model.spawnedRun)
    }
    func testConfirmationCannotTargetReplacementAttempt() async {
        let transport = AppContractTransport { _, _ in .json(["accepted": true]) }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture(); model.input = "Redirect"
        await model.cancel(confirmed: true, expectedAttemptID: "old-attempt")
        await model.sendInput(mode: "immediate", confirmed: true, expectedAttemptID: "old-attempt", submittedInput: "Original")
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertEqual(model.input, "Redirect"); XCTAssertNotNil(model.error)
    }
    func testUnrelatedInteractionReceiptFreezesInsteadOfRetrying() async {
        let transport = AppContractTransport { _, _ in .json(["interaction": ["id": "other", "runId": "run-1", "status": "resolved"]]) }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture()
        model.interactions = [["id": "i1", "runId": "run-1", "attemptId": "attempt-1", "status": "pending"]]
        await model.respond(id: "i1", response: ["decision": "allow"], confirmed: true)
        XCTAssertNotNil(model.pendingAction); XCTAssertFalse(model.canMutate)
        await model.retryPending()
        XCTAssertEqual(transport.requests.count, 1)
    }
    func testFiltersAreSentToBackendAndPreservedForNextPage() async {
        let page = (0..<100).map { nativeRunFixture().merging(["id": .string(String(format: "run-%03d", $0))]) }
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/agent-runs" { return .json(["runs": request.query["cursor"] == nil ? .array(page) : []]) }
            return .json(["runs": []])
        }
        defer { transport.close() }
        let model = AgentRunsModel(api: transport.api, workspaceID: "workspace-1", journal: journal())
        model.workspaces = [["id": "workspace-1"]]; model.customAgentsEnabled = true
        model.query = "a & b"; model.statusFilter = "running"; model.includeArchived = true
        await model.reload(); await model.loadMore()
        let requests = transport.requests.filter { $0.path == "/api/agent-runs" }
        XCTAssertEqual(requests.count, 2)
        for request in requests {
            XCTAssertEqual(request.query["q"], "a & b"); XCTAssertEqual(request.query["status"], "running")
            XCTAssertEqual(request.query["includeArchived"], "true")
        }
        XCTAssertEqual(requests[1].query["cursor"], "run-099")
    }
    func testRuntimeErrorReturnedAsHTTP400CannotCauseRepeatedInput() async {
        let transport = AppContractTransport { _, _ in .json(["error": "Runtime input failed"], status: 400) }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture(); model.input = "Once"
        await model.sendInput(mode: "queued", confirmed: true)
        XCTAssertNotNil(model.pendingAction)
        await model.sendInput(mode: "queued", confirmed: true)
        XCTAssertEqual(transport.requests.count, 1)
    }
    func testInvalidSuccessBodyIsUncertainButLocalValidationIsNot() {
        XCTAssertTrue(NativeRunContract.uncertain(MichiAPIError(statusCode: 200, code: MichiAPIError.Code.invalidResponse, message: "Invalid JSON")))
        XCTAssertFalse(NativeRunContract.uncertain(MichiAPIError(statusCode: nil, code: MichiAPIError.Code.invalidPath, message: "Invalid path")))
        XCTAssertFalse(NativeRunContract.uncertain(MichiAPIError(statusCode: 400, code: "parent_unavailable", message: "Parent missing"), actionKind: "continue"))
    }
    func testUnknownInputIsDurableBeforePOSTAndSurvivesRecreation() async throws {
        let storage = journal()
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" {
                // The marker must exist before transport starts, not in the error handler.
                do {
                    let files = try FileManager.default.contentsOfDirectory(at: storage.directory!, includingPropertiesForKeys: nil)
                    XCTAssertEqual(files.count, 1)
                    let record = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: XCTUnwrap(files.first)))
                    XCTAssertEqual(record["action"]["key"].optionalString, request.idempotencyKey)
                    XCTAssertEqual(record["action"]["body"], request.body)
                } catch { XCTFail("Operation was not durably saved before POST: \(error)") }
                return .failure(.networkConnectionLost)
            }
            if request.path.hasSuffix("/events") { return .json(["events": []]) }
            return .json(nativeRunResponse(nativeRunFixture()))
        }
        defer { transport.close() }
        let first = detail(transport, journal: storage); first.run = nativeRunFixture(); first.input = "Only once"
        await first.sendInput(mode: "queued", confirmed: true)
        let recreated = detail(transport, journal: NativeRunMutationJournal(directory: storage.directory))
        XCTAssertEqual(recreated.pendingAction, first.pendingAction); XCTAssertEqual(recreated.input, "Only once")
        await recreated.load(); await recreated.retryPending(); await recreated.sendInput(mode: "queued", confirmed: true)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertFalse(recreated.canMutate)
    }
    func testLostSpawnSurvivesRecreationAndBlocksSecondOpenScreen() async {
        let transport = AppContractTransport { request, _ in request.method == "GET" ? .json(nativeWritableWorkspace()) : .failure(.timedOut) }
        defer { transport.close() }
        let storage = journal()
        // Two controllers sharing storage were opened before either operation.
        let model = spawnModel(transport, journal: storage)
        let second = spawnModel(transport, journal: NativeRunMutationJournal(directory: storage.directory))
        _ = await model.spawn(definitionID: "agent-1", task: "Only once", environment: "auto", confirmed: true)
        _ = await second.spawn(definitionID: "agent-1", task: "Duplicate", environment: "auto", confirmed: true)
        let recreated = spawnModel(transport, journal: NativeRunMutationJournal(directory: storage.directory))
        XCTAssertTrue(recreated.spawnOutcomeUnknown)
        XCTAssertEqual(recreated.pendingSpawn, model.pendingSpawn)
        XCTAssertEqual(recreated.pendingSpawn?.body["task"], "Only once")
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
    func testLostWorkflowOperationSurvivesRecreationWithoutReplay() async {
        let transport = AppContractTransport { _, _ in .failure(.networkConnectionLost) }
        defer { transport.close() }
        let storage = journal()
        let original = detail(transport, kind: .workflow, journal: storage); original.run = nativeRunFixture(workflow: true)
        await original.workflowAction("pause", confirmed: true)
        let recreated = detail(transport, kind: .workflow, journal: NativeRunMutationJournal(directory: storage.directory))
        recreated.run = nativeRunFixture(workflow: true)
        await recreated.retryPending(); await recreated.workflowAction("pause", confirmed: true)
        XCTAssertEqual(recreated.pendingAction, original.pendingAction)
        XCTAssertEqual(transport.requests.count, 1)
    }
    func testReceiptRecoveryAfterRecreationUsesExactOriginalKeyAndPayload() async throws {
        let storage = journal()
        let transport = AppContractTransport { request, requests in
            if request.path == "/api/workspaces/workspace-1" { return .json(nativeWritableWorkspace()) }
            if request.method == "POST" {
                if requests.filter({ $0.method == "POST" }).count == 1 { return .failure(.networkConnectionLost) }
                return .json(["runId": "run-1", "workspaceId": "workspace-1", "nodeId": "created-node"])
            }
            if request.path.hasSuffix("/events") { return .json(["events": []]) }
            return .json(nativeRunResponse(nativeRunFixture(status: "completed")))
        }
        defer { transport.close() }
        let original = detail(transport, journal: storage); original.run = nativeRunFixture(status: "completed")
        await original.continueRun(includeTask: true, includeResult: false, includeTranscript: true, newThread: false, confirmed: true)
        let recreated = detail(transport, journal: NativeRunMutationJournal(directory: storage.directory))
        await recreated.load()
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        await recreated.continueRun(includeTask: false, includeResult: true, includeTranscript: false, newThread: true, confirmed: true)
        await recreated.retryPending()
        let posts = transport.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 2); XCTAssertEqual(posts.first?.body, posts.last?.body)
        XCTAssertEqual(posts.first?.idempotencyKey, posts.last?.idempotencyKey)
        XCTAssertNil(recreated.pendingAction)
        XCTAssertNil(try storage.load(.init(api: transport.api, workspaceID: "workspace-1", target: recreated.target)))
    }
    func testPriorUnknownReceiptIsNotClearedByLaterDefiniteRejection() async {
        let storage = journal()
        let transport = AppContractTransport { request, requests in
            if request.method == "GET" { return .json(nativeWritableWorkspace()) }
            return requests.filter({ $0.method == "POST" }).count == 1 ? .failure(.networkConnectionLost)
                : .json(["error": "parent_unavailable", "message": "Continue as a new thread instead."], status: 400)
        }
        defer { transport.close() }
        let model = detail(transport, journal: storage); model.run = nativeRunFixture(status: "completed")
        await model.continueRun(includeTask: true, includeResult: false, includeTranscript: false, newThread: false, confirmed: true)
        let saved = model.pendingAction
        await model.retryPending()
        XCTAssertEqual(model.pendingAction, saved)
        let recreated = detail(transport, journal: NativeRunMutationJournal(directory: storage.directory))
        XCTAssertEqual(recreated.pendingAction, saved)
    }
    func testActualParentUnavailableBodyAllowsExplicitNewThreadFallback() async {
        let storage = journal()
        let transport = AppContractTransport { request, requests in
            if request.path == "/api/workspaces/workspace-1" { return .json(nativeWritableWorkspace()) }
            if request.method == "POST" {
                if requests.filter({ $0.method == "POST" }).count == 1 {
                    return .json(["error": "parent_unavailable", "message": "The Parent conversation is unavailable. Continue as a new thread instead."], status: 400)
                }
                return .json(["runId": "run-1", "workspaceId": "workspace-1", "nodeId": "new-thread"])
            }
            if request.path.hasSuffix("/events") { return .json(["events": []]) }
            return .json(nativeRunResponse(nativeRunFixture(status: "completed")))
        }
        defer { transport.close() }
        let model = detail(transport, journal: storage); model.run = nativeRunFixture(status: "completed")
        await model.continueRun(includeTask: true, includeResult: false, includeTranscript: false, newThread: false, confirmed: true)
        XCTAssertNil(model.pendingAction); XCTAssertEqual(model.error, "parent_unavailable")
        await model.continueRun(includeTask: true, includeResult: false, includeTranscript: false, newThread: true, confirmed: true)
        let posts = transport.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 2); XCTAssertNotEqual(posts.first?.idempotencyKey, posts.last?.idempotencyKey)
        XCTAssertEqual(posts.last?.body["fallback"], "new_thread"); XCTAssertEqual(model.continuation?["nodeId"], "new-thread")
    }
    func testMachineLabelsAreNarrowlyClassifiedByRouteAndStatus() {
        let label = MichiAPIError(statusCode: 400, code: nil, message: "parent_unavailable")
        XCTAssertFalse(NativeRunContract.uncertain(label, actionKind: "continue"))
        XCTAssertTrue(NativeRunContract.uncertain(label, actionKind: "input"))
        XCTAssertTrue(NativeRunContract.uncertain(MichiAPIError(statusCode: 500, code: nil, message: "parent_unavailable"), actionKind: "continue"))
        XCTAssertTrue(NativeRunContract.uncertain(MichiAPIError(statusCode: 400, code: nil, message: "parent_unavailable after mutation"), actionKind: "continue"))
        XCTAssertTrue(NativeRunContract.uncertain(MichiAPIError(statusCode: 409, code: nil, message: "conflict"), actionKind: "input"))
    }
    func testArchivedDeletedAndUnverifiableWorkspaceBlocksNewWork() async {
        let cases: [JSONValue] = [
            nativeWritableWorkspace()["workspace"].merging(["archived_at": 10]),
            nativeWritableWorkspace()["workspace"].merging(["deleted_at": 10]),
            nativeWritableWorkspace()["workspace"].merging(["id": "foreign"]),
            ["id": "workspace-1"],
            nativeWritableWorkspace()["workspace"].merging(["settings": ["system": "trash"]])
        ]
        for workspace in cases {
            let transport = AppContractTransport { _, _ in .json(["workspace": workspace]) }
            let spawner = spawnModel(transport, journal: journal())
            let started = await spawner.spawn(definitionID: "agent-1", task: "No new work", environment: "auto", confirmed: true)
            XCTAssertFalse(started); XCTAssertFalse(spawner.spawnOutcomeUnknown)
            let model = detail(transport); model.run = nativeRunFixture(status: "completed")
            await model.continueRun(includeTask: true, includeResult: false, includeTranscript: false, newThread: true, confirmed: true)
            await model.saveAsAgent(confirmed: true)
            XCTAssertNil(model.pendingAction); XCTAssertNotNil(model.error)
            XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 0)
            XCTAssertEqual(transport.requests.count, 3)
            transport.close()
        }
    }
    func testWorkspaceGuardIsFreshForEveryReceiptRecovery() async {
        let transport = AppContractTransport { request, requests in
            if request.method == "GET" {
                var workspace = nativeWritableWorkspace()["workspace"]
                if requests.filter({ $0.method == "GET" }).count > 1 { workspace = workspace.merging(["archived_at": 11]) }
                return .json(["workspace": workspace])
            }
            return .failure(.timedOut)
        }
        defer { transport.close() }
        let model = detail(transport); model.run = nativeRunFixture(status: "completed")
        await model.continueRun(includeTask: true, includeResult: false, includeTranscript: false, newThread: true, confirmed: true)
        let pending = model.pendingAction; await model.retryPending()
        XCTAssertEqual(model.pendingAction, pending)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }
    func testJournalCorruptionAndUnwritableStorageNeverSendPOST() async throws {
        let transport = AppContractTransport { _, _ in .json(["accepted": true]) }
        defer { transport.close() }
        let storage = journal(), target = NativeRunTarget(id: "run-1", workspaceID: "workspace-1", kind: .agent)
        try FileManager.default.createDirectory(at: storage.directory!, withIntermediateDirectories: true)
        try Data("corrupt".utf8).write(to: storage.fileURL(.init(api: transport.api, workspaceID: target.workspaceID, target: target)))
        let corrupt = detail(transport, journal: storage); corrupt.run = nativeRunFixture(); corrupt.input = "No send"
        XCTAssertNotNil(corrupt.recoveryIssue); await corrupt.sendInput(mode: "queued", confirmed: true)
        let unavailable = journal()
        try Data("regular file".utf8).write(to: unavailable.directory!)
        let blocked = detail(transport, journal: unavailable); blocked.run = nativeRunFixture(); blocked.input = "No send"
        await blocked.sendInput(mode: "queued", confirmed: true)
        XCTAssertTrue(transport.requests.isEmpty); XCTAssertNotNil(blocked.error)
    }
    func testJournalScopeSeparatesConnectionsWorkspacesAndRuns() throws {
        let transport = AppContractTransport { _, _ in .json([:]) }, other = AppContractTransport { _, _ in .json([:]) }
        defer { transport.close(); other.close() }
        let storage = journal(), target = NativeRunTarget(id: "run-1", workspaceID: "workspace-1", kind: .agent)
        let scope = NativeRunMutationScope(api: transport.api, workspaceID: "workspace-1", target: target)
        let action = NativeRunPendingAction(kind: "input", path: "/agent-runs/run-1/input", body: ["text": "once"], canReplay: false, submittedText: "once")
        try storage.reserve(action, scope: scope)
        XCTAssertEqual(try storage.load(scope), action)
        XCTAssertNil(try storage.load(.init(api: other.api, workspaceID: "workspace-1", target: target)))
        XCTAssertNil(try storage.load(.init(api: transport.api, workspaceID: "workspace-2", target: target)))
        XCTAssertNil(try storage.load(.init(api: transport.api, workspaceID: "workspace-1", target: .init(id: "run-2", workspaceID: "workspace-1", kind: .agent))))
    }

    func testReadAccessToArchivedAndDeletedWorkspacesIsPreserved() async {
        let transport = AppContractTransport { request, _ in
            switch request.path {
            case "/api/workspaces/all": return .json(["workspaces": [
                ["workspace": ["id": "workspace-1", "archived_at": 10]],
                ["workspace": ["id": "workspace-2", "deleted_at": 10]]]])
            case "/api/agent/status": return .json(["customAgentsEnabled": true])
            case "/api/agents": return .json(["definitions": []])
            case "/api/agent-runs", "/api/workflow-runs": return .json(["runs": []])
            default:
                if request.path.hasSuffix("/events") { return .json(["events": []]) }
                return .json(nativeRunResponse(nativeRunFixture(status: "completed")))
            }
        }
        defer { transport.close() }
        let list = AgentRunsModel(api: transport.api, workspaceID: "workspace-1", journal: journal())
        await list.bootstrap(); XCTAssertEqual(list.workspaces.map(\.id), ["workspace-1", "workspace-2"])
        await list.selectWorkspace("workspace-2"); XCTAssertEqual(list.workspaceID, "workspace-2")
        let model = detail(transport); await model.load(); XCTAssertTrue(model.ready)
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

}
