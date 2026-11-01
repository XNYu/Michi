import Foundation
import Combine
import MichiCore

enum NativeHomeActivitySection: String, CaseIterable, Identifiable {
    case needsYou
    case running
    case continueWork
    case upNext
    case justDone

    var id: String { rawValue }
    var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .running: return "Running"
        case .continueWork: return "Pick up where you left off"
        case .upNext: return "Up next"
        case .justDone: return "Just done"
        }
    }
}

enum NativeHomeActivityKind: String {
    case permission, question, proposal, conversation, run, job, page, digest
}

struct NativeHomeActivityItem: Identifiable, Equatable {
    var id: String
    var section: NativeHomeActivitySection
    var kind: NativeHomeActivityKind
    var title: String
    var subtitle: String
    var symbol: String
    var state: String
    var workspaceID: String?
    var nodeID: String?
    var pageID: String?
    var jobID: String?
    var progress: Double?
    var relative: String
}

struct NativeHomeParsedSections: Equatable {
    var waiting: NativeHomeSectionSnapshot?
    var stalled: NativeHomeSectionSnapshot?
    var done: NativeHomeSectionSnapshot?
    var errors: [String] = []
}

struct NativeHomePulseCounts: Equatable {
    var running: Int
    var needsYou: Int
    var doneToday: Int
}

struct NativeHomeLiveChat: Equatable {
    var pendingPermission: JSONValue?
    var pendingQuestion: JSONValue?
    var busy = false
    var loaded = false
    var statusText = ""
    var messageCount = 0

    @MainActor
    init(chat: ChatController) {
        pendingPermission = chat.pendingPermission
        pendingQuestion = chat.pendingQuestion
        busy = chat.busy
        loaded = chat.loaded
        statusText = chat.statusText
        messageCount = chat.messages.count
    }

    init(pendingPermission: JSONValue? = nil, pendingQuestion: JSONValue? = nil, busy: Bool = false, loaded: Bool = false, statusText: String = "", messageCount: Int = 0) {
        self.pendingPermission = pendingPermission
        self.pendingQuestion = pendingQuestion
        self.busy = busy
        self.loaded = loaded
        self.statusText = statusText
        self.messageCount = messageCount
    }
}

/// Home activity field mapping and merge rules. Keeps parsers testable without a live store.
enum NativeHomeActivityContract {
    static let failedJobStatuses: Set<String> = ["failed", "timed_out", "interrupted", "cancelled"]

    static func parseSections(_ value: JSONValue) -> NativeHomeParsedSections {
        var parsed = NativeHomeParsedSections()
        parsed.waiting = parseSection(value, key: "waiting", into: &parsed.errors)
        parsed.stalled = parseSection(value, key: "stalled", into: &parsed.errors)
        parsed.done = parseSection(value, key: "done", into: &parsed.errors)
        return parsed
    }

    private static func parseSection(_ value: JSONValue, key: String, into errors: inout [String]) -> NativeHomeSectionSnapshot? {
        guard value.objectValue[key] != nil else { return nil }
        do {
            return try NativeHomeSectionSnapshot.parse(value[key], maximum: 8)
        } catch {
            errors.append(error.localizedDescription)
            return nil
        }
    }

    static func items(from snapshot: NativeHomeSectionSnapshot, section: NativeHomeActivitySection, state: String? = nil) -> [NativeHomeActivityItem] {
        let resolved = state ?? (section == .needsYou ? "waiting" : "done")
        return snapshot.items.map { item in
            switch item.target {
            case .conversation(let nodeID, let workspaceID):
                return NativeHomeActivityItem(
                    id: item.id, section: section,
                    kind: resolved == "done" ? .digest : .conversation,
                    title: item.title,
                    subtitle: [item.summary, item.workspaceName].filter { !$0.isEmpty }.joined(separator: " · "),
                    symbol: resolved == "waiting" ? "hand.raised" : (resolved == "stalled" ? "pause.circle" : "checkmark"),
                    state: resolved,
                    workspaceID: workspaceID, nodeID: nodeID, pageID: nil, jobID: nil, progress: nil,
                    relative: relativeTime(item.at)
                )
            case .page(let pageID, _, _):
                return NativeHomeActivityItem(
                    id: item.id, section: .needsYou, kind: .proposal,
                    title: item.title,
                    subtitle: [item.summary, item.workspaceName].filter { !$0.isEmpty }.joined(separator: " · "),
                    symbol: "wrench", state: "waiting",
                    workspaceID: item.workspaceID, nodeID: nil, pageID: pageID, jobID: nil, progress: nil,
                    relative: relativeTime(item.at)
                )
            }
        }
    }

    static func jobItems(_ jobs: [JSONValue], now: Date = Date()) -> [NativeHomeActivityItem] {
        jobs.flatMap { job in items(fromJob: job, now: now) }
    }

