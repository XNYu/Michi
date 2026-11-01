import Foundation
import Combine
import CryptoKit
import MichiCore

enum NativeComponentAction: String, CaseIterable { case enable, disable, activate, rollback, delete }

struct NativeComponentDraft: Equatable {
    var name = ""
    var description = ""
    var code = ""
    var propsSchemaText = "null"
    init(name: String = "", description: String = "", code: String = "", propsSchemaText: String = "null") {
        self.name = name; self.description = description; self.code = code; self.propsSchemaText = propsSchemaText
    }
    init(component: JSONValue, version: JSONValue) {
        self.init(name: component["name"].stringValue, description: component["description"].stringValue,
                  code: version["code"].stringValue, propsSchemaText: version["propsSchema"].prettyPrinted)
    }
    var record: JSONValue { ["name": .string(name), "description": .string(description), "code": .string(code), "propsSchemaText": .string(propsSchemaText)] }
    init(record: JSONValue) {
        self.init(name: record["name"].stringValue, description: record["description"].stringValue,
                  code: record["code"].stringValue, propsSchemaText: record["propsSchemaText"].optionalString ?? "null")
    }
    func input() throws -> JSONValue {
        guard name.range(of: "^[a-z][a-z0-9-]{1,39}$", options: .regularExpression) != nil else {
            throw NativeFailure("Use a 2–40 character name beginning with a lowercase letter, followed by lowercase letters, digits or hyphens.")
        }
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, description.unicodeScalars.count <= 500, !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              code.utf8.count <= 200_000, propsSchemaText.utf8.count <= 64_000 else { throw NativeFailure("Enter a description of at most 500 characters and code of at most 200 KB; the props schema is limited to 64 KB.") }
        let schema: JSONValue
        do { schema = try JSONValue.parse(propsSchemaText) } catch { throw NativeFailure("Props schema must be valid JSON or null. Your source has been kept.") }
        guard schema.isNull || NativeComponentContract.schema(schema, root: true) else { throw NativeFailure("This props schema is not supported by the component service. Your source has been kept.") }
        return ["name": .string(name), "description": .string(trimmed), "code": .string(code), "propsSchema": schema]
    }
}

