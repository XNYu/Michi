import Foundation
import MichiCore

/// A proleptic Gregorian civil day. Arithmetic never passes through midnight,
/// the device's preferred calendar, UTC offsets, or daylight-saving transitions.
struct NativeDatabaseDay: Equatable, Hashable, Comparable, Identifiable {
    let year: Int
    let month: Int
    let day: Int
    var id: String { key }
    var key: String { String(format: "%04d-%02d-%02d", year, month, day) }
    init?(year: Int, month: Int, day: Int) {
        guard (1...9999).contains(year), (1...12).contains(month), (1...Self.daysInMonth(year: year, month: month)).contains(day) else { return nil }
        self.year = year; self.month = month; self.day = day
    }
    init?(_ value: String) {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45,
              bytes.enumerated().allSatisfy({ [4, 7].contains($0.offset) || (48...57).contains($0.element) }),
              let year = Int(value.prefix(4)), let month = Int(value.dropFirst(5).prefix(2)), let day = Int(value.suffix(2)) else { return nil }
        self.init(year: year, month: month, day: day)
    }
    static func daysInMonth(year: Int, month: Int) -> Int {
        guard (1...12).contains(month) else { return 0 }
        if month == 2 { return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28 }
        return [4, 6, 9, 11].contains(month) ? 30 : 31
    }
    private static func beforeYear(_ year: Int) -> Int { let y = year - 1; return y * 365 + y / 4 - y / 100 + y / 400 }
    var ordinal: Int { Self.beforeYear(year) + (1..<month).reduce(0) { $0 + Self.daysInMonth(year: year, month: $1) } + day - 1 }
    var weekdayMondayFirst: Int { ordinal % 7 }
    init?(ordinal: Int) {
        guard ordinal >= 0, ordinal < Self.beforeYear(10000) else { return nil }
        var low = 1, high = 9999
        while low < high { let mid = (low + high + 1) / 2; if Self.beforeYear(mid) <= ordinal { low = mid } else { high = mid - 1 } }
        var remaining = ordinal - Self.beforeYear(low), month = 1
        while remaining >= Self.daysInMonth(year: low, month: month) { remaining -= Self.daysInMonth(year: low, month: month); month += 1 }
        self.init(year: low, month: month, day: remaining + 1)
    }
    func adding(days: Int) -> Self? {
        let (value, overflow) = ordinal.addingReportingOverflow(days)
        return overflow ? nil : Self(ordinal: value)
    }
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.ordinal < rhs.ordinal }
    static func at(_ date: Date, timeZone: TimeZone = .current) -> Self? {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        guard let y = c.year, let m = c.month, let d = c.day else { return nil }
        return Self(year: y, month: m, day: d)
    }
    /// DatePicker uses UTC noon and an explicit Gregorian calendar. Saved values
    /// remain civil-day strings and do not change when the phone changes zones.
    var pickerDate: Date {
        Date(timeIntervalSince1970: Double(ordinal - NativeDatabaseDay("1970-01-01")!.ordinal) * 86_400 + 43_200)
    }
}