    static func items(fromJob job: JSONValue, now: Date = Date()) -> [NativeHomeActivityItem] {
        let name = job["name"].stringValue.isEmpty ? "Scheduled job" : job["name"].stringValue
        let workspace = job["workspaceId"].optionalString
        let node = job["persistentNodeId"].optionalString
        let enabled = job["enabled"].featureOptionalBool ?? false
        let autoPaused = job["autoPaused"].boolValue
        let active = job["activeRunId"].optionalString
        let lastStatus = job["lastStatus"].stringValue
        let lastRunAt = job["lastRunAt"].featureOptionalNumber
        let nextRunAt = job["nextRunAt"].featureOptionalNumber
        var rows: [NativeHomeActivityItem] = []

        if active != nil {
            rows.append(NativeHomeActivityItem(
                id: "jobrun-\(job.id)", section: .running, kind: .run,
                title: name, subtitle: job["lastError"].optionalString ?? "Agent run",
                symbol: "clock.arrow.circlepath", state: "streaming",
                workspaceID: workspace, nodeID: node, pageID: nil, jobID: job.id, progress: nil, relative: ""
            ))
        } else if enabled, !autoPaused, nextRunAt != nil {
            rows.append(NativeHomeActivityItem(
                id: "job-\(job.id)", section: .upNext, kind: .job,
                title: name, subtitle: "Scheduled · \(featureFormatDate(nextRunAt))",
                symbol: "clock", state: "idle",
                workspaceID: workspace, nodeID: node, pageID: nil, jobID: job.id, progress: nil,
                relative: featureFormatDate(nextRunAt)
            ))
        }

        if failedJobStatuses.contains(lastStatus) {
            rows.append(NativeHomeActivityItem(
                id: "jobfail-\(job.id)", section: .justDone, kind: .job,
                title: "\(name) \(lastStatus.replacingOccurrences(of: "_", with: " "))",
                subtitle: [featureFormatDate(lastRunAt), job["lastError"].stringValue].filter { !$0.isEmpty }.joined(separator: " · "),
                symbol: "xmark.circle", state: "failed",
                workspaceID: workspace, nodeID: node, pageID: nil, jobID: job.id, progress: nil,
                relative: featureFormatDate(lastRunAt)
            ))
        } else if lastStatus == "succeeded", isDoneToday(lastRunAt, now: now) {
            rows.append(NativeHomeActivityItem(
                id: "jobdone-\(job.id)", section: .justDone, kind: .job,
                title: "\(name) ran",
                subtitle: featureFormatDate(lastRunAt),
                symbol: "checkmark", state: "done",
                workspaceID: workspace, nodeID: node, pageID: nil, jobID: job.id, progress: nil,
                relative: featureFormatDate(lastRunAt)
            ))
        }
        return rows
    }

    static func localItems(graphs: [WorkspaceGraph], chats: [String: NativeHomeLiveChat] = [:]) -> [NativeHomeActivityItem] {
        var result: [NativeHomeActivityItem] = []
        for graph in graphs.orderedLive {
            for node in graph.visibleNodes() where graph.isConversation(node) {
                let chat = chats[node.id]
                let tree = graph.tree(node["tree_id"].stringValue)
                let thread = tree.map(graph.threadTitle) ?? graph.title(node)
                let isRoot = tree?["root_node_id"].stringValue == node.id
                let title = isRoot ? thread : graph.title(node)
                let relative = relativeTime(tree?["last_active_at"].featureOptionalNumber ?? node["created_at"].featureOptionalNumber)
                let subtitleBase = isRoot ? relative : [thread, relative].filter { !$0.isEmpty }.joined(separator: " · ")

                if let waiting = needsUser(node, chat: chat) {
                    switch waiting {
                    case .permission:
                        let request = chat?.pendingPermission
                        result.append(NativeHomeActivityItem(
                            id: "perm-\(node.id)", section: .needsYou, kind: .permission,
                            title: request?["title"].optionalString ?? node["permission_title"].optionalString ?? "Permission requested",
                            subtitle: subtitleBase, symbol: "hand.raised", state: "waiting",
                            workspaceID: graph.id, nodeID: node.id, pageID: nil, jobID: nil, progress: nil, relative: relative
                        ))
                    case .question:
                        let question = chat?.pendingQuestion?["questions"].arrayValue.first?["question"].stringValue
                        result.append(NativeHomeActivityItem(
                            id: "ask-\(node.id)", section: .needsYou, kind: .question,
                            title: (question?.isEmpty == false ? question! : (node["input_prompt"].optionalString ?? "Michi needs your input")),
                            subtitle: subtitleBase, symbol: "text.bubble", state: "waiting",
                            workspaceID: graph.id, nodeID: node.id, pageID: nil, jobID: nil, progress: nil, relative: relative
                        ))
                    case .status:
                        result.append(NativeHomeActivityItem(
                            id: "wait-\(node.id)", section: .needsYou, kind: .conversation,
                            title: title,
                            subtitle: [node["status"].stringValue.replacingOccurrences(of: "_", with: " "), subtitleBase].filter { !$0.isEmpty }.joined(separator: " · "),
                            symbol: "hand.raised", state: "waiting",
                            workspaceID: graph.id, nodeID: node.id, pageID: nil, jobID: nil, progress: nil, relative: relative
                        ))
                    }
                    continue
                }

                let state = nodeState(node, chat: chat)
                if state == "streaming" || chat?.busy == true {
                    result.append(NativeHomeActivityItem(
                        id: "run-\(node.id)", section: .running, kind: .conversation,
                        title: title, subtitle: runningSubtitle(chat: chat, relative: relative),
                        symbol: "dot.radiowaves.left.and.right", state: "streaming",
                        workspaceID: graph.id, nodeID: node.id, pageID: nil, jobID: nil, progress: nil, relative: relative
                    ))
                } else if state == "stalled" {
                    result.append(NativeHomeActivityItem(
                        id: "stall-\(node.id)", section: .justDone, kind: .conversation,
                        title: title, subtitle: "Stalled · \(relative)", symbol: "pause.circle", state: "stalled",
                        workspaceID: graph.id, nodeID: node.id, pageID: nil, jobID: nil, progress: nil, relative: relative
                    ))
                }
            }
        }
        return result
    }

