#if DEBUG
import Foundation
import MichiCore

/// Isolated DEBUG HTTP for the newly authorized custom-component runtime.
/// Synthetic only: no host backend, agent, network, or production writes.
/// Unknown hosts stay with FixtureURLProtocol (403). Unknown routes return nil
/// and fail closed. Mint/call/delete never replay a failed write.
enum NativeComponentRuntimeFixtures {
    struct Response {
        let value: JSONValue
        var status = 200
        var empty = false
        var transportFailure = false
    }

    static var args: [String] { ProcessInfo.processInfo.arguments }
    static var page: Bool { args.contains("--preview-parity-component") }
    static var library: Bool { args.contains("--preview-parity-component-library") }
    static var databaseView: Bool { args.contains("--preview-parity-component-db") }
    static var stale: Bool { args.contains("--preview-parity-component-stale") }
    static var disabled: Bool { args.contains("--preview-parity-component-disabled") }
    static var unknownWrite: Bool { args.contains("--preview-parity-component-unknown-write") }
    static var sheet: Bool { page || library || databaseView }
    static var active: Bool { sheet || stale || disabled || unknownWrite }

    static let workspaceID = NativeParityFixtures.workspaceID
    static let calculatorID = "component-calculator"
    static let databaseComponentID = "component-db-demo"
    static let calculatorPageID = "page-calculator"
    static let calculatorBlockID = "block-calculator"
    static let customViewID = "view-custom"
    static let ownerUserID = "fixture-owner"
    static let tokenTTLMilliseconds: Double = 120_000

    /// Restricted-document calculator: allowlisted `createElement` + input/button/textContent.
    static let calculatorCodeV1 = """
    const title = document.createElement('h3');
    title.textContent = props.title || 'Calculator';
    root.appendChild(title);
    """

    static let calculatorCode = """
    const heading = document.createElement('h3');
    heading.textContent = props.title || 'Calculator';
    const left = document.createElement('input');
    left.setAttribute('type', 'text');
    left.setAttribute('value', '2');
    left.setAttribute('aria-label', 'Left');
    const right = document.createElement('input');
    right.setAttribute('type', 'text');
    right.setAttribute('value', '3');
    right.setAttribute('aria-label', 'Right');
    let leftValue = '2';
    let rightValue = '3';
    left.addEventListener('input', function (event) { leftValue = event.target.value; });
    right.addEventListener('input', function (event) { rightValue = event.target.value; });
    const out = document.createElement('div');
    out.setAttribute('aria-live', 'polite');
    out.textContent = '5';
    const button = document.createElement('button');
    button.textContent = 'Add';
    button.addEventListener('click', function () {
      out.textContent = String(Number(leftValue) + Number(rightValue));
    });
    root.appendChild(heading);
    root.appendChild(left);
    root.appendChild(right);
    root.appendChild(button);
    root.appendChild(out);
    """

    /// Custom database view: reads the bound database, shows the row count, and
    /// updates one row with the current `expectRev`. No host/agent/network.
    static let databaseViewCode = """
    call('resize', 240);
    const heading = document.createElement('h3');
    heading.textContent = 'Release rows';
    const count = document.createElement('div');
    count.textContent = 'Loading…';
    const status = document.createElement('div');
    const button = document.createElement('button');
    button.textContent = 'Mark Native Home done';
    let snapshot = null;
    function show(database) {
      snapshot = database;
      const rows = (database && database.rows) || [];
      count.textContent = 'Rows: ' + rows.length;
    }
    button.addEventListener('click', function () {
      const rows = (snapshot && snapshot.rows) || [];
      const row = rows.find(function (item) { return item.id === 'r-ui'; }) || rows[0];
      if (!row) { status.textContent = 'No row'; return; }
      call('write.rows', [{ op: 'row.update', id: row.id, expectRev: row.rev, values: { status: 'done' } }])
        .then(function (result) {
          const applied = result && result.applied && result.applied.length;
          const proposed = result && result.proposed && result.proposed.length;
          status.textContent = applied ? 'Applied' : (proposed ? 'Proposed' : 'No change');
          return call('read.database');
        })
        .then(show)
        .catch(function (error) { status.textContent = String(error && error.message || error); });
    });
    root.appendChild(heading);
    root.appendChild(count);
    root.appendChild(button);
    root.appendChild(status);
    call('read.database').then(show).catch(function (error) {
      count.textContent = String(error && error.message || error);
    });
    """