enum NativeDatabaseDates {
    /// ISO times become local days; plain dates are never interpreted as UTC.
    static func day(_ text: String, timeZone: TimeZone = .current) -> NativeDatabaseDay? {
        if let plain = NativeDatabaseDay(text) { return plain }
        guard text.utf8.count <= 64,
              let expression = try? NSRegularExpression(pattern: #"^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$"#),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        func part(_ index: Int) -> String? { Range(match.range(at: index), in: text).map { String(text[$0]) } }
        guard let civil = part(1).flatMap(NativeDatabaseDay.init), let hour = part(2).flatMap(Int.init), let minute = part(3).flatMap(Int.init),
              (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        let second = part(4).flatMap(Int.init) ?? 0
        guard (0...59).contains(second) else { return nil }
        var zone = timeZone
        if let offset = part(6) {
            if offset == "Z" { zone = TimeZone(secondsFromGMT: 0)! }
            else {
                guard let h = Int(offset.dropFirst().prefix(2)), let m = Int(offset.suffix(2)), h <= 23, m <= 59,
                      let explicit = TimeZone(secondsFromGMT: (offset.first == "-" ? -1 : 1) * (h * 3600 + m * 60)) else { return nil }
                zone = explicit
            }
        }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let components = DateComponents(year: civil.year, month: civil.month, day: civil.day, hour: hour, minute: minute, second: second)
        guard let instant = calendar.date(from: components) else { return nil }
        let check = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: instant)
        guard check.year == civil.year, check.month == civil.month, check.day == civil.day, check.hour == hour, check.minute == minute, check.second == second else { return nil }
        return NativeDatabaseDay.at(instant, timeZone: timeZone)
    }
    static func span(_ value: JSONValue, timeZone: TimeZone = .current) -> NativeDatabaseSpan? {
        if let text = value.optionalString, let day = day(text, timeZone: timeZone) { return .init(start: day, end: day) }
        guard let text = value["start"].optionalString, let start = day(text, timeZone: timeZone) else { return nil }
        let endText = value["end"].optionalString ?? ""
        guard let end = endText.isEmpty ? start : day(endText, timeZone: timeZone) else { return nil }
        return .init(start: min(start, end), end: max(start, end))
    }
}

struct NativeDatabaseSpan: Equatable { let start: NativeDatabaseDay; let end: NativeDatabaseDay }
struct NativeDatabaseCalendarDay: Identifiable {
    let date: NativeDatabaseDay
    let inMonth: Bool
    let today: Bool
    let rows: [JSONValue]
    var id: String { date.key }
}
struct NativeDatabaseAxis {
    let first: NativeDatabaseDay
    let days: Int
    let today: NativeDatabaseDay
    var labels: [NativeDatabaseDay] { (0..<days).compactMap { first.adding(days: $0) } }
}
struct NativeDatabaseSpanPlacement: Equatable {
    let start: Int
    let length: Int
    let clippedBefore: Bool
    let clippedAfter: Bool
}

enum NativeDatabaseLayout {
    static let pageSize = 60
    static func dateColumn(_ columns: [JSONValue], config: JSONValue, isThreads: Bool = false) -> JSONValue? {
        let dates = columns.filter { $0["type"] == "date" }
        return dates.first { $0.id == config["date"].stringValue } ?? (isThreads ? dates.first { $0.id == "lastActivity" } : nil) ?? dates.first
    }
    static func planColumn(_ columns: [JSONValue], config: JSONValue) -> JSONValue? { columns.first { $0["type"] == "date" && $0.id == config["planDate"].stringValue } }
    static func coverColumn(_ columns: [JSONValue], config: JSONValue) -> JSONValue? {
        columns.first { $0["type"] == "image" && $0.id == config["cover"].stringValue } ?? columns.first { $0["type"] == "image" }
    }
    static func titleColumn(_ columns: [JSONValue], isThreads: Bool = false) -> JSONValue? {
        (isThreads ? columns.first { $0.id == "title" } : nil) ?? columns.first { $0["type"] == "text" } ?? columns.first
    }
    static func title(_ row: JSONValue, columns: [JSONValue], isTasks: Bool = false, isThreads: Bool = false) -> String {
        if isTasks { return featureRowTitle(row, columns: columns, isTasks: true) }
        guard let title = titleColumn(columns, isThreads: isThreads) else { return "Untitled" }
        let text = featureCellText(row["values"][title.id], type: title["type"].stringValue)
        return text.isEmpty ? "Untitled" : text
    }
    static func editable(_ column: JSONValue) -> Bool { column["builtin"].boolValue ? column["editable"] == true : column["editable"] != false }
    static func month(year: Int, month: Int, rows: [JSONValue], dateColumnID: String, today: NativeDatabaseDay, timeZone: TimeZone = .current) -> [NativeDatabaseCalendarDay] {
        guard let first = NativeDatabaseDay(year: year, month: month, day: 1) else { return [] }
        let count = NativeDatabaseDay.daysInMonth(year: year, month: month), lead = first.weekdayMondayFirst
        let total = ((lead + count + 6) / 7) * 7
        var byDay: [String: [JSONValue]] = [:]
        for row in rows { if let start = NativeDatabaseDates.span(row["values"][dateColumnID], timeZone: timeZone)?.start { byDay[start.key, default: []].append(row) } }
        return (0..<total).compactMap { offset in
            guard let day = first.adding(days: offset - lead) else { return nil }
            let inside = day.year == year && day.month == month
            return .init(date: day, inMonth: inside, today: day == today, rows: inside ? byDay[day.key] ?? [] : [])
        }
    }
    static func axis(spans: [NativeDatabaseSpan], today: NativeDatabaseDay) -> NativeDatabaseAxis {
        var lo = today.ordinal, hi = today.ordinal
        for span in spans { lo = min(lo, span.start.ordinal); hi = max(hi, span.end.ordinal) }
        lo = max(0, lo - 1); hi = min(NativeDatabaseDay("9999-12-31")!.ordinal, hi + 1)
        lo = max(0, min(lo, hi - 13)); lo = max(lo, hi - 91)
        return .init(first: NativeDatabaseDay(ordinal: lo)!, days: hi - lo + 1, today: today)
    }
    static func placement(_ span: NativeDatabaseSpan, axis: NativeDatabaseAxis) -> NativeDatabaseSpanPlacement? {
        let a = span.start.ordinal - axis.first.ordinal, b = span.end.ordinal - axis.first.ordinal
        guard b >= 0, a < axis.days else { return nil }
        return .init(start: max(0, a), length: min(axis.days - 1, b) - max(0, a) + 1, clippedBefore: a < 0, clippedAfter: b >= axis.days)
    }
    static func snippet(_ row: JSONValue, columns: [JSONValue], isThreads: Bool = false) -> String {
        let title = titleColumn(columns, isThreads: isThreads)?.id
        if isThreads {
            let next = plain(row["values"]["next"].stringValue)
            if !next.isEmpty { return "Next: " + next }
            let stopped = plain(row["values"]["stoppedAt"].stringValue)
            return stopped == plain(row["values"][title ?? "title"].stringValue) ? "" : stopped
        }
        if let text = columns.first(where: { $0["type"] == "text" && $0.id != title && !row["values"][$0.id].stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { return plain(row["values"][text.id].stringValue) }
        return plain(row["body"].stringValue)
    }
    static func galleryFacts(columns: [JSONValue], config: JSONValue, isThreads: Bool = false) -> [JSONValue] {
        let title = titleColumn(columns, isThreads: isThreads)?.id, cover = coverColumn(columns, config: config)?.id
        let visible = config["visible"].isNull ? nil : Set(config["visible"].arrayValue.map(\.stringValue))
        return columns.filter { $0.id != title && $0.id != cover && $0["type"] != "text" && !(isThreads && $0["builtin"].boolValue) && (visible == nil || visible!.contains($0.id)) }
    }
    private static func plain(_ text: String) -> String {
        String(text.prefix(500)).replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"[*_`#>]+"#, with: "", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
    /// Mirrors pictureAddress's public HTTPS policy; userinfo, local names,
    /// private IPs and alternate numeric IPv4 spellings are rejected as well.
    static func imageURL(_ value: JSONValue) -> URL? {
        guard let text = value.optionalString?.trimmingCharacters(in: .whitespacesAndNewlines), text.utf8.count <= 8192,
              let url = URL(string: text), let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.scheme?.lowercased() == "https",
              c.user == nil, c.password == nil, let rawHost = c.host else { return nil }
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        if host.contains(":") { return (host.hasPrefix("2") || host.hasPrefix("3")) && !host.contains(".") ? url : nil }
        guard host.contains("."), ![".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"].contains(where: host.hasSuffix) else { return nil }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) {
            let nums = parts.compactMap { Int($0) }
            guard nums.count == 4, nums.allSatisfy({ (0...255).contains($0) }), parts.enumerated().allSatisfy({ String(nums[$0.offset]) == $0.element }) else { return nil }
            let n = nums.reduce(UInt64(0)) { $0 * 256 + UInt64($1) }
            let denied: [(UInt64, Int)] = [(0x00000000, 8), (0x0a000000, 8), (0x64400000, 10), (0x7f000000, 8), (0xa9fe0000, 16), (0xac100000, 12), (0xc0000000, 24), (0xc0a80000, 16), (0xc6120000, 15), (0xe0000000, 4), (0xf0000000, 4)]
            return denied.contains(where: { n >> (32 - $0.1) == $0.0 >> (32 - $0.1) }) ? nil : url
        }
        guard let last = parts.last, Int(last) == nil, !last.hasPrefix("0x"), parts.allSatisfy({ !$0.isEmpty }) else { return nil }
        return url
    }
}

/// Creates only an explicit edit intent. The caller persists it with the current
/// database revision; the row revision remains the one the person moved.
func nativeDatabaseCalendarMoveOperation(row: JSONValue, column: JSONValue, to day: String, timeZone: TimeZone = .current) throws -> JSONValue? {
    guard column["type"] == "date", NativeDatabaseLayout.editable(column) else { throw NativeFailure("This date column cannot be changed.") }
    guard !row.id.isEmpty, !column.id.isEmpty, case .number(let revision) = row["rev"], revision >= 1, revision.isFinite, revision.rounded() == revision else { throw NativeFailure("Reload the row before moving its date.") }
    guard let target = NativeDatabaseDay(day) else { throw NativeFailure("Choose a valid Gregorian date as YYYY-MM-DD.") }
    let old = row["values"][column.id]
    let startText = old.optionalString ?? old["start"].optionalString
    let start = startText.flatMap { NativeDatabaseDates.day($0, timeZone: timeZone) }
    if start == target { return nil }
    let endText = old["end"].optionalString
    if let text = startText, !text.isEmpty, start == nil { throw NativeFailure("The existing start date is invalid. Edit the row before moving it.") }
    var value: JSONValue = ["start": .string(target.key)]
    if let endText, !endText.isEmpty {
        guard let start, let end = NativeDatabaseDates.day(endText, timeZone: timeZone), let shifted = target.adding(days: end.ordinal - start.ordinal) else { throw NativeFailure("The date range cannot be moved without losing its length.") }
        value["end"] = .string(shifted.key)
    }
    return ["op": "row.update", "id": .string(row.id), "expectRev": row["rev"], "values": .object([column.id: value])]
}
