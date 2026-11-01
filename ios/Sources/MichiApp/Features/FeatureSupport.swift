import Foundation
import MichiCore

enum FeatureAPI {
    static func get(_ api: MichiAPI, _ path: String) async throws -> JSONValue {
        try await api.request(path)
    }

    static func send(_ api: MichiAPI, _ path: String, method: String, body: JSONValue? = nil) async throws -> JSONValue {
        try await api.request(path, method: method, body: body)
    }

    static func segment(_ id: String) -> String {
        MichiAPI.pathSegment(id)
    }

    static func query(_ pairs: [(String, String?)]) -> String {
        let items = pairs.compactMap { key, value -> String? in
            guard let value else { return nil }
            return "\(MichiAPI.queryComponent(key))=\(MichiAPI.queryComponent(value))"
        }
        return items.isEmpty ? "" : "?" + items.joined(separator: "&")
    }
}

struct FeatureRequestError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func featureErrorMessage(_ error: Error) -> String {
    if let request = error as? FeatureRequestError { return request.message }
    return error.localizedDescription
}

func featureError(from payload: JSONValue, fallback: String) -> String {
    let envelope = payload["error"]
    if let message = envelope["message"].optionalString, !message.isEmpty { return message }
    if let message = envelope.optionalString, !message.isEmpty { return message }
    if let message = payload["message"].optionalString, !message.isEmpty { return message }
    return fallback
}

func featureItems(_ value: JSONValue, key: String = "items") -> [JSONValue] {
    let nested = value[key]
    if !nested.isNull { return nested.arrayValue }
    return value.arrayValue
}

func featureUnwrap(_ value: JSONValue, _ key: String) -> JSONValue {
    let inner = value[key]
    return inner.isNull ? value : inner
}

func featureRequirePage(_ payload: JSONValue) throws -> JSONValue {
    let page = featureUnwrap(payload, "page")
    guard !page.id.isEmpty, page["revision"].intValue > 0 else {
        throw FeatureRequestError(message: "The page update did not return a saved revision.")
    }
    return page
}

func featureRequireDatabase(_ payload: JSONValue) throws -> JSONValue {
    let database = featureUnwrap(payload, "database")
    guard !database.id.isEmpty, database["revision"].intValue > 0 else {
        throw FeatureRequestError(message: "The database update did not return a saved revision.")
    }
    return database
}

func featureViewDraftIsDirty(_ draft: JSONValue, selected: JSONValue) -> Bool {
    !draft.isNull && draft != selected
}

func featureOptional(_ value: JSONValue) -> JSONValue? {
    value.isNull ? nil : value
}

func featureStringList(_ value: JSONValue) -> [String] {
    value.arrayValue.compactMap { item in
        let text = item.stringValue
        return text.isEmpty ? nil : text
    }
}

func featureJSONStrings(_ values: [String]) -> JSONValue {
    .array(values.map { .string($0) })
}

func featureWorkspaceName(_ workspace: JSONValue) -> String {
    if let name = workspace["name"].optionalString, !name.isEmpty { return name }
    if let cwd = workspace["cwd"].optionalString, !cwd.isEmpty { return (cwd as NSString).lastPathComponent }
    return workspace.id
}

func featureWorkspaceId(_ workspace: JSONValue) -> String {
    workspace.id
}

func featureNamed(_ value: JSONValue, fallback: String = "Untitled") -> String {
    if let title = value["title"].optionalString, !title.isEmpty { return title }
    if let name = value["name"].optionalString, !name.isEmpty { return name }
    return fallback
}

func featureBlockInput(from block: JSONValue) -> JSONValue {
    var fields = block.objectValue
    fields.removeValue(forKey: "id")
    fields.removeValue(forKey: "rev")
    fields.removeValue(forKey: "sources")
    fields.removeValue(forKey: "edit")
    return .object(fields)
}

func featureMarkdown(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
}

func featureDate(_ millis: Double?) -> Date? {
    guard let millis, millis > 0 else { return nil }
    return Date(timeIntervalSince1970: millis / 1000)
}

func featureMillis(_ date: Date) -> Double {
    (date.timeIntervalSince1970 * 1000).rounded()
}

func featureFormatDate(_ millis: Double?) -> String {
    guard let date = featureDate(millis) else { return "—" }
    return featureFormatDate(date)
}

func featureFormatDate(_ date: Date) -> String {
    date.formatted(date: .abbreviated, time: .shortened)
}

func featureRelative(_ millis: Double?) -> String {
    guard let date = featureDate(millis) else { return "—" }
    return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
}

func featureTimeZoneId() -> String {
    TimeZone.current.identifier
}

func featurePad(_ value: Int) -> String {
    String(format: "%02d", value)
}

@MainActor
func featureRun<T>(_ work: @escaping () async throws -> T, onError: (String) -> Void) async -> T? {
    do {
        return try await work()
    } catch is CancellationError {
        return nil
    } catch {
        onError(featureErrorMessage(error))
        return nil
    }
}

extension JSONValue {
    var featureOptionalNumber: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var featureOptionalBool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var featureWorkspaceKey: String {
        let workspaceId = self["workspaceId"].stringValue
        return workspaceId.isEmpty ? id : workspaceId
    }

    var featureDeletionGroupId: String { self["deletionGroupId"].stringValue }
    var featureOptionValue: String { self["value"].stringValue }
}
