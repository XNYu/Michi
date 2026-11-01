import Foundation
import Combine
import MichiCore

enum NativeHomeSection: String, CaseIterable, Hashable {
    case waiting, stalled, done
    var title: String {
        switch self { case .waiting: return "Waiting on you"; case .stalled: return "Stalled"; case .done: return "Just done" }
    }
    var emptyMessage: String {
        switch self { case .waiting: return "Nothing is waiting on you."; case .stalled: return "Nothing has stalled."; case .done: return "Nothing finished since you last looked." }
    }
}

struct NativeHomeSectionItem: Identifiable, Equatable {
    enum Target: Equatable {
        case conversation(nodeID: String, workspaceID: String)
        case page(pageID: String, changeID: String, blockID: String?)
    }
    let id: String
    let workspaceID: String?
    let workspaceName: String
    let title: String
    let summary: String
    let at: Double?
    let agentClaim: Bool
    let target: Target

    static func parse(_ value: JSONValue) throws -> Self {
        let target: Target
        let owner = value["workspaceId"].optionalString
        switch (value["kind"].stringValue, value["target"]["kind"].stringValue) {
        case ("conversation", "conversation"):
            let node = value["target"]["nodeId"].stringValue
            let workspace = value["target"]["workspaceId"].stringValue
            guard !node.isEmpty, !workspace.isEmpty, owner == workspace, value.id == "conversation:\(node)" else {
                throw invalid("A reminder has an invalid conversation workspace.")
            }
            target = .conversation(nodeID: node, workspaceID: workspace)
        case ("proposal", "page"):
            let page = value["target"]["pageId"].stringValue
            let change = value["target"]["changeId"].stringValue
            guard !page.isEmpty, !change.isEmpty, value.id == "change:\(change)" else { throw invalid("A reminder has an invalid page target.") }
            target = .page(pageID: page, changeID: change, blockID: value["target"]["blockId"].optionalString)
        default: throw invalid("A reminder has an unsupported target.")
        }
        guard case .string = value["title"], case .string = value["summary"], case .string = value["workspaceName"],
              case .bool(let claim) = value["agentClaim"],
              value["at"].isNull || RichPageBlockModel.number(value["at"]) != nil else { throw invalid("A reminder is incomplete.") }
        return Self(id: value.id, workspaceID: owner, workspaceName: value["workspaceName"].stringValue,
                    title: value["title"].stringValue, summary: value["summary"].stringValue,
                    at: RichPageBlockModel.number(value["at"]), agentClaim: claim, target: target)
    }
    private static func invalid(_ message: String) -> FeatureRequestError { FeatureRequestError(message: message) }
}

struct NativeHomeSectionSnapshot: Equatable {
    let items: [NativeHomeSectionItem]
    let total: Int
    let ruleIDs: [String]

    static func parse(_ value: JSONValue, maximum: Int, state: NativeHomeSection? = nil) throws -> Self {
        guard case .array(let rows) = value["items"], rows.count <= maximum,
              let total = RichPageBlockModel.number(value["total"]), total >= Double(rows.count), total.rounded() == total,
              total < Double(Int.max) else { throw FeatureRequestError(message: "The reminder list is incomplete. Try refreshing.") }
        if let state, rows.contains(where: { $0["state"].stringValue != state.rawValue || $0["kind"] != "conversation" }) {
            throw FeatureRequestError(message: "The reminder list returned a different conversation state.")
        }
        let items = try rows.map(NativeHomeSectionItem.parse)
        guard Set(items.map(\.id)).count == items.count else { throw FeatureRequestError(message: "The reminder list contains duplicate items.") }
        return Self(items: items, total: Int(total), ruleIDs: value["ruleIds"].arrayValue.compactMap(\.optionalString))
    }
}