    static func merge(local: [NativeHomeActivityItem], remote: [NativeHomeActivityItem]) -> [NativeHomeActivityItem] {
        var seenIDs = Set<String>()
        var seenNodes = Set<String>()
        var result: [NativeHomeActivityItem] = []
        func add(_ item: NativeHomeActivityItem) {
            if let node = conversationNode(item), !seenNodes.insert(node).inserted { return }
            guard seenIDs.insert(item.id).inserted else { return }
            result.append(item)
        }
        local.forEach(add)
        remote.forEach(add)
        return result
    }

    static func conversationNode(_ item: NativeHomeActivityItem) -> String? {
        switch item.kind {
        case .job, .run, .proposal, .page: return nil
        default:
            return item.nodeID.flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    /// Backend `waiting.total` is the full remote universe and may exceed the
    /// visible item cap (`HOME_SECTION_LIMIT` / layout rules). Native Home also
    /// merges live graph waits the sections payload did not count. Use the
    /// larger of those two — never substitute the visible cap for `total`, and
    /// never hide live-only rows behind a smaller remote total.
    static func mergedNeedsYouCount(visible: Int, waitingTotal: Int?) -> Int {
        guard let waitingTotal else { return visible }
        return max(waitingTotal, visible)
    }

    static func pulse(items: [NativeHomeActivityItem], waitingTotal: Int?) -> NativeHomePulseCounts {
        NativeHomePulseCounts(
            running: items.filter { $0.section == .running }.count,
            needsYou: mergedNeedsYouCount(
                visible: items.filter { $0.section == .needsYou }.count,
                waitingTotal: waitingTotal
            ),
            doneToday: items.filter { $0.section == .justDone && $0.state == "done" }.count
        )
    }

    static func isDoneToday(_ timestamp: Double?, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        guard let timestamp, timestamp > 0, timestamp.isFinite else { return false }
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        return calendar.isDate(date, inSameDayAs: now)
    }

    static func creationWorkspace(selected: WorkspaceGraph?, live: [WorkspaceGraph]) -> WorkspaceGraph? {
        if let selected, !selected.isDeleted, !selected.isArchived, !selected.isSystem { return selected }
        return live.orderedLive.first
    }

    private enum WaitingKind { case permission, question, status }

    private static func needsUser(_ node: JSONValue, chat: NativeHomeLiveChat?) -> WaitingKind? {
        if chat?.pendingPermission != nil { return .permission }
        if chat?.pendingQuestion != nil { return .question }
        switch node["status"].stringValue {
        case "permission": return .permission
        case "needs_input": return .question
        case "waiting": return .status
        default: return nil
        }
    }

    private static func runningSubtitle(chat: NativeHomeLiveChat?, relative: String) -> String {
        if let chat, !chat.statusText.isEmpty { return chat.statusText }
        if let chat, chat.loaded, chat.messageCount > 0 {
            return "Responding · \(chat.messageCount) message\(chat.messageCount == 1 ? "" : "s")"
        }
        return relative.isEmpty ? "Responding" : "Responding · \(relative)"
    }

    private static func nodeState(_ node: JSONValue, chat: NativeHomeLiveChat?) -> String {
        if chat?.pendingPermission != nil || chat?.pendingQuestion != nil { return "waiting" }
        if ["waiting", "needs_input", "permission"].contains(node["status"].stringValue) { return "waiting" }
        if node["status"].stringValue == "streaming" || chat?.busy == true { return "streaming" }
        return node["status"].stringValue
    }

    static func relativeTime(_ value: Double?) -> String {
        guard let value, value > 0 else { return "" }
        let seconds = max(0, Date().timeIntervalSince1970 - value / 1000)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86_400))d"
    }
}

