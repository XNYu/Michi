import XCTest
@testable import MichiCore

final class NativeSequenceFragmentTests: XCTestCase {
    func testNestedAltLoopKeepsMessageNumbersActivationIndicesAndScope() throws {
        let source = """
        sequenceDiagram
        autonumber
        A->>+B: request
        loop Retry
          alt Cached
            B-->>A: cached
          else Fresh
            B->>C: fetch
            C-->>B: data
          end
        end
        B-->>-A: done
        """
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.participants.map(\.id), ["A", "B", "C"])
        XCTAssertEqual(graph.events.compactMap { if case .message(_, _, _, _, let number) = $0 { return number }; return nil }, [1, 2, 3, 4, 5])
        XCTAssertEqual(graph.activations, [.init(participant: "B", start: 0, end: 4, depth: 0)])
        XCTAssertEqual(graph.fragments.map(\.kind), [.loop, .alt])
        XCTAssertEqual(graph.fragments.map(\.depth), [0, 1])
        XCTAssertEqual(graph.fragments.map(\.startRow), [1, 2])
        XCTAssertEqual(graph.fragments.map(\.endRow), [8, 7])
        XCTAssertEqual(graph.fragments.map(\.participants), [["A", "B", "C"], ["A", "B", "C"]])
        XCTAssertEqual(graph.fragments[0].branches.map(\.events), [1..<4])
        XCTAssertEqual(graph.fragments[1].branches.map(\.events), [1..<2, 2..<4])
        XCTAssertEqual(graph.rows, [.event(0), .fragmentStart(0), .fragmentStart(1), .event(1), .fragmentElse(fragment: 1, branch: 1), .event(2), .event(3), .fragmentEnd(1), .fragmentEnd(0), .event(4)])
        let spoken = graph.accessibilityDescription
        XCTAssertTrue(spoken.contains("Begin loop: Retry. Begin alternative: Cached."))
        XCTAssertTrue(spoken.contains("Else: Fresh."))
        XCTAssertTrue(spoken.contains("End alt. End loop. 5."))
    }

    func testThreeLevelsAndMultipleAlternativesAreStructuredInSourceOrder() throws {
        let source = "sequenceDiagram\nalt Primary\nopt Allowed\nloop Until ready\nA->>B: work\nend\nend\nelse Secondary\nB->>A: wait\nelse\nNote over A,B: no operation\nend"
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse(source))
        XCTAssertEqual(graph.fragments.map(\.depth), [0, 1, 2])
        XCTAssertEqual(graph.fragments[0].branches.map(\.label), ["Primary", "Secondary", ""])
        XCTAssertEqual(graph.fragments[0].branches.map(\.events), [0..<1, 1..<2, 2..<3])
        XCTAssertEqual(graph.fragments[1].branches[0].events, 0..<1)
        XCTAssertEqual(graph.fragments[2].branches[0].events, 0..<1)
        XCTAssertEqual(graph.fragments[0].branches.map(\.headerRow), [0, 6, 8])
    }

    func testParticipantDeclarationsInsideFramesRemainGlobalAndUnusedActorsStayOutsideScope() throws {
        let source = "sequenceDiagram\nparticipant Unused\nopt condition\nactor A as User\nA->>B: hello\nend\nparticipant B as Service\nB-->>A: reply"
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse(source))
        XCTAssertEqual(graph.participants.map(\.id), ["Unused", "A", "B"])
        XCTAssertEqual(graph.participants.map(\.label), ["Unused", "User", "Service"])
        XCTAssertTrue(graph.participants[1].actor)
        XCTAssertEqual(graph.fragments[0].participants, ["A", "B"])
        XCTAssertEqual(graph.fragments[0].branches[0].events, 0..<1)
        XCTAssertTrue(graph.accessibilityDescription.contains("Service to User"))
        XCTAssertEqual(graph.rows.last, .event(1))
    }

    func testEmptyFramesAndEmptyConditionsHaveVisibleBoundaryRows() throws {
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\nparticipant A\nalt\nelse\nend\nopt\nend\nloop\nend"))
        XCTAssertTrue(graph.events.isEmpty)
        XCTAssertEqual(graph.fragments.map(\.kind), [.alt, .opt, .loop])
        XCTAssertEqual(graph.fragments[0].branches.map(\.events), [0..<0, 0..<0])
        XCTAssertEqual(graph.rows.count, 7)
        XCTAssertTrue(graph.accessibilityDescription.contains("Begin alternative. Else. End alt."))
    }

    func testFrameConditionLabelsAllowPlainComparisonsAndBoundedLineBreaks() throws {
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\nALT x > 0 & y < 2<br/>仍可继续\nA->>B: end is literal in message text\nELSE fallback\nB-->>A: alt / loop / else\nEND"))
        XCTAssertEqual(graph.fragments[0].branches.map(\.label), ["x > 0 & y < 2\n仍可继续", "fallback"])
        XCTAssertEqual(graph.events.map(\.text), ["end is literal in message text", "alt / loop / else"])
    }

    func testMalformedBlocksRejectWholeDiagram() {
        let bad = [
            "end", "else condition", "loop L\nA->>B: work", "alt A\nA->>B: yes\nelse no",
            "opt optional\nA->>B: work\nelse invalid\nend", "loop L\nelse invalid\nend",
            "alt A\nopt B\nelse belongs to wrong block\nend\nend",
            "alt A\nA->>B: work\nend trailing text", "alt A\nend\nend",
            "loop L\nopt O\nalt A\nloop fourth\nA->>B: work\nend\nend\nend\nend"
        ]
        for fragment in bad {
            XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nparticipant A\n" + fragment), fragment)
        }
    }

    func testUnsupportedFragmentsAndUnsafeConditionSyntaxKeepExactFallback() {
        for fragment in ["rect rgb(0, 0, 0)\nA->>B: x\nend", "rect rgba(0, 0, 255, 0.1)\nA->>B: x\nend", "box Team\nparticipant A\nend", "box Aqua Group\nparticipant A\nend"] {
            let source = "sequenceDiagram\nopt Outer\n" + fragment + "\nend"
            XCTAssertNil(MarkdownSequenceDiagram.parse(source))
            XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)])
        }
        for label in ["<b>condition</b>", "<script>x</script>", "# comment", "wrap: condition", ":nowrap: condition", "a; b", "x %% comment", "`quoted`", "x\u{0000}", String(repeating: "x", count: 181), "a<br/>b<br/>c<br/>d<br/>e"] {
            XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nalt \(label)\nA->>B: work\nend"), label)
        }
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nloop L\n%%{init: {}}%%\nA->>B: work\nend"))
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nparticipant alt\nalt->>A: ambiguous keyword"))
    }

    func testParallelCriticalAndBreakFramesKeepBranchesRowsAndScope() throws {
        let source = "sequenceDiagram\npar Fetch profile\nA->>B: profile\nand Fetch orders\nA->>C: orders\nand\nA->>D: audit\nend\ncritical Commit\nB->>C: write\noption Timeout\nB-->>A: retry\nend\nbreak Invalid input\nA-xB: reject\nend"
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.participants.map(\.id), ["A", "B", "C", "D"])
        XCTAssertEqual(graph.fragments.map(\.kind), [.par, .critical, .breakFrame])
        XCTAssertEqual(graph.fragments.map(\.kind.rawValue), ["par", "critical", "break"])
        XCTAssertEqual(graph.fragments.map(\.kind.separator), ["and", "option", nil])
        XCTAssertEqual(graph.fragments[0].branches.map(\.label), ["Fetch profile", "Fetch orders", ""])
        XCTAssertEqual(graph.fragments[0].branches.map(\.events), [0..<1, 1..<2, 2..<3])
        XCTAssertEqual(graph.fragments[0].branches.map(\.headerRow), [0, 2, 4])
        XCTAssertEqual(graph.fragments[1].branches.map(\.label), ["Commit", "Timeout"])
        XCTAssertEqual(graph.fragments[1].branches.map(\.events), [3..<4, 4..<5])
        XCTAssertEqual(graph.fragments[2].branches.map(\.events), [5..<6])
        XCTAssertEqual(graph.fragments.map(\.startRow), [0, 7, 12])
        XCTAssertEqual(graph.fragments.map(\.endRow), [6, 11, 14])
        XCTAssertEqual(graph.fragments.map(\.participants), [["A", "B", "C", "D"], ["A", "B", "C"], ["A", "B"]])
        XCTAssertEqual(graph.rows, [.fragmentStart(0), .event(0), .fragmentElse(fragment: 0, branch: 1), .event(1), .fragmentElse(fragment: 0, branch: 2), .event(2), .fragmentEnd(0),
                                    .fragmentStart(1), .event(3), .fragmentElse(fragment: 1, branch: 1), .event(4), .fragmentEnd(1),
                                    .fragmentStart(2), .event(5), .fragmentEnd(2)])
        let spoken = graph.accessibilityDescription
        for phrase in ["Begin parallel: Fetch profile.", "In parallel: Fetch orders.", "In parallel. A to D", "End par.",
                       "Begin critical region: Commit.", "Option: Timeout.", "End critical.",
                       "Begin break: Invalid input. A to B, cross: reject. End break."] {
            XCTAssertTrue(spoken.contains(phrase), phrase)
        }
        guard case .sequenceDiagram(let parsed)? = MarkdownDocument("```mermaid\n\(source)\n```").blocks.first else { return XCTFail("Expected native frames") }
        XCTAssertEqual(parsed, graph)
    }

    func testNewFrameKeywordsAreCaseInsensitiveNestAndNeverClaimIdentifiers() throws {
        let nested = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\nBREAK outer\nCritical middle\nPar inner\nA->>B: one\nAND other\nB->>A: two\nEnd\nOPTION fallback\nA->>B: three\nend\nEND"))
        XCTAssertEqual(nested.fragments.map(\.kind), [.breakFrame, .critical, .par])
        XCTAssertEqual(nested.fragments.map(\.depth), [0, 1, 2])
        XCTAssertEqual(nested.fragments[1].branches.map(\.label), ["middle", "fallback"])
        XCTAssertEqual(nested.fragments[2].branches.map(\.label), ["inner", "other"])
        // Words that only start with a keyword stay participants and message text.
        let words = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\nparticipant Partner\nparticipant Optional\nPartner->>Optional: and more\nOptional-->>Partner: break time\nBreaker->>Partner: option"))
        XCTAssertTrue(words.fragments.isEmpty)
        XCTAssertEqual(words.participants.map(\.id), ["Partner", "Optional", "Breaker"])
        XCTAssertEqual(words.events.map(\.text), ["and more", "break time", "option"])
        for source in ["participant par", "participant critical", "actor option", "participant and", "break->>A: x", "A->>critical: x"] {
            XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nparticipant A\n" + source), source)
        }
    }

    func testSeparatorsBelongOnlyToTheirOwnFrameKind() {
        let bad = [
            "alt a\nA->>B: x\nand b\nend", "alt a\nA->>B: x\noption b\nend", "par a\nA->>B: x\nelse b\nend",
            "par a\nA->>B: x\noption b\nend", "critical a\nA->>B: x\nelse b\nend", "critical a\nA->>B: x\nand b\nend",
            "break a\nA->>B: x\nelse b\nend", "opt a\nA->>B: x\noption b\nend", "loop a\nand b\nend",
            "and orphan", "option orphan", "par a\nalt b\nand wrong level\nend\nend",
            "par a\nA->>B: x", "critical a\nA->>B: x\noption b", "break a\nA->>B: x\nend extra",
            "par # comment\nA->>B: x\nend", "critical wrap: x\nA->>B: x\nend", "break <b>stop</b>\nA->>B: x\nend",
            "par a\nand <script>x</script>\nend"
        ]
        for fragment in bad {
            let source = "sequenceDiagram\nparticipant A\n" + fragment
            XCTAssertNil(MarkdownSequenceDiagram.parse(source), fragment)
            XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)], fragment)
        }
    }

    func testParallelAndCriticalBranchLimitsMatchAlternatives() throws {
        for (header, separator) in [("par", "and"), ("critical", "option")] {
            let prefix = "sequenceDiagram\nparticipant A\n\(header) first\n"
            let eight = try XCTUnwrap(MarkdownSequenceDiagram.parse(prefix + String(repeating: "\(separator) more\n", count: 7) + "end"))
            XCTAssertEqual(eight.fragments[0].branches.count, 8, header)
            XCTAssertNil(MarkdownSequenceDiagram.parse(prefix + String(repeating: "\(separator) more\n", count: 8) + "end"), header)
        }
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\npar a\ncritical b\nbreak c\nopt fourth\nA->>B: x\nend\nend\nend\nend"))
    }

    func testFrameAndBranchLimitsAcceptBoundaryRejectNext() throws {
        let frame = "opt bounded\nA->>B: message\nend\n"
        XCTAssertEqual(try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\n" + String(repeating: frame, count: 12))).fragments.count, 12)
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\n" + String(repeating: frame, count: 13)))
        let prefix = "sequenceDiagram\nparticipant A\nalt first\n"
        let seven = prefix + String(repeating: "else more\n", count: 7) + "end"
        XCTAssertEqual(try XCTUnwrap(MarkdownSequenceDiagram.parse(seven)).fragments[0].branches.count, 8)
        XCTAssertNil(MarkdownSequenceDiagram.parse(prefix + String(repeating: "else more\n", count: 8) + "end"))
    }

    func testEventAndRowLimitsCountFrameClosuresSeparately() throws {
        let messages = String(repeating: "A->>B: message\n", count: 48)
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\nloop bounded\n" + messages + "end"))
        XCTAssertEqual(graph.events.count, 48)
        XCTAssertEqual(graph.rows.count, 50)
        XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\nloop bounded\n" + messages + "A->>B: extra\nend"))
        let eightRows = "alt a\nA->>B: one\nelse b\nA->>B: two\nelse c\nA->>B: three\nB-->>A: four\nend\n"
        let full = "sequenceDiagram\n" + String(repeating: eightRows, count: 12)
        XCTAssertEqual(try XCTUnwrap(MarkdownSequenceDiagram.parse(full)).rows.count, 96)
        // Same 48 messages and twelve frames, but exactly one extra branch row.
        var tooManyRows = full
        let firstHeader = try XCTUnwrap(tooManyRows.range(of: "alt a\n"))
        tooManyRows.replaceSubrange(firstHeader, with: "alt a\nelse extra\n")
        XCTAssertNil(MarkdownSequenceDiagram.parse(tooManyRows))
    }

    func testInvalidActivationAndAutonumberDoNotBecomeValidBecauseOfFrames() {
        for source in ["opt x\ndeactivate A\nend", "alt x\nA->>+B: start\nelse y\nB-->>A: no close\nend", "loop x\nautonumber\nA->>B: work\nend", "autonumber\nopt x\nA->>B: work\nend\nautonumber"] {
            XCTAssertNil(MarkdownSequenceDiagram.parse("sequenceDiagram\n" + source), source)
        }
        let balanced = MarkdownSequenceDiagram.parse("sequenceDiagram\nactivate A\nopt x\nA->>B: work\nend\ndeactivate A")
        XCTAssertEqual(balanced?.activations.first?.start, 0)
        XCTAssertEqual(balanced?.activations.first?.end, 2)
    }

    func testSharedRowGeometryContainsNestedFramesAndPreservesBandsAtLargeTextSize() throws {
        let graph = try XCTUnwrap(MarkdownSequenceDiagram.parse("sequenceDiagram\nloop retry\nalt cached\nA->>B: use\nelse miss\nopt refresh\nB->>A: reply\nend\nend\nend"))
        for scale in [1.0, 3.0] {
            let heights = graph.rows.map { row -> Double in
                switch row { case .event: return 80 * scale; case .fragmentEnd: return 16 * scale; default: return 48 * scale }
            }
            let offsets = try XCTUnwrap(graph.rowOffsets(heights: heights))
            XCTAssertEqual(offsets.count, graph.rows.count + 1)
            XCTAssertEqual(offsets.last, heights.reduce(0, +))
            XCTAssertTrue(zip(offsets, offsets.dropFirst()).allSatisfy { $0 < $1 })
            let outer = graph.fragments[0], inner = graph.fragments[1], optional = graph.fragments[2]
            XCTAssertLessThan(offsets[outer.startRow], offsets[inner.startRow])
            XCTAssertGreaterThan(offsets[outer.endRow], offsets[inner.endRow])
            XCTAssertLessThan(offsets[inner.branches[1].headerRow], offsets[optional.startRow])
            XCTAssertGreaterThan(offsets[inner.endRow], offsets[optional.endRow])
            for (row, value) in graph.rows.enumerated() {
                if case .event = value { XCTAssertGreaterThanOrEqual(offsets[row], offsets[inner.startRow] + heights[inner.startRow]) }
            }
        }
        XCTAssertNil(graph.rowOffsets(heights: []))
        for invalid in [0.0, -1.0, Double.infinity, Double.nan, 8_193.0] {
            XCTAssertNil(graph.rowOffsets(heights: Array(repeating: invalid, count: graph.rows.count)))
        }
        XCTAssertNil(graph.rowOffsets(heights: Array(repeating: 1_000, count: graph.rows.count)))
    }

    func testNativeMarkdownDispatchAndCRLFSourcePreservation() throws {
        let source = "sequenceDiagram\r\n%% comment\r\nopt Optional\r\nA->>B: hello\r\nend"
        XCTAssertEqual(try XCTUnwrap(MarkdownSequenceDiagram.parse(source)).source, source)
        let lf = source.replacingOccurrences(of: "\r\n", with: "\n")
        guard case .sequenceDiagram(let graph)? = MarkdownDocument("```mermaid\n\(lf)\n```").blocks.first else { return XCTFail("Expected native fragment rendering") }
        XCTAssertEqual(graph.fragments.first?.kind, .opt)
        XCTAssertEqual(graph.source, lf)
    }
}