/// Embedded home sections are connection-global, including those on workspace
/// pages. The server owns preview rule filtering; its total is intentionally
/// larger than the preview and must never be inferred from the listed rows.
@MainActor
final class NativePageHomeSectionModel: ObservableObject {
    let api: MichiAPI
    @Published private(set) var sections: [NativeHomeSection: NativeHomeSectionSnapshot] = [:]
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var sourceIssue: String?
    @Published private(set) var expanded: Set<NativeHomeSection> = []
    @Published private(set) var extraLoading: Set<NativeHomeSection> = []
    @Published private(set) var extraErrors: [NativeHomeSection: String] = [:]
    @Published private(set) var extraItems: [NativeHomeSection: [NativeHomeSectionItem]] = [:]
    private var generation = UUID()
    private var refreshTask: Task<Void, Never>?
    private var extraTasks: [NativeHomeSection: Task<Void, Never>] = [:]
    private var extraTokens: [NativeHomeSection: UUID] = [:]

    init(api: MichiAPI) { self.api = api }

    func items(in section: NativeHomeSection) -> [NativeHomeSectionItem] {
        let base = sections[section]?.items ?? []
        guard expanded.contains(section) else { return base }
        let ids = Set(base.map(\.id))
        return base + (extraItems[section] ?? []).filter { !ids.contains($0.id) }
    }

    func refresh() async {
        if let refreshTask { await refreshTask.value; return }
        loading = true
        let token = generation
        let task = Task { [weak self] in
            guard let self else { return }
            defer { if generation == token { loading = false; refreshTask = nil } }
            do {
                let payload = try await FeatureAPI.get(api, featureSpacesHomeSectionsPath())
                var parsed: [NativeHomeSection: NativeHomeSectionSnapshot] = [:]
                for section in NativeHomeSection.allCases { parsed[section] = try NativeHomeSectionSnapshot.parse(payload[section.rawValue], maximum: 8) }
                guard case .bool(let available) = payload["conversations"]["available"] else {
                    throw FeatureRequestError(message: "Conversation availability is missing from the reminder response.")
                }
                guard !Task.isCancelled, generation == token else { return }
                sections = parsed; error = nil
                sourceIssue = available ? nil : (payload["conversations"]["reason"].optionalString ?? "Conversation reminders are temporarily unavailable.")
                for section in expanded {
                    guard !Task.isCancelled, generation == token else { return }
                    await loadMore(section)
                }
            } catch {
                guard !Task.isCancelled, generation == token else { return }
                self.error = error.localizedDescription
            }
        }
        refreshTask = task
        await task.value
    }

    func setExpanded(_ section: NativeHomeSection, _ value: Bool) async {
        if value { expanded.insert(section); await loadMore(section) }
        else {
            expanded.remove(section); extraTokens.removeValue(forKey: section)
            extraTasks.removeValue(forKey: section)?.cancel(); extraLoading.remove(section)
        }
    }

    func loadMore(_ section: NativeHomeSection) async {
        guard expanded.contains(section), !extraLoading.contains(section) else { return }
        let token = UUID(); extraTokens[section] = token; extraLoading.insert(section)
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if extraTokens[section] == token { extraLoading.remove(section); extraTasks.removeValue(forKey: section) }
            }
            do {
                let path = "/spaces-home/conversations" + FeatureAPI.query([("state", section.rawValue), ("limit", "500")])
                let payload = try await FeatureAPI.get(api, path)
                let parsed = try NativeHomeSectionSnapshot.parse(payload, maximum: 500, state: section)
                guard !Task.isCancelled, extraTokens[section] == token, expanded.contains(section) else { return }
                extraItems[section] = parsed.items; extraErrors[section] = nil
            } catch {
                guard !Task.isCancelled, extraTokens[section] == token else { return }
                extraErrors[section] = error.localizedDescription
            }
        }
        extraTasks[section] = task
        await task.value
    }

    func stop() {
        generation = UUID(); refreshTask?.cancel(); refreshTask = nil; loading = false
        for task in extraTasks.values { task.cancel() }
        extraTasks = [:]; extraTokens = [:]; extraLoading = []
    }

    static func containsSection(in blocks: [JSONValue]) -> Bool {
        func contains(_ value: JSONValue, depth: Int) -> Bool {
            guard depth < 12 else { return false }
            if value["type"] == "home-section" { return true }
            switch value {
            case .array(let values): return values.contains { contains($0, depth: depth + 1) }
            case .object(let values): return ["blocks", "columns", "regions", "tabs"].contains { key in
                values[key].map { contains($0, depth: depth + 1) } ?? false
            }
            default: return false
            }
        }
        return blocks.contains { contains($0, depth: 0) }
    }
}