    static let calculatorHost: JSONValue = [
        "kind": "page_block", "pageId": .string(calculatorPageID), "blockId": .string(calculatorBlockID)
    ]
    static let databaseHost: JSONValue = [
        "kind": "database_view", "databaseId": .string(NativeParityFixtures.databaseID), "viewId": .string(customViewID)
    ]
    static let calculatorProps: JSONValue = ["title": "Add"]
    static let databaseProps: JSONValue = [:]

    private static let lock = NSRecursiveLock()
    private static var tokens: [String: Token] = [:]

    private struct Token {
        var capability: String
        var expiresAt: Double
        var componentID: String
        var version: Int
        var host: JSONValue
        var props: JSONValue
        var allowedDatabaseIDs: [String]
        var enabled: Bool
        var calls: [Double]
    }

    static func withCustomView(_ database: JSONValue) -> JSONValue {
        var next = database
        var views = next["views"].arrayValue
        if !views.contains(where: { exact($0.id, customViewID) }) {
            views.append([
                "id": .string(customViewID),
                "name": "Custom",
                "type": "custom",
                "position": 2,
                "config": [
                    "filters": [],
                    "match": "all",
                    "sorts": [],
                    "componentId": .string(databaseComponentID),
                    "pinnedVersion": 1,
                    "props": databaseProps,
                    "visible": ["title", "status", "priority"]
                ]
            ])
            next["views"] = .array(views)
        }
        var rows = next["rows"].arrayValue
        if let index = rows.firstIndex(where: { exact($0.id, "r-review") }), rows[index]["edited"].objectValue["title"] == nil {
            var row = rows[index]
            var edited = row["edited"].objectValue
            edited["title"] = 1
            row["edited"] = .object(edited)
            rows[index] = row
            next["rows"] = .array(rows)
        }
        return next
    }

    static func response(path: String, method: String, url: URL, body: JSONValue) -> Response? {
        guard active else { return nil }
        if method == "GET" { return get(path: path, url: url) }
        if path == "/component-capabilities", method == "POST" { return mint(body) }
        if path.hasPrefix("/component-capabilities/"), method == "POST" {
            return call(capability: String(path.dropFirst("/component-capabilities/".count)), body: body)
        }
        if path.hasPrefix("/component-capabilities/"), method == "DELETE" {
            return revoke(capability: String(path.dropFirst("/component-capabilities/".count)))
        }
        return nil
    }

    private static func get(path: String, url: URL) -> Response? {
        if path == "/workspaces/\(workspaceID)/components" {
            return Response(value: ["revision": 5, "items": .array(libraryItems())])
        }
        if path.hasPrefix("/components/") {
            let parts = path.split(separator: "/").map(String.init)
            guard parts.count >= 2 else { return nil }
            let id = parts[1]
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let workspace = query.first(where: { $0.name == "workspaceId" })?.value ?? ""
            guard exact(workspace, workspaceID) || workspace.isEmpty else { return notFound("Component unavailable") }
            if parts.count == 3, parts[2] == "references" { return references(id) }
            if parts.count == 2 { return version(id: id, requested: query.first(where: { $0.name == "version" })?.value.flatMap(Int.init)) }
        }
        if path == "/pages/\(calculatorPageID)" { return Response(value: ["page": calculatorPage()]) }
        if path == "/databases/\(NativeParityFixtures.databaseID)", databaseView {
            return Response(value: ["database": NativeParityFixtures.liveDatabase()])
        }
        return nil
    }