@MainActor
final class NativeHomeActivityModel: ObservableObject {
    let api: MichiAPI
    @Published private(set) var remoteItems: [NativeHomeActivityItem] = []
    @Published private(set) var greetingText = ""
    @Published private(set) var greetingDetail: String?
    @Published var loading = false
    @Published var error: String?
    @Published var jobs: [JSONValue] = []
    @Published private(set) var waitingTotal: Int?
    @Published private(set) var stalledTotal: Int?
    @Published private(set) var doneTotal: Int?
    private var generation = UUID()

    init(api: MichiAPI) { self.api = api }

    func displayed(store: MichiStore) -> [NativeHomeActivityItem] {
        NativeHomeActivityContract.merge(
            local: NativeHomeActivityContract.localItems(graphs: store.graphs, chats: liveChats(store)),
            remote: remoteItems
        )
    }

    func items(_ items: [NativeHomeActivityItem], in section: NativeHomeActivitySection) -> [NativeHomeActivityItem] {
        items.filter { $0.section == section }
    }

    func pulse(for items: [NativeHomeActivityItem]) -> NativeHomePulseCounts {
        NativeHomeActivityContract.pulse(items: items, waitingTotal: waitingTotal)
    }

    func headerCount(_ section: NativeHomeActivitySection, rows: [NativeHomeActivityItem]) -> String? {
        switch section {
        case .needsYou: return "\(NativeHomeActivityContract.mergedNeedsYouCount(visible: rows.count, waitingTotal: waitingTotal))"
        case .justDone: return "\(max(doneTotal ?? 0, rows.count))"
        case .continueWork: return nil
        default: return "\(rows.count)"
        }
    }

    func refresh(store _: MichiStore, greeting: HomeGreetingRecord? = nil) async {
        let token = UUID()
        generation = token
        loading = true
        defer { if generation == token { loading = false } }

        async let jobsOutcome = loadJSON("/scheduled-jobs")
        async let sectionsOutcome = loadJSON(featureSpacesHomeSectionsPath())

        let jobsResult = await jobsOutcome
        let sectionsResult = await sectionsOutcome
        guard generation == token, !Task.isCancelled else { return }

        var nextRemote: [NativeHomeActivityItem] = []
        var errors: [String] = []

        switch jobsResult {
        case .success(let payload):
            jobs = featureItems(payload, key: "jobs")
            nextRemote.append(contentsOf: NativeHomeActivityContract.jobItems(jobs))
        case .failure(let failure):
            if failure is CancellationError { return }
            errors.append(failure.localizedDescription)
        }

        switch sectionsResult {
        case .success(let payload):
            let parsed = NativeHomeActivityContract.parseSections(payload)
            errors.append(contentsOf: parsed.errors)
            waitingTotal = parsed.waiting?.total
            stalledTotal = parsed.stalled?.total
            doneTotal = parsed.done?.total
            if let waiting = parsed.waiting {
                nextRemote.append(contentsOf: NativeHomeActivityContract.items(from: waiting, section: .needsYou, state: "waiting"))
            }
            if let stalled = parsed.stalled {
                nextRemote.append(contentsOf: NativeHomeActivityContract.items(from: stalled, section: .justDone, state: "stalled"))
            }
            if let done = parsed.done {
                nextRemote.append(contentsOf: NativeHomeActivityContract.items(from: done, section: .justDone, state: "done"))
            }
        case .failure(let failure):
            if failure is CancellationError { return }
            errors.append(failure.localizedDescription)
            waitingTotal = nil
            stalledTotal = nil
            doneTotal = nil
        }

        guard generation == token, !Task.isCancelled else { return }
        remoteItems = nextRemote
        if let greeting {
            greetingText = greeting.text
            greetingDetail = greeting.detail
        } else {
            greetingText = ""
            greetingDetail = nil
        }
        error = errors.isEmpty ? nil : errors.joined(separator: "\n")
    }

    private func liveChats(_ store: MichiStore) -> [String: NativeHomeLiveChat] {
        var chats: [String: NativeHomeLiveChat] = [:]
        for graph in store.graphs {
            for node in graph.visibleNodes() {
                if let chat = store.existingChat(for: node.id) {
                    chats[node.id] = NativeHomeLiveChat(chat: chat)
                }
            }
        }
        return chats
    }

    private func loadJSON(_ path: String) async -> Result<JSONValue, Error> {
        do { return .success(try await api.request(path)) }
        catch { return .failure(error) }
    }
}
