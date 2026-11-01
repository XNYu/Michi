import Foundation
import XCTest
@testable import MichiCore

final class HTMLDocumentTests: XCTestCase {
    func testDetailsSummarySupSubKbdMarkAndLinks() {
        let source = #"<details open><summary>More</summary>see <sup>2</sup> and <sub>2</sub> press <kbd>Cmd</kbd> and <mark>hit</mark> <a href="https://example.com">site</a></details>"#
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.source, source)
        XCTAssertFalse(document.truncated)
        guard case .element(let details)? = document.nodes.only, details.name == .details, details.open else {
            return XCTFail("Expected an open details element")
        }
        XCTAssertEqual(details.children.compactMap(\.name), [.summary, .sup, .sub, .kbd, .mark, .a])
        XCTAssertEqual(details.children.compactMap(\.text), ["see ", " and ", " press ", " and ", " "])
        XCTAssertEqual(details.children.compactMap(\.onlyText), ["More", "2", "2", "Cmd", "hit", "site"])
        XCTAssertEqual(details.children.compactMap(\.href), ["https://example.com"])
        XCTAssertEqual(NativeHTMLSyntax.linkURL("https://example.com")?.absoluteString, "https://example.com")
    }

    func testSemanticInlineFormattingAndListsAndTable() {
        let source = "<p><strong>A</strong> <em>B</em> <del>C</del></p><ul><li>one</li><li>two</li></ul><table><tr><th>H</th></tr><tr><td>1</td></tr></table>"
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.nodes.compactMap(\.name), [.p, .ul, .table])
        XCTAssertEqual(document.searchableText, "A B C one two H 1")
        XCTAssertEqual(document.tables().map(\.headers), [["H"]])
        XCTAssertEqual(document.tables().map(\.rows), [[["1"]]])
        XCTAssertEqual(document.tables().first?.alignments, [.leading])
    }

    func testScriptsEventsAndResourceTagsAreUnsupportedSource() {
        let source = #"<script>window.x=1</script><img src="https://example.com/x.png" onerror="alert(1)"><iframe src="https://example.com"></iframe><a href="javascript:alert(1)">go</a>"#
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.reconstructed, source)
        XCTAssertEqual(document.nodes.map(\.kind), ["unsupported", "unsupported", "unsupported", "element"])
        XCTAssertEqual(document.nodes[0].source, "<script>window.x=1</script>")
        XCTAssertEqual(document.nodes[1].source, #"<img src="https://example.com/x.png" onerror="alert(1)">"#)
        XCTAssertTrue(document.nodes.compactMap(\.href).isEmpty)
        XCTAssertNil(NativeHTMLSyntax.linkURL("javascript:alert(1)"))
        XCTAssertNil(NativeHTMLSyntax.linkURL("data:text/html,hi"))
        XCTAssertNil(NativeHTMLSyntax.linkURL("file:///tmp/x"))
        XCTAssertNil(NativeHTMLSyntax.linkURL("vbscript:x"))
    }

    func testExactMichiLinksSurviveAndMalformedOnesDoNot() {
        XCTAssertEqual(NativeHTMLSyntax.linkURL("michi://node/n-1?message=m-1")?.absoluteString, "michi://node/n-1?message=m-1")
        XCTAssertEqual(NativeHTMLSyntax.linkURL("michi://page/p-1?block=b-1")?.absoluteString, "michi://page/p-1?block=b-1")
        for denied in ["michi://node/n-1?message=m-1&other=x", "michi://page/..", "michi://command/delete", "mailto:a@example.com"] {
            XCTAssertNil(NativeHTMLSyntax.linkURL(denied), denied)
        }
    }

    func testAutolinksAndProseComparisonsAreNotTags() {
        let source = #"<https://example.test/$x$> <dev+$cash$@example.test> a < b and <kbd>K</kbd>"#
        XCTAssertTrue(NativeHTMLSyntax.containsMarkup(source))
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.reconstructed, source)
        XCTAssertEqual(document.nodes.compactMap(\.name), [.kbd])
        XCTAssertEqual(document.nodes.first?.text, "<https://example.test/$x$> <dev+$cash$@example.test> a < b and ")
    }

    func testEntitiesDecodeOnlyInTextAndSafeAttributes() {
        let source = #"<a href="https://example.com/?q=a&amp;b=1">&lt;x&gt; &amp; &#39;y&#x27;</a>"#
        let document = NativeHTMLSyntax.parse(source)
        guard case .element(let link)? = document.nodes.only, link.name == .a else { return XCTFail("Expected a link") }
        XCTAssertEqual(link.href, "https://example.com/?q=a&b=1")
        XCTAssertEqual(link.children.only?.text, "<x> & 'y'")
        XCTAssertEqual(document.reconstructed, source)
    }

    func testUnknownAndUnclosedMarkupKeepsExactSource() {
        let source = "<custom onload=\"x\">keep</custom><details>still open"
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.reconstructed, source)
        XCTAssertEqual(document.nodes.map(\.kind), ["unsupported", "element"])
        XCTAssertEqual(document.nodes[0].source, "<custom onload=\"x\">keep</custom>")
        XCTAssertEqual(document.nodes[1].name, .details)
        XCTAssertEqual(document.nodes[1].children.only?.text, "still open")
    }

    func testBoundsPreserveRemainderAsUnsupportedSource() {
        let huge = String(repeating: "x", count: 64_001)
        let overflow = NativeHTMLSyntax.parse(huge)
        XCTAssertTrue(overflow.truncated)
        XCTAssertEqual(overflow.nodes, [.unsupported(huge)])
        XCTAssertEqual(overflow.source, huge)

        let many = String(repeating: "<kbd>k</kbd>", count: 600)
        let document = NativeHTMLSyntax.parse(many)
        XCTAssertTrue(document.truncated)
        XCTAssertEqual(document.source, many)
        XCTAssertEqual(document.reconstructed, many)
        XCTAssertGreaterThan(document.nodes.count, 1)
        XCTAssertLessThanOrEqual(document.nodes.filter { $0.name == .kbd }.count, 512)
    }

    func testContainsMarkupIgnoresBareAngles() {
        XCTAssertFalse(NativeHTMLSyntax.containsMarkup("a < b and c > d"))
        XCTAssertFalse(NativeHTMLSyntax.containsMarkup("<3 apples"))
        XCTAssertTrue(NativeHTMLSyntax.containsMarkup("press <KBD>Enter</KBD>"))
        XCTAssertTrue(NativeHTMLSyntax.containsMarkup("<script>x</script>"))
    }

    func testNestedBudgetExhaustionKeepsConsumedParentSourceVisible() {
        let source = "<div>" + String(repeating: "<kbd>k</kbd>", count: 600) + "</div>after"
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertTrue(document.truncated)
        XCTAssertEqual(document.nodes, [.unsupported(source)])
        XCTAssertEqual(document.source, source)
    }

    func testEmailAutolinkIsNotMarkup() {
        XCTAssertFalse(NativeHTMLSyntax.containsMarkup("<dev@example.com>"))
        XCTAssertFalse(NativeHTMLSyntax.containsMarkup("Write <dev@example.com> please"))
        XCTAssertFalse(NativeHTMLSyntax.containsMarkup("<dev+$cash$@example.test>"))
        XCTAssertFalse(NativeHTMLSyntax.containsMarkup("<https://example.test/$x$>"))
        XCTAssertFalse(NativeHTMLSyntax.containsMarkup("<kbd"))
        XCTAssertTrue(NativeHTMLSyntax.containsMarkup("see <kbd>K</kbd> and <dev@example.com>"))
        let email = NativeHTMLSyntax.parse("<dev@example.com>")
        XCTAssertEqual(email.reconstructed, "<dev@example.com>")
        XCTAssertEqual(email.nodes.map(\.kind), ["text"])
        XCTAssertEqual(email.nodes.first?.text, "<dev@example.com>")
    }

    func testUnclosedInlineDoesNotSwallowFollowingMarkdown() {
        let source = "Press <kbd>Cmd and **bold** $x$"
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.reconstructed, source)
        let fragments = NativeHTMLSyntax.inlineFragments(source)
        XCTAssertEqual(NativeHTMLSyntax.reconstructed(fragments), source)
        XCTAssertTrue(fragments.allSatisfy { if case .text = $0 { return true }; return false })
        XCTAssertFalse(NativeHTMLSyntax.markdownCrossesHTML(fragments))
    }

    func testInlineFragmentsKeepMarkdownMathAroundCompleteHTML() {
        let source = "**bold** and <kbd>Enter</kbd> then $x$ plus <dev@example.com>"
        XCTAssertTrue(NativeHTMLSyntax.containsMarkup(source))
        let fragments = NativeHTMLSyntax.inlineFragments(source)
        XCTAssertEqual(NativeHTMLSyntax.reconstructed(fragments), source)
        XCTAssertEqual(fragments.count, 3)
        guard case .text(let prefix) = fragments[0] else { return XCTFail("Expected markdown prefix") }
        guard case .html(let node, let html) = fragments[1] else { return XCTFail("Expected kbd") }
        guard case .text(let suffix) = fragments[2] else { return XCTFail("Expected markdown suffix") }
        XCTAssertEqual(prefix, "**bold** and ")
        XCTAssertEqual(html, "<kbd>Enter</kbd>")
        XCTAssertEqual(node.name, .kbd)
        XCTAssertEqual(node.onlyText, "Enter")
        XCTAssertEqual(suffix, " then $x$ plus <dev@example.com>")
        XCTAssertFalse(NativeHTMLSyntax.markdownCrossesHTML(fragments))
    }

    func testInlineFragmentsSkipCodeSpansAndUnclosedTags() {
        let source = "Use `<kbd>x</kbd>` and <kbd>y"
        let fragments = NativeHTMLSyntax.inlineFragments(source)
        XCTAssertEqual(NativeHTMLSyntax.reconstructed(fragments), source)
        XCTAssertTrue(fragments.allSatisfy { if case .text = $0 { return true }; return false })
    }

    func testEmphasisCrossingHTMLRequestsExactSource() {
        let source = "**bold <kbd>x</kbd> still**"
        let fragments = NativeHTMLSyntax.inlineFragments(source)
        XCTAssertEqual(NativeHTMLSyntax.reconstructed(fragments), source)
        XCTAssertTrue(NativeHTMLSyntax.markdownCrossesHTML(fragments))
    }

    func testInlineTableFragmentIsLocalAndLossless() {
        let source = "See <table><tr><th>H</th></tr><tr><td>1</td></tr></table> after"
        let fragments = NativeHTMLSyntax.inlineFragments(source)
        XCTAssertEqual(NativeHTMLSyntax.reconstructed(fragments), source)
        XCTAssertEqual(fragments.count, 3)
        guard case .html(let node, let html) = fragments[1] else { return XCTFail("Expected table") }
        XCTAssertEqual(node.name, .table)
        XCTAssertEqual(NativeHTMLDocument(nodes: [node], source: html).tables().map(\.headers), [["H"]])
        XCTAssertFalse(NativeHTMLSyntax.markdownCrossesHTML(fragments))
    }

    func testUnknownAndMalformedTagsStayVisibleText() {
        let source = #"<custom>keep</custom> and <kbd class="x" <not"#
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.reconstructed, source)
        XCTAssertEqual(document.nodes[0].source, "<custom>keep</custom>")
        let fragments = NativeHTMLSyntax.inlineFragments(source)
        XCTAssertEqual(NativeHTMLSyntax.reconstructed(fragments), source)
        XCTAssertTrue(fragments.allSatisfy { if case .text = $0 { return true }; return false })
    }

    func testTableCellsPreserveBoundedInlineHTML() {
        let source = #"<table><thead><tr><th>Kind</th><th>Example</th></tr></thead><tbody><tr><td>subscript</td><td>H<sub>2</sub>O</td></tr><tr><td><strong>A</strong> <em>B</em> <code>c</code> <kbd>K</kbd> <mark>m</mark> <a href="https://example.com">site</a></td><td>mc<sup>2</sup></td></tr></tbody></table>"#
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.reconstructed, source)
        XCTAssertEqual(document.tables().count, 1)
        let table = document.tables()[0]
        XCTAssertEqual(table.headers, ["Kind", "Example"])
        XCTAssertEqual(table.alignments, [.leading, .leading])
        XCTAssertEqual(table.rows, [
            ["subscript", "H<sub>2</sub>O"],
            [#"<strong>A</strong> <em>B</em> <code>c</code> <kbd>K</kbd> <mark>m</mark> <a href="https://example.com">site</a>"#, "mc<sup>2</sup>"]
        ])
        XCTAssertEqual(table.headerCells, [[.text("Kind")], [.text("Example")]])
        XCTAssertEqual(table.rowCells[0][0], [.text("subscript")])
        XCTAssertEqual(table.rowCells[0][1], [
            .text("H"),
            .html(node: .element(.init(name: .sub, children: [.text("2")])), source: "<sub>2</sub>"),
            .text("O")
        ])
        XCTAssertEqual(table.rowCells[1][1], [
            .text("mc"),
            .html(node: .element(.init(name: .sup, children: [.text("2")])), source: "<sup>2</sup>")
        ])
        XCTAssertFalse(table.rows[0][1].contains("H2O"))
        XCTAssertTrue(table.rows[0][1].contains("<sub>"))
        XCTAssertFalse(document.searchableText.contains("<sub>"))
        XCTAssertTrue(document.searchableText.contains("H"))
    }

    func testTDOnlyTableKeepsEveryDataRow() {
        let source = "<table><tr><td>subscript</td><td>H<sub>2</sub>O</td></tr><tr><td>superscript</td><td>mc<sup>2</sup></td></tr></table>"
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.tables().count, 1)
        let table = document.tables()[0]
        XCTAssertEqual(table.headers, [])
        XCTAssertEqual(table.headerCells, [])
        XCTAssertEqual(table.rows, [["subscript", "H<sub>2</sub>O"], ["superscript", "mc<sup>2</sup>"]])
        XCTAssertEqual(table.rowCells.count, 2)
        XCTAssertEqual(table.alignments, [.leading, .leading])
    }

    func testOrdinaryTHThenTDTableContracts() {
        let source = "<table><tr><th>H</th></tr><tr><td>1</td></tr></table>"
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(document.tables().map(\.headers), [["H"]])
        XCTAssertEqual(document.tables().map(\.rows), [[["1"]]])
        XCTAssertEqual(document.tables().first?.alignments, [.leading])
        XCTAssertEqual(document.tables().first?.headerCells, [[.text("H")]])
        XCTAssertEqual(document.tables().first?.rowCells, [[[.text("1")]]])
    }

    func testRowspanColspanKeepsTableOrdinalWithoutPartialGrid() {
        let rowspan = #"<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>"#
        let colspan = #"<table><tr><td colspan="2">A</td></tr><tr><td>B</td><td>C</td></tr></table>"#
        for source in [rowspan, colspan] {
            let document = NativeHTMLSyntax.parse(source)
            XCTAssertTrue(document.tables().isEmpty, source)
            XCTAssertEqual(NativeMarkdownTableOrder.count(in: document.nodes), 1, source)
            XCTAssertEqual(document.nodes.first?.name, .table)
            XCTAssertEqual(document.reconstructed, source)
        }
    }

    func testNestedTableKeepsOrdinalWithoutRecursiveCells() {
        let source = "<table><tr><td><table><tr><th>H</th></tr><tr><td>1</td></tr></table></td></tr></table>"
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertTrue(document.tables().isEmpty)
        XCTAssertEqual(NativeMarkdownTableOrder.count(in: document.nodes), 1)
        XCTAssertEqual(document.reconstructed, source)
    }

    func testTableCellLiteralComparisonIsNotMarkup() {
        let source = "<table><tr><th>H</th></tr><tr><td>a < b and c > d</td></tr></table>"
        let table = NativeHTMLSyntax.parse(source).tables()[0]
        XCTAssertEqual(table.rows, [["a < b and c > d"]])
        XCTAssertEqual(table.rowCells, [[[.text("a < b and c > d")]]])
    }
}

