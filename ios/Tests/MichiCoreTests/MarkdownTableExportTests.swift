import Foundation
import XCTest
@testable import MichiCore

final class MarkdownTableExportTests: XCTestCase {
    func testExportsCompleteTableAndAlignmentWithoutStrippingInlineSource() throws {
        let output = try MarkdownTableExport.serialize(headers: ["Name", "**Value**", "Note"], alignments: [.leading, .center, .trailing], rows: [["[Michi](https://example.com)", "`code`", "中文 👩🏽‍💻"]])
        XCTAssertEqual(output, "| Name | **Value** | Note |\n| --- | :---: | ---: |\n| [Michi](https://example.com) | `code` | 中文 👩🏽‍💻 |")
    }

    func testEscapesPipesAndNormalizesAllLineBreaksWithoutAddingRows() throws {
        let output = try MarkdownTableExport.serialize(headers: ["A|B", "Lines"], alignments: [], rows: [["x|y", "one\r\ntwo\rthree\nfour"], ["`a|b`", ""]])
        XCTAssertEqual(output, "| A\\|B | Lines |\n| --- | --- |\n| x\\|y | one<br>two<br>three<br>four |\n| `a\\|b` |  |")
        XCTAssertEqual(output.components(separatedBy: "\n").count, 4)
    }

    func testParsedEscapedPipesAndBackslashesRoundTripThroughTableParser() throws {
        let original = "| Name | Code |\n| --- | --- |\n| a\\\\\\|b | `x|y` |\n| C:\\folder | tail\\ |"
        guard case .table(let headers, let alignments, let rows) = try XCTUnwrap(MarkdownDocument(original).blocks.first) else { return XCTFail("Expected table") }
        let exported = try MarkdownTableExport.serialize(headers: headers, alignments: alignments, rows: rows)
        XCTAssertEqual(MarkdownDocument(exported).blocks, MarkdownDocument(original).blocks)
    }

