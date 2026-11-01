import Foundation
import CryptoKit
import MichiCore

struct NativeBlockCatalogEntry: Identifiable {
    let source: JSONValue
    let categoryLabel: String
    let input: JSONValue
    var id: String { source["type"].stringValue }
    var name: String { source["label"].stringValue }
    var description: String { source["blurb"].stringValue }
    var category: String { source["category"].stringValue }
    var addedBy: String? { id == "threads" ? "The assistant adds these from the conversations behind a page." : nil }
    var wide: Bool { ["plan-actual", "compare", "conflict", "table", "criteria", "chart", "gallery", "threads", "grid"].contains(id) }
}

struct NativeBlockCatalog {
    let source: JSONValue
    let entries: [NativeBlockCatalogEntry]
    var categories: [JSONValue] { source["categories"].arrayValue.filter { $0.id != "references" } }

    init(now: Date = Date(), timeZone: TimeZone = .current, source: JSONValue? = nil) throws {
        let loaded = try source ?? PageBlockCatalogResource.load()
        guard loaded["version"] == 1, !loaded["entries"].arrayValue.isEmpty,
              Set(loaded["entries"].arrayValue.map { $0["type"].stringValue }).count == loaded["entries"].arrayValue.count else {
            throw NativeFailure("The built-in catalog is malformed.")
        }
        self.source = loaded
        entries = loaded["categories"].arrayValue.filter { $0.id != "references" }.flatMap { category in
            loaded["entries"].arrayValue.compactMap { entry in
                guard entry["category"].stringValue == category.id, !entry["example"].isNull else { return nil }
                return NativeBlockCatalogEntry(source: entry, categoryLabel: category["label"].stringValue,
                    input: entry["type"] == "plan-actual" ? Self.planSample(now: now, timeZone: timeZone) : entry["example"])
            }
        }
    }

    func filtered(query: String, category: String = "all") -> [NativeBlockCatalogEntry] {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return entries.filter { (category == "all" || $0.category == category)
            && (words.isEmpty || "\($0.name) \($0.description) \($0.id) \($0.categoryLabel)".lowercased().contains(words)) }
    }

    /// The shared parser remains the final authority. This rejects malformed source,
    /// metadata and nested references locally; it never rewrites or drops fields.
    func validate(_ input: JSONValue) throws {
        guard try JSONEncoder().encode(input).count <= 1_048_576 else { throw NativeFailure("This block is too large.") }
        try validateContent(input, depth: 0)
    }

    private func validateContent(_ input: JSONValue, depth: Int) throws {
        guard case .object(let values) = input, let type = values["type"]?.optionalString,
              let entry = source["entries"].arrayValue.first(where: { $0["type"].stringValue == type }), depth <= 2,
              Set(values.keys).isDisjoint(with: ["id", "rev", "sources", "edit"]) else {
            throw NativeFailure("Use a supported block input without server identity or revision fields.")
        }
        if depth > 0 && ["database-ref", "page-link", "component", "threads", "conflict", "home-section", "view"].contains(type) {
            throw NativeFailure("Referenced resources and conversations must stay at the top level.")
        }
        // These examples contain deliberately invented conversation IDs and are never insertable.
        if type == "threads", input["nodeIds"].arrayValue.contains(where: { $0.stringValue.hasPrefix("sample-") }) {
            throw NativeFailure("The assistant adds thread cards from real conversations behind this page.")
        }
        try validateSchema(entry["schema"], input, path: "block", depth: depth)
    }

    private func validateSchema(_ schema: JSONValue, _ value: JSONValue, path: String, depth: Int) throws {
        func invalid() -> NativeFailure { NativeFailure("Invalid \(path). Check this block's source fields and values.") }
        let branches = (schema["anyOf"].arrayValue + schema["oneOf"].arrayValue)
        if !branches.isEmpty {
            for branch in branches { if (try? validateSchema(branch, value, path: path, depth: depth)) != nil { return } }
            throw invalid()
        }
        if let fixed = schema.objectValue["const"], fixed != value { throw invalid() }
        if !schema["enum"].arrayValue.isEmpty && !schema["enum"].arrayValue.contains(value) { throw invalid() }
        switch schema["type"].stringValue {
        case "object":
            guard case .object(let values) = value else { throw invalid() }
            let properties = schema["properties"].objectValue
            if schema["additionalProperties"] == false && !Set(values.keys).isSubset(of: Set(properties.keys)) { throw invalid() }
            for key in schema["required"].arrayValue where values[key.stringValue] == nil { throw invalid() }
            for (key, child) in properties { if let v = values[key] { try validateSchema(child, v, path: "\(path).\(key)", depth: depth) } }
        case "array":
            guard case .array(let items) = value else { throw invalid() }
            if !schema["minItems"].isNull && items.count < schema["minItems"].intValue { throw invalid() }
            if !schema["maxItems"].isNull && items.count > schema["maxItems"].intValue { throw invalid() }
            if schema["uniqueItems"] == true && Set(items.map(\.prettyPrinted)).count != items.count { throw invalid() }
            let itemSchema = schema["items"]
            for (i, item) in items.enumerated() {
                if itemSchema["type"] == "object" && itemSchema["properties"].isNull { try validateContent(item, depth: depth + 1) }
                else { try validateSchema(itemSchema, item, path: "\(path)[\(i)]", depth: depth) }
            }
        case "string":
            guard case .string(let text) = value else { throw invalid() }
            if !schema["minLength"].isNull && text.utf16.count < schema["minLength"].intValue { throw invalid() }
            if !schema["maxLength"].isNull && text.utf16.count > schema["maxLength"].intValue { throw invalid() }
            if let pattern = schema["pattern"].optionalString,
               text.range(of: pattern, options: .regularExpression) == nil { throw invalid() }
            if schema["description"] == "YYYY-MM-DD" && !Self.validDay(text) { throw invalid() }
        case "number", "integer":
            guard case .number(let n) = value, n.isFinite else { throw invalid() }
            if schema["type"] == "integer" && n.rounded(.towardZero) != n { throw invalid() }
            if !schema["minimum"].isNull && n < schema["minimum"].doubleValue { throw invalid() }
            if !schema["maximum"].isNull && n > schema["maximum"].doubleValue { throw invalid() }
            if !schema["exclusiveMinimum"].isNull && n <= schema["exclusiveMinimum"].doubleValue { throw invalid() }
        case "boolean": guard case .bool = value else { throw invalid() }
        case "null": guard value.isNull else { throw invalid() }
        default: break
        }
    }

