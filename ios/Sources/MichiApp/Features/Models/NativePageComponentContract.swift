import Foundation
import MichiCore

/// Classification, ownership, and host data for registered custom components.
/// Raw HTML/script is never treated as a runnable host. Workspace and page
/// identity are UTF-8 exact and never guessed from a block.
enum NativePageComponentContract {
    static func exact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    static func hasRawCustomScript(_ value: JSONValue) -> Bool {
        if !value["html"].stringValue.isEmpty { return true }
        if !value["javascript"].stringValue.isEmpty { return true }
        if value["type"].stringValue == "component", !value["code"].stringValue.isEmpty { return true }
        if !value["config"]["html"].stringValue.isEmpty { return true }
        if !value["config"]["javascript"].stringValue.isEmpty { return true }
        return false
    }

    static func registeredComponentID(_ block: JSONValue) -> String? {
        guard block["type"].stringValue == "component" else { return nil }
        let id = block["componentId"].stringValue
        return id.isEmpty ? nil : id
    }

    static func canHostRegisteredComponent(_ block: JSONValue) -> Bool {
        registeredComponentID(block) != nil && !hasRawCustomScript(block)
    }

    static func registeredCustomViewComponentID(_ view: JSONValue) -> String? {
        guard view["type"].stringValue == "custom" else { return nil }
        if !view["config"]["code"].stringValue.isEmpty { return nil }
        if hasRawCustomScript(view) { return nil }
        let id = view["config"]["componentId"].stringValue
        return id.isEmpty ? nil : id
    }

    static func canHostRegisteredCustomView(_ view: JSONValue) -> Bool {
        registeredCustomViewComponentID(view) != nil
    }

    /// `props.databaseId` plus `props.databaseIds`, first 20 unique non-empty ids.
    /// These are the web CustomBlock allowlist keys. This contract does not load
    /// full database DTOs for them.
    static func allowedDatabaseIDs(from props: JSONValue) -> [String] {
        var ids: [String] = []
        var seen = Set<Data>()
        func add(_ raw: String) {
            guard !raw.isEmpty, seen.insert(Data(raw.utf8)).inserted else { return }
            ids.append(raw)
        }
        if let id = props["databaseId"].optionalString { add(id) }
        for value in props["databaseIds"].arrayValue { add(value.stringValue) }
        return Array(ids.prefix(20))
    }

    static func objectProps(_ value: JSONValue) -> JSONValue {
        if case .object = value { return value }
        return [:]
    }

    static func pinnedVersion(_ value: JSONValue) -> Int? {
        guard case .number(let number) = value, let version = Int(exactly: number), version > 0 else { return nil }
        return version
    }

    static func databaseTitle(_ database: JSONValue) -> String {
        if let title = database["title"].optionalString, !title.isEmpty { return title }
        if let name = database["name"].optionalString, !name.isEmpty { return name }
        return ""
    }

    static func usableDraft(_ text: String) -> String? {
        guard !text.isEmpty, text.count <= ComponentSandbox.draftCharacters else { return nil }
        return text
    }

    static func usablePageID(_ pageID: String) -> String? {
        pageID.isEmpty ? nil : pageID
    }

    static func isDatabaseReadOnly(_ database: JSONValue) -> Bool {
        database["readOnly"] == true || database["editable"] == false
    }

    static func validatedDatabaseIdentity(database: JSONValue, expectedID: String, workspaceID: String) -> Bool {
        !expectedID.isEmpty && !workspaceID.isEmpty
            && exact(database.id, expectedID)
            && exact(database["workspaceId"].stringValue, workspaceID)
            && database["revision"].intValue > 0
    }

    static func hostScope(
        connectionIdentity: String,
        credentialIdentity: String,
        workspaceID: String,
        host: JSONValue,
        componentID: String
    ) -> String {
        [
            connectionIdentity,
            credentialIdentity,
            workspaceID,
            host["kind"].stringValue,
            host["pageId"].stringValue,
            host["blockId"].stringValue,
            host["databaseId"].stringValue,
            host["viewId"].stringValue,
            componentID,
        ].map { Data($0.utf8).base64EncodedString() }.joined(separator: ".")
    }

    static func pageHost(
        ownership: NativePageComponentOwnership,
        block: JSONValue
    ) -> NativePageComponentPreparedHost? {
        guard ownership.allowsExecution,
              let componentID = registeredComponentID(block), canHostRegisteredComponent(block),
              ComponentSandbox.isID(.string(ownership.pageID)), ComponentSandbox.isID(.string(block.id))
        else { return nil }
        let host: JSONValue = [
            "kind": "page_block",
            "pageId": .string(ownership.pageID),
            "blockId": .string(block.id),
        ]
        guard ComponentSandbox.parseHost(host) != nil else { return nil }
        let props = objectProps(block["props"])
        return NativePageComponentPreparedHost(
            host: host,
            componentID: componentID,
            pinnedVersion: pinnedVersion(block["pinnedVersion"]),
            props: props,
            data: pageHostData(ownership: ownership, block: block),
            bindingKey: .array([block["rev"], block["edit"]]),
            initialHeight: ComponentSandbox.clampHeight(block["height"].featureOptionalNumber ?? Double(ComponentSandbox.heightMin)),
            scope: hostScope(
                connectionIdentity: ownership.connectionIdentity,
                credentialIdentity: ownership.credentialIdentity,
                workspaceID: ownership.workspaceID,
                host: host,
                componentID: componentID
            )
        )
    }