    private static func libraryItems() -> [JSONValue] {
        var items: [JSONValue] = []
        if args.contains("--preview-components") { items.append(legacyPreviewComponent()) }
        if page || library || stale || disabled || unknownWrite {
            items.append(componentRecord(
                id: calculatorID, name: "calculator",
                description: "A saved workspace calculator that uses the restricted document API.",
                enabled: !disabled, activeVersion: 2, versions: 2
            ))
        }
        if databaseView || unknownWrite || stale {
            items.append(componentRecord(
                id: databaseComponentID, name: "release-rows",
                description: "A custom database view that reads rows and updates one with expectRev.",
                enabled: !disabled, activeVersion: 1, versions: 1
            ))
        }
        return items
    }

    private static func componentRecord(id: String, name: String, description: String, enabled: Bool, activeVersion: Int, versions: Int) -> JSONValue {
        [
            "id": .string(id),
            "ownerUserId": .string(ownerUserID),
            "workspaceId": .string(workspaceID),
            "name": .string(name),
            "description": .string(description),
            "enabled": .bool(enabled),
            "activeVersion": .number(Double(activeVersion)),
            "libraryRevision": 5,
            "revocationEpoch": 1,
            "deletedAt": .null,
            "versions": .number(Double(versions)),
            "createdAt": 1,
            "updatedAt": 2
        ]
    }

    private static func legacyPreviewComponent() -> JSONValue {
        ContinuationFixtures.component.merging(["libraryRevision": 5])
    }

    private static func version(id: String, requested: Int?) -> Response? {
        guard let binding = binding(for: id) else {
            if exact(id, ContinuationFixtures.component.id), args.contains("--preview-components") {
                let number = requested ?? 2
                return Response(value: [
                    "componentId": "component-preview",
                    "version": .number(Double(number)),
                    "code": "const title = document.createElement('h2');\ntitle.textContent = props.title;\nroot.appendChild(title);",
                    "propsSchema": ["type": "object", "properties": ["title": ["type": "string"]]],
                    "source": ["kind": "user"],
                    "createdAt": 2
                ])
            }
            return nil
        }
        if disabled || !binding.enabled { return notFound("Component unavailable") }
        let number = requested ?? binding.activeVersion
        guard number >= 1, number <= binding.versions else { return notFound("Component version is unavailable") }
        return Response(value: [
            "componentId": .string(id),
            "version": .number(Double(number)),
            "code": .string(code(for: id, version: number)),
            "propsSchema": binding.schema,
            "source": ["kind": "user"],
            "createdAt": 2
        ])
    }

    private static func references(_ id: String) -> Response? {
        if exact(id, calculatorID) {
            return Response(value: ["items": [[
                "componentId": .string(calculatorID),
                "workspaceId": .string(workspaceID),
                "kind": "page_block",
                "pageId": .string(calculatorPageID),
                "blockId": .string(calculatorBlockID),
                "pinnedVersion": 2,
                "protected": true,
                "hostRevision": 1
            ]]])
        }
        if exact(id, databaseComponentID) {
            return Response(value: ["items": [[
                "componentId": .string(databaseComponentID),
                "workspaceId": .string(workspaceID),
                "kind": "database_view",
                "databaseId": .string(NativeParityFixtures.databaseID),
                "viewId": .string(customViewID),
                "pinnedVersion": 1,
                "protected": false,
                "hostRevision": NativeParityFixtures.liveDatabase()["revision"]
            ]]])
        }
        if exact(id, ContinuationFixtures.component.id), args.contains("--preview-components") {
            return Response(value: ["items": [[
                "componentId": "component-preview", "workspaceId": .string(workspaceID),
                "kind": "page_block", "pageId": "page-preview", "blockId": "widget",
                "pinnedVersion": 2, "protected": true, "hostRevision": 1
            ]]])
        }
        return nil
    }

    private static func calculatorPage() -> JSONValue {
        [
            "id": .string(calculatorPageID),
            "workspaceId": .string(workspaceID),
            "title": "Saved calculator",
            "revision": 1,
            "blocks": [
                ["id": "calc-heading", "rev": 1, "type": "heading", "text": "Workspace calculator"],
                ["id": "calc-intro", "rev": 1, "type": "markdown", "text": "Edit either number and tap Add to calculate the result."],
                [
                    "id": .string(calculatorBlockID),
                    "rev": 1,
                    "type": "component",
                    "componentId": .string(calculatorID),
                    "pinnedVersion": 2,
                    "props": calculatorProps,
                    "height": 240
                ]
            ]
        ]
    }

