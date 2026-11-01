import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func readDigest(_ generation: Double = 100, viewedAt: Double = 0) -> JSONValue {
    ["id": "digest-1", "workspace_id": "workspace-1", "kind": "digest", "deleted_at": .null,
     "digest": ["generatedAt": .number(generation), "viewedAt": .number(viewedAt), "status": "idle", "content": "Saved content", "opaque": ["x": [true, .null]]]]
}
private func readGraph(_ node: JSONValue) -> JSONValue { ["workspace": ["id": "workspace-1"], "nodes": .array([node])] }
private func readReceipt(generation: Double = 100, viewedAt: Double = 200) -> JSONValue {
    ["workspaceId": "workspace-1", "nodeId": "digest-1", "generatedAt": .number(generation), "viewedAt": .number(viewedAt), "changed": true]
}

@MainActor final class NativeDigestReadTests: XCTestCase {
    private lazy var defaults: UserDefaults = {
        let suite = "michi-digest-read-test-" + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        addTeardownBlock { preferences.removePersistentDomain(forName: suite) }
        return preferences
    }()
    private func model(_ transport: AppContractTransport) -> NativeDigestReadModel {
        NativeDigestReadModel(api: transport.api, workspaceID: "workspace-1", defaults: defaults)
    }

    func testMatchingGenerationUsesOnlyFieldScopedEndpointAndDeduplicates() async {
        let transport = AppContractTransport { request, _ in
            request.method == "GET" ? .json(["digestReadMarkers": "v1"]) : .json(readReceipt())
        }; defer { transport.close() }
        let model = model(transport)
        let first = await model.markViewed(node: readDigest())
        let again = await model.markViewed(node: readDigest())
        XCTAssertEqual(first, again); XCTAssertEqual(first?.viewedAt, 200)
        let writes = transport.requests.filter { $0.method == "POST" }
        XCTAssertEqual(writes.count, 1); XCTAssertEqual(writes.first?.path, "/api/workspaces/workspace-1/nodes/digest-1/digest/viewed")
        XCTAssertEqual(writes.first?.body, ["generatedAt": 100])
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/commands") })
    }

    func testOlderBackendShowsNoteAndNeverFallsBackToWholeDigestPatch() async {
        let transport = AppContractTransport { _, _ in .json(["explicitCommands": true]) }; defer { transport.close() }
        let model = model(transport)
        let result = await model.markViewed(node: readDigest())
        XCTAssertNil(result); XCTAssertNotNil(model.notice)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testFailedCapabilityReadNeverWritesAndDoesNotBecomeUnsupported() async {
        let transport = AppContractTransport { _, _ in .json(["error": "Offline"], status: 503) }; defer { transport.close() }
        let model = model(transport)
        let result = await model.markViewed(node: readDigest())
        XCTAssertNil(result); XCTAssertNotNil(model.error); XCTAssertNil(model.notice)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testUnknownPostReconcilesGETWithoutResubmitting() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/capabilities") { return .json(["digestReadMarkers": "v1"]) }
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            return .json(readGraph(readDigest(viewedAt: 300)))
        }; defer { transport.close() }
        let model = model(transport)
        let receipt = await model.markViewed(node: readDigest())
        XCTAssertEqual(receipt?.viewedAt, 300); XCTAssertNil(model.error); XCTAssertNil(model.notice)
        _ = await model.markViewed(node: readDigest())
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(transport.requests.last?.path, "/api/workspaces/workspace-1")
    }

