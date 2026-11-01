import Foundation

/// Pure projection of one durable turn from its stamped stream frames, for
/// live display. It follows the identity, sequence and accumulation rules of
/// shared/src/turnProjection.ts; the backend's persisted turn stays
/// authoritative after hydration. Raw answer text keeps metadata sentinels
/// (`[TITLE: ...]` etc.), which this projection does not strip. Text offsets
/// count UTF-16 code units, like the web projection.
public struct TurnProjection: Equatable, Sendable {
    public enum Status: String, Equatable, Sendable { case active, completed, cancelled, error }
    public enum Section: String, Equatable, Sendable { case answer, thinking }

    public enum Outcome: Equatable, Sendable {
        /// The frame changed projected state.
        case applied
        /// Accepted and its `seq` recorded, but it carries no projected state
        /// (`heartbeat`, `session_state`, or an event this client does not know).
        case ignored
        case rejected(Rejection)
    }

    public enum Rejection: String, Equatable, Sendable {
        /// Another node's frame.
        case foreignNode
        /// A late frame from an older (or different) turn.
        case foreignTurn
        case foreignAssistant
        /// A replayed or duplicate frame at or below `lastAppliedSeq`.
        case staleSequence
        /// Turn content after `done`/`error`.
        case afterTerminal
    }

    public struct Block: Equatable, Sendable, Identifiable {
        public enum Kind: Equatable, Sendable {
            case answer
            case thinking
            case tool(toolCallId: String, section: Section, textOffset: Int)
            case image(path: String, caption: String?, mimeType: String, size: Int)
            case userInput(interactionId: String, requestId: Int)
        }

        public let id: String
        public let kind: Kind
        /// Raw streamed text of an answer/thinking block; empty otherwise.
        public internal(set) var text: String
        public internal(set) var isStreaming: Bool
    }

    public struct ToolCall: Equatable, Sendable, Identifiable {
        public let id: String
        public internal(set) var title = ""
        public internal(set) var status = ""
        public internal(set) var kind: String?
        public internal(set) var detail: String?
        /// Latest input snapshot; never an append-only delta.
        public internal(set) var inputJSON: String?
        public internal(set) var output: String?
        public internal(set) var textOffset = 0
        public internal(set) var startedAt: Double?
        public internal(set) var endedAt: Double?

        public var isActive: Bool { TurnProjection.isActiveToolStatus(status) }
    }

    public struct PermissionOption: Equatable, Sendable, Identifiable {
        public let optionId: String
        public let name: String
        public let kind: String
        public let disabled: Bool
        public var id: String { optionId }
    }

    public struct PermissionRequest: Equatable, Sendable, Identifiable {
        public let requestId: Int
        public let toolCallId: String?
        public let title: String
        public let detail: String?
        public let options: [PermissionOption]
        public let source: String?
        public var id: Int { requestId }
    }

    public enum UserInputStatus: String, Equatable, Sendable { case pending, answered, skipped, interrupted }

    public struct UserInputRequest: Equatable, Sendable, Identifiable {
        public let interactionId: String
        public let requestId: Int
        /// Raw question records (`question`, `header`, `options`, `multiSelect`, `id`).
        public let questions: [JSONValue]
        public internal(set) var answers: [JSONValue]
        public internal(set) var status: UserInputStatus
        public var id: String { interactionId }
    }

    public struct Failure: Equatable, Sendable {
        public let message: String
        public let code: String?
        public let recoverable: Bool?
    }

