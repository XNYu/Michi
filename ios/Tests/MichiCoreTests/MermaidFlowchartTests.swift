import XCTest
import CoreGraphics
@testable import MichiCore

final class MermaidFlowchartTests: XCTestCase {
    // These syntax/shape/stroke expectations were also checked with the installed
    // Mermaid 11.12.2 parser, without rendering or executing diagram callbacks.
    func testStadiumAndCompletePreviewGraphRenderWithoutPartialFallback() throws {
        let source = "flowchart TB\nA([Start]) --> B{Ready?}\nB -- Yes --> C[(Saved data)]\nB -. Retry .-> B\nC ==> D((Done))\nD -->|Revise| B"
        let graph = try XCTUnwrap(MarkdownFlowchart.parse(source))
        XCTAssertEqual(graph.nodes.map(\.shape), [.stadium, .decision, .cylinder, .circle])
        XCTAssertEqual(graph.edges.count, 5)
        XCTAssertEqual(graph.source, source)
        if case .flowchart(let parsed) = MarkdownDocument.mermaidBlock(source) { XCTAssertEqual(parsed, graph) }
        else { XCTFail("Supported page source must render natively") }
        XCTAssertNil(MarkdownFlowchart.parse("flowchart TB\nA([unfinished) --> B"))
    }

    func testReverseGraphWithCycleShapesAndPipeLabels() throws {
        let source = "flowchart RL\nA((Circle)) -.->|retry| B(((Double)))\nB ==>|write| C[(Store)]\nC --> A"
        let graph = try XCTUnwrap(MarkdownFlowchart.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.direction, .rightToLeft)
        XCTAssertTrue(graph.horizontal)
        XCTAssertEqual(graph.nodes.map(\.shape), [.circle, .doubleCircle, .cylinder])
        XCTAssertEqual(graph.nodes.map(\.label), ["Circle", "Double", "Store"])
        XCTAssertEqual(graph.nodes.map(\.rank), [0, 1, 2])
        XCTAssertEqual(graph.edges.map(\.stroke), [.dotted, .thick, .solid])
        XCTAssertEqual(graph.edges.map(\.label), ["retry", "write", ""])
        XCTAssertTrue(graph.edges.allSatisfy(\.arrow))
    }