    func testUnconfirmedWriteStaysGETOnlyAcrossModelRecreation() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/capabilities") { return .json(["digestReadMarkers": "v1"]) }
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            return .json(readGraph(readDigest()))
        }; defer { transport.close() }
        let first = model(transport)
        _ = await first.markViewed(node: readDigest())
        XCTAssertNotNil(first.notice)
        let reopened = model(transport)
        _ = await reopened.markViewed(node: readDigest())
        XCTAssertNotNil(reopened.notice)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/workspace-1") }.count, 2)
    }

    func testNewerGenerationCannotBeMarkedByOldRequestOrReceipt() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/capabilities") { return .json(["digestReadMarkers": "v1"]) }
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            return .json(readGraph(readDigest(400)))
        }; defer { transport.close() }
        let model = model(transport)
        let result = await model.markViewed(node: readDigest())
        XCTAssertNil(result); XCTAssertNotNil(model.notice)
        let receipt = NativeDigestReadReceipt(workspaceID: "workspace-1", nodeID: "digest-1", generatedAt: 100, viewedAt: 500)
        XCTAssertEqual(receipt.applying(to: readDigest(400)), readDigest(400))
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testMalformedReceiptIsUnknownAndForeignGETCannotConfirmIt() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/capabilities") { return .json(["digestReadMarkers": "v1"]) }
            if request.method == "POST" { return .json(readReceipt().merging(["nodeId": "someone-else"])) }
            return .json(readGraph(readDigest(viewedAt: 300)).merging(["workspace": ["id": "foreign"]]))
        }; defer { transport.close() }
        let model = model(transport)
        let result = await model.markViewed(node: readDigest())
        XCTAssertNil(result)
        XCTAssertNotNil(model.error); XCTAssertNotNil(model.notice)
        _ = await model.markViewed(node: readDigest())
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testExplicitConflictDoesNotRepostOrPretendSuccess() async {
        let transport = AppContractTransport { request, _ in
            request.method == "GET" ? .json(["digestReadMarkers": "v1"]) : .json(["error": "Digest changed"], status: 409)
        }; defer { transport.close() }
        let model = model(transport)
        let result = await model.markViewed(node: readDigest())
        XCTAssertNil(result)
        XCTAssertNotNil(model.error)
        _ = await model.markViewed(node: readDigest())
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertNotNil(model.error)
    }

    func testInvalidOrAlreadyViewedDigestDoesNotIssueRequests() async {
        let transport = AppContractTransport { _, _ in .json(["error": "Unexpected"], status: 500) }; defer { transport.close() }
        let model = model(transport)
        for node in [readDigest().merging(["workspace_id": "foreign"]), readDigest().merging(["deleted_at": 1]), readDigest().merging(["digest": ["generatedAt": 100, "status": "generating"]]), readDigest(100.5)] {
            let result = await model.markViewed(node: node)
            XCTAssertNil(result)
        }
        let read = await model.markViewed(node: readDigest(viewedAt: 200))
        XCTAssertEqual(read?.viewedAt, 200)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testReceiptMergePreservesNewLocalContentOpaqueFieldsAndNewerViewMarker() {
        let receipt = NativeDigestReadReceipt(workspaceID: "workspace-1", nodeID: "digest-1", generatedAt: 100, viewedAt: 200)
        var node = readDigest(viewedAt: 300), content = node["digest"]
        content["content"] = "Latest content"; node["digest"] = .string(content.prettyPrinted)
        let merged = receipt.applying(to: node)
        XCTAssertEqual(merged["digest"].parsedJSON["viewedAt"], 300)
        XCTAssertEqual(merged["digest"].parsedJSON["content"], "Latest content")
        XCTAssertEqual(merged["digest"].parsedJSON["opaque"], content["opaque"])
        XCTAssertNotNil(merged["digest"].optionalString)
    }

    func testConfirmedRefusalAllowsExplicitRetryButNotAutomaticResend() async {
        let transport = AppContractTransport { request, captured in
            if request.method == "GET" { return .json(["digestReadMarkers": "v1"]) }
            return captured.filter { $0.method == "POST" }.count == 1 ? .json(["error": "Digest changed"], status: 409) : .json(readReceipt())
        }; defer { transport.close() }
        let model = model(transport)
        let refused = await model.markViewed(node: readDigest())
        XCTAssertNil(refused); XCTAssertNotNil(model.error)
        XCTAssertEqual(model.action(for: readDigest()), .retry)
        // Viewing again is still automatic: no second marker.
        let automatic = await model.markViewed(node: readDigest())
        XCTAssertNil(automatic)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(model.action(for: readDigest()), .retry)
        let retried = await model.markViewed(node: readDigest(), userInitiated: true)
        XCTAssertEqual(retried?.viewedAt, 200); XCTAssertNil(model.error); XCTAssertNil(model.notice)
        XCTAssertNil(model.action(for: readDigest()))
        let writes = transport.requests.filter { $0.method == "POST" }
        XCTAssertEqual(writes.count, 2)
        XCTAssertTrue(writes.allSatisfy { $0.path == "/api/workspaces/workspace-1/nodes/digest-1/digest/viewed" && $0.body == ["generatedAt": 100] })
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/capabilities") }.count, 1)
        // The confirmed receipt is reused by both paths.
        _ = await model.markViewed(node: readDigest())
        _ = await model.markViewed(node: readDigest(), userInitiated: true)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 2)
    }

    func testPreSendFailureAllowsExplicitRetryAndLeavesNoUnknownState() async {
        let transport = AppContractTransport { request, captured in
            if request.path.hasSuffix("/capabilities") {
                return captured.count == 1 ? .json(["error": "Offline"], status: 503) : .json(["digestReadMarkers": "v1"])
            }
            return .json(readReceipt())
        }; defer { transport.close() }
        let model = model(transport)
        let failed = await model.markViewed(node: readDigest())
        XCTAssertNil(failed); XCTAssertNotNil(model.error); XCTAssertNil(model.notice)
        XCTAssertEqual(model.action(for: readDigest()), .mark)
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
        let retried = await model.markViewed(node: readDigest(), userInitiated: true)
        XCTAssertEqual(retried?.viewedAt, 200); XCTAssertNil(model.error)
        XCTAssertEqual(transport.requests.map(\.method), ["GET", "GET", "POST"])
    }

    func testCachedUnsupportedCapabilityIsReadAgainOnlyOnExplicitAction() async {
        let transport = AppContractTransport { request, captured in
            if request.path.hasSuffix("/capabilities") {
                switch captured.count {
                case 1: return .json(["explicitCommands": true])
                case 2: return .json(["error": "Offline"], status: 503)
                default: return .json(["digestReadMarkers": "v1"])
                }
            }
            return .json(readReceipt())
        }; defer { transport.close() }
        let model = model(transport)
        _ = await model.markViewed(node: readDigest())
        _ = await model.markViewed(node: readDigest())
        XCTAssertNotNil(model.notice); XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(model.action(for: readDigest()), .mark)
        // A failed re-read keeps the cached answer, so viewing stays network-free.
        let unreadable = await model.markViewed(node: readDigest(), userInitiated: true)
        XCTAssertNil(unreadable); XCTAssertNotNil(model.error)
        _ = await model.markViewed(node: readDigest())
        XCTAssertNotNil(model.notice); XCTAssertEqual(transport.requests.count, 2)
        let marked = await model.markViewed(node: readDigest(), userInitiated: true)
        XCTAssertEqual(marked?.viewedAt, 200); XCTAssertNil(model.notice); XCTAssertNil(model.error)
        XCTAssertEqual(transport.requests.map(\.method), ["GET", "GET", "GET", "POST"])
    }

    func testUnknownOutcomeOffersOnlyReadOnlyCheckEvenOnExplicitAction() async {
        let transport = AppContractTransport { request, captured in
            if request.path.hasSuffix("/capabilities") { return .json(["digestReadMarkers": "v1"]) }
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            let checks = captured.filter { $0.path == "/api/workspaces/workspace-1" }.count
            return .json(readGraph(readDigest(viewedAt: checks <= 2 ? 0 : 300)))
        }; defer { transport.close() }
        let first = model(transport)
        let unknown = await first.markViewed(node: readDigest())
        XCTAssertNil(unknown); XCTAssertNotNil(first.notice)
        XCTAssertEqual(first.action(for: readDigest()), .check)
        let reopened = model(transport)
        XCTAssertEqual(reopened.action(for: readDigest()), .check)
        let stillUnknown = await reopened.markViewed(node: readDigest(), userInitiated: true)
        XCTAssertNil(stillUnknown); XCTAssertNotNil(reopened.notice)
        XCTAssertEqual(reopened.action(for: readDigest()), .check)
        let confirmed = await reopened.markViewed(node: readDigest(), userInitiated: true)
        XCTAssertEqual(confirmed?.viewedAt, 300); XCTAssertNil(reopened.notice); XCTAssertNil(reopened.error)
        XCTAssertNil(reopened.action(for: readDigest()))
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/workspaces/workspace-1" }.count, 3)
        XCTAssertEqual(transport.requests.filter { $0.path.hasSuffix("/capabilities") }.count, 1)
    }

    func testStaleGenerationIsNeverResentAfterReconciliationFindsNewerDigest() async {
        let transport = AppContractTransport { request, captured in
            if request.path.hasSuffix("/capabilities") { return .json(["digestReadMarkers": "v1"]) }
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            let checks = captured.filter { $0.path == "/api/workspaces/workspace-1" }.count
            return .json(readGraph(readDigest(checks == 1 ? 100 : 400)))
        }; defer { transport.close() }
        _ = await model(transport).markViewed(node: readDigest())
        let reopened = model(transport)
        XCTAssertEqual(reopened.action(for: readDigest()), .check)
        _ = await reopened.markViewed(node: readDigest(), userInitiated: true)
        XCTAssertNotNil(reopened.notice); XCTAssertNil(reopened.action(for: readDigest()))
        _ = await reopened.markViewed(node: readDigest(), userInitiated: true)
        _ = await reopened.markViewed(node: readDigest())
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(reopened.action(for: readDigest(400)), .mark)
    }

    func testOwnerMatchingIsByteExactForRequestsReceiptsAndReconciliation() async {
        let composed = "caf\u{E9}", decomposed = "cafe\u{301}"
        XCTAssertEqual(composed, decomposed) // Swift String equality alone would conflate them.
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/capabilities") { return .json(["digestReadMarkers": "v1"]) }
            if request.method == "POST" { return .json(readReceipt().merging(["workspaceId": .string(decomposed)])) }
            let node = readDigest(viewedAt: 300).merging(["workspace_id": .string(composed)])
            return .json(["workspace": ["id": .string(decomposed)], "nodes": .array([node])])
        }; defer { transport.close() }
        let model = NativeDigestReadModel(api: transport.api, workspaceID: composed, defaults: defaults)
        let own = readDigest().merging(["workspace_id": .string(composed)])
        let foreign = readDigest().merging(["workspace_id": .string(decomposed)])
        let ignored = await model.markViewed(node: foreign, userInitiated: true)
        XCTAssertNil(ignored); XCTAssertNil(model.action(for: foreign)); XCTAssertTrue(transport.requests.isEmpty)

        // A receipt or saved graph for the other spelling never confirms this marker.
        let unconfirmed = await model.markViewed(node: own)
        XCTAssertNil(unconfirmed); XCTAssertNotNil(model.error)
        XCTAssertEqual(model.action(for: own), .check)
        let checked = await model.markViewed(node: own, userInitiated: true)
        XCTAssertNil(checked)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)

        let receipt = NativeDigestReadReceipt(workspaceID: composed, nodeID: "digest-1", generatedAt: 100, viewedAt: 200)
        XCTAssertNotEqual(receipt, NativeDigestReadReceipt(workspaceID: decomposed, nodeID: "digest-1", generatedAt: 100, viewedAt: 200))
        XCTAssertEqual(receipt.applying(to: foreign), foreign)
        let otherNode = own.merging(["id": .string("digest-\u{E9}")])
        XCTAssertEqual(NativeDigestReadReceipt(workspaceID: composed, nodeID: "digest-e\u{301}", generatedAt: 100, viewedAt: 200).applying(to: otherNode), otherNode)
        XCTAssertEqual(receipt.applying(to: own)["digest"]["viewedAt"], 200)
    }

    func testUnknownStateAndReceiptsAreScopedToServerWorkspaceNodeAndGeneration() async {
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/capabilities") { return .json(["digestReadMarkers": "v1"]) }
            if request.method == "POST" {
                let generation = request.body["generatedAt"].doubleValue
                return generation == 100 ? .failure(.networkConnectionLost) : .json(readReceipt(generation: generation, viewedAt: generation + 1))
            }
            return .json(readGraph(readDigest()))
        }; defer { transport.close() }
        let otherServer = AppContractTransport { _, _ in .json(["error": "Unexpected"], status: 500) }; defer { otherServer.close() }
        let model = model(transport)
        _ = await model.markViewed(node: readDigest())
        XCTAssertEqual(model.action(for: readDigest()), .check)
        // That unknown send covers only its own server, workspace, node and generation.
        XCTAssertEqual(model.action(for: readDigest(200)), .mark)
        XCTAssertEqual(model.action(for: readDigest().merging(["id": "digest-2"])), .mark)
        let otherWorkspace = NativeDigestReadModel(api: transport.api, workspaceID: "workspace-2", defaults: defaults)
        XCTAssertEqual(otherWorkspace.action(for: readDigest().merging(["workspace_id": "workspace-2"])), .mark)
        XCTAssertEqual(NativeDigestReadModel(api: otherServer.api, workspaceID: "workspace-1", defaults: defaults).action(for: readDigest()), .mark)
        let newer = await model.markViewed(node: readDigest(200))
        XCTAssertEqual(newer, NativeDigestReadReceipt(workspaceID: "workspace-1", nodeID: "digest-1", generatedAt: 200, viewedAt: 201))
        // The newer receipt never confirms the older generation.
        XCTAssertEqual(model.action(for: readDigest()), .check)
        XCTAssertEqual(newer?.applying(to: readDigest()), readDigest())
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.map(\.body), [["generatedAt": 100], ["generatedAt": 200]])
        XCTAssertTrue(otherServer.requests.isEmpty)
    }
}
