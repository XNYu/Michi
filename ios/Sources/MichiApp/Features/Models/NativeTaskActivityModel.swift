import Foundation
import Combine
import MichiCore

/// Who made a task, matching `TaskOrigin.by` on the shared contract.
enum NativeTaskOriginBy: String, Equatable {
    case you
    case metaAgent = "meta-agent"
    case agent
}

/// `{ by, conversations, at }` from `GET /databases/:id/rows/:rowId/origin`.
struct NativeTaskOrigin: Equatable {
    var by: NativeTaskOriginBy
    var conversations: Int
    var at: Double
}

enum NativeTaskMarkKind: String, Equatable {
    case new
    case updated
}

struct NativeTaskMark: Equatable {
    var rowId: String
    var kind: NativeTaskMarkKind
    var at: Double
}

/// Parsed `GET /databases/:id/task-activity`. Malformed items stay out of row maps.
struct NativeTaskActivitySnapshot: Equatable {
    var suggestions: [JSONValue]
    var marks: [NativeTaskMark]
    var latestUpkeep: JSONValue?
    var unsupported: [String]
}

/// Byte-exact `(databaseId, rowId)` pair. Backend rows are keyed by
/// `(database_id, id)`; a delimiter join or Unicode-normalized String can
/// collapse distinct identities.
struct NativeTaskRowIdentity: Hashable, Sendable {
    let databaseId: String
    let rowId: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.databaseId.utf8.elementsEqual(rhs.databaseId.utf8)
            && lhs.rowId.utf8.elementsEqual(rhs.rowId.utf8)
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(databaseId.utf8.count)
        for byte in databaseId.utf8 { hasher.combine(byte) }
        hasher.combine(rowId.utf8.count)
        for byte in rowId.utf8 { hasher.combine(byte) }
    }
}

enum NativeTaskOriginPresentation: Equatable {
    case idle
    case loading(rowKey: NativeTaskRowIdentity)
    case ready(rowKey: NativeTaskRowIdentity, origin: NativeTaskOrigin)
    case absent(rowKey: NativeTaskRowIdentity)
    case unsupported(rowKey: NativeTaskRowIdentity, message: String, raw: JSONValue)
    case failed(rowKey: NativeTaskRowIdentity, message: String)

    var rowKey: NativeTaskRowIdentity? {
        switch self {
        case .idle: return nil
        case .loading(let key), .ready(let key, _), .absent(let key), .unsupported(let key, _, _), .failed(let key, _):
            return key
        }
    }

    var origin: NativeTaskOrigin? {
        if case .ready(rowKey: _, origin: let origin) = self { return origin }
        return nil
    }

    var isReady: Bool {
        if case .ready = self { return true }
        return false
    }
}

func nativeTaskOriginRowKey(databaseId: String, rowId: String) -> NativeTaskRowIdentity {
    NativeTaskRowIdentity(databaseId: databaseId, rowId: rowId)
}

func nativeTaskActivityPath(databaseId: String) -> String {
    "/databases/\(FeatureAPI.segment(databaseId))/task-activity"
}

func nativeTaskOriginPath(databaseId: String, rowId: String) -> String {
    "/databases/\(FeatureAPI.segment(databaseId))/rows/\(FeatureAPI.segment(rowId))/origin"
}

func nativeTaskOriginText(_ origin: NativeTaskOrigin) -> String {
    if origin.by == .you { return "Created by you" }
    let who = origin.by == .metaAgent ? "Meta agent" : "an agent"
    if origin.conversations > 0 {
        return "Created by \(who) from \(nativeTaskPlural(origin.conversations, word: "conversation"))"
    }
    return "Created by \(who)"
}

func nativeTaskOriginSentence(_ origin: NativeTaskOrigin) -> String {
    "\(nativeTaskOriginText(origin)) · \(featureRelative(origin.at))"
}

func nativeTaskPlural(_ count: Int, word: String) -> String {
    "\(count) \(word)\(count == 1 ? "" : "s")"
}

