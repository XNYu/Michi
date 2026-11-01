import Foundation
import XCTest
@testable import MichiCore

final class MarkdownDocumentTests: XCTestCase {
    func testHeadingsListsTasksAndNestedQuotesAreDistinctBlocks() {
        let document = MarkdownDocument("# Heading\n\n- first\n  - nested\n- [x] done\n2. second\n\n> quote\n> > inner")
        XCTAssertEqual(document.blocks, [
            .heading(level: 1, text: "Heading"),
            .listItem(marker: "•", text: "first", depth: 0, checked: nil),
            .listItem(marker: "•", text: "nested", depth: 1, checked: nil),
            .listItem(marker: "•", text: "done", depth: 0, checked: true),
            .listItem(marker: "2.", text: "second", depth: 0, checked: nil),
            .quote([.paragraph("quote"), .quote([.paragraph("inner")])])
        ])
    }

    func testCodeFenceUsesOpeningMarkerAndLengthAndPreservesLiteralMarkdown() {
        let text = "````swift\n# not a heading\n```\n~~~\nlet x = `thing`\n`````\nAfter"
        XCTAssertEqual(MarkdownDocument(text).blocks, [
            .code(language: "swift", text: "# not a heading\n```\n~~~\nlet x = `thing`"), .paragraph("After")
        ])
    }

    func testStreamingUnclosedFenceAndUnicodeDiffKeepAllContent() {
        XCTAssertEqual(MarkdownDocument("~~~diff\n-旧值\n+新值\n").blocks, [.code(language: "diff", text: "-旧值\n+新值\n")])
    }

    func testInlineBackticksDoNotBecomeBlockCode() {
        let text = "Use `code` and ```literal``` inside this paragraph.\nNext line."
        XCTAssertEqual(MarkdownDocument(text).blocks, [.paragraph(text)])
    }

    func testTablesRespectEscapedPipesInlineCodeAndAlignment() {
        let text = "| Name | Value |\n| :--- | ---: |\n| left\\|right | `a|b` |\n| next | 42 |"
        XCTAssertEqual(MarkdownDocument(text).blocks, [.table(headers: ["Name", "Value"], alignments: [.leading, .trailing], rows: [["left|right", "`a|b`"], ["next", "42"]])])
    }

    func testEmptyTableHeaderAndShortRowsAreRetained() {
        XCTAssertEqual(MarkdownDocument("| | B |\n| --- | :---: |\n| x |\n").blocks, [
            .table(headers: ["", "B"], alignments: [.leading, .center], rows: [["x", ""]])
        ])
    }

    func testMalformedExtraTableCellsAreNotDiscarded() {
        let blocks = MarkdownDocument("A | B\n--- | ---\nx | y | must remain").blocks
        XCTAssertEqual(blocks, [.table(headers: ["A", "B"], alignments: [.leading, .leading], rows: []), .paragraph("x | y | must remain")])
    }

    func testMalformedTableSeparatorRemainsText() {
        XCTAssertEqual(MarkdownDocument("A | B\n-- | ---\nx | y").blocks, [.paragraph("A | B\n-- | ---\nx | y")])
    }

    func testDoubleEscapedBackslashDoesNotHideTableDelimiter() {
        XCTAssertEqual(MarkdownDocument("A | B\n--- | ---\na\\\\|b").blocks, [
            .table(headers: ["A", "B"], alignments: [.leading, .leading], rows: [["a\\\\", "b"]])
        ])
    }

    func testIndentedCodeRetainsLeadingContentAndDoesNotExecuteHTML() {
        XCTAssertEqual(MarkdownDocument("    <script>literal</script>\n    # code\n\nAfter").blocks, [
            .code(language: "", text: "<script>literal</script>\n# code"), .paragraph("After")
        ])
    }

    func testSetextRuleAndClosingHeadingMarkers() {
        XCTAssertEqual(MarkdownDocument("Title\n===\n\n---\n\n### Third ###\n#hashtag").blocks, [
            .heading(level: 1, text: "Title"), .rule, .heading(level: 3, text: "Third"), .paragraph("#hashtag")
        ])
    }

