import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class SynchronizationContractTests: XCTestCase {
    func testDirtyPageTitleKeepsOriginalRevisionAcrossRemoteRefresh() async throws {
        let lock = NSLock()
        var reads = 0
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/pages/page-1", request.method == "PATCH" {
                return .json(["error": ["code": "revision_conflict", "message": "Page changed remotely"]], status: 409)
            }
            if request.path == "/api/pages/page-1" {
                lock.lock(); reads += 1; let revision = reads; lock.unlock()
                return .json(["id": "page-1", "workspaceId": "workspace-1", "revision": .number(Double(revision)), "title": revision == 1 ? "Original" : "Remote title", "blocks": []])
            }
            return .json(["items": [], "databaseId": .null])
        }
        defer { transport.close() }
        let model = FeaturePageModel(api: transport.api, pageId: "page-1", workspaceId: "workspace-1")
        await model.refresh()
        model.title = "Unsaved local title"
        await model.refresh()
        XCTAssertEqual(model.title, "Unsaved local title")
        XCTAssertEqual(model.revision, 2)
        await model.saveTitle()
        let mutation = try XCTUnwrap(transport.requests.first { $0.method == "PATCH" })
        XCTAssertEqual(mutation.body["revision"], 1)
        XCTAssertEqual(model.title, "Unsaved local title")
        XCTAssertNotNil(model.error)
        model.discardTitleChanges()
        XCTAssertEqual(model.title, "Remote title")
        XCTAssertFalse(model.titleDirty)
    }

    func testBackgroundGapDoesNotAdvanceCursorWhenHistoryHydrationFails() async throws {
        var graph = appContractGraph().raw
        graph["nodes"] = .array(graph["nodes"].arrayValue.map { $0.merging(["last_applied_turn_id": "turn-1", "last_applied_seq": 1]) })
        let initial = graph
        let transport = AppContractTransport { request, requests in
            if request.path == "/api/workspaces/all" {
                var snapshot = initial
                if requests.contains(where: { $0.path == "/api/chats/background/subscribe" }) { snapshot["nodes"] = .array(initial["nodes"].arrayValue.map { $0.merging(["last_applied_seq": 5]) }) }
                return .json(["workspaces": .array([snapshot])])
            }
            if request.path == "/api/chats/background/subscribe" {
                return .events([("background_sync_required", ["chatId": "node-1", "nodeId": "node-1", "turnId": "turn-1", "seq": 5])])
            }
            if request.path.hasSuffix("/messages") {
                if requests.filter({ $0.path.hasSuffix("/messages") }).count == 1 { return .json(["messages": []]) }
                return .json(["error": "History unavailable"], status: 503)
            }
            return .json([:])
        }
        defer { transport.close() }
        let store = MichiStore(api: transport.api)
        await store.reload()
        XCTAssertNotNil(store.chat(for: "node-1"))
        store.startObserving()
        let deadline = Date().addingTimeInterval(4)
        while transport.requests.filter({ $0.path == "/api/chats/background/subscribe" }).count < 2 && Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        store.disconnectStreams()
        let requests = transport.requests.filter { $0.path == "/api/chats/background/subscribe" }
        XCTAssertGreaterThanOrEqual(requests.count, 2)
        XCTAssertEqual(requests.last?.body["cursors"]["node-1"]["seq"], 1)
    }
    func testGapForOneNodeCannotAdvanceAnotherNodeAcrossObserverRestart() async throws {
        var base = appContractGraph().raw
        base["nodes"] = .array([
            base["nodes"].arrayValue[0].merging(["last_applied_turn_id": "turn-1", "last_applied_seq": 1]),
            ["id": "node-2", "workspace_id": "workspace-1", "tree_id": "tree-2", "status": "idle", "last_applied_turn_id": "turn-2", "last_applied_seq": 1],
        ])
        base["trees"] = .array(base["trees"].arrayValue + [["id": "tree-2", "workspace_id": "workspace-1", "root_node_id": "node-2"]])
        let initial = base
        let transport = AppContractTransport { request, requests in
            let subscribed = requests.contains { $0.path == "/api/chats/background/subscribe" }
            if request.path == "/api/workspaces/all" {
                var graph = initial
                if subscribed { graph["nodes"] = .array(initial["nodes"].arrayValue.map { $0.merging(["last_applied_seq": 5]) }) }
                return .json(["workspaces": .array([graph])])
            }
            if request.path.hasSuffix("/messages") {
                if subscribed && request.path.contains("tree-2") { return .json(["error": "Second history unavailable"], status: 503) }
                return .json(["messages": []])
            }
            if request.path == "/api/chats/background/subscribe" {
                return .events([
                    ("background_sync_required", ["nodeId": "node-1", "chatId": "node-1", "turnId": "turn-1", "seq": 5]),
                    ("background_sync_required", ["nodeId": "node-2", "chatId": "node-2", "turnId": "turn-2", "seq": 5]),
                ])
            }
            return .json([:])
        }
        defer { transport.close() }
        let store = MichiStore(api: transport.api)
        await store.reload()
        XCTAssertNotNil(store.chat(for: "node-1")); XCTAssertNotNil(store.chat(for: "node-2"))
        store.startObserving()
        var deadline = Date().addingTimeInterval(3)
        while store.synchronizationError == nil && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(store.synchronizationError)
        store.disconnectStreams(); store.startObserving()
        deadline = Date().addingTimeInterval(3)
        while transport.requests.filter({ $0.path == "/api/chats/background/subscribe" }).count < 2 && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        store.disconnectStreams()
        let calls = transport.requests.filter { $0.path == "/api/chats/background/subscribe" }
        XCTAssertGreaterThanOrEqual(calls.count, 2)
        XCTAssertEqual(calls.last?.body["cursors"]["node-1"]["seq"], 5)
        XCTAssertEqual(calls.last?.body["cursors"]["node-2"]["seq"], 1)
    }

}