func nativeTaskUpkeepSummary(_ upkeep: JSONValue) -> String? {
    let added = upkeep["added"].intValue
    let updated = upkeep["updated"].intValue
    let removed = upkeep["removed"].intValue
    let suggested = upkeep["suggested"].intValue
    var parts: [String] = []
    for (verb, count) in [("added", added), ("updated", updated), ("removed", removed)] where count > 0 {
        parts.append(parts.isEmpty ? "\(verb) \(nativeTaskPlural(count, word: "task"))" : "\(verb) \(count)")
    }
    if suggested > 0 {
        parts.append("suggested \(nativeTaskPlural(suggested, word: "change"))")
    }
    let said: String
    if parts.count > 1 {
        said = parts.dropLast().joined(separator: ", ") + " and " + parts[parts.count - 1]
    } else {
        said = parts.first ?? "changed nothing"
    }
    return "Meta agent \(said)"
}

enum NativeTaskParse<Value> {
    case ok(Value)
    case unsupported(String)
}

func nativeTaskParseOriginEnvelope(_ payload: JSONValue) -> NativeTaskParse<NativeTaskOrigin?> {
    guard case .object(let object) = payload, object.keys.contains("origin") else {
        return .unsupported("This origin response is not the {origin} record Pages returns.")
    }
    let origin = payload["origin"]
    if origin.isNull { return .ok(nil) }
    switch nativeTaskParseOrigin(origin) {
    case .ok(let parsed): return .ok(parsed)
    case .unsupported(let message): return .unsupported(message)
    }
}

func nativeTaskParseOrigin(_ value: JSONValue) -> NativeTaskParse<NativeTaskOrigin> {
    guard case .object = value else {
        return .unsupported("This origin record is not an object.")
    }
    guard let by = NativeTaskOriginBy(rawValue: value["by"].stringValue) else {
        return .unsupported("This origin record has an unsupported creator.")
    }
    guard let conversations = nativeTaskNonNegativeInt(value["conversations"]) else {
        return .unsupported("This origin record has an unreadable conversation count.")
    }
    guard let at = value["at"].featureOptionalNumber, at.isFinite else {
        return .unsupported("This origin record has an unreadable time.")
    }
    return .ok(NativeTaskOrigin(by: by, conversations: conversations, at: at))
}

func nativeTaskParseActivity(_ payload: JSONValue) -> NativeTaskParse<NativeTaskActivitySnapshot> {
    guard case .object = payload else {
        return .unsupported("Task activity is not a JSON object.")
    }
    guard case .array(let rawSuggestions) = payload["suggestions"], rawSuggestions.count <= 200,
          case .array = payload["marks"] else {
        return .unsupported("Task activity must contain bounded suggestions and task marks.")
    }
    if payload.objectValue.keys.contains("suggestions"), case .array = payload["suggestions"] {
    } else if payload.objectValue.keys.contains("suggestions") {
        return .unsupported("Task activity suggestions are not a list.")
    }
    if payload.objectValue.keys.contains("marks"), case .array = payload["marks"] {
    } else if payload.objectValue.keys.contains("marks") {
        return .unsupported("Task activity marks are not a list.")
    }
    if payload.objectValue.keys.contains("latestUpkeep"), !payload["latestUpkeep"].isNull {
        guard case .object = payload["latestUpkeep"] else {
            return .unsupported("The latest upkeep record is not an object.")
        }
    }
    var unsupported: [String] = []
    var suggestions: [JSONValue] = []
    for change in payload["suggestions"].arrayValue {
        if nativeTaskSuggestionRowId(change) == nil {
            unsupported.append(change.id.isEmpty ? "A suggestion is missing its task." : "Suggestion \(change.id) is not attached to a task.")
            continue
        }
        suggestions.append(change)
    }
    var marks: [NativeTaskMark] = []
    for item in payload["marks"].arrayValue {
        if let mark = nativeTaskParseMark(item) {
            marks.append(mark)
        } else {
            unsupported.append("A task mark is not {rowId, kind, at}.")
        }
    }
    let upkeep = payload["latestUpkeep"].isNull ? nil : payload["latestUpkeep"]
    return .ok(NativeTaskActivitySnapshot(
        suggestions: suggestions,
        marks: marks,
        latestUpkeep: upkeep,
        unsupported: unsupported
    ))
}