final class MarkdownHTMLBlockTests: XCTestCase {
    func testRawExecutableHTMLIsAnInertHTMLBlock() {
        let source = "<script>alert('x')</script>\n<iframe src=\"https://example.com\"></iframe>"
        let blocks = MarkdownDocument(source).blocks
        XCTAssertEqual(blocks.count, 2)
        for (block, line) in zip(blocks, source.split(separator: "\n", omittingEmptySubsequences: false)) {
            guard case .html(let document) = block else { return XCTFail("Expected html block") }
            XCTAssertEqual(document.source, String(line))
            XCTAssertEqual(document.nodes.map(\.kind), ["unsupported"])
            XCTAssertEqual(document.reconstructed, String(line))
        }
    }

    func testDetailsBlockDoesNotBecomeAParagraph() {
        let source = "<details>\n<summary>Note</summary>\nbody\n</details>\n\nAfter"
        XCTAssertEqual(MarkdownDocument(source).blocks, [
            .html(NativeHTMLSyntax.parse("<details>\n<summary>Note</summary>\nbody\n</details>")),
            .paragraph("After")
        ])
    }

    func testInlineHTMLStaysInTheParagraphForSearchAndMath() {
        let source = "Press <kbd>Cmd</kbd> and $x$"
        XCTAssertEqual(MarkdownDocument(source).blocks, [.paragraph(source)])
        XCTAssertTrue(NativeHTMLSyntax.containsMarkup(source))
    }

