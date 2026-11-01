import XCTest
@testable import MichiCore

final class TurnProjectionTests: XCTestCase {
    private var nextSeq = 0

    /// A ChatHub-stamped frame for node n1 / turn t1 / assistant a1.
    private func frame(_ event: String, _ fields: [String: JSONValue] = [:], node: String = "n1", turn: String = "t1",
                       assistant: String = "a1", seq: Int? = nil) -> SSEEvent {
        var data = fields
        data["nodeId"] = .string(node)
        data["turnId"] = .string(turn)
        data["assistantId"] = .string(assistant)
        let value = seq ?? nextSeq
        nextSeq = max(nextSeq, value + 1)
        data["seq"] = .number(Double(value))
        return SSEEvent(event: event, data: .object(data))
    }

    private func projection(_ events: [SSEEvent], turnId: String? = nil) -> TurnProjection {
        var projection = TurnProjection(nodeId: "n1", turnId: turnId)
        for event in events { projection.apply(event) }
        return projection
    }

    func testAccumulatesAnswerAndThoughtBlocks() {
        var p = TurnProjection(nodeId: "n1")
        XCTAssertEqual(p.apply(frame("turn_start", ["userText": "hello", "startedAt": 100])), .applied)
        for event in [frame("chunk", ["text": "Hel"]), frame("chunk", ["text": "lo"]),
                      frame("thought", ["text": "think"]), frame("chunk", ["text": " world"])] {
            XCTAssertEqual(p.apply(event), .applied)
        }

        XCTAssertEqual(p.turnId, "t1")
        XCTAssertEqual(p.assistantId, "a1")
        XCTAssertEqual(p.userText, "hello")
        XCTAssertEqual(p.startedAt, 100)
        XCTAssertEqual(p.lastAppliedSeq, 4)
        XCTAssertEqual(p.blocks.map(\.id), ["a1-b-0", "a1-b-1", "a1-b-2"])
        XCTAssertEqual(p.blocks.map(\.kind), [.answer, .thinking, .answer])
        XCTAssertEqual(p.blocks.map(\.isStreaming), [false, false, true])
        XCTAssertEqual(p.answerText, "Hello world")
        XCTAssertEqual(p.thoughtText, "think")
        XCTAssertEqual(p.status, .active)
    }

    func testToolCallsMergeAndInheritTheirSection() {
        let p = projection([
            frame("thought", ["text": "plan"]),
            frame("tool_call", ["toolCallId": "tc1", "title": "Read", "status": "pending", "kind": "read", "observedAt": 100]),
            frame("tool_call", ["toolCallId": "tc2", "title": "Grep", "status": "running"]),
            frame("tool_call_update", ["toolCallId": "tc1", "output": "file text", "observedAt": 150]),
            frame("chunk", ["text": "é😀"]),
            frame("tool_call", ["toolCallId": "tc3", "title": "Edit", "status": "in_progress", "inputJson": "{\"a\":1}"]),
        ])

        XCTAssertEqual(p.toolCalls.map(\.id), ["tc1", "tc2", "tc3"])
        let read = p.toolCalls[0]
        XCTAssertEqual(read.title, "Read")
        XCTAssertEqual(read.kind, "read")
        XCTAssertEqual(read.output, "file text")
        XCTAssertEqual(read.status, "completed")
        XCTAssertEqual(read.startedAt, 100)
        XCTAssertEqual(read.endedAt, 150)
        XCTAssertFalse(read.isActive)
        XCTAssertEqual(p.toolCalls[2].inputJSON, "{\"a\":1}")
        XCTAssertTrue(p.toolCalls[2].isActive)

        XCTAssertEqual(p.blocks.map(\.kind), [
            .thinking,
            .tool(toolCallId: "tc1", section: .thinking, textOffset: 4),
            .tool(toolCallId: "tc2", section: .thinking, textOffset: 4),
            .answer,
            .tool(toolCallId: "tc3", section: .answer, textOffset: 3), // UTF-16 units
        ])
        XCTAssertEqual(p.blocks[0].isStreaming, false)
        XCTAssertEqual(p.blocks[3].isStreaming, false)
    }

