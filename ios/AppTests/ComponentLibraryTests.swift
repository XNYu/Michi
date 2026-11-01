import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

private func componentFixture(_ changes: [String: JSONValue] = [:]) -> JSONValue {
    JSONValue.object(["id": "pc-1", "ownerUserId": "local-user", "workspaceId": "workspace-1", "name": "test-widget", "description": "A test widget",
        "enabled": true, "activeVersion": 2, "libraryRevision": 4, "revocationEpoch": 1, "deletedAt": .null, "versions": 2,
        "createdAt": 1, "updatedAt": 2, "future": ["kept": true]]).merging(changes)
}
private func componentVersion(_ number: Int = 2, code: String = "root.textContent = 'Hello';", more: [String: JSONValue] = [:]) -> JSONValue {
    JSONValue.object(["componentId": "pc-1", "version": .number(Double(number)), "code": .string(code), "propsSchema": .null,
        "source": ["kind": "user"], "createdAt": 2, "futureVersionField": ["preserved": true]]).merging(more)
}
private func componentLibrary(_ item: JSONValue = componentFixture(), revision: Int = 4) -> JSONValue { ["revision": .number(Double(revision)), "items": .array(item.isNull ? [] : [item])] }

@MainActor final class ComponentLibraryTests: XCTestCase {
    private func journal() -> NativeComponentMutationJournal {
        NativeComponentMutationJournal(directory: FileManager.default.temporaryDirectory.appendingPathComponent("ComponentLibraryTests-" + UUID().uuidString, isDirectory: true))
    }
    private func clean(_ journal: NativeComponentMutationJournal) { if let directory = journal.directory { try? FileManager.default.removeItem(at: directory) } }
    private func readReply(_ request: AppContractRequest, library: JSONValue = componentLibrary(), version: JSONValue = componentVersion()) -> AppContractResponse {
        if request.path == "/api/workspaces/workspace-1" { return .json(appContractGraph().raw) }
        if request.path == "/api/workspaces/workspace-1/components" { return .json(library) }
        if request.path.hasSuffix("/references") { return .json(["items": []]) }
        return .json(version)
    }

    func testHydrationReadsScopedLibraryVersionAndReferencesWithoutWriting() async {
        let journal = journal(); defer { clean(journal) }
        let usage: JSONValue = ["componentId": "pc-1", "workspaceId": "workspace-1", "kind": "page_block", "pageId": "page-1", "blockId": "block-1", "pinnedVersion": 1, "protected": true, "hostRevision": 7]
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/references") { return .json(["items": [usage]]) }
            return self.readReply(request)
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        XCTAssertFalse(model.canMutate)
        await model.refresh(); await model.select(componentID: "pc-1", version: 1)
        // Deliberately mismatched version fixture is rejected, not silently replaced by active v2.
        XCTAssertEqual(model.selectedVersion, 1); XCTAssertFalse(model.draftReady); XCTAssertTrue(model.version.isNull)
        await model.select(componentID: "pc-1", version: 2, discardDraft: true)
        XCTAssertTrue(model.hasLoaded); XCTAssertTrue(model.draftReady); XCTAssertEqual(model.revision, 4)
        XCTAssertEqual(model.references, [usage]); XCTAssertEqual(model.items[0]["future"], ["kept": true])
        XCTAssertEqual(model.version["futureVersionField"], ["preserved": true])
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
        XCTAssertEqual(transport.requests.last?.query, ["workspaceId": "workspace-1"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.directory!.path))
    }