    private static func mint(_ body: JSONValue) -> Response {
        guard exact(body["workspaceId"].stringValue, workspaceID),
              let binding = binding(for: body["componentId"].stringValue),
              let version = exactRevision(body["version"]),
              let host = parseHost(body["host"]),
              body.objectValue.keys.contains("props") else {
            return invalid("Invalid component host")
        }
        if disabled || !binding.enabled { return notFound("Component unavailable") }
        if version != binding.pinnedVersion { return staleRevision("Component version does not match the pinned host") }
        if host.kind == "page_block" {
            guard exact(binding.componentID, calculatorID), hostsEqual(host.json, calculatorHost) else {
                return notFound("Component host is unavailable")
            }
        } else {
            guard exact(binding.componentID, databaseComponentID), hostsEqual(host.json, databaseHost) else {
                return notFound("Component host is unavailable")
            }
        }
        let token = UUID().uuidString + UUID().uuidString
        let expiresAt = Date().timeIntervalSince1970 * 1000 + tokenTTLMilliseconds
        lock.lock(); defer { lock.unlock() }
        tokens[token] = Token(
            capability: token, expiresAt: expiresAt, componentID: binding.componentID, version: version,
            host: host.json, props: binding.props, allowedDatabaseIDs: binding.allowedDatabaseIDs,
            enabled: binding.enabled, calls: []
        )
        return Response(value: [
            "capability": .string(token),
            "expiresAt": .number(expiresAt),
            "componentId": .string(binding.componentID),
            "version": .number(Double(version)),
            "host": host.json,
            "props": binding.props
        ], status: 201)
    }

    private static func call(capability: String, body: JSONValue) -> Response {
        lock.lock()
        guard var token = tokens[capability] else {
            lock.unlock()
            return notFound("Component capability unavailable")
        }
        let now = Date().timeIntervalSince1970 * 1000
        if now >= token.expiresAt {
            tokens.removeValue(forKey: capability)
            lock.unlock()
            return notFound("Component capability expired")
        }
        if disabled || !token.enabled {
            tokens.removeValue(forKey: capability)
            lock.unlock()
            return notFound("Component capability was revoked")
        }
        if stale {
            lock.unlock()
            return staleRevision("Component host changed")
        }
        token.calls = token.calls.filter { now - $0 < 60_000 }
        if token.calls.count >= 60 {
            lock.unlock()
            return Response(value: error("stale_revision", "Component capability rate limit exceeded"), status: 409)
        }
        token.calls.append(now)
        tokens[capability] = token
        lock.unlock()

        let method = body["method"].stringValue
        guard ComponentSandbox.methods.contains(method) else { return invalid("Invalid component method") }
        if !body["resourceId"].isNull, body["resourceId"].optionalString == nil { return invalid("Invalid resourceId") }
        let args: [JSONValue]
        if body["args"].isNull { args = [] }
        else if case .array(let values) = body["args"] { args = values }
        else { return invalid("Invalid component arguments") }
        if (try? JSONEncoder().encode(JSONValue.array(args)))?.count ?? .max > 64_000 {
            return invalid("Invalid component request")
        }

        switch method {
        case "read.host":
            guard args.isEmpty else { return invalid("Invalid read.host arguments") }
            return Response(value: ["result": readHost(token)])
        case "read.database":
            guard args.isEmpty else { return invalid("Invalid read.database arguments") }
            let resource = body["resourceId"].optionalString ?? (hostKind(token.host) == "database_view" ? NativeParityFixtures.databaseID : nil)
            guard let resource, token.allowedDatabaseIDs.contains(where: { exact($0, resource) }) else {
                return notFound("Database is outside this component host scope")
            }
            return Response(value: ["result": NativeParityFixtures.liveDatabase()])
        case "resize":
            guard args.count == 1, let height = exactRevision(args[0]), height >= 80, height <= 1_600 else {
                return invalid("Invalid component height")
            }
            return Response(value: ["result": ["height": .number(Double(height))]])
        case "navigate.page":
            guard args.count == 1, let pageID = args[0].optionalString, !pageID.isEmpty, pageID.utf16.count <= 200 else {
                return invalid("Invalid page navigation")
            }
            guard authorizedPage(pageID) else { return notFound("Page is outside this component workspace") }
            return Response(value: ["result": ["pageId": .string(pageID)]])
        case "ask.draft":
            guard args.count == 1, let text = args[0].optionalString, !text.isEmpty, text.utf16.count <= 8_000 else {
                return invalid("Invalid draft request")
            }
            return Response(value: ["result": ["text": .string(text)]])
        case "write.rows":
            if hostKind(token.host) != "database_view" {
                return invalid("This component host cannot write database rows")
            }
            if unknownWrite {
                return Response(value: .null, transportFailure: true)
            }
            guard args.count == 1, case .array(let ops) = args[0], !ops.isEmpty, ops.count <= 200 else {
                return invalid("Invalid row write batch")
            }
            let resource = body["resourceId"].optionalString ?? NativeParityFixtures.databaseID
            guard token.allowedDatabaseIDs.contains(where: { exact($0, resource) }), exact(resource, NativeParityFixtures.databaseID) else {
                return notFound("Database is outside this component host scope")
            }
            return writeRows(ops, componentID: token.componentID, version: token.version, viewID: token.host["viewId"].stringValue)
        default:
            return invalid("Invalid component method")
        }
    }

