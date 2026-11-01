import Foundation
import MichiCore
import Darwin

struct RichPageBlockError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

struct RichPageView: Identifiable, Equatable {
    let id: String
    let title: String
    let presentation: String
    let blocks: [JSONValue]
}

/// Presentation state stores only the action's identity, never resolved blocks.
/// Resolve against the current page snapshot before displaying or building an
/// edit route, so successful saves immediately expose their new revisions.
struct RichPageViewSelection: Identifiable, Equatable {
    let id: String
    let presentation: String
    private let action: JSONValue

    init(action: JSONValue, blocks: [JSONValue], visited: Set<String> = []) throws {
        let view = try RichPageBlockModel.view(action: action, blocks: blocks, visited: visited)
        self.id = view.id
        self.presentation = view.presentation
        self.action = action
    }

    func resolve(blocks: [JSONValue], visited: Set<String> = []) -> RichPageView? {
        try? RichPageBlockModel.view(action: action, blocks: blocks, visited: visited)
    }
}

/// Container edits replace a nested slot; named views address independent
/// page blocks. Keep both routes so a view opened inside a container can
/// never redirect an edit into that container's slot.
@MainActor
struct RichPageMutationRoute {
    typealias Apply = (JSONValue, String, Int) async -> Bool
    let page: Apply?
    let local: Apply?

    func nested(parent: JSONValue, collection: String, group: Int?, index: Int,
                onError: @escaping (String) -> Void) -> RichPageMutationRoute {
        guard let local else { return RichPageMutationRoute(page: page, local: nil) }
        return RichPageMutationRoute(page: page, local: { replacement, _, _ in
            do {
                let next = try RichPageBlockModel.replacingChild(in: parent, collection: collection, group: group, index: index, with: replacement)
                return await local(next, parent.id, parent["rev"].intValue)
            } catch { onError(error.localizedDescription); return false }
        })
    }

    func namedView(_ view: RichPageView, pageBlocks: [JSONValue],
                   onError: @escaping (String) -> Void) -> RichPageMutationRoute {
        guard let page else { return RichPageMutationRoute(page: nil, local: nil) }
        return RichPageMutationRoute(page: page, local: { input, id, revision in
            guard !id.isEmpty, revision > 0,
                  view.blocks.contains(where: { $0.id == id && $0["rev"].intValue == revision }),
                  pageBlocks.filter({ $0.id == id }).count == 1,
                  pageBlocks.first(where: { $0.id == id })?["rev"].intValue == revision else {
                onError("This view changed. Reload the page before editing it."); return false
            }
            return await page(input, id, revision)
        })
    }
}

struct RichChartPoint: Identifiable, Equatable {
    let id: String
    let series: String
    let label: String
    let x: Double?
    let y: Double
    let size: Double?
    let kind: String
}

