import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class DatabaseLayoutTests: XCTestCase {
    private let utc = TimeZone(secondsFromGMT: 0)!
    private let dateColumn: JSONValue = ["id": "dates", "name": "Dates", "type": "date"]
    private func row(_ date: JSONValue, id: String = "r1") -> JSONValue { ["id": .string(id), "rev": 7, "values": ["dates": date, "other": "Keep", "title": "Record"], "body": "Keep body"] }

    func testCivilDateValidatesGregorianLeapYearsAndEveryComponent() {
        for value in ["2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31"] { XCTAssertNotNil(NativeDatabaseDay(value), value) }
        for value in ["1900-02-29", "2100-02-29", "2025-02-29", "2024-04-31", "0000-01-01", "2024-13-01", "2024-01-00", "2024-1-01", "２０２４-01-01", "2024-01-01\n"] { XCTAssertNil(NativeDatabaseDay(value), value) }
    }
    func testCivilOrdinalRoundTripsAndIsBounded() {
        for text in ["0001-01-01", "1500-03-01", "1582-10-04", "1582-10-15", "1900-03-01", "2000-02-29", "2024-12-31", "9999-12-31"] {
            let day = NativeDatabaseDay(text)!
            XCTAssertEqual(NativeDatabaseDay(ordinal: day.ordinal), day)
        }
        XCTAssertEqual(NativeDatabaseDay("2024-02-28")!.adding(days: 2)?.key, "2024-03-01")
        XCTAssertEqual(NativeDatabaseDay("2023-12-31")!.adding(days: 1)?.key, "2024-01-01")
        XCTAssertNil(NativeDatabaseDay("0001-01-01")!.adding(days: -1))
        XCTAssertNil(NativeDatabaseDay("9999-12-31")!.adding(days: 1))
        XCTAssertNil(NativeDatabaseDay("2024-01-01")!.adding(days: Int.max))
    }
    func testPlainDayNeverChangesAcrossTimeZones() {
        for zone in ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo", "Pacific/Apia"] {
            XCTAssertEqual(NativeDatabaseDates.day("2024-02-29", timeZone: TimeZone(identifier: zone)!)?.key, "2024-02-29")
        }
        // This civil date did not have a local midnight in Apia, but remains a valid date-only value.
        XCTAssertEqual(NativeDatabaseDates.day("2011-12-30", timeZone: TimeZone(identifier: "Pacific/Apia")!)?.key, "2011-12-30")
    }
    func testISOTimestampsMapToTheSelectedLocalDay() {
        let losAngeles = TimeZone(identifier: "America/Los_Angeles")!
        XCTAssertEqual(NativeDatabaseDates.day("2024-03-10T03:30:00Z", timeZone: losAngeles)?.key, "2024-03-09")
        XCTAssertEqual(NativeDatabaseDates.day("2024-03-10T03:30:00.123Z", timeZone: losAngeles)?.key, "2024-03-09")
        XCTAssertEqual(NativeDatabaseDates.day("2024-03-10T23:30:00-07:00", timeZone: utc)?.key, "2024-03-11")
        XCTAssertEqual(NativeDatabaseDates.day("2024-03-10T12:30", timeZone: losAngeles)?.key, "2024-03-10")
        for text in ["2024-02-30T12:00:00Z", "2024-03-10T24:01:00Z", "2024-03-10T12:99:00Z", "2024-03-10T12:00:00+99:00", "not a date"] { XCTAssertNil(NativeDatabaseDates.day(text, timeZone: utc), text) }
        XCTAssertNil(NativeDatabaseDates.day("2024-03-10T02:30:00", timeZone: losAngeles))
    }
    func testPickerDateRoundTripUsesGregorianUTC() {
        for text in ["1970-01-01", "2024-03-10", "2024-11-03", "2024-12-31"] {
            let day = NativeDatabaseDay(text)!
            XCTAssertEqual(NativeDatabaseDay.at(day.pickerDate, timeZone: utc), day)
        }
    }
    func testSpanNormalizesReverseDatesAndRejectsInvalidEnds() {
        XCTAssertEqual(NativeDatabaseDates.span(["start": "2024-02-29", "end": "2024-02-01"], timeZone: utc), .init(start: NativeDatabaseDay("2024-02-01")!, end: NativeDatabaseDay("2024-02-29")!))
        XCTAssertEqual(NativeDatabaseDates.span("2024-03-04", timeZone: utc)?.start, NativeDatabaseDay("2024-03-04"))
        XCTAssertNil(NativeDatabaseDates.span(["start": "2024-02-01", "end": "2024-02-30"], timeZone: utc))
        XCTAssertNil(NativeDatabaseDates.span(.null, timeZone: utc))
    }
    func testCalendarIsMondayFirstAndOnlyShowsRangeStartInViewOrder() {
        let rows = [row(["start": "2024-02-29", "end": "2024-03-02"], id: "first"), row("2024-02-29", id: "second"), row("2024-01-31", id: "outside")]
        let days = NativeDatabaseLayout.month(year: 2024, month: 2, rows: rows, dateColumnID: "dates", today: NativeDatabaseDay("2024-02-29")!, timeZone: utc)
        XCTAssertEqual(days.count, 35); XCTAssertEqual(days.first?.id, "2024-01-29"); XCTAssertEqual(days.last?.id, "2024-03-03")
        XCTAssertEqual(days.first { $0.id == "2024-02-29" }?.rows.map(\.id), ["first", "second"])
        XCTAssertTrue(days.first { $0.id == "2024-02-29" }?.today == true)
        XCTAssertTrue(days.first { $0.id == "2024-01-31" }!.rows.isEmpty)
        XCTAssertTrue(days.first { $0.id == "2024-03-01" }!.rows.isEmpty)
        XCTAssertTrue(NativeDatabaseLayout.month(year: 2024, month: 13, rows: [], dateColumnID: "dates", today: NativeDatabaseDay("2024-02-29")!).isEmpty)
    }
    func testCalendarAlwaysBoundsMonthCells() {
        for month in 1...12 {
            let days = NativeDatabaseLayout.month(year: 2026, month: month, rows: [], dateColumnID: "dates", today: NativeDatabaseDay("2026-01-01")!)
            XCTAssertTrue((28...42).contains(days.count)); XCTAssertEqual(days.count % 7, 0)
            XCTAssertEqual(days.first!.date.weekdayMondayFirst, 0)
        }
    }
    func testMovePreservesRangeAcrossDSTAndOnlyChangesDateField() throws {
        let source = row(["start": "2024-03-09", "end": "2024-03-11"])
        let op = try XCTUnwrap(nativeDatabaseCalendarMoveOperation(row: source, column: dateColumn, to: "2024-11-02", timeZone: TimeZone(identifier: "America/Los_Angeles")!))
        XCTAssertEqual(op, ["op": "row.update", "id": "r1", "expectRev": 7, "values": ["dates": ["start": "2024-11-02", "end": "2024-11-04"]]])
        XCTAssertEqual(source["values"]["other"], "Keep"); XCTAssertEqual(source["body"], "Keep body")
    }
    func testMoveHandlesLeapDayAndYearBoundary() throws {
        let op = try nativeDatabaseCalendarMoveOperation(row: row(["start": "2024-02-28", "end": "2024-03-01"]), column: dateColumn, to: "2024-12-31", timeZone: utc)
        XCTAssertEqual(op?["values"]["dates"], ["start": "2024-12-31", "end": "2025-01-02"])
    }
    func testMoveKeepsReversedRangeOrientationLikeWebContract() throws {
        let op = try nativeDatabaseCalendarMoveOperation(row: row(["start": "2024-03-10", "end": "2024-03-08"]), column: dateColumn, to: "2024-04-10", timeZone: utc)
        XCTAssertEqual(op?["values"]["dates"], ["start": "2024-04-10", "end": "2024-04-08"])
    }
    func testMovingTimestampConvertsToDaysButSameDayIsNoOp() throws {
        let source = row(["start": "2024-03-10T23:30:00Z", "end": "2024-03-12T23:30:00Z"])
        XCTAssertNil(try nativeDatabaseCalendarMoveOperation(row: source, column: dateColumn, to: "2024-03-10", timeZone: utc))
        let op = try nativeDatabaseCalendarMoveOperation(row: source, column: dateColumn, to: "2024-04-01", timeZone: utc)
        XCTAssertEqual(op?["values"]["dates"], ["start": "2024-04-01", "end": "2024-04-03"])
        XCTAssertEqual(try nativeDatabaseCalendarMoveOperation(row: row(.null), column: dateColumn, to: "2024-04-01")?["values"]["dates"], ["start": "2024-04-01"])
    }
    func testMoveRejectsLockedBuiltinsInvalidDatesMissingRevisionAndOverflow() {
        let source = row(["start": "2024-03-01", "end": "2024-03-02"])
        for column in [dateColumn.merging(["editable": false]), dateColumn.merging(["builtin": true]), dateColumn.merging(["type": "text"])] {
            XCTAssertThrowsError(try nativeDatabaseCalendarMoveOperation(row: source, column: column, to: "2024-04-01"))
        }
        XCTAssertNoThrow(try nativeDatabaseCalendarMoveOperation(row: source, column: dateColumn.merging(["builtin": true, "editable": true]), to: "2024-04-01"))
        XCTAssertThrowsError(try nativeDatabaseCalendarMoveOperation(row: source.merging(["rev": .null]), column: dateColumn, to: "2024-04-01"))
        XCTAssertThrowsError(try nativeDatabaseCalendarMoveOperation(row: source, column: dateColumn, to: "2024-04-31"))
        XCTAssertThrowsError(try nativeDatabaseCalendarMoveOperation(row: source, column: dateColumn, to: "9999-12-31"))
        XCTAssertThrowsError(try nativeDatabaseCalendarMoveOperation(row: row(["start": "2024-02-30", "end": "2024-03-02"]), column: dateColumn, to: "2024-04-01"))
    }
    func testAxisIsInclusiveAtLeastTwoWeeksAndAtMost92Days() {
        let today = NativeDatabaseDay("2024-10-11")!
        let empty = NativeDatabaseLayout.axis(spans: [], today: today)
        XCTAssertEqual(empty.days, 14); XCTAssertEqual(empty.labels.last?.key, "2024-10-12")
        let axis = NativeDatabaseLayout.axis(spans: [.init(start: NativeDatabaseDay("2020-01-01")!, end: NativeDatabaseDay("2026-12-31")!)], today: today)
        XCTAssertEqual(axis.days, 92); XCTAssertEqual(axis.labels.count, 92); XCTAssertEqual(axis.labels.last?.key, "2027-01-01")
        XCTAssertEqual(Set(axis.labels.map(\.ordinal)).count, 92)
    }
    func testActualAndPlanAreIndependentAndPlacementClipsAtBothEnds() {
        let first = NativeDatabaseDay("2024-03-01")!, axis = NativeDatabaseAxis(first: NativeDatabaseDay("2024-03-01")!, days: 14, today: NativeDatabaseDay("2024-03-05")!)
        let actual = NativeDatabaseSpan(start: first, end: first.adding(days: 4)!)
        let plan = NativeDatabaseSpan(start: first.adding(days: -3)!, end: first.adding(days: 1)!)
        XCTAssertEqual(NativeDatabaseLayout.placement(actual, axis: axis), .init(start: 0, length: 5, clippedBefore: false, clippedAfter: false))
        XCTAssertEqual(NativeDatabaseLayout.placement(plan, axis: axis), .init(start: 0, length: 2, clippedBefore: true, clippedAfter: false))
        XCTAssertEqual(NativeDatabaseLayout.placement(.init(start: first.adding(days: 12)!, end: first.adding(days: 20)!), axis: axis), .init(start: 12, length: 2, clippedBefore: false, clippedAfter: true))
        XCTAssertNil(NativeDatabaseLayout.placement(.init(start: first.adding(days: -4)!, end: first.adding(days: -1)!), axis: axis))
    }
    func testConfiguredDatePlanAndCoverMustHaveCorrectTypes() {
        let columns: [JSONValue] = [dateColumn, ["id": "title", "type": "text"], ["id": "lastActivity", "type": "date"], ["id": "plan", "type": "date"], ["id": "image", "type": "image"]]
        XCTAssertEqual(NativeDatabaseLayout.dateColumn(columns, config: ["date": "title"])?.id, "dates")
        XCTAssertEqual(NativeDatabaseLayout.dateColumn(columns, config: [:], isThreads: true)?.id, "lastActivity")
        XCTAssertEqual(NativeDatabaseLayout.dateColumn(columns, config: ["date": "plan"], isThreads: true)?.id, "plan")
        XCTAssertEqual(NativeDatabaseLayout.planColumn(columns, config: ["planDate": "plan"])?.id, "plan")
        XCTAssertNil(NativeDatabaseLayout.planColumn(columns, config: ["planDate": "title"]))
        XCTAssertEqual(NativeDatabaseLayout.coverColumn(columns, config: ["cover": "title"])?.id, "image")
    }
    func testGallerySnippetsArePlainBoundedAndPreferTextToBody() {
        let columns: [JSONValue] = [["id": "title", "type": "text"], ["id": "notes", "type": "text"]]
        let value: JSONValue = ["values": ["title": "Title", "notes": "**Read** [this](https://example.com)"], "body": "Body"]
        XCTAssertEqual(NativeDatabaseLayout.snippet(value, columns: columns), "Read this")
        let body: JSONValue = ["values": ["title": "Title"], "body": .string("**Start** " + String(repeating: "more words ", count: 5000))]
        XCTAssertTrue(NativeDatabaseLayout.snippet(body, columns: columns).hasPrefix("Start more words"))
        XCTAssertLessThanOrEqual(NativeDatabaseLayout.snippet(body, columns: columns).count, 500)
    }
    func testGalleryFactsRespectVisibleColumnsAndHideCoverAndTitle() {
        let columns: [JSONValue] = [["id": "title", "type": "text"], ["id": "notes", "type": "text"], ["id": "image", "type": "image"], ["id": "score", "type": "number"], ["id": "status", "type": "select"]]
        XCTAssertEqual(NativeDatabaseLayout.galleryFacts(columns: columns, config: ["visible": ["image", "score"]]).map(\.id), ["score"])
        XCTAssertTrue(NativeDatabaseLayout.galleryFacts(columns: columns, config: ["visible": []]).isEmpty)
    }
    func testPublicImagePolicyRejectsCredentialsPrivateAddressesAndActiveSchemes() {
        for value in ["https://images.example.com/cover.png", "https://8.8.8.8/image", "https://[2606:4700:4700::1111]/image"] { XCTAssertNotNil(NativeDatabaseLayout.imageURL(.string(value)), value) }
        for value in ["http://example.com/i", "file:///tmp/i", "data:image/png;base64,a", "javascript:alert(1)", "https://user:password@example.com/i", "https://localhost/i", "https://printer/i", "https://host.local/i", "https://127.0.0.1/i", "https://10.0.0.1/i", "https://100.64.0.1/i", "https://172.16.0.1/i", "https://192.168.1.2/i", "https://169.254.169.254/i", "https://224.0.0.1/i", "https://[::1]/i", "https://[fd00::1]/i", "https://[::ffff:127.0.0.1]/i", "https://2130706433/i", "https://0177.0.0.1/i", "https://0x7f.0.0.1/i"] {
            XCTAssertNil(NativeDatabaseLayout.imageURL(.string(value)), value)
        }
    }
    func testDerivingLayoutsDoesNotMutateInputSnapshots() {
        let input = row(["start": "2024-02-28", "end": "2024-03-01"]), copy = row(["start": "2024-02-28", "end": "2024-03-01"])
        _ = NativeDatabaseLayout.month(year: 2024, month: 2, rows: [input], dateColumnID: "dates", today: NativeDatabaseDay("2024-02-29")!)
        _ = NativeDatabaseLayout.snippet(input, columns: [dateColumn])
        _ = NativeDatabaseDates.span(input["values"]["dates"])
        XCTAssertEqual(input, copy)
    }
}