func nativeTaskParseMark(_ value: JSONValue) -> NativeTaskMark? {
    let rowId = value["rowId"].stringValue
    guard !rowId.isEmpty, let kind = NativeTaskMarkKind(rawValue: value["kind"].stringValue),
          let at = value["at"].featureOptionalNumber, at.isFinite else { return nil }
    return NativeTaskMark(rowId: rowId, kind: kind, at: at)
}

func nativeTaskSuggestionRowId(_ change: JSONValue) -> String? {
    guard !change.id.isEmpty, change["target"]["kind"].stringValue == "row" else { return nil }
    let rowId = change["target"]["rowId"].stringValue
    return rowId.isEmpty ? nil : rowId
}

func nativeTaskSuggestionsOf(_ snapshot: NativeTaskActivitySnapshot?, rowId: String) -> [JSONValue] {
    guard !rowId.isEmpty else { return [] }
    return (snapshot?.suggestions ?? []).filter { nativeTaskSuggestionRowId($0) == rowId }
}

func nativeTaskMarkOf(_ snapshot: NativeTaskActivitySnapshot?, rowId: String) -> NativeTaskMarkKind? {
    guard !rowId.isEmpty else { return nil }
    return snapshot?.marks.first { $0.rowId == rowId }?.kind
}

func nativeTaskIsConflict(_ error: Error) -> Bool {
    if let failure = error as? MichiAPIError, failure.statusCode == 409 { return true }
    return false
}

func nativeTaskSuggestionActions() -> [FeaturePageChangeAction] { [.accept, .dismiss] }

extension JSONValue {
    var nativeTaskRowIdentity: NativeTaskRowIdentity {
        NativeTaskRowIdentity(databaseId: self["databaseId"].stringValue, rowId: id)
    }
}

func nativeTaskDecideBody(action: FeaturePageChangeAction) throws -> JSONValue {
    guard nativeTaskSuggestionActions().contains(action) else {
        throw FeatureRequestError(message: "Task suggestions only support accept and dismiss.")
    }
    return try featurePageChangeActionBody(action: action)
}

/// Accept or dismiss one pending row suggestion. Does not edit other rows or workspaces.
func nativeTaskDecide(
    api: MichiAPI,
    change: JSONValue,
    action: FeaturePageChangeAction,
    edited: JSONValue? = nil
) async throws -> JSONValue {
    _ = try nativeTaskDecideBody(action: action)
    let body = try featurePageChangeActionBody(action: action, editedContent: edited)
    guard !change.id.isEmpty else {
        throw FeatureRequestError(message: "This suggestion has no id.")
    }
    let result = try await FeatureAPI.send(
        api,
        featurePageChangeActionPath(change.id, action: action),
        method: "POST",
        body: body
    )
    return try featurePageChangeResult(result, expectedId: change.id, action: action)
}

private func nativeTaskNonNegativeInt(_ value: JSONValue) -> Int? {
    guard let number = value.featureOptionalNumber, number.isFinite,
          number >= 0, number == number.rounded(.towardZero),
          number < Double(Int.max) else { return nil }
    return Int(number)
}

/// One origin read for one task. Switching rows clears the previous sentence before the next answer arrives.
@MainActor
final class NativeTaskOriginLoader: ObservableObject {
    let api: MichiAPI
    let databaseId: String
    @Published private(set) var presentation: NativeTaskOriginPresentation = .idle
    private var generation = 0

    init(api: MichiAPI, databaseId: String) {
        self.api = api
        self.databaseId = databaseId
    }

    var currentRowKey: NativeTaskRowIdentity? { presentation.rowKey }

    var readyOrigin: NativeTaskOrigin? { presentation.origin }

    func load(rowId: String) async {
        await load(databaseId: databaseId, rowId: rowId)
    }

