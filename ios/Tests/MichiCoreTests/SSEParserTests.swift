import XCTest
@testable import MichiCore

final class SSEParserTests: XCTestCase {
    private func parse(_ chunks: [String], parser: SSEParser = SSEParser()) throws -> [SSEEvent] {
        var parser = parser
        return try chunks.flatMap { try parser.feed(Array($0.utf8)) }
    }

    private func parseBytewise(_ text: String) throws -> [SSEEvent] {
        var parser = SSEParser()
        return try text.utf8.flatMap { try parser.feed([$0]) }
    }

    func testDispatchesAJSONEventOnABlankLine() throws {
        let events = try parse(["event: chunk\ndata: {\"text\":\"hi\",\"seq\":3}\n\n"])
        XCTAssertEqual(events, [SSEEvent(event: "chunk", data: ["text": "hi", "seq": 3])])
    }

    func testAcceptsCRLFAndCRLineEndings() throws {
        let events = try parse(["event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r"])
        XCTAssertEqual(events.map(\.event), ["a", "b"])
        XCTAssertEqual(events.map(\.data), [.number(1), .number(2)])
    }

    func testCRLFSplitAcrossChunksIsOneLineBreak() throws {
        let events = try parse(["data: 1\r", "\ndata: 2\r", "\n\r", "\n"])
        XCTAssertEqual(events, [SSEEvent(event: "message", data: .string("1\n2"))])
    }

    func testMultiByteCharactersSplitAcrossChunks() throws {
        let text = "héllo 👋🏽 世界"
        let events = try parseBytewise("event: chunk\ndata: {\"text\":\"\(text)\"}\n\n")
        XCTAssertEqual(events.first?.data["text"].stringValue, text)
        XCTAssertEqual(events.count, 1)
    }

    func testCommentsAndKeepalivesAreSkipped() throws {
        let events = try parse([": keepalive\n\n", ":ping\n", "event: chunk\n: inline comment\ndata: {}\n\n"])
        XCTAssertEqual(events, [SSEEvent(event: "chunk", data: [:])])
    }

    func testDataLinesJoinWithNewlines() throws {
        let json = try parse(["event: tool_call\ndata: {\"toolCallId\":\n", "data: \"tc1\"}\n\n"])
        XCTAssertEqual(json.first?.data, ["toolCallId": "tc1"])

        let text = try parse(["data: line one\ndata:\ndata: line three\n\n"])
        XCTAssertEqual(text.first?.data, .string("line one\n\nline three"))
    }

    func testFieldParsingRules() throws {
        let events = try parse([
            "data:x\n\n",              // no space after the colon
            "data:  x\n\n",            // only one leading space is removed
            "data\n\n",                // a field with no colon has an empty value
            "event: lonely\n\n",       // no data: not dispatched, and the type resets
            "unknown: field\ndata: 7\n\n",
        ])
        XCTAssertEqual(events, [
            SSEEvent(event: "message", data: .string("x")),
            SSEEvent(event: "message", data: .string(" x")),
            SSEEvent(event: "message", data: .string("")),
            SSEEvent(event: "message", data: .number(7)),
        ])
    }

    func testUnknownEventsAndRawPayloadsArePreserved() throws {
        let payload = #"{"turnId":"t1","seq":9,"future":{"list":[1,"two",null,false],"deep":{"x":1.5}}}"#
        let events = try parse(["event: brand_new_event\ndata: \(payload)\n\n", "event: plain\ndata: not json\n\n"])

        XCTAssertEqual(events[0].event, "brand_new_event")
        XCTAssertEqual(events[0].data, try JSONValue.parse(payload))
        XCTAssertEqual(events[0].data["future"]["deep"]["x"].doubleValue, 1.5)
        XCTAssertEqual(events[1], SSEEvent(event: "plain", data: .string("not json")))
    }

    func testAnUnterminatedTrailingEventIsNotDispatched() throws {
        var parser = SSEParser()
        XCTAssertEqual(try parser.feed(Array("data: 1\n\ndata: 2\n".utf8)).count, 1)
        XCTAssertEqual(try parser.feed(Array("\n".utf8)).map(\.data), [.number(2)])
        XCTAssertTrue(try parser.feed(Array("data: 3".utf8)).isEmpty)
    }

    func testLineLengthIsBounded() {
        var parser = SSEParser(maxLineBytes: 8)
        XCTAssertNoThrow(try parser.feed(Array("data: 1\n\n".utf8)))
        XCTAssertThrowsError(try parser.feed(Array("data: 123456789".utf8))) { error in
            XCTAssertEqual((error as? MichiAPIError)?.code, MichiAPIError.Code.streamLimitExceeded)
            XCTAssertNil((error as? MichiAPIError)?.statusCode)
        }
    }

    func testEventSizeIsBounded() {
        var parser = SSEParser(maxLineBytes: 64, maxEventBytes: 10)
        XCTAssertThrowsError(try parser.feed(Array("data: 12345\ndata: 12345\n\n".utf8))) { error in
            XCTAssertEqual((error as? MichiAPIError)?.code, MichiAPIError.Code.streamLimitExceeded)
        }
    }

    func testALargeEventIsFollowedByOrdinaryEvents() throws {
        var parser = SSEParser()
        let big = String(repeating: "x", count: 200_000)
        let events = try parser.feed(Array("data: \(big)\n\n".utf8) + Array("data: 1\n\n".utf8))
        XCTAssertEqual(events.map(\.data), [.string(big), .number(1)])
    }

    func testByteOrderMarkIsStrippedOnlyAtTheStart() throws {
        let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
        var parser = SSEParser()
        var events = try parser.feed(bom.prefix(2))
        events += try parser.feed(bom.suffix(1) + Array("data: 1\n\n".utf8))
        events += try parser.feed(bom + Array("data: 2\n\n".utf8))
        XCTAssertEqual(events.map(\.data), [.number(1)])
    }

    func testIDAndRetryFields() throws {
        var parser = SSEParser()
        let events = try parser.feed(Array("id: 42\nretry: 1500\ndata: 1\n\ndata: 2\n\nid\nretry: soon\ndata: 3\n\n".utf8))
        XCTAssertEqual(events.map(\.id), ["42", "42", nil])
        XCTAssertEqual(parser.retryMilliseconds, 1500)
        XCTAssertEqual(parser.lastEventID, "")
    }

    func testInvalidUTF8IsReplacedRatherThanFatal() throws {
        var parser = SSEParser()
        let events = try parser.feed(Array("data: a".utf8) + [0xFF, 0xFE] + Array("b\n\n".utf8))
        XCTAssertEqual(events.first?.data, .string("a\u{FFFD}\u{FFFD}b"))
    }
}