    func testListContinuationRetainsLineAndNestedItemBoundary() {
        XCTAssertEqual(MarkdownDocument("- first\n  continuation\n  - nested\n\nparagraph").blocks, [
            .listItem(marker: "•", text: "first\ncontinuation", depth: 0, checked: nil),
            .listItem(marker: "•", text: "nested", depth: 1, checked: nil), .paragraph("paragraph")
        ])
    }

    func testOnlyAbsoluteHTTPLinksWithoutCredentialsAreInteractive() {
        for allowed in ["https://example.com/path?q=a#part", "http://localhost:3000/", "HTTPS://EXAMPLE.COM"] {
            XCTAssertTrue(MarkdownDocument.safeLink(URL(string: allowed)!), allowed)
        }
        for denied in ["javascript:alert(1)", "data:text/html,hello", "file:///tmp/private", "michi://execute", "mailto:a@example.com", "//example.com", "/relative/path", "https://user:password@example.com", "https:relative"] {
            XCTAssertFalse(MarkdownDocument.safeLink(URL(string: denied)!), denied)
        }
    }

    func testLargeAndTooManyLineInputsRemainAvailableAsLiteralContent() {
        let large = String(repeating: "界", count: 350_000)
        XCTAssertEqual(MarkdownDocument(large).blocks, [.literal(large)])
        let manyLines = String(repeating: "x\n", count: 6_001)
        XCTAssertEqual(MarkdownDocument(manyLines).blocks, [.literal(manyLines)])
    }

    func testBlockCountLimitPreservesRemainder() {
        let text = String(repeating: "# Heading\n", count: 1_002)
        let blocks = MarkdownDocument(text).blocks
        XCTAssertEqual(blocks.count, 1_001)
        XCTAssertEqual(blocks.last, .literal("# Heading\n# Heading\n"))
    }

    func testSimpleFlowchartChainsBranchesAndLaterLabels() throws {
        let source = "flowchart TB\nA[Start] --> B{Ready?}\nB -->|yes| C(Done)\nB --> D\nD[Try again]"
        let graph = try XCTUnwrap(MarkdownFlowchart.parse(source))
        XCTAssertFalse(graph.horizontal)
        XCTAssertEqual(graph.nodes.map(\.id), ["A", "B", "C", "D"])
        XCTAssertEqual(graph.nodes.map(\.rank), [0, 1, 2, 2])
        XCTAssertEqual(graph.nodes.last?.label, "Try again")
        XCTAssertEqual(graph.edges.map(\.label), ["", "yes", ""])
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.flowchart(graph)])
        let chain = try XCTUnwrap(MarkdownFlowchart.parse("graph LR; A --> B --> C"))
        XCTAssertTrue(chain.horizontal)
        XCTAssertEqual(chain.nodes.map(\.rank), [0, 1, 2])
    }

    func testUnsupportedMermaidIsAnIntactCodeBlock() {
        for source in [
            "flowchart TB\nA --> B\nclick A \"https://example.com\"",
            "flowchart TB\nA[<img src=x>] --> B",
            "flowchart TB\nsubgraph Group\nA --> B\nend\nB --> Group",
            "sequenceDiagram\nrect rgb(0, 0, 0)\nAlice->>Bob: hello\nend",
            "flowchart TB\nA --> B\nstyle A fill:red"
        ] {
            XCTAssertNil(MarkdownFlowchart.parse(source), source)
            XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)])
        }
    }

    func testFlowchartNodeResourceLimitFallsBackWithoutTruncation() {
        let source = "flowchart LR\n" + (0..<26).map { "N\($0)" }.joined(separator: " --> ")
        XCTAssertNil(MarkdownFlowchart.parse(source))
        XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)])
    }

    func testRawHTMLIsDataAndNotAnExecutableBlock() {
        let source = "<script>alert('x')</script>\n<iframe src=\"https://example.com\"></iframe>"
        let blocks = MarkdownDocument(source).blocks
        XCTAssertEqual(blocks.count, 2)
        for (block, line) in zip(blocks, source.split(separator: "\n", omittingEmptySubsequences: false)) {
            guard case .html(let document) = block else { return XCTFail("Expected inert HTML, not execution") }
            XCTAssertEqual(document.source, String(line))
            XCTAssertEqual(document.nodes, [.unsupported(String(line))])
        }
    }
}
