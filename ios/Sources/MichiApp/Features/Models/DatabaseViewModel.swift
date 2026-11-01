import Foundation
import Combine
import MichiCore

let featureDatabaseColumnTypes = ["text", "number", "date", "select", "multi", "checkbox", "url", "progress", "app", "image", "threads"]
let featureDatabaseViewTypes = ["table", "board", "list", "calendar", "gallery", "timeline", "custom"]
let featureDatabaseFilterOps = [
    "is", "is-not", "contains", "not-contains", "empty", "not-empty", "gt", "lt", "before", "after", "checked", "unchecked", "waiting",
]
let featureDatabaseNoValueFilterOps: Set<String> = ["empty", "not-empty", "checked", "unchecked", "waiting"]
let featureDatabaseNativeViewTypes: Set<String> = ["table", "board", "list", "calendar", "gallery", "timeline"]

func featureCanEditStructuredColumn(_ column: JSONValue) -> Bool {
    guard column["editable"].featureOptionalBool != false else { return false }
    return ["date", "multi", "threads"].contains(column["type"].stringValue)
}

func featureIsUnsupportedCustomView(_ view: JSONValue) -> Bool {
    view["type"].stringValue == "custom"
        || view["config"].objectValue.keys.contains("componentId")
        || view["config"].objectValue.keys.contains("code")
        || view["config"].objectValue.keys.contains("component")
}

func featureIsUnsupportedCustomBlock(_ block: JSONValue) -> Bool {
    block["type"].stringValue == "component" && !NativePageComponentContract.canHostRegisteredComponent(block)
}

func featureCanHostRegisteredComponent(_ block: JSONValue) -> Bool {
    NativePageComponentContract.canHostRegisteredComponent(block)
}

func featureCanHostRegisteredCustomView(_ view: JSONValue) -> Bool {
    NativePageComponentContract.canHostRegisteredCustomView(view)
}

func featureUnsupportedCustomReason(_ value: JSONValue) -> String {
    if NativePageComponentContract.canHostRegisteredCustomView(value) {
        return "This custom view keeps its own component configuration. Native Pages cannot rewrite that configuration here."
    }
    if featureIsUnsupportedCustomView(value) {
        return "This custom HTML/JS view is identified and kept on the server. Native iOS does not execute it, and it is not opened in a WebView."
    }
    if NativePageComponentContract.canHostRegisteredComponent(value) {
        return "This registered component runs in the isolated custom-component host."
    }
    if featureIsUnsupportedCustomBlock(value) {
        return "This custom HTML/JS component is identified and kept on the server. Native iOS does not execute it, and it is not opened in a WebView."
    }
    return "Unsupported custom HTML/JS is identified and kept on the server."
}

func featureParseDateCell(start: String, end: String?) throws -> JSONValue {
    let startDay = start.trimmingCharacters(in: .whitespacesAndNewlines)
    if startDay.isEmpty { return .null }
    guard featureIsDayString(startDay) else { throw FeatureRequestError(message: "Enter a date as YYYY-MM-DD.") }
    let endDay = end?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if endDay.isEmpty { return ["start": .string(startDay)] }
    guard featureIsDayString(endDay) else { throw FeatureRequestError(message: "Enter a date as YYYY-MM-DD.") }
    if endDay < startDay { return ["start": .string(endDay), "end": .string(startDay)] }
    if endDay == startDay { return ["start": .string(startDay)] }
    return ["start": .string(startDay), "end": .string(endDay)]
}

func featureParseMultiCell(_ values: [String], options: [JSONValue] = []) throws -> JSONValue {
    if values.count > 50 { throw FeatureRequestError(message: "A multi-select cell holds at most 50 values.") }
    var seen = Set<String>()
    var out: [JSONValue] = []
    for raw in values {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { continue }
        if value.count > 200 { throw FeatureRequestError(message: "A selected value is too long.") }
        let resolved = featureOptionValue(value, options: options) ?? value
        if seen.insert(resolved).inserted { out.append(.string(resolved)) }
    }
    return out.isEmpty ? .null : .array(out)
}

