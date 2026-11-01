import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class NativePageSourceTests: XCTestCase {
    private let a: JSONValue = ["nodeId": "a", "turnId": "ta", "assistantId": "ma"]
    private let b: JSONValue = ["nodeId": "b", "turnId": "tb", "assistantId": "mb"]
    private func entry(_ text: String, _ sources: [JSONValue]) -> JSONValue { ["text": .string(text), "sources": .array(sources)] }
    private func markdown(_ text: String, _ entries: [JSONValue], whole: [JSONValue] = []) -> JSONValue {
        ["id": "block", "rev": 1, "type": "markdown", "text": .string(text), "segmentSources": .array(entries), "sources": .array(whole)]
    }

    func testSplitterMatchesElevenFixturesExecutedByTheActualSharedTypeScript() throws {
        let fixtures = try JSONValue.parse(sharedSplitterFixtures).arrayValue
        XCTAssertEqual(fixtures.count, 11)
        for fixture in fixtures {
            let result = try XCTUnwrap(NativePageMarkdownSources.split(fixture["input"].stringValue))
            let actual = JSONValue.array(result.map { ["index": .number(Double($0.index)), "kind": .string($0.kind.rawValue), "text": .string($0.text)] })
            XCTAssertEqual(actual, fixture["expected"], fixture["input"].stringValue)
            // Check bytes as well; Swift's JSON/String equality is Unicode-normalizing.
            XCTAssertEqual(result.map { Array($0.text.utf16) }, fixture["expected"].arrayValue.map { Array($0["text"].stringValue.utf16) })
        }
    }

    func testSourceRequiresClosedCompleteTripleAndUTF16Length() throws {
        let source = try XCTUnwrap(NativePageSource(a))
        XCTAssertEqual(source.reference, .source(nodeID: "a", turnID: "ta", assistantID: "ma"))
        for bad in [JSONValue.null, [], ["nodeId": "a"], a.merging(["kind": "chat"]), a.merging(["nodeId": ""]), a.merging(["turnId": 1]), a.merging(["assistantId": .null]), a.merging(["nodeId": .string(String(repeating: "😀", count: 101))])] {
            XCTAssertNil(NativePageSource(bad), bad.prettyPrinted)
        }
        let exact = a.merging(["nodeId": .string(String(repeating: "😀", count: 100))])
        XCTAssertNotNil(NativePageSource(exact))
        XCTAssertEqual(NativePageSource(a.merging(["nodeId": " a "]))?.nodeID, " a ")
        XCTAssertNotNil(NativePageSource.parseList(.array(Array(repeating: a, count: 100))))
        XCTAssertNil(NativePageSource.parseList(.array(Array(repeating: a, count: 101))))
        XCTAssertNil(NativePageSource.parseList(.array([a, ["nodeId": "partial"]])))
    }

    func testTupleDedupePreservesOrderSeparatorsAndCanonicallyDistinctOpaqueIDs() throws {
        let first = try XCTUnwrap(NativePageSource(a))
        let second = try XCTUnwrap(NativePageSource(b))
        XCTAssertEqual(NativePageSource.unique([first, first, second, first]), [first, second])
        let composed = try XCTUnwrap(NativePageSource(a.merging(["nodeId": "é"])))
        let decomposed = try XCTUnwrap(NativePageSource(a.merging(["nodeId": "e\u{0301}"])))
        XCTAssertNotEqual(composed, decomposed)
        XCTAssertEqual(Set([composed, decomposed]).count, 2)
        let left = try XCTUnwrap(NativePageSource(a.merging(["nodeId": "a:b", "turnId": "c"])))
        let right = try XCTUnwrap(NativePageSource(a.merging(["nodeId": "a", "turnId": "b:c"])))
        XCTAssertNotEqual(left.id, right.id)
    }

    func testExactAnchorsRejectReorderingEditingAndUnicodeNormalization() throws {
        let entries = JSONValue.array([entry("- Alpha", [a]), entry("- Beta", [b])])
        XCTAssertNotNil(NativePageMarkdownSources.parse(text: "- Alpha\n- Beta", value: entries))
        XCTAssertNil(NativePageMarkdownSources.parse(text: "- Beta\n- Alpha", value: entries))
        XCTAssertNil(NativePageMarkdownSources.parse(text: "- Alpha changed\n- Beta", value: entries))
        XCTAssertNil(NativePageMarkdownSources.parse(text: "- Alpha \n- Beta", value: entries))
        XCTAssertNil(NativePageMarkdownSources.parse(text: "é", value: .array([entry("e\u{0301}", [a])])))
        XCTAssertNotNil(NativePageMarkdownSources.parse(text: "# Header\r\n\r\nBody", value: .array([entry("# Header", []), entry("Body", [a])])))
    }

    func testAllSegmentMetadataMustValidateBeforeAnyPassageIsShown() {
        for value: JSONValue in [
            .null, .object([:]), .array([entry("First", [a])]),
            .array([entry("First", [a]), entry("Second", [b]).merging(["extra": true])]),
            .array([entry("First", [a]), ["text": "Second", "sources": .null]]),
            .array([entry("First", [a]), entry("Second", [b.merging(["kind": "helper"])])]),
            .array([entry("First", [a]), entry("Second", [b.merging(["assistantId": ""])])])
        ] {
            XCTAssertNil(NativePageMarkdownSources.parse(text: "First\n\nSecond", value: value))
        }
        let tooMany = JSONValue.array([entry("First", Array(repeating: a, count: 51)), entry("Second", Array(repeating: b, count: 50))])
        XCTAssertNil(NativePageMarkdownSources.parse(text: "First\n\nSecond", value: tooMany))
    }

    func testExplicitlyUncitedPassageDoesNotInheritWholeBlockSource() throws {
        let block = markdown("- Alpha\n- Uncited", [entry("- Alpha", [a, a]), entry("- Uncited", [])], whole: [b, b])
        let provenance = NativePageProvenance(block: block)
        XCTAssertEqual(provenance.groups.count, 2)
        XCTAssertEqual(provenance.groups[0].label, "Passage 1")
        XCTAssertEqual(provenance.groups[0].passage, "- Alpha")
        XCTAssertEqual(provenance.groups[0].sources, [try XCTUnwrap(NativePageSource(a))])
        XCTAssertEqual(provenance.groups[1].label, "Entire block")
        XCTAssertNil(provenance.groups[1].passage)
        XCTAssertEqual(provenance.groups[1].sources, [try XCTUnwrap(NativePageSource(b))])
        XCTAssertEqual(provenance.sourceCount, 2)
        XCTAssertFalse(provenance.unavailablePassages)
    }

    func testStalePassagesDisappearButValidWholeBlockProvenanceRemains() throws {
        let stale = markdown("- Beta\n- Alpha", [entry("- Alpha", [a]), entry("- Beta", [b])], whole: [a])
        let provenance = NativePageProvenance(block: stale)
        XCTAssertTrue(provenance.unavailablePassages)
        XCTAssertEqual(provenance.groups.map(\.label), ["Entire block"])
        XCTAssertEqual(provenance.groups[0].sources, [try XCTUnwrap(NativePageSource(a))])
        let withoutWhole = NativePageProvenance(block: stale.merging(["sources": []]))
        XCTAssertTrue(withoutWhole.isVisible)
        XCTAssertTrue(withoutWhole.groups.isEmpty)
        XCTAssertEqual(withoutWhole.sourceCount, 0)
    }

    func testLiveSnapshotReplacementRecomputesSourceAndNeverKeepsOldResolvedPassage() throws {
        let first = markdown("First", [entry("First", [a])])
        let second = markdown("Second", [entry("Second", [b])]).merging(["rev": 2])
        XCTAssertEqual(NativePageProvenance(block: first).groups.first?.sources.first?.nodeID, "a")
        XCTAssertEqual(NativePageProvenance(block: second).groups.first?.sources.first?.nodeID, "b")
        XCTAssertEqual(NativePageProvenance(block: second).groups.first?.passage, "Second")
        XCTAssertFalse(NativePageProvenance(block: ["type": "markdown", "text": "No metadata"]).isVisible)
    }

    func testContainersCollectOnlyValidatedDescendantPassagesWithDistinctPaths() {
        let child = markdown("Text", [entry("Text", [a])])
        let stale = markdown("Changed", [entry("Old", [b])])
        let block: JSONValue = ["type": "grid", "regions": [
            ["id": "r1", "blocks": [["type": "columns", "columns": [[child], [["type": "toggle", "blocks": [stale]]]]]]],
            ["id": "r2", "blocks": [["type": "tabs", "tabs": [["label": "One", "blocks": [child]]]]]]
        ]]
        let provenance = NativePageProvenance(block: block)
        XCTAssertEqual(provenance.groups.count, 2)
        XCTAssertEqual(provenance.sourceCount, 1)
        XCTAssertTrue(provenance.unavailablePassages)
        XCTAssertNotEqual(provenance.groups[0].id, provenance.groups[1].id)
        XCTAssertTrue(provenance.groups[0].label.contains("Region 1"))
        XCTAssertTrue(provenance.groups[1].label.contains("Tab 1"))
        XCTAssertTrue(provenance.groups.allSatisfy { $0.sources.first?.nodeID == "a" })
    }

    func testInvalidWholeBlockMetadataIsNotPartiallyPresented() {
        let block: JSONValue = ["type": "heading", "text": "Title", "sources": [a, ["nodeId": "incomplete"]]]
        let provenance = NativePageProvenance(block: block)
        XCTAssertTrue(provenance.invalidSources)
        XCTAssertTrue(provenance.groups.isEmpty)
    }

    func testBoundsStopOversizedMarkdownAndNestedMenus() {
        XCTAssertNil(NativePageMarkdownSources.split(String(repeating: "x", count: 32_769)))
        XCTAssertNil(NativePageMarkdownSources.split(String(repeating: "\n", count: 2_000)))
        XCTAssertNil(NativePageMarkdownSources.split(String(repeating: "# H\n", count: 101)))
        XCTAssertEqual(NativePageMarkdownSources.split(String(repeating: "# H\n", count: 100))?.count, 100)
        var deep: JSONValue = ["type": "heading", "text": "Deep", "sources": [a]]
        for _ in 0..<7 { deep = ["type": "toggle", "blocks": .array([deep])] }
        XCTAssertTrue(NativePageProvenance(block: deep).limited)
        XCTAssertTrue(NativePageProvenance(block: deep).groups.isEmpty)
        let wide: JSONValue = ["type": "columns", "columns": .array(Array(repeating: .array([]), count: 122))]
        XCTAssertTrue(NativePageProvenance(block: wide).limited)
        let group: JSONValue = ["type": "heading", "text": "H", "sources": [a]]
        let many: JSONValue = ["type": "toggle", "blocks": .array(Array(repeating: group, count: 120))]
        XCTAssertEqual(NativePageProvenance(block: many).groups.count, 100)
        XCTAssertTrue(NativePageProvenance(block: many).limited)
    }

    func testChatHelperAndHumanChangesHaveAccurateReadOnlySourceTargets() throws {
        let chat = NativePageChangeProvenance(source: a.merging(["kind": "chat"]))
        XCTAssertEqual(chat.label, "Chat")
        XCTAssertEqual(chat.links.first?.reference, .source(nodeID: "a", turnID: "ta", assistantID: "ma"))
        XCTAssertEqual(NativePageChangeProvenance(source: b.merging(["kind": "helper"])).label, "Page helper")
        let user = NativePageChangeProvenance(source: ["kind": "user"])
        XCTAssertEqual(user.label, "Changed by you")
        XCTAssertTrue(user.links.isEmpty)
        XCTAssertFalse(user.unavailable)
        XCTAssertTrue(NativePageChangeProvenance(source: ["kind": "user", "nodeId": "a"]).unavailable)
    }

    func testMaintenanceKeepsWriterAndExactUserMessageEvidenceDistinct() throws {
        let source = a.merging(["kind": "maintenance", "jobId": "job", "runId": "run", "read": ["kind": "conversations", "count": 4], "evidence": .array([b, b, b.merging(["messageId": "user-msg"])])])
        let provenance = NativePageChangeProvenance(source: source)
        XCTAssertFalse(provenance.unavailable)
        XCTAssertEqual(provenance.readSummary, "Read 4 conversations")
        XCTAssertEqual(provenance.links.count, 3)
        XCTAssertEqual(provenance.links[0].label, "Open maintenance run")
        XCTAssertEqual(provenance.links[0].reference, .source(nodeID: "a", turnID: "ta", assistantID: "ma"))
        XCTAssertEqual(provenance.links[1].reference, .source(nodeID: "b", turnID: "tb", assistantID: "mb"))
        XCTAssertEqual(provenance.links[2].reference, .node(id: "b", messageID: "user-msg"))
        XCTAssertEqual(provenance.links[2].source.assistantID, "mb")
        XCTAssertTrue(provenance.links[1].label.hasPrefix("Cited message"))
    }

    func testLegacyMaintenanceReadSetDoesNotClaimEveryConversationWasCited() {
        let source = a.merging(["kind": "maintenance", "jobId": "job", "runId": "run", "evidence": .array([a, b])])
        let provenance = NativePageChangeProvenance(source: source)
        XCTAssertEqual(provenance.readSummary, "Read 2 conversations")
        XCTAssertEqual(provenance.links.dropFirst().map(\.label), ["Read message 1", "Read message 2"])
        let runOnly = NativePageChangeProvenance(source: source.merging(["evidence": []]))
        XCTAssertNil(runOnly.readSummary)
        XCTAssertEqual(runOnly.links.count, 1)
    }

    func testChangeSourceValidationIsClosedBoundedAndAllOrNothing() {
        let valid = a.merging(["kind": "maintenance", "jobId": "job", "runId": "run", "evidence": .array([b])])
        let invalid = [JSONValue.null, a.merging(["kind": "chat", "extra": true]), valid.merging(["jobId": ""]), valid.merging(["runId": .null]), valid.merging(["evidence": .array(Array(repeating: b, count: 101))]), valid.merging(["evidence": .array([b, b.merging(["messageId": ""])])]), valid.merging(["read": ["kind": "conversations", "count": -1]]), valid.merging(["read": ["kind": "conversations", "count": 100001]]), valid.merging(["read": ["kind": "unknown", "count": 2]]), valid.merging(["read": ["kind": "conversations", "count": .number(1.5)]]), valid.merging(["read": ["kind": "conversations", "count": 2, "extra": true]])]
        for source in invalid {
            let result = NativePageChangeProvenance(source: source)
            XCTAssertTrue(result.unavailable, source.prettyPrinted)
            XCTAssertTrue(result.links.isEmpty)
        }
    }

    func testComponentSourcesAreDescribedWithoutInventingConversationTargets() {
        let page: JSONValue = ["kind": "component", "componentId": "component", "version": 3, "pageId": "page", "blockId": "block"]
        let database: JSONValue = ["kind": "component", "componentId": "component", "version": 4, "databaseId": "db", "viewId": "view"]
        XCTAssertEqual(NativePageChangeProvenance(source: page).label, "Page component · v3")
        XCTAssertEqual(NativePageChangeProvenance(source: database).label, "Custom database view · v4")
        XCTAssertTrue(NativePageChangeProvenance(source: page).links.isEmpty)
        XCTAssertTrue(NativePageChangeProvenance(source: page.merging(["databaseId": "db"])).unavailable)
        XCTAssertTrue(NativePageChangeProvenance(source: page.merging(["version": 0])).unavailable)
    }
}

