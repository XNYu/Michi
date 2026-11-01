import XCTest
@testable import MichiCore

final class NativeMichiReferenceTests: XCTestCase {
    func testAssistantLinkExamplesMatchWebParser() {
        XCTAssertEqual(NativeMichiReference.parse("michi://node/n-123"), .node(id: "n-123", messageID: nil))
        XCTAssertEqual(NativeMichiReference.parse("michi://node/n-123?message=a-9"), .node(id: "n-123", messageID: "a-9"))
        XCTAssertEqual(NativeMichiReference.parse("MICHI://Node/n-1/?message=self-n%2D1"), .node(id: "n-1", messageID: "self-n-1"))
        XCTAssertEqual(NativeMichiReference.parse("michi://page/pg-adbd"), .page(id: "pg-adbd", blockID: nil))
        XCTAssertEqual(NativeMichiReference.parse("MICHI://Page/pg-1/?block=b%2D2"), .page(id: "pg-1", blockID: "b-2"))
        XCTAssertEqual(NativeMichiReference.parse("michi://page/pg-1?block=markdown~2"), .page(id: "pg-1", blockID: "markdown~2"))
    }

    func testAllowedASCIIIDsAndPercentDecodingPreserveCaseAndPlus() {
        let id = "Aa09._:~@+=-"
        XCTAssertEqual(NativeMichiReference.parse("michi://node/\(id)?MESSAGE=a+b%3Dc"), .node(id: id, messageID: "a+b=c"))
        XCTAssertEqual(NativeMichiReference.parse("michi://page/p%40x?BLOCK=x%3Ay"), .page(id: "p@x", blockID: "x:y"))
        XCTAssertNil(NativeMichiReference.parse("michi://node/%252E%252E"), "Decode once, never recursively")
    }

    func testIDLengthAppliesToDecodedValueAndEveryComponent() {
        let maximum = String(repeating: "a", count: 256), excess = maximum + "b"
        XCTAssertEqual(NativeMichiReference.parse("michi://node/\(maximum)"), .node(id: maximum, messageID: nil))
        XCTAssertNotNil(NativeMichiReference.parse("michi://page/p?block=\(String(repeating: "%61", count: 256))"))
        for value in ["michi://node/\(excess)", "michi://node/n?message=\(excess)", "michi://page/\(excess)", "michi://page/p?block=\(excess)"] {
            XCTAssertNil(NativeMichiReference.parse(value))
        }
    }

    func testRejectsExtraQueryFragmentsCredentialsPathsAndDotOnlyIDs() {
        for value in [
            "", "https://example.com", "javascript:alert(1)", "michi://thread/x", "desk://node/x", "michi:node/x",
            "michi://node/", "michi://node/a/b", "michi://node/a//", "michi://node/n?message=", "michi://node/n?message=a&x=1",
            "michi://node/n?block=b1", "michi://node/n?message=a#x", "michi://node/n#fragment", "michi://node/n?message=a?x=1",
            "michi://user:secret@node/n", "michi://node:123/n", "michi://node@evil/n", "michi://node/..", "michi://page/%2E%2E%2E",
            "michi://page/p?block=.", "michi://node/n?message=..", "michi://page/p?block=b&block=b", "michi://page/p?block=b/",
            "michi://node/%2F", "michi://node/a%5Cb", "michi://node/%3Cscript%3E", "michi://node/%E0%A4%A", "michi://node/%FF",
            "michi://node/n%20a", "michi://page/你好", "michi://source/n?turn=t&assistant=a"
        ] { XCTAssertNil(NativeMichiReference.parse(value), value) }
    }

    func testMatchesJavaScriptWhitespaceWithoutNormalizingIDs() {
        XCTAssertEqual(NativeMichiReference.parse("\u{FEFF}\t michi://node/n \n\u{3000}"), .node(id: "n", messageID: nil))
        XCTAssertNil(NativeMichiReference.parse("\u{0085}michi://node/n"))
        XCTAssertNil(NativeMichiReference.parse("michi://node/n\u{2028}x"))
        XCTAssertNil(NativeMichiReference.parse("michi://node/n?message=a%0Ab"))
        XCTAssertNil(NativeMichiReference.parse("michi://node/n?meſſage=a"))
        XCTAssertNil(NativeMichiReference.parse("michi://page/p?blocK=b"))
    }

