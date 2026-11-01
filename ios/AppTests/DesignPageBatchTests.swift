import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class DesignPageBatchTests: XCTestCase {
    func testDirectoryGroupsByByteExactWorkspaceIdentityNotName() {
        let composed = "é"
        let decomposed = "e\u{0301}"
        XCTAssertEqual(composed, decomposed)
        XCTAssertFalse(composed.utf8.elementsEqual(decomposed.utf8))

        let spaces: [JSONValue] = [
            ["id": "page-a", "workspaceId": "ws-1", "workspaceName": "Notes", "title": "Alpha"],
            ["id": "page-b", "workspaceId": "ws-2", "workspaceName": "Notes", "title": "Beta"],
            ["id": "page-c", "workspaceId": .string(composed), "workspaceName": "Accent", "title": "NFC"],
            ["id": "page-d", "workspaceId": .string(decomposed), "workspaceName": "Accent", "title": "NFD"],
            ["id": "page-e", "workspaceId": "ws-1", "workspaceName": "Notes renamed", "title": "Gamma"],
        ]
        let groups = DesignPageBatch.directoryGroups(spaces)
        XCTAssertEqual(groups.count, 4)
        XCTAssertEqual(groups[0].label, "Notes")
        XCTAssertEqual(groups[0].pages.map(\.id), ["page-a", "page-e"])
        XCTAssertEqual(groups[1].label, "Notes")
        XCTAssertEqual(groups[1].pages.map(\.id), ["page-b"])
        XCTAssertNotEqual(groups[0].id, groups[1].id)
        XCTAssertNotEqual(groups[2].id, groups[3].id)
        XCTAssertEqual(Set(groups.map(\.id)).count, 4)
    }

    func testPageAndDatabaseIdentitiesKeepWorkspacePair() {
        let left = DesignPagesPageIdentity(pageId: "page-1", workspaceId: "ws-a")
        let right = DesignPagesPageIdentity(pageId: "page-1", workspaceId: "ws-b")
        XCTAssertNotEqual(left, right)
        let dbLeft = DesignPagesDatabaseIdentity(databaseId: "db-1", workspaceId: "ws-a")
        let dbRight = DesignPagesDatabaseIdentity(databaseId: "db-1", workspaceId: "ws-b")
        XCTAssertNotEqual(dbLeft, dbRight)
        XCTAssertEqual(
            JSONValue.object(["id": "page-1", "workspaceId": "ws-a"]).designPagesPageIdentity,
            left
        )
    }

    func testHomeIdentityIgnoresRevisionAndUsesExactPageWorkspacePair() {
        let first = DesignPagesHomeIdentity(pageId: "page-home", workspaceId: "ws-1")
        let refresh = DesignPagesHomeIdentity(pageId: "page-home", workspaceId: "ws-1")
        let moved = DesignPagesHomeIdentity(pageId: "page-home", workspaceId: "ws-2")
        let replaced = DesignPagesHomeIdentity(pageId: "page-other", workspaceId: "ws-1")
        XCTAssertEqual(first, refresh)
        XCTAssertNotEqual(first, moved)
        XCTAssertNotEqual(first, replaced)
        let composed = DesignPagesHomeIdentity(pageId: "é", workspaceId: "ws")
        let decomposed = DesignPagesHomeIdentity(pageId: "e\u{0301}", workspaceId: "ws")
        XCTAssertNotEqual(composed, decomposed)
    }

    func testRejectAllSnapshotsEveryPendingIDAndAcceptUsesSelectionOnly() {
        let pending = [change("c1"), change("c2"), change("c3")]
        XCTAssertEqual(
            DesignPageBatch.intendedIDs(kind: .rejectAll, pending: pending, selected: opaque("c2")),
            ["c1", "c2", "c3"]
        )
        XCTAssertEqual(
            DesignPageBatch.intendedIDs(kind: .acceptSelected, pending: pending, selected: opaque("c2", "missing")),
            ["c2"]
        )
        XCTAssertEqual(
            DesignPageBatch.intendedIDs(kind: .acceptSelected, pending: pending, selected: []),
            []
        )
        XCTAssertEqual(
            DesignPageBatch.intendedIDs(kind: .rejectAll, pending: pending + [change("c4", state: "accepted")], selected: []),
            ["c1", "c2", "c3"]
        )
    }

    func testAcceptSelectedKeepsComposedAndDecomposedIDsIndependently() {
        let composed = "é"
        let decomposed = "e\u{0301}"
        XCTAssertEqual(composed, decomposed)
        XCTAssertFalse(composed.utf8.elementsEqual(decomposed.utf8))
        XCTAssertEqual(Set([composed, decomposed]).count, 1)
        XCTAssertEqual(opaque(composed, decomposed).count, 2)

        let pending = [change(composed), change(decomposed), change("plain")]
        XCTAssertEqual(
            DesignPageBatch.intendedIDs(kind: .acceptSelected, pending: pending, selected: opaque(composed)).map(DesignPageOpaqueID.init(raw:)),
            [DesignPageOpaqueID(raw: composed)]
        )
        XCTAssertEqual(
            DesignPageBatch.intendedIDs(kind: .acceptSelected, pending: pending, selected: opaque(decomposed)).map(DesignPageOpaqueID.init(raw:)),
            [DesignPageOpaqueID(raw: decomposed)]
        )
        XCTAssertEqual(
            DesignPageBatch.intendedIDs(kind: .acceptSelected, pending: pending, selected: opaque(composed, decomposed)).map(DesignPageOpaqueID.init(raw:)),
            [DesignPageOpaqueID(raw: composed), DesignPageOpaqueID(raw: decomposed)]
        )
    }

    func testBatchNextReResolvesPendingAndStopsWhenMissingOrNotPending() {
        let pending = [change("c1"), change("c2")]
        var session = DesignPageBatchSession(kind: .rejectAll, intendedIDs: ["c1", "c2"])
        guard case .perform(let first) = DesignPageBatch.next(session: session, pending: pending) else {
            return XCTFail("expected first write")
        }
        XCTAssertEqual(first.id, "c1")
        session.index += 1
        XCTAssertEqual(DesignPageBatch.next(session: session, pending: [change("c2")]), .perform(change("c2")))
        XCTAssertEqual(DesignPageBatch.next(session: session, pending: [change("c1")]), .unavailable)
        XCTAssertEqual(DesignPageBatch.next(session: session, pending: [change("c2", state: "accepted")]), .unavailable)
        session.index += 1
        XCTAssertEqual(DesignPageBatch.next(session: session, pending: pending), .finished)
    }

    func testSequentialRunStopsLaterWritesAfterFailureCancellationOrMissingItem() async {
        let pending = [change("c1"), change("c2"), change("c3")]

        var failed: [String] = []
        var failSession = DesignPageBatchSession(kind: .rejectAll, intendedIDs: ["c1", "c2", "c3"])
        await DesignPageBatch.run(session: &failSession, isCancelled: { false }, pending: { pending }) { change in
            failed.append(change.id)
            return false
        }
        XCTAssertEqual(failed, ["c1"])
        XCTAssertEqual(failSession.index, 0)

        var cancelledWrites: [String] = []
        var cancelled = false
        var cancelSession = DesignPageBatchSession(kind: .acceptSelected, intendedIDs: ["c1", "c2", "c3"])
        await DesignPageBatch.run(session: &cancelSession, isCancelled: { cancelled }, pending: { pending }) { change in
            cancelledWrites.append(change.id)
            cancelled = true
            return true
        }
        XCTAssertEqual(cancelledWrites, ["c1"])
        XCTAssertEqual(cancelSession.index, 0)

        var afterGap: [String] = []
        var gapSession = DesignPageBatchSession(kind: .rejectAll, intendedIDs: ["c1", "c2", "c3"])
        await DesignPageBatch.run(
            session: &gapSession,
            isCancelled: { false },
            pending: { [change("c1"), change("c3")] }
        ) { change in
            afterGap.append(change.id)
            return true
        }
        XCTAssertEqual(afterGap, ["c1"])
        XCTAssertEqual(gapSession.index, 1)
    }

    func testHomePageIDReadsHomePageIdNotPageId() {
        let item: JSONValue = ["workspaceId": "ws-1", "pageId": "stale", "homePageId": "page-home"]
        XCTAssertEqual(DesignPageBatch.homePageID(item), "page-home")
        XCTAssertEqual(DesignPageBatch.homePageID(["pageId": "stale"]), "")
    }

    private func change(_ id: String, state: String = "pending") -> JSONValue {
        ["id": .string(id), "proposalState": .string(state)]
    }

    private func opaque(_ values: String...) -> Set<DesignPageOpaqueID> {
        Set(values.map(DesignPageOpaqueID.init(raw:)))
    }
}