    private static func revoke(capability: String) -> Response {
        lock.lock(); defer { lock.unlock() }
        tokens.removeValue(forKey: capability)
        return Response(value: .null, status: 204, empty: true)
    }

    private static func readHost(_ token: Token) -> JSONValue {
        if hostKind(token.host) == "page_block" {
            let page = calculatorPage()
            let block = page["blocks"].arrayValue.first { exact($0.id, calculatorBlockID) } ?? .null
            return ["page": ["id": .string(page.id), "title": page["title"], "revision": page["revision"]], "block": block]
        }
        let database = NativeParityFixtures.liveDatabase()
        let view = database["views"].arrayValue.first { exact($0.id, customViewID) } ?? .null
        return ["databaseId": .string(database.id), "view": view]
    }

    private static func writeRows(_ ops: [JSONValue], componentID: String, version: Int, viewID: String) -> Response {
        lock.lock(); defer { lock.unlock() }
        var database = NativeParityFixtures.liveDatabase()
        guard exact(database.id, NativeParityFixtures.databaseID),
              exact(database["workspaceId"].stringValue, workspaceID) else {
            return notFound("Database not found")
        }
        var applied: [JSONValue] = []
        var proposed: [JSONValue] = []
        var rejected: [JSONValue] = []
        var touched = Set<String>()
        let source: JSONValue = [
            "kind": "component",
            "componentId": .string(componentID),
            "version": .number(Double(version)),
            "databaseId": .string(database.id),
            "viewId": .string(viewID)
        ]
        for (index, op) in ops.enumerated() {
            switch op["op"].stringValue {
            case "row.add":
                if let failed = applyRowAdd(op, index: index, to: &database, applied: &applied, source: source) { rejected.append(failed) }
            case "row.update":
                if let failed = applyRowUpdate(op, index: index, to: &database, applied: &applied, proposed: &proposed, touched: &touched, source: source) {
                    rejected.append(failed)
                }
            case "row.delete":
                if let failed = applyRowDelete(op, index: index, to: &database, applied: &applied, proposed: &proposed, touched: &touched, source: source) {
                    rejected.append(failed)
                }
            default:
                rejected.append(rejection(index, "invalid", "Only row add, update and delete operations are supported"))
            }
        }
        NativeParityFixtures.replaceDatabase(database)
        return Response(value: ["result": [
            "resource": ["kind": "database", "id": .string(database.id)],
            "revision": database["revision"],
            "applied": .array(applied),
            "proposed": .array(proposed),
            "rejected": .array(rejected)
        ]])
    }

