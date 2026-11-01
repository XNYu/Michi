import Foundation
import Combine
import CryptoKit
import MichiCore

enum NativeRunKind: String, CaseIterable, Identifiable, Hashable {
    case agent = "Agent runs", workflow = "Workflows"
    var id: String { rawValue }
}

struct NativeRunTarget: Hashable, Identifiable {
    let id: String
    let workspaceID: String
    let kind: NativeRunKind
}

enum NativeRunContract {
    static let agentStatuses = ["queued", "preparing", "running", "waiting", "recovering", "completed", "failed", "cancelled"]
    static let workflowStatuses = ["running", "paused", "completed", "failed", "cancelled"]
    static func terminal(_ run: JSONValue) -> Bool { ["completed", "failed", "cancelled"].contains(run["status"].stringValue) }
    static func validate(_ run: JSONValue, workspace: String, kind: NativeRunKind, id: String? = nil) throws {
        let states = kind == .agent ? agentStatuses : workflowStatuses
        guard run["version"] == 1, !run.id.isEmpty, run["workspaceId"].stringValue == workspace,
              id == nil || run.id == id, states.contains(run["status"].stringValue),
              case .number(let revision) = run[kind == .agent ? "latestEventSeq" : "revision"],
              revision.isFinite, revision.rounded() == revision, revision >= (kind == .agent ? -1 : 0) else {
            throw NativeFailure("The backend returned an invalid or unrelated run. Existing data has been kept.")
        }
    }
    static func text(_ value: JSONValue) -> String {
        if let text = value.optionalString { return text }
        for key in ["text", "content", "message", "summary", "detail", "title", "name"] {
            if let text = value[key].optionalString, !text.isEmpty { return text }
        }
        return value.isNull ? "" : value.prettyPrinted
    }
    static func name(_ run: JSONValue, kind: NativeRunKind) -> String {
        kind == .agent ? (run["effectiveDefinition"]["name"].optionalString ?? "Agent run") : (run["name"].optionalString ?? "Workflow")
    }
    static func uncertain(_ error: Error, actionKind: String? = nil) -> Bool {
        guard let failure = error as? MichiAPIError else { return error is CancellationError || error is URLError }
        let localRejections = [MichiAPIError.Code.invalidConfiguration, MichiAPIError.Code.invalidPath, MichiAPIError.Code.invalidRequest, MichiAPIError.Code.insecureURL]
        if let code = failure.code, localRejections.contains(code) { return false }
        // The actual action route returns {error: "parent_unavailable", message: ...}.
        // MichiAPI puts that exact label in message, with code == nil. Only these
        // known pre-effect labels, on their specific routes/statuses, are definite.
        let label = failure.code ?? failure.message
        if failure.statusCode == 400 {
            if actionKind == "continue", label == "parent_unavailable" { return false }
            if ["continue", "save"].contains(actionKind ?? ""), label == "invalid_action" { return false }
        }
        if failure.statusCode == 409, ["input", "cancel"].contains(actionKind ?? ""), label == "expected Attempt does not match the active Attempt" { return false }
        guard let status = failure.statusCode else { return true }
        // These routes map arbitrary runtime exceptions to HTTP 400/409,
        // including errors after handing input to the running agent.
        return (200..<300).contains(status) || [400, 408, 409].contains(status) || status >= 500
    }
    static func requireWritableWorkspace(_ api: MichiAPI, workspaceID: String) async throws {
        let payload = try await api.request("/workspaces/" + MichiAPI.pathSegment(workspaceID))
        let workspace = payload["workspace"]
        guard workspace.id == workspaceID,
              workspace.objectValue.keys.contains("deleted_at"), workspace.objectValue.keys.contains("archived_at") else {
            throw NativeFailure("The current workspace state could not be verified. Refresh before creating work.")
        }
        guard workspace["deleted_at"].isNull, workspace["archived_at"].isNull, workspace["purged_at"].isNull,
              workspace["settings"].parsedJSON["system"].isNull else {
            throw NativeFailure("Archived, deleted and system workspaces are read-only. Restore the workspace before creating work.")
        }
    }
}