enum NativeComponentContract {
    static func id(_ value: JSONValue) -> Bool { value.optionalString.map { !$0.isEmpty && $0.utf16.count <= 200 } == true }
    /// Opaque IDs match by exact UTF-8 bytes, never Unicode canonical equivalence.
    static func same(_ a: String, _ b: String) -> Bool { ComponentSandbox.sameID(a, b) }
    static func same(_ value: JSONValue, _ expected: String) -> Bool {
        value.optionalString.map { ComponentSandbox.sameID($0, expected) } == true
    }
    static func integer(_ value: JSONValue, minimum: Int = 0) -> Int? {
        guard let n = value.featureOptionalNumber, n.isFinite, n >= Double(minimum), n <= 9_007_199_254_740_991, n.rounded(.down) == n else { return nil }
        return Int(n)
    }
    static func component(_ value: JSONValue, workspaceID: String, owner: String?, expectedID: String? = nil, deleted: Bool = false) throws -> JSONValue {
        guard id(value["id"]), id(value["ownerUserId"]), same(value["workspaceId"], workspaceID),
              expectedID.map { same(value["id"], $0) } ?? true, owner.map { same(value["ownerUserId"], $0) } ?? true,
              value["name"].optionalString != nil, value["description"].optionalString != nil, value["enabled"].featureOptionalBool != nil,
              let active = integer(value["activeVersion"], minimum: 1), let count = integer(value["versions"], minimum: 1), active <= count,
              integer(value["libraryRevision"], minimum: 1) != nil, integer(value["revocationEpoch"]) != nil,
              integer(value["createdAt"]) != nil, integer(value["updatedAt"]) != nil,
              value.objectValue.keys.contains("deletedAt"), value["deletedAt"].isNull || integer(value["deletedAt"]) != nil,
              deleted || value["deletedAt"].isNull else { throw NativeFailure("The component response has an invalid identity or revision. Existing content has been kept.") }
        return value
    }
    static func version(_ value: JSONValue, componentID: String, number: Int) throws -> JSONValue {
        guard same(value["componentId"], componentID), integer(value["version"], minimum: 1) == number,
              let code = value["code"].optionalString, code.utf8.count <= 200_000,
              value["propsSchema"].isNull || { if case .object = value["propsSchema"] { return true }; return false }(),
              case .object = value["source"], id(value["source"]["kind"]), integer(value["createdAt"]) != nil else {
            throw NativeFailure("The requested component version could not be verified. Existing source has been kept.")
        }
        return value
    }
    static func references(_ payload: JSONValue, workspaceID: String, componentID: String) throws -> [JSONValue] {
        guard case .array(let items) = payload["items"] else { throw NativeFailure("Component usage could not be read.") }
        for item in items {
            let page = item["kind"] == "page_block", database = item["kind"] == "database_view"
            guard same(item["workspaceId"], workspaceID), same(item["componentId"], componentID),
                  (page && id(item["pageId"]) && id(item["blockId"])) || (database && id(item["databaseId"]) && id(item["viewId"])),
                  item["protected"].featureOptionalBool != nil, integer(item["hostRevision"], minimum: 1) != nil,
                  item["pinnedVersion"].isNull || integer(item["pinnedVersion"], minimum: 1) != nil else { throw NativeFailure("Component usage contains an unrelated or invalid reference.") }
        }
        return items
    }
    static func schema(_ value: JSONValue, depth: Int = 0, root: Bool = false) -> Bool {
        guard case .object(let fields) = value, depth <= 8,
              Set(fields.keys).isSubset(of: ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]) else { return false }
        if let type = fields["type"], !["object", "array", "string", "number", "integer", "boolean", "null"].contains(type.stringValue) || (root && type != "object") { return false }
        for key in ["minLength", "maxLength", "minItems", "maxItems"] {
            if let value = fields[key], integer(value).map({ $0 <= 10_000 }) != true { return false }
        }
        for key in ["minimum", "maximum"] { if let value = fields[key], value.featureOptionalNumber?.isFinite != true { return false } }
        if let value = fields["additionalProperties"], value.featureOptionalBool == nil { return false }
        if let required = fields["required"] {
            guard case .array(let values) = required, values.count <= 64, values.allSatisfy(id), Set(values.map(\.stringValue)).count == values.count else { return false }
        }
        if let properties = fields["properties"] {
            guard case .object(let fields) = properties, fields.count <= 64,
                  fields.allSatisfy({ id(.string($0.key)) && schema($0.value, depth: depth + 1) }) else { return false }
        }
        if let items = fields["items"], !schema(items, depth: depth + 1) { return false }
        if let choices = fields["enum"] {
            guard case .array(let choices) = choices, choices.count <= 100, choices.allSatisfy({ json($0) }) else { return false }
        }
        if let constant = fields["const"], !json(constant) { return false }
        return true
    }
    private static func json(_ value: JSONValue, depth: Int = 0) -> Bool {
        guard depth <= 20 else { return false }
        switch value {
        case .null, .bool: return true
        case .number(let n): return n.isFinite
        case .string(let s): return s.unicodeScalars.count <= 64_000
        case .array(let a): return a.count <= 2_000 && a.allSatisfy { json($0, depth: depth + 1) }
        case .object(let o): return o.count <= 64 && o.allSatisfy { $0.key.utf16.count <= 200 && json($0.value, depth: depth + 1) }
        }
    }
    static func confirmedRejection(_ error: Error) -> Bool {
        guard let error = error as? MichiAPIError else { return false }
        if let code = error.code, [MichiAPIError.Code.invalidConfiguration, MichiAPIError.Code.invalidPath, MichiAPIError.Code.invalidRequest, MichiAPIError.Code.insecureURL].contains(code) { return true }
        if let status = error.statusCode, [401, 403, 404].contains(status) { return true }
        return [400, 409].contains(error.statusCode ?? 0) && ["invalid", "not_found", "stale_revision"].contains(error.code ?? "")
    }
}

