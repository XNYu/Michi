import Foundation
import Combine
import CryptoKit
import MichiCore

/// Height choice for a custom view binding. User `view.save` writes must pin a
/// version; height stays optional and is never invented.
enum NativeComponentViewHeight: Equatable {
    case keep
    case clear
    case set(Int)
}

/// Dedicated custom-view binding. Builds `view.save` without
/// `featureSanitizedViewConfig`, which would strip `componentId`.
enum NativeComponentDatabaseBinding {
    static let heightMin = ComponentSandbox.heightMin
    static let heightMax = ComponentSandbox.heightMax
    static let propsBytes = ComponentSandbox.propsBytes
    static let maxViews = 50
    static let rawScriptKeys = ["code", "html", "javascript"]

    static func exact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    /// Sorted JSON bytes. String values compare as encoded UTF-8, not Unicode
    /// canonical equivalence. A missing key is not equal to a present key.
    static func sortedJSON(_ value: JSONValue) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    static func exactJSON(_ a: JSONValue, _ b: JSONValue) -> Bool {
        guard let left = try? sortedJSON(a), let right = try? sortedJSON(b) else { return false }
        return left.elementsEqual(right)
    }

    static func firstView(_ views: [JSONValue], id: String) -> JSONValue? {
        views.first { exact($0.id, id) }
    }