// Generated by Node 24 executing the repository's shared/src/pages/markdownSegments.ts,
// without copying a second splitter into the test. Keep exact source text/UTF-16 anchors.
private let sharedSplitterFixtures = #"""
[
  {
    "input": "# Heading\n\nFirst paragraph\nsecond line\n\n- One\n  - Child\n\n  continued\n- Two\n\n```js\nx();\n```\n\n| A | B |\n|---|---|\n| x | y |\n\n> Quoted\n> second line",
    "expected": [
      {
        "index": 0,
        "kind": "heading",
        "text": "# Heading"
      },
      {
        "index": 1,
        "kind": "paragraph",
        "text": "First paragraph\nsecond line"
      },
      {
        "index": 2,
        "kind": "list-item",
        "text": "- One\n  - Child\n\n  continued"
      },
      {
        "index": 3,
        "kind": "list-item",
        "text": "- Two"
      },
      {
        "index": 4,
        "kind": "code",
        "text": "```js\nx();\n```"
      },
      {
        "index": 5,
        "kind": "table",
        "text": "| A | B |\n|---|---|\n| x | y |"
      },
      {
        "index": 6,
        "kind": "quote",
        "text": "> Quoted\n> second line"
      }
    ]
  },
  {
    "input": "1. Parent\n   ```md\n# Not a heading\n- Not an item\n   ```\n   continuation\n2) Next\n\nAfter",
    "expected": [
      {
        "index": 0,
        "kind": "list-item",
        "text": "1. Parent\n   ```md\n# Not a heading\n- Not an item\n   ```\n   continuation"
      },
      {
        "index": 1,
        "kind": "list-item",
        "text": "2) Next"
      },
      {
        "index": 2,
        "kind": "paragraph",
        "text": "After"
      }
    ]
  },
  {
    "input": "- First\ncontinued\n- Second\n\n> Quote\ncontinued quote",
    "expected": [
      {
        "index": 0,
        "kind": "list-item",
        "text": "- First"
      },
      {
        "index": 1,
        "kind": "paragraph",
        "text": "continued"
      },
      {
        "index": 2,
        "kind": "list-item",
        "text": "- Second"
      },
      {
        "index": 3,
        "kind": "quote",
        "text": "> Quote"
      },
      {
        "index": 4,
        "kind": "paragraph",
        "text": "continued quote"
      }
    ]
  },
  {
    "input": "A | B\n--- | ---\n| x | y |\n\n[Docs][docs]\n\n[docs]: https://example.com\n  \"Title\"",
    "expected": [
      {
        "index": 0,
        "kind": "paragraph",
        "text": "A | B\n--- | ---"
      },
      {
        "index": 1,
        "kind": "table",
        "text": "| x | y |"
      },
      {
        "index": 2,
        "kind": "paragraph",
        "text": "[Docs][docs]"
      },
      {
        "index": 3,
        "kind": "paragraph",
        "text": "[docs]: https://example.com\n  \"Title\""
      }
    ]
  },
  {
    "input": "~~~code\n```\n# inside\n~~~~\nAfter",
    "expected": [
      {
        "index": 0,
        "kind": "code",
        "text": "~~~code\n```\n# inside\n~~~~"
      },
      {
        "index": 1,
        "kind": "paragraph",
        "text": "After"
      }
    ]
  },
  {
    "input": "```bad`info\nnot fenced\n\n    # Four spaces\n    - Not top-level\n",
    "expected": [
      {
        "index": 0,
        "kind": "paragraph",
        "text": "```bad`info\nnot fenced"
      },
      {
        "index": 1,
        "kind": "paragraph",
        "text": "    # Four spaces\n    - Not top-level"
      }
    ]
  },
  {
    "input": "Paragraph\r\nnext\r\n\r\n# Header\r\n\r\n- Item\r\n\tcontinued\r\n",
    "expected": [
      {
        "index": 0,
        "kind": "paragraph",
        "text": "Paragraph\nnext"
      },
      {
        "index": 1,
        "kind": "heading",
        "text": "# Header"
      },
      {
        "index": 2,
        "kind": "list-item",
        "text": "- Item\n\tcontinued"
      }
    ]
  },
  {
    "input": "  - Item\n   too shallow\n  - Next\n\n```\nunclosed\n\n",
    "expected": [
      {
        "index": 0,
        "kind": "list-item",
        "text": "  - Item"
      },
      {
        "index": 1,
        "kind": "paragraph",
        "text": "   too shallow"
      },
      {
        "index": 2,
        "kind": "list-item",
        "text": "  - Next"
      },
      {
        "index": 3,
        "kind": "code",
        "text": "```\nunclosed"
      }
    ]
  },
  {
    "input": "﻿\n#\n## Title\n-　Item\n\nnext",
    "expected": [
      {
        "index": 0,
        "kind": "heading",
        "text": "#"
      },
      {
        "index": 1,
        "kind": "heading",
        "text": "## Title"
      },
      {
        "index": 2,
        "kind": "list-item",
        "text": "-　Item"
      },
      {
        "index": 3,
        "kind": "paragraph",
        "text": "\nnext"
      }
    ]
  },
  {
    "input": "١. Not ASCII numbering\n1) ASCII\n\n## é\n\n$$\nx+y\n$$",
    "expected": [
      {
        "index": 0,
        "kind": "paragraph",
        "text": "١. Not ASCII numbering"
      },
      {
        "index": 1,
        "kind": "list-item",
        "text": "1) ASCII"
      },
      {
        "index": 2,
        "kind": "heading",
        "text": "## é"
      },
      {
        "index": 3,
        "kind": "paragraph",
        "text": "$$\nx+y\n$$"
      }
    ]
  },
  {
    "input": "\n\n",
    "expected": []
  }
]
"""#
