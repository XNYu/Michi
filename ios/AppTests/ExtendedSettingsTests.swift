import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor
final class ExtendedSettingsTests: XCTestCase {
    private var storedPermissions: JSONValue {
        [
            "global": false,
            "mode": "ask",
            "opaquePolicy": ["nested": true, "list": ["keep", 2]],
            "futureFlag": .null,
        ]
    }

    private var followSettings: JSONValue {
        [
            "runtimeId": .null, "providerId": .null, "modelId": .null, "reasoning": .null,
            "writeWorkspaceHomes": .null, "maintainSpacesHome": .null, "firstRunDays": .null,
        ]
    }

    private var metaInfo: JSONValue {
        [
            "settings": followSettings,
            "resolved": ["runtimeId": "claude", "providerId": .null, "modelId": "claude-opus-5.5", "reasoning": "high", "followsGlobal": true],
            "availability": ["available": true, "reason": .null],
            "guard": ["maintenance": .null, "chat": .null],
            "usageToday": .null,
        ]
    }

    private var validWorkspace: JSONValue {
        [
            "workspace": ["id": "ws-1", "name": "Notes", "cwd": "/tmp/notes"],
            "trees": [["id": "tree-1"]],
            "nodes": [["id": "node-1"]],
            "edges": [],
            "messages": [["id": "msg-1"], ["id": "msg-2"]],
            "contexts": [],
            "localOnlyExtra": ["kept": true],
        ]
    }

    private var validBackup: JSONValue {
        [
            "app": "michi",
            "version": 1,
            "exportedAt": 1_730_000_000_000,
            "workspaces": [validWorkspace],
            "legacyNote": "retain-me",
        ]
    }

    func testPermissionBodyKeepsUnrelatedFieldsAndApproveForMeAbsence() async throws {
        let draft = FeaturePermissionDraft(global: true, mode: "ask", approveForMe: false)
        let body = try featurePermissionSettingsBody(stored: storedPermissions, draft: draft)
        XCTAssertEqual(body["global"], true)
        XCTAssertEqual(body["mode"], "ask")
        XCTAssertEqual(body["opaquePolicy"], storedPermissions["opaquePolicy"])
        XCTAssertEqual(body["futureFlag"], .null)
        XCTAssertNil(body.objectValue["approveForMe"])
    }

    func testPermissionBodyWritesApproveForMeOnlyWhenChosen() async throws {
        let enabled = try featurePermissionSettingsBody(
            stored: storedPermissions,
            draft: FeaturePermissionDraft(global: true, mode: "ask", approveForMe: true)
        )
        XCTAssertEqual(enabled["approveForMe"], true)
        XCTAssertEqual(enabled["opaquePolicy"], storedPermissions["opaquePolicy"])

        let storedFalse = storedPermissions.merging(["approveForMe": false])
        let preserved = try featurePermissionSettingsBody(
            stored: storedFalse,
            draft: FeaturePermissionDraft(global: false, mode: "ask", approveForMe: false)
        )
        XCTAssertEqual(preserved["approveForMe"], false)
        XCTAssertEqual(preserved["futureFlag"], .null)

        let cleared = try featurePermissionSettingsBody(
            stored: storedPermissions.merging(["approveForMe": true]),
            draft: FeaturePermissionDraft(global: true, mode: "trust", approveForMe: false)
        )
        XCTAssertEqual(cleared["mode"], "trust")
        XCTAssertNil(cleared.objectValue["approveForMe"])
        XCTAssertEqual(cleared["opaquePolicy"], storedPermissions["opaquePolicy"])
    }