    static func uniqueName(_ base: String, views: [JSONValue]) -> String {
        let trimmed = String(base.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        let seed = trimmed.isEmpty ? "Custom" : trimmed
        let names = Set(views.map { $0["name"].stringValue })
        if !names.contains(seed) { return seed }
        var index = 2
        var name = "\(seed) \(index)"
        while names.contains(name) {
            index += 1
            name = "\(seed) \(index)"
        }
        return name
    }

    static func parseProps(_ text: String) throws -> JSONValue {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= propsBytes else {
            throw FeatureRequestError(message: "Properties must be a JSON object smaller than 64 KB.")
        }
        let value: JSONValue
        do { value = try JSONValue.parse(trimmed) } catch {
            throw FeatureRequestError(message: "Properties are not valid JSON.")
        }
        return try requireProps(value)
    }

    static func requireProps(_ value: JSONValue) throws -> JSONValue {
        guard case .object = value, ComponentSandbox.bounded(value) else {
            throw FeatureRequestError(message: "Properties must be a JSON object smaller than 64 KB.")
        }
        let encoded = value.prettyPrinted
        guard encoded.utf8.count <= propsBytes else {
            throw FeatureRequestError(message: "Properties must be a JSON object smaller than 64 KB.")
        }
        return value
    }

    static func requirePinnedVersion(_ version: Int, component: JSONValue) throws -> Int {
        let latest = component["versions"].intValue
        guard version >= 1, latest >= 1, version <= latest else {
            throw FeatureRequestError(message: "Choose an existing immutable component version. User custom views must pin a version.")
        }
        return version
    }

    static func requireComponent(_ component: JSONValue, workspaceID: String) throws -> JSONValue {
        guard ComponentSandbox.isID(.string(component.id)),
              exact(component["workspaceId"].stringValue, workspaceID),
              component["enabled"] == true
        else {
            throw FeatureRequestError(message: "Choose an enabled workspace component before binding this view.")
        }
        return component
    }

    static func requireName(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= 100 else {
            throw FeatureRequestError(message: "Enter a view name.")
        }
        return trimmed
    }

    static func requireHeight(_ height: Int) throws -> Int {
        guard height >= heightMin, height <= heightMax else {
            throw FeatureRequestError(message: "Saved height must be between \(heightMin) and \(heightMax).")
        }
        return height
    }

    static func boundConfig(
        existing: JSONValue,
        componentID: String,
        pinnedVersion: Int,
        props: JSONValue,
        height: NativeComponentViewHeight
    ) throws -> JSONValue {
        guard ComponentSandbox.isID(.string(componentID)), pinnedVersion >= 1 else {
            throw FeatureRequestError(message: "Choose a workspace component and pin an existing version.")
        }
        let props = try requireProps(props)
        var fields = existing.objectValue
        if fields["filters"] == nil { fields["filters"] = .array([]) }
        if fields["match"] == nil { fields["match"] = "all" }
        if fields["sorts"] == nil { fields["sorts"] = .array([]) }
        for key in rawScriptKeys { fields.removeValue(forKey: key) }
        fields["componentId"] = .string(componentID)
        fields["pinnedVersion"] = .number(Double(pinnedVersion))
        fields["props"] = props
        switch height {
        case .keep:
            break
        case .clear:
            fields.removeValue(forKey: "height")
        case .set(let value):
            fields["height"] = .number(Double(try requireHeight(value)))
        }
        return .object(fields)
    }

    static func saveOperation(id: String, name: String, config: JSONValue) throws -> JSONValue {
        let name = try requireName(name)
        guard ComponentSandbox.isID(.string(id)), id.utf16.count <= 200, case .object = config else {
            throw FeatureRequestError(message: "This view could not be read safely. Reload before editing.")
        }
        return [
            "op": "view.save",
            "view": [
                "id": .string(id),
                "name": .string(name),
                "type": "custom",
                "config": config,
            ],
        ]
    }

    static func bindOperation(
        view: JSONValue,
        name: String? = nil,
        componentID: String,
        pinnedVersion: Int,
        props: JSONValue,
        height: NativeComponentViewHeight
    ) throws -> JSONValue {
        guard view["type"].stringValue == "custom", ComponentSandbox.isID(.string(view.id)), case .object = view["config"] else {
            throw FeatureRequestError(message: "Bind an existing custom view, or create a new custom view.")
        }
        let config = try boundConfig(
            existing: view["config"],
            componentID: componentID,
            pinnedVersion: pinnedVersion,
            props: props,
            height: height
        )
        return try saveOperation(id: view.id, name: name ?? view["name"].stringValue, config: config)
    }

    static func createOperation(
        database: JSONValue,
        id: String,
        name: String,
        componentID: String,
        pinnedVersion: Int,
        props: JSONValue,
        height: NativeComponentViewHeight
    ) throws -> JSONValue {
        let views = database["views"].arrayValue
        guard views.count < maxViews, firstView(views, id: id) == nil else {
            throw FeatureRequestError(message: "The database cannot add another view.")
        }
        let config = try boundConfig(
            existing: featureEmptyViewConfig(),
            componentID: componentID,
            pinnedVersion: pinnedVersion,
            props: props,
            height: height == .keep ? .clear : height
        )
        return try saveOperation(id: id, name: uniqueName(name, views: views), config: config)
    }

    /// Full intended config, including absent keys. `applyPageDatabaseOps` adds
    /// `edit` and `position` on the view, not inside `config`. `pinHumanDatabaseViews`
    /// only writes `config.pinnedVersion` when a human-edited custom view has
    /// none; this builder always pins, so confirmation compares config exactly.
    static func matches(_ operation: JSONValue, database: JSONValue) -> Bool {
        guard operation["op"].stringValue == "view.save",
              let saved = firstView(database["views"].arrayValue, id: operation["view"].id)
        else { return false }
        let expected = operation["view"]
        return exact(saved["name"].stringValue, expected["name"].stringValue)
            && exact(saved["type"].stringValue, expected["type"].stringValue)
            && exactJSON(saved["config"], expected["config"])
    }

    static func definiteRejection(_ error: Error) -> Bool {
        guard let error = error as? MichiAPIError else { return false }
        if let code = error.code, [
            MichiAPIError.Code.invalidConfiguration,
            MichiAPIError.Code.invalidPath,
            MichiAPIError.Code.invalidRequest,
            MichiAPIError.Code.insecureURL,
        ].contains(code) { return true }
        if let status = error.statusCode, [401, 403, 404].contains(status) { return true }
        return [400, 409].contains(error.statusCode ?? 0) && ["invalid", "not_found", "stale_revision"].contains(error.code ?? "")
    }

    static func newViewID() -> String {
        "view-" + UUID().uuidString.lowercased()
    }
}

/// Durable per-connection/credential/workspace/database reservation written
/// before POST. No replay token. Pattern matches NativeComponentMutationJournal
/// (DatabaseOrderingModel still uses UserDefaults and was not edited).
final class NativeComponentBindingJournal: @unchecked Sendable {
    static let maxBytes = 1_048_576
    private static let lock = NSLock()
    let directory: URL?

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Michi/ComponentBinding.v1", isDirectory: true)
    }

    func fileURL(scope: JSONValue) throws -> URL {
        guard let directory else { throw FeatureRequestError(message: "Local operation storage is unavailable. Nothing was submitted.") }
        return directory.appendingPathComponent(try scopeHash(scope) + ".json")
    }

    func load(scope: JSONValue) throws -> JSONValue? {
        Self.lock.lock(); defer { Self.lock.unlock() }
        return try read(scope: scope)
    }