    func testOpaqueSourceEqualityAndHashDoNotNormalizeUnicode() {
        let composed = "é", decomposed = "e\u{0301}"
        XCTAssertEqual(composed, decomposed, "Swift text equality demonstrates why opaque IDs need byte identity")
        let values: [NativeMichiReference] = [
            .source(nodeID: composed, turnID: "t", assistantID: "a"), .source(nodeID: decomposed, turnID: "t", assistantID: "a"),
            .source(nodeID: "n", turnID: composed, assistantID: "a"), .source(nodeID: "n", turnID: decomposed, assistantID: "a"),
            .source(nodeID: "n", turnID: "t", assistantID: composed), .source(nodeID: "n", turnID: "t", assistantID: decomposed)
        ]
        XCTAssertEqual(Set(values).count, 6)
        XCTAssertNotEqual(values[0], values[1]); XCTAssertNotEqual(values[2], values[3]); XCTAssertNotEqual(values[4], values[5])
    }

    func testStructuredSourcesPreserveOpaqueIDsNotLinkGrammar() {
        let source: JSONValue = ["nodeId": "node/with spaces", "turnId": "..", "assistantId": "回答🦉?&%"]
        XCTAssertEqual(NativeMichiReference.source(source), .source(nodeID: "node/with spaces", turnID: "..", assistantID: "回答🦉?&%"))
        XCTAssertTrue(NativeMichiReference.source(source)!.isValid)
        XCTAssertNotNil(NativeMichiReference.source(["nodeId": " ", "turnId": "\n", "assistantId": "."]))
    }

    func testSourceLimitsCountUTF16AndRejectWrongTypesAndEmptyValues() {
        let maximum = String(repeating: "🦉", count: 100)
        let source: JSONValue = ["nodeId": .string(maximum), "turnId": "t", "assistantId": "a"]
        XCTAssertNotNil(NativeMichiReference.source(source))
        XCTAssertNil(NativeMichiReference.source(source.merging(["nodeId": .string(maximum + "x")])))
        for key in ["nodeId", "turnId", "assistantId"] {
            for bad in [JSONValue.null, "", 1, true, [], [:]] {
                XCTAssertNil(NativeMichiReference.source(source.merging([key: bad])))
            }
        }
    }

    func testLinkDecisionRoutesInternalReferencesAndKeepsSafeExternalGrammar() {
        let page = URL(string: "michi://page/page-reference?block=source-body")!
        XCTAssertEqual(NativeMichiReference.linkDecision(for: page, allowInternal: true), .open(.page(id: "page-reference", blockID: "source-body")))
        XCTAssertEqual(NativeMichiReference.linkDecision(for: page, allowInternal: false), .discard)
        XCTAssertEqual(NativeMichiReference.linkDecision(for: URL(string: "https://example.com/docs")!, allowInternal: true), .system)
        XCTAssertEqual(NativeMichiReference.linkDecision(for: URL(string: "javascript:alert(1)")!, allowInternal: true), .discard)
        XCTAssertEqual(NativeMichiReference.linkDecision(for: URL(string: "michi://thread/x")!, allowInternal: true), .discard)
    }

    func testDirectlyConstructedCasesAreValidatedBeforeResolution() {
        XCTAssertFalse(NativeMichiReference.node(id: "../foreign", messageID: nil).isValid)
        XCTAssertFalse(NativeMichiReference.page(id: "p", blockID: "").isValid)
        XCTAssertFalse(NativeMichiReference.source(nodeID: "n", turnID: "", assistantID: "a").isValid)
        XCTAssertFalse(NativeMichiReference.source(nodeID: "n", turnID: String(repeating: "a", count: 201), assistantID: "a").isValid)
    }
}