    private static func applyRowAdd(_ operation: JSONValue, index: Int, to database: inout JSONValue, applied: inout [JSONValue], source: JSONValue) -> JSONValue? {
        guard case .object(let values) = operation["values"] else {
            return rejection(index, "invalid", "Invalid row add")
        }
        var rows = database["rows"].arrayValue
        let nextRevision = database["revision"].intValue + 1
        let id = "r-component-\(rows.count + 1)"
        let row: JSONValue = [
            "id": .string(id),
            "rev": .number(Double(nextRevision)),
            "position": .number(Double(rows.count)),
            "values": .object(values)
        ]
        rows.append(row)
        database["rows"] = .array(rows)
        database["revision"] = .number(Double(nextRevision))
        applied.append(change(id: id, op: "row.add", appliedRev: nextRevision, values: values, proposal: false, source: source))
        return nil
    }

    private static func applyRowUpdate(_ operation: JSONValue, index: Int, to database: inout JSONValue, applied: inout [JSONValue], proposed: inout [JSONValue], touched: inout Set<String>, source: JSONValue) -> JSONValue? {
        let id = operation["id"].stringValue
        guard !id.isEmpty, case .object(let values) = operation["values"], !values.isEmpty,
              let expectRev = exactRevision(operation["expectRev"]) else {
            return rejection(index, "invalid", "Invalid row update")
        }
        if touched.contains(id) { return rejection(index, "invalid", "Duplicate row target \(id) in one call") }
        var rows = database["rows"].arrayValue
        guard let rowIndex = rows.firstIndex(where: { exact($0.id, id) }) else {
            return rejection(index, "missing", "Row \(id) does not exist")
        }
        let currentRev = rows[rowIndex]["rev"].intValue
        if currentRev != expectRev {
            return rejection(index, "stale", "Row \(id) revision changed")
        }
        touched.insert(id)
        var row = rows[rowIndex]
        var merged = row["values"].objectValue
        var appliedValues: [String: JSONValue] = [:]
        var proposedValues: [String: JSONValue] = [:]
        let edited = row["edited"].objectValue
        for (key, value) in values {
            if merged[key] == value { continue }
            if edited[key] != nil { proposedValues[key] = value }
            else { appliedValues[key] = value; merged[key] = value }
        }
        if !appliedValues.isEmpty {
            let nextRevision = database["revision"].intValue + 1
            row["values"] = .object(merged)
            row["rev"] = .number(Double(nextRevision))
            rows[rowIndex] = row
            database["rows"] = .array(rows)
            database["revision"] = .number(Double(nextRevision))
            applied.append(change(id: id, op: "row.update", appliedRev: nextRevision, values: appliedValues, proposal: false, source: source))
        }
        if !proposedValues.isEmpty {
            proposed.append(change(id: id, op: "row.update", appliedRev: nil, values: proposedValues, proposal: true, source: source))
        }
        return nil
    }

    private static func applyRowDelete(_ operation: JSONValue, index: Int, to database: inout JSONValue, applied: inout [JSONValue], proposed: inout [JSONValue], touched: inout Set<String>, source: JSONValue) -> JSONValue? {
        let id = operation["id"].stringValue
        guard !id.isEmpty, let expectRev = exactRevision(operation["expectRev"]) else {
            return rejection(index, "invalid", "Invalid row delete")
        }
        if touched.contains(id) { return rejection(index, "invalid", "Duplicate row target \(id) in one call") }
        var rows = database["rows"].arrayValue
        guard let rowIndex = rows.firstIndex(where: { exact($0.id, id) }) else {
            return rejection(index, "missing", "Row \(id) does not exist")
        }
        if rows[rowIndex]["rev"].intValue != expectRev {
            return rejection(index, "stale", "Row \(id) revision changed")
        }
        touched.insert(id)
        if !rows[rowIndex]["edited"].objectValue.isEmpty {
            proposed.append(change(id: id, op: "row.delete", appliedRev: nil, values: [:], proposal: true, source: source))
            return nil
        }
        let nextRevision = database["revision"].intValue + 1
        rows.remove(at: rowIndex)
        database["rows"] = .array(rows)
        database["revision"] = .number(Double(nextRevision))
        applied.append(change(id: id, op: "row.delete", appliedRev: nextRevision, values: [:], proposal: false, source: source))
        return nil
    }