func featureParseThreadsCell(_ ids: [String]) throws -> JSONValue {
    if ids.count > 50 { throw FeatureRequestError(message: "A conversations cell holds at most 50 threads.") }
    var seen = Set<String>()
    var out: [JSONValue] = []
    for raw in ids {
        let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty { continue }
        if id.count > 200 { throw FeatureRequestError(message: "A conversation id is too long.") }
        if seen.insert(id).inserted { out.append(.string(id)) }
    }
    return out.isEmpty ? .null : .array(out)
}

func featureStructuredCellDraft(_ value: JSONValue, type: String) -> JSONValue {
    switch type {
    case "date":
        if value["start"].optionalString != nil { return value }
        if let start = value.optionalString, !start.isEmpty { return ["start": .string(start)] }
        return .null
    case "multi", "threads":
        return value.isNull ? .array([]) : .array(featureStringList(value).map { .string($0) })
    default:
        return value
    }
}

func featureIsDayString(_ value: String) -> Bool {
    NativeDatabaseDay(value) != nil
}

func featureOptionValue(_ raw: String, options: [JSONValue]) -> String? {
    if let match = options.first(where: { $0["value"].stringValue == raw }) { return match["value"].stringValue }
    if let match = options.first(where: { $0["label"].stringValue == raw }) { return match["value"].stringValue }
    return nil
}

func featureEmptyViewConfig() -> JSONValue {
    ["filters": .array([]), "match": "all", "sorts": .array([])]
}

func featureViewConfig(_ view: JSONValue) -> JSONValue {
    let config = view["config"]
    var next: [String: JSONValue] = [
        "filters": .array(config["filters"].arrayValue),
        "match": .string(config["match"].optionalString ?? "all"),
        "sorts": .array(config["sorts"].arrayValue),
    ]
    for key in ["group", "visible", "date", "planDate", "cover"] {
        if !config[key].isNull { next[key] = config[key] }
    }
    return .object(next)
}

func featureEffectiveViewConfig(_ view: JSONValue, columns: [JSONValue]) -> JSONValue {
    var config = featureViewConfig(view)
    if view["type"].stringValue == "board", config["group"].stringValue.isEmpty {
        if let group = columns.first(where: { $0["type"].stringValue == "select" }) {
            config["group"] = .string(group.id)
        }
    }
    return config
}

func featureViewSaveOperation(from view: JSONValue) throws -> JSONValue {
    if featureIsUnsupportedCustomView(view) {
        throw FeatureRequestError(message: featureUnsupportedCustomReason(view))
    }
    let name = view["name"].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let type = view["type"].stringValue
    guard !name.isEmpty, name.count <= 100 else { throw FeatureRequestError(message: "Enter a view name.") }
    guard featureDatabaseNativeViewTypes.contains(type) else {
        throw FeatureRequestError(message: "This view type cannot be saved here.")
    }
    var payload: [String: JSONValue] = [
        "name": .string(name),
        "type": .string(type),
        "config": try featureSanitizedViewConfig(view["config"], type: type),
    ]
    if !view.id.isEmpty { payload["id"] = .string(view.id) }
    return ["op": "view.save", "view": .object(payload)]
}