    func testFailedRefreshKeepsDirtySourceAndBlocksWritesFromInvalidSnapshot() async {
        let journal = journal(); defer { clean(journal) }
        var libraryReads = 0
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/components") { libraryReads += 1; return .json(libraryReads == 1 ? componentLibrary() : componentLibrary(componentFixture(["ownerUserId": "foreign"]), revision: 5)) }
            return self.readReply(request)
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); await model.select(componentID: "pc-1")
        model.draft.code = "unsaved source"; await model.refresh()
        XCTAssertEqual(model.items[0]["ownerUserId"], "local-user"); XCTAssertEqual(model.revision, 4)
        XCTAssertEqual(model.draft.code, "unsaved source"); XCTAssertTrue(model.dirty); XCTAssertFalse(model.canMutate)
        let saved = await model.save(); XCTAssertFalse(saved)
        XCTAssertFalse(transport.requests.contains { $0.method == "POST" })
    }

    func testCreateSendsExactNameInputAndServerCreatesUserAttribution() async {
        let journal = journal(); defer { clean(journal) }
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" {
                XCTAssertEqual(request.body, ["expectedLibraryRevision": 0, "input": ["name": "new-widget", "description": "New widget", "code": "source only", "propsSchema": ["type": "object"]]])
                return .json(["revision": 1, "component": componentFixture(["id": "pc-new", "name": "new-widget", "description": "New widget", "activeVersion": 1, "versions": 1, "libraryRevision": 1]),
                    "version": componentVersion(1, code: "source only", more: ["componentId": "pc-new", "propsSchema": ["type": "object"]])], status: 201)
            }
            return self.readReply(request, library: componentLibrary(.null, revision: 0))
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); model.draft = .init(name: "new-widget", description: " New widget ", code: "source only", propsSchemaText: "{\"type\":\"object\"}")
        let saved = await model.save()
        XCTAssertTrue(saved); XCTAssertEqual(model.selectedID, "pc-new"); XCTAssertEqual(model.selectedVersion, 1); XCTAssertEqual(model.revision, 1)
        XCTAssertFalse(model.dirty); XCTAssertFalse(model.outcomeUnknown)
        let duplicate = await model.save(); XCTAssertFalse(duplicate)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertFalse(transport.requests.contains { $0.path.contains("capabilit") || $0.path.contains("sandbox") })
    }

    func testSameNameAppendsImmutableVersionAndPreservesEditsDuringSave() async {
        let journal = journal(); defer { clean(journal) }
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" {
                XCTAssertEqual(request.body["expectedLibraryRevision"], 4)
                return .delayedJSON(["revision": 5, "component": componentFixture(["activeVersion": 3, "versions": 3, "libraryRevision": 5, "revocationEpoch": 2]), "version": componentVersion(3, code: "submitted")], status: 201, delay: 0.15)
            }
            return self.readReply(request)
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); await model.select(componentID: "pc-1"); model.draft.code = "submitted"
        let task = Task { await model.save() }
        let deadline = Date().addingTimeInterval(2)
        while !transport.requests.contains(where: { $0.method == "POST" }) && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        model.draft.code = "edited while saving"
        let saved = await task.value
        XCTAssertTrue(saved); XCTAssertEqual(model.version["code"], "submitted"); XCTAssertEqual(model.selectedVersion, 3)
        XCTAssertEqual(model.draft.code, "edited while saving"); XCTAssertTrue(model.dirty)
    }

    func testConflictRefreshesRevisionKeepsDraftAndNeverAutomaticallyRetries() async {
        let journal = journal(); defer { clean(journal) }
        var posts = 0
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" {
                posts += 1
                if posts == 1 { return .json(["error": ["code": "stale_revision", "message": "changed"]], status: 409) }
                XCTAssertEqual(request.body["expectedLibraryRevision"], 5)
                return .json(["revision": 6, "component": componentFixture(["activeVersion": 3, "versions": 3, "libraryRevision": 6, "revocationEpoch": 2]), "version": componentVersion(3, code: "kept")], status: 201)
            }
            return self.readReply(request, library: componentLibrary(revision: posts == 0 ? 4 : 5))
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); await model.select(componentID: "pc-1"); model.draft.code = "kept"
        let first = await model.save()
        XCTAssertFalse(first); XCTAssertEqual(posts, 1); XCTAssertEqual(model.revision, 5); XCTAssertEqual(model.draft.code, "kept")
        XCTAssertFalse(model.outcomeUnknown); XCTAssertTrue(model.error?.contains("changed") == true)
        let second = await model.save(); XCTAssertTrue(second); XCTAssertEqual(posts, 2)
    }

    func testAllActionsUseLatestLibraryRevisionAndRequireConfirmation() async {
        let journal = journal(); defer { clean(journal) }
        var current = componentFixture(), revision = 4
        let transport = AppContractTransport { request, _ in
            if request.method == "GET" { return self.readReply(request, library: componentLibrary(current, revision: revision)) }
            XCTAssertEqual(request.body["expectedLibraryRevision"], .number(Double(revision)))
            XCTAssertEqual(request.body["workspaceId"], "workspace-1")
            revision += 1; current["libraryRevision"] = .number(Double(revision))
            current["revocationEpoch"] = .number(Double(current["revocationEpoch"].intValue + 1))
            if request.path.hasSuffix("/disable") { current["enabled"] = false }
            if request.path.hasSuffix("/enable") { current["enabled"] = true }
            if request.path.hasSuffix("/activate") || request.path.hasSuffix("/rollback") { current["activeVersion"] = request.body["version"] }
            if request.method == "DELETE" { current["enabled"] = false; current["deletedAt"] = 100 }
            return .json(current)
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal); await model.refresh()
        let unconfirmed = await model.perform(.disable, componentID: "pc-1"); XCTAssertFalse(unconfirmed)
        for (action, version) in [(NativeComponentAction.disable, nil), (.enable, nil), (.activate, 1), (.rollback, 2), (.delete, nil)] as [(NativeComponentAction, Int?)] {
            let changed = await model.perform(action, componentID: "pc-1", version: version, confirmed: true)
            XCTAssertTrue(changed, action.rawValue)
        }
        XCTAssertEqual(model.revision, 9); XCTAssertTrue(model.items.isEmpty)
        XCTAssertEqual(transport.requests.filter { $0.method != "GET" }.count, 5)
    }

    func testArchivedWorkspaceCanReadButCannotMutateAndPreflightDetectsNewArchive() async {
        let journal = journal(); defer { clean(journal) }
        var workspaceReads = 0
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/workspaces/workspace-1" { workspaceReads += 1; return .json(appContractGraph(workspaceArchived: workspaceReads > 1).raw) }
            return self.readReply(request)
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal); await model.refresh()
        let changed = await model.perform(.disable, componentID: "pc-1", confirmed: true)
        XCTAssertFalse(changed); XCTAssertTrue(model.readOnly); XCTAssertFalse(model.outcomeUnknown)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
        let readOnlyModel = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", readOnly: true, journal: journal)
        await readOnlyModel.refresh(); XCTAssertTrue(readOnlyModel.hasLoaded); XCTAssertFalse(readOnlyModel.canMutate)
    }

    func testMalformedMutationReplyBlocksFurtherWritesWithoutClaimingSuccess() async {
        let journal = journal(); defer { clean(journal) }
        let transport = AppContractTransport { request, _ in request.method == "POST" ? .json(["ok": true]) : self.readReply(request) }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal); await model.refresh()
        let changed = await model.perform(.disable, componentID: "pc-1", confirmed: true)
        XCTAssertFalse(changed); XCTAssertTrue(model.outcomeUnknown); XCTAssertEqual(model.items[0]["enabled"], true); XCTAssertEqual(model.revision, 4)
        let again = await model.perform(.disable, componentID: "pc-1", confirmed: true); XCTAssertFalse(again)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testUnknownSaveSurvivesModelRecreationAndReconcilesMatchingImmutableVersion() async {
        let journal = journal(); defer { clean(journal) }
        var committed = false
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            return self.readReply(request,
                library: committed ? componentLibrary(componentFixture(["activeVersion": 3, "versions": 3, "libraryRevision": 5]), revision: 5) : componentLibrary(),
                version: committed ? componentVersion(3, code: "unconfirmed source") : componentVersion())
        }; defer { transport.close() }
        let first = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await first.refresh(); await first.select(componentID: "pc-1"); first.draft.code = "unconfirmed source"
        let saved = await first.save(); XCTAssertFalse(saved); XCTAssertTrue(first.outcomeUnknown)
        let second = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        XCTAssertTrue(second.outcomeUnknown); XCTAssertEqual(second.draft.code, "unconfirmed source")
        let unresolved = await second.reconcilePending(); XCTAssertFalse(unresolved); XCTAssertTrue(second.outcomeUnknown)
        let blocked = await second.save(); XCTAssertFalse(blocked)
        committed = true
        let reconciled = await second.reconcilePending(); XCTAssertTrue(reconciled); XCTAssertFalse(second.outcomeUnknown)
        XCTAssertEqual(second.selectedVersion, 3); XCTAssertEqual(second.version["code"], "unconfirmed source")
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testReconciliationReleasesSupersededSaveWithoutAcceptingDifferentSource() async {
        let journal = journal(); defer { clean(journal) }
        var submitted = false
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { submitted = true; return .failure(.timedOut) }
            return self.readReply(request,
                library: submitted ? componentLibrary(componentFixture(["activeVersion": 3, "versions": 3, "libraryRevision": 5]), revision: 5) : componentLibrary(),
                version: submitted ? componentVersion(3, code: "another writer") : componentVersion())
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); await model.select(componentID: "pc-1"); model.draft.code = "my source"; await model.save()
        let reconciled = await model.reconcilePending()
        XCTAssertTrue(reconciled); XCTAssertFalse(model.outcomeUnknown); XCTAssertEqual(model.draft.code, "my source")
        XCTAssertTrue(model.notice?.contains("superseded") == true)
        XCTAssertEqual(model.version["code"], componentVersion()["code"])
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testUnknownDeleteReconcilesAbsenceOnlyAfterLibraryAdvances() async {
        let journal = journal(); defer { clean(journal) }
        var stage = 0
        let transport = AppContractTransport { request, _ in
            if request.method == "DELETE" { return .failure(.networkConnectionLost) }
            return self.readReply(request, library: stage == 0 ? componentLibrary() : componentLibrary(.null, revision: stage == 1 ? 4 : 5))
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal); await model.refresh()
        await model.perform(.delete, componentID: "pc-1", confirmed: true)
        stage = 1; let early = await model.reconcilePending(); XCTAssertFalse(early)
        stage = 2; let finished = await model.reconcilePending(); XCTAssertTrue(finished)
        XCTAssertFalse(model.outcomeUnknown); XCTAssertEqual(transport.requests.filter { $0.method == "DELETE" }.count, 1)
    }

    func testSharedJournalPreventsTwoControllersSubmittingSameRevision() async {
        let journal = journal(); defer { clean(journal) }
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .delayedJSON(componentFixture(["enabled": false, "libraryRevision": 5, "revocationEpoch": 2]), status: 200, delay: 0.15) }
            return self.readReply(request)
        }; defer { transport.close() }
        let first = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        let second = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await first.refresh(); await second.refresh()
        let task = Task { await first.perform(.disable, componentID: "pc-1", confirmed: true) }
        let deadline = Date().addingTimeInterval(2)
        while !transport.requests.contains(where: { $0.method == "POST" }) && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        let blocked = await second.perform(.disable, componentID: "pc-1", confirmed: true)
        let finished = await task.value
        XCTAssertFalse(blocked); XCTAssertTrue(finished); XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testUnavailableJournalBlocksSubmissionBeforePost() async throws {
        let journal = journal(); defer { clean(journal) }
        try Data("not a directory".utf8).write(to: journal.directory!)
        let transport = AppContractTransport { request, _ in self.readReply(request) }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal); await model.refresh()
        let changed = await model.perform(.disable, componentID: "pc-1", confirmed: true)
        XCTAssertFalse(changed); XCTAssertNotNil(model.error); XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testCorruptPendingRecordIsNotDiscardedToPermitAnotherMutation() async throws {
        let journal = journal(); defer { clean(journal) }
        let transport = AppContractTransport { request, _ in self.readReply(request) }; defer { transport.close() }
        let scope: JSONValue = ["connection": .string(transport.api.baseURL.absoluteString), "workspaceID": "workspace-1", "credentialIdentity": .string(transport.api.credentialIdentityFingerprint)]
        try FileManager.default.createDirectory(at: journal.directory!, withIntermediateDirectories: true)
        let url = try journal.fileURL(scope: scope)
        try Data("not valid JSON".utf8).write(to: url)
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh()
        XCTAssertTrue(model.outcomeUnknown); XCTAssertNotNil(model.recoveryIssue); XCTAssertFalse(model.canMutate)
        let changed = await model.perform(.disable, componentID: "pc-1", confirmed: true)
        XCTAssertFalse(changed); XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "not valid JSON")
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testDeletedWorkspaceCannotHydrateWritableLibrary() async {
        let journal = journal(); defer { clean(journal) }
        var graph = appContractGraph().raw; graph["workspace"]["deleted_at"] = 10
        let snapshot = graph
        let transport = AppContractTransport { _, _ in .json(snapshot) }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        let loaded = await model.refresh()
        XCTAssertFalse(loaded); XCTAssertFalse(model.hasLoaded); XCTAssertFalse(model.canMutate)
        XCTAssertEqual(transport.requests.map(\.path), ["/api/workspaces/workspace-1"])
    }

    func testDisabledVersionIsNotReplacedWithFabricatedSource() async {
        let journal = journal(); defer { clean(journal) }
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/components/pc-1" { return .json(["error": ["code": "not_found", "message": "Component is disabled"]], status: 404) }
            return self.readReply(request, library: componentLibrary(componentFixture(["enabled": false])))
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); let selected = await model.select(componentID: "pc-1", version: 1)
        XCTAssertFalse(selected); XCTAssertEqual(model.selectedVersion, 1); XCTAssertFalse(model.draftReady); XCTAssertTrue(model.version.isNull)
        let saved = await model.save(); XCTAssertFalse(saved); XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testValidationRejectsInvalidDefinitionsWithoutDroppingUnknownSchema() throws {
        let valid = NativeComponentDraft(name: "my-widget", description: "A widget", code: "source", propsSchemaText: "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"}},\"additionalProperties\":false}")
        XCTAssertNoThrow(try valid.input())
        var draft = valid; draft.name = "Upper Case"; XCTAssertThrowsError(try draft.input())
        draft = valid; draft.code = String(repeating: "x", count: 200_001); XCTAssertThrowsError(try draft.input())
        draft = valid; draft.propsSchemaText = "{\"type\":\"object\",\"futureConstraint\":true}"; XCTAssertThrowsError(try draft.input())
        XCTAssertTrue(draft.propsSchemaText.contains("futureConstraint"))
        draft.propsSchemaText = "{\"type\":\"array\"}"; XCTAssertThrowsError(try draft.input())
        draft.propsSchemaText = "{\"required\":[\"title\",\"title\"]}"; XCTAssertThrowsError(try draft.input())
        draft.propsSchemaText = "not JSON"; XCTAssertThrowsError(try draft.input())
    }

    func testForeignReferencesAndInvalidVersionIdentitiesAreRejected() {
        XCTAssertThrowsError(try NativeComponentContract.references(["items": [["componentId": "pc-foreign", "workspaceId": "workspace-1", "kind": "page_block", "pageId": "p", "blockId": "b", "protected": false, "hostRevision": 1]]], workspaceID: "workspace-1", componentID: "pc-1"))
        XCTAssertThrowsError(try NativeComponentContract.version(componentVersion(more: ["componentId": "pc-foreign"]), componentID: "pc-1", number: 2))
        XCTAssertThrowsError(try NativeComponentContract.component(componentFixture(["workspaceId": "foreign"]), workspaceID: "workspace-1", owner: "local-user"))
        XCTAssertThrowsError(try NativeComponentContract.component(componentFixture(["libraryRevision": .number(4.5)]), workspaceID: "workspace-1", owner: "local-user"))
    }

    func testSelectedComponentCannotBeRenamedToAnotherOrNewNameBySave() async {
        let journal = journal(); defer { clean(journal) }
        let library: JSONValue = ["revision": 4, "items": [componentFixture(), componentFixture(["id": "pc-2", "name": "other-widget"])]]
        let transport = AppContractTransport { request, _ in self.readReply(request, library: library) }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); await model.select(componentID: "pc-1")
        for name in ["other-widget", "unused-widget"] {
            model.draft.name = name; model.draft.code = "kept draft"
            let saved = await model.save()
            XCTAssertFalse(saved); XCTAssertEqual(model.selectedID, "pc-1"); XCTAssertEqual(model.draft.name, name)
            XCTAssertEqual(model.draft.code, "kept draft"); XCTAssertTrue(model.error?.contains("keeps its name") == true)
        }
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
        XCTAssertFalse(model.outcomeUnknown)
    }

    func testNewComponentNameCollisionRequiresSelectingExistingComponent() async {
        let journal = journal(); defer { clean(journal) }
        let transport = AppContractTransport { request, _ in self.readReply(request) }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh()
        model.draft = .init(name: "test-widget", description: "New draft", code: "do not replace the existing component")
        let saved = await model.save()
        XCTAssertFalse(saved); XCTAssertNil(model.selectedID); XCTAssertEqual(model.items[0]["versions"], 2)
        XCTAssertEqual(model.draft.code, "do not replace the existing component")
        XCTAssertTrue(model.error?.contains("Select it explicitly") == true)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func testDisabledSource404CannotKeepAnAlreadyFencedSavePending() async {
        let journal = journal(); defer { clean(journal) }
        var submitted = false
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { submitted = true; return .failure(.networkConnectionLost) }
            if submitted && request.path == "/api/components/pc-1" { return .json(["error": ["code": "not_found", "message": "Component is disabled"]], status: 404) }
            let library = submitted ? componentLibrary(componentFixture(["activeVersion": 3, "versions": 3, "enabled": false, "libraryRevision": 6]), revision: 6) : componentLibrary()
            return self.readReply(request, library: library)
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); await model.select(componentID: "pc-1"); model.draft.code = "saved or superseded source"; await model.save()
        let resolved = await model.reconcilePending()
        XCTAssertTrue(resolved); XCTAssertFalse(model.outcomeUnknown)
        XCTAssertEqual(model.draft.code, "saved or superseded source"); XCTAssertTrue(model.dirty)
        XCTAssertTrue(model.notice?.contains("superseded") == true)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testDisableSupersededByEnableClearsPendingWithoutRepeatingDisable() async {
        let journal = journal(); defer { clean(journal) }
        var submitted = false
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { submitted = true; return .failure(.timedOut) }
            return self.readReply(request, library: submitted ? componentLibrary(componentFixture(["enabled": true, "libraryRevision": 6]), revision: 6) : componentLibrary())
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); await model.perform(.disable, componentID: "pc-1", confirmed: true)
        let resolved = await model.reconcilePending()
        XCTAssertTrue(resolved); XCTAssertFalse(model.outcomeUnknown); XCTAssertEqual(model.items[0]["enabled"], true)
        XCTAssertTrue(model.notice?.contains("superseded") == true)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testExplicitReviewedClearRequiresFreshAdvancedRevision() async {
        let journal = journal(); defer { clean(journal) }
        var advanced = false
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            return self.readReply(request, library: componentLibrary(revision: advanced ? 5 : 4))
        }; defer { transport.close() }
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        await model.refresh(); await model.perform(.disable, componentID: "pc-1", confirmed: true)
        let count = transport.requests.count
        let unconfirmed = await model.clearPendingAfterReview(confirmed: false)
        XCTAssertFalse(unconfirmed); XCTAssertEqual(transport.requests.count, count)
        let unchanged = await model.clearPendingAfterReview(confirmed: true)
        XCTAssertFalse(unchanged); XCTAssertTrue(model.outcomeUnknown)
        XCTAssertTrue(model.notice?.contains("delayed request could still commit") == true)
        advanced = true
        let cleared = await model.clearPendingAfterReview(confirmed: true)
        XCTAssertTrue(cleared); XCTAssertFalse(model.outcomeUnknown)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testSameServerDifferentSyntheticCredentialsHaveSeparatePendingRecords() async {
        let journal = journal(); defer { clean(journal) }
        var owner = "owner-a"
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.networkConnectionLost) }
            return self.readReply(request, library: componentLibrary(componentFixture(["ownerUserId": .string(owner)])))
        }; defer { transport.close() }
        let apiA = MichiAPI(baseURL: transport.baseURL, bearerToken: "synthetic-component-test-a", session: transport.session)
        let apiAAgain = MichiAPI(baseURL: transport.baseURL, bearerToken: "  synthetic-component-test-a  ", session: transport.session)
        let apiB = MichiAPI(baseURL: transport.baseURL, bearerToken: "synthetic-component-test-b", session: transport.session)
        XCTAssertEqual(apiA.credentialIdentityFingerprint, apiAAgain.credentialIdentityFingerprint)
        XCTAssertNotEqual(apiA.credentialIdentityFingerprint, apiB.credentialIdentityFingerprint)
        let first = NativeComponentLibraryModel(api: apiA, workspaceID: "workspace-1", journal: journal)
        await first.refresh(); await first.select(componentID: "pc-1"); first.draft.code = "private draft belonging to A"; await first.save()
        XCTAssertTrue(first.outcomeUnknown)
        owner = "owner-b"
        let other = NativeComponentLibraryModel(api: apiB, workspaceID: "workspace-1", journal: journal)
        XCTAssertFalse(other.outcomeUnknown); XCTAssertTrue(other.draft.code.isEmpty)
        let loaded = await other.refresh()
        XCTAssertTrue(loaded); XCTAssertEqual(other.items[0]["ownerUserId"], "owner-b"); XCTAssertTrue(other.canMutate)
        let sameIdentity = NativeComponentLibraryModel(api: apiAAgain, workspaceID: "workspace-1", journal: journal)
        XCTAssertTrue(sameIdentity.outcomeUnknown); XCTAssertEqual(sameIdentity.draft.code, "private draft belonging to A")
    }

    func testCurrentLibraryOwnerIsNeverInferredFromPendingRecord() async throws {
        let journal = journal(); defer { clean(journal) }
        let transport = AppContractTransport { request, _ in self.readReply(request, library: componentLibrary(componentFixture(["ownerUserId": "current-owner"]), revision: 5)) }; defer { transport.close() }
        let scope: JSONValue = ["connection": .string(transport.api.baseURL.absoluteString), "workspaceID": "workspace-1", "credentialIdentity": .string(transport.api.credentialIdentityFingerprint)]
        let pending: JSONValue = ["requestID": "stale-owner-operation", "kind": "disable", "componentID": "pc-1", "expectedLibraryRevision": 4, "ownerUserID": "previous-owner"]
        try journal.reserve(pending, scope: scope)
        let model = NativeComponentLibraryModel(api: transport.api, workspaceID: "workspace-1", journal: journal)
        let loaded = await model.refresh()
        XCTAssertTrue(loaded); XCTAssertEqual(model.items[0]["ownerUserId"], "current-owner")
        XCTAssertNil(model.error); XCTAssertTrue(model.outcomeUnknown)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }
}