    func testUnclosedHTMLBlockRemainsLosslessParagraph() {
        let source = "<details>\nstill streaming"
        XCTAssertEqual(MarkdownDocument(source).blocks, [.paragraph(source)])
    }

    func testIndentedHTMLRemainsCode() {
        XCTAssertEqual(MarkdownDocument("    <script>literal</script>\n    # code").blocks, [
            .code(language: "", text: "<script>literal</script>\n# code")
        ])
    }

    func testInlineHTMLWithEmailAndMathStaysAParagraph() {
        let source = "Ask <dev@example.com> about $x$ and **bold**"
        XCTAssertEqual(MarkdownDocument(source).blocks, [.paragraph(source)])
        XCTAssertFalse(NativeHTMLSyntax.containsMarkup(source))
    }
}

final class NativeMarkdownTableOrderTests: XCTestCase {
    func testOrderWalksQuoteAndHTMLTablesDepthFirst() {
        let markdown = """
        | A | B |
        | --- | --- |
        | 1 | 2 |

        > | Q | R |
        > | --- | --- |
        > | 3 | 4 |

        <table><tr><th>H</th></tr><tr><td>1</td></tr></table>

        <details>
        <summary>Note</summary>
        <table><tr><th>D</th></tr><tr><td>2</td></tr></table>
        </details>
        """
        let blocks = MarkdownDocument(markdown).blocks
        XCTAssertEqual(NativeMarkdownTableOrder.count(in: blocks), 4)
        XCTAssertEqual(NativeMarkdownTableOrder.count(before: 0, in: blocks), 0)
        let quoteIndex = blocks.firstIndex { if case .quote = $0 { return true }; return false }
        let htmlIndices = blocks.indices.filter { if case .html = blocks[$0] { return true }; return false }
        XCTAssertEqual(quoteIndex, 1)
        XCTAssertEqual(htmlIndices.count, 2)
        XCTAssertEqual(NativeMarkdownTableOrder.count(before: 1, in: blocks), 1)
        XCTAssertEqual(NativeMarkdownTableOrder.count(before: htmlIndices[0], in: blocks), 2)
        XCTAssertEqual(NativeMarkdownTableOrder.count(before: htmlIndices[1], in: blocks), 3)
        guard case .html(let details) = blocks[htmlIndices[1]] else { return XCTFail("Expected details html") }
        XCTAssertEqual(NativeMarkdownTableOrder.count(in: details.nodes), 1)
    }