/// A durable reservation is written before a component POST/DELETE. No replay
/// token exists on these routes: reopen only reads and reconciles, never retries.
final class NativeComponentMutationJournal: @unchecked Sendable {
    private static let lock = NSLock()
    let directory: URL?
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("Michi/ComponentOperations.v1", isDirectory: true)
    }
    func fileURL(scope: JSONValue) throws -> URL {
        guard let directory else { throw NativeFailure("Local operation storage is unavailable. Nothing was submitted.") }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let hash = SHA256.hash(data: try encoder.encode(scope)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(hash + ".json")
    }
    private func read(scope: JSONValue) throws -> JSONValue? {
        let url = try fileURL(scope: scope)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size, size.intValue <= 1_048_576 else { throw NativeFailure("The pending component operation could not be read. New changes remain blocked.") }
        let record = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        let pending = record["pending"]
        guard record["format"] == 1, record["scope"] == scope, NativeComponentContract.id(pending["requestID"]),
              ["save", "enable", "disable", "activate", "rollback", "delete"].contains(pending["kind"].stringValue),
              NativeComponentContract.integer(pending["expectedLibraryRevision"]) != nil else { throw NativeFailure("The pending component operation has an invalid identity. New changes remain blocked.") }
        return pending
    }
    func load(scope: JSONValue) throws -> JSONValue? { Self.lock.lock(); defer { Self.lock.unlock() }; return try read(scope: scope) }
    func reserve(_ pending: JSONValue, scope: JSONValue) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard try read(scope: scope) == nil, let directory else { throw NativeFailure("A component operation is already pending. Check its result before making another change.") }
        let data = try JSONEncoder().encode(JSONValue.object(["format": 1, "scope": scope, "pending": pending]))
        guard data.count <= 1_048_576 else { throw NativeFailure("This component operation is too large to save safely.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = try fileURL(scope: scope); try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }; try handle.synchronize()
        guard try read(scope: scope) == pending else { throw NativeFailure("The pending component operation could not be verified. Nothing was submitted.") }
    }
    func clear(_ pending: JSONValue, scope: JSONValue) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let saved = try read(scope: scope) else { return }
        guard saved == pending else { throw NativeFailure("Another pending component operation was kept.") }
        try FileManager.default.removeItem(at: fileURL(scope: scope))
    }
}

@MainActor final class NativeComponentLibraryModel: ObservableObject {
    let api: MichiAPI
    let workspaceID: String
    let journal: NativeComponentMutationJournal
    @Published private(set) var items: [JSONValue] = []
    @Published private(set) var revision = 0
    @Published private(set) var selectedID: String?
    @Published private(set) var selectedVersion: Int?
    @Published private(set) var version: JSONValue = .null
    @Published private(set) var references: [JSONValue] = []
    @Published var draft = NativeComponentDraft()
    @Published private(set) var draftReady = true
    @Published private(set) var loading = false
    @Published private(set) var reading = false
    @Published private(set) var saving = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var readOnly = true
    @Published private(set) var error: String?
    @Published private(set) var notice: String?
    @Published private(set) var pending: JSONValue?
    @Published private(set) var recoveryIssue: String?
    private var baseline = NativeComponentDraft()
    private var callerReadOnly: Bool
    private var ownerUserID: String?
    private var available = false
    private var scope: JSONValue {
        ["connection": .string(api.baseURL.absoluteString), "workspaceID": .string(workspaceID),
         "credentialIdentity": .string(api.credentialIdentityFingerprint)]
    }
    var selected: JSONValue? { selectedID.flatMap { id in items.first { NativeComponentContract.same($0["id"], id) } } }
    var dirty: Bool { draft != baseline }
    var outcomeUnknown: Bool { pending != nil || recoveryIssue != nil }
    var canMutate: Bool { hasLoaded && available && !readOnly && !loading && !reading && !saving && !outcomeUnknown }
    /// Keep pickers bounded; select(componentID:version:) can read any version.
    var availableVersions: [Int] {
        guard let selected else { return [] }
        let latest = selected["versions"].intValue
        var values = Set((max(1, latest - 199)...latest))
        values.insert(selected["activeVersion"].intValue)
        if let selectedVersion { values.insert(selectedVersion) }
        return values.sorted(by: >)
    }