    func reserve(_ pending: JSONValue, scope: JSONValue) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard try read(scope: scope) == nil, let directory else {
            throw FeatureRequestError(message: "A custom view change is already pending. Check its result before making another change.")
        }
        try validate(pending, scope: scope)
        let envelope: JSONValue = ["format": 1, "scope": scope, "pending": pending]
        let data = try JSONEncoder().encode(envelope)
        guard data.count <= Self.maxBytes else {
            throw FeatureRequestError(message: "This custom view change is too large to save safely.")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = try fileURL(scope: scope)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }; try handle.synchronize()
        guard let stored = try read(scope: scope), NativeComponentDatabaseBinding.exactJSON(stored, pending) else {
            throw FeatureRequestError(message: "The pending custom view change could not be verified. Nothing was submitted.")
        }
    }

    func clear(_ pending: JSONValue, scope: JSONValue) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let saved = try read(scope: scope) else { return }
        guard NativeComponentDatabaseBinding.exactJSON(saved, pending) else {
            throw FeatureRequestError(message: "Another pending custom view change was kept.")
        }
        try FileManager.default.removeItem(at: try fileURL(scope: scope))
    }

    /// Explicit forget only. Removes this scope's file even when the record is unreadable.
    func forget(scope: JSONValue) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        let url = try fileURL(scope: scope)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    private func scopeHash(_ scope: JSONValue) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(scope)).map { String(format: "%02x", $0) }.joined()
    }

    private func read(scope: JSONValue) throws -> JSONValue? {
        let url = try fileURL(scope: scope)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size, size.intValue <= Self.maxBytes else {
            throw FeatureRequestError(message: "The pending custom view change could not be read. New changes remain blocked.")
        }
        let envelope: JSONValue
        do { envelope = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)) } catch {
            throw FeatureRequestError(message: "The pending custom view change could not be read. New changes remain blocked.")
        }
        let pending = envelope["pending"]
        guard envelope["format"] == 1,
              NativeComponentDatabaseBinding.exactJSON(envelope["scope"], scope)
        else {
            throw FeatureRequestError(message: "The pending custom view change has an invalid identity. New changes remain blocked.")
        }
        try validate(pending, scope: scope)
        return pending
    }

    private func validate(_ pending: JSONValue, scope: JSONValue) throws {
        let operation = pending["operation"]
        let viewID = operation["view"].id
        let selectViewID = pending["selectViewId"].stringValue
        guard NativeComponentDatabaseBinding.exact(pending["databaseId"].stringValue, scope["databaseID"].stringValue),
              NativeComponentDatabaseBinding.exact(pending["workspaceId"].stringValue, scope["workspaceID"].stringValue),
              pending["revision"].intValue > 0,
              operation["op"].stringValue == "view.save",
              ComponentSandbox.isID(.string(viewID)),
              ComponentSandbox.isID(.string(selectViewID)),
              NativeComponentDatabaseBinding.exact(selectViewID, viewID),
              case .object = operation["view"]["config"]
        else {
            throw FeatureRequestError(message: "The pending custom view change has an invalid identity. New changes remain blocked.")
        }
    }
}

@MainActor
final class NativeComponentDatabaseBindingModel: ObservableObject {
    let model: FeatureDatabaseModel
    let journal: NativeComponentBindingJournal
    @Published private(set) var access = false
    @Published private(set) var pending: JSONValue?
    @Published private(set) var journalIssue: String?
    @Published private(set) var notice: String?
    @Published var name = ""
    @Published var componentID = ""
    @Published var pinnedVersion = 0
    @Published var propsText = "{}"
    @Published var heightText = ""
    @Published var clearHeight = false

    var scope: JSONValue {
        [
            "connection": .string(model.api.baseURL.absoluteString),
            "credentialIdentity": .string(model.api.credentialIdentityFingerprint),
            "workspaceID": .string(model.workspaceId),
            "databaseID": .string(model.databaseId),
        ]
    }

    var disabled: Bool {
        !access
            || model.loading
            || model.saving
            || model.viewDirty
            || pending != nil
            || journalIssue != nil
            || model.orderingPending != nil
            || DatabaseManagement.restriction(model.database) != nil
    }

    var canBindSelected: Bool { model.selectedView["type"].stringValue == "custom" }

    init(model: FeatureDatabaseModel, journal: NativeComponentBindingJournal = .init()) {
        self.model = model
        self.journal = journal
        restorePending()
        adoptSelectedView()
    }

    func adoptSelectedView() {
        let view = model.selectedView
        name = view["type"].stringValue == "custom" ? view["name"].stringValue : "Custom"
        componentID = view["config"]["componentId"].stringValue
        pinnedVersion = NativePageComponentContract.pinnedVersion(view["config"]["pinnedVersion"]) ?? 0
        if case .object = view["config"]["props"] {
            propsText = view["config"]["props"].prettyPrinted
        } else {
            propsText = "{}"
        }
        if let height = ComponentSandbox.safeInteger(view["config"]["height"]) {
            heightText = String(height)
        } else {
            heightText = ""
        }
        clearHeight = false
    }

