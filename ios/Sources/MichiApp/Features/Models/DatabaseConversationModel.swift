import Foundation
import Combine
import MichiCore

struct FeatureConversationState: Equatable {
    let waiting: Bool
    let title: String
}

typealias FeatureConversationLookup = (String) -> FeatureConversationState?

/// A backend ThreadCardItem. Retaining the original record preserves future fields.
struct FeatureDatabaseConversationCard: Identifiable, Equatable {
    let raw: JSONValue
    var id: String { raw["nodeId"].stringValue }
    var nodeID: String { id }
    var workspaceID: String { raw["workspaceId"].stringValue }
    var title: String { raw["title"].stringValue }
    var state: String { raw["state"].stringValue }
    var summary: String { raw["summary"].stringValue }
    var at: Double { raw["at"].doubleValue }
    var messageID: String? { raw["messageId"].optionalString }
    // Shared conversationWaitsOnYou deliberately excludes "stalled".
    var filterState: FeatureConversationState { FeatureConversationState(waiting: state == "waiting", title: title) }
}

enum FeatureDatabaseConversationContract {
    // shared/src/pages/home.ts THREAD_STATE_LIMITS.nodeIds.
    static let batchSize = 500
    static let states: Set<String> = ["waiting", "stalled", "running", "done", "idle"]
    static func validID(_ value: String) -> Bool { !value.isEmpty && value.utf16.count <= 200 }

    static func cards(_ payload: JSONValue, requested: Set<String>) throws -> [String: FeatureDatabaseConversationCard] {
        guard case .array(let items) = payload["items"], items.count <= requested.count else {
            throw FeatureRequestError(message: "The linked conversations could not be read.")
        }
        var result: [String: FeatureDatabaseConversationCard] = [:]
        for item in items {
            let nodeID = item["nodeId"].stringValue
            guard validID(nodeID), requested.contains(nodeID), result[nodeID] == nil,
                  validID(item["workspaceId"].stringValue), item["title"].optionalString != nil,
                  item["summary"].optionalString != nil, states.contains(item["state"].stringValue),
                  let at = item["at"].featureOptionalNumber, at.isFinite, at >= 0,
                  item["messageId"].isNull || item["messageId"].optionalString.map(validID) == true else {
                throw FeatureRequestError(message: "The backend returned an invalid linked conversation. The previous result has been kept.")
            }
            result[nodeID] = FeatureDatabaseConversationCard(raw: item)
        }
        return result
    }

    /// A normal database never treats a conversation moved to another workspace as its own.
    static func scope(workspaceID: String, rows: [JSONValue], columns: [JSONValue]) -> [String: Set<String>] {
        let threadColumns = columns.filter { $0["type"].stringValue == "threads" }.map(\.id)
        var result: [String: Set<String>] = [:]
        for row in rows {
            for column in threadColumns {
                for id in featureStringList(row["values"][column]) where !id.isEmpty {
                    result[id, default: []].insert(workspaceID)
                }
            }
        }
        return result
    }

    /// Match web conversationsInTaskWorkspaces: the actual source database owns the
    /// workspace; a row's editable values must not redirect a linked conversation.
    static func scope(allTasks payload: JSONValue) -> [String: Set<String>] {
        var workspaceOf: [String: String] = [:]
        for source in payload["sources"].arrayValue {
            let id = source["databaseId"].stringValue, workspaceID = source["workspaceId"].stringValue
            if validID(id), validID(workspaceID) { workspaceOf[id] = workspaceID }
        }
        var result: [String: Set<String>] = [:]
        for entry in payload["rows"].arrayValue {
            guard let workspaceID = workspaceOf[entry["databaseId"].stringValue] else { continue }
            for id in featureStringList(entry["row"]["values"]["threads"]) where !id.isEmpty {
                result[id, default: []].insert(workspaceID)
            }
        }
        return result
    }
}

/// The POST endpoint is a read-only batch query, the same one the phone web task
/// board uses. No acknowledgement, conversation mutation, or agent work is sent.
@MainActor final class FeatureDatabaseConversationModel: ObservableObject {
    let api: MichiAPI
    @Published private(set) var cards: [String: FeatureDatabaseConversationCard] = [:]
    @Published private(set) var loaded = false
    @Published private(set) var loading = false
    @Published private(set) var failed = false
    @Published private(set) var error: String?
    @Published private(set) var expectedWorkspaces: [String: Set<String>] = [:]
    private var loadedScope: [String: Set<String>]?
    private var generation: UInt64 = 0

    init(api: MichiAPI) { self.api = api }

    /// A previous answer remains useful during a failed refresh, but is always
    /// constrained by the current database/workspace set before use.
    var byNode: [String: FeatureDatabaseConversationCard] {
        cards.filter { id, card in expectedWorkspaces[id]?.contains(card.workspaceID) == true }
    }
    var lookup: FeatureConversationLookup {
        let snapshot = byNode
        return { snapshot[$0]?.filterState }
    }
    func card(nodeID: String, workspaceID: String? = nil) -> FeatureDatabaseConversationCard? {
        guard let card = byNode[nodeID], workspaceID == nil || card.workspaceID == workspaceID else { return nil }
        return card
    }

    @discardableResult func refresh(workspaceID: String, rows: [JSONValue], columns: [JSONValue]) async -> Bool {
        await refresh(expectedWorkspaces: FeatureDatabaseConversationContract.scope(workspaceID: workspaceID, rows: rows, columns: columns))
    }
    @discardableResult func refresh(allTasks payload: JSONValue) async -> Bool {
        await refresh(expectedWorkspaces: FeatureDatabaseConversationContract.scope(allTasks: payload))
    }

    /// Commit only once all batches succeed. A newer refresh supersedes an older
    /// one, including when the linked IDs change while requests are in flight.
    @discardableResult func refresh(expectedWorkspaces wanted: [String: Set<String>]) async -> Bool {
        generation &+= 1
        let requestGeneration = generation
        loading = true; failed = false; error = nil
        defer { if requestGeneration == generation { loading = false } }
        guard wanted.allSatisfy({ FeatureDatabaseConversationContract.validID($0.key)
            && !$0.value.isEmpty && $0.value.allSatisfy(FeatureDatabaseConversationContract.validID) }) else {
            loaded = false; failed = true; error = "A linked conversation or workspace has an invalid ID."
            return false
        }
        expectedWorkspaces = wanted
        loaded = loadedScope == wanted
        let ids = wanted.keys.sorted()
        if ids.isEmpty {
            cards = [:]; loadedScope = wanted; loaded = true
            return true
        }
        do {
            var collected: [String: FeatureDatabaseConversationCard] = [:]
            for offset in stride(from: 0, to: ids.count, by: FeatureDatabaseConversationContract.batchSize) {
                try Task.checkCancellation()
                guard requestGeneration == generation else { return false }
                let batch = Array(ids[offset..<min(offset + FeatureDatabaseConversationContract.batchSize, ids.count)])
                let payload = try await api.request("/spaces-home/thread-states", method: "POST", body: ["nodeIds": .array(batch.map(JSONValue.string))])
                guard requestGeneration == generation else { return false }
                let answer = try FeatureDatabaseConversationContract.cards(payload, requested: Set(batch))
                collected.merge(answer) { _, new in new }
            }
            try Task.checkCancellation()
            guard requestGeneration == generation else { return false }
            cards = collected; loadedScope = wanted; loaded = true; failed = false; error = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard requestGeneration == generation else { return false }
            failed = true; self.error = "Couldn’t read where the linked conversations stand. The previous result has been kept."
            return false
        }
    }
}