    static func validDay(_ value: String) -> Bool {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return false }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return false }
        let back = calendar.dateComponents([.year, .month, .day], from: date)
        return back.year == parts[0] && back.month == parts[1] && back.day == parts[2]
    }

    static func planSample(now: Date, timeZone: TimeZone) -> JSONValue {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        let today = calendar.startOfDay(for: now)
        func d(_ offset: Int) -> JSONValue {
            let parts = calendar.dateComponents([.year, .month, .day], from: calendar.date(byAdding: .day, value: offset, to: today)!)
            return .string(String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!))
        }
        return ["type": "plan-actual", "title": "Plan vs actual", "items": [
            ["label": "Plan", "planStart": d(-14), "planEnd": d(-12), "actualStart": d(-14), "actualEnd": d(-12)],
            ["label": "Schema", "planStart": d(-11), "planEnd": d(-7), "actualStart": d(-11), "actualEnd": d(-5)],
            ["label": "Migration", "planStart": d(-6), "planEnd": d(1), "actualStart": d(-4), "forecastEnd": d(3)],
            ["label": "Tests", "planStart": d(2), "planEnd": d(4), "forecastStart": d(4), "forecastEnd": d(6)],
        ]]
    }
}

struct NativeBlockInsertion: Codable, Equatable {
    let token: String
    let workspaceID: String
    let body: JSONValue
}

/// Page IDs are globally assigned. Scope includes the connection and page so a
/// navigation workspace mismatch cannot bypass an unresolved insertion.
final class NativeBlockInsertionJournal {
    private struct Record: Codable { let connection: String; let pageID: String; let insertion: NativeBlockInsertion }
    private static let lock = NSLock()
    private static var activeTokens: Set<String> = []
    let directory: URL?
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Michi/PageInsertions.v1", isDirectory: true)
    }
    func load(api: MichiAPI, pageID: String) throws -> NativeBlockInsertion? {
        Self.lock.lock(); defer { Self.lock.unlock() }
        return try read(api: api, pageID: pageID)
    }
    func reserve(_ insertion: NativeBlockInsertion, api: MichiAPI, pageID: String) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard try read(api: api, pageID: pageID) == nil, let directory else { throw NativeFailure("An earlier insertion must be reviewed before adding another block.") }
        let data = try JSONEncoder().encode(Record(connection: api.baseURL.absoluteString, pageID: pageID, insertion: insertion))
        guard data.count <= 1_100_000 else { throw NativeFailure("The block could not be saved safely. Nothing was submitted.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = try fileURL(api: api, pageID: pageID)
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }; try handle.synchronize()
        guard try read(api: api, pageID: pageID) == insertion else { throw NativeFailure("The saved insertion could not be verified. Nothing was submitted.") }
        Self.activeTokens.insert(insertion.token)
    }
    func isActive(_ token: String) -> Bool {
        Self.lock.lock(); defer { Self.lock.unlock() }
        return Self.activeTokens.contains(token)
    }
    func finish(_ insertion: NativeBlockInsertion) {
        Self.lock.lock(); defer { Self.lock.unlock() }
        Self.activeTokens.remove(insertion.token)
    }
    func clear(_ insertion: NativeBlockInsertion, api: MichiAPI, pageID: String, requireInactive: Bool = false) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        if requireInactive && Self.activeTokens.contains(insertion.token) {
            throw NativeFailure("This insertion is still in progress. Wait for it to finish before reviewing its outcome.")
        }
        guard let current = try read(api: api, pageID: pageID) else { return }
        guard current == insertion else { throw NativeFailure("A different insertion is pending. Its record has been kept.") }
        try FileManager.default.removeItem(at: fileURL(api: api, pageID: pageID))
    }
    func fileURL(api: MichiAPI, pageID: String) throws -> URL {
        guard let directory else { throw NativeFailure("Local insertion recovery storage is unavailable.") }
        let bytes = try JSONEncoder().encode([api.baseURL.absoluteString, pageID])
        return directory.appendingPathComponent(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() + ".json")
    }
    private func read(api: MichiAPI, pageID: String) throws -> NativeBlockInsertion? {
        let url = try fileURL(api: api, pageID: pageID)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size, size.intValue <= 1_100_000 else { throw NativeFailure("The saved insertion cannot be read safely.") }
        let record = try JSONDecoder().decode(Record.self, from: Data(contentsOf: url))
        guard record.connection == api.baseURL.absoluteString, record.pageID == pageID, !record.insertion.token.isEmpty,
              record.insertion.body["revision"].intValue > 0,
              record.insertion.body["ops"].arrayValue.count == 1,
              record.insertion.body["ops"].arrayValue.first?["op"] == "insert" else {
            throw NativeFailure("The saved insertion identity cannot be verified.")
        }
        return record.insertion
    }
}