/// Read adapters for shared/pages/{blocks,richBlocks,viewInteractions}. They
/// never invent missing numeric values or execute content supplied by a page.
enum RichPageBlockModel {
    static let supportedTypes: Set<String> = [
        "heading", "markdown", "callout", "checklist", "metrics", "next-steps", "timeline", "plan-actual",
        "compare", "conflict", "table", "criteria", "chart", "gallery", "forgot", "threads", "home-section",
        "database-ref", "page-link", "task-view", "toggle", "columns", "grid", "tabs", "view", "view-link",
        "quote", "divider", "toc", "code", "diff", "math", "mermaid", "keyvalue", "tags", "status", "stat",
        "progress", "ring", "gauge", "leaderboard", "rating", "pros-cons", "choice", "milestones", "stepper",
        "agenda", "calendar", "gantt", "countdown", "clocks", "image", "before-after", "carousel",
        "video", "audio", "embed", "link", "file", "person", "place", "actions", "form", "poll",
        "component",
    ]
    static func isMainContent(_ block: JSONValue) -> Bool {
        block["type"] != "view" && block["visibility"] != "detail"
    }
    static func moveInFullPage(source: IndexSet, destination: Int, blocks: [JSONValue]) throws -> (source: IndexSet, destination: Int) {
        let visible = blocks.indices.filter { isMainContent(blocks[$0]) }
        guard source.count == 1, let from = source.first, visible.indices.contains(from), (0...visible.count).contains(destination) else {
            throw RichPageBlockError(message: "Move one visible block at a time.")
        }
        return (IndexSet(integer: visible[from]), destination == visible.count ? blocks.count : visible[destination])
    }
    static func number(_ value: JSONValue) -> Double? {
        guard case .number(let result) = value, result.isFinite else { return nil }
        return result
    }
    static func text(_ value: JSONValue) -> String {
        switch value {
        case .string(let text): return text
        case .number(let number) where number.isFinite: return number.formatted(.number.precision(.fractionLength(0...6)))
        case .bool(let flag): return flag ? "Yes" : "No"
        default: return ""
        }
    }
    static func timestamp(_ value: JSONValue) -> String {
        if let milliseconds = number(value) {
            return Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .shortened)
        }
        return value.stringValue
    }
    static func date(_ value: String) -> Date? {
        if value.count == 10 {
            let day = DateFormatter(); day.calendar = Calendar(identifier: .gregorian)
            day.locale = Locale(identifier: "en_US_POSIX"); day.timeZone = TimeZone(secondsFromGMT: 0)
            day.dateFormat = "yyyy-MM-dd"; day.isLenient = false
            guard let parsed = day.date(from: value), day.string(from: parsed) == value else { return nil }
            return parsed
        }
        let formatter = ISO8601DateFormatter()
        for options: ISO8601DateFormatter.Options in [
            [.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime], [.withFullDate],
        ] {
            formatter.formatOptions = options
            if let date = formatter.date(from: value) { return date }
        }
        return nil
    }
    static func localDay(_ date: Date) -> String {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    static func localDate(_ day: String) -> Date? {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        return formatter.date(from: day)
    }
    static func markdownViewLinks(_ markdown: String) -> [(label: String, action: JSONValue)] {
        guard let regex = try? NSRegularExpression(pattern: #"\[([^\]\n]+)\]\((#view/[a-zA-Z][a-zA-Z0-9_-]{0,79}(?:\?presentation=(?:inline|drawer|modal))?)\)"#) else { return [] }
        func segments(_ blocks: [MarkdownBlock]) -> [String] {
            blocks.flatMap { block -> [String] in
                switch block {
                case .paragraph(let text), .heading(_, let text), .listItem(_, let text, _, _): return [text]
                case .quote(let children): return segments(children)
                case .table(let headers, _, let rows): return headers + rows.flatMap { $0 }
                case .html(let document): return [document.searchableText]
                default: return []
                }
            }
        }
        return Array(segments(MarkdownDocument(markdown).blocks).flatMap { segment in
            regex.matches(in: segment, range: NSRange(segment.startIndex..., in: segment)).compactMap { match -> (label: String, action: JSONValue)? in
                guard let label = Range(match.range(at: 1), in: segment), let href = Range(match.range(at: 2), in: segment),
                      let url = URL(string: String(segment[href])), let action = viewAction(href: url) else { return nil }
                return (String(segment[label]), action)
            }
        }.prefix(40))
    }
    static func view(action: JSONValue, blocks: [JSONValue], visited: Set<String> = []) throws -> RichPageView {
        let id = action["viewId"].stringValue
        guard action["type"] == "open-view", !id.isEmpty,
              ["", "inline", "drawer", "modal"].contains(action["presentation"].stringValue) else {
            throw RichPageBlockError(message: "This page has an invalid view action.")
        }
        guard !visited.contains(id) else { throw RichPageBlockError(message: "This view is already open.") }
        let matches = blocks.filter { $0["type"] == "view" && $0["viewId"].stringValue == id }
        guard matches.count == 1, let definition = matches.first else {
            throw RichPageBlockError(message: "The named view is missing or duplicated on this page.")
        }
        let ids = definition["blockIds"].arrayValue.map(\.stringValue)
        guard !ids.isEmpty, ids.count <= 40, Set(ids).count == ids.count else {
            throw RichPageBlockError(message: "This view has invalid content references.")
        }
        let content = try ids.map { id -> JSONValue in
            let matches = blocks.filter { $0.id == id }
            guard !id.isEmpty, matches.count == 1, let target = matches.first, target["type"] != "view" else {
                throw RichPageBlockError(message: "This view refers to missing or invalid page content.")
            }
            return target
        }
        return RichPageView(id: id, title: definition["title"].stringValue,
                            presentation: action["presentation"].optionalString ?? "drawer", blocks: content)
    }
    static func viewAction(href: URL) -> JSONValue? {
        let raw = href.absoluteString
        guard let range = raw.range(of: #"^#view/([a-zA-Z][a-zA-Z0-9_-]{0,79})(\?presentation=(inline|drawer|modal))?$"#, options: .regularExpression) else { return nil }
        let parts = String(raw[range]).dropFirst(6).split(separator: "?", maxSplits: 1)
        var result: JSONValue = ["type": "open-view", "viewId": .string(String(parts[0]))]
        if parts.count == 2 { result["presentation"] = .string(String(parts[1].dropFirst("presentation=".count))) }
        return result
    }
    /// A nested block has no independent identity/revision; its owner is edited.
    static func replacingChild(in block: JSONValue, collection: String, group: Int?, index: Int, with child: JSONValue) throws -> JSONValue {
        var next = featureBlockInput(from: block)
        var values = next[collection].arrayValue
        if let group {
            guard values.indices.contains(group) else { throw RichPageBlockError(message: "This content group changed. Reload before editing.") }
            var children = collection == "columns" ? values[group].arrayValue : values[group]["blocks"].arrayValue
            guard children.indices.contains(index) else { throw RichPageBlockError(message: "This content changed. Reload before editing.") }
            children[index] = featureBlockInput(from: child)
            if collection == "columns" { values[group] = .array(children) }
            else { values[group]["blocks"] = .array(children) }
        } else {
            guard values.indices.contains(index) else { throw RichPageBlockError(message: "This content changed. Reload before editing.") }
            values[index] = featureBlockInput(from: child)
        }
        next[collection] = .array(values)
        return next
    }
    static func chartPoints(_ block: JSONValue) throws -> [RichChartPoint] {
        let kind = block["kind"].stringValue
        var result: [RichChartPoint] = []
        let labels = block["labels"].arrayValue
        for (seriesIndex, series) in block["series"].arrayValue.prefix(10).enumerated() {
            let name = series["label"].stringValue
            let mark = kind == "composite" ? series["as"].stringValue : kind
            if !labels.isEmpty || kind == "radar" {
                let axes = kind == "radar" ? block["axes"].arrayValue : labels
                let values = series["values"].arrayValue
                guard values.count == axes.count, !axes.isEmpty else { throw RichPageBlockError(message: "Chart values do not match their labels.") }
                for (index, value) in values.prefix(100).enumerated() {
                    guard let y = number(value) else { throw RichPageBlockError(message: "The chart contains an invalid value.") }
                    result.append(.init(id: "\(seriesIndex)-\(index)", series: name, label: text(axes[index]), x: nil, y: y, size: nil, kind: mark))
                }
            } else {
                for (index, point) in series["points"].arrayValue.prefix(100).enumerated() {
                    guard let y = number(point["y"]), number(point["x"]) != nil || point["x"].optionalString != nil else {
                        throw RichPageBlockError(message: "The chart contains an invalid point.")
                    }
                    result.append(.init(id: "\(seriesIndex)-\(index)", series: name, label: text(point["x"]),
                                        x: number(point["x"]), y: y, size: number(point["z"]), kind: mark))
                }
            }
        }
        if kind == "sparkline" {
            result = try block["values"].arrayValue.prefix(100).enumerated().map { index, value in
                guard let y = number(value) else { throw RichPageBlockError(message: "The chart contains an invalid value.") }
                return .init(id: "\(index)", series: "", label: "\(index + 1)", x: Double(index + 1), y: y, size: nil, kind: "line")
            }
        }
        return result
    }
    static func formPrompt(_ block: JSONValue, values: [String: JSONValue]) throws -> String {
        let fields = block["fields"].arrayValue
        guard !fields.isEmpty, fields.count <= 20 else { throw RichPageBlockError(message: "This form has invalid fields.") }
        var answers: [String: JSONValue] = [:]
        for field in fields {
            let key = field["key"].stringValue, raw = values[key] ?? .null
            guard !key.isEmpty, answers[key] == nil else { throw RichPageBlockError(message: "This form has duplicate or missing field keys.") }
            let answer: JSONValue
            switch field["type"].stringValue {
            case "checkbox": answer = .bool(raw == .bool(true))
            case "number":
                let n = number(raw) ?? Double(raw.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
                answer = n.flatMap { $0.isFinite ? JSONValue.number($0) : nil } ?? .null
            case "select":
                answer = field["options"].arrayValue.contains(raw) ? raw : .null
            case "date":
                let day = raw.stringValue
                answer = day.count == 10 && date(day) != nil ? raw : .null
            case "text": answer = .string(raw.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
            default: throw RichPageBlockError(message: "This form uses an unsupported field type.")
            }
            if field["required"].boolValue && (answer.isNull || answer == .string("") || (field["type"] == "checkbox" && answer != .bool(true))) {
                throw RichPageBlockError(message: "Fill in \(field["label"].stringValue).")
            }
            answers[key] = answer
        }
        guard !block["prompt"].stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RichPageBlockError(message: "This form has no assistant prompt.")
        }
        return block["prompt"].stringValue + "\n\n" + JSONValue.object(answers).prettyPrinted
    }
    /// Same public-address policy as frontend/lib/pictureAddress.ts. URLs are
    /// never sent through the authenticated Michi API.
    static func mediaURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              let originalHost = url.host?.lowercased() else { return nil }
        let host = originalHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        guard !host.isEmpty else { return nil }
        if host.contains(":") {
            var address = in6_addr()
            guard inet_pton(AF_INET6, host, &address) == 1 else { return nil }
            let bytes = withUnsafeBytes(of: address) { Array($0) }
            if bytes[0] & 0xfe == 0xfc || (bytes[0] == 0xfe && bytes[1] & 0x80 != 0) ||
                bytes[0] == 0xff || bytes.prefix(12).allSatisfy({ $0 == 0 }) ||
                (bytes.prefix(10).allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff) ||
                (bytes[0] == 0 && bytes[1] == 0x64 && bytes[2] == 0xff && bytes[3] == 0x9b) { return nil }
        } else {
            let pieces = host.split(separator: ".")
            if pieces.count == 4, pieces.allSatisfy({ UInt8($0) != nil }) {
                guard pieces.allSatisfy({ String(UInt8($0)!) == $0 }) else { return nil }
                let ip = pieces.reduce(UInt32(0)) { ($0 << 8) | UInt32(UInt8($1)!) }
                let ranges: [(UInt32, Int)] = [(0, 8), (0x0a000000, 8), (0x64400000, 10), (0x7f000000, 8),
                    (0xa9fe0000, 16), (0xac100000, 12), (0xc0000000, 24), (0xc0a80000, 16),
                    (0xc6120000, 15), (0xe0000000, 4), (0xf0000000, 4)]
                if ranges.contains(where: { (ip >> (32 - $0.1)) == ($0.0 >> (32 - $0.1)) }) { return nil }
            } else {
                // Foundation does not normalize legacy numeric IPv4 spellings.
                if pieces.allSatisfy({ UInt64($0) != nil || $0.hasPrefix("0x") }) { return nil }
                if !host.contains(".") || [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"].contains(where: host.hasSuffix) { return nil }
            }
        }
        return url
    }
}
