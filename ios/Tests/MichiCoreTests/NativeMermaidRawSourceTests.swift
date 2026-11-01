import XCTest
@testable import MichiCore

final class NativeMermaidRawSourceTests: XCTestCase {
    func testEmbeddedFenceRemainsEntireSourceInsteadOfEscapingPageBlock() {
        for source in ["graph LR\nA-->B\n```\n# Not a page heading\n```mermaid\nC-->D", "```\n<script>alert(1)</script>\n```"] {
            XCTAssertEqual(MarkdownDocument.mermaidBlock(source), .code(language: "mermaid", text: source))
        }
    }
    func testValidPageAndChatDiagramUseSameNativeAdapter() {
        for source in ["graph LR; A-->B", "sequenceDiagram\nA->>B: hello", "stateDiagram-v2\n[*] --> Ready"] {
            let block = MarkdownDocument.mermaidBlock(source)
            if case .code = block { XCTFail("Expected native diagram") }
            XCTAssertEqual(MarkdownDocument("```mermaid\n" + source + "\n```").blocks, [block])
        }
    }
}