struct NativeRunMutationScope: Codable, Equatable {
    let connection: String
    let workspaceID: String
    let resourceKind: String
    let runID: String?
    init(api: MichiAPI, workspaceID: String, target: NativeRunTarget? = nil) {
        connection = api.baseURL.absoluteString; self.workspaceID = workspaceID
        resourceKind = target.map { $0.kind == .agent ? "agent" : "workflow" } ?? "spawn"
        runID = target?.id
    }
}

/// Private app storage, independent of view/controller lifetime. A synchronous,
/// atomic write and file synchronization complete before the POST is permitted.
/// Credentials are never recorded. Tests inject a disposable directory.
final class NativeRunMutationJournal: @unchecked Sendable {
    private struct Record: Codable { let version: Int; let scope: NativeRunMutationScope; let action: NativeRunPendingAction }
    private static let lock = NSLock()
    let directory: URL?
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Michi/AgentRunOperations.v1", isDirectory: true)
    }
    func load(_ scope: NativeRunMutationScope) throws -> NativeRunPendingAction? {
        Self.lock.lock(); defer { Self.lock.unlock() }
        return try read(scope)
    }
    func reserve(_ action: NativeRunPendingAction, scope: NativeRunMutationScope) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        if let existing = try read(scope) {
            guard existing == action else { throw NativeFailure("An unresolved operation is already saved for this run. It has been kept.") }
            return
        }
        guard valid(action, scope: scope), let directory else { throw NativeFailure("This operation could not be saved safely. Nothing was submitted.") }
        let data = try JSONEncoder().encode(Record(version: 1, scope: scope, action: action))
        guard data.count <= 1_048_576 else { throw NativeFailure("This operation is too large to save safely. Nothing was submitted.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = try fileURL(scope)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        guard try read(scope) == action else { throw NativeFailure("The operation could not be verified in local storage. Nothing was submitted.") }
    }
    func clear(_ action: NativeRunPendingAction, scope: NativeRunMutationScope) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let existing = try read(scope) else { return }
        guard existing == action else { throw NativeFailure("A different unresolved operation is saved. Its record has been kept.") }
        try FileManager.default.removeItem(at: fileURL(scope))
    }
    func fileURL(_ scope: NativeRunMutationScope) throws -> URL {
        guard let directory else { throw NativeFailure("Persistent operation storage is unavailable. Nothing will be submitted.") }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let hash = SHA256.hash(data: try encoder.encode(scope)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(hash + ".json")
    }
    private func read(_ scope: NativeRunMutationScope) throws -> NativeRunPendingAction? {
        let url = try fileURL(scope)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size, size.intValue <= 1_048_576 else { throw NativeFailure("The saved operation record cannot be read safely. New operations remain blocked.") }
        let record = try JSONDecoder().decode(Record.self, from: Data(contentsOf: url))
        guard record.version == 1, record.scope == scope, valid(record.action, scope: scope) else {
            throw NativeFailure("The saved operation identity cannot be verified. New operations remain blocked.")
        }
        return record.action
    }
    private func valid(_ action: NativeRunPendingAction, scope: NativeRunMutationScope) -> Bool {
        guard !scope.workspaceID.isEmpty, !action.key.isEmpty, action.key.utf8.count <= 256,
              action.key.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }),
              action.canReplay == ["continue", "save", "watch"].contains(action.kind) else { return false }
        if scope.resourceKind == "spawn" {
            return action.kind == "spawn" && action.path == "/agent-runs" && action.body["workspaceId"].stringValue == scope.workspaceID
        }
        guard let runID = scope.runID, !runID.isEmpty else { return false }
        let path = (scope.resourceKind == "agent" ? "/agent-runs/" : "/workflow-runs/") + MichiAPI.pathSegment(runID)
        if scope.resourceKind == "workflow" { return action.kind == "workflow" && (action.path == path + "/actions" || (action.path.hasPrefix(path + "/approvals/") && action.path.count > path.count + 11)) }
        guard scope.resourceKind == "agent" else { return false }
        switch action.kind {
        case "input", "cancel": return action.path == path + "/" + action.kind
        case "respond": return action.path.hasPrefix(path + "/interactions/") && action.path.hasSuffix("/respond")
        case "continue", "save": return action.path == path + (action.kind == "continue" ? "/continue-as-branch" : "/save-as-agent") && action.body["workspaceId"].stringValue == scope.workspaceID
        case "watch": return action.path == "/agent-run-watches" && action.body["workspaceId"].stringValue == scope.workspaceID && action.body["runIds"] == [.string(runID)]
        default: return false
        }
    }
}