    func testInlineEdgeLabelsAndQuotedPunctuation() throws {
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("graph BT\nA -- yes --> B\nB -. maybe .-> C\nC == done ==> A"))
        XCTAssertEqual(graph.direction, .bottomToTop)
        XCTAssertFalse(graph.horizontal)
        XCTAssertEqual(graph.edges.map(\.label), ["yes", "maybe", "done"])
        XCTAssertEqual(graph.edges.map(\.stroke), [.solid, .dotted, .thick])
        let quoted = try XCTUnwrap(MarkdownFlowchart.parse("flowchart TB\nA -- \"yes (ready)\" --> B\nB -->|\"say | yes\"| A"))
        XCTAssertEqual(quoted.edges.map(\.label), ["yes (ready)", "say | yes"])
    }

    func testUnarrowedEdgesKeepTheirStrokeAndConnectivity() throws {
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("flowchart TD\nA ---|plain| B\nB -.- C\nC === A"))
        XCTAssertEqual(graph.direction, .topToBottom)
        XCTAssertEqual(graph.edges.map(\.stroke), [.solid, .dotted, .thick])
        XCTAssertTrue(graph.edges.allSatisfy { !$0.arrow })
        XCTAssertTrue(graph.accessibilityDescription.contains("A connects to B, plain, solid line"))
    }

    func testSelfLoopsAreRetainedWithReadableDescription() throws {
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("flowchart LR\nA[\"a; b\"] -->|again| A"))
        XCTAssertEqual(graph.nodes.count, 1)
        XCTAssertEqual(graph.nodes[0].label, "a; b")
        XCTAssertEqual(graph.edges.count, 1)
        XCTAssertEqual(graph.edges[0].from, graph.edges[0].to)
        XCTAssertTrue(graph.accessibilityDescription.contains("a; b leads to itself, again, solid line"))
    }

    func testSCCRanksPreserveAcyclicEntryAndExit() throws {
        let source = "flowchart TB\nEntry --> B\nB --> C\nC --> B\nC --> Exit\nDetached --> Solo"
        let graph = try XCTUnwrap(MarkdownFlowchart.parse(source))
        XCTAssertEqual(graph.nodes.map(\.rank), [0, 1, 2, 3, 0, 1])
        for _ in 0..<10 { XCTAssertEqual(MarkdownFlowchart.parse(source), graph) }
    }

    func testDAGBranchRanksAndLaterDeclarationsStayCompatible() throws {
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("graph LR; A --> B --> C; B --> D; D((Last label)); C[Done]"))
        XCTAssertEqual(graph.nodes.map(\.id), ["A", "B", "C", "D"])
        XCTAssertEqual(graph.nodes.map(\.rank), [0, 1, 2, 2])
        XCTAssertEqual(graph.nodes.last?.label, "Last label")
        XCTAssertEqual(graph.nodes.last?.shape, .circle)
    }

    func testCommentsAndCRLFPreserveOriginalSource() throws {
        let source = "%% ordinary comment; ignored\r\nflowchart BT; A[\"中文 (label); text\"] --> B\r\n%% more commentary\r\nB --> A"
        let graph = try XCTUnwrap(MarkdownFlowchart.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.nodes[0].label, "中文 (label); text")
        XCTAssertEqual(graph.edges.count, 2)
    }

    func testUnsupportedSemanticsRejectWholeDiagram() {
        let tails = [
            "click A \"https://example.com\"", "classDef red fill:red", "class A red", "style A fill:red", "linkStyle 0 stroke:red",
            "subgraph X\nA --> B", "direction RL", "accTitle: Custom accessible title", "A@{ shape: rect }", "A:::red",
            "A --o B", "A ---oB", "A -.-xB", "A ===oB", "A <--> B", "A ----> B", "A ~~~ B", "A & B --> C",
            "A[[Subroutine]]", "A[<b>HTML</b>]", "A[\"`Markdown`\"]", "A[\"#quot;entity\"]", "A[\"a &amp; b\"]",
            "%%{init: {\"flowchart\": {\"curve\": \"linear\"}}}%%"
        ]
        for tail in tails { XCTAssertNil(MarkdownFlowchart.parse("flowchart TB\nA --> B\n" + tail), tail) }
        XCTAssertNil(MarkdownFlowchart.parse("---\ntitle: Config\n---\nflowchart TB\nA --> B"))
    }

    func testMalformedLabelsAndIncompleteLinksDoNotPartiallyRender() {
        for body in ["A[unterminated", "A((Wrong)]", "A[\"unclosed]", "A -->|unclosed B", "A -->", "A -. label", "A -- label ==> B", "A[one\ntwo]", "A -->|<b>html</b>| B"] {
            XCTAssertNil(MarkdownFlowchart.parse("flowchart TB\n" + body), body)
        }
    }

    func testNodeEdgeAndUTF8SourceLimitsAreExact() throws {
        let nodes24 = "flowchart TB\n" + (0..<24).map { "N\($0)" }.joined(separator: " --> ")
        XCTAssertEqual(try XCTUnwrap(MarkdownFlowchart.parse(nodes24)).nodes.count, 24)
        XCTAssertNil(MarkdownFlowchart.parse(nodes24 + " --> N24"))
        let edges32 = "flowchart TB\n" + Array(repeating: "A --> A", count: 32).joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownFlowchart.parse(edges32)).edges.count, 32)
        XCTAssertNil(MarkdownFlowchart.parse(edges32 + "\nA --> A"))
        let prefix = "flowchart TB\nA\n%% "
        let exact = prefix + String(repeating: "x", count: 12_000 - prefix.utf8.count)
        XCTAssertNotNil(MarkdownFlowchart.parse(exact))
        XCTAssertNil(MarkdownFlowchart.parse(exact + "x"))
        let unicode = prefix + String(repeating: "你", count: 4_000)
        XCTAssertLessThan(unicode.count, 12_000)
        XCTAssertNil(MarkdownFlowchart.parse(unicode))
    }

    func testLabelLimitsDoNotTruncateContent() throws {
        let node = String(repeating: "x", count: 200), edge = String(repeating: "y", count: 120)
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("graph LR\nA[\(node)] -->|\(edge)| B"))
        XCTAssertEqual(graph.nodes[0].label, node); XCTAssertEqual(graph.edges[0].label, edge)
        XCTAssertNil(MarkdownFlowchart.parse("graph LR\nA[\(node)x] --> B"))
        XCTAssertNil(MarkdownFlowchart.parse("graph LR\nA -->|\(edge)y| B"))
    }

    func testEveryDirectionHasArrowEnteringTargetBoundary() throws {
        for direction in ["TB", "TD", "BT", "LR", "RL"] {
            let graph = try XCTUnwrap(MarkdownFlowchart.parse("flowchart \(direction)\nA --> B\nB --> A\nA --> A"))
            let layout = MarkdownFlowchartLayout(graph: graph)
            for route in layout.routes {
                let edge = graph.edges[route.edgeIndex]
                let target = try XCTUnwrap(layout.nodes.first { $0.id == edge.to })
                let tip = try XCTUnwrap(route.points.last), prior = route.points[route.points.count - 2]
                switch graph.direction {
                case .leftToRight: XCTAssertEqual(tip.x, target.rect.minX); XCTAssertEqual(tip.y, target.rect.midY); XCTAssertGreaterThan(tip.x, prior.x)
                case .rightToLeft: XCTAssertEqual(tip.x, target.rect.maxX); XCTAssertEqual(tip.y, target.rect.midY); XCTAssertLessThan(tip.x, prior.x)
                case .topToBottom: XCTAssertEqual(tip.y, target.rect.minY); XCTAssertEqual(tip.x, target.rect.midX); XCTAssertGreaterThan(tip.y, prior.y)
                case .bottomToTop: XCTAssertEqual(tip.y, target.rect.maxY); XCTAssertEqual(tip.x, target.rect.midX); XCTAssertLessThan(tip.y, prior.y)
                }
            }
            try assertBounds(layout)
        }
    }

    func testReturnSelfAndDuplicateEdgesGetDistinctOuterChannels() throws {
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("graph LR\nA --> B\nB -->|back| A\nA -->|self| A\nA -->|parallel| B"))
        let layout = MarkdownFlowchartLayout(graph: graph)
        XCTAssertEqual(layout.routes.map(\.kind), [.direct, .returning, .selfLoop, .returning])
        XCTAssertEqual(Set(layout.routes.dropFirst().map { $0.labelRect.midY }).count, 3)
        for route in layout.routes.dropFirst() {
            XCTAssertGreaterThan(route.labelRect.minY, layout.nodes.map { $0.rect.maxY }.max() ?? 0)
            XCTAssertNotEqual(route.points.first, route.points.last)
        }
        XCTAssertEqual(layout, MarkdownFlowchartLayout(graph: graph))
        try assertBounds(layout)
    }

    func testDirectLabelsDoNotOverlapEachOtherOrNodes() throws {
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("flowchart TB\nA -->|first branch| B\nA -->|second branch| C\nD -->|joins| C"))
        let layout = MarkdownFlowchartLayout(graph: graph)
        for i in layout.routes.indices {
            let label = layout.routes[i].labelRect
            for other in layout.routes.dropFirst(i + 1) { XCTAssertFalse(label.intersects(other.labelRect)) }
            for node in layout.nodes { XCTAssertFalse(label.intersects(node.rect)) }
        }
        try assertBounds(layout)
    }

    func testReturnStemsAvoidOtherNodesInSameRank() throws {
        for direction in ["TB", "BT", "LR", "RL"] {
            let graph = try XCTUnwrap(MarkdownFlowchart.parse("graph \(direction)\nA --> B\nD --> E\nB --> A\nE --> E"))
            let layout = MarkdownFlowchartLayout(graph: graph)
            for route in layout.routes where route.kind != .direct {
                for (start, end) in zip(route.points, route.points.dropFirst()) {
                    // Axis-aligned route segments must not cross any card interior.
                    let segment = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: max(0.01, abs(end.x - start.x)), height: max(0.01, abs(end.y - start.y)))
                    for node in layout.nodes { XCTAssertFalse(segment.intersects(node.rect.insetBy(dx: 1, dy: 1)), "\(direction): \(route)") }
                }
            }
            try assertBounds(layout)
        }
    }

    func testMeasuredSizesAndLargeTextRemainFiniteAndInsideCanvas() throws {
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("graph RL\nA((Circle)) -->|yes| B{Decision}\nB -->|retry| A\nA -->|loop| A"))
        let sizes: [String: CGSize] = ["A": CGSize(width: 300, height: 450), "B": CGSize(width: 600, height: 420)]
        let layout = MarkdownFlowchartLayout(graph: graph, nodeSizes: sizes, labelSizes: Array(repeating: CGSize(width: 456, height: 240), count: 3), scale: 3)
        XCTAssertEqual(layout.nodes[0].rect.width, 450)
        XCTAssertEqual(layout.nodes[0].rect.height, 450)
        try assertBounds(layout)
        let invalid = MarkdownFlowchartLayout(graph: graph, nodeSizes: ["A": CGSize(width: CGFloat.nan, height: -1)], scale: .infinity)
        try assertBounds(invalid)
    }

    func testSubgraphMembershipTitlesAndAccessibility() throws {
        let source = "flowchart LR\nsubgraph api [Service layer]\nA[Gateway] --> B\nend\nC --> A\nsubgraph Storage\nD[(Data)]\nend\nB --> D"
        let graph = try XCTUnwrap(MarkdownFlowchart.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.groups.map(\.id), ["api", "Storage"])
        XCTAssertEqual(graph.groups.map(\.title), ["Service layer", "Storage"])
        XCTAssertEqual(graph.groups.map(\.parent), [nil, nil])
        XCTAssertEqual(graph.nodes.map(\.id), ["A", "B", "C", "D"])
        XCTAssertEqual(graph.nodes.map(\.group), [0, 0, nil, 1])
        XCTAssertEqual(graph.nodes.map(\.rank), [1, 2, 0, 3])
        XCTAssertEqual(graph.edges.map { "\($0.from)>\($0.to)" }, ["A>B", "C>A", "B>D"])
        let spoken = graph.accessibilityDescription
        XCTAssertTrue(spoken.contains("Group Service layer contains Gateway, B."), spoken)
        XCTAssertTrue(spoken.contains("Group Storage contains Data."), spoken)
        XCTAssertTrue(spoken.contains("Gateway leads to B, solid line."), spoken)
        guard case .flowchart(let parsed) = MarkdownDocument.mermaidBlock(source) else { return XCTFail("Grouped flowchart must render natively") }
        XCTAssertEqual(parsed, graph)
        XCTAssertTrue(try XCTUnwrap(MarkdownFlowchart.parse("graph LR\nA --> B")).groups.isEmpty)
    }

    func testMembershipFollowsMermaidFirstClosedSubgraph() throws {
        // Modelled on Mermaid 11 flowDb (not re-run against an installed parser): Inner closes
        // first and keeps B although Outer listed it earlier; the earlier sibling keeps C.
        let source = "graph TB\nsubgraph Outer\nA --> B\nsubgraph Inner\nB\nend\nend\nsubgraph First\nC\nend\nsubgraph Second\nC --> D\nend"
        let graph = try XCTUnwrap(MarkdownFlowchart.parse(source))
        XCTAssertEqual(graph.groups.map(\.id), ["Outer", "Inner", "First", "Second"])
        XCTAssertEqual(graph.groups.map(\.parent), [nil, 0, nil, nil])
        XCTAssertEqual(graph.groups.map(\.depth), [0, 1, 0, 0])
        XCTAssertEqual(graph.nodes.map(\.id), ["A", "B", "C", "D"])
        XCTAssertEqual(graph.nodes.map(\.group), [0, 1, 2, 3])
        XCTAssertEqual(graph.edges.count, 2)
        XCTAssertTrue(graph.accessibilityDescription.contains("Group Outer contains A, group Inner."))
        XCTAssertTrue(graph.accessibilityDescription.contains("Group Inner, inside Outer, contains B."))
        for _ in 0..<5 { XCTAssertEqual(MarkdownFlowchart.parse(source), graph) }
    }

    func testSubgraphHeaderFormsGeneratedIDsAndMatchingDirection() throws {
        let graph = try XCTUnwrap(MarkdownFlowchart.parse("flowchart TB\nsubgraph one\nA\nend\nsubgraph two [\"Two (quoted)\"]\nB\nend\nsubgraph \"Third group\"\nC\nend\nsubgraph Fourth group\ndirection TB\nD\nend\nsubgraph five[Plain five]\nE\nend"))
        XCTAssertEqual(graph.groups.map(\.id), ["one", "two", "[group 2]", "[group 3]", "five"])
        XCTAssertEqual(graph.groups.map(\.title), ["one", "Two (quoted)", "Third group", "Fourth group", "Plain five"])
        XCTAssertEqual(graph.nodes.map(\.group), [0, 1, 2, 3, 4])
        XCTAssertNotNil(MarkdownFlowchart.parse("flowchart TD\nsubgraph S\ndirection TD\nA --> B\nend"))
        XCTAssertNotNil(MarkdownFlowchart.parse("graph LR; subgraph S; A --> B; end; B --> C"))
    }

    func testSubgraphAmbiguityAndMalformedBlocksRejectWholeDiagram() {
        let bodies = [
            "subgraph S\nA --> B", "A --> B\nend", "subgraph S\nend", "subgraph S\nA\nend\nsubgraph T\nA\nend",
            "subgraph S\nA\nend\nB --> S", "S --> A\nsubgraph S\nB\nend", "subgraph \"API\"\nA\nend\nAPI --> A",
            "subgraph S\nA\nend\nsubgraph S\nB\nend", "subgraph S\ndirection LR\nA\nend", "subgraph S\ndirection\nA\nend",
            "subgraph\nA\nend", "subgraph S [<b>bold</b>]\nA\nend", "subgraph S [a & b]\nA\nend", "subgraph S [unclosed\nA\nend",
            "subgraph S []\nA\nend", "subgraph end\nA\nend", "subgraph S [x] y\nA\nend", "subgraph `md`\nA\nend",
            "subgraph a\nsubgraph b\nsubgraph c\nsubgraph d\nA\nend\nend\nend\nend",
            "subgraph S\nA\nend\nstyle S fill:red", "subgraph S\nA:::red\nend", "subgraph S\nclassDef x fill:red\nA\nend"
        ]
        for body in bodies {
            let source = "flowchart TB\n" + body
            XCTAssertNil(MarkdownFlowchart.parse(source), body)
            XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)], body)
        }
        // Node ids that merely start with a keyword stay ordinary nodes.
        XCTAssertEqual(try XCTUnwrap(MarkdownFlowchart.parse("flowchart TB\nsubgraphs --> directions")).nodes.map(\.id), ["subgraphs", "directions"])
    }

    func testGroupCountAndNestingLimitsAcceptBoundaryRejectNext() throws {
        let eight = "flowchart TB\n" + (0..<8).map { "subgraph G\($0)\nN\($0)\nend" }.joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownFlowchart.parse(eight)).groups.count, 8)
        XCTAssertNil(MarkdownFlowchart.parse(eight + "\nsubgraph G8\nN8\nend"))
        let three = try XCTUnwrap(MarkdownFlowchart.parse("flowchart TB\nsubgraph a\nsubgraph b\nsubgraph c\nA\nend\nend\nend"))
        XCTAssertEqual(three.groups.map(\.depth), [0, 1, 2])
        XCTAssertEqual(three.groups.map(\.parent), [nil, 0, 1])
        XCTAssertEqual(three.nodes.map(\.group), [2])
    }

    func testGroupFramesContainOnlyMembersAndTitlesStayClearOfRoutes() throws {
        for direction in ["TB", "BT", "LR", "RL"] {
            let source = "flowchart \(direction)\nStart --> A\nsubgraph Outer [Outer group]\nA -->|go| B\nsubgraph Inner [Inner group]\nB --> C\nend\nend\nC --> Done\nDone --> A\nX --> Done\nsubgraph Side\nX\nend"
            let graph = try XCTUnwrap(MarkdownFlowchart.parse(source))
            XCTAssertEqual(graph.nodes.map(\.group), [nil, 0, 1, 1, nil, 2])
            let measured = MarkdownFlowchartLayout(graph: graph, groupTitleSizes: Array(repeating: CGSize(width: 420, height: 260), count: 3), scale: 3)
            for layout in [MarkdownFlowchartLayout(graph: graph), measured] {
                XCTAssertEqual(layout.groups.map(\.id), ["Outer", "Inner", "Side"])
                for (index, frame) in layout.groups.enumerated() {
                    let members = Set(graph.nodes.filter { node in
                        var group = node.group
                        while let current = group { if current == index { return true }; group = graph.groups[current].parent }
                        return false
                    }.map(\.id))
                    for node in layout.nodes {
                        if members.contains(node.id) { XCTAssertTrue(frame.rect.contains(node.rect), "\(direction) \(frame.id) \(node.id)") }
                        else { XCTAssertFalse(frame.rect.intersects(node.rect), "\(direction) \(frame.id) \(node.id)") }
                        XCTAssertFalse(frame.titleRect.intersects(node.rect), "\(direction) title \(frame.id) \(node.id)")
                    }
                    XCTAssertTrue(frame.rect.contains(frame.titleRect), "\(direction) \(frame.id)")
                    for route in layout.routes {
                        if !graph.edges[route.edgeIndex].label.isEmpty { XCTAssertFalse(frame.titleRect.intersects(route.labelRect), "\(direction) label") }
                        for (start, end) in zip(route.points, route.points.dropFirst()) {
                            let segment = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: max(0.01, abs(end.x - start.x)), height: max(0.01, abs(end.y - start.y)))
                            XCTAssertFalse(segment.intersects(frame.titleRect.insetBy(dx: 1, dy: 1)), "\(direction) route \(route.edgeIndex) crosses \(frame.id) title")
                        }
                    }
                }
                XCTAssertTrue(layout.groups[0].rect.contains(layout.groups[1].rect))
                XCTAssertNotEqual(layout.groups[0].rect, layout.groups[1].rect)
                XCTAssertFalse(layout.groups[0].rect.intersects(layout.groups[2].rect))
                try assertBounds(layout)
            }
            XCTAssertEqual(MarkdownFlowchartLayout(graph: graph), MarkdownFlowchartLayout(graph: graph))
        }
    }

    private func assertBounds(_ layout: MarkdownFlowchartLayout, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertTrue(layout.size.width.isFinite && layout.size.height.isFinite, file: file, line: line)
        func point(_ p: CGPoint) {
            XCTAssertGreaterThanOrEqual(p.x, 0, file: file, line: line); XCTAssertGreaterThanOrEqual(p.y, 0, file: file, line: line)
            XCTAssertLessThanOrEqual(p.x, layout.size.width, file: file, line: line); XCTAssertLessThanOrEqual(p.y, layout.size.height, file: file, line: line)
        }
        for rect in layout.nodes.map(\.rect) + layout.routes.map(\.labelRect) + layout.groups.flatMap({ [$0.rect, $0.titleRect] }) {
            point(CGPoint(x: rect.minX, y: rect.minY)); point(CGPoint(x: rect.maxX, y: rect.maxY))
        }
        for route in layout.routes { for p in route.points { point(p) } }
    }
}