    func testNodeTurnAssistantAndSequenceIdentityAreEnforced() {
        var p = TurnProjection(nodeId: "n1")
        XCTAssertEqual(p.apply(frame("chunk", ["text": "x"], seq: 0)), .applied)
        XCTAssertEqual(p.apply(frame("chunk", ["text": "other node"], node: "n2", seq: 1)), .rejected(.foreignNode))
        XCTAssertEqual(p.apply(frame("chunk", ["text": "late older turn"], turn: "t0", seq: 5)), .rejected(.foreignTurn))
        XCTAssertEqual(p.apply(frame("chunk", ["text": "other assistant"], assistant: "a9", seq: 6)), .rejected(.foreignAssistant))
        XCTAssertEqual(p.apply(frame("chunk", ["text": "replayed"], seq: 0)), .rejected(.staleSequence))
        XCTAssertEqual(p.lastAppliedSeq, 0)
        XCTAssertEqual(p.answerText, "x")

        // An unstamped legacy frame still applies but cannot move the watermark.
        XCTAssertEqual(p.apply(SSEEvent(event: "chunk", data: ["text": "y"])), .applied)
        XCTAssertEqual(p.answerText, "xy")
        XCTAssertEqual(p.lastAppliedSeq, 0)

        // A foreground send knows its turn before the first frame.
        var foreground = TurnProjection(nodeId: "n1", turnId: "t2")
        XCTAssertEqual(foreground.apply(frame("chunk", ["text": "stale"], seq: 9)), .rejected(.foreignTurn))
        XCTAssertNil(foreground.assistantId)
        XCTAssertEqual(foreground.lastAppliedSeq, -1)
    }

    func testUnknownEventsAreIgnoredButAdvanceTheWatermark() {
        var p = TurnProjection(nodeId: "n1")
        XCTAssertEqual(p.apply(frame("future_event", ["anything": ["nested": true]], seq: 3)), .ignored)
        XCTAssertEqual(p.apply(frame("heartbeat", ["idleMs": 10_000], seq: 4)), .ignored)
        XCTAssertEqual(p.lastAppliedSeq, 4)
        XCTAssertEqual(p.apply(frame("chunk", ["text": "late"], seq: 2)), .rejected(.staleSequence))
        XCTAssertTrue(p.blocks.isEmpty)
    }

    func testPermissionRequestsResolveAndClearWhenTheTurnEnds() {
        var p = TurnProjection(nodeId: "n1")
        p.apply(frame("permission_request", [
            "requestId": 7, "toolCallId": "tc1", "title": "Run command", "detail": "ls", "source": "kiro",
            "options": [["optionId": "allow", "name": "Allow", "kind": "allow_once"],
                        ["optionId": "deny", "name": "Deny", "kind": "reject_once", "disabled": true]],
        ]))
        p.apply(frame("permission_request", ["requestId": 8, "title": "Write file", "options": []]))
        XCTAssertEqual(p.permissions.map(\.requestId), [7, 8])
        let first = p.permissions[0]
        XCTAssertEqual(first.toolCallId, "tc1")
        XCTAssertEqual(first.detail, "ls")
        XCTAssertEqual(first.source, "kiro")
        XCTAssertEqual(first.options.map(\.optionId), ["allow", "deny"])
        XCTAssertEqual(first.options.map(\.disabled), [false, true])

        p.apply(frame("permission_resolved", ["requestId": 7]))
        XCTAssertEqual(p.permissions.map(\.requestId), [8])

        p.apply(frame("done", ["stopReason": "end_turn"]))
        XCTAssertTrue(p.permissions.isEmpty)
        XCTAssertEqual(p.status, .completed)
    }

    func testDoneFinalizesTextAndToolsAndRejectsLateContent() {
        var p = projection([
            frame("chunk", ["text": "answer"]),
            frame("tool_call", ["toolCallId": "tc1", "title": "Read", "status": "running"]),
            frame("done", ["stopReason": "end_turn", "completedAt": 500, "persisted": true]),
        ])
        XCTAssertEqual(p.status, .completed)
        XCTAssertTrue(p.isTerminal)
        XCTAssertEqual(p.stopReason, "end_turn")
        XCTAssertEqual(p.completedAt, 500)
        XCTAssertEqual(p.toolCalls.first?.status, "completed")
        XCTAssertEqual(p.toolCalls.first?.endedAt, 500)
        XCTAssertTrue(p.blocks.allSatisfy { !$0.isStreaming })

        XCTAssertEqual(p.apply(frame("chunk", ["text": "late"])), .rejected(.afterTerminal))
        XCTAssertEqual(p.apply(frame("done", [:])), .rejected(.afterTerminal))
        XCTAssertEqual(p.apply(frame("title", ["title": "  Named later  "])), .applied)
        XCTAssertEqual(p.title, "Named later")
        XCTAssertEqual(p.answerText, "answer")
    }