    public let nodeId: String
    public private(set) var turnId: String?
    public private(set) var assistantId: String?
    /// Highest applied `seq`; a replay resumes from `lastAppliedSeq + 1`.
    public private(set) var lastAppliedSeq = -1
    public private(set) var status = Status.active
    public private(set) var userText: String?
    public private(set) var startedAt: Double?
    public private(set) var completedAt: Double?
    public private(set) var stopReason: String?
    public private(set) var failure: Failure?
    public private(set) var blocks: [Block] = []
    public private(set) var toolCalls: [ToolCall] = []
    /// Raw plan entries (`content`, `priority`, `status`).
    public private(set) var plan: [JSONValue] = []
    /// Unresolved permission requests in arrival order; cleared when the turn ends.
    public private(set) var permissions: [PermissionRequest] = []
    public private(set) var userInputs: [UserInputRequest] = []
    public private(set) var title: String?
    public private(set) var followUps: [String] = []
    public private(set) var branchOverview: String?
    public private(set) var usageSummary: JSONValue?
    public private(set) var warnings: [JSONValue] = []

    /// Pass the client-generated `turnId` of a foreground send so frames from
    /// any other turn are rejected; otherwise the first stamped frame sets it.
    public init(nodeId: String, turnId: String? = nil, assistantId: String? = nil) {
        self.nodeId = nodeId
        self.turnId = turnId
        self.assistantId = assistantId
    }

    public var isTerminal: Bool { status != .active }
    public var answerText: String { blocks.filter { $0.kind == .answer }.map(\.text).joined() }
    public var thoughtText: String { blocks.filter { $0.kind == .thinking }.map(\.text).joined() }
    public var pendingUserInputs: [UserInputRequest] { userInputs.filter { $0.status == .pending } }

    public static func isActiveToolStatus(_ status: String) -> Bool {
        status.isEmpty || status == "running" || status == "pending" || status == "in_progress"
    }

    private static let projectedEvents: Set<String> = [
        "turn_start", "chunk", "thought", "plan", "tool_call", "tool_call_update",
        "permission_request", "permission_resolved", "user_input_request", "user_input_resolved",
        "image", "title", "follow_ups", "branch_overview", "usage_summary", "warning", "done", "error",
    ]
    /// Node metadata and resolutions may still arrive once the turn has ended.
    private static let postTerminalEvents: Set<String> = [
        "title", "follow_ups", "branch_overview", "usage_summary", "warning",
        "permission_resolved", "user_input_resolved",
    ]