@MainActor final class AgentRunsModel: ObservableObject {
    let api: MichiAPI
    @Published var workspaceID: String
    @Published var workspaces: [JSONValue] = []
    @Published var runs: [JSONValue] = []
    @Published var workflows: [JSONValue] = []
    @Published var definitions: [JSONValue] = []
    @Published var kind: NativeRunKind = .agent
    @Published var query = ""
    @Published var statusFilter = ""
    @Published var includeArchived = false
    @Published var loading = false
    @Published var customAgentsEnabled = false
    @Published var error: String?
    @Published var workflowError: String?
    @Published var hasMore = false
    @Published var spawning = false
    @Published var pendingSpawn: NativeRunPendingAction?
    @Published var spawnRecoveryIssue: String?
    var spawnOutcomeUnknown: Bool { pendingSpawn != nil || spawnRecoveryIssue != nil }
    let journal: NativeRunMutationJournal
    @Published var spawnedRun: JSONValue?
    private var cursor: String?
    private var epoch = 0
    init(api: MichiAPI, workspaceID: String? = nil, journal: NativeRunMutationJournal = NativeRunMutationJournal()) {
        self.api = api; self.workspaceID = workspaceID ?? ""; self.journal = journal
        refreshSpawnRecovery()
    }
    private func refreshSpawnRecovery() {
        guard !workspaceID.isEmpty else { pendingSpawn = nil; spawnRecoveryIssue = nil; return }
        do { pendingSpawn = try journal.load(.init(api: api, workspaceID: workspaceID)); spawnRecoveryIssue = nil }
        catch { spawnRecoveryIssue = "Saved operation recovery is blocked: " + error.localizedDescription }
    }
    var availableDefinitions: [JSONValue] {
        definitions.filter { $0["status"] == "enabled" && ($0["scope"] == "global" || $0["workspaceId"].stringValue == workspaceID) }
    }
    var visibleRows: [JSONValue] {
        (kind == .agent ? runs : workflows).filter {
            (statusFilter.isEmpty || $0["status"].stringValue == statusFilter) &&
            (query.isEmpty || NativeRunContract.name($0, kind: kind).localizedCaseInsensitiveContains(query) || $0["task"].stringValue.localizedCaseInsensitiveContains(query) || $0["description"].stringValue.localizedCaseInsensitiveContains(query))
        }.sorted { ($0["startedAt"].doubleValue == 0 ? $0["createdAt"].doubleValue : $0["startedAt"].doubleValue) > ($1["startedAt"].doubleValue == 0 ? $1["createdAt"].doubleValue : $1["startedAt"].doubleValue) }
    }
    func bootstrap() async {
        do {
            let result = try await api.request("/workspaces/all?meta=1")
            guard case .array(let rows) = result["workspaces"] else { throw NativeFailure("Workspaces could not be loaded.") }
            workspaces = rows.map { $0["workspace"] }.filter { !$0.id.isEmpty }
            if workspaceID.isEmpty { workspaceID = workspaces.first?.id ?? "" }; refreshSpawnRecovery()
            let status = try await api.request("/agent/status")
            customAgentsEnabled = status["customAgentsEnabled"].boolValue
            if customAgentsEnabled {
                let result = try await api.request("/agents")
                definitions = featureItems(result, key: "definitions")
            }
        } catch { self.error = error.localizedDescription }
        await reload()
    }
    func selectWorkspace(_ id: String) async {
        guard workspaces.contains(where: { $0.id == id }) else { return }
        epoch += 1; workspaceID = id; runs = []; workflows = []; cursor = nil; hasMore = false; loading = false
        refreshSpawnRecovery()
        await reload()
    }
    func filtersChanged() async {
        epoch += 1; runs = []; cursor = nil; hasMore = false; loading = false
        await reload()
    }
    private func listPath(workspace: String, cursor: String? = nil) -> String {
        var path = "/agent-runs?workspaceId=\(MichiAPI.queryComponent(workspace))&limit=100&includeArchived=\(includeArchived)"
        if !query.isEmpty { path += "&q=" + MichiAPI.queryComponent(query) }
        if !statusFilter.isEmpty, NativeRunContract.agentStatuses.contains(statusFilter) { path += "&status=" + MichiAPI.queryComponent(statusFilter) }
        if let cursor { path += "&cursor=" + MichiAPI.queryComponent(cursor) }
        return path
    }
    func reload(preserveLoadedPages: Bool = false) async {
        guard !loading, !workspaceID.isEmpty, workspaces.contains(where: { $0.id == workspaceID }) else { return }
        loading = true; let generation = epoch, workspace = workspaceID
        defer { if epoch == generation { loading = false } }
        if customAgentsEnabled {
            do {
                let path = listPath(workspace: workspace)
                let result = try await api.request(path)
                guard case .array(let rows) = result["runs"] else { throw NativeFailure("Run list could not be read.") }
                for run in rows { try NativeRunContract.validate(run, workspace: workspace, kind: .agent) }
                guard epoch == generation else { return }
                if preserveLoadedPages, runs.count > 100, rows.count == 100, let lastID = rows.last?.id {
                    // Poll only the first page, retaining pages explicitly loaded by the user.
                    // Pull to refresh rebuilds pagination from the authoritative first page.
                    runs = rows + runs.filter { $0.id > lastID }
                } else { runs = rows; cursor = rows.last?.id; hasMore = rows.count == 100 }
                error = nil
            } catch { if epoch == generation { self.error = error.localizedDescription } }
        }
        do {
            let result = try await api.request("/workflow-runs?workspaceId=\(MichiAPI.queryComponent(workspace))")
            guard case .array(let rows) = result["runs"] else { throw NativeFailure("Workflow list could not be read.") }
            for run in rows { try NativeRunContract.validate(run, workspace: workspace, kind: .workflow) }
            guard epoch == generation else { return }
            workflows = rows; workflowError = nil
        } catch { if epoch == generation { workflowError = error.localizedDescription } }
    }
    func loadMore() async {
        guard hasMore, !loading, let cursor, !workspaceID.isEmpty else { return }
        loading = true; let generation = epoch, workspace = workspaceID
        defer { if epoch == generation { loading = false } }
        do {
            let result = try await api.request(listPath(workspace: workspace, cursor: cursor))
            guard case .array(let rows) = result["runs"] else { throw NativeFailure("Run page could not be read.") }
            for run in rows { try NativeRunContract.validate(run, workspace: workspace, kind: .agent) }
            guard rows.isEmpty || (rows.last?.id ?? "") > cursor else { throw NativeFailure("Run pagination did not advance.") }
            guard epoch == generation else { return }
            let existing = Set(runs.map(\.id)); runs += rows.filter { !existing.contains($0.id) }
            self.cursor = rows.last?.id ?? cursor; hasMore = rows.count == 100; error = nil
        } catch { if epoch == generation { self.error = error.localizedDescription } }
    }
    func spawn(definitionID: String, task: String, environment: String, confirmed: Bool) async -> Bool {
        refreshSpawnRecovery()
        let text = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard confirmed, !spawning, !spawnOutcomeUnknown, customAgentsEnabled, !text.isEmpty, text.utf16.count <= 32_000,
              workspaces.contains(where: { $0.id == workspaceID }),
              availableDefinitions.contains(where: { $0.id == definitionID }), ["auto", "read_only", "git_worktree"].contains(environment) else { return false }
        spawning = true; defer { spawning = false }
        let workspace = workspaceID
        let body: JSONValue = ["version": 1, "workspaceId": .string(workspace), "agentId": .string(definitionID), "ephemeralDefinition": .null,
            "task": .string(text), "contextManifest": ["version": 1, "entries": [], "assembledAt": .number((Date().timeIntervalSince1970 * 1000).rounded()), "estimatedChars": 0],
            "permissionRestriction": .null, "environment": environment == "read_only" ? ["version": 1, "kind": "shared_workspace", "access": "read_only"] : ["version": 1, "kind": .string(environment)],
            "expectedResult": .null, "completionMode": "notify", "invocationMode": "manual", "runTtlMs": .null,
            "parentRunId": .null, "parentAttemptId": .null, "parentNodeId": .null, "parentTurnId": .null, "parentMessageId": .null, "parentToolCallId": .null]
        let scope = NativeRunMutationScope(api: api, workspaceID: workspace)
        let action = NativeRunPendingAction(kind: "spawn", path: "/agent-runs", body: body, canReplay: false, submittedText: text)
        var submitted = false
        do {
            try await NativeRunContract.requireWritableWorkspace(api, workspaceID: workspace)
            // Compare-and-reserve also catches an operation started by another open screen.
            try journal.reserve(action, scope: scope)
            if workspaceID == workspace { pendingSpawn = action }
            submitted = true
            let result = try await api.request(action.path, method: "POST", body: action.body, idempotencyKey: action.key)
            try NativeRunContract.validate(result["run"], workspace: workspace, kind: .agent)
            try journal.clear(action, scope: scope)
            refreshSpawnRecovery()
            spawnedRun = result["run"]; error = nil; await reload(); return true
        } catch {
            if submitted, !NativeRunContract.uncertain(error, actionKind: "spawn"), !(error is NativeFailure) {
                do { try journal.clear(action, scope: scope) } catch { spawnRecoveryIssue = error.localizedDescription }
            }
            refreshSpawnRecovery()
            self.error = error.localizedDescription; return false
        }
    }
}

