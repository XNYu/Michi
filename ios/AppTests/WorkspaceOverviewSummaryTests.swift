import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class WorkspaceOverviewSummaryTests: XCTestCase {
    private let node: JSONValue = ["id": "node-1", "workspace_id": "workspace-1", "kind": "chat", "title": "A title is not a summary"]
    private func message(_ role: String, _ content: String, seq: Int = 0) -> JSONValue {
        ["node_id": "node-1", "role": .string(role), "content": .string(content), "seq": .number(Double(seq))]
    }
    private func graph(_ messages: [JSONValue], node: JSONValue? = nil) -> WorkspaceGraph {
        WorkspaceGraph(raw: ["workspace": ["id": "workspace-1"], "nodes": .array([node ?? self.node]), "messages": .array(messages), "trees": [], "edges": []])
    }
    private func summary(_ messages: [JSONValue]) -> String { WorkspaceOverviewSummary.text(node: node, graph: graph(messages)) }

    func testLatestAnswerUsesFirstUsefulParagraphAndSkipsTitleAndHeading() {
        XCTAssertEqual(summary([
            message("assistant", "Old answer", seq: 1),
            message("assistant", "[TITLE: T]\n\n#### Result\n\nRotating tokens are the current favorite.\n\nMore detail.", seq: 2)
        ]), "Rotating tokens are the current favorite.")
    }

    func testStreamedAnswerBlocksJoinBeforeMetadataProjection() {
        let blocks: JSONValue = [
            ["id": "thought", "kind": "thinking", "rawText": "Private reasoning"],
            ["id": "tool", "kind": "tool", "toolCallId": "tool-1", "section": "thinking", "rawOffset": 0],
            ["id": "answer-1", "kind": "answer", "rawText": "[TIT", "streaming": true],
            ["id": "answer-2", "kind": "answer", "rawText": "LE: New title]\n# Result\nVisible answer.\n\nDetails.", "streaming": true]
        ]
        let answer = message("assistant", "This aggregate content must not replace structured blocks").merging([
            "blocks": .string(blocks.prettyPrinted), "thought": "Private thought field", "tool_calls": [["result": "Private tool log"]]
        ])
        XCTAssertEqual(summary([answer]), "Visible answer.")
    }

    func testLatestThoughtOnlyMessageFallsBackToUserNotOlderAnswer() {
        let latest = message("assistant", "Private aggregate", seq: 3).merging(["blocks": [
            ["id": "thought", "kind": "thinking", "rawText": "Hidden thought"],
            ["id": "tool", "kind": "tool", "toolCallId": "tool-1", "section": "answer", "rawOffset": 0]
        ]])
        XCTAssertEqual(summary([message("user", "/branch Compare storage models", seq: 1), message("assistant", "Outdated answer", seq: 2), latest]), "Compare storage models")
    }

    func testFirstUserPromptStripsBranchAndQuotedLines() {
        XCTAssertEqual(summary([message("user", "/BrAnCh Compare the storage models\n> Quoted source\nKeep the scope narrow."), message("user", "Later request", seq: 2)]),
                       "Compare the storage models\n\nKeep the scope narrow.")
        XCTAssertEqual(summary([message("user", "/BTW Explain the tradeoff")]), "Explain the tradeoff")
    }

    func testOnlyExactBranchCommandsAreRemoved() {
        XCTAssertEqual(summary([message("user", "/branches is a path")]), "/branches is a path")
        XCTAssertEqual(summary([message("user", "/branching is not the command")]), "/branching is not the command")
    }

    func testSavedJournalAlwaysWinsAndIsNotExcerptClipped() {
        let saved = String(repeating: "Saved journal. ", count: 100)
        let row = node.merging(["branch_overview": [["at": 1, "text": "Earlier"], ["at": 2, "text": .string(saved)]]])
        let value = WorkspaceOverviewSummary.text(node: row, graph: graph([message("assistant", "Fallback answer")], node: row))
        XCTAssertEqual(value, saved.trimmingCharacters(in: .whitespacesAndNewlines)); XCTAssertGreaterThan(value.utf16.count, 720)
        let legacy = node.merging(["branch_overview": " Legacy saved summary "])
        XCTAssertEqual(WorkspaceOverviewSummary.text(node: legacy, graph: graph([], node: legacy)), "Legacy saved summary")
    }

    func testEmptyJournalFallsBackWithoutChangingGraphOrNode() {
        let row = node.merging(["branch_overview": "[]"])
        let source = graph([message("assistant", "Useful fallback")], node: row), before = row
        let raw = source.raw
        XCTAssertEqual(WorkspaceOverviewSummary.text(node: row, graph: source), "Useful fallback")
        XCTAssertEqual(source.raw, raw); XCTAssertEqual(row, before)
        XCTAssertEqual(source.node(row.id)?["branch_overview"], "[]")
    }

    func testAbsentMessagesPreservesEmptyInsteadOfInventingTitleSummary() {
        var source = graph([])
        source.raw = source.raw.merging(["messages": .null])
        XCTAssertEqual(WorkspaceOverviewSummary.text(node: node, graph: source), "")
        XCTAssertEqual(summary([message("assistant", "\n \t\u{FEFF}"), message("user", " /branch ")]), "/branch")
        XCTAssertEqual(summary([message("user", "/branch \u{FEFF}\n\t")]), "")
    }

    func testCurrencyAndOrdinaryMarkdownRemainVisible() {
        XCTAssertEqual(summary([message("assistant", "Budget is $5, $10, and US$25. Keep [the price](https://example.com).\n\nLater paragraph.")]),
                       "Budget is $5, $10, and US$25. Keep [the price](https://example.com).")
    }

    func testWhitespaceAndHeadingOnlyParagraphsAreSkipped() {
        XCTAssertEqual(summary([message("assistant", "\u{FEFF}\n\t\n# Heading\n \t\n## Next heading\nBody starts here.\n\u{00A0}\nLater.")]), "Body starts here.")
        XCTAssertEqual(summary([message("assistant", "## Heading only"), message("user", "Opening question", seq: -1)]), "Opening question")
    }

    func testForeignMessageNodeAndForeignWorkspaceAreNotUsed() {
        let own = message("assistant", "Owned answer", seq: 1)
        let otherNode = message("assistant", "Other conversation", seq: 9).merging(["node_id": "other"])
        let otherWorkspace = message("assistant", "Other workspace", seq: 10).merging(["workspace_id": "foreign"])
        XCTAssertEqual(summary([own, otherNode, otherWorkspace]), "Owned answer")
        let foreign = node.merging(["workspace_id": "foreign", "branch_overview": "Must not show"])
        XCTAssertEqual(WorkspaceOverviewSummary.text(node: foreign, graph: graph([own])), "")
        XCTAssertEqual(WorkspaceOverviewSummary.text(node: node, graph: graph([own], node: foreign)), "")
        let missing = node.merging(["id": "missing"])
        XCTAssertEqual(WorkspaceOverviewSummary.text(node: missing, graph: graph([own])), "")
    }

    func testDeletedAndNonConversationNodesHaveNoSummary() {
        for patch: [String: JSONValue] in [["deleted_at": 1], ["kind": "digest"], ["kind": "artifact"]] {
            let row = node.merging(patch)
            XCTAssertEqual(WorkspaceOverviewSummary.text(node: row, graph: graph([message("assistant", "Do not show")], node: row)), "")
        }
    }

    func testToolDebugAndSystemMessagesAreNeverUsedAsAnswerOrPrompt() {
        XCTAssertEqual(summary([
            message("tool", "Private tool result"), message("debug", "Private debug trace"), message("system", "System policy"),
            message("assistant", "").merging(["thought": "Hidden reasoning", "tool_calls": [["result": "Tool debug"]]])
        ]), "")
    }

    func testOrderingUsesSequenceAndLegacyCreationTime() {
        XCTAssertEqual(summary([message("assistant", "Latest by seq", seq: 5), message("assistant", "Older by seq", seq: 2)]), "Latest by seq")
        let older: JSONValue = ["node_id": "node-1", "role": "assistant", "content": "Older legacy", "created_at": 10]
        let newer = older.merging(["content": "Newer legacy", "created_at": 20])
        XCTAssertEqual(summary([newer, older]), "Newer legacy")
        XCTAssertEqual(summary([message("assistant", "Equal sequence first"), message("assistant", "Equal sequence last")]), "Equal sequence last")
    }

    func testIncompleteTitleSentinelAndSteeringAreNotLeaked() {
        let steering = "[STEERING steer-1234567890abcdef1234567890abcdef: Internal report]"
        XCTAssertEqual(summary([message("assistant", steering + "\nVisible conclusion. [TITLE: New title]\n[BRANCH-OVERVIEW: Private metadata]\n[FOLLOW-UP 1: Next?]")]), "Visible conclusion.")
        XCTAssertEqual(summary([message("assistant", "Visible conclusion. [TIT")]), "Visible conclusion.")
    }

    func testAssistantAndUserLimitsMatchWebUTF16Budgets() {
        let answer = summary([message("assistant", String(repeating: "a", count: 800))])
        XCTAssertEqual(answer, String(repeating: "a", count: 720) + "…")
        let prompt = summary([message("user", "/branch " + String(repeating: "b", count: 500))])
        XCTAssertEqual(prompt, String(repeating: "b", count: 420) + "…")
        let unicode = summary([message("assistant", String(repeating: "a", count: 719) + "😀" + String(repeating: "z", count: 50))])
        XCTAssertEqual(unicode, String(repeating: "a", count: 719) + "…"); XCTAssertFalse(unicode.contains("�"))
    }

    func testLongExcerptPrefersLateSentenceOrLineBoundary() {
        let sentence = String(repeating: "a", count: 500) + ". " + String(repeating: "b", count: 300)
        XCTAssertEqual(summary([message("assistant", sentence)]), String(repeating: "a", count: 500) + ".…")
        let cjk = String(repeating: "字", count: 500) + "。" + String(repeating: "词", count: 300)
        XCTAssertEqual(summary([message("assistant", cjk)]), String(repeating: "字", count: 500) + "。…")
        let lines = String(repeating: "a", count: 500) + "\n" + String(repeating: "b", count: 300)
        XCTAssertEqual(summary([message("assistant", lines)]), String(repeating: "a", count: 500) + "…")
        let early = "Short. " + String(repeating: "b", count: 800)
        XCTAssertEqual(summary([message("assistant", early)]).utf16.count, 721)
    }
}