    func testOddBackslashesCannotExposePipeDelimiters() throws {
        let output = try MarkdownTableExport.serialize(headers: ["A", "B"], alignments: [], rows: [["a\\|b", "preserved"]])
        XCTAssertTrue(output.contains("a\\\\\\|b"))
        guard case .table(_, _, let rows) = try XCTUnwrap(MarkdownDocument(output).blocks.first) else { return XCTFail("Expected table") }
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].count, 2)
        XCTAssertEqual(rows[0][1], "preserved")
    }

    func testPipesWithCombiningMarkVariationSelectorAndJoinerAreEscapedAsScalars() throws {
        for suffix in ["\u{0301}", "\u{FE0F}", "\u{200D}"] {
            let output = try MarkdownTableExport.serialize(headers: ["H|\(suffix)"], alignments: [], rows: [["left|\(suffix)right"], ["`code|\(suffix)value`"]])
            let expected = "| H\\|\(suffix) |\n| --- |\n| left\\|\(suffix)right |\n| `code\\|\(suffix)value` |"
            // Compare bytes as well as strings so Unicode canonical equivalence
            // cannot hide a changed or dropped combining scalar.
            XCTAssertEqual(Data(output.utf8), Data(expected.utf8))
        }
    }

    func testBackslashParityIsPreservedBeforePipeWithCombiningScalar() throws {
        for suffix in ["\u{0301}", "\u{FE0F}", "\u{200D}"] {
            let output = try MarkdownTableExport.serialize(headers: ["A"], alignments: [], rows: [["a\\\\|\(suffix)b"]])
            XCTAssertEqual(Data(output.utf8), Data("| A |\n| --- |\n| a\\\\\\|\(suffix)b |".utf8))
        }
    }

    func testUnicodeDelimiterExportKeepsFullLongCellAndFinalRowBeyondPreview() throws {
        let cell = String(repeating: "界|\u{0301}|\u{FE0F}|\u{200D}👩🏽‍💻", count: 500) + "FINAL CELL"
        let escaped = String(repeating: "界\\|\u{0301}\\|\u{FE0F}\\|\u{200D}👩🏽‍💻", count: 500) + "FINAL CELL"
        var rows = (0..<100).map { ["row \($0)"] }
        rows.append([cell])
        let output = try MarkdownTableExport.serialize(headers: ["A"], alignments: [], rows: rows)
        let expected = (["| A |", "| --- |"] + (0..<100).map { "| row \($0) |" } + ["| \(escaped) |"]).joined(separator: "\n")
        XCTAssertEqual(Data(output.utf8), Data(expected.utf8))
        XCTAssertEqual(output.components(separatedBy: "\n").count, 103)
    }

    func testRaggedRowsAndMissingHeadersArePaddedWithoutDroppingExtraCells() throws {
        XCTAssertEqual(try MarkdownTableExport.serialize(headers: ["A"], alignments: [.trailing], rows: [["one", "two", "three"], ["four"]]),
                       "| A |  |  |\n| ---: | --- | --- |\n| one | two | three |\n| four |  |  |")
        XCTAssertEqual(try MarkdownTableExport.serialize(headers: [], alignments: [], rows: [["value"]]), "|  |\n| --- |\n| value |")
    }

    func testEmptyAndHeaderOnlyTablesDoNotInventRows() throws {
        XCTAssertEqual(try MarkdownTableExport.serialize(headers: [], alignments: [], rows: []), "")
        XCTAssertEqual(try MarkdownTableExport.serialize(headers: ["A"], alignments: [], rows: []), "| A |\n| --- |")
    }

    func testExportContainsRowsBeyondNativePreviewPage() throws {
        let rows = (0..<101).map { ["row \($0)", "value \($0)"] }
        let output = try MarkdownTableExport.serialize(headers: ["Row", "Value"], alignments: [], rows: rows)
        XCTAssertEqual(output.components(separatedBy: "\n").count, 103)
        XCTAssertTrue(output.hasSuffix("| row 100 | value 100 |"))
    }

    func testExportContainsEntireLongCellBeyondNativePreview() throws {
        let value = String(repeating: "界", count: 5_000) + "FINAL CELL VALUE"
        let output = try MarkdownTableExport.serialize(headers: ["Value"], alignments: [], rows: [[value]])
        XCTAssertTrue(output.contains(value))
        XCTAssertTrue(output.hasSuffix("FINAL CELL VALUE |"))
    }

    func testOversizedShapesFailInsteadOfReturningPartialTables() {
        XCTAssertThrowsError(try MarkdownTableExport.serialize(headers: Array(repeating: "", count: 201), alignments: [], rows: [])) { XCTAssertEqual($0 as? MarkdownTableExport.Failure, .tooManyColumns) }
        XCTAssertThrowsError(try MarkdownTableExport.serialize(headers: ["A"], alignments: [], rows: Array(repeating: [], count: 10_001))) { XCTAssertEqual($0 as? MarkdownTableExport.Failure, .tooManyRows) }
        XCTAssertThrowsError(try MarkdownTableExport.serialize(headers: Array(repeating: "", count: 200), alignments: [], rows: Array(repeating: [], count: 499))) { XCTAssertEqual($0 as? MarkdownTableExport.Failure, .tooManyCells) }
    }

    func testBoundCountsUTF8AndEscapeExpansionRatherThanCharacterCount() {
        let unicode = String(repeating: "界", count: MarkdownTableExport.maximumUTF8Bytes / 3 + 1)
        XCTAssertThrowsError(try MarkdownTableExport.serialize(headers: ["A"], alignments: [], rows: [[unicode]])) { XCTAssertEqual($0 as? MarkdownTableExport.Failure, .tooLarge) }
        let pipes = String(repeating: "|", count: MarkdownTableExport.maximumUTF8Bytes / 2)
        XCTAssertThrowsError(try MarkdownTableExport.serialize(headers: ["A"], alignments: [], rows: [[pipes]])) { XCTAssertEqual($0 as? MarkdownTableExport.Failure, .tooLarge) }
    }
}