    func testSameHeaderTablesKeepDistinctOrdinalsIndependentOfRows() {
        let short = MarkdownDocument("| H |\n| --- |\n| 1 |\n\n| H |\n| --- |\n| 2 |")
        let longer = MarkdownDocument("| H |\n| --- |\n| 1 |\n| extra |\n\n| H |\n| --- |\n| 2 |")
        XCTAssertEqual(NativeMarkdownTableOrder.count(in: short.blocks), 2)
        XCTAssertEqual(NativeMarkdownTableOrder.count(in: longer.blocks), 2)
        XCTAssertEqual(NativeMarkdownTableOrder.count(before: 1, in: short.blocks), 1)
        XCTAssertEqual(NativeMarkdownTableOrder.count(before: 1, in: longer.blocks), 1)
    }

    func testHTMLDetailsThenSiblingTableUsesSourceWalk() {
        let source = "<details><summary>s</summary><table><tr><th>D</th></tr><tr><td>1</td></tr></table></details><table><tr><th>H</th></tr><tr><td>2</td></tr></table>"
        let document = NativeHTMLSyntax.parse(source)
        XCTAssertEqual(NativeMarkdownTableOrder.count(in: document.nodes), 2)
        XCTAssertEqual(NativeMarkdownTableOrder.index(ofTableAt: [0, 1], in: document.nodes), 0)
        XCTAssertEqual(NativeMarkdownTableOrder.index(ofTableAt: [1], in: document.nodes), 1)
        XCTAssertEqual(document.tables().map(\.headers), [["D"], ["H"]])
    }
}

private extension Array {
    var only: Element? { count == 1 ? first : nil }
}

private extension NativeHTMLNode {
    var kind: String {
        switch self {
        case .text: return "text"
        case .element: return "element"
        case .unsupported: return "unsupported"
        }
    }
    var name: NativeHTMLName? { if case .element(let element) = self { return element.name }; return nil }
    var href: String? { if case .element(let element) = self { return element.href }; return nil }
    var text: String? { if case .text(let value) = self { return value }; return nil }
    var onlyText: String? {
        if case .element(let element) = self, case .text(let value)? = element.children.only { return value }
        return nil
    }
    var source: String? { if case .unsupported(let value) = self { return value }; return nil }
    var children: [NativeHTMLNode] { if case .element(let element) = self { return element.children }; return [] }
}
