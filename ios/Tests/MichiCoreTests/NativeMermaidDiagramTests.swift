import XCTest
@testable import MichiCore

final class NativeMermaidDiagramTests: XCTestCase {
    func testSequenceParticipantsAliasesActorsAndMessageOrder() throws {
        let source = "sequenceDiagram\nactor U as 用户\nparticipant API as Server\nU->>API: Hello\nAPI-->>U: Welcome\nAPI->>API: Save"
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.participants.map(\.id), ["U", "API"])
        XCTAssertEqual(graph.participants.map(\.label), ["用户", "Server"])
        XCTAssertTrue(graph.participants[0].actor)
        XCTAssertEqual(graph.events, [
            .message(from: "U", to: "API", arrow: .arrow, text: "Hello", number: nil),
            .message(from: "API", to: "U", arrow: .dashedArrow, text: "Welcome", number: nil),
            .message(from: "API", to: "API", arrow: .arrow, text: "Save", number: nil)
        ])
        XCTAssertTrue(graph.accessibilityDescription.contains("用户 to Server"))
    }
    func testSequenceEightArrowTypesKeepDistinctSemantics() throws {
        let arrows = ["->", "-->", "->>", "-->>", "-x", "--x", "-)", "--)"]
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\n" + arrows.map { "A\($0)B: event" }.joined(separator: "\n")))
        let parsed = graph.events.compactMap { event -> MarkdownSequenceDiagram.Arrow? in
            if case .message(_, _, let arrow, _, _) = event { return arrow }; return nil
        }
        XCTAssertEqual(parsed.map(\.rawValue), arrows)
        XCTAssertEqual(parsed.map(\.dashed), [false, true, false, true, false, true, false, true])
        XCTAssertEqual(parsed.map(\.ending), ["line", "line", "arrow", "arrow", "cross", "cross", "open", "open"])
    }
    func testNotesBreaksAutonumberAndImplicitParticipants() throws {
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\nautonumber\nA->>B: One<br/>Two\nNote over A,B: Shared note\nNote left of A: Before\nNote right of B: After\nB-->>A: Reply"))
        XCTAssertEqual(graph.participants.map(\.id), ["A", "B"])
        XCTAssertEqual(graph.events[0], .message(from: "A", to: "B", arrow: .arrow, text: "One\nTwo", number: 1))
        XCTAssertEqual(graph.events[1], .note(placement: .over, participants: ["A", "B"], text: "Shared note"))
        XCTAssertEqual(graph.events[4], .message(from: "B", to: "A", arrow: .dashedArrow, text: "Reply", number: 2))
    }
    func testActivationShortcutsDeactivateSenderAndNestedSpans() throws {
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\nA->>+B: call\nactivate B\nB->>B: work\ndeactivate B\nB-->>-A: reply"))
        XCTAssertEqual(graph.activations.count, 2)
        XCTAssertEqual(graph.activations.map(\.participant), ["B", "B"])
        XCTAssertEqual(graph.activations.map(\.depth), [1, 0])
        XCTAssertEqual(graph.activations.map(\.start), [1, 0])
        XCTAssertEqual(graph.activations.map(\.end), [3, 4])
    }
    func testSequenceUnsupportedOrAmbiguousConstructsRejectWholeDiagram() {
        let statements = ["par Parallel", "alt yes", "end", "box Team", "create participant A", "A<<->>B: both", "A->>B: <b>bold</b>", "participant A@{type: actor}", "deactivate A", "activate A", "Note left of A,B: bad", "Note over A,A: duplicate", "autonumber 10", "accTitle: title", "%%{init: {}}%%"]
        for statement in statements {
            XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nA->>B: first\n" + statement), statement)
        }
    }
    func testSequenceResourceBoundsAndExactCRLFSource() throws {
        let source = "sequenceDiagram\r\n%% comment\r\nA->>B: original"
        XCTAssertEqual(try XCTUnwrap(MarkdownSequenceDiagram.parse(source)).source, source)
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\n" + (1...9).map { "participant P\($0)" }.joined(separator: "\n")))
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\n" + String(repeating: "A->>B: event\n", count: 49)))
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nA->>B: " + String(repeating: "x", count: 181)))
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\n" + String(repeating: "%% comment\n", count: 160)))
        XCTAssertNil(MarkdownSequenceDiagram.parse(String(repeating: "x", count: 12_001)))
    }
    func testStateInitialFinalAliasDescriptionAndTransitions() throws {
        let source = "stateDiagram-v2\n[*] --> Idle\nstate \"Working state\" as Busy\nIdle: Ready\nIdle --> Busy: begin\nBusy --> [*]: done"
        let graph = try XCTUnwrap(MarkdownStateDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.states.map(\.id), ["@start", "Idle", "Busy", "@end"])
        XCTAssertEqual(graph.states.map(\.label), ["Start", "Ready", "Working state", "End"])
        XCTAssertEqual(graph.states.map(\.kind), [.initial, .state, .state, .final])
        XCTAssertEqual(graph.transitions.map(\.label), ["", "begin", "done"])
        XCTAssertTrue(graph.accessibilityDescription.contains("Working state transitions to End: done"))
    }
    func testStateCyclesSelfLoopsAndDirectionDoNotBecomeDAGFallback() throws {
        let graph = try XCTUnwrap(MarkdownStateDiagram.parse("stateDiagram-v2\ndirection LR\nA --> B: next\nB --> A: retry\nB --> B: wait"))
        XCTAssertTrue(graph.horizontal)
        XCTAssertEqual(graph.states.map(\.id), ["A", "B"])
        XCTAssertEqual(graph.transitions.map(\.to), ["B", "A", "B"])
        XCTAssertFalse(try XCTUnwrap(MarkdownStateDiagram.parse("stateDiagram-v2\ndirection TB\nA")).horizontal)
    }
    func testStatePlainComparisonLabelsAndLineBreaks() throws {
        let graph = try XCTUnwrap(MarkdownStateDiagram.parse("stateDiagram-v2\nA: First<br/>Second\nA --> B: x > 0 & y < 2"))
        XCTAssertEqual(graph.states[0].label, "First\nSecond")
        XCTAssertEqual(graph.transitions[0].label, "x > 0 & y < 2")
    }
    func testStateUnsupportedSyntaxNeverProducesMisleadingPartialGraph() {
        for statement in ["state Composite {", "state decision <<choice>>", "--", "classDef color fill:red", "note right of A: Note", "A --> B:::styled", "direction RL", "accTitle: title", "[*] --> [*]", "A --> B %% inline comment", "A --> B; B --> C", "A --> B: <script>x</script>"] {
            XCTAssertNil(MarkdownStateDiagram.parse("stateDiagram-v2\n" + statement), statement)
        }
    }
    func testStateBoundsIncludeInitialAndFinalNodes() {
        let states = (1...18).map { "S\($0)" }.joined(separator: "\n")
        XCTAssertNotNil(MarkdownStateDiagram.parse("stateDiagram-v2\n" + states))
        XCTAssertNil(MarkdownStateDiagram.parse("stateDiagram-v2\n" + states + "\n[*] --> S1"))
        XCTAssertNil(MarkdownStateDiagram.parse("stateDiagram-v2\n" + String(repeating: "A --> B\n", count: 33)))
    }
    func testCompositeStatesScopePseudoStatesOrderAndDescribe() throws {
        let source = "stateDiagram-v2\n[*] --> Idle\nIdle --> Active: start\nstate \"Active work\" as Active {\n  [*] --> Loading\n  Loading --> Ready: loaded\n  state Ready {\n    [*] --> Viewing\n    Viewing --> [*]\n  }\n  Ready --> [*]\n}\nActive --> Done\nDone --> [*]"
        let graph = try XCTUnwrap(MarkdownStateDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.states.map(\.id), ["@start", "Idle", "Active", "Active@start", "Loading", "Ready", "Ready@start", "Viewing", "Ready@end", "Active@end", "Done", "@end"])
        XCTAssertEqual(graph.states.map(\.kind), [.initial, .state, .composite, .initial, .state, .composite, .initial, .state, .final, .final, .state, .final])
        XCTAssertEqual(graph.states.map(\.depth), [0, 0, 0, 1, 1, 1, 2, 2, 2, 1, 0, 0])
        XCTAssertEqual(graph.states.map(\.parent), [nil, nil, nil, "Active", "Active", "Active", "Ready", "Ready", "Ready", "Active", nil, nil])
        XCTAssertEqual(graph.states[2].label, "Active work")
        XCTAssertEqual([0, 1, 2, 5, 7, 99].map(graph.subtreeEnd), [0, 1, 9, 8, 7, 99])
        XCTAssertEqual(graph.transitions.map { "\($0.from)>\($0.to)" }, ["@start>Idle", "Idle>Active", "Active@start>Loading", "Loading>Ready", "Ready@start>Viewing", "Viewing>Ready@end", "Ready>Active@end", "Active>Done", "Done>@end"])
        let spoken = graph.accessibilityDescription
        for phrase in ["Active work, composite state containing Start of Active work, Loading, Ready, End of Active work.",
                       "Ready, composite state containing Start of Ready, Viewing, End of Ready.",
                       "Start transitions to Idle.", "Idle transitions to Active work: start.", "Viewing transitions to End of Ready.",
                       "Ready transitions to End of Active work.", "Done transitions to End."] {
            XCTAssertTrue(spoken.contains(phrase), phrase)
        }
        guard case .stateDiagram(let parsed)? = MarkdownDocument("```mermaid\n\(source)\n```").blocks.first else { return XCTFail("Expected native composite state") }
        XCTAssertEqual(parsed, graph)
        // A composite may be declared before its block, then used by name at its own level.
        let early = try XCTUnwrap(MarkdownStateDiagram.parse("stateDiagram-v2\ndirection LR\nA --> Group\nstate Group{\nInner\n}\nGroup --> A"))
        XCTAssertTrue(early.horizontal)
        XCTAssertEqual(early.states.map(\.id), ["A", "Group", "Inner"])
        XCTAssertEqual(early.states.map(\.kind), [.state, .composite, .state])
    }

    func testCompositeStateAmbiguityAndMalformedBlocksKeepExactSource() {
        let bodies = [
            "state A {\n}", "state A {\nB", "A\n}", "state A {\nB\n}\n}", "state A {\nB\n}}", "state A { B }", "state A {B}",
            "state A {\nB\n}\nB --> C", "state A {\nB\n}\nstate C {\nB --> D\n}", "state A {\nA --> B\n}", "B\nstate A {\nB --> C\n}",
            "state A {\nB\n}\nstate A {\nC\n}", "state A {\ndirection LR\nB\n}", "state A {\nB --> C\n--\nD\n}",
            "state A {\nstate B <<choice>>\n}", "state A {\nstate B <<fork>>\nB --> C\n}", "state A {\nnote right of B: x\n}",
            "state \"<b>A</b>\" as A {\nB\n}", "state end {\nB\n}", "state A {\n[*] --> [*]\n}", "state A {\nB --> C:::hot\n}",
            "state a {\nstate b {\nstate c {\nstate d {\nX\n}\n}\n}\n}"
        ]
        for body in bodies {
            let source = "stateDiagram-v2\n" + body
            XCTAssertNil(MarkdownStateDiagram.parse(source), body)
            XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)], body)
        }
        // Braces stay outside the sequence subset even though state blocks now use them.
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nA->>B: {x}"))
    }

    func testCompositeNestingAndCountLimitsAcceptBoundaryRejectNext() throws {
        let three = try XCTUnwrap(MarkdownStateDiagram.parse("stateDiagram-v2\nstate a {\nstate b {\nstate c {\nX\n}\n}\n}"))
        XCTAssertEqual(three.states.map(\.id), ["a", "b", "c", "X"])
        XCTAssertEqual(three.states.map(\.depth), [0, 1, 2, 3])
        XCTAssertEqual(three.subtreeEnd(0), 3)
        let six = (0..<6).map { "state C\($0) {\nS\($0)\n}" }.joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownStateDiagram.parse("stateDiagram-v2\n" + six)).states.filter { $0.kind == .composite }.count, 6)
        XCTAssertNil(MarkdownStateDiagram.parse("stateDiagram-v2\n" + six + "\nstate C6 {\nS6\n}"))
        // Scoped start/end states count against the shared eighteen-entry bound.
        func crowded(_ count: Int) -> String { "stateDiagram-v2\n" + (1...count).map { "S\($0)" }.joined(separator: "\n") + "\nstate Box {\n[*] --> In\nIn --> [*]\n}" }
        XCTAssertEqual(try XCTUnwrap(MarkdownStateDiagram.parse(crowded(14))).states.count, 18)
        XCTAssertNil(MarkdownStateDiagram.parse(crowded(15)))
        let crlf = "stateDiagram-v2\r\nstate Box {\r\n[*] --> In\r\n}"
        XCTAssertEqual(try XCTUnwrap(MarkdownStateDiagram.parse(crlf)).source, crlf)
    }

    func testMarkdownIntegrationPreservesFlowchartAndCompleteFallbackSource() {
        let sequence = "sequenceDiagram\nA->>B: hello"
        let state = "stateDiagram-v2\n[*] --> A"
        guard case .sequenceDiagram? = MarkdownDocument("```mermaid\n\(sequence)\n```").blocks.first else { return XCTFail("Expected native sequence") }
        guard case .stateDiagram? = MarkdownDocument("```mermaid\n\(state)\n```").blocks.first else { return XCTFail("Expected native state") }
        guard case .flowchart? = MarkdownDocument("```mermaid\nflowchart LR\nA --> B\n```").blocks.first else { return XCTFail("Existing flowchart changed") }
        let unsupported = "sequenceDiagram\nA->>B: hello\nrect rgb(200, 220, 255)\nB-->>A: yes\nend"
        XCTAssertEqual(MarkdownDocument("```mermaid\n\(unsupported)\n```").blocks, [.code(language: "mermaid", text: unsupported)])
        XCTAssertEqual(MarkdownDocument("```text\n\(sequence)\n```").blocks, [.code(language: "text", text: sequence)])
    }
}