    private struct Binding {
        var componentID: String
        var enabled: Bool
        var pinnedVersion: Int
        var activeVersion: Int
        var versions: Int
        var props: JSONValue
        var schema: JSONValue
        var allowedDatabaseIDs: [String]
    }

    private static func binding(for id: String) -> Binding? {
        if exact(id, calculatorID) {
            return Binding(
                componentID: calculatorID, enabled: !disabled, pinnedVersion: 2, activeVersion: 2, versions: 2,
                props: calculatorProps,
                schema: ["type": "object", "properties": ["title": ["type": "string"]]],
                allowedDatabaseIDs: []
            )
        }
        if exact(id, databaseComponentID) {
            return Binding(
                componentID: databaseComponentID, enabled: !disabled, pinnedVersion: 1, activeVersion: 1, versions: 1,
                props: databaseProps, schema: ["type": "object"],
                allowedDatabaseIDs: [NativeParityFixtures.databaseID]
            )
        }
        return nil
    }

    private static func code(for id: String, version: Int) -> String {
        if exact(id, calculatorID) { return version <= 1 ? calculatorCodeV1 : calculatorCode }
        return databaseViewCode
    }

    private static func parseHost(_ value: JSONValue) -> (kind: String, json: JSONValue)? {
        guard case .object(let fields) = value else { return nil }
        let kind = value["kind"].stringValue
        if kind == "page_block" {
            guard Set(fields.keys) == ["kind", "pageId", "blockId"],
                  NativeComponentContract.id(value["pageId"]), NativeComponentContract.id(value["blockId"]) else { return nil }
            return (kind, ["kind": "page_block", "pageId": value["pageId"], "blockId": value["blockId"]])
        }
        if kind == "database_view" {
            guard Set(fields.keys) == ["kind", "databaseId", "viewId"],
                  NativeComponentContract.id(value["databaseId"]), NativeComponentContract.id(value["viewId"]) else { return nil }
            return (kind, ["kind": "database_view", "databaseId": value["databaseId"], "viewId": value["viewId"]])
        }
        return nil
    }

    private static func hostKind(_ host: JSONValue) -> String { host["kind"].stringValue }

    private static func hostsEqual(_ a: JSONValue, _ b: JSONValue) -> Bool {
        exact(a["kind"].stringValue, b["kind"].stringValue)
            && exact(a["pageId"].stringValue, b["pageId"].stringValue)
            && exact(a["blockId"].stringValue, b["blockId"].stringValue)
            && exact(a["databaseId"].stringValue, b["databaseId"].stringValue)
            && exact(a["viewId"].stringValue, b["viewId"].stringValue)
    }

    private static func authorizedPage(_ id: String) -> Bool {
        [calculatorPageID, "page-preview"].contains { exact($0, id) }
    }

    private static func change(id: String, op: String, appliedRev: Int?, values: [String: JSONValue], proposal: Bool, source: JSONValue) -> JSONValue {
        [
            "op": .string(op),
            "id": .string(id),
            "values": .object(values),
            "appliedRev": appliedRev.map { .number(Double($0)) } ?? .null,
            "proposal": .bool(proposal),
            "source": source
        ]
    }

    private static func rejection(_ index: Int, _ reason: String, _ message: String) -> JSONValue {
        ["index": .number(Double(index)), "reason": .string(reason), "message": .string(message)]
    }

    private static func exact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    private static func exactRevision(_ value: JSONValue) -> Int? {
        guard case .number(let number) = value, number.isFinite, number.rounded(.towardZero) == number,
              number >= 1, number <= 9_007_199_254_740_991 else { return nil }
        return Int(number)
    }

    private static func error(_ code: String, _ message: String) -> JSONValue {
        ["error": ["code": .string(code), "message": .string(message)]]
    }
    private static func invalid(_ message: String) -> Response { Response(value: error("invalid", message), status: 400) }
    private static func notFound(_ message: String) -> Response { Response(value: error("not_found", message), status: 404) }
    private static func staleRevision(_ message: String) -> Response { Response(value: error("stale_revision", message), status: 409) }
}
#endif