    func adoptLibraryInsert(_ component: JSONValue, version: Int, props: JSONValue) -> Bool {
        do {
            _ = try NativeComponentDatabaseBinding.requireComponent(component, workspaceID: model.workspaceId)
            pinnedVersion = try NativeComponentDatabaseBinding.requirePinnedVersion(version, component: component)
            componentID = component.id
            propsText = try NativeComponentDatabaseBinding.requireProps(props).prettyPrinted
            model.error = nil
            return true
        } catch {
            model.error = featureErrorMessage(error)
            return false
        }
    }

    /// Picker / pre-submit identity. Keeps the current pin when `version` is omitted.
    func selectComponent(_ component: JSONValue, version: Int? = nil) -> Bool {
        do {
            let checked = try NativeComponentDatabaseBinding.requireComponent(component, workspaceID: model.workspaceId)
            let requested = version ?? (pinnedVersion >= 1 ? pinnedVersion : checked["activeVersion"].intValue)
            pinnedVersion = try NativeComponentDatabaseBinding.requirePinnedVersion(requested, component: checked)
            componentID = checked.id
            model.error = nil
            return true
        } catch {
            model.error = featureErrorMessage(error)
            return false
        }
    }

    private func restorePending() {
        do {
            pending = try journal.load(scope: scope)
            journalIssue = nil
        } catch {
            pending = nil
            journalIssue = "The pending custom view change could not be read. New changes remain blocked."
        }
    }

    private func snapshot() async throws -> JSONValue {
        access = false
        let graph = WorkspaceGraph(raw: try await model.api.request("/workspaces/\(MichiAPI.pathSegment(model.workspaceId))"))
        guard NativeComponentDatabaseBinding.exact(graph.id, model.workspaceId),
              !graph.isDeleted, !graph.isArchived, !graph.isSystem
        else {
            throw FeatureRequestError(message: "This database's workspace is unavailable or read-only.")
        }
        let database = try featureRequireDatabase(await model.api.request("/databases/\(MichiAPI.pathSegment(model.databaseId))"))
        guard NativeComponentDatabaseBinding.exact(database.id, model.databaseId),
              NativeComponentDatabaseBinding.exact(database["workspaceId"].stringValue, model.workspaceId),
              case .array = database["views"], case .array = database["columns"], case .array = database["rows"]
        else {
            throw FeatureRequestError(message: "The database snapshot did not match this workspace.")
        }
        if let reason = DatabaseManagement.restriction(database) { throw FeatureRequestError(message: reason) }
        access = true
        return database
    }

    func refresh() async {
        guard !model.loading, !model.saving else { return }
        model.loading = true
        defer { model.loading = false }
        restorePending()
        do {
            let latest = try await snapshot()
            guard !Task.isCancelled else { return }
            model.applyOrderedDatabase(latest)
            if journalIssue == nil,
               let pending,
               latest["revision"].intValue > pending["revision"].intValue,
               NativeComponentDatabaseBinding.matches(pending["operation"], database: latest) {
                let selected = pending["selectViewId"].stringValue
                try clearReserved(pending)
                if !selected.isEmpty { model.selectView(selected) }
                adoptSelectedView()
                notice = "The saved change is confirmed."
            }
            model.error = nil
        } catch {
            access = false
            model.error = featureErrorMessage(error)
        }
    }

    func bindSelectedView() async -> Bool {
        do {
            return await apply(try makeBindOperation(database: model.database), selectViewId: model.selectedView.id)
        } catch {
            model.error = featureErrorMessage(error)
            return false
        }
    }

    func createCustomView() async -> Bool {
        do {
            let id = NativeComponentDatabaseBinding.newViewID()
            return await apply(try makeCreateOperation(database: model.database, id: id), selectViewId: id)
        } catch {
            model.error = featureErrorMessage(error)
            return false
        }
    }

    func makeBindOperation(database: JSONValue) throws -> JSONValue {
        guard let view = NativeComponentDatabaseBinding.firstView(database["views"].arrayValue, id: model.selectedView.id),
              NativeComponentDatabaseBinding.exactJSON(view, model.selectedView)
        else {
            throw FeatureRequestError(message: "This view changed. Review the latest view before editing.")
        }
        return try NativeComponentDatabaseBinding.bindOperation(
            view: view,
            name: name,
            componentID: componentID,
            pinnedVersion: pinnedVersion,
            props: try NativeComponentDatabaseBinding.parseProps(propsText),
            height: heightChoice(forExisting: true)
        )
    }