func featureSanitizedViewConfig(_ config: JSONValue, type: String) throws -> JSONValue {
    let allowed = Set(["filters", "match", "sorts", "group", "visible", "date", "planDate", "cover"])
    if let unknown = config.objectValue.keys.first(where: { !allowed.contains($0) }) {
        throw FeatureRequestError(message: "The \(unknown) view setting is not supported in native Pages.")
    }
    let match = config["match"].optionalString ?? "all"
    guard match == "all" || match == "any" else { throw FeatureRequestError(message: "A view matches all or any filters.") }
    let filters = try config["filters"].arrayValue.map(featureSanitizedFilter)
    let sorts = try config["sorts"].arrayValue.map(featureSanitizedSort)
    var next: [String: JSONValue] = [
        "filters": .array(filters),
        "match": .string(match),
        "sorts": .array(sorts),
    ]
    for key in ["group", "date", "planDate", "cover"] {
        if let value = config[key].optionalString, !value.isEmpty { next[key] = .string(value) }
    }
    if !config["visible"].isNull {
        let visible = featureStringList(config["visible"])
        if visible.count > 100 { throw FeatureRequestError(message: "Too many visible columns.") }
        next["visible"] = featureJSONStrings(visible)
    }
    _ = type
    return .object(next)
}

func featureSanitizedFilter(_ filter: JSONValue) throws -> JSONValue {
    let keys = Set(filter.objectValue.keys)
    guard keys.isSubset(of: ["column", "op", "value"]) else {
        throw FeatureRequestError(message: "A filter only has a column, operator and value.")
    }
    let column = filter["column"].stringValue
    let op = filter["op"].stringValue
    guard !column.isEmpty, featureDatabaseFilterOps.contains(op) else {
        throw FeatureRequestError(message: "This filter is not supported.")
    }
    var next: [String: JSONValue] = ["column": .string(column), "op": .string(op)]
    if !featureDatabaseNoValueFilterOps.contains(op), !filter["value"].isNull {
        next["value"] = filter["value"]
    }
    return .object(next)
}

func featureSanitizedSort(_ sort: JSONValue) throws -> JSONValue {
    let keys = Set(sort.objectValue.keys)
    guard keys.isSubset(of: ["column", "dir"]) else {
        throw FeatureRequestError(message: "A sort only has a column and direction.")
    }
    let column = sort["column"].stringValue
    let dir = sort["dir"].stringValue
    guard !column.isEmpty, dir == "asc" || dir == "desc" else {
        throw FeatureRequestError(message: "This sort is not supported.")
    }
    return ["column": .string(column), "dir": .string(dir)]
}

func featureColumnAddOperation(name: String, type: String, after: String? = nil) throws -> JSONValue {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= 100 else { throw FeatureRequestError(message: "Enter a column name.") }
    guard featureDatabaseColumnTypes.contains(type) else { throw FeatureRequestError(message: "This column type is not supported.") }
    var column: [String: JSONValue] = ["name": .string(trimmed), "type": .string(type)]
    if type == "select" || type == "multi" { column["options"] = .array([]) }
    var op: [String: JSONValue] = ["op": "column.add", "column": .object(column)]
    if let after { op["after"] = .string(after) }
    return .object(op)
}

func featureColumnUpdateOperation(id: String, patch: JSONValue) throws -> JSONValue {
    guard !id.isEmpty else { throw FeatureRequestError(message: "Reload this column before editing.") }
    let allowed = Set(["name", "type", "options", "editable", "width"])
    if let unknown = patch.objectValue.keys.first(where: { !allowed.contains($0) }) {
        throw FeatureRequestError(message: "The \(unknown) column setting cannot be written.")
    }
    guard !patch.objectValue.isEmpty else { throw FeatureRequestError(message: "No column changes to save.") }
    return ["op": "column.update", "id": .string(id), "patch": patch]
}

func featureOptionAddOperation(columnId: String, value: String, label: String? = nil, color: String? = nil) throws -> JSONValue {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !columnId.isEmpty, !trimmed.isEmpty, trimmed.count <= 200 else {
        throw FeatureRequestError(message: "Enter an option value.")
    }
    var option: [String: JSONValue] = ["value": .string(trimmed)]
    if let label, !label.isEmpty { option["label"] = .string(label) }
    if let color {
        guard ["gray", "blue", "green", "amber", "red", "violet"].contains(color) else {
            throw FeatureRequestError(message: "That option color is not supported.")
        }
        option["color"] = .string(color)
    }
    return ["op": "option.add", "id": .string(columnId), "option": .object(option)]
}