    func testCancelledTurnInterruptsActiveTools() {
        let p = projection([
            frame("tool_call", ["toolCallId": "tc1", "status": "running", "observedAt": 10]),
            frame("tool_call", ["toolCallId": "tc2", "status": "failed", "observedAt": 20]),
            frame("done", ["stopReason": "cancelled", "observedAt": 30]),
        ])
        XCTAssertEqual(p.status, .cancelled)
        XCTAssertEqual(p.toolCalls.map(\.status), ["interrupted", "failed"])
        XCTAssertEqual(p.toolCalls.map(\.endedAt), [30, 20])
    }

    func testErrorEndsTheTurnWithItsMachineCode() {
        var p = projection([
            frame("chunk", ["text": "partial"]),
            frame("tool_call", ["toolCallId": "tc1", "status": "pending"]),
            frame("user_input_request", ["requestId": 1, "interactionId": "i1", "questions": [["question": "Pick?"]]]),
            frame("error", ["message": "boom", "code": "turn_failed", "recoverable": false]),
        ])
        XCTAssertEqual(p.status, .error)
        XCTAssertEqual(p.failure, TurnProjection.Failure(message: "boom", code: "turn_failed", recoverable: false))
        XCTAssertEqual(p.toolCalls.first?.status, "interrupted")
        XCTAssertEqual(p.userInputs.first?.status, .interrupted)
        XCTAssertTrue(p.pendingUserInputs.isEmpty)
        XCTAssertEqual(p.apply(frame("error", ["message": "again"])), .rejected(.afterTerminal))
        XCTAssertEqual(p.failure?.message, "boom")
    }

    func testUserInputRequestsAreAnsweredOnce() {
        var p = TurnProjection(nodeId: "n1")
        let request = frame("user_input_request", [
            "requestId": 1, "interactionId": "t1:input:1:0",
            "questions": [["question": "Pick?", "options": [["label": "A"]], "multiSelect": false]],
        ])
        p.apply(request)
        p.apply(frame("user_input_request", ["requestId": 1, "interactionId": "t1:input:1:0", "questions": []]))
        XCTAssertEqual(p.pendingUserInputs.map(\.interactionId), ["t1:input:1:0"])
        XCTAssertEqual(p.userInputs.first?.questions.first?["question"].stringValue, "Pick?")
        XCTAssertEqual(p.blocks.map(\.kind), [.userInput(interactionId: "t1:input:1:0", requestId: 1)])

        p.apply(frame("user_input_resolved", ["requestId": 1, "interactionId": "t1:input:1:0",
                                              "answers": [["question": "Pick?", "answer": "A"]]]))
        XCTAssertEqual(p.userInputs.first?.status, .answered)
        // A duplicate empty confirmation keeps the submitted answer.
        p.apply(frame("user_input_resolved", ["requestId": 1, "interactionId": "t1:input:1:0", "answers": []]))
        XCTAssertEqual(p.userInputs.first?.status, .answered)
        XCTAssertEqual(p.userInputs.first?.answers.first?["answer"].stringValue, "A")

        // Without an interactionId the turn-scoped fallback identity is used.
        p.apply(frame("user_input_request", ["requestId": 2, "questions": []]))
        p.apply(frame("user_input_resolved", ["requestId": 2, "answers": [], "outcome": "skipped"]))
        XCTAssertEqual(p.userInputs.last?.interactionId, "t1:input:2")
        XCTAssertEqual(p.userInputs.last?.status, .skipped)
    }

    func testNodeMetadataPlanImagesAndUsage() {
        let p = projection([
            frame("plan", ["entries": [["content": "Step", "priority": "high", "status": "pending"]]]),
            frame("chunk", ["text": "see"]),
            frame("image", ["path": "/tmp/a.png", "caption": "Chart", "mimeType": "image/png", "size": 12]),
            frame("title", ["title": "  Title  "]),
            frame("follow_ups", ["followUps": ["a", " b ", "", 4, "c", "d"]]),
            frame("branch_overview", ["overview": " Overview "]),
            frame("usage_summary", ["totalTokens": 42]),
            frame("warning", ["source": "kiro", "category": "provider", "message": "slow"]),
        ])
        XCTAssertEqual(p.plan.first?["content"].stringValue, "Step")
        XCTAssertEqual(p.blocks.map(\.kind), [.answer, .image(path: "/tmp/a.png", caption: "Chart", mimeType: "image/png", size: 12)])
        XCTAssertFalse(p.blocks[0].isStreaming)
        XCTAssertEqual(p.title, "Title")
        XCTAssertEqual(p.followUps, ["a", "b", "c"])
        XCTAssertEqual(p.branchOverview, "Overview")
        XCTAssertEqual(p.usageSummary?["totalTokens"].intValue, 42)
        XCTAssertEqual(p.warnings.map { $0["message"].stringValue }, ["slow"])
    }
}