struct NativeRunPendingAction: Codable, Equatable {
    let kind: String
    let path: String
    let body: JSONValue
    let key: String
    let canReplay: Bool
    let submittedText: String?
    init(kind: String, path: String, body: JSONValue, key: String = UUID().uuidString, canReplay: Bool, submittedText: String?) {
        self.kind = kind; self.path = path; self.body = body; self.key = key; self.canReplay = canReplay; self.submittedText = submittedText
    }
}

@MainActor final class AgentRunDetailModel: ObservableObject {
    let api: MichiAPI
    let target: NativeRunTarget
    let journal: NativeRunMutationJournal
    @Published var recoveryIssue: String?
    @Published var run: JSONValue = .null
    @Published var attempts: [JSONValue] = []
    @Published var events: [JSONValue] = []
    @Published var interactions: [JSONValue] = []
    @Published var watches: [JSONValue] = []
    @Published var loading = false
    @Published var busy = false
    @Published var error: String?
    @Published var message: String?
    @Published var input = ""
    @Published var pendingAction: NativeRunPendingAction?
    @Published var continuation: JSONValue?
    @Published var hasMoreEvents = false
    private var cursor = -1
    var terminal: Bool { NativeRunContract.terminal(run) }
    var ready: Bool { !run.isNull }
    var canMutate: Bool { ready && !busy && pendingAction == nil && recoveryIssue == nil }
    var pendingInteractions: [JSONValue] { interactions.filter { $0["status"] == "pending" } }
    var path: String { (target.kind == .agent ? "/agent-runs/" : "/workflow-runs/") + MichiAPI.pathSegment(target.id) }
    init(api: MichiAPI, target: NativeRunTarget, journal: NativeRunMutationJournal = NativeRunMutationJournal()) {
        self.api = api; self.target = target; self.journal = journal
        refreshRecovery()
    }
    private var scope: NativeRunMutationScope { .init(api: api, workspaceID: target.workspaceID, target: target) }
    private func refreshRecovery() {
        do {
            pendingAction = try journal.load(scope); recoveryIssue = nil
            if input.isEmpty, let submittedText = pendingAction?.submittedText { input = submittedText }
        } catch { recoveryIssue = "Saved operation recovery is blocked: " + error.localizedDescription }
    }
    func load() async {
        guard !loading else { return }; loading = true; defer { loading = false }
        do {
            let result = try await api.request(path), next = result["run"]
            try NativeRunContract.validate(next, workspace: target.workspaceID, kind: target.kind, id: target.id)
            let revision = target.kind == .agent ? "latestEventSeq" : "revision"
            if !run.isNull && next[revision].intValue < run[revision].intValue { return }
            if target.kind == .agent {
                guard case .array(let attempts) = result["attempts"], case .array(let interactions) = result["interactions"],
                      attempts.allSatisfy({ $0["runId"].stringValue == target.id }), interactions.allSatisfy({ $0["runId"].stringValue == target.id }) else {
                    throw NativeFailure("Run details are incomplete or belong to another run.")
                }
                self.attempts = attempts; self.interactions = interactions
                try await readEventPage()
            }
            run = next; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func loadMoreEvents() async {
        guard !loading, target.kind == .agent else { return }
        loading = true; defer { loading = false }
        do { try await readEventPage(); error = nil } catch { self.error = error.localizedDescription }
    }
    private func readEventPage() async throws {
        let result = try await api.request(path + "/events?afterSeq=\(cursor)")
        guard case .array(let rows) = result["events"] else { throw NativeFailure("Run events could not be read.") }
        var nextCursor = cursor
        for event in rows {
            guard event["version"] == 1, event["runId"].stringValue == target.id,
                  case .number(let seq) = event["seq"], seq == Double(nextCursor + 1) else {
                throw NativeFailure("Run event history contains an identity or sequence gap. Refresh before continuing.")
            }
            nextCursor += 1
        }
        events += rows; cursor = nextCursor; hasMoreEvents = rows.count == 1_000
        // Events are fetched a page at a time; no unbounded catch-up loop.
        for event in rows where ["watch_membership_updated", "watch_fired", "parent_delivery_updated"].contains(event["type"].stringValue) {
            watches.append(event)
        }
    }
    func sendInput(mode: String, confirmed: Bool, expectedAttemptID: JSONValue? = nil, submittedInput: String? = nil) async {
        let original = submittedInput ?? input
        let text = original.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canMutate, !terminal, confirmed, target.kind == .agent, ["queued", "immediate"].contains(mode), !text.isEmpty, text.utf16.count <= 32_000 else { return }
        guard expectedAttemptID == nil || expectedAttemptID == run["activeAttemptId"] else { error = "The active attempt changed. Review the run before sending input."; return }
        await perform(.init(kind: "input", path: path + "/input", body: ["version": 1, "text": .string(text), "mode": .string(mode), "expectedAttemptId": run["activeAttemptId"]], canReplay: false, submittedText: original))
    }
    func cancel(confirmed: Bool, expectedAttemptID: JSONValue? = nil) async {
        guard canMutate, !terminal, confirmed, target.kind == .agent else { return }
        guard expectedAttemptID == nil || expectedAttemptID == run["activeAttemptId"] else { error = "The active attempt changed. Review the run before cancelling."; return }
        await perform(.init(kind: "cancel", path: path + "/cancel", body: ["version": 1, "expectedAttemptId": run["activeAttemptId"], "reason": "Cancelled from iOS"], canReplay: false, submittedText: nil))
    }
    func respond(id: String, response: JSONValue, confirmed: Bool) async {
        guard canMutate, !terminal, confirmed, target.kind == .agent,
              let interaction = pendingInteractions.first(where: { $0.id == id }), interaction["attemptId"].isNull || interaction["attemptId"] == run["activeAttemptId"] else { return }
        await perform(.init(kind: "respond", path: path + "/interactions/\(MichiAPI.pathSegment(id))/respond", body: ["version": 1, "response": response], canReplay: false, submittedText: nil))
    }
    func continueRun(includeTask: Bool, includeResult: Bool, includeTranscript: Bool, newThread: Bool, confirmed: Bool) async {
        guard canMutate, terminal, target.kind == .agent, confirmed, includeTask || includeResult || includeTranscript else { return }
        await perform(.init(kind: "continue", path: path + "/continue-as-branch", body: ["version": 1, "workspaceId": .string(target.workspaceID), "includeTask": .bool(includeTask), "includeResult": .bool(includeResult), "includeTranscript": .bool(includeTranscript), "fallback": .string(newThread ? "new_thread" : "error")], canReplay: true, submittedText: nil))
    }
    func saveAsAgent(confirmed: Bool) async {
        guard canMutate, terminal, target.kind == .agent, confirmed, run["definitionId"].isNull else { return }
        await perform(.init(kind: "save", path: path + "/save-as-agent", body: ["version": 1, "workspaceId": .string(target.workspaceID)], canReplay: true, submittedText: nil))
    }
    func createWatch(confirmed: Bool) async {
        guard canMutate, !terminal, target.kind == .agent, confirmed else { return }
        await perform(.init(kind: "watch", path: "/agent-run-watches", body: ["version": 1, "workspaceId": .string(target.workspaceID), "runIds": [.string(target.id)], "condition": ["version": 1, "kind": "all"], "completionMode": "notify", "parentRunId": .null, "parentNodeId": .null, "parentTurnId": .null], canReplay: true, submittedText: nil))
    }
    func workflowAction(_ action: String, confirmed: Bool) async {
        guard canMutate, confirmed, target.kind == .workflow, ["stop", "pause", "resume", "retry"].contains(action), run["actions"].arrayValue.contains(.string(action)) else { return }
        await perform(.init(kind: "workflow", path: path + "/actions", body: ["action": .string(action)], canReplay: false, submittedText: nil))
    }
    func workflowApproval(id: String, optionID: String, confirmed: Bool) async {
        guard canMutate, confirmed, target.kind == .workflow, let approval = run["approvals"].arrayValue.first(where: { $0.id == id }),
              approval["options"].arrayValue.contains(where: { $0["optionId"].stringValue == optionID }) else { return }
        await perform(.init(kind: "workflow", path: path + "/approvals/\(MichiAPI.pathSegment(id))", body: ["optionId": .string(optionID)], canReplay: false, submittedText: nil))
    }
    func retryPending() async { if let pendingAction, pendingAction.canReplay, !busy, recoveryIssue == nil { await perform(pendingAction) } }
    private func perform(_ action: NativeRunPendingAction) async {
        guard !busy, recoveryIssue == nil else { return }; busy = true
        defer { busy = false }
        var submitted = false
        var recovering = false
        do {
            if let saved = try journal.load(scope) {
                pendingAction = saved
                guard saved == action, saved.canReplay else { return }
                recovering = true
            }
            if ["continue", "save"].contains(action.kind) {
                try await NativeRunContract.requireWritableWorkspace(api, workspaceID: target.workspaceID)
            }
            try journal.reserve(action, scope: scope)
            pendingAction = action
            submitted = true
            let result = try await api.request(action.path, method: "POST", body: action.body, idempotencyKey: action.key)
            switch action.kind {
            case "input", "cancel": guard result["accepted"].boolValue else { throw NativeFailure("The backend did not confirm this action.") }
            case "respond":
                let interaction = result["interaction"]
                guard interaction["runId"].stringValue == target.id,
                      action.path == path + "/interactions/\(MichiAPI.pathSegment(interaction.id))/respond",
                      ["resolved", "rejected", "cancelled"].contains(interaction["status"].stringValue) else { throw NativeFailure("The interaction response was not confirmed.") }
            case "continue":
                guard result["runId"].stringValue == target.id, result["workspaceId"].stringValue == target.workspaceID, !result["nodeId"].stringValue.isEmpty else { throw NativeFailure("The new conversation was not confirmed.") }
                continuation = result; message = "Conversation created: " + result["nodeId"].stringValue
            case "save":
                guard result["runId"].stringValue == target.id, !result["definition"].id.isEmpty,
                      result["definition"]["workspaceId"].stringValue == target.workspaceID,
                      result["definition"]["status"] == "draft" else { throw NativeFailure("The saved agent was not confirmed.") }
                message = "Draft agent saved: " + result["definition"]["name"].stringValue
            case "watch":
                guard result["watch"]["workspaceId"].stringValue == target.workspaceID, !result["watch"].id.isEmpty else { throw NativeFailure("The watch was not confirmed.") }
                watches.append(result["watch"]); message = "Completion notification requested."
            case "workflow":
                try NativeRunContract.validate(result["run"], workspace: target.workspaceID, kind: .workflow, id: target.id)
                if result["run"]["revision"].intValue >= run["revision"].intValue { run = result["run"] }
            default: break
            }
            try journal.clear(action, scope: scope)
            pendingAction = nil; error = nil
            if let submitted = action.submittedText, input == submitted { input = "" }
            await load()
        } catch {
            // A definite rejection can release only a newly submitted operation.
            // It cannot prove an earlier ambiguous request had no effect.
            if submitted, !recovering, !NativeRunContract.uncertain(error, actionKind: action.kind), !(error is NativeFailure) {
                do { try journal.clear(action, scope: scope) } catch { recoveryIssue = error.localizedDescription }
            }
            refreshRecovery()
            self.error = error.localizedDescription
        }
    }
}
