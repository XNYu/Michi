import Foundation
import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class NativeComponentDatabaseBindingTests: XCTestCase {
    private static let custom: JSONValue = [
        "id": "custom", "name": "Overview", "type": "custom", "position": 3,
        "config": [
            "filters": [["column": "title", "op": "not-empty"]],
            "sorts": [["column": "title", "dir": "asc"]],
            "match": "all",
            "group": "status",
            "componentId": "component-1",
            "pinnedVersion": 4,
            "height": 360,
            "props": ["zero": 0, "enabled": false, "nested": ["unknown": [1, "two"]]],
            "futureFlag": ["retain": true],
        ],
    ]
    private static let table: JSONValue = [
        "id": "table", "name": "Table", "type": "table", "position": 0,
        "config": ["filters": [], "sorts": [], "match": "all"],
    ]
    private static let component: JSONValue = [
        "id": "component-2", "workspaceId": "ws", "name": "panel", "enabled": true,
        "activeVersion": 3, "versions": 3,
    ]
    private static let database: JSONValue = [
        "id": "db", "workspaceId": "ws", "revision": 7, "title": "Work",
        "columns": [["id": "title", "name": "Title", "type": "text"]],
        "views": .array([table, custom]),
        "rows": [["id": "row", "rev": 7, "position": 0, "values": ["title": "Item"]]],
    ]
    private static let workspace: JSONValue = ["workspace": ["id": "ws"], "nodes": [], "trees": [], "edges": []]

    private var journal: NativeComponentBindingJournal!

    override func setUp() {
        journal = NativeComponentBindingJournal(directory: FileManager.default.temporaryDirectory.appendingPathComponent("BindingTests-" + UUID().uuidString, isDirectory: true))
    }

    override func tearDown() {
        if let directory = journal?.directory { try? FileManager.default.removeItem(at: directory) }
    }

    private func store(_ transport: AppContractTransport, api: MichiAPI? = nil, databaseId: String = "db") -> FeatureDatabaseModel {
        FeatureDatabaseModel(api: api ?? transport.api, databaseId: databaseId, workspaceId: "ws")
    }

    private func binding(_ model: FeatureDatabaseModel) -> NativeComponentDatabaseBindingModel {
        NativeComponentDatabaseBindingModel(model: model, journal: journal)
    }

    private func close(_ transport: AppContractTransport) {
        UserDefaults.standard.removeObject(forKey: "michi.database.component-binding.\(transport.api.baseURL.absoluteString).ws.db")
        transport.close()
    }

    private static func response(_ request: AppContractRequest, database: JSONValue? = nil) -> AppContractResponse {
        if request.path == "/api/workspaces/ws" { return .json(workspace) }
        if request.path == "/api/databases/db" { return .json(database ?? Self.database) }
        return .json(["error": "Unexpected request"], status: 404)
    }

    func testBindOperationPreservesUnrelatedConfigAndPinsVersion() throws {
        let bound = try NativeComponentDatabaseBinding.bindOperation(
            view: Self.custom,
            name: " Overview ",
            componentID: "component-2",
            pinnedVersion: 3,
            props: ["title": "Review"],
            height: .set(240)
        )
        XCTAssertEqual(bound["op"], "view.save")
        XCTAssertEqual(Set(bound["view"].objectValue.keys), ["id", "name", "type", "config"])
        XCTAssertEqual(bound["view"]["id"], "custom")
        XCTAssertEqual(bound["view"]["name"], "Overview")
        XCTAssertEqual(bound["view"]["type"], "custom")
        let config = bound["view"]["config"]
        XCTAssertEqual(config["filters"], Self.custom["config"]["filters"])
        XCTAssertEqual(config["sorts"], Self.custom["config"]["sorts"])
        XCTAssertEqual(config["match"], "all")
        XCTAssertEqual(config["group"], "status")
        XCTAssertEqual(config["futureFlag"], ["retain": true])
        XCTAssertEqual(config["componentId"], "component-2")
        XCTAssertEqual(config["pinnedVersion"], 3)
        XCTAssertEqual(config["props"], ["title": "Review"])
        XCTAssertEqual(config["height"], 240)
        XCTAssertNil(config.objectValue["code"])
        XCTAssertThrowsError(try featureViewSaveOperation(from: bound["view"]))
        XCTAssertThrowsError(try featureSanitizedViewConfig(config, type: "custom"))
    }

    func testBindKeepsHeightStripsRawScriptAndRejectsUnpinnedOrInvalidProps() throws {
        var raw = Self.custom
        raw["config"]["code"] = "alert(1)"
        raw["config"]["html"] = "<div/>"
        let kept = try NativeComponentDatabaseBinding.bindOperation(
            view: raw,
            componentID: "component-2",
            pinnedVersion: 1,
            props: [:],
            height: .keep
        )
        XCTAssertEqual(kept["view"]["config"]["height"], 360)
        XCTAssertNil(kept["view"]["config"].objectValue["code"])
        XCTAssertNil(kept["view"]["config"].objectValue["html"])
        XCTAssertEqual(kept["view"]["config"]["futureFlag"], ["retain": true])

        let cleared = try NativeComponentDatabaseBinding.bindOperation(
            view: Self.custom,
            componentID: "component-2",
            pinnedVersion: 1,
            props: [:],
            height: .clear
        )
        XCTAssertNil(cleared["view"]["config"].objectValue["height"])

        XCTAssertThrowsError(try NativeComponentDatabaseBinding.bindOperation(
            view: Self.table, componentID: "component-2", pinnedVersion: 1, props: [:], height: .keep
        ))
        XCTAssertThrowsError(try NativeComponentDatabaseBinding.bindOperation(
            view: Self.custom, componentID: "", pinnedVersion: 1, props: [:], height: .keep
        ))
        XCTAssertThrowsError(try NativeComponentDatabaseBinding.bindOperation(
            view: Self.custom, componentID: "component-2", pinnedVersion: 0, props: [:], height: .keep
        ))
        XCTAssertThrowsError(try NativeComponentDatabaseBinding.bindOperation(
            view: Self.custom, componentID: "component-2", pinnedVersion: 1, props: ["x"], height: .keep
        ))
        XCTAssertThrowsError(try NativeComponentDatabaseBinding.bindOperation(
            view: Self.custom, componentID: "component-2", pinnedVersion: 1, props: [:], height: .set(70)
        ))
    }

    func testCreateOperationUsesCustomTypeRequiredConfigAndExactUTF8Identity() throws {
        let composed = "view-e\u{0301}"
        let precomposed = "view-\u{00e9}"
        XCTAssertEqual(composed, precomposed)
        XCTAssertFalse(NativeComponentDatabaseBinding.exact(composed, precomposed))

        let created = try NativeComponentDatabaseBinding.createOperation(
            database: Self.database,
            id: composed,
            name: "Custom",
            componentID: "component-2",
            pinnedVersion: 2,
            props: ["ok": true],
            height: .keep
        )
        XCTAssertEqual(created["view"].id, composed)
        XCTAssertEqual(created["view"]["type"], "custom")
        XCTAssertEqual(created["view"]["name"], "Custom")
        XCTAssertEqual(created["view"]["config"]["filters"], [])
        XCTAssertEqual(created["view"]["config"]["match"], "all")
        XCTAssertEqual(created["view"]["config"]["sorts"], [])
        XCTAssertEqual(created["view"]["config"]["componentId"], "component-2")
        XCTAssertEqual(created["view"]["config"]["pinnedVersion"], 2)
        XCTAssertEqual(created["view"]["config"]["props"], ["ok": true])
        XCTAssertNil(created["view"]["config"].objectValue["height"])
        XCTAssertNil(NativeComponentDatabaseBinding.firstView([created["view"]], id: precomposed))
        XCTAssertEqual(NativeComponentDatabaseBinding.firstView([created["view"]], id: composed)?.id, composed)

        var crowded = Self.database
        crowded["views"] = .array((0..<50).map { index -> JSONValue in
            ["id": .string("v\(index)"), "name": .string("V\(index)"), "type": "table", "config": featureEmptyViewConfig()]
        })
        XCTAssertThrowsError(try NativeComponentDatabaseBinding.createOperation(
            database: crowded, id: "view-new", name: "Custom", componentID: "c", pinnedVersion: 1, props: [:], height: .clear
        ))
    }

    func testMatchesRequiresExactFullConfigIncludingAbsentKeysAndIgnoresViewEditPosition() throws {
        let cleared = try NativeComponentDatabaseBinding.bindOperation(
            view: Self.custom, componentID: "component-2", pinnedVersion: 1, props: [:], height: .clear
        )
        var leftoverHeight = Self.custom
        leftoverHeight["name"] = "Overview"
        leftoverHeight["config"] = cleared["view"]["config"]
        leftoverHeight["config"]["height"] = 360
        leftoverHeight["edit"] = ["at": 99]
        leftoverHeight["position"] = 3
        XCTAssertFalse(NativeComponentDatabaseBinding.matches(cleared, database: Self.database.merging(["views": .array([Self.table, leftoverHeight])])))

        var exact = leftoverHeight
        var fields = exact["config"].objectValue
        fields.removeValue(forKey: "height")
        exact["config"] = .object(fields)
        XCTAssertTrue(NativeComponentDatabaseBinding.matches(cleared, database: Self.database.merging(["views": .array([Self.table, exact])])))

        var raw = Self.custom
        raw["config"]["code"] = "alert(1)"
        let stripped = try NativeComponentDatabaseBinding.bindOperation(
            view: raw, componentID: "component-2", pinnedVersion: 1, props: [:], height: .keep
        )
        var leftoverCode = Self.custom
        leftoverCode["name"] = stripped["view"]["name"]
        leftoverCode["config"] = stripped["view"]["config"]
        leftoverCode["config"]["code"] = "alert(1)"
        XCTAssertFalse(NativeComponentDatabaseBinding.matches(stripped, database: Self.database.merging(["views": .array([Self.table, leftoverCode])])))
        var cleaned = leftoverCode
        var cleanedFields = cleaned["config"].objectValue
        cleanedFields.removeValue(forKey: "code")
        cleaned["config"] = .object(cleanedFields)
        XCTAssertTrue(NativeComponentDatabaseBinding.matches(stripped, database: Self.database.merging(["views": .array([Self.table, cleaned])])))
    }

    func testExactJSONIsByteExactForOpaqueIDsAndPropStrings() throws {
        let composed = "e\u{0301}"
        let precomposed = "\u{00e9}"
        XCTAssertEqual(composed, precomposed)
        XCTAssertFalse(NativeComponentDatabaseBinding.exactJSON(["id": .string(composed)], ["id": .string(precomposed)]))
        XCTAssertFalse(NativeComponentDatabaseBinding.exactJSON(["label": .string(composed)], ["label": .string(precomposed)]))
        XCTAssertTrue(NativeComponentDatabaseBinding.exactJSON(["b": 1, "a": 2], ["a": 2, "b": 1]))
        XCTAssertFalse(NativeComponentDatabaseBinding.exactJSON(["height": 360], [:]))
    }

    func testMakeBindOperationRejectsUnicodeEquivalentSelectedView() throws {
        let composed = "e\u{0301}"
        let precomposed = "\u{00e9}"
        var stored = Self.custom
        stored["config"]["props"] = ["label": .string(composed)]
        var displayed = Self.custom
        displayed["config"]["props"] = ["label": .string(precomposed)]
        XCTAssertEqual(stored, displayed)
        XCTAssertFalse(NativeComponentDatabaseBinding.exactJSON(stored, displayed))

        let model = FeatureDatabaseModel(
            api: MichiAPI(baseURL: URL(string: "https://binding-unicode.michi.test")!),
            databaseId: "db",
            workspaceId: "ws"
        )
        let binding = binding(model)
        model.database = Self.database.merging(["views": .array([Self.table, displayed]), "revision": 7])
        model.selectedViewId = "custom"
        binding.componentID = "component-2"
        binding.pinnedVersion = 1
        XCTAssertThrowsError(try binding.makeBindOperation(database: Self.database.merging(["views": .array([Self.table, stored])])))
    }

    func testDatabaseSelectionKeepsCanonicallyEquivalentViewIDsDistinct() {
        var first = Self.custom, second = Self.custom
        first["id"] = "view-caf\u{00e9}"
        second["id"] = "view-cafe\u{0301}"
        first["name"] = "First"
        second["name"] = "Second"
        let model = FeatureDatabaseModel(api: MichiAPI(baseURL: URL(string: "https://binding-selection.michi.test")!), databaseId: "db", workspaceId: "ws")
        model.database = Self.database.merging(["views": .array([first, second])])
        model.selectedViewId = second.id
        XCTAssertEqual(Array(model.selectedView.id.utf8), Array(second.id.utf8))
        XCTAssertEqual(model.selectedView["name"], "Second")
    }

    func testConfirmedBindRefreshesOnceAndSelectsView() async {
        var latest = Self.database
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" {
                XCTAssertEqual(request.path, "/api/databases/db/edits")
                XCTAssertEqual(request.body["revision"], 7)
                let op = request.body["ops"].arrayValue[0]
                XCTAssertEqual(op["op"], "view.save")
                XCTAssertEqual(op["view"]["config"]["futureFlag"], ["retain": true])
                XCTAssertEqual(op["view"]["config"]["componentId"], "component-2")
                XCTAssertEqual(op["view"]["config"]["pinnedVersion"], 3)
                var saved = Self.custom
                saved["config"] = op["view"]["config"]
                saved["name"] = op["view"]["name"]
                latest = Self.database.merging(["revision": 8, "views": .array([Self.table, saved])])
                return .json(latest)
            }
            return Self.response(request, database: latest)
        }
        defer { close(transport) }
        let model = store(transport)
        let binding = binding(model)
        await binding.refresh()
        model.selectView("custom")
        binding.adoptSelectedView()
        binding.componentID = "component-2"
        binding.pinnedVersion = 3
        binding.propsText = "{\"title\":\"Review\"}"
        binding.heightText = "240"
        let saved = await binding.bindSelectedView()
        XCTAssertTrue(saved)
        XCTAssertNil(binding.pending)
        XCTAssertEqual(model.selectedViewId, "custom")
        XCTAssertEqual(model.selectedView["config"]["componentId"], "component-2")
        XCTAssertEqual(model.revision, 8)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        let again = await binding.bindSelectedView()
        XCTAssertTrue(again)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testClearingSavedHeightPostsWhenExistingHeightRemains() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" {
                let op = request.body["ops"].arrayValue[0]
                XCTAssertNil(op["view"]["config"].objectValue["height"])
                var saved = Self.custom
                saved["config"] = op["view"]["config"]
                saved["name"] = op["view"]["name"]
                saved["edit"] = ["at": 1]
                return .json(Self.database.merging(["revision": 8, "views": .array([Self.table, saved])]))
            }
            return Self.response(request)
        }
        defer { close(transport) }
        let model = store(transport)
        let binding = binding(model)
        await binding.refresh()
        model.selectView("custom")
        binding.adoptSelectedView()
        binding.componentID = "component-2"
        binding.pinnedVersion = 4
        binding.propsText = Self.custom["config"]["props"].prettyPrinted
        binding.clearHeight = true
        let bindingResult321 = await binding.bindSelectedView()
        XCTAssertTrue(bindingResult321)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertNil(model.selectedView["config"].objectValue["height"])
    }

    func testCreateSelectsNewViewWithoutASecondWrite() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" {
                let op = request.body["ops"].arrayValue[0]
                XCTAssertEqual(op["view"]["type"], "custom")
                XCTAssertEqual(op["view"]["config"]["filters"], [])
                XCTAssertEqual(op["view"]["config"]["match"], "all")
                XCTAssertEqual(op["view"]["config"]["sorts"], [])
                XCTAssertNil(op["view"]["config"].objectValue["height"])
                return .json(Self.database.merging([
                    "revision": 8,
                    "views": .array([Self.table, Self.custom, op["view"]]),
                ]))
            }
            return Self.response(request)
        }
        defer { close(transport) }
        let model = store(transport)
        let binding = binding(model)
        await binding.refresh()
        binding.name = "Panel"
        binding.componentID = "component-2"
        binding.pinnedVersion = 2
        binding.propsText = "{}"
        let saved = await binding.createCustomView()
        XCTAssertTrue(saved)
        XCTAssertEqual(model.views.count, 3)
        XCTAssertEqual(model.selectedView["type"], "custom")
        XCTAssertEqual(model.selectedView["name"], "Panel")
        XCTAssertEqual(model.selectedView["config"]["componentId"], "component-2")
        XCTAssertFalse(model.selectedView.id.isEmpty)
        XCTAssertNotEqual(model.selectedView.id, "table")
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testUnknownWritePersistsAndRefreshConfirmsWithoutReposting() async {
        let transport = AppContractTransport { request, requests in
            if request.method == "POST" { return .failure(.timedOut) }
            if let sent = requests.first(where: { $0.method == "POST" }), request.path == "/api/databases/db" {
                let view = sent.body["ops"].arrayValue[0]["view"]
                return .json(Self.database.merging(["revision": 8, "views": .array([Self.table, view])]))
            }
            return Self.response(request)
        }
        defer { close(transport) }
        let model = store(transport)
        let binding = binding(model)
        await binding.refresh()
        model.selectView("custom")
        binding.adoptSelectedView()
        binding.componentID = "component-2"
        binding.pinnedVersion = 3
        binding.propsText = "{\"ok\":true}"
        let saved = await binding.bindSelectedView()
        XCTAssertFalse(saved)
        XCTAssertNotNil(binding.pending)
        let retry = await binding.bindSelectedView()
        XCTAssertFalse(retry)
        let restored = self.binding(model)
        XCTAssertNotNil(restored.pending)
        await restored.refresh()
        XCTAssertNil(restored.pending)
        XCTAssertEqual(model.selectedView["config"]["componentId"], "component-2")
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testScopedUnknownPendingDoesNotApplyToAnotherDatabase() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.timedOut) }
            return Self.response(request)
        }
        defer { close(transport) }
        let model = store(transport)
        let binding = binding(model)
        await binding.refresh()
        model.selectView("custom")
        binding.adoptSelectedView()
        binding.componentID = "component-2"
        binding.pinnedVersion = 2
        _ = await binding.bindSelectedView()
        XCTAssertNotNil(binding.pending)

        let other = FeatureDatabaseModel(api: transport.api, databaseId: "other", workspaceId: "ws")
        let otherBinding = self.binding(other)
        XCTAssertNil(otherBinding.pending)
        XCTAssertNil(otherBinding.journalIssue)
    }

    func testUnknownPendingDoesNotCrossCredentialIdentities() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.timedOut) }
            return Self.response(request)
        }
        defer { close(transport) }
        let apiA = MichiAPI(baseURL: transport.baseURL, bearerToken: "synthetic-binding-test-a", session: transport.session)
        let apiAAgain = MichiAPI(baseURL: transport.baseURL, bearerToken: "  synthetic-binding-test-a  ", session: transport.session)
        let apiB = MichiAPI(baseURL: transport.baseURL, bearerToken: "synthetic-binding-test-b", session: transport.session)
        XCTAssertEqual(apiA.credentialIdentityFingerprint, apiAAgain.credentialIdentityFingerprint)
        XCTAssertNotEqual(apiA.credentialIdentityFingerprint, apiB.credentialIdentityFingerprint)

        let modelA = store(transport, api: apiA)
        let first = binding(modelA)
        await first.refresh()
        modelA.selectView("custom")
        first.adoptSelectedView()
        first.componentID = "component-2"
        first.pinnedVersion = 2
        _ = await first.bindSelectedView()
        XCTAssertNotNil(first.pending)
        XCTAssertFalse(first.pending!.objectValue.keys.contains("token"))

        let other = binding(store(transport, api: apiB))
        XCTAssertNil(other.pending)
        XCTAssertNil(other.journalIssue)

        let restored = binding(store(transport, api: apiAAgain))
        XCTAssertNotNil(restored.pending)
        XCTAssertTrue(NativeComponentDatabaseBinding.exactJSON(restored.pending!["operation"], first.pending!["operation"]))
    }

    func testCorruptPendingBlocksWritesAndExplicitForgetClearsIt() async throws {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        defer { close(transport) }
        let model = store(transport)
        let probe = binding(model)
        let url = try journal.fileURL(scope: probe.scope)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{".utf8).write(to: url)

        let blocked = binding(model)
        XCTAssertNil(blocked.pending)
        XCTAssertNotNil(blocked.journalIssue)
        blocked.componentID = "component-2"
        blocked.pinnedVersion = 1
        await blocked.refresh()
        let bindingResult461 = await blocked.createCustomView()
        XCTAssertFalse(bindingResult461)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })

        blocked.forgetPending()
        XCTAssertNil(blocked.journalIssue)
        XCTAssertNil(blocked.pending)
    }

    func testSecondScreenCannotClearOrReplaceAnotherPendingWrite() async {
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .failure(.timedOut) }
            return Self.response(request)
        }
        defer { close(transport) }
        let model = store(transport)
        let first = binding(model)
        await first.refresh()
        model.selectView("custom")
        first.adoptSelectedView()
        first.componentID = "component-2"
        first.pinnedVersion = 2
        _ = await first.bindSelectedView()
        XCTAssertNotNil(first.pending)
        let reserved = first.pending!

        let secondModel = store(transport)
        let second = binding(secondModel)
        await second.refresh()
        secondModel.selectView("custom")
        second.adoptSelectedView()
        second.componentID = "component-2"
        second.pinnedVersion = 3
        let bindingResult493 = await second.bindSelectedView()
        XCTAssertFalse(bindingResult493)
        let bindingResult494 = await second.createCustomView()
        XCTAssertFalse(bindingResult494)
        XCTAssertTrue(NativeComponentDatabaseBinding.exactJSON(first.pending!, reserved))
        XCTAssertTrue(NativeComponentDatabaseBinding.exactJSON(second.pending!, reserved))
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)
    }

    func testFiveHundredAndInvalidSuccessKeepPendingWithoutRetry() async {
        var postStatus = 500
        var payload: JSONValue = ["error": "offline"]
        var latest = Self.database
        let transport = AppContractTransport { request, _ in
            if request.method == "POST" { return .json(payload, status: postStatus) }
            return Self.response(request, database: latest)
        }
        defer { close(transport) }
        let model = store(transport)
        let binding = binding(model)
        await binding.refresh()
        model.selectView("custom")
        binding.adoptSelectedView()
        binding.componentID = "component-2"
        binding.pinnedVersion = 2
        binding.propsText = "{\"kept\":true}"
        let bindingResult517 = await binding.bindSelectedView()
        XCTAssertFalse(bindingResult517)
        XCTAssertNotNil(binding.pending)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 1)

        binding.forgetPending()
        XCTAssertNil(binding.pending)
        postStatus = 200
        payload = Self.database
        let bindingResult525 = await binding.bindSelectedView()
        XCTAssertFalse(bindingResult525)
        XCTAssertNotNil(binding.pending)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 2)
        let bindingResult528 = await binding.bindSelectedView()
        XCTAssertFalse(bindingResult528)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 2)

        var confirmed = Self.custom
        confirmed["config"]["componentId"] = "component-2"
        confirmed["config"]["pinnedVersion"] = 2
        confirmed["config"]["props"] = ["kept": true]
        await binding.refresh()
        XCTAssertNotNil(binding.pending)
        latest = Self.database.merging(["revision": 8, "views": .array([Self.table, confirmed])])
        await binding.refresh()
        XCTAssertNil(binding.pending)
        XCTAssertEqual(transport.requests.filter { $0.method == "POST" }.count, 2)
    }

    func testDefiniteRejectionIgnoresTransportServerAndUncodedClientErrors() {
        XCTAssertFalse(NativeComponentDatabaseBinding.definiteRejection(URLError(.timedOut)))
        XCTAssertFalse(NativeComponentDatabaseBinding.definiteRejection(MichiAPIError(statusCode: 500, code: nil, message: "offline")))
        XCTAssertFalse(NativeComponentDatabaseBinding.definiteRejection(MichiAPIError(statusCode: 422, code: nil, message: "unusable")))
        XCTAssertFalse(NativeComponentDatabaseBinding.definiteRejection(MichiAPIError(statusCode: 400, code: nil, message: "generic")))
        XCTAssertTrue(NativeComponentDatabaseBinding.definiteRejection(MichiAPIError(statusCode: 400, code: "invalid", message: "bad")))
        XCTAssertTrue(NativeComponentDatabaseBinding.definiteRejection(MichiAPIError(statusCode: 409, code: "stale_revision", message: "stale")))
        XCTAssertTrue(NativeComponentDatabaseBinding.definiteRejection(MichiAPIError(statusCode: 404, code: "not_found", message: "gone")))
        XCTAssertTrue(NativeComponentDatabaseBinding.definiteRejection(MichiAPIError(statusCode: 401, code: nil, message: "auth")))
    }

    func testReadOnlyAndIdentityMismatchDoNotWrite() async {
        let readOnlyDB = Self.database.merging(["readOnly": true])
        let readOnly = AppContractTransport { request, _ in Self.response(request, database: readOnlyDB) }
        defer { close(readOnly) }
        let readModel = store(readOnly)
        let readBinding = binding(readModel)
        await readBinding.refresh()
        XCTAssertFalse(readBinding.access)
        readBinding.componentID = "component-2"
        readBinding.pinnedVersion = 1
        let refused = await readBinding.createCustomView()
        XCTAssertFalse(refused)
        XCTAssertTrue(readOnly.requests.allSatisfy { $0.method == "GET" })

        let drifted = AppContractTransport { request, requests in
            let reads = requests.filter { $0.path == "/api/databases/db" }.count
            return Self.response(request, database: reads > 1 ? Self.database.merging(["revision": 8]) : Self.database)
        }
        defer { close(drifted) }
        let model = store(drifted)
        let binding = binding(model)
        await binding.refresh()
        model.selectView("custom")
        binding.adoptSelectedView()
        binding.componentID = "component-2"
        binding.pinnedVersion = 2
        let saved = await binding.bindSelectedView()
        XCTAssertFalse(saved)
        XCTAssertEqual(model.revision, 8)
        XCTAssertNotNil(model.error)
        XCTAssertNil(binding.pending)
        XCTAssertTrue(drifted.requests.allSatisfy { $0.method == "GET" })
    }

    func testAdoptLibraryInsertRequiresEnabledComponentAndObjectProps() {
        let model = FeatureDatabaseModel(
            api: MichiAPI(baseURL: URL(string: "https://binding-library.michi.test")!),
            databaseId: "db",
            workspaceId: "ws"
        )
        let binding = binding(model)
        XCTAssertTrue(binding.adoptLibraryInsert(Self.component, version: 3, props: ["ok": true]))
        XCTAssertEqual(binding.componentID, "component-2")
        XCTAssertEqual(binding.pinnedVersion, 3)
        XCTAssertFalse(binding.adoptLibraryInsert(Self.component.merging(["enabled": false]), version: 3, props: [:]))
        XCTAssertFalse(binding.adoptLibraryInsert(Self.component, version: 9, props: [:]))
        XCTAssertFalse(binding.adoptLibraryInsert(Self.component, version: 1, props: ["x"]))
        XCTAssertFalse(binding.selectComponent(Self.component.merging(["enabled": false]), version: 1))
        XCTAssertFalse(binding.selectComponent(Self.component.merging(["workspaceId": "other"]), version: 1))
        XCTAssertTrue(binding.selectComponent(Self.component, version: 2))
        XCTAssertEqual(binding.pinnedVersion, 2)
        XCTAssertTrue(binding.selectComponent(Self.component))
        XCTAssertEqual(binding.pinnedVersion, 2)
        XCTAssertFalse(binding.selectComponent(Self.component.merging(["deletedAt": 1, "enabled": false])))
    }
}
