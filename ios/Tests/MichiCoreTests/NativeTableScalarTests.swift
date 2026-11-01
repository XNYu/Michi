import XCTest
@testable import MichiCore

final class NativeTableScalarTests: XCTestCase {
    func testRawPipeWithCombiningScalarStillSeparatesGFMCells() {
        for suffix in ["\u{0301}", "\u{FE0F}", "\u{200D}"] {
            let source = "| A | B |\n| --- | --- |\n| left|" + suffix + "right |"
            guard case .table(_, _, let rows)? = MarkdownDocument(source).blocks.first else {
                XCTFail("Expected table"); continue
            }
            XCTAssertEqual(rows, [["left", suffix + "right"]])
        }
    }
    func testEscapedPipeWithCombiningScalarRemainsInsideOneCell() {
        for suffix in ["\u{0301}", "\u{FE0F}", "\u{200D}"] {
            let source = "| A | B |\n| --- | --- |\n| left\\|" + suffix + "right | safe |"
            guard case .table(_, _, let rows)? = MarkdownDocument(source).blocks.first else {
                XCTFail("Expected table"); continue
            }
            XCTAssertEqual(rows, [["left|" + suffix + "right", "safe"]])
        }
    }
    func testExportRoundTripPreservesCombinedPipesAndUnicode() throws {
        for suffix in ["\u{0301}", "\u{FE0F}", "\u{200D}"] {
            let cell = "Michi |" + suffix + " 中文 👩🏽‍💻"
            let serialized = try MarkdownTableExport.serialize(headers: ["Value"], alignments: [.leading], rows: [[cell]])
            guard case .table(let headers, _, let rows)? = MarkdownDocument(serialized).blocks.first else {
                XCTFail("Expected table"); continue
            }
            XCTAssertEqual(headers, ["Value"])
            XCTAssertEqual(rows, [[cell]])
        }
    }
}
