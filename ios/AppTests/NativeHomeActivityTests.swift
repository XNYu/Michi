import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class NativeHomeActivityTests: XCTestCase {
    func testParsesBackendSectionShapeAndRejectsIdentityMismatch() throws {
        let waiting = NativeHomeActivityContract.parseSections([
            "waiting": [
                "items": [conversationItem(node: "branch-9", title: "Unopened branch")],
                "total": 3
            ],
            "stalled": ["items": [], "total": 0],
            "done": ["items": [], "total": 0]
        ])
        XCTAssertTrue(waiting.errors.isEmpty)
        XCTAssertEqual(waiting.waiting?.total, 3)
        XCTAssertEqual(waiting.waiting?.items.first?.id, "conversation:branch-9")
        if case .conversation(let node, let workspace)? = waiting.waiting?.items.first?.target {
            XCTAssertEqual(node, "branch-9")
            XCTAssertEqual(workspace, "ws-1")
        } else {
            XCTFail("expected conversation target")
        }

        let bad = NativeHomeActivityContract.parseSections([
            "waiting": [
                "items": [conversationItem(node: "branch-9", title: "Unopened branch").merging(["id": "conversation:other"])],
                "total": 1
            ]
        ])
        XCTAssertFalse(bad.errors.isEmpty)
        XCTAssertNil(bad.waiting)
    }

    func testWaitingNonRootBranchAppearsInLocalNeedsYou() {
        let graph = fixtureGraph(rootStatus: "idle", branchStatus: "waiting")
        let items = NativeHomeActivityContract.localItems(graphs: [graph])
        XCTAssertTrue(items.contains { $0.nodeID == "branch-1" && $0.section == .needsYou })
        XCTAssertFalse(items.contains { $0.id.contains("root-1") && $0.section == .needsYou })
    }

    func testDuplicateLocalAndSectionRowsCollapseToOneNode() {
        let graph = fixtureGraph(rootStatus: "permission", branchStatus: nil)
        let local = NativeHomeActivityContract.localItems(graphs: [graph])
        let snapshot = NativeHomeActivityContract.parseSections([
            "waiting": ["items": [conversationItem(node: "root-1", title: "Same node from backend")], "total": 1]
        ])
        let remote = NativeHomeActivityContract.items(from: snapshot.waiting!, section: .needsYou, state: "waiting")
        let merged = NativeHomeActivityContract.merge(local: local, remote: remote)
        XCTAssertEqual(merged.filter { $0.nodeID == "root-1" }.count, 1)
        XCTAssertEqual(merged.first?.id, "perm-root-1")
    }

    func testJobActivePausedAndDateRules() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let tomorrow = (now.timeIntervalSince1970 + 86_400) * 1000
        let yesterday = (now.timeIntervalSince1970 - 86_400) * 1000
        let today = now.timeIntervalSince1970 * 1000

        let running = NativeHomeActivityContract.jobItems([
            ["id": "job-run", "name": "Nightly", "enabled": true, "autoPaused": false, "activeRunId": "run-1", "persistentNodeId": "n-1"]
        ], now: now)
        XCTAssertEqual(running.map(\.section), [.running])
        XCTAssertNil(running.first?.progress)

        let upcoming = NativeHomeActivityContract.jobItems([
            ["id": "job-next", "name": "Triage", "enabled": true, "autoPaused": false, "nextRunAt": .number(tomorrow)]
        ], now: now)
        XCTAssertEqual(upcoming.map(\.section), [.upNext])

        let paused = NativeHomeActivityContract.jobItems([
            ["id": "job-paused", "name": "Paused", "enabled": true, "autoPaused": true, "nextRunAt": .number(tomorrow)]
        ], now: now)
        XCTAssertTrue(paused.isEmpty)

        let oldSuccess = NativeHomeActivityContract.jobItems([
            ["id": "job-old", "name": "Old", "enabled": true, "lastStatus": "succeeded", "lastRunAt": .number(yesterday)]
        ], now: now)
        XCTAssertTrue(oldSuccess.isEmpty)
        XCTAssertFalse(NativeHomeActivityContract.isDoneToday(yesterday, now: now))
        XCTAssertTrue(NativeHomeActivityContract.isDoneToday(today, now: now))
    }

    func testFailedAndCancelledJobsAreJustDoneButNotPulseDone() {
        let now = Date()
        let today = now.timeIntervalSince1970 * 1000
        let failed = NativeHomeActivityContract.jobItems([
            ["id": "job-fail", "name": "Digest", "enabled": true, "lastStatus": "failed", "lastError": "timeout", "lastRunAt": .number(today)]
        ], now: now)
        let cancelled = NativeHomeActivityContract.jobItems([
            ["id": "job-cancel", "name": "Sweep", "enabled": true, "lastStatus": "cancelled", "lastRunAt": .number(today)]
        ], now: now)
        XCTAssertEqual(failed.first?.state, "failed")
        XCTAssertEqual(cancelled.first?.state, "failed")
        let pulse = NativeHomeActivityContract.pulse(items: failed + cancelled, waitingTotal: nil)
        XCTAssertEqual(pulse.doneToday, 0)
    }

    func testStalledIsListedButNotCountedAsDoneToday() {
        let graph = fixtureGraph(rootStatus: "stalled", branchStatus: nil)
        let items = NativeHomeActivityContract.localItems(graphs: [graph])
        XCTAssertEqual(items.first?.section, .justDone)
        XCTAssertEqual(items.first?.state, "stalled")
        XCTAssertEqual(NativeHomeActivityContract.pulse(items: items, waitingTotal: 4).doneToday, 0)
        XCTAssertEqual(NativeHomeActivityContract.pulse(items: items, waitingTotal: 4).needsYou, 4)
    }

    func testCreationSkipsSystemAndArchivedWorkspaces() {
        let archived = WorkspaceGraph(raw: [
            "workspace": ["id": "ws-arch", "name": "Old", "archived_at": 1, "deleted_at": .null, "settings": "{}"],
            "nodes": [], "trees": [], "edges": []
        ])
        let system = WorkspaceGraph(raw: [
            "workspace": ["id": "ws-sys", "name": "System", "deleted_at": .null, "archived_at": .null, "settings": "{\"system\":\"home\"}"],
            "nodes": [], "trees": [], "edges": []
        ])
        let live = WorkspaceGraph(raw: [
            "workspace": ["id": "ws-live", "name": "Studio", "deleted_at": .null, "archived_at": .null, "settings": "{}"],
            "nodes": [], "trees": [], "edges": []
        ])
        XCTAssertEqual(NativeHomeActivityContract.creationWorkspace(selected: archived, live: [archived, system, live])?.id, "ws-live")
        XCTAssertEqual(NativeHomeActivityContract.creationWorkspace(selected: system, live: [system, live])?.id, "ws-live")
        XCTAssertEqual(NativeHomeActivityContract.creationWorkspace(selected: live, live: [live])?.id, "ws-live")
    }

    func testRunningSubtitleUsesLoadedMessageCountNotNodes() {
        let graph = fixtureGraph(rootStatus: "streaming", branchStatus: nil)
        let items = NativeHomeActivityContract.localItems(
            graphs: [graph],
            chats: ["root-1": NativeHomeLiveChat(loaded: true, messageCount: 3)]
        )
        XCTAssertEqual(items.first?.subtitle, "Responding · 3 messages")
    }

    func testWaitingTotalComesFromBackendNotRowCount() {
        let snapshot = try! NativeHomeSectionSnapshot.parse([
            "items": [conversationItem(node: "n-1")],
            "total": 12
        ], maximum: 8)
        let items = NativeHomeActivityContract.items(from: snapshot, section: .needsYou, state: "waiting")
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(NativeHomeActivityContract.pulse(items: items, waitingTotal: snapshot.total).needsYou, 12)
        XCTAssertEqual(NativeHomeActivityContract.mergedNeedsYouCount(visible: items.count, waitingTotal: snapshot.total), 12)
    }

    func testMergedNeedsYouCountAddsLiveExtrasWithoutCollapsingServerCap() {
        let merged = [
            needsYouRow("wait-n-waiting", node: "n-waiting"),
            needsYouRow("wait-n-waiting-branch", node: "n-waiting-branch"),
            needsYouRow("wait-n-waiting-remote", node: "n-waiting-remote"),
            needsYouRow("change:chg-preview", node: nil, kind: .proposal),
        ]
        XCTAssertEqual(merged.count, 4)
        XCTAssertEqual(NativeHomeActivityContract.mergedNeedsYouCount(visible: merged.count, waitingTotal: 2), 4)
        XCTAssertEqual(NativeHomeActivityContract.pulse(items: merged, waitingTotal: 2).needsYou, 4)
        XCTAssertEqual(NativeHomeActivityContract.mergedNeedsYouCount(visible: 8, waitingTotal: 12), 12)
        XCTAssertEqual(NativeHomeActivityContract.pulse(items: Array(merged.prefix(1)), waitingTotal: 12).needsYou, 12)
        XCTAssertEqual(NativeHomeActivityContract.mergedNeedsYouCount(visible: 3, waitingTotal: nil), 3)
    }

    private func fixtureGraph(rootStatus: String, branchStatus: String?) -> WorkspaceGraph {
        var nodes: [JSONValue] = [
            ["id": "root-1", "workspace_id": "ws-1", "tree_id": "tree-1", "title": "Root chat", "kind": "chat",
             "status": .string(rootStatus), "deleted_at": .null, "created_at": 1]
        ]
        if let branchStatus {
            nodes.append(["id": "branch-1", "workspace_id": "ws-1", "tree_id": "tree-1", "parent_node_id": "root-1",
                          "title": "Branch waiting", "kind": "chat", "status": .string(branchStatus),
                          "deleted_at": .null, "created_at": 2])
        }
        return WorkspaceGraph(raw: [
            "workspace": ["id": "ws-1", "name": "Studio", "deleted_at": .null, "archived_at": .null, "settings": "{}"],
            "nodes": .array(nodes),
            "trees": [["id": "tree-1", "workspace_id": "ws-1", "root_node_id": "root-1", "created_at": 1, "last_active_at": 2, "archived_at": .null]],
            "edges": []
        ])
    }

    private func needsYouRow(_ id: String, node: String?, kind: NativeHomeActivityKind = .conversation) -> NativeHomeActivityItem {
        NativeHomeActivityItem(
            id: id, section: .needsYou, kind: kind, title: id, subtitle: "",
            symbol: "hand.raised", state: "waiting",
            workspaceID: "ws-1", nodeID: node, pageID: kind == .proposal ? "page-preview" : nil,
            jobID: nil, progress: nil, relative: "2h"
        )
    }

    private func conversationItem(node: String, title: String = "Needs a look") -> JSONValue {
        [
            "id": .string("conversation:\(node)"), "kind": "conversation",
            "title": .string(title), "summary": "Waiting on you",
            "workspaceId": "ws-1", "workspaceName": "Studio",
            "agentClaim": false, "at": 1_700_000_000_000,
            "target": ["kind": "conversation", "nodeId": .string(node), "workspaceId": "ws-1"]
        ]
    }
}