    func load(databaseId: String, rowId: String) async {
        generation += 1
        let token = generation
        let key = nativeTaskOriginRowKey(databaseId: databaseId, rowId: rowId)
        presentation = .loading(rowKey: key)
        guard !databaseId.isEmpty, !rowId.isEmpty else {
            guard token == generation else { return }
            presentation = .unsupported(
                rowKey: key,
                message: "This task has no database or row identity, so its origin was not read.",
                raw: ["databaseId": .string(databaseId), "rowId": .string(rowId)]
            )
            return
        }
        do {
            let payload = try await FeatureAPI.get(api, nativeTaskOriginPath(databaseId: databaseId, rowId: rowId))
            guard token == generation, currentRowKey == key else { return }
            switch nativeTaskParseOriginEnvelope(payload) {
            case .ok(let origin):
                if let origin {
                    presentation = .ready(rowKey: key, origin: origin)
                } else {
                    presentation = .absent(rowKey: key)
                }
            case .unsupported(let message):
                presentation = .unsupported(rowKey: key, message: message, raw: payload)
            }
        } catch is CancellationError {
        } catch {
            guard token == generation, currentRowKey == key else { return }
            presentation = .failed(rowKey: key, message: featureErrorMessage(error))
        }
    }
}

/// Workspace task-board activity: suggestions, marks, and accept/dismiss of one change.
@MainActor
final class NativeTaskActivityModel: ObservableObject {
    let api: MichiAPI
    let databaseId: String
    let workspaceId: String
    let history: FeaturePageHistoryModel

    @Published var snapshot: NativeTaskActivitySnapshot?
    @Published var payload: JSONValue = .null
    @Published var unsupported: String?
    @Published var error: String?
    @Published var seenRowIds: Set<String> = []
    @Published var deciding = false

    init(api: MichiAPI, databaseId: String, workspaceId: String) {
        self.api = api
        self.databaseId = databaseId
        self.workspaceId = workspaceId
        history = FeaturePageHistoryModel(api: api, pageId: "", workspaceId: workspaceId)
    }

    func suggestions(for rowId: String) -> [JSONValue] {
        nativeTaskSuggestionsOf(snapshot, rowId: rowId)
    }

    func mark(for rowId: String) -> NativeTaskMarkKind? {
        guard !seenRowIds.contains(rowId) else { return nil }
        return nativeTaskMarkOf(snapshot, rowId: rowId)
    }

    func seen(_ rowId: String) {
        guard !rowId.isEmpty else { return }
        seenRowIds.insert(rowId)
    }

    func adopt(_ payload: JSONValue) {
        self.payload = payload
        switch nativeTaskParseActivity(payload) {
        case .ok(var snapshot):
            var seen: Set<String> = []
            let valid = snapshot.suggestions.filter { change in
                nativeTaskSuggestionRowId(change) != nil && featureIsPendingProposal(change)
                    && change["target"]["databaseId"].stringValue.utf8.elementsEqual(databaseId.utf8)
                    && seen.insert(change.id).inserted
            }
            if valid.count != snapshot.suggestions.count { snapshot.unsupported.append("Some suggestions do not identify a unique pending change in this database.") }
            snapshot.suggestions = valid
            self.snapshot = snapshot
            unsupported = snapshot.unsupported.isEmpty ? nil : snapshot.unsupported.joined(separator: " ")
            error = nil
        case .unsupported(let message):
            snapshot = nil
            unsupported = message
        }
    }

    func load() async {
        snapshot = nil; error = nil
        do {
            adopt(try await FeatureAPI.get(api, nativeTaskActivityPath(databaseId: databaseId)))
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    @discardableResult
    func decide(_ change: JSONValue, action: FeaturePageChangeAction, edited: JSONValue? = nil) async -> Bool {
        guard !deciding else { return false }
        guard snapshot?.suggestions.contains(change) == true,
              change["target"]["databaseId"].stringValue.utf8.elementsEqual(databaseId.utf8),
              featureIsPendingProposal(change) else {
            error = "This suggestion is no longer available in this task database. Refresh before deciding."
            return false
        }
        deciding = true
        defer { deciding = false }
        do {
            _ = try await nativeTaskDecide(api: api, change: change, action: action, edited: edited)
            snapshot?.suggestions.removeAll { $0.id == change.id }
            error = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }
}