    /// Local `read.host` snapshot plus an empty `databases` map. Allowed
    /// database ids are recorded on `props`; full DTOs are not invented here.
    static func pageHostData(ownership: NativePageComponentOwnership, block: JSONValue) -> JSONValue {
        [
            "page": [
                "id": .string(ownership.pageID),
                "title": .string(ownership.title),
                "revision": .number(Double(ownership.revision)),
            ],
            "block": block,
            "databases": [:],
        ]
    }

    static func databaseHost(
        connectionIdentity: String,
        credentialIdentity: String,
        workspaceID: String,
        database: JSONValue,
        expectedDatabaseID: String,
        view: JSONValue,
        data: JSONValue
    ) -> NativePageComponentPreparedHost? {
        guard validatedDatabaseIdentity(database: database, expectedID: expectedDatabaseID, workspaceID: workspaceID),
              let componentID = registeredCustomViewComponentID(view),
              ComponentSandbox.isID(.string(database.id)), ComponentSandbox.isID(.string(view.id))
        else { return nil }
        let host: JSONValue = [
            "kind": "database_view",
            "databaseId": .string(database.id),
            "viewId": .string(view.id),
        ]
        guard ComponentSandbox.parseHost(host) != nil else { return nil }
        return NativePageComponentPreparedHost(
            host: host,
            componentID: componentID,
            pinnedVersion: pinnedVersion(view["config"]["pinnedVersion"]),
            props: objectProps(view["config"]["props"]),
            data: data,
            bindingKey: .array([view["config"], view["edit"]]),
            initialHeight: ComponentSandbox.clampHeight(view["config"]["height"].featureOptionalNumber ?? Double(ComponentSandbox.heightMin)),
            scope: hostScope(
                connectionIdentity: connectionIdentity,
                credentialIdentity: credentialIdentity,
                workspaceID: workspaceID,
                host: host,
                componentID: componentID
            )
        )
    }

    /// Web `CustomDatabaseView` data: saved view snapshot only, never a local draft.
    static func customDatabaseViewData(
        database: JSONValue,
        view: JSONValue,
        rows: [JSONValue],
        columns: [JSONValue],
        conversation: FeatureConversationLookup? = nil
    ) -> JSONValue {
        let config = featureEffectiveViewConfig(view, columns: columns)
        let visible = featureApplyView(rows: rows, columns: columns, config: config, conversation: conversation)
        let groups = featureBoardGroups(rows: visible, columns: columns, config: config)
        return [
            "database": [
                "id": .string(database.id),
                "title": .string(databaseTitle(database)),
                "revision": .number(Double(database["revision"].intValue)),
            ],
            "columns": .array(columns),
            "groups": .array(groups.map { group -> JSONValue in
                [
                    "key": group.key.map { .string($0) } ?? .null,
                    "label": .string(group.label),
                    "rows": .array(group.rows),
                ]
            }),
            "rows": .array(groups.flatMap(\.rows)),
        ]
    }
}

struct NativePageComponentPreparedHost: Equatable {
    let host: JSONValue
    let componentID: String
    let pinnedVersion: Int?
    let props: JSONValue
    let data: JSONValue
    let bindingKey: JSONValue
    let initialHeight: Int
    let scope: String
}

struct NativePageComponentOwnership: Equatable {
    var connectionIdentity: String
    var credentialIdentity: String
    var workspaceID: String
    var pageID: String
    var expectedID: String
    var title: String
    var revision: Int
    var readOnly: Bool
    var available: Bool

    var allowsExecution: Bool {
        available
            && NativePageComponentContract.exact(pageID, expectedID)
            && !workspaceID.isEmpty
            && !pageID.isEmpty
            && revision > 0
    }
}

enum NativeDatabaseBoardDropAction: Equatable {
    case moveOnto(String)
    case transfer(index: Int)
}

/// Main-board drop planning only. The database model still validates identity,
/// revision, sorted/read-only/unknown/multiselect rules before any request.
enum NativeDatabaseBoardDrop {
    static func exact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    static func action(
        item: DatabaseOrderingDragItem,
        group: DatabaseOrderingGroup,
        ontoRowID: String?
    ) -> NativeDatabaseBoardDropAction? {
        guard item.kind == .row, !item.id.isEmpty else { return nil }
        if let ontoRowID {
            guard group.rows.contains(where: { exact($0.id, ontoRowID) }) else { return nil }
            if let source = item.group, exact(source, group.id) {
                return exact(item.id, ontoRowID) ? nil : .moveOnto(ontoRowID)
            }
            let index = group.rows.firstIndex(where: { exact($0.id, ontoRowID) }) ?? group.rows.count
            return .transfer(index: index)
        }
        if let source = item.group, exact(source, group.id) { return nil }
        return .transfer(index: group.rows.count)
    }

    static func accepts(_ rejection: String?) -> Bool { rejection == nil }
}

struct NativePageComponentActions {
    var onNavigatePage: ((String) -> Void)?
    var onAskDraft: ((String) -> Void)?

    static let unused = NativePageComponentActions(onNavigatePage: nil, onAskDraft: nil)

    var navigationHandler: ((String) -> Void)? { onNavigatePage == nil ? nil : navigate }
    var draftHandler: ((String) -> Void)? { onAskDraft == nil ? nil : draft }

    func navigate(_ pageID: String) {
        guard let id = NativePageComponentContract.usablePageID(pageID) else { return }
        onNavigatePage?(id)
    }

    func draft(_ text: String) {
        guard let usable = NativePageComponentContract.usableDraft(text) else { return }
        onAskDraft?(usable)
    }
}