    @discardableResult
    public mutating func apply(_ event: SSEEvent) -> Outcome {
        let data = event.data
        if let frameNode = data["nodeId"].optionalString, frameNode != nodeId { return .rejected(.foreignNode) }
        let frameTurn = data["turnId"].optionalString
        if let frameTurn, let turnId, frameTurn != turnId { return .rejected(.foreignTurn) }
        let frameAssistant = data["assistantId"].optionalString
        if let frameAssistant, let assistantId, frameAssistant != assistantId { return .rejected(.foreignAssistant) }
        let seq = Self.integer(data["seq"])
        if let seq, seq <= lastAppliedSeq { return .rejected(.staleSequence) }
        let projected = Self.projectedEvents.contains(event.event)
        if isTerminal, projected, !Self.postTerminalEvents.contains(event.event) { return .rejected(.afterTerminal) }

        if turnId == nil { turnId = frameTurn }
        if assistantId == nil { assistantId = frameAssistant }
        if let seq { lastAppliedSeq = seq }
        guard projected else { return .ignored }

        let observedAt = Self.number(data["observedAt"])
        switch event.event {
        case "turn_start":
            userText = data["userText"].optionalString ?? userText
            startedAt = Self.number(data["startedAt"]) ?? startedAt
        case "chunk":
            appendText(.answer, data["text"].stringValue)
        case "thought":
            appendText(.thinking, data["text"].stringValue)
        case "plan":
            plan = data["entries"].arrayValue
        case "tool_call", "tool_call_update":
            applyTool(data, observedAt: observedAt)
        case "permission_request":
            let request = PermissionRequest(
                requestId: data["requestId"].intValue,
                toolCallId: data["toolCallId"].optionalString,
                title: data["title"].stringValue,
                detail: data["detail"].optionalString,
                options: data["options"].arrayValue.map {
                    PermissionOption(optionId: $0["optionId"].stringValue, name: $0["name"].stringValue,
                                     kind: $0["kind"].stringValue, disabled: $0["disabled"].boolValue)
                },
                source: data["source"].optionalString)
            if let index = permissions.firstIndex(where: { $0.requestId == request.requestId }) {
                permissions[index] = request
            } else {
                permissions.append(request)
            }
        case "permission_resolved":
            let requestId = data["requestId"].intValue
            permissions.removeAll { $0.requestId == requestId }
        case "user_input_request":
            let requestId = data["requestId"].intValue
            let interactionId = data["interactionId"].optionalString ?? fallbackInteractionId(requestId)
            guard !userInputs.contains(where: { $0.interactionId == interactionId }) else { break }
            closeTrailingText()
            blocks.append(Block(id: nextBlockID(), kind: .userInput(interactionId: interactionId, requestId: requestId),
                                text: "", isStreaming: false))
            userInputs.append(UserInputRequest(interactionId: interactionId, requestId: requestId,
                                               questions: data["questions"].arrayValue, answers: [], status: .pending))
        case "user_input_resolved":
            let requestId = data["requestId"].intValue
            let interactionId = data["interactionId"].optionalString ?? fallbackInteractionId(requestId)
            let answers = data["answers"].arrayValue
            guard let index = userInputs.firstIndex(where: { $0.interactionId == interactionId }) else { break }
            // A duplicate empty confirmation must not erase a submitted answer.
            if userInputs[index].status == .answered, answers.isEmpty { break }
            let outcome = UserInputStatus(rawValue: data["outcome"].stringValue)
                .flatMap { $0 == .answered || $0 == .skipped ? $0 : nil }
            userInputs[index].answers = answers
            userInputs[index].status = outcome ?? (answers.isEmpty ? .skipped : .answered)
        case "image":
            closeTrailingText()
            blocks.append(Block(id: nextBlockID(),
                                kind: .image(path: data["path"].stringValue, caption: data["caption"].optionalString,
                                             mimeType: data["mimeType"].stringValue, size: data["size"].intValue),
                                text: "", isStreaming: false))
        case "title":
            if let value = Self.trimmed(data["title"]) { title = value }
        case "follow_ups":
            followUps = Array(data["followUps"].arrayValue.compactMap { Self.trimmed($0) }.prefix(3))
        case "branch_overview":
            if let value = Self.trimmed(data["overview"]) { branchOverview = value }
        case "usage_summary":
            usageSummary = data
        case "warning":
            warnings.append(data)
        case "done":
            let reason = data["stopReason"].optionalString
            status = reason == "cancel" || reason == "cancelled" ? .cancelled : reason == "error" ? .error : .completed
            stopReason = reason
            completedAt = Self.number(data["completedAt"])
            finalize(interrupted: status != .completed, at: completedAt ?? observedAt)
        case "error":
            status = .error
            failure = Failure(message: data["message"].stringValue, code: data["code"].optionalString,
                              recoverable: Self.bool(data["recoverable"]))
            completedAt = Self.number(data["completedAt"])
            finalize(interrupted: true, at: completedAt ?? observedAt)
        default:
            return .ignored
        }
        return .applied
    }

    // MARK: - Accumulation

    private func nextBlockID() -> String { "\(assistantId ?? turnId ?? nodeId)-b-\(blocks.count)" }

    private func fallbackInteractionId(_ requestId: Int) -> String { "\(turnId ?? ""):input:\(requestId)" }

    private mutating func appendText(_ section: Section, _ text: String) {
        let kind: Block.Kind = section == .answer ? .answer : .thinking
        if let last = blocks.indices.last, blocks[last].kind == kind {
            blocks[last].text += text
            blocks[last].isStreaming = true
        } else {
            closeTrailingText()
            blocks.append(Block(id: nextBlockID(), kind: kind, text: text, isStreaming: true))
        }
    }

