import XCTest
@testable import MichiCore

final class AssistantTextTests: XCTestCase {
    func testStreamingMetadataNeverLeaks() {
        let answer = "A useful answer. [TITLE: Internal title]"
        for length in 18...answer.count {
            let prefix = String(answer.prefix(length))
            XCTAssertEqual(AssistantText.visible(prefix), "A useful answer.")
        }
    }
    func testOrdinaryLinksAndCodeRemainVisible() {
        let text = "Read [documentation](https://example.com). Use array[0]."
        XCTAssertEqual(AssistantText.visible(text), text)
    }
    func testMultipleMetadataFieldsAndUnicode() {
        XCTAssertEqual(AssistantText.visible("你好。\n[TITLE: 标题]\n[FOLLOW-UP 1/3: 下一步]\n[BRANCH-OVERVIEW: 内容]"), "你好。")
    }
    func testJSONPreservesUnknownFieldsAndNulls() throws {
        let value = try JSONValue.parse(#"{"id":"x","nullable":null,"flag":false,"future":{"n":12},"items":[true,1,"x"]}"#)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)), value)
        XCTAssertTrue(value["nullable"].isNull)
        XCTAssertEqual(value["future"]["n"].intValue, 12)
    }
}