    func testPermissionReloadDoesNotWrite() async {
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/permissions/settings" {
                return .json(["global": false, "mode": "ask", "opaquePolicy": ["nested": true]])
            }
            if request.path == "/api/agent/status" {
                return .json(["availableRuntimes": [["id": "claude", "available": true], ["id": "kiro", "available": true, "approveForMe": true]]])
            }
            return .json(["error": "Unexpected write"], status: 500)
        }
        defer { transport.close() }
        let model = FeaturePermissionsSettingsModel(api: transport.api)
        await model.reload()
        XCTAssertTrue(model.ready)
        XCTAssertTrue(model.supportsYolo)
        XCTAssertEqual(model.approveRuntimeIds, ["kiro"])
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
    }

    func testPermissionSavePutsMergedRecordAndLeavesUnrelatedFields() async throws {
        let stored = storedPermissions
        let transport = AppContractTransport { request, _ in
            if request.method == "PUT" && request.path == "/api/permissions/settings" {
                return .json(request.body)
            }
            if request.path == "/api/permissions/settings" {
                return .json(stored)
            }
            return .json(["availableRuntimes": []])
        }
        defer { transport.close() }
        let model = FeaturePermissionsSettingsModel(api: transport.api)
        await model.reload()
        model.draft.global = true
        model.draft.mode = "yolo"
        await model.save()
        let put = try XCTUnwrap(transport.requests.first { $0.method == "PUT" })
        XCTAssertEqual(put.path, "/api/permissions/settings")
        XCTAssertEqual(put.body["global"], true)
        XCTAssertEqual(put.body["mode"], "yolo")
        XCTAssertEqual(put.body["opaquePolicy"], stored["opaquePolicy"])
        XCTAssertEqual(put.body["futureFlag"], .null)
        XCTAssertNil(put.body.objectValue["approveForMe"])
        XCTAssertEqual(transport.requests.filter { $0.method == "PUT" }.count, 1)
    }

    func testUnchangedPermissionDraftNeverPuts() async {
        let transport = AppContractTransport { _, _ in .json(["global": true, "mode": "trust"]) }
        defer { transport.close() }
        let model = FeaturePermissionsSettingsModel(api: transport.api)
        await model.reload()
        await model.save()
        XCTAssertFalse(transport.requests.contains { $0.method == "PUT" })
    }

    func testMetaAgentPatchOmitsUnchangedNullableDefaults() async {
        let draft = featureMetaAgentDraft(from: metaInfo)
        XCTAssertTrue(draft.followGlobal)
        XCTAssertEqual(draft.firstRunDays, 30)
        XCTAssertTrue(draft.writeWorkspaceHomes)
        XCTAssertEqual(featureMetaAgentSettingsPatch(stored: followSettings, draft: draft, resolved: metaInfo["resolved"]), .object([:]))

        var days = draft
        days.firstRunDays = 90
        XCTAssertEqual(
            featureMetaAgentSettingsPatch(stored: followSettings, draft: days, resolved: metaInfo["resolved"]),
            ["firstRunDays": 90]
        )

        var homes = draft
        homes.writeWorkspaceHomes = false
        XCTAssertEqual(
            featureMetaAgentSettingsPatch(stored: followSettings, draft: homes, resolved: metaInfo["resolved"]),
            ["writeWorkspaceHomes": false]
        )
    }

    func testMetaAgentFollowGlobalSendsOnlyRuntimeNulls() async {
        let stored: JSONValue = [
            "runtimeId": "codex", "providerId": .null, "modelId": "gpt-5.5-codex", "reasoning": "high",
            "writeWorkspaceHomes": false, "maintainSpacesHome": true, "firstRunDays": 7,
        ]
        var draft = FeatureMetaAgentDraft()
        draft.followGlobal = true
        draft.writeWorkspaceHomes = false
        draft.maintainSpacesHome = true
        draft.firstRunDays = 7
        XCTAssertEqual(
            featureMetaAgentSettingsPatch(stored: stored, draft: draft, resolved: metaInfo["resolved"]),
            ["runtimeId": .null, "providerId": .null, "modelId": .null, "reasoning": .null]
        )
    }

    func testMetaAgentCustomRuntimeSwitchClearsOwnedFields() async {
        let stored: JSONValue = [
            "runtimeId": "codex", "providerId": .null, "modelId": "gpt-5.5-codex", "reasoning": "high",
            "writeWorkspaceHomes": true, "maintainSpacesHome": true, "firstRunDays": 30,
        ]
        var draft = FeatureMetaAgentDraft()
        draft.followGlobal = false
        draft.runtimeId = "claude"
        draft.providerId = nil
        draft.modelId = nil
        draft.reasoning = nil
        let patch = featureMetaAgentSettingsPatch(stored: stored, draft: draft, resolved: metaInfo["resolved"])
        XCTAssertEqual(patch["runtimeId"], "claude")
        XCTAssertEqual(patch["providerId"], .null)
        XCTAssertEqual(patch["modelId"], .null)
        XCTAssertEqual(patch["reasoning"], .null)
        XCTAssertNil(patch.objectValue["firstRunDays"])
        XCTAssertNil(patch.objectValue["writeWorkspaceHomes"])
        draft.providerId = "anthropic"; draft.modelId = "selected-model"; draft.reasoning = "medium"
        let selected = featureMetaAgentSettingsPatch(stored: stored, draft: draft, resolved: metaInfo["resolved"])
        XCTAssertEqual(selected["providerId"], "anthropic")
        XCTAssertEqual(selected["modelId"], "selected-model")
        XCTAssertEqual(selected["reasoning"], "medium")
    }

    func testMetaAgentSavePutsOnlyChangedField() async throws {
        let info = metaInfo
        let transport = AppContractTransport { request, _ in
            if request.method == "PUT" && request.path == "/api/meta-agent/settings" {
                var next = info
                next["settings"] = info["settings"].merging(request.body.objectValue)
                return .json(next)
            }
            if request.path == "/api/meta-agent" { return .json(info) }
            return .json(["availableRuntimes": [["id": "claude", "available": true]]])
        }
        defer { transport.close() }
        let model = FeatureMetaAgentSettingsModel(api: transport.api)
        await model.reload()
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
        model.draft.firstRunDays = 7
        await model.save()
        let put = try XCTUnwrap(transport.requests.first { $0.method == "PUT" })
        XCTAssertEqual(put.path, "/api/meta-agent/settings")
        XCTAssertEqual(put.body, ["firstRunDays": 7])
        XCTAssertNil(put.body.objectValue["runtimeId"])
        XCTAssertNil(put.body.objectValue["writeWorkspaceHomes"])
    }

    func testMetaAgentRetrySendsFailedMaintenanceToolset() async throws {
        var info = metaInfo
        info["guard"] = [
            "maintenance": [
                "state": "failed", "runtimeId": "claude", "toolset": "maintenance",
                "unexpectedTools": ["fs_write"], "checkedAt": 1,
            ],
            "chat": .null,
        ]
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/meta-agent/retry" {
                return .json(self.metaInfo)
            }
            if request.path == "/api/meta-agent" { return .json(info) }
            return .json(["availableRuntimes": []])
        }
        defer { transport.close() }
        let model = FeatureMetaAgentSettingsModel(api: transport.api)
        await model.reload()
        XCTAssertEqual(featureMetaAgentRetryBody(failures: model.failures), ["toolset": "maintenance"])
        await model.retryGuard()
        let retry = try XCTUnwrap(transport.requests.first { $0.path == "/api/meta-agent/retry" })
        XCTAssertEqual(retry.method, "POST")
        XCTAssertEqual(retry.body, ["toolset": "maintenance"])
    }

    func testMetaAgentToolApprovalPostsExplicitState() async throws {
        var info = metaInfo
        info["toolApprovals"] = [[
            "id": "approval-1", "server": "github", "tool": "create_issue",
            "description": "Open an issue", "state": "pending", "requestedAt": 1, "updatedAt": 1,
        ]]
        let transport = AppContractTransport { request, _ in
            if request.path.hasSuffix("/tool-approvals/approval-1") {
                return .json(self.metaInfo)
            }
            if request.path == "/api/meta-agent" { return .json(info) }
            return .json(["availableRuntimes": []])
        }
        defer { transport.close() }
        let model = FeatureMetaAgentSettingsModel(api: transport.api)
        await model.reload()
        await model.decideToolApproval(id: "approval-1", state: "approved")
        let post = try XCTUnwrap(transport.requests.first { $0.path.hasSuffix("/tool-approvals/approval-1") })
        XCTAssertEqual(post.method, "POST")
        XCTAssertEqual(post.body, ["state": "approved"])
    }

    func testBackupParseKeepsUnknownFieldsAndCountsMessages() async throws {
        let summary = try featureInspectBackup(validBackup)
        XCTAssertEqual(summary.version, 1)
        XCTAssertEqual(summary.workspaceCount, 1)
        XCTAssertEqual(summary.messageCount, 2)
        XCTAssertEqual(summary.exportedAt, 1_730_000_000_000)
        XCTAssertEqual(summary.document["legacyNote"], "retain-me")
        XCTAssertEqual(summary.document["workspaces"].arrayValue[0]["localOnlyExtra"], ["kept": true])
        XCTAssertEqual(summary.document["workspaces"].arrayValue[0]["workspace"]["cwd"], "/tmp/notes")
    }

    func testInvalidBackupShapesAreRejected() async {
        XCTAssertEqual(featureMaxBackupBytes, 50 * 1024 * 1024)
        XCTAssertThrowsError(try featureInspectBackup(Data("{".utf8))) { error in
            XCTAssertEqual((error as? FeatureRequestError)?.message, "Choose a valid JSON backup file.")
        }
        let invalids: [JSONValue] = [
            ["app": "other", "version": 1, "workspaces": []],
            ["app": "michi", "version": 3, "workspaces": []],
            ["app": "michi", "version": .number(1.5), "workspaces": []],
            ["app": "michi", "version": 2, "workspaces": []],
            ["app": "michi", "version": 1, "workspaces": [["workspace": ["id": "ws-1"]]]],
            ["app": "michi", "version": 1, "workspaces": "nope"],
        ]
        for value in invalids {
            XCTAssertThrowsError(try featureInspectBackup(value), String(describing: value)) { error in
                XCTAssertEqual((error as? FeatureRequestError)?.message, "This file is not a supported Michi backup.")
            }
        }
        XCTAssertNotNil(featureBackupSizeError(byteCount: featureMaxBackupBytes + 1))
        XCTAssertNil(featureBackupSizeError(byteCount: featureMaxBackupBytes))
        XCTAssertThrowsError(try featureInspectBackup(Data("{}".utf8), byteCount: featureMaxBackupBytes + 1)) { error in
            XCTAssertEqual((error as? FeatureRequestError)?.message, "Backup files must be 50 MiB or smaller.")
        }
    }

    func testVersion2BackupRequiresAgentsObjectWithoutStrippingWorkspaces() async throws {
        var backup = validBackup
        backup["version"] = 2
        XCTAssertThrowsError(try featureInspectBackup(backup))
        backup["agents"] = ["definitions": [], "extra": ["kept": 1]]
        let summary = try featureInspectBackup(backup)
        XCTAssertEqual(summary.document["agents"]["extra"], ["kept": 1])
        XCTAssertEqual(summary.document["workspaces"].arrayValue[0]["localOnlyExtra"], ["kept": true])
    }

    func testImportPostsFullDocumentAsMergeAndNeverSendsInvalidFiles() async throws {
        let backup = validBackup
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/backup/import" {
                return .json(["workspaceCount": 1])
            }
            return .json(["error": "Unexpected"], status: 404)
        }
        defer { transport.close() }
        let model = FeatureBackupSettingsModel(api: transport.api)
        XCTAssertThrowsError(try model.reviewImport(data: Data("{".utf8), name: "broken.json"))
        XCTAssertNil(model.pending)
        await model.confirmImport()
        XCTAssertTrue(transport.requests.isEmpty)

        let encoded = try JSONEncoder().encode(backup)
        try model.reviewImport(data: encoded, name: "michi.json")
        XCTAssertEqual(model.pending?.document["legacyNote"], "retain-me")
        await model.confirmImport()
        let post = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(post.method, "POST")
        XCTAssertEqual(post.path, "/api/backup/import")
        XCTAssertEqual(post.query["mode"], "merge")
        XCTAssertEqual(post.body, backup)
        XCTAssertEqual(model.restoredCount, 1)

        await model.confirmImport()
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testExportValidatesPayloadBeforeOfferingFile() async throws {
        let backup = validBackup
        let transport = AppContractTransport { request, _ in
            if request.path == "/api/backup/export" { return .json(backup) }
            return .json(["error": "Unexpected"], status: 404)
        }
        defer { transport.close() }
        let model = FeatureBackupSettingsModel(api: transport.api)
        await model.exportBackup()
        XCTAssertTrue(model.presentExporter)
        let data = try XCTUnwrap(model.exportData)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), backup)
        XCTAssertFalse(transport.requests.contains { $0.method != "GET" })
    }

    func testExportRejectsInvalidServerPayloadWithoutImporting() async {
        let transport = AppContractTransport { _, _ in
            .json(["app": "michi", "version": 3, "workspaces": []])
        }
        defer { transport.close() }
        let model = FeatureBackupSettingsModel(api: transport.api)
        await model.exportBackup()
        XCTAssertFalse(model.presentExporter)
        XCTAssertNil(model.exportData)
        XCTAssertEqual(model.error, "This file is not a supported Michi backup.")
        XCTAssertFalse(transport.requests.contains { $0.path.contains("/import") })
    }
    func testAmbiguousImportDoesNotAllowAccidentalSecondSubmission() async throws {
        let transport = AppContractTransport { _, _ in .failure(.networkConnectionLost) }
        defer { transport.close() }
        let model = FeatureBackupSettingsModel(api: transport.api)
        try model.reviewImport(data: JSONEncoder().encode(validBackup), name: "fixture.json")
        await model.confirmImport()
        XCTAssertTrue(model.importOutcomeUnknown)
        XCTAssertFalse(model.canRestore)
        XCTAssertNotNil(model.error)
        await model.confirmImport()
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/backup/import" }.count, 1)
    }

}
