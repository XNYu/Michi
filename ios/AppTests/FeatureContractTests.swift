import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class FeatureContractTests: XCTestCase {
    private let columns: [JSONValue] = [
        ["id": "name", "name": "Name", "type": "text"],
        ["id": "count", "name": "Count", "type": "number"],
        ["id": "progress", "name": "Progress", "type": "progress"],
        ["id": "checked", "name": "Checked", "type": "checkbox"],
        ["id": "date", "name": "Date", "type": "date"],
        ["id": "tags", "name": "Tags", "type": "multi"],
        ["id": "threads", "name": "Threads", "type": "threads"],
        ["id": "nullable", "name": "Nullable", "type": "text"],
        ["id": "computed", "name": "Computed", "type": "text", "editable": false],
    ]

    private var original: JSONValue {
        [
            "id": "row-1", "rev": 7, "body": "Original notes",
            "values": [
                "name": "Original", "count": 12, "progress": .number(0.375),
                "checked": true, "date": ["start": "2026-10-01", "end": "2026-10-31"],
                "tags": ["One, with a comma", "Two"], "threads": ["thread-a", "thread-b"],
                "nullable": .null, "computed": "Derived",
            ],
            "edited": ["name": 123], "bodyEditedAt": 456,
        ]
    }

    private func drafts(for row: JSONValue) -> [String: String] {
        Dictionary(uniqueKeysWithValues: columns.map { column in
            (column.id, featureCellDraft(row["values"][column.id], type: column["type"].stringValue))
        })
    }

    func testEditingOneCellDoesNotClaimOrFlattenOtherCells() throws {
        let row = original
        var draft = drafts(for: row)
        draft["name"] = "Renamed"
        let operation = try XCTUnwrap(featureDatabaseRowUpdate(baseline: row, columns: columns, drafts: draft, body: row["body"].stringValue))
        XCTAssertEqual(operation, ["op": "row.update", "id": "row-1", "expectRev": 7, "values": ["name": "Renamed"]])
        // Simulate the backend's merge: arrays, dates, nulls, and metadata remain byte-for-byte values.
        let merged = row["values"].merging(operation["values"].objectValue)
        for key in ["date", "tags", "threads", "nullable", "progress", "computed"] {
            XCTAssertEqual(merged[key], row["values"][key], key)
        }
        XCTAssertNil(operation.objectValue["body"])
        XCTAssertNil(operation.objectValue["edited"])
        XCTAssertNil(operation.objectValue["bodyEditedAt"])
    }

    func testUnchangedDraftDoesNotSubmitOwnershipChanges() throws {
        XCTAssertNil(try featureDatabaseRowUpdate(baseline: original, columns: columns, drafts: drafts(for: original), body: "Original notes"))
        var formatted = drafts(for: original)
        formatted["count"] = "12.0"
        XCTAssertNil(try featureDatabaseRowUpdate(baseline: original, columns: columns, drafts: formatted, body: "Original notes"))
    }

    func testUnsupportedAndReadOnlyColumnsNeverAppearInMutation() throws {
        var draft = drafts(for: original)
        for id in ["computed", "date", "tags", "threads"] { draft[id] = "Should not be written" }
        XCTAssertNil(try featureDatabaseRowUpdate(baseline: original, columns: columns, drafts: draft, body: "Original notes"))
        for column in columns where ["computed", "date", "tags", "threads"].contains(column.id) {
            XCTAssertFalse(featureCanEditColumn(column))
        }
    }

    func testClearingNotesExplicitlySendsEmptyBodyAndOriginalRevision() throws {
        let operation = try XCTUnwrap(featureDatabaseRowUpdate(baseline: original, columns: columns, drafts: drafts(for: original), body: ""))
        XCTAssertEqual(operation, ["op": "row.update", "id": "row-1", "expectRev": 7, "body": ""])
        XCTAssertNil(operation.objectValue["values"])
    }

    func testTypedNumberProgressAndCheckboxChanges() throws {
        var draft = drafts(for: original)
        draft["count"] = "13.5"
        draft["progress"] = "62.5"
        draft["checked"] = "false"
        let operation = try XCTUnwrap(featureDatabaseRowUpdate(baseline: original, columns: columns, drafts: draft, body: "Original notes"))
        XCTAssertEqual(operation["values"], ["count": .number(13.5), "progress": .number(0.625), "checked": false])
        draft["count"] = " "
        let cleared = try XCTUnwrap(featureDatabaseRowUpdate(baseline: original, columns: columns, drafts: draft, body: "Original notes"))
        XCTAssertEqual(cleared["values"].objectValue["count"], .some(.null))
    }

    func testInvalidNumbersRejectTheWholeEdit() throws {
        for bad in ["not a number", "nan", "inf", "1e999"] {
            var draft = drafts(for: original)
            draft["count"] = bad
            draft["name"] = "Should not partially save"
            XCTAssertThrowsError(try featureDatabaseRowUpdate(baseline: original, columns: columns, drafts: draft, body: "Original notes"), bad)
        }
        XCTAssertThrowsError(try featureParseCell("101", type: "progress"))
        XCTAssertThrowsError(try featureParseCell("-1", type: "progress"))
    }

    func testLargeNumbersRenderWithoutIntegerOverflow() {
        XCTAssertFalse(featureCellDraft(.number(1e100), type: "number").isEmpty)
        XCTAssertFalse(featureCellText(.number(1e100), type: "number").isEmpty)
        XCTAssertEqual(featureCellText(original["values"]["date"], type: "date"), "2026-10-01 – 2026-10-31")
    }

    func testMissingRevisionIsRejectedBeforeNetworkMutation() {
        let invalid: JSONValue = ["id": "row-1", "values": ["name": "Old"]]
        XCTAssertThrowsError(try featureDatabaseRowUpdate(baseline: invalid, columns: columns, drafts: ["name": "New"], body: ""))
    }
}
