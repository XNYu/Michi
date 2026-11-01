import Foundation
import MichiCore

/// An opaque, exact server provenance tuple. Do not trim or normalize IDs.
struct NativePageSource: Hashable, Identifiable, Sendable {
    let nodeID: String
    let turnID: String
    let assistantID: String

    init?(_ value: JSONValue) {
        guard case .object(let fields) = value, Set(fields.keys) == ["nodeId", "turnId", "assistantId"],
              let nodeID = Self.validID(value["nodeId"]), let turnID = Self.validID(value["turnId"]),
              let assistantID = Self.validID(value["assistantId"]) else { return nil }
        self.nodeID = nodeID; self.turnID = turnID; self.assistantID = assistantID
    }
    static func validID(_ value: JSONValue) -> String? {
        guard case .string(let text) = value, !text.isEmpty, text.utf16.count <= 200 else { return nil }
        return text
    }
    // Swift String equality normalizes Unicode; JS's tuple identity does not.
    var id: String { [nodeID, turnID, assistantID].map { Data($0.utf8).base64EncodedString() }.joined(separator: ":") }
    var reference: NativeMichiReference { .source(nodeID: nodeID, turnID: turnID, assistantID: assistantID) }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
    static func unique(_ sources: [Self]) -> [Self] {
        var seen = Set<Self>()
        return sources.filter { seen.insert($0).inserted }
    }
    static func parseList(_ value: JSONValue) -> [Self]? {
        guard case .array(let values) = value, values.count <= 100 else { return nil }
        var sources: [Self] = []
        for value in values { guard let source = Self(value) else { return nil }; sources.append(source) }
        return sources
    }
}