    init(api: MichiAPI, workspaceID: String, readOnly: Bool = false, ownerUserID: String? = nil, journal: NativeComponentMutationJournal = .init()) {
        self.api = api; self.workspaceID = workspaceID; self.callerReadOnly = readOnly; self.ownerUserID = ownerUserID; self.journal = journal
        do {
            pending = try journal.load(scope: scope)
            if let pending {
                if pending["kind"] == "save" { draft = NativeComponentDraft(record: pending["draft"]); selectedID = pending["componentID"].optionalString }
                notice = "A previous component change is unconfirmed. Check its saved result before changing the library again."
            }
        } catch { recoveryIssue = "The pending component operation could not be read. New changes remain blocked." }
    }
    private var libraryPath: String { "/workspaces/\(MichiAPI.pathSegment(workspaceID))/components" }
    private func detailPath(_ id: String, number: Int? = nil) -> String {
        "/components/\(MichiAPI.pathSegment(id))" + FeatureAPI.query([("workspaceId", workspaceID), ("version", number.map(String.init))])
    }
    private func workspaceState() async throws -> Bool {
        let result = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))")
        let workspace = result["workspace"]
        guard NativeComponentContract.same(workspace["id"], workspaceID), workspace.objectValue.keys.contains("deleted_at"), workspace.objectValue.keys.contains("archived_at"),
              workspace["deleted_at"].isNull, workspace["purged_at"].isNull else { throw NativeFailure("The component workspace is unavailable. Existing source has been kept.") }
        // The scoped component route verifies the actor and permits a system
        // workspace only when it hosts this owner's Spaces Home.
        return callerReadOnly || !workspace["archived_at"].isNull
    }
    private func readLibrary() async throws {
        let archived = try await workspaceState(), result = try await api.request(libraryPath)
        guard let nextRevision = NativeComponentContract.integer(result["revision"]), nextRevision >= revision,
              case .array(let records) = result["items"] else { throw NativeFailure("The component library revision could not be read. Existing source has been kept.") }
        var nextOwner = ownerUserID, ids = Set<Data>(), names = Set<String>()
        for record in records {
            _ = try NativeComponentContract.component(record, workspaceID: workspaceID, owner: nextOwner)
            if nextOwner == nil { nextOwner = record["ownerUserId"].stringValue }
            guard record["libraryRevision"].intValue <= nextRevision, ids.insert(Data(record.id.utf8)).inserted,
                  names.insert(record["name"].stringValue).inserted else { throw NativeFailure("The library contains conflicting component identities.") }
        }
        if let selectedID, let old = selected, let next = records.first(where: { NativeComponentContract.same($0["id"], selectedID) }),
           old["activeVersion"] != next["activeVersion"] {
            notice = "The active version changed in another window. Your source is kept; review the version list before saving or inserting."
        }
        items = records; revision = nextRevision; ownerUserID = nextOwner; readOnly = archived; hasLoaded = true; available = true
        if let selectedID, !records.contains(where: { NativeComponentContract.same($0["id"], selectedID) }) { notice = "The selected component is no longer in this library. Your draft is kept." }
    }
    @discardableResult func refresh() async -> Bool {
        guard !loading, !saving, !reading else { return false }
        loading = true; defer { loading = false }
        do { try await readLibrary(); error = nil; return true }
        catch { available = false; self.error = error.localizedDescription; return false }
    }
    @discardableResult func beginNew(discardDraft: Bool = false) -> Bool {
        guard !saving, !reading, !loading, !dirty || discardDraft else { error = "Save or explicitly discard your current source first."; return false }
        selectedID = nil; selectedVersion = nil; version = .null; references = []; draft = .init(); baseline = draft; draftReady = true; error = nil
        return true
    }
    @discardableResult func select(componentID: String, version number: Int? = nil, discardDraft: Bool = false) async -> Bool {
        guard hasLoaded, !loading, !reading, !saving, !dirty || discardDraft,
              let component = items.first(where: { NativeComponentContract.same($0["id"], componentID) }) else { error = "Save or explicitly discard your source before selecting a component."; return false }
        let target = number ?? component["activeVersion"].intValue
        guard target > 0, target <= component["versions"].intValue else { error = "Choose an existing immutable version."; return false }
        reading = true; defer { reading = false }
        selectedID = componentID; selectedVersion = target; self.version = .null; references = []; draftReady = false
        let previousDraft = draft
        do {
            let result = try await api.request(detailPath(componentID, number: target))
            let loaded = try NativeComponentContract.version(result, componentID: componentID, number: target)
            self.version = loaded; baseline = NativeComponentDraft(component: component, version: loaded)
            if draft == previousDraft { draft = baseline }; draftReady = true; error = nil
        } catch { self.error = component["enabled"] == false && (error as? MichiAPIError)?.statusCode == 404 ? "This component is disabled. The backend does not expose disabled source; enable it before reading a version." : error.localizedDescription }
        do {
            let payload = try await api.request("/components/\(MichiAPI.pathSegment(componentID))/references" + FeatureAPI.query([("workspaceId", workspaceID)]))
            references = try NativeComponentContract.references(payload, workspaceID: workspaceID, componentID: componentID)
        } catch { if self.error == nil { self.error = error.localizedDescription } }
        return draftReady
    }
    func discardDraft() async {
        if let selectedID { _ = await select(componentID: selectedID, version: selectedVersion, discardDraft: true) }
        else { _ = beginNew(discardDraft: true) }
    }
    @discardableResult func save() async -> Bool {
        guard canMutate, draftReady, dirty else { return false }
        do {
            let input = try draft.input(), existing = items.first { $0["name"] == input["name"] }
            if let selectedID {
                guard let existing, NativeComponentContract.same(existing["id"], selectedID) else {
                    throw NativeFailure("An existing component keeps its name. Select the intended component to save a version, or start a new component with a different name. Your draft is kept.")
                }
            } else if existing != nil {
                throw NativeFailure("That name already belongs to a component. Select it explicitly before saving a new version. Your draft is kept.")
            }
            let operation: JSONValue = ["requestID": .string(UUID().uuidString), "kind": "save", "expectedLibraryRevision": .number(Double(revision)),
                "ownerUserID": ownerUserID.map(JSONValue.string) ?? .null, "componentID": existing?["id"] ?? .null,
                "version": .number(Double((existing?["versions"].intValue ?? 0) + 1)), "before": existing ?? .null, "input": input, "draft": draft.record]
            return await submit(operation, path: libraryPath, method: "POST", body: ["input": input, "expectedLibraryRevision": operation["expectedLibraryRevision"]])
        } catch { self.error = error.localizedDescription; return false }
    }
    @discardableResult func perform(_ action: NativeComponentAction, componentID: String? = nil, version number: Int? = nil, confirmed: Bool = false) async -> Bool {
        guard confirmed, canMutate, let id = componentID ?? selectedID,
              let component = items.first(where: { NativeComponentContract.same($0["id"], id) }) else { return false }
        if (action == .enable && component["enabled"] == true) || (action == .disable && component["enabled"] == false) {
            error = "The component already has that state in the loaded library. Refresh to check it."; return false
        }
        var body: JSONValue = ["workspaceId": .string(workspaceID), "expectedLibraryRevision": .number(Double(revision))]
        if action == .activate || action == .rollback {
            guard component["enabled"] == true, let number, number > 0, number <= component["versions"].intValue else { error = "Enable the component and choose an existing version first."; return false }
            guard number != component["activeVersion"].intValue else { error = "That version is already active in the loaded library."; return false }
            body["version"] = .number(Double(number))
        }
        let operation: JSONValue = ["requestID": .string(UUID().uuidString), "kind": .string(action.rawValue), "componentID": .string(id),
            "ownerUserID": component["ownerUserId"], "expectedLibraryRevision": .number(Double(revision)), "version": body["version"], "before": component]
        let path = "/components/\(MichiAPI.pathSegment(id))" + (action == .delete ? "" : "/" + action.rawValue)
        return await submit(operation, path: path, method: action == .delete ? "DELETE" : "POST", body: body)
    }
    private func submit(_ operation: JSONValue, path: String, method: String, body: JSONValue) async -> Bool {
        saving = true; error = nil; defer { saving = false }
        var submitted = false, acknowledged = false
        do {
            readOnly = try await workspaceState()
            guard !readOnly else { throw NativeFailure("This workspace is archived or read-only. Your source has been kept.") }
            try Task.checkCancellation()
            try journal.reserve(operation, scope: scope); pending = operation; submitted = true
            let response = try await api.request(path, method: method, body: body)
            try applyAcknowledgement(response, operation: operation)
            acknowledged = true
            try clearPending(operation); error = nil; return true
        } catch {
            if submitted && NativeComponentContract.confirmedRejection(error) {
                do { try clearPending(operation) } catch { recoveryIssue = "The rejected operation's local record could not be cleared." }
                if (error as? MichiAPIError)?.statusCode == 409 {
                    do { try await readLibrary() } catch { available = false }
                    self.error = "The component library changed. Your source is kept. Review the current versions and submit again explicitly."
                } else { self.error = error.localizedDescription }
            } else {
                do { pending = try journal.load(scope: scope) } catch { recoveryIssue = "The pending operation could not be read. New changes remain blocked." }
                if acknowledged {
                    recoveryIssue = "The confirmed operation's local record could not be cleared."
                    self.error = "The server confirmed this change, but its local operation record could not be cleared. Check the saved result before another change."
                } else {
                    self.error = submitted ? "The component change is unconfirmed. Check its saved result; it will not be submitted again automatically." : error.localizedDescription
                }
            }
            return false
        }
    }
    private func applyAcknowledgement(_ response: JSONValue, operation: JSONValue) throws {
        let savingVersion = operation["kind"] == "save", id = operation["componentID"].optionalString
        let component = try NativeComponentContract.component(savingVersion ? response["component"] : featureUnwrap(response, "component"), workspaceID: workspaceID,
            owner: operation["ownerUserID"].optionalString ?? ownerUserID, expectedID: id, deleted: operation["kind"] == "delete")
        let nextRevision = operation["expectedLibraryRevision"].intValue + 1
        guard component["libraryRevision"].intValue == nextRevision else { throw NativeFailure("The component change did not return its expected revision.") }
        if savingVersion {
            let expected = operation["version"].intValue, input = operation["input"]
            let stored = try NativeComponentContract.version(response["version"], componentID: component.id, number: expected)
            guard NativeComponentContract.integer(response["revision"]) == nextRevision, component["name"] == input["name"], component["description"] == input["description"],
                  component["activeVersion"].intValue == expected, component["versions"].intValue == expected,
                  stored["code"] == input["code"], stored["propsSchema"] == input["propsSchema"], stored["source"]["kind"] == "user",
                  component["enabled"] == (id == nil ? true : operation["before"]["enabled"]),
                  component["revocationEpoch"].intValue == (id == nil ? 1 : operation["before"]["revocationEpoch"].intValue + 1),
                  id != nil || !items.contains(where: { NativeComponentContract.same($0["id"], component.id) }) else { throw NativeFailure("The saved component version could not be confirmed.") }
            applySaved(component, version: stored, operation: operation)
        } else {
            let before = operation["before"], changesVersion = ["activate", "rollback"].contains(operation["kind"].stringValue)
            guard matches(component, operation: operation), component["name"] == before["name"], component["description"] == before["description"],
                  component["versions"] == before["versions"], component["createdAt"] == before["createdAt"],
                  changesVersion || component["activeVersion"] == before["activeVersion"],
                  component["revocationEpoch"].intValue == before["revocationEpoch"].intValue + 1 else { throw NativeFailure("The component action was not confirmed by its response.") }
            replace(component)
        }
        revision = nextRevision; ownerUserID = component["ownerUserId"].stringValue
        notice = savingVersion ? "Saved immutable version v\(component["activeVersion"].intValue). Preview it here with isolated sample data; live page and database hosts run the pinned or active version." : "Component library updated."
    }
    private func replace(_ component: JSONValue) {
        items.removeAll { NativeComponentContract.same($0["id"], component.id) }
        if component["deletedAt"].isNull { items.append(component); items.sort { $0["name"].stringValue < $1["name"].stringValue } }
    }
    private func applySaved(_ component: JSONValue, version stored: JSONValue, operation: JSONValue) {
        replace(component); selectedID = component.id; selectedVersion = stored["version"].intValue; version = stored; draftReady = true
        let submitted = NativeComponentDraft(record: operation["draft"]), committed = NativeComponentDraft(component: component, version: stored)
        if draft == submitted { draft = committed }
        baseline = committed
    }
    private func matches(_ component: JSONValue, operation: JSONValue) -> Bool {
        switch operation["kind"].stringValue {
        case "enable": return component["enabled"] == true && component["deletedAt"].isNull
        case "disable": return component["enabled"] == false && component["deletedAt"].isNull
        case "activate", "rollback": return component["enabled"] == true && component["activeVersion"] == operation["version"] && component["deletedAt"].isNull
        case "delete": return !component["deletedAt"].isNull && component["enabled"] == false
        default: return false
        }
    }
    private func clearPending(_ operation: JSONValue) throws { try journal.clear(operation, scope: scope); pending = nil; recoveryIssue = nil }
    /// Resolves the local reservation, not necessarily proof that our write ran.
    /// Every mutation compares the entire library revision inside a transaction.
    /// A newer revision fences an old request permanently, including one whose
    /// HTTP response was lost or whose resulting state was superseded.
    @discardableResult func reconcilePending() async -> Bool {
        guard !loading, !reading, !saving else { return false }
        loading = true; defer { loading = false }
        do {
            guard let operation = try journal.load(scope: scope) else { pending = nil; recoveryIssue = nil; return true }
            pending = operation
            try await readLibrary()
            try requirePendingOwner(operation)
            let previous = operation["expectedLibraryRevision"].intValue
            // An unchanged revision cannot prove a delayed request won't commit.
            guard revision > previous else { notice = "The library has not confirmed this operation yet. No retry was sent."; return false }
            var confirmed = false
            if operation["kind"] == "save" {
                let input = operation["input"]
                if let component = items.first(where: { $0["name"] == input["name"] }),
                      (operation["componentID"].isNull || NativeComponentContract.same(component["id"], operation["componentID"].stringValue)),
                      component["libraryRevision"].intValue > previous,
                      component["versions"].intValue >= operation["version"].intValue {
                    do {
                        let number = operation["version"].intValue
                        let stored = try NativeComponentContract.version(await api.request(detailPath(component.id, number: number)), componentID: component.id, number: number)
                        if stored["code"] == input["code"], stored["propsSchema"] == input["propsSchema"], stored["source"]["kind"] == "user" {
                            applySaved(component, version: stored, operation: operation); confirmed = true
                        }
                    } catch {
                        // A disabled/deleted version can return 404, or a later
                        // detail read can fail. The successful library GET has
                        // already proved the old revision can no longer commit.
                    }
                }
            } else if operation["kind"] == "delete" {
                confirmed = !items.contains(where: { NativeComponentContract.same($0["id"], operation["componentID"].stringValue) })
            } else {
                if let component = items.first(where: { NativeComponentContract.same($0["id"], operation["componentID"].stringValue) }) {
                    confirmed = component["libraryRevision"].intValue > previous && matches(component, operation: operation)
                }
            }
            try clearPending(operation)
            notice = confirmed
                ? (operation["kind"] == "save" ? "The matching immutable version is saved. Review the current active version; no request was repeated." : "The requested state is present in the saved library. No request was repeated.")
                : "The earlier change was not confirmed or was superseded. A newer library revision prevents its old request from committing. Review the current library before saving again; your draft is kept."
            error = nil; return true
        } catch { self.error = "Couldn’t verify the pending component operation. It remains blocked and was not repeated."; return false }
    }

    /// An explicit recovery action still requires a fresh, scoped revision proof.
    /// Confirmation alone cannot release a request that may yet commit at R.
    @discardableResult func clearPendingAfterReview(confirmed: Bool) async -> Bool {
        guard confirmed, !loading, !reading, !saving else { return false }
        loading = true; defer { loading = false }
        do {
            guard let operation = try journal.load(scope: scope) else { pending = nil; recoveryIssue = nil; return true }
            pending = operation
            try await readLibrary(); try requirePendingOwner(operation)
            guard revision > operation["expectedLibraryRevision"].intValue else {
                notice = "The library revision has not advanced. A delayed request could still commit, so its pending record was kept."
                return false
            }
            try clearPending(operation)
            notice = "The stale pending record was cleared after review. Its old request can no longer commit at the newer library revision. Your draft is kept."
            error = nil; return true
        } catch { self.error = "The current library revision could not be verified. The pending operation was kept."; return false }
    }

    private func requirePendingOwner(_ operation: JSONValue) throws {
        // Empty libraries have no component owner to pin. Credential identity
        // plus the authenticated scoped GET remains authoritative in that case.
        if let pendingOwner = operation["ownerUserID"].optionalString, let ownerUserID, !NativeComponentContract.same(pendingOwner, ownerUserID) {
            throw NativeFailure("The pending operation belongs to another component owner.")
        }
    }
}