func featureBoardMoveOperation(row: JSONValue, groupColumn: JSONValue, key: String?, sourceKey: String? = nil) throws -> JSONValue {
    guard !row.id.isEmpty, row["rev"].intValue > 0 else {
        throw FeatureRequestError(message: "Reload this row before moving it.")
    }
    guard !groupColumn.id.isEmpty, groupColumn["editable"] != false else {
        throw FeatureRequestError(message: "This board's grouping column cannot be edited.")
    }
    let type = groupColumn["type"].stringValue
    let value: JSONValue
    switch type {
    case "checkbox":
        value = .bool(key == "true")
    case "select", "status", "app":
        value = (key?.isEmpty ?? true) ? .null : .string(key!)
    case "multi":
        let current = row["values"][groupColumn.id]
        guard current.isNull || { if case .array(let values) = current { return values.allSatisfy { $0.optionalString != nil } }; return false }() else {
            throw FeatureRequestError(message: "The multi-select value could not be read safely.")
        }
        let values = current.arrayValue.map(\.stringValue)
        guard (sourceKey == nil && values.isEmpty) || sourceKey.map(values.contains) == true else {
            throw FeatureRequestError(message: "This card is no longer in its original group. Refresh before moving it.")
        }
        var next = values.filter { $0 != sourceKey }
        if let key, !next.contains(key) { next.append(key) }
        guard next.count <= 50 else { throw FeatureRequestError(message: "A multi-select cell holds at most 50 values.") }
        value = next.isEmpty ? .null : .array(next.map(JSONValue.string))
    default:
        throw FeatureRequestError(message: "This board cannot move cards on that column.")
    }
    return [
        "op": "row.update",
        "id": .string(row.id),
        "expectRev": row["rev"],
        "values": .object([groupColumn.id: value]),
    ]
}

func featureActiveFilter(_ filter: JSONValue, columns: [JSONValue]) -> Bool {
    guard let column = columns.first(where: { $0.id == filter["column"].stringValue }) else { return false }
    let op = filter["op"].stringValue
    guard featureDatabaseFilterOps.contains(op) else { return false }
    if op == "waiting" && column["type"].stringValue != "threads" { return false }
    if featureDatabaseNoValueFilterOps.contains(op) { return true }
    return !featureCellIsBlank(filter["value"])
}