/// Mirrors shared/src/pages/markdownSegments.ts; the renderer itself remains one
/// Markdown document so tables, lists, math and reference definitions keep context.
enum NativePageMarkdownSources {
    struct Segment: Equatable, Sendable, Identifiable {
        enum Kind: String, Sendable { case heading, paragraph, listItem = "list-item", code, table, quote }
        let index: Int
        let kind: Kind
        let text: String
        var id: Int { index }
    }
    struct Passage: Equatable, Sendable {
        let segment: Segment
        let sources: [NativePageSource]
    }
    private static let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    private static let jsSpace = #"[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]"#
    private static let fence = try! NSRegularExpression(pattern: #"^ {0,3}(`{3,}|~{3,})(.*)$"#)
    private static let heading = try! NSRegularExpression(pattern: "^ {0,3}#{1,6}(?:" + jsSpace + "|$)")
    private static let item = try! NSRegularExpression(pattern: "^ {0,3}(?:[-*+]|[0-9]+[.)])" + jsSpace)
    private static let table = try! NSRegularExpression(pattern: #"^ {0,3}\|"#)
    private static let quote = try! NSRegularExpression(pattern: #"^ {0,3}>"#)
    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool { regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil }
    private static func trim(_ text: String) -> String { text.trimmingCharacters(in: whitespace) }
    private static func openingFence(_ text: String) -> String? {
        guard let match = fence.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let markerRange = Range(match.range(at: 1), in: text), let suffixRange = Range(match.range(at: 2), in: text) else { return nil }
        let marker = String(text[markerRange])
        return marker.first == "`" && text[suffixRange].contains("`") ? nil : marker
    }
    private static func fenceEnd(_ lines: [String], from: Int, marker: String) -> Int {
        for index in (from + 1)..<lines.count {
            let line = trim(lines[index])
            if line.count >= marker.count, line.allSatisfy({ $0 == marker.first! }) { return index + 1 }
        }
        return lines.count
    }
    private static func indentation(_ line: String) -> Int {
        var count = 0
        for char in line { if char == " " { count += 1 } else if char == "\t" { count += 4 } else { break } }
        return count
    }
    private static func itemEnd(_ lines: [String], from: Int) -> Int {
        let needed = indentation(lines[from]) + 2
        var end = from + 1, index = from + 1
        while index < lines.count {
            if trim(lines[index]).isEmpty { index += 1; continue }
            if indentation(lines[index]) < needed { break }
            // JS trimStart, not trim: closing-fence and info-string checks retain suffixes.
            let scalars = lines[index].unicodeScalars.drop(while: { whitespace.contains($0) })
            if let marker = openingFence(String(String.UnicodeScalarView(scalars))) { index = fenceEnd(lines, from: index, marker: marker) - 1 }
            end = index + 1; index += 1
        }
        return end
    }
    static func split(_ text: String) -> [Segment]? {
        guard text.utf16.count <= 32_768 else { return nil }
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        guard lines.count <= 2_000 else { return nil }
        var segments: [Segment] = [], index = 0
        func startsBlock(_ line: String) -> Bool { openingFence(line) != nil || matches(heading, line) || matches(item, line) || matches(table, line) || matches(quote, line) }
        func append(_ kind: Segment.Kind, _ from: Int, _ to: Int) {
            var end = to
            while end > from, trim(lines[end - 1]).isEmpty { end -= 1 }
            segments.append(.init(index: segments.count, kind: kind, text: lines[from..<end].joined(separator: "\n")))
        }
        while index < lines.count {
            let line = lines[index]
            if trim(line).isEmpty { index += 1; continue }
            guard segments.count < 100 else { return nil }
            if let marker = openingFence(line) { let end = fenceEnd(lines, from: index, marker: marker); append(.code, index, end); index = end; continue }
            if matches(heading, line) { append(.heading, index, index + 1); index += 1; continue }
            if matches(item, line) { let end = itemEnd(lines, from: index); append(.listItem, index, end); index = end; continue }
            if matches(table, line) || matches(quote, line) {
                let isTable = matches(table, line), run = isTable ? table : quote
                var end = index + 1
                while end < lines.count, matches(run, lines[end]) { end += 1 }
                append(isTable ? .table : .quote, index, end); index = end; continue
            }
            var end = index + 1
            while end < lines.count, !trim(lines[end]).isEmpty, !startsBlock(lines[end]) { end += 1 }
            append(.paragraph, index, end); index = end
        }
        return segments
    }
    static func parse(text: String, value: JSONValue) -> [Passage]? {
        guard let segments = split(text), case .array(let entries) = value,
              entries.count == segments.count, entries.count <= 100 else { return nil }
        var totalSources = 0, result: [Passage] = []
        for (index, entry) in entries.enumerated() {
            guard case .object(let fields) = entry, Set(fields.keys) == ["text", "sources"],
                  let anchor = entry["text"].optionalString,
                  anchor.utf16.elementsEqual(segments[index].text.utf16),
                  let sources = NativePageSource.parseList(entry["sources"]) else { return nil }
            totalSources += sources.count
            guard totalSources <= 100 else { return nil }
            result.append(.init(segment: segments[index], sources: NativePageSource.unique(sources)))
        }
        return result
    }
}

struct NativePageProvenance {
    struct Group: Identifiable {
        let id: String
        let label: String
        let passage: String?
        let sources: [NativePageSource]
    }
    let groups: [Group]
    let unavailablePassages: Bool
    let invalidSources: Bool
    let limited: Bool
    var sourceCount: Int { NativePageSource.unique(groups.flatMap(\.sources)).count }
    var isVisible: Bool { !groups.isEmpty || unavailablePassages || invalidSources || limited }

    init(block: JSONValue) {
        var groups: [Group] = [], stale = false, invalid = false, limited = false
        var nodes = 0, links = 0
        func add(id: String, label: String, passage: String?, sources: [NativePageSource]) {
            let unique = NativePageSource.unique(sources)
            guard !unique.isEmpty else { return }
            guard groups.count < 100, links < 200 else { limited = true; return }
            let shown = Array(unique.prefix(200 - links))
            if shown.count < unique.count { limited = true }
            links += shown.count
            groups.append(.init(id: id, label: label, passage: passage, sources: shown))
        }
        func visit(_ value: JSONValue, path: String, label: String, depth: Int) {
            guard depth <= 6, nodes < 120 else { limited = true; return }
            nodes += 1
            if value["type"] == "markdown", value.objectValue["segmentSources"] != nil {
                if let text = value["text"].optionalString, let matched = NativePageMarkdownSources.parse(text: text, value: value["segmentSources"]) {
                    for passage in matched {
                        add(id: path + "/p\(passage.segment.index)", label: label + "Passage \(passage.segment.index + 1)", passage: passage.segment.text, sources: passage.sources)
                    }
                } else { stale = true }
            }
            if value.objectValue["sources"] != nil {
                if let sources = NativePageSource.parseList(value["sources"]) { add(id: path + "/block", label: label + "Entire block", passage: nil, sources: sources) }
                else { invalid = true }
            }
            func slot(_ values: JSONValue, suffix: String, title: String) {
                for (index, child) in values.arrayValue.prefix(121).enumerated() {
                    guard nodes < 120 else { limited = true; return }
                    visit(child, path: path + suffix + "/\(index)", label: label + title + "Content \(index + 1) · ", depth: depth + 1)
                }
            }
            switch value["type"].stringValue {
            case "toggle": slot(value["blocks"], suffix: "/toggle", title: "")
            case "columns":
                if value["columns"].arrayValue.count > 120 { limited = true }
                for (index, column) in value["columns"].arrayValue.prefix(121).enumerated() { guard nodes < 120 else { limited = true; break }; slot(column, suffix: "/c\(index)", title: "Column \(index + 1) · ") }
            case "tabs", "grid":
                let key = value["type"] == "tabs" ? "tabs" : "regions"
                if value[key].arrayValue.count > 120 { limited = true }
                for (index, container) in value[key].arrayValue.prefix(121).enumerated() { guard nodes < 120 else { limited = true; break }; slot(container["blocks"], suffix: "/\(key)\(index)", title: (key == "tabs" ? "Tab " : "Region ") + "\(index + 1) · ") }
            default: break
            }
        }
        visit(block, path: "root", label: "", depth: 0)
        self.groups = groups; unavailablePassages = stale; invalidSources = invalid; self.limited = limited
    }
}

struct NativePageChangeProvenance {
    struct Link: Identifiable {
        let label: String
        let source: NativePageSource
        let messageID: String?
        var id: String { label + ":" + source.id + ":" + Data((messageID ?? "").utf8).base64EncodedString() }
        var reference: NativeMichiReference { messageID.map { .node(id: source.nodeID, messageID: $0) } ?? source.reference }
    }
    let label: String
    let readSummary: String?
    let links: [Link]
    let unavailable: Bool

    init(source value: JSONValue) {
        let parsed = Self.parse(value)
        label = parsed?.0 ?? "Source unavailable"; readSummary = parsed?.1; links = parsed?.2 ?? []; unavailable = parsed == nil
    }
    private static func parse(_ value: JSONValue) -> (String, String?, [Link])? {
        guard case .object(let fields) = value else { return nil }
        func exact(_ keys: Set<String>) -> Bool { Set(fields.keys).isSubset(of: keys) }
        func triple(_ raw: JSONValue) -> NativePageSource? { NativePageSource(["nodeId": raw["nodeId"], "turnId": raw["turnId"], "assistantId": raw["assistantId"]]) }
        func integer(_ raw: JSONValue, min: Double = 0, max: Double = 9_007_199_254_740_991) -> Double? {
            guard case .number(let number) = raw, number.isFinite, number.rounded() == number, number >= min, number <= max else { return nil }; return number
        }
        switch value["kind"].stringValue {
        case "user": return exact(["kind"]) ? ("Changed by you", nil, []) : nil
        case "chat", "helper":
            guard exact(["kind", "nodeId", "turnId", "assistantId"]), let source = triple(value) else { return nil }
            return (value["kind"] == "helper" ? "Page helper" : "Chat", nil, [.init(label: "Open exact message", source: source, messageID: nil)])
        case "maintenance":
            guard exact(["kind", "nodeId", "turnId", "assistantId", "jobId", "runId", "evidence", "read"]),
                  let writer = triple(value), NativePageSource.validID(value["jobId"]) != nil, NativePageSource.validID(value["runId"]) != nil,
                  case .array(let evidence) = value["evidence"], evidence.count <= 100 else { return nil }
            var readSummary: String?
            if fields["read"] != nil {
                let read = value["read"]
                guard case .object(let readFields) = read, Set(readFields.keys) == ["kind", "count"],
                      ["conversations", "workspace-homes"].contains(read["kind"].stringValue), let count = integer(read["count"], max: 100_000) else { return nil }
                readSummary = "Read \(Int(count)) " + (read["kind"] == "conversations" ? "conversation" : "workspace home") + (count == 1 ? "" : "s")
            } else if evidence.count > 1 { readSummary = "Read \(evidence.count) conversations" }
            var links: [Link] = [.init(label: "Open maintenance run", source: writer, messageID: nil)], seen = Set<String>()
            for entry in evidence {
                guard case .object(let keys) = entry, Set(keys.keys).isSubset(of: ["nodeId", "turnId", "assistantId", "messageId"]), let source = triple(entry) else { return nil }
                let messageID: String?
                if keys["messageId"] != nil { guard let id = NativePageSource.validID(entry["messageId"]) else { return nil }; messageID = id }
                else { messageID = nil }
                let key = source.id + ":" + Data((messageID ?? "").utf8).base64EncodedString()
                guard seen.insert(key).inserted else { continue }
                let prefix = fields["read"] == nil && evidence.count > 1 ? "Read message " : "Cited message "
                links.append(.init(label: prefix + "\(links.count)", source: source, messageID: messageID))
            }
            return ("Maintenance run", readSummary, links)
        case "component":
            guard NativePageSource.validID(value["componentId"]) != nil, let version = integer(value["version"], min: 1) else { return nil }
            if exact(["kind", "componentId", "version", "pageId", "blockId"]), NativePageSource.validID(value["pageId"]) != nil, NativePageSource.validID(value["blockId"]) != nil { return ("Page component · v\(Int(version))", nil, []) }
            if exact(["kind", "componentId", "version", "databaseId", "viewId"]), NativePageSource.validID(value["databaseId"]) != nil, NativePageSource.validID(value["viewId"]) != nil { return ("Custom database view · v\(Int(version))", nil, []) }
            return nil
        default: return nil
        }
    }
}