    private mutating func closeTrailingText() {
        guard let last = blocks.indices.last else { return }
        if blocks[last].kind == .answer || blocks[last].kind == .thinking { blocks[last].isStreaming = false }
    }

    /// Tools do not start a section: consecutive tools inherit the section of
    /// the preceding text or tool block.
    private func currentSection() -> Section {
        for block in blocks.reversed() {
            switch block.kind {
            case .answer: return .answer
            case .thinking: return .thinking
            case .tool(_, let section, _): return section
            case .userInput: return .answer
            case .image: continue
            }
        }
        return .answer
    }

    private func runLength(_ section: Section) -> Int {
        var total = 0
        for block in blocks.reversed() {
            switch (block.kind, section) {
            case (.thinking, .answer), (.answer, .thinking): return total
            case (.answer, .answer), (.thinking, .thinking): total += block.text.utf16.count
            default: continue
            }
        }
        return total
    }

    private mutating func applyTool(_ data: JSONValue, observedAt: Double?) {
        let id = data["toolCallId"].stringValue
        let existing = toolCalls.firstIndex { $0.id == id }
        var tool = existing.map { toolCalls[$0] } ?? ToolCall(id: id, startedAt: observedAt)
        if let value = Self.nonEmpty(data["title"]) { tool.title = value }
        if let value = Self.nonEmpty(data["status"]) { tool.status = value }
        if let value = Self.nonEmpty(data["kind"]) { tool.kind = value }
        if let value = Self.nonEmpty(data["detail"]) { tool.detail = value }
        if let value = Self.nonEmpty(data["inputJson"]) { tool.inputJSON = value }
        if let value = Self.nonEmpty(data["output"]) {
            tool.output = value
            // Output means the tool finished, even without a terminal status.
            if tool.isActive { tool.status = "completed" }
        }
        if tool.endedAt == nil, let observedAt, !tool.isActive { tool.endedAt = observedAt }
        if let existing {
            toolCalls[existing] = tool
            return
        }
        let section = currentSection()
        tool.textOffset = runLength(section)
        toolCalls.append(tool)
        closeTrailingText()
        blocks.append(Block(id: nextBlockID(), kind: .tool(toolCallId: id, section: section, textOffset: tool.textOffset),
                            text: "", isStreaming: false))
    }

    /// Tools still active when a turn is cut off are `interrupted`, not completed:
    /// they may never have run.
    private mutating func finalize(interrupted: Bool, at time: Double?) {
        for index in blocks.indices where blocks[index].kind == .answer || blocks[index].kind == .thinking {
            blocks[index].isStreaming = false
        }
        for index in toolCalls.indices where toolCalls[index].isActive {
            toolCalls[index].status = interrupted ? "interrupted" : "completed"
            if toolCalls[index].endedAt == nil { toolCalls[index].endedAt = time }
        }
        for index in userInputs.indices where userInputs[index].status == .pending {
            userInputs[index].status = .interrupted
        }
        permissions.removeAll()
    }

    // MARK: - Field readers

    private static func integer(_ value: JSONValue) -> Int? {
        guard case .number(let number) = value, number.isFinite, number == number.rounded(),
              abs(number) < 9_007_199_254_740_992 else { return nil }
        return Int(number)
    }

    private static func number(_ value: JSONValue) -> Double? {
        if case .number(let number) = value, number.isFinite { return number }
        return nil
    }

    private static func bool(_ value: JSONValue) -> Bool? {
        if case .bool(let flag) = value { return flag }
        return nil
    }

    private static func nonEmpty(_ value: JSONValue) -> String? {
        guard let string = value.optionalString, !string.isEmpty else { return nil }
        return string
    }

    private static func trimmed(_ value: JSONValue) -> String? {
        let string = value.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return string.isEmpty ? nil : string
    }
}