func featureCellIsBlank(_ value: JSONValue) -> Bool {
    if value.isNull { return true }
    if let text = value.optionalString { return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    if case .array(let items) = value { return items.isEmpty }
    if value["start"].optionalString?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false { return false }
    if value.objectValue.keys.contains("start") { return value["start"].stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    return false
}

func featureApplyView(rows: [JSONValue], columns: [JSONValue], config: JSONValue, conversation: FeatureConversationLookup? = nil) -> [JSONValue] {
    let filters = config["filters"].arrayValue.filter { featureActiveFilter($0, columns: columns) }
    let matchAny = config["match"].stringValue == "any"
    let filtered: [JSONValue]
    if filters.isEmpty {
        filtered = rows
    } else {
        filtered = rows.filter { row in
            let tests = filters.map { featureRowMatches($0, row: row, columns: columns, conversation: conversation) }
            return matchAny ? tests.contains(true) : !tests.contains(false)
        }
    }
    let sorts = config["sorts"].arrayValue.compactMap { sort -> (JSONValue, String)? in
        guard let column = columns.first(where: { $0.id == sort["column"].stringValue }) else { return nil }
        return (column, sort["dir"].stringValue)
    }
    return filtered.sorted { left, right in
        for (column, dir) in sorts {
            let a = left["values"][column.id]
            let b = right["values"][column.id]
            let blankA = column["type"].stringValue != "checkbox" && featureCellIsBlank(a)
            let blankB = column["type"].stringValue != "checkbox" && featureCellIsBlank(b)
            if blankA || blankB {
                if blankA && blankB { continue }
                return blankA ? false : true
            }
            let compared = featureCompareCells(a, b, column: column)
            if compared != .orderedSame {
                return dir == "desc" ? compared == .orderedDescending : compared == .orderedAscending
            }
        }
        let pos = left["position"].intValue - right["position"].intValue
        if pos != 0 { return pos < 0 }
        return left.id < right.id
    }
}

func featureBoardGroups(rows: [JSONValue], columns: [JSONValue], config: JSONValue) -> [(key: String?, label: String, rows: [JSONValue])] {
    let groupId = config["group"].stringValue
    guard let column = columns.first(where: { $0.id == groupId }) else {
        return [(nil, "", rows)]
    }
    if column["type"].stringValue == "checkbox" {
        return [
            ("true", "Yes", rows.filter { $0["values"][column.id].boolValue }),
            ("false", "No", rows.filter { !$0["values"][column.id].boolValue }),
        ]
    }
    let options = column["options"].arrayValue
    var buckets: [String: [JSONValue]] = [:]
    var empty: [JSONValue] = []
    for row in rows {
        let value = row["values"][column.id]
        if featureCellIsBlank(value) {
            empty.append(row)
            continue
        }
        let keys = value.arrayValue.isEmpty ? [value.stringValue] : featureStringList(value)
        for key in keys {
            buckets[key, default: []].append(row)
        }
    }
    var groups = options.map { option -> (String?, String, [JSONValue]) in
        let key = option["value"].stringValue
        return (key, option["label"].optionalString ?? key, buckets[key] ?? [])
    }
    let known = Set(options.map { $0["value"].stringValue })
    for key in buckets.keys.sorted() where !known.contains(key) {
        groups.append((key, key, buckets[key] ?? []))
    }
    if !empty.isEmpty { groups.append((nil, "No value", empty)) }
    return groups
}

func featureRowMatches(_ filter: JSONValue, row: JSONValue, columns: [JSONValue], conversation: FeatureConversationLookup? = nil) -> Bool {
    guard let column = columns.first(where: { $0.id == filter["column"].stringValue }) else { return false }
    let value = row["values"][column.id]
    let wanted = filter["value"]
    switch filter["op"].stringValue {
    case "is": return featureCellsEqual(value, wanted, column: column)
    case "is-not": return !featureCellsEqual(value, wanted, column: column)
    case "contains": return featureCellContains(value, wanted, column: column, conversation: conversation)
    case "not-contains": return !featureCellContains(value, wanted, column: column, conversation: conversation)
    case "empty": return column["type"].stringValue == "checkbox" ? value != true : featureCellIsBlank(value)
    case "not-empty": return column["type"].stringValue == "checkbox" ? value == true : !featureCellIsBlank(value)
    case "gt": return featureCompareCells(value, wanted, column: column) == .orderedDescending
    case "lt": return featureCompareCells(value, wanted, column: column) == .orderedAscending
    case "before": return featureCompareCells(value, wanted, column: column) == .orderedAscending
    case "after": return featureCompareCells(value, wanted, column: column) == .orderedDescending
    case "checked": return value == true
    case "unchecked": return value != true
    case "waiting": return column["type"].stringValue == "threads" && featureStringList(value).contains { conversation?($0)?.waiting == true }
    default: return false
    }
}

func featureCellsEqual(_ value: JSONValue, _ wanted: JSONValue, column: JSONValue) -> Bool {
    switch column["type"].stringValue {
    case "checkbox": return value.boolValue == (wanted == true || wanted.stringValue == "true")
    case "number", "progress":
        return value.featureOptionalNumber != nil && value.featureOptionalNumber == wanted.featureOptionalNumber
    case "date":
        return featureDateStart(value) == featureDateStart(wanted) && featureDateStart(value) != nil
    case "multi":
        let have = Set(featureStringList(value))
        let need = featureStringList(wanted.isNull ? .array([]) : wanted.arrayValue.isEmpty ? .array([wanted]) : wanted)
        return !need.isEmpty && need.allSatisfy { have.contains($0) }
    default:
        return !featureCellIsBlank(value) && featureCellText(value, type: column["type"].stringValue) == featureCellText(wanted, type: column["type"].stringValue)
    }
}

func featureCellContains(_ value: JSONValue, _ wanted: JSONValue, column: JSONValue, conversation: FeatureConversationLookup? = nil) -> Bool {
    if column["type"].stringValue == "multi" { return featureCellsEqual(value, wanted, column: column) }
    if column["type"].stringValue == "threads" {
        let needle = wanted.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return featureStringList(value).contains { $0.lowercased() == needle || conversation?($0)?.title.lowercased().contains(needle) == true }
    }
    let hay = featureCellText(value, type: column["type"].stringValue).lowercased()
    let needle = featureCellText(wanted, type: column["type"].stringValue).lowercased()
    return !needle.isEmpty && hay.contains(needle)
}

func featureCompareCells(_ left: JSONValue, _ right: JSONValue, column: JSONValue) -> ComparisonResult {
    switch column["type"].stringValue {
    case "number", "progress":
        let a = left.featureOptionalNumber ?? .nan
        let b = right.featureOptionalNumber ?? .nan
        if a.isFinite && b.isFinite { return a == b ? .orderedSame : (a < b ? .orderedAscending : .orderedDescending) }
        return .orderedSame
    case "date":
        guard let a = featureDateStart(left), let b = featureDateStart(right) else { return .orderedSame }
        return a == b ? .orderedSame : (a < b ? .orderedAscending : .orderedDescending)
    case "checkbox":
        return (left.boolValue ? 1 : 0) == (right.boolValue ? 1 : 0) ? .orderedSame : (left.boolValue ? .orderedDescending : .orderedAscending)
    default:
        let a = featureCellText(left, type: column["type"].stringValue)
        let b = featureCellText(right, type: column["type"].stringValue)
        return a == b ? .orderedSame : (a < b ? .orderedAscending : .orderedDescending)
    }
}

func featureDateStart(_ value: JSONValue) -> String? {
    if let start = value["start"].optionalString, !start.isEmpty { return String(start.prefix(10)) }
    if let start = value.optionalString, !start.isEmpty { return String(start.prefix(10)) }
    return nil
}

func featureDatabaseRowValueUpdate(
    baseline: JSONValue,
    columns: [JSONValue],
    drafts: [String: String],
    structured: [String: JSONValue] = [:],
    body: String
) throws -> JSONValue? {
    guard !baseline.id.isEmpty, baseline["rev"].intValue > 0 else {
        throw FeatureRequestError(message: "Reload this row before editing.")
    }
    var values: [String: JSONValue] = [:]
    for column in columns where featureCanEditColumn(column) {
        let original = baseline["values"][column.id]
        let type = column["type"].stringValue
        guard let draft = drafts[column.id], draft != featureCellDraft(original, type: type) else { continue }
        let parsed = try featureParseCell(draft, type: type)
        if parsed != original { values[column.id] = parsed }
    }
    for column in columns where featureCanEditStructuredColumn(column) {
        guard let next = structured[column.id] else { continue }
        let original = baseline["values"][column.id]
        if next != original { values[column.id] = next }
    }
    if structured.keys.contains(where: { key in
        guard let column = columns.first(where: { $0.id == key }) else { return true }
        return !featureCanEditStructuredColumn(column)
    }) {
        throw FeatureRequestError(message: "This cell cannot be edited here.")
    }
    let bodyChanged = body != baseline["body"].stringValue
    guard !values.isEmpty || bodyChanged else { return nil }
    var operation: [String: JSONValue] = [
        "op": "row.update", "id": .string(baseline.id), "expectRev": baseline["rev"],
    ]
    if !values.isEmpty { operation["values"] = .object(values) }
    if bodyChanged { operation["body"] = .string(body) }
    return .object(operation)
}