    func makeCreateOperation(database: JSONValue, id: String) throws -> JSONValue {
        try NativeComponentDatabaseBinding.createOperation(
            database: database,
            id: id,
            name: name,
            componentID: componentID,
            pinnedVersion: pinnedVersion,
            props: try NativeComponentDatabaseBinding.parseProps(propsText),
            height: heightChoice(forExisting: false)
        )
    }

    private func heightChoice(forExisting: Bool) throws -> NativeComponentViewHeight {
        let trimmed = heightText.trimmingCharacters(in: .whitespacesAndNewlines)
        if clearHeight { return .clear }
        if trimmed.isEmpty { return forExisting ? .keep : .clear }
        guard let value = Int(trimmed) else {
            throw FeatureRequestError(message: "Saved height must be between \(NativeComponentDatabaseBinding.heightMin) and \(NativeComponentDatabaseBinding.heightMax).")
        }
        return .set(try NativeComponentDatabaseBinding.requireHeight(value))
    }

    private func apply(_ operation: JSONValue, selectViewId: String) async -> Bool {
        restorePending()
        guard journalIssue == nil, !disabled, model.revision > 0 else {
            if journalIssue != nil {
                model.error = journalIssue
            } else if pending != nil {
                model.error = "The last custom view change is unconfirmed. Refresh to check it; it will not be submitted again."
            }
            return false
        }
        let revision = model.revision
        model.saving = true
        notice = nil
        defer { model.saving = false }
        var reserved: JSONValue?
        do {
            let latest = try await snapshot()
            model.applyOrderedDatabase(latest)
            guard !Task.isCancelled else { return false }
            guard latest["revision"].intValue == revision, !model.viewDirty else {
                throw FeatureRequestError(message: "The database changed. Review the refreshed state before applying this edit.")
            }
            if NativeComponentDatabaseBinding.matches(operation, database: latest) {
                model.selectView(selectViewId)
                adoptSelectedView()
                model.error = nil
                notice = "Saved."
                return true
            }
            let record: JSONValue = [
                "databaseId": .string(model.databaseId),
                "workspaceId": .string(model.workspaceId),
                "revision": .number(Double(revision)),
                "operation": operation,
                "selectViewId": .string(selectViewId),
            ]
            try journal.reserve(record, scope: scope)
            reserved = record
            pending = record
            let result = try await model.api.request(
                "/databases/\(MichiAPI.pathSegment(model.databaseId))/edits",
                method: "POST",
                body: ["revision": .number(Double(revision)), "ops": .array([operation])]
            )
            let saved = try featureRequireDatabase(result)
            guard NativeComponentDatabaseBinding.exact(saved.id, model.databaseId),
                  NativeComponentDatabaseBinding.exact(saved["workspaceId"].stringValue, model.workspaceId),
                  saved["revision"].intValue >= revision + 1,
                  case .array = saved["views"], case .array = saved["columns"], case .array = saved["rows"],
                  result["changes"]["rejected"].arrayValue.isEmpty,
                  NativeComponentDatabaseBinding.matches(operation, database: saved)
            else {
                throw FeatureRequestError(message: "The saved change could not be confirmed. Refresh to check it.")
            }
            model.applyOrderedDatabase(saved)
            model.selectView(selectViewId)
            adoptSelectedView()
            try clearReserved(record)
            model.error = nil
            notice = "Saved."
            return true
        } catch {
            if let reserved, NativeComponentDatabaseBinding.definiteRejection(error) {
                do { try clearReserved(reserved) } catch {
                    journalIssue = "The rejected change's local record could not be cleared."
                }
            } else {
                reloadPending()
            }
            model.error = featureErrorMessage(error) + (pending == nil && journalIssue == nil ? "" : " The change may already be saved; it has not been retried.")
            return false
        }
    }

    private func clearReserved(_ record: JSONValue) throws {
        try journal.clear(record, scope: scope)
        if pending.map({ NativeComponentDatabaseBinding.exactJSON($0, record) }) != false {
            pending = nil
        }
        journalIssue = nil
    }

    private func reloadPending() {
        do {
            pending = try journal.load(scope: scope)
            journalIssue = nil
        } catch {
            pending = nil
            journalIssue = "The pending custom view change could not be read. New changes remain blocked."
        }
    }

    func forgetPending() {
        guard !model.loading, !model.saving else { return }
        do {
            try journal.forget(scope: scope)
            pending = nil
            journalIssue = nil
            notice = "The local pending record was forgotten. The original edit may still finish."
        } catch {
            model.error = featureErrorMessage(error)
        }
    }
}
