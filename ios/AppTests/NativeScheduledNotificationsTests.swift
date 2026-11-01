import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func scheduledNotificationEvent(_ changes: [String: JSONValue] = [:]) -> JSONValue {
    JSONValue.object(["phase": "finished", "runId": "run-1", "jobId": "job-1", "jobName": "Daily summary",
        "workspaceId": "workspace-1", "nodeId": "node-1", "treeId": "tree-1", "status": "succeeded",
        "summary": "Three changes to review", "error": .null, "notify": true, "at": 1000]).merging(changes)
}

@MainActor final class NativeScheduledNotificationsTests: XCTestCase {
    private func activeModel(_ transport: AppContractTransport, preference: String = "all") -> NativeScheduledNotificationsModel {
        let model = NativeScheduledNotificationsModel(api: transport.api)
        model.setNotificationPreference(preference); model.setActive(true)
        return model
    }

    func testReceiveHasNoNetworkAcknowledgementOrOtherSideEffects() {
        let transport = AppContractTransport { _, _ in .json(["error": "unexpected request"], status: 500) }; defer { transport.close() }
        let model = activeModel(transport)
        XCTAssertTrue(model.receive(scheduledNotificationEvent()))
        XCTAssertEqual(model.notice?.title, "Daily summary")
        XCTAssertEqual(model.notice?.subtitle, "Scheduled job finished")
        XCTAssertEqual(model.notice?.body, "Three changes to review")
        model.dismiss(); XCTAssertNil(model.notice)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testInactiveUnloadedOffAndUnknownPreferencesSuppressDelivery() {
        let transport = AppContractTransport { _, _ in .json([:]) }; defer { transport.close() }
        let model = NativeScheduledNotificationsModel(api: transport.api)
        XCTAssertFalse(model.receive(scheduledNotificationEvent()))
        model.setActive(true)
        XCTAssertFalse(model.receive(scheduledNotificationEvent(["runId": "run-2"])))
        model.setNotificationPreference("off")
        XCTAssertFalse(model.receive(scheduledNotificationEvent(["runId": "run-3"])))
        model.setNotificationPreference("future-mode")
        XCTAssertFalse(model.receive(scheduledNotificationEvent(["runId": "run-4"])))
        model.setNotificationPreference("all")
        XCTAssertFalse(model.receive(scheduledNotificationEvent(["runId": "run-3"])), "Previously suppressed events must not reappear after preferences change")
        XCTAssertTrue(model.receive(scheduledNotificationEvent(["runId": "run-5"])))
        model.setNotificationPreference("off"); XCTAssertNil(model.notice)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testScheduledCompletionUsesPerJobNotifyEvenWithApprovalOnlyPreference() {
        let transport = AppContractTransport { _, _ in .json([:]) }; defer { transport.close() }
        let model = activeModel(transport, preference: "approval-only")
        // Phone chatStore checks only global off for scheduled events.
        XCTAssertTrue(model.receive(scheduledNotificationEvent()))
        XCTAssertFalse(model.receive(scheduledNotificationEvent(["runId": "muted-job", "notify": false])))
        XCTAssertEqual(model.notice?.id.runID, "run-1")
    }

    func testAttentionDoesNotRequireCompletionNotifyAndDistinguishesInputFromApproval() {
        let transport = AppContractTransport { _, _ in .json([:]) }; defer { transport.close() }
        let model = activeModel(transport)
        let attention = scheduledNotificationEvent(["phase": "attention", "status": "running", "notify": false, "attention": "input"])
        XCTAssertTrue(model.receive(attention)); XCTAssertEqual(model.notice?.subtitle, "Needs your input")
        XCTAssertTrue(model.notice?.needsAttention == true)
        XCTAssertTrue(model.receive(attention.merging(["attention": "approval"])))
        XCTAssertEqual(model.notice?.subtitle, "Needs your approval")
    }

    func testOnlySupportedFinishedOutcomesProduceBanners() {
        XCTAssertNil(NativeScheduledNotificationsContract.notice(scheduledNotificationEvent(["phase": "started", "status": "running"])))
        for status in ["cancelled", "interrupted", "running"] {
            XCTAssertNil(NativeScheduledNotificationsContract.notice(scheduledNotificationEvent(["status": .string(status)])))
        }
        XCTAssertEqual(NativeScheduledNotificationsContract.notice(scheduledNotificationEvent(["status": "failed", "error": "Agent unavailable"]))?.body, "Agent unavailable")
        XCTAssertEqual(NativeScheduledNotificationsContract.notice(scheduledNotificationEvent(["status": "timed_out", "error": .null]))?.subtitle, "Scheduled job failed")
        XCTAssertEqual(NativeScheduledNotificationsContract.notice(scheduledNotificationEvent(["summary": ""]))?.body, "Open the conversation to see the result.")
    }

    func testMalformedControlFramesAndMissingConversationAreIgnored() {
        let badFields: [[String: JSONValue]] = [
            ["phase": "invented"], ["runId": ""], ["jobId": ""], ["nodeId": .null], ["workspaceId": ""],
            ["notify": "true"], ["at": -1], ["at": .number(1.5)], ["summary": [:]], ["error": []],
            ["phase": "attention", "status": "running"], ["phase": "attention", "status": "succeeded", "attention": "input"],
        ]
        for fields in badFields { XCTAssertNil(NativeScheduledNotificationsContract.notice(scheduledNotificationEvent(fields))) }
    }

    func testDuplicateReplayIsSuppressedButDifferentPhaseOrAttentionTimeCanNotify() {
        let transport = AppContractTransport { _, _ in .json([:]) }; defer { transport.close() }
        let model = activeModel(transport)
        let attention = scheduledNotificationEvent(["phase": "attention", "status": "running", "attention": "approval"])
        XCTAssertTrue(model.receive(attention)); model.dismiss()
        XCTAssertFalse(model.receive(attention)); XCTAssertNil(model.notice)
        XCTAssertTrue(model.receive(attention.merging(["at": 1001])))
        XCTAssertTrue(model.receive(scheduledNotificationEvent()))
        XCTAssertFalse(model.receive(scheduledNotificationEvent()))
    }

    func testDedupeStorageIsBounded() {
        let transport = AppContractTransport { _, _ in .json([:]) }; defer { transport.close() }
        let model = activeModel(transport)
        for index in 0...NativeScheduledNotificationsModel.deduplicationLimit {
            XCTAssertTrue(model.receive(scheduledNotificationEvent(["runId": .string("run-\(index)")])))
        }
        XCTAssertFalse(model.receive(scheduledNotificationEvent(["runId": "run-512"])))
        XCTAssertTrue(model.receive(scheduledNotificationEvent(["runId": "run-0"])), "Only a bounded recent window of IDs is retained")
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testSceneDetachClearsBannerAndKeepsReplayDedupeWithoutCancellingRun() {
        let transport = AppContractTransport { _, _ in .json([:]) }; defer { transport.close() }
        let model = activeModel(transport)
        model.receive(scheduledNotificationEvent())
        model.setActive(false); XCTAssertNil(model.notice)
        XCTAssertFalse(model.receive(scheduledNotificationEvent(["runId": "late-frame"])))
        model.setActive(true)
        XCTAssertFalse(model.receive(scheduledNotificationEvent()))
        XCTAssertTrue(model.receive(scheduledNotificationEvent(["runId": "new-run"])))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testExpiredOlderBannerCannotDismissNewerNotice() throws {
        let transport = AppContractTransport { _, _ in .json([:]) }; defer { transport.close() }
        let model = activeModel(transport)
        model.receive(scheduledNotificationEvent()); let old = try XCTUnwrap(model.notice)
        model.receive(scheduledNotificationEvent(["runId": "run-2"]))
        model.dismiss(old.id)
        XCTAssertEqual(model.notice?.id.runID, "run-2")
    }

    func testNavigationReadsCurrentWorkspaceAndMovedTreeWithoutAcknowledgingDelivery() async throws {
        var graph = appContractGraph().raw
        graph["nodes"] = [.object(graph["nodes"].arrayValue[0].objectValue.merging(["tree_id": "moved-tree"]) { _, new in new })]
        graph["trees"] = [["id": "moved-tree", "workspace_id": "workspace-1", "archived_at": 2]]
        let snapshot = graph
        let transport = AppContractTransport { _, _ in .json(snapshot) }; defer { transport.close() }
        let model = activeModel(transport); model.receive(scheduledNotificationEvent())
        let notice = try XCTUnwrap(model.notice), target = await model.target(for: notice)
        XCTAssertEqual(target, NativeScheduledNotificationTarget(workspaceID: "workspace-1", nodeID: "node-1", treeID: "moved-tree", readOnly: true))
        XCTAssertEqual(transport.requests.map(\.path), ["/api/workspaces/workspace-1"])
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
    }

    func testNavigationRejectsDeletedForeignAndMissingTreeRecords() throws {
        let notice = try XCTUnwrap(NativeScheduledNotificationsContract.notice(scheduledNotificationEvent()))
        var cases = [appContractGraph(nodeDeleted: true).raw]
        var foreign = appContractGraph().raw; foreign["workspace"]["id"] = "foreign"; cases.append(foreign)
        var wrongNode = appContractGraph().raw; wrongNode["nodes"] = [["id": "node-1", "workspace_id": "foreign", "tree_id": "tree-1"]]; cases.append(wrongNode)
        var purged = appContractGraph().raw; purged["workspace"]["purged_at"] = 3; cases.append(purged)
        var noTree = appContractGraph().raw; noTree["trees"] = []; cases.append(noTree)
        for snapshot in cases { XCTAssertThrowsError(try NativeScheduledNotificationsContract.target(for: notice, workspace: snapshot)) }
    }

    func testNavigationFailureNeverUsesPreviousGraphOrLeaksBackendErrorBody() async throws {
        let transport = AppContractTransport { _, _ in .json(["error": "raw-private-error"], status: 503) }; defer { transport.close() }
        let model = activeModel(transport); model.receive(scheduledNotificationEvent())
        let notice = try XCTUnwrap(model.notice), target = await model.target(for: notice)
        XCTAssertNil(target); XCTAssertNotNil(model.error); XCTAssertFalse(model.error?.contains("raw-private-error") == true)
        XCTAssertEqual(transport.requests.count, 1); XCTAssertFalse(model.opening)
    }

    func testNavigationFinishingAfterSceneDetachDoesNotOpen() async throws {
        let snapshot = appContractGraph().raw
        let transport = AppContractTransport { _, _ in .delayedJSON(snapshot, status: 200, delay: 0.15) }; defer { transport.close() }
        let model = activeModel(transport); model.receive(scheduledNotificationEvent())
        let notice = try XCTUnwrap(model.notice)
        let task = Task { await model.target(for: notice) }
        let deadline = Date().addingTimeInterval(2)
        while transport.requests.isEmpty && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        model.setActive(false); model.setActive(true)
        let target = await task.value
        XCTAssertNil(target); XCTAssertFalse(model.opening); XCTAssertNil(model.error)
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
    }

    func testTurningNotificationsOffInvalidatesPendingNavigation() async throws {
        let snapshot = appContractGraph().raw
        let transport = AppContractTransport { _, _ in .delayedJSON(snapshot, status: 200, delay: 0.15) }; defer { transport.close() }
        let model = activeModel(transport); model.receive(scheduledNotificationEvent())
        let notice = try XCTUnwrap(model.notice)
        let task = Task { await model.target(for: notice) }
        let deadline = Date().addingTimeInterval(2)
        while transport.requests.isEmpty && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        model.setNotificationPreference("off")
        let target = await task.value
        XCTAssertNil(target); XCTAssertNil(model.notice); XCTAssertFalse(model.opening)
    }

    func testRepeatedOpenTapOnlyFetchesOnce() async throws {
        let snapshot = appContractGraph().raw
        let transport = AppContractTransport { _, _ in .delayedJSON(snapshot, status: 200, delay: 0.15) }; defer { transport.close() }
        let model = activeModel(transport); model.receive(scheduledNotificationEvent())
        let notice = try XCTUnwrap(model.notice)
        let first = Task { await model.target(for: notice) }
        let deadline = Date().addingTimeInterval(2)
        while transport.requests.isEmpty && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        let second = await model.target(for: notice)
        let target = await first.value
        XCTAssertNil(second); XCTAssertNotNil(target); XCTAssertEqual(transport.requests.count, 1)
    }
}
