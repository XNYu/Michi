import Foundation
import SwiftUI
import MichiCore

struct NativeMessage: Identifiable {
    var id: String
    var role: String
    var text: String
    var blocks: [JSONValue] = []
    var tools: [JSONValue] = []
    var metadata: JSONValue = .null
    /// Durable `created_at` of a saved row; nil for optimistic and live rows.
    var createdAt: Date?
    init(id: String, role: String, text: String) { self.id = id; self.role = role; self.text = text }
    init(_ row: JSONValue) {
        id = row.id; role = row["role"].stringValue; text = row["content"].stringValue
        blocks = row["blocks"].parsedJSON.arrayValue; tools = row["tool_calls"].parsedJSON.arrayValue
        metadata = row["metadata"].parsedJSON
        createdAt = DesignChatTimestamp.date(row["created_at"])
    }
}

@MainActor final class ChatController: ObservableObject {
    let api: MichiAPI
    @Published private(set) var graph: WorkspaceGraph
    @Published private(set) var node: JSONValue
    var onGraphChanged: (() -> Void)?
    @Published var messages: [NativeMessage] = []
    // UI rows also contain optimistic sends and live steering events. Only an
    // owned user row read from durable history can settle initial context seeding.
    private var historyHydrated = false
    private var hasDurableUserHistory = false
    /// Ids of this node's rows from the last durable history read, in `seq`
    /// order. Branch anchors and "Use prompt again" accept only these.
    @Published private(set) var durableMessageIDs: [String] = []
    @Published var draft = "" { didSet {
        if !restoringComposer { mentions = NativeComposer.reanchor(mentions, previous: oldValue, next: draft); composerChanged() }
    } }
    @Published var quotedText = "" { didSet { composerChanged() } }
    @Published var quoteSource: JSONValue = .null { didSet { composerChanged() } }
    @Published var mentions: [JSONValue] = []
    @Published var queued: [NativeQueuedMessage] = [] { didSet { persistRecoveryQueue() } }
    @Published var queuePaused = false
    @Published var draftSaveError: String?
    @Published var steering = false
    @Published var commandRunning = false
    @Published var commandResult: String?
    /// Set only by the validated system-assistant surface. Ordinary conversations omit it.
    var metaAgentContext: JSONValue?
    var enableFollowUps = true
    private var restoringComposer = false
    private var draftGeneration = 0
    private var savedDraftGeneration = 0
    private var draftSaveTask: Task<Void, Never>?
    private var draftSaveIdentity: UUID?
    private var submittedComposer = NativeComposer()
    private var submittedQueue: [NativeQueuedMessage] = []
    let recoveryStore: NativeComposerRecoveryStore
    @Published private(set) var pendingSubmission: NativeComposerSubmission?
    @Published private(set) var submissionRecoveryError: String?
    private var recoveryReady = false
    private var restoringRecovery = false
    var recoveryScope: NativeComposerRecoveryScope {
        .init(connection: api.baseURL.absoluteString, workspaceID: graph.id, nodeID: node.id, windowID: composerWindowID)
    }
    var recoverableSubmissionText: String? { pendingSubmission?.composer.wireText }
    var recoverableSubmittedQueue: [NativeQueuedMessage] { pendingSubmission?.queueEntries ?? [] }
    var recoveryStatus: String? {
        if let submissionRecoveryError { return submissionRecoveryError }
        guard let pendingSubmission else { return nil }
        return pendingSubmission.kind == "command"
            ? "This command may already have run. Its original text is saved on this device. Resume will not repeat it."
            : "This message is saved on this device while its result is unconfirmed. Reconnecting only reads the original response; it does not resend the message."
    }
    private var terminalFailed = false
    let composerWindowID: String
    @Published var loading = false
    @Published var loaded = false
    @Published var busy = false
    @Published var reconnecting = false
    @Published var error: String?
    @Published var pendingPermission: JSONValue?
    @Published var pendingQuestion: JSONValue?
    @Published var plan: [JSONValue] = []
    @Published var tools: [JSONValue] = []
    @Published var thought = ""
    @Published var answer = ""
    @Published var followUps: [String] = []
    @Published var attachments: [JSONValue] = []
    @Published var uploading = false
    @Published var statusText = ""
    @Published var title: String
    @Published var runtimeID = ""
    private var defaultRuntimeID = ""
    @Published var providerID = ""
    @Published var modelID = ""
    @Published var reasoning = ""
    @Published var permissionMode = "ask"
    @Published var approveForMe = false
    private var reasoningExplicitlySelected = false
    func selectReasoning(_ value: String) { reasoning = value; reasoningExplicitlySelected = true }
    var resolvedRuntimeID: String { runtimeID.isEmpty ? defaultRuntimeID : runtimeID }
    @Published var modes: [JSONValue] = []
    @Published var modeID = ""
    @Published var sessionState: JSONValue = .null
    @Published var subagents: [JSONValue] = []
    @Published var usage: JSONValue = .null
    @Published var images: [JSONValue] = []
    @Published var liveBlocks: [TurnProjection.Block] = []
    private var projection: TurnProjection?
    private(set) var turnID: String?
    private var assistantID: String?
    /// Read-only: the assistant message the live blocks belong to, once known.
    var liveAssistantID: String? { assistantID }
    private var lastSequence = -1
    private var streamTask: Task<Void, Never>?
    private var streamIdentity: UUID?
    private var terminal = false
    private var detached = false
    private var sending = false
    private var isCancelRequested = false
    private var cancelSentAfterStart = false
    private var waitingForPreviousTurn = false
    private var submittedText = ""
    private var submittedAttachments: [JSONValue] = []
    private var storageKey: String { "michi.\(api.baseURL.absoluteString).\(node.id)" }
    private var activeTurnStorageKey: String { storageKey + "." + composerWindowID + ".activeTurn" }
    var displayedMessages: [NativeMessage] { messages.filter { $0.id != assistantID || (!busy && answer.isEmpty) } }
    var isReadOnly: Bool { graph.isArchived || graph.isDeleted || !node["deleted_at"].isNull || graph.trees.contains { $0.id == node["tree_id"].stringValue && !$0["archived_at"].isNull } }
    init(api: MichiAPI, graph: WorkspaceGraph, node: JSONValue, recoveryStore: NativeComposerRecoveryStore = NativeComposerRecoveryStore(), windowID: String? = nil) {
        self.api = api; self.graph = graph; self.node = node; title = graph.title(node); self.recoveryStore = recoveryStore
        let existing = UserDefaults.standard.string(forKey: "michi.nativeComposerWindow")
        composerWindowID = windowID ?? existing ?? "ios-" + UUID().uuidString.lowercased()
        if existing == nil && windowID == nil { UserDefaults.standard.set(composerWindowID, forKey: "michi.nativeComposerWindow") }
        runtimeID = node["runtime_id"].stringValue; providerID = node["provider_id"].stringValue; modelID = node["model_id"].stringValue
        reasoning = node["reasoning"].stringValue; modeID = node["current_mode_id"].stringValue
        let storedMode = node["permission_mode"].stringValue
        permissionMode = featureIsPermissionMode(storedMode) ? storedMode : "ask"
        approveForMe = permissionMode == "ask" && node["permission_approve_for_me"].intValue == 1
        restoreComposer(NativeComposer.fromNode(node, windowID: composerWindowID))
        if let cached = UserDefaults.standard.string(forKey: storageKey + ".pendingComposer"), let raw = try? JSONValue.parse(cached) {
            restoreComposer(NativeComposer(raw: raw)); draftGeneration = 1
        } else if let legacy = UserDefaults.standard.string(forKey: storageKey + ".draft"), !legacy.isEmpty {
            restoringComposer = true; draft = legacy; restoringComposer = false; draftGeneration = 1
        }
        turnID = UserDefaults.standard.string(forKey: activeTurnStorageKey)
            ?? (windowID == nil ? UserDefaults.standard.string(forKey: storageKey + ".activeTurn") : nil)
        restoreRecovery(); recoveryReady = true
        if turnID != nil { busy = true }
    }
    private func restoreRecovery() {
        restoringRecovery = true; defer { restoringRecovery = false }
        do {
            guard let state = try recoveryStore.load(recoveryScope) else { return }
            queued = state.queue.map { var entry = $0; entry.outcomeUnknown = entry.outcomeUnknown || entry.steering; entry.steering = false; return entry }
            if !queued.isEmpty { queuePaused = true }
            pendingSubmission = state.submission
            guard let submission = state.submission else { return }
            submittedComposer = submission.composer; submittedAttachments = submission.composer.attachments; submittedQueue = submission.queueEntries
            queuePaused = true
            if submission.kind == "turn" {
                turnID = submission.turnID; busy = true; terminal = false
                statusText = "Response status unknown"
            } else {
                markCommandUnknown(submission); statusText = "Command result unknown"
            }
        } catch { submissionRecoveryError = "Saved submission recovery is blocked: " + error.localizedDescription; queuePaused = true }
    }
    private func persistRecoveryQueue() {
        guard recoveryReady, !restoringRecovery else { return }
        do { try recoveryStore.updateQueue(queued, submissionID: pendingSubmission?.id, scope: recoveryScope) }
        catch { submissionRecoveryError = "Queue recovery could not be saved: " + error.localizedDescription; queuePaused = true }
    }
    private func reserveSubmission(_ submission: NativeComposerSubmission) throws {
        do {
            try recoveryStore.reserve(submission, queue: queued, scope: recoveryScope)
            pendingSubmission = submission
        } catch {
            restoreRecovery()
            throw error
        }
    }
    @discardableResult private func resolveSubmission(_ expectedID: String?, queue: [NativeQueuedMessage]? = nil) -> Bool {
        guard let submission = pendingSubmission else { return submissionRecoveryError == nil }
        guard submission.id == expectedID else { return false }
        do {
            try recoveryStore.resolve(submission, queue: queue ?? queued, scope: recoveryScope)
            pendingSubmission = nil; return true
        } catch { submissionRecoveryError = "The saved submission could not be resolved: " + error.localizedDescription; queuePaused = true; return false }
    }
    private func markCommandUnknown(_ submission: NativeComposerSubmission) {
        let ids = Set(submission.queueEntries.map(\.id))
        for index in queued.indices where ids.contains(queued[index].id) { queued[index].outcomeUnknown = true }
        for entry in submission.queueEntries where !queued.contains(where: { $0.id == entry.id }) {
            var unknown = entry; unknown.steering = false; unknown.outcomeUnknown = true; queued.append(unknown)
        }
        if submission.queueEntries.isEmpty, !queued.contains(where: { $0.id == submission.id }) {
            queued.append(NativeQueuedMessage(id: submission.id, composer: submission.composer, outcomeUnknown: true))
        }
        queuePaused = true
    }
    func refresh(graph: WorkspaceGraph, node: JSONValue) {
        if runtimeID == self.node["runtime_id"].stringValue { runtimeID = node["runtime_id"].stringValue }
        if providerID == self.node["provider_id"].stringValue { providerID = node["provider_id"].stringValue }
        if modelID == self.node["model_id"].stringValue { modelID = node["model_id"].stringValue }
        if reasoning == self.node["reasoning"].stringValue { reasoning = node["reasoning"].stringValue }
        let oldMode = featureIsPermissionMode(self.node["permission_mode"].stringValue) ? self.node["permission_mode"].stringValue : "ask"
        let oldApprove = oldMode == "ask" && self.node["permission_approve_for_me"].intValue == 1
        // Like the fields above, an unsaved local choice (including an
        // inherited Approve for me) survives an unrelated graph reload.
        if permissionMode == oldMode && approveForMe == oldApprove {
            let storedMode = node["permission_mode"].stringValue
            permissionMode = featureIsPermissionMode(storedMode) ? storedMode : permissionMode
            approveForMe = permissionMode == "ask" && node["permission_approve_for_me"].intValue == 1
        }
        self.graph = graph; self.node = node
        if !node["title"].stringValue.isEmpty { title = node["title"].stringValue }
    }
    var ownsActiveTurn: Bool { turnID != nil && busy }
    @discardableResult func load() async -> Bool {
        guard !loading else { return false }; loading = true; defer { loading = false }
        do {
            let result = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/trees/\(MichiAPI.pathSegment(node["tree_id"].stringValue))/messages")
            guard case .array(let rows) = result["messages"] else { throw NativeFailure("The saved conversation could not be read.") }
            messages = rows.filter { DesignChatOpaqueID.same($0["node_id"].stringValue, node.id) }.sorted { $0["seq"].intValue < $1["seq"].intValue }.map(NativeMessage.init)
            recordHydratedHistory(rows)
            loaded = true; scheduleDraftSave()
            if runtimeID.isEmpty && defaultRuntimeID.isEmpty, let status = try? await api.request("/agent/status") { defaultRuntimeID = status["runtime"].stringValue }
            if turnID == nil && node["status"].stringValue == "streaming" {
                turnID = node["last_applied_turn_id"].optionalString
                terminal = false; projection = nil; lastSequence = -1; assistantID = nil; liveBlocks = []
            }
            if turnID != nil && !terminal && streamTask == nil { resumeIfNeeded() }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    private func recordHydratedHistory(_ rows: [JSONValue]) {
        historyHydrated = true
        let owned = rows.filter {
            DesignChatOpaqueID.same($0["node_id"].stringValue, node.id) && !$0.id.isEmpty && !$0.id.hasPrefix("pending-")
                && ($0["workspace_id"].isNull || DesignChatOpaqueID.same($0["workspace_id"].stringValue, graph.id))
        }
        hasDurableUserHistory = hasDurableUserHistory || owned.contains { $0["role"] == "user" }
        durableMessageIDs = owned.sorted { $0["seq"].intValue < $1["seq"].intValue }.map { $0.id }
    }
    private func applySessionState(_ value: JSONValue) {
        guard case .object = value else { return }
        if case .number(let incoming) = value["version"], case .number(let current) = sessionState["version"], incoming < current { return }
        sessionState = value
        if value.objectValue["modelId"] != nil { modelID = value["modelId"].stringValue }
        if value.objectValue["currentModeId"] != nil { modeID = value["currentModeId"].stringValue }
        if value.objectValue["reasoning"] != nil { reasoning = value["reasoning"].stringValue }
        if case .array(let available) = value["availableModes"] { modes = available }
    }
    func loadModes() async {
        do { modes = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/modes")["availableModes"].arrayValue }
        catch { self.error = error.localizedDescription }
    }
    private func ensureSession(composer: NativeComposer? = nil) async throws {
        guard loaded, historyHydrated else { throw NativeFailure("Wait for saved conversation history to load before starting a session.") }
        var body: JSONValue = ["workspaceId": .string(graph.id), "enableFollowUps": .bool(enableFollowUps)]
        if !hasDurableUserHistory, let reference = try NativeDigestFollowUp.savedReference(node: node, graph: graph) {
            // A new branch seeds its selected digest only until its first saved
            // user turn. Later live/exact resumes keep runtime context; compatible
            // reconstruction uses the backend's own durable transcript, as on web.
            // Missing or changed initial context never silently disappears.
            let snapshot = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))")
            guard snapshot["workspace"].id == graph.id, case .array = snapshot["nodes"], case .array = snapshot["trees"], case .array = snapshot["edges"] else {
                throw NativeFailure("The digest context could not be refreshed. Your draft has been kept.")
            }
            let current = WorkspaceGraph(raw: snapshot)
            body["mergeContexts"] = [.string(try NativeDigestFollowUp.context(reference: reference, nodeID: node.id, graph: current))]
        }
        let manifest = try artifactManifest(for: composer)
        if !manifest.all.isEmpty { body["contextManifest"] = .array(manifest.all) }
        if !manifest.selected.isEmpty { body["extraContexts"] = .array(manifest.selected) }
        var cwd = graph.workspace["cwd"].stringValue
        if cwd.isEmpty {
            let location = try await api.request("/uploads/web-cwd", method: "POST", body: ["workspaceId": .string(graph.id)])
            guard !location["cwd"].stringValue.isEmpty else { throw NativeFailure("Could not resolve this workspace's folder.") }
            cwd = location["cwd"].stringValue
        }
        let fields = ["cwd": cwd, "runtimeId": runtimeID, "providerId": providerID, "modelId": modelID, "reasoning": reasoning, "modeId": modeID, "parentChatId": node["parent_node_id"].stringValue]
        for (key, value) in fields where !value.isEmpty { body[key] = .string(value) }
        if reasoningExplicitlySelected && reasoning.isEmpty { body["reasoning"] = .null }
        let permission = featureIsPermissionMode(permissionMode) ? permissionMode : (node["permission_mode"].stringValue.isEmpty ? "ask" : node["permission_mode"].stringValue)
        body["permissionMode"] = .string(permission)
        body["approveForMe"] = .bool(permission == "ask" && approveForMe)
        let result = try await api.request("/nodes/\(MichiAPI.pathSegment(node.id))/ensure-session", method: "POST", body: body)
        applySessionState(result["sessionState"])
    }
    func send() { send(composerSnapshot, queueEntries: []) }
    private func send(_ composer: NativeComposer, queueEntries: [NativeQueuedMessage]) {
        let text = composer.value.trimmingCharacters(in: .whitespacesAndNewlines)
        let turnMetaContext = metaAgentContext
        guard !composer.isEmpty, !busy, !sending, !uploading, !commandRunning, loaded, !isReadOnly, turnID == nil, pendingSubmission == nil, submissionRecoveryError == nil else { return }
        if let command = NativeChatCommand.parse(text, runtime: runtimeID.isEmpty ? defaultRuntimeID : runtimeID, engine: sessionState["nativeEngine"].stringValue), composer.quotedText.isEmpty, composer.attachments.isEmpty {
            Task { await executeComposerCommand(command, composer: composer, queueEntries: queueEntries) }; return
        }
        sending = true; busy = true; error = nil; detached = false; terminal = false; terminalFailed = false; isCancelRequested = false; cancelSentAfterStart = false
        let identity = UUID(); streamIdentity = identity
        streamTask = Task { [weak self] in
            guard let self else { return }
            defer { if streamIdentity == identity { streamTask = nil; sending = false } }
            let wireText: String
            do { try await ensureSession(composer: composer); wireText = try await resolvedPrompt(composer) }
            catch { if streamIdentity == identity { self.error = error.localizedDescription; busy = false; if !queueEntries.isEmpty { queuePaused = true } }; return }
            guard !Task.isCancelled && streamIdentity == identity else { return }
            guard !isReadOnly else { busy = false; error = "This conversation is now read-only."; return }
            guard queueEntriesStillPending(queueEntries) else { busy = false; terminal = true; queuePaused = true; return }
            let id = UUID().uuidString.lowercased()
            var payload: JSONValue = ["text": .string(wireText), "nodeId": .string(node.id), "turnId": .string(id), "displayText": .string(composer.value), "userMetadata": composer.metadata]
            if let turnMetaContext { payload["metaAgentContext"] = turnMetaContext }
            let submission = NativeComposerSubmission(id: id, kind: "turn", turnID: id, path: "/chats/\(MichiAPI.pathSegment(node.id))/message", payload: payload, composer: composer, queueEntries: queueEntries)
            do { try reserveSubmission(submission) }
            catch { self.error = error.localizedDescription; busy = pendingSubmission?.kind == "turn"; queuePaused = true; return }
            turnID = id; lastSequence = -1; assistantID = nil; submittedText = text
            projection = TurnProjection(nodeId: node.id, turnId: id)
            liveBlocks = []; answer = ""; thought = ""; tools = []; plan = []; images = []; usage = .null; pendingPermission = nil; pendingQuestion = nil
            UserDefaults.standard.set(id, forKey: activeTurnStorageKey)
            submittedComposer = composer; submittedAttachments = composer.attachments; submittedQueue = queueEntries
            queued.removeAll { item in queueEntries.contains { $0.id == item.id } }
            var optimistic = NativeMessage(id: "pending-" + id, role: "user", text: composer.value)
            optimistic.metadata = composer.metadata; messages.append(optimistic)
            if queueEntries.isEmpty && composerSnapshot == composer { restoreComposer(NativeComposer()); composerChanged() }
            var busyRetries = 0
            while !Task.isCancelled {
                do {
                    waitingForPreviousTurn = false
                    for try await event in api.stream("/chats/\(MichiAPI.pathSegment(node.id))/message", method: "POST", body: payload) {
                        guard !Task.isCancelled else { break }; consume(event)
                        if terminal { break }
                    }
                    break
                } catch let failure as MichiAPIError where failure.statusCode == 409 && failure.code == "turn_active" && lastSequence < 0 {
                    // The backend explicitly proves this turn never started.
                    if isCancelRequested { rejectUnstarted("Message was not sent."); break }
                    waitingForPreviousTurn = true; statusText = "Waiting for the previous response…"
                    busyRetries += 1
                    if busyRetries > 12 { rejectUnstarted("The previous response is still running. Your message remains in the composer."); break }
                    do { try await Task.sleep(for: .milliseconds(min(2000, busyRetries * 250))) } catch { break }
                } catch let failure as MichiAPIError where failure.isPreDispatchRefusal && lastSequence < 0 {
                    rejectUnstarted(failure.localizedDescription); break
                } catch let failure as MichiAPIError where failure.statusCode.map({ (400..<500).contains($0) }) == true && lastSequence < 0 {
                    rejectUnstarted(failure.localizedDescription); break
                } catch {
                    if !Task.isCancelled { statusText = "Reconnecting to this response…" }; break
                }
            }
            guard streamIdentity == identity else { return }
            sending = false
            if !terminal && !Task.isCancelled { await recover() }
            if terminal { await finish() }
        }
    }
    private func consume(_ event: SSEEvent) {
        let data = event.data
        if projection == nil { projection = TurnProjection(nodeId: node.id, turnId: turnID) }
        guard var current = projection else { return }
        if case .rejected = current.apply(event) { return }
        projection = current; lastSequence = current.lastAppliedSeq; assistantID = current.assistantId
        if isCancelRequested, !cancelSentAfterStart, lastSequence >= 0, !current.isTerminal, let id = turnID {
            // The earlier cancel may have arrived before /message registered
            // this turn. Its first stamped frame now proves the target exists.
            cancelSentAfterStart = true
            Task { await postCancel(id) }
        }
        answer = current.answerText; thought = current.thoughtText; liveBlocks = current.blocks; plan = current.plan
        tools = current.toolCalls.map { tool in
            var row: JSONValue = ["id": .string(tool.id), "toolCallId": .string(tool.id), "title": .string(tool.title), "status": .string(tool.status)]
            row["detail"] = tool.detail.map(JSONValue.string) ?? .null
            row["inputJson"] = tool.inputJSON.map(JSONValue.string) ?? .null
            row["output"] = tool.output.map(JSONValue.string) ?? .null
            return row
        }
        pendingPermission = current.permissions.first.map { request in
            ["requestId": .number(Double(request.requestId)), "title": .string(request.title),
             "detail": request.detail.map(JSONValue.string) ?? .null,
             "options": .array(request.options.map { ["optionId": .string($0.optionId), "name": .string($0.name), "disabled": .bool($0.disabled)] })]
        }
        pendingQuestion = current.pendingUserInputs.first.map { request in
            ["requestId": .number(Double(request.requestId)), "interactionId": .string(request.interactionId), "questions": .array(request.questions)]
        }
        switch event.event {
        case "turn_start": statusText = "Working…"
        case "title": title = data["title"].stringValue
        case "follow_ups": followUps = data["followUps"].arrayValue.map(\.stringValue)
        case "session_state": applySessionState(data)
        case "subagent_list_update":
            for agent in data["subagents"].arrayValue {
                if let i = subagents.firstIndex(where: { $0["sessionId"] == agent["sessionId"] }) { subagents[i] = subagents[i].merging(agent.objectValue) }
                else { subagents.append(agent) }
            }
        case "usage_summary", "context_usage": usage = usage.merging(data.objectValue)
        case "image": images.append(data)
        case "steer_accepted":
            let queueID = data["queueId"].stringValue
            queued.removeAll { $0.id == queueID }
            let messageID = data["messageId"].optionalString ?? "u-steer-\(assistantID ?? "")-\(data["seq"].intValue)"
            if !messages.contains(where: { $0.id == messageID }) {
                var message = NativeMessage(id: messageID, role: "user", text: data["displayText"].optionalString ?? data["text"].stringValue)
                message.metadata = data["userMetadata"].merging(["steered": true]); messages.append(message)
            }
        case "spawn_branches", "artifact_saved", "artifact_updated": onGraphChanged?()
        case "compaction_start": statusText = "Compacting context…"
        case "retry_start": statusText = data["detail"].stringValue.isEmpty ? "Agent is retrying…" : data["detail"].stringValue
        case "cancel_phase": statusText = data["phase"].stringValue == "settled" ? "Stopped" : "Stopping…"
        case "warning", "mcp_server_error": statusText = data["message"].optionalString ?? data["error"].stringValue
        case "done":
            terminalFailed = data["stopReason"] == "error" || data["persisted"] == false
            if terminalFailed { queuePaused = true; error = data["persisted"] == false ? "The response finished but the backend did not confirm durable persistence." : "Agent process exited before completing the turn." }
            terminal = true; statusText = ["cancel", "cancelled"].contains(data["stopReason"].stringValue) ? "Stopped" : ""
        case "error": terminalFailed = true; queuePaused = true; terminal = true; error = data["message"].stringValue; statusText = ""
        default: break
        }
    }
    private func recover() async {
        guard let id = turnID else { return }
        let identity = streamIdentity
        reconnecting = true; defer { if streamIdentity == identity { reconnecting = false } }
        for attempt in 0..<4 {
            if Task.isCancelled || detached { return }
            do {
                if attempt > 0 { try await Task.sleep(for: .milliseconds(400 * (1 << attempt))) }
                for try await event in api.stream("/chats/\(MichiAPI.pathSegment(node.id))/stream?fromTurnId=\(MichiAPI.pathSegment(id))&fromSeq=\(lastSequence + 1)") {
                    if Task.isCancelled { return }; consume(event); if terminal { return }
                }
            } catch let failure as MichiAPIError where failure.statusCode == 410 {
                if await reconcileUnavailable(failure.localizedDescription) { return }
            } catch { if Task.isCancelled { return } }
        }
        busy = true // Unknown outcome must block a second send; do not lose the turn identity.
        error = "The connection ended before completion could be confirmed. Reconnect to this response or reload its saved conversation before sending again."
        statusText = "Response status unknown"
    }
    private func finish() async {
        let completedTurn = turnID
        pendingPermission = nil; pendingQuestion = nil; isCancelRequested = false; cancelSentAfterStart = false; sending = false
        // Only a validated terminal frame or exact durable-turn evidence reaches here.
        guard resolveSubmission(completedTurn) else { busy = true; statusText = "Submission recovery needs attention"; return }
        UserDefaults.standard.removeObject(forKey: activeTurnStorageKey)
        UserDefaults.standard.removeObject(forKey: storageKey + ".activeTurn")
        // Keep visible text if final hydration fails; don't blank a successful reply.
        do {
            let result = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/trees/\(MichiAPI.pathSegment(node["tree_id"].stringValue))/messages")
            if case .array(let rows) = result["messages"] {
                let loaded = rows.filter { $0["node_id"].stringValue == node.id }.sorted { $0["seq"].intValue < $1["seq"].intValue }.map(NativeMessage.init)
                messages = loaded
                recordHydratedHistory(rows)
                if assistantID.map({ id in loaded.contains { $0.id == id } }) == true { answer = ""; thought = ""; tools = []; liveBlocks = []; assistantID = nil }
            }
        } catch { self.error = "Response finished, but saved history could not refresh: " + error.localizedDescription }
        if turnID == completedTurn {
            turnID = nil; busy = false
            if !terminalFailed && !queuePaused && !detached { Task { await Task.yield(); self.flushQueue() } }
        }; onGraphChanged?()
    }
    private func rejectUnstarted(_ message: String) {
        queuePaused = true
        if !submittedQueue.isEmpty {
            queued.insert(contentsOf: submittedQueue.filter { entry in !queued.contains { $0.id == entry.id } }, at: 0)
        } else if composerSnapshot.isEmpty { restoreComposer(submittedComposer); composerChanged() }
        else if !submittedComposer.isEmpty { queued.insert(NativeQueuedMessage(composer: submittedComposer), at: 0) }
        guard resolveSubmission(turnID) else { busy = true; statusText = "Submission recovery needs attention"; return }
        if let turnID { messages.removeAll { $0.id == "pending-" + turnID } }
        UserDefaults.standard.removeObject(forKey: activeTurnStorageKey)
        UserDefaults.standard.removeObject(forKey: storageKey + ".activeTurn")
        turnID = nil; busy = false; terminal = true; waitingForPreviousTurn = false; error = message; statusText = ""
    }
    private func reconcileUnavailable(_ message: String) async -> Bool {
        do {
            let snapshot = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))")
            let current = snapshot["nodes"].arrayValue.first { $0.id == node.id }
            if let current, snapshot["workspace"].id == graph.id, ["idle", "error"].contains(current["status"].stringValue) {
                guard let id = turnID else { return false }
                var hasEvidence = current["last_applied_turn_id"].stringValue == id
                if !hasEvidence, !current["last_applied_turn_id"].stringValue.isEmpty {
                    // A newer durable turn may have superseded an old saved
                    // marker. Require the old turn's exact persisted assistant.
                    let history = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/trees/\(MichiAPI.pathSegment(node["tree_id"].stringValue))/messages")
                    let expected = "a-\(node.id)-\(id)"
                    hasEvidence = history["messages"].arrayValue.contains { $0.id == expected && $0["node_id"].stringValue == node.id && $0["role"].stringValue == "assistant" }
                }
                guard hasEvidence else { return false }
                terminal = true; terminalFailed = true; queuePaused = true; error = message; return true
            }
        } catch { /* Preserve the pending turn on failed reconciliation. */ }
        error = message; statusText = "Response status unknown"; busy = true; return false
    }
    func detach() {
        detached = true; draftSaveTask?.cancel(); streamTask?.cancel(); streamTask = nil; streamIdentity = nil; sending = false
        if waitingForPreviousTurn { rejectUnstarted("Message was not sent before the app disconnected. It is still in the composer.") }
        else if turnID == nil { busy = false }
    }
    func resumeIfNeeded() {
        detached = false; scheduleDraftSave()
        guard turnID != nil, !terminal, streamTask == nil else { if !busy { flushQueue() }; return }
        detached = false; busy = true; error = nil
        let identity = UUID(); streamIdentity = identity
        streamTask = Task {
            defer { if streamIdentity == identity { streamTask = nil } }
            await recover(); if terminal && streamIdentity == identity { await finish() }
        }
    }
    func stop() async {
        if waitingForPreviousTurn || (sending && turnID == nil) {
            streamTask?.cancel(); streamTask = nil; streamIdentity = nil; sending = false
            if turnID != nil { rejectUnstarted("Message was not sent.") }
            else { busy = false; error = "Message was not sent." }
            return
        }
        guard let id = turnID, !isCancelRequested else { return }
        isCancelRequested = true; cancelSentAfterStart = lastSequence >= 0
        await postCancel(id)
    }
    private func postCancel(_ id: String) async {
        do {
            _ = try await api.request("/chats/\(MichiAPI.pathSegment(node.id))/cancel", method: "POST", body: ["turnId": .string(id)])
            if turnID == id && !terminal { statusText = "Stopping…"; resumeIfNeeded() }
        } catch {
            if turnID == id { self.error = error.localizedDescription; isCancelRequested = false; cancelSentAfterStart = false }
        }
    }
    func permission(_ option: String?) async {
        guard let pendingPermission else { return }
        var body: JSONValue = ["requestId": pendingPermission["requestId"]]
        if let option { body["optionId"] = .string(option) } else { body["cancel"] = true }
        do { _ = try await api.request("/chats/\(MichiAPI.pathSegment(node.id))/permission-response", method: "POST", body: body); self.pendingPermission = nil }
        catch { self.error = error.localizedDescription }
    }
    func respond(answers: [JSONValue], skip: Bool = false) async {
        guard let pendingQuestion else { return }
        var body: JSONValue = ["requestId": pendingQuestion["requestId"], "answers": .array(answers)]
        if !pendingQuestion["interactionId"].isNull { body["interactionId"] = pendingQuestion["interactionId"] }
        if skip { body["skip"] = true }
        do { _ = try await api.request("/chats/\(MichiAPI.pathSegment(node.id))/user-input-response", method: "POST", body: body); self.pendingQuestion = nil }
        catch { self.error = error.localizedDescription }
    }
    func steer() async {
        guard !composerSnapshot.isEmpty, busy, !steering, loaded, !isReadOnly, turnID != nil else { return }
        let entry = NativeQueuedMessage(composer: composerSnapshot)
        queued.append(entry); restoreComposer(NativeComposer()); composerChanged()
        await steerQueued(entry.id)
    }
    func steerQueued(_ id: String) async {
        guard busy, !steering, !isReadOnly, let intendedTurn = turnID, let index = queued.firstIndex(where: { $0.id == id }), !queued[index].outcomeUnknown else { return }
        steering = true; queued[index].steering = true; defer { steering = false; if let i = queued.firstIndex(where: { $0.id == id }) { queued[i].steering = false }; if !busy && !queuePaused { Task { await Task.yield(); self.flushQueue() } } }
        let composer = queued[index].composer
        var submitted = false, explicitlyRejected = false
        do {
            let wireText = try await resolvedPrompt(composer)
            guard !Task.isCancelled, turnID == intendedTurn, busy, !terminal, !detached, !isReadOnly else {
                error = "The response changed before steering was submitted. Your message remains queued."; return
            }
            submitted = true
            let result = try await api.request("/chats/\(MichiAPI.pathSegment(node.id))/steer", method: "POST", body: ["text": .string(wireText), "displayText": .string(composer.expandedText), "userMetadata": composer.metadata, "queueId": .string(id)])
            guard case .bool(let accepted) = result["accepted"] else { throw NativeFailure("The steering result could not be confirmed. Check the response before submitting again.") }
            if !accepted { explicitlyRejected = true; throw NativeFailure(result["reason"].optionalString ?? "Steer was not accepted. Your message remains queued.") }
            queued.removeAll { $0.id == id }
            if !result["message"].isNull { consume(SSEEvent(event: "steer_accepted", data: result["message"])) }
        } catch {
            self.error = error.localizedDescription
            // A response lost after the runtime accepted steering cannot be
            // resubmitted automatically. Keep a visible reconciliation entry.
            let status = (error as? MichiAPIError)?.statusCode
            let confirmedRejection = explicitlyRejected || status.map { [400, 401, 403, 404, 409, 422].contains($0) } == true
            if submitted && !confirmedRejection {
                if let i = queued.firstIndex(where: { $0.id == id }) { queued[i].outcomeUnknown = true }
                queuePaused = true
            }
        }
    }
    private func executeComposerCommand(_ command: NativeChatCommand, composer: NativeComposer, queueEntries: [NativeQueuedMessage], clearsComposer: Bool = true) async {
        guard !commandRunning, !busy, !isReadOnly, pendingSubmission == nil, submissionRecoveryError == nil else { return }
        commandRunning = true; defer { commandRunning = false }
        var submitted = false, explicitlyRejected = false
        let path = "/chats/\(MichiAPI.pathSegment(node.id))/" + (command.name == "compact" ? "compact" : "execute-command")
        let payload: JSONValue = command.name == "compact"
            ? (command.value.isEmpty ? [:] : ["instructions": .string(command.value)])
            : ["command": .string(command.name), "args": command.value.isEmpty ? [:] : ["value": .string(command.value)]]
        let submission = NativeComposerSubmission(id: UUID().uuidString.lowercased(), kind: "command", turnID: nil,
            path: path, payload: payload, composer: composer, queueEntries: queueEntries)
        do {
            try await ensureSession()
            guard !Task.isCancelled, !detached, !isReadOnly, queueEntriesStillPending(queueEntries) else { queuePaused = true; return }
            try reserveSubmission(submission)
            submitted = true
            let result = try await api.request(path, method: "POST", body: payload)
            if command.name == "compact" {
                guard case .bool(let started) = result["started"] else { throw NativeFailure("The command result could not be confirmed.") }
                if !started { explicitlyRejected = true; throw NativeFailure(result["detail"].optionalString ?? "Compaction is unavailable.") }
            } else {
                guard result["success"] == true else { throw NativeFailure(result["message"].optionalString ?? "The command result could not be confirmed.") }
            }
            let remaining = queued.filter { entry in !queueEntries.contains { $0.id == entry.id } }
            guard resolveSubmission(submission.id, queue: remaining) else { markCommandUnknown(submission); return }
            commandResult = result["message"].optionalString ?? result["detail"].optionalString ?? "/\(command.name) completed."
            if !result["data"].isNull { commandResult! += "\n" + (result["data"].optionalString ?? result["data"].prettyPrinted) }
            if !result["sessionState"].isNull { applySessionState(result["sessionState"]) }
            queued = remaining
            if clearsComposer, queueEntries.isEmpty && composerSnapshot == composer { restoreComposer(NativeComposer()); composerChanged() }
            Task { await Task.yield(); self.flushQueue() }
        } catch {
            self.error = error.localizedDescription; queuePaused = true
            if submitted {
                if explicitlyRejected || Self.commandWasRejected(error, compact: command.name == "compact") {
                    _ = resolveSubmission(submission.id)
                } else { markCommandUnknown(submission); statusText = "Command result unknown" }
            }
        }
    }
    private static func commandWasRejected(_ error: Error, compact: Bool) -> Bool {
        guard let failure = error as? MichiAPIError else { return false }
        if [401, 403, 404].contains(failure.statusCode ?? 0) { return true }
        if compact { return failure.statusCode == 409 } // The route emits 409 only for started:false.
        if failure.statusCode == 400 { return ["command is required", "Active session does not support command execution"].contains(failure.message) }
        if failure.statusCode == 409 { return ["Wait for the active turn to finish before executing a command.", "Cannot change model during an active turn"].contains(failure.message) }
        return false
    }
    func compact() async {
        guard loaded, !busy, !commandRunning, !isReadOnly, pendingSubmission == nil, submissionRecoveryError == nil else { return }
        var composer = NativeComposer(); composer.value = "/compact"
        await executeComposerCommand(.init(name: "compact", value: ""), composer: composer, queueEntries: [], clearsComposer: false)
    }
    func upload(_ url: URL) async {
        guard loaded, !isReadOnly, !uploading else { return }
        uploading = true; defer { uploading = false }
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 20 * 1024 * 1024 else { throw NativeFailure("Choose a file smaller than 20 MB.") }
            let bytes = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: url, options: .mappedIfSafe) }.value
            guard bytes.count <= 20 * 1024 * 1024 else { throw NativeFailure("Choose a file smaller than 20 MB.") }
            let location = try await api.request("/uploads/web-cwd", method: "POST", body: ["workspaceId": .string(graph.id)])
            guard !location["cwd"].stringValue.isEmpty else { throw NativeFailure("Could not resolve the upload folder.") }
            let result = try await api.request("/workspaces/import-file", method: "POST", body: ["workspaceId": .string(graph.id), "cwd": location["cwd"], "originalName": .string(url.lastPathComponent), "contentBase64": .string(bytes.base64EncodedString()), "subdir": ".attachments"])
            guard !result["filePath"].stringValue.isEmpty else { throw NativeFailure("The upload did not return a file reference.") }
            let relative = result["filePath"].stringValue
            let absolute = relative.hasPrefix("/") ? relative : location["cwd"].stringValue + "/" + relative
            attachments.append(result.merging(["name": result["displayName"].isNull ? result["name"] : result["displayName"], "absPath": .string(absolute)]))
        } catch { self.error = error.localizedDescription }
    }
    var composerSnapshot: NativeComposer {
        var value = NativeComposer(); value.value = draft; value.mentions = mentions
        value.attachments = attachments; value.quotedText = quotedText; value.quoteSource = quoteSource
        return value
    }
    var otherWindowDrafts: [(id: String, composer: NativeComposer)] {
        node["composer_draft"].parsedJSON["__michiWindowDrafts"].objectValue
            .filter { $0.key != composerWindowID }.map { (id: $0.key, composer: NativeComposer(raw: $0.value)) }
            .filter { !$0.composer.isEmpty }.sorted { $0.id < $1.id }
    }
    private func restoreComposer(_ composer: NativeComposer, keepAttachments: Bool = false) {
        restoringComposer = true
        draft = composer.value; mentions = composer.mentions; quotedText = composer.quotedText; quoteSource = composer.quoteSource
        if !keepAttachments { attachments = composer.attachments }
        restoringComposer = false
    }
    func useDraft(_ composer: NativeComposer) {
        if !composerSnapshot.isEmpty { queued.append(NativeQueuedMessage(composer: composerSnapshot)); queuePaused = true }
        restoreComposer(composer); composerChanged()
    }
    func quote(_ message: NativeMessage) {
        quotedText = message.text
        quoteSource = message.role == "assistant" ? .null : ["type": "attached"]
    }
    func insertMention(kind: String, id: String, label: String) {
        guard !isReadOnly, loaded else { return }
        if !draft.isEmpty && !draft.hasSuffix(" ") { draft += " " }
        let start = draft.utf16.count
        draft += "@" + label
        mentions.append(["start": .number(Double(start)), "end": .number(Double(draft.utf16.count)), "kind": .string(kind), "refId": .string(id), "label": .string(label)])
        draft += " "; composerChanged()
    }
    func clearQuote() { quotedText = ""; quoteSource = .null }
    var mentionChips: [DesignChatMentionChip] { DesignChatMentions.chips(value: draft, mentions: mentions) }
    /// Removes one exact mention and its separating space. A chip from a
    /// stale render that no longer matches the draft changes nothing.
    @discardableResult func removeMention(_ chip: DesignChatMentionChip) -> Bool {
        guard !isReadOnly, let next = DesignChatMentions.removing(chip, value: draft, mentions: mentions) else { return false }
        restoringComposer = true; draft = next.value; mentions = next.mentions; restoringComposer = false
        composerChanged(); return true
    }

    /// This controller's next-session agent fields, as a branch inherits them.
    var agentSettings: DesignChatAgentSettings {
        DesignChatAgentSettings(runtimeID: runtimeID, providerID: providerID, modelID: modelID, reasoning: reasoning,
                                reasoningExplicit: reasoningExplicitlySelected, permissionMode: permissionMode, approveForMe: approveForMe).normalized
    }
    /// "Same as parent": a new, empty branch of `parentNodeID` takes the
    /// parent's settings before its first session. They are sent with that
    /// session's ensure-session call; until then they live only here.
    @discardableResult func adoptBranchAgentSettings(_ settings: DesignChatAgentSettings, parentNodeID: String, workspaceID: String) -> Bool {
        guard !parentNodeID.isEmpty, DesignChatOpaqueID.same(node["parent_node_id"].stringValue, parentNodeID),
              DesignChatOpaqueID.same(graph.id, workspaceID), !isReadOnly,
              turnID == nil, !busy, !sending, !commandRunning, pendingSubmission == nil, submissionRecoveryError == nil,
              !hasDurableUserHistory, !messages.contains(where: { $0.role == "user" }) else { return false }
        let value = settings.normalized
        runtimeID = value.runtimeID; providerID = value.providerID; modelID = value.modelID
        reasoning = value.reasoning; reasoningExplicitlySelected = value.reasoningExplicit
        permissionMode = value.permissionMode; approveForMe = value.approveForMe
        return true
    }

    func promptAgainSource(for reply: NativeMessage) -> Result<DesignChatPromptAgain.Source, DesignChatPromptAgain.Unavailable> {
        DesignChatPromptAgain.source(forReply: reply.id, messages: messages, durableIDs: durableMessageIDs)
    }
    var promptAgainReplyIDs: Set<DesignChatOpaqueID> { DesignChatPromptAgain.availableReplyIDs(messages: messages, durableIDs: durableMessageIDs) }
    /// Why the composer cannot take a saved prompt now, if it cannot.
    var promptAgainBlocked: DesignChatPromptAgain.Blocked? {
        if isReadOnly { return .readOnly }
        if !loaded { return .notLoaded }
        if busy || sending || commandRunning || reconnecting || steering || turnID != nil || pendingSubmission != nil || submissionRecoveryError != nil
            || queued.contains(where: { $0.outcomeUnknown || $0.steering }) { return .submissionUnresolved }
        if uploading || !composerSnapshot.isEmpty { return .draftNotEmpty }
        return nil
    }
    /// Copies the reply's saved prompt (text, quote, attachments) into the
    /// empty composer. It never sends; the user reviews it and taps Send.
    @discardableResult func usePromptAgain(_ reply: NativeMessage) -> DesignChatPromptAgain.Outcome {
        if let blocked = promptAgainBlocked { return .blocked(blocked) }
        switch promptAgainSource(for: reply) {
        case .failure(let reason): return .blocked(.unavailable(reason))
        case .success(let source):
            restoreComposer(source.composer); composerChanged()
            return .filled(mentionsNotRestored: source.mentionsNotRestored)
        }
    }
    private func composerChanged() {
        guard !restoringComposer else { return }
        draftGeneration += 1
        UserDefaults.standard.set(composerSnapshot.persisted.prettyPrinted, forKey: storageKey + ".pendingComposer")
        UserDefaults.standard.removeObject(forKey: storageKey + ".draft")
        scheduleDraftSave()
    }
    private func scheduleDraftSave() {
        guard loaded, !detached, !isReadOnly, draftGeneration != savedDraftGeneration, draftSaveTask == nil else { return }
        let identity = UUID(); draftSaveIdentity = identity
        draftSaveTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if draftSaveIdentity == identity {
                    draftSaveTask = nil; draftSaveIdentity = nil
                    if Task.isCancelled && !detached { scheduleDraftSave() }
                }
            }
            while draftGeneration != savedDraftGeneration && !Task.isCancelled && !isReadOnly {
                do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
                guard !isReadOnly, !detached, !Task.isCancelled, draftSaveIdentity == identity else { return }
                let generation = draftGeneration, snapshot = composerSnapshot.persisted
                do {
                    let field: JSONValue = snapshot.isNull ? .null : .string(snapshot.prettyPrinted)
                    _ = try await api.request("/workspaces/\(MichiAPI.pathSegment(graph.id))/commands", method: "POST", body: [
                        "operationId": .string(UUID().uuidString), "commands": [["type": "node.patch", "payload": ["id": .string(node.id), "composer_draft": field, "composer_draft_window_id": .string(composerWindowID)]]]
                    ])
                    guard draftSaveIdentity == identity, !Task.isCancelled else { return }
                    savedDraftGeneration = generation; draftSaveError = nil
                    // Until the next graph read, reflect our acknowledged slot
                    // locally so an unrelated refresh cannot restore old text.
                    var raw = node["composer_draft"].parsedJSON
                    var windows = raw["__michiWindowDrafts"].objectValue; windows[composerWindowID] = field
                    raw["__michiWindowDrafts"] = .object(windows); node["composer_draft"] = .string(raw.prettyPrinted)
                    if generation == draftGeneration { UserDefaults.standard.removeObject(forKey: storageKey + ".pendingComposer") }
                } catch { if draftSaveIdentity == identity && !Task.isCancelled { draftSaveError = "Draft is kept on this device. " + error.localizedDescription }; return }
            }
        }
    }
    func retryDraftSave() { scheduleDraftSave() }
    func enqueueDraft() {
        guard loaded, !isReadOnly, !uploading, !composerSnapshot.isEmpty else { return }
        queued.append(NativeQueuedMessage(composer: composerSnapshot))
        guard submissionRecoveryError == nil else { return }
        restoreComposer(NativeComposer()); composerChanged()
        if !busy && !queuePaused { flushQueue() }
    }
    func restoreQueued(_ id: String) {
        guard let index = queued.firstIndex(where: { $0.id == id }), !queued[index].steering, !queued[index].outcomeUnknown else { return }
        let entry = queued.remove(at: index)
        if !composerSnapshot.isEmpty { queued.insert(NativeQueuedMessage(composer: composerSnapshot), at: index) }
        restoreComposer(entry.composer); composerChanged()
    }
    private func queueEntriesStillPending(_ entries: [NativeQueuedMessage]) -> Bool {
        entries.allSatisfy { snapshot in
            queued.contains { $0.id == snapshot.id && $0.composer == snapshot.composer && !$0.steering && !$0.outcomeUnknown }
        }
    }
    func removeQueued(_ id: String) { queued.removeAll { $0.id == id && !$0.steering && !$0.outcomeUnknown } }
    func flushQueue() {
        guard !busy, !sending, !commandRunning, !detached, !queuePaused, !isReadOnly, pendingSubmission == nil, submissionRecoveryError == nil,
              let first = queued.first, !first.steering, !first.outcomeUnknown else { return }
        // Preserve independently sourced quotes and slash-command boundaries.
        // Adjacent ordinary text entries match the web's combined flush.
        var batch = [first]
        if first.composer.quotedText.isEmpty && !first.composer.value.hasPrefix("/") {
            for next in queued.dropFirst() {
                if next.steering || next.outcomeUnknown || !next.composer.quotedText.isEmpty || next.composer.value.hasPrefix("/") { break }
                batch.append(next)
            }
        }
        var composer = first.composer
        if batch.count > 1 {
            composer.value = ""; composer.mentions = []
            for entry in batch {
                if !composer.value.isEmpty { composer.value += "\n\n" }
                let offset = composer.value.utf16.count
                composer.value += entry.composer.value
                composer.mentions += entry.composer.mentions.map { mention in mention.merging(["start": .number(Double(mention["start"].intValue + offset)), "end": .number(Double(mention["end"].intValue + offset))]) }
            }
            composer.attachments = batch.flatMap { $0.composer.attachments }
        }
        send(composer, queueEntries: batch)
    }
    func resumeQueue() {
        guard pendingSubmission?.kind != "command", submissionRecoveryError == nil, !queued.contains(where: \.outcomeUnknown) else {
            queuePaused = true; error = "An earlier operation has an unknown result. Resume cannot execute it again."; return
        }
        queuePaused = false; flushQueue()
    }

}
