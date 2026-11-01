import Foundation
import MichiCore

/// Read-only excerpts for pre-journal conversations. Mirrors phone Overview's
/// fallbackBranchOverview; an excerpt is never written into branch_overview.
@MainActor enum WorkspaceOverviewSummary {
    static func text(node: JSONValue, graph: WorkspaceGraph) -> String {
        guard !node.id.isEmpty, node["workspace_id"].stringValue == graph.id,
              let current = graph.node(node.id), current["workspace_id"].stringValue == graph.id,
              current["kind"] == "chat", current["deleted_at"].isNull else { return "" }
        let saved = WorkspaceOverviewModel.overview(current)
        if !saved.isEmpty { return saved }

        let messages = graph.raw["messages"].arrayValue.enumerated().filter { _, message in
            message["node_id"].stringValue == current.id &&
            (message["workspace_id"].isNull || message["workspace_id"].stringValue == graph.id) &&
            ["assistant", "user"].contains(message["role"].stringValue)
        }.sorted { left, right in
            // Same ordering as web hydration: seq when both rows have one,
            // otherwise created_at, preserving wire order for equal values.
            if let a = number(left.element["seq"]), let b = number(right.element["seq"]) { return a == b ? left.offset < right.offset : a < b }
            let a = number(left.element["created_at"]) ?? 0, b = number(right.element["created_at"]) ?? 0
            return a == b ? left.offset < right.offset : a < b
        }.map(\.element)

        if let assistant = messages.last(where: { $0["role"] == "assistant" }) {
            // Reuse the digest's web-compatible answer-block and sentinel
            // projection. Thinking, tool blocks and metadata are not prose.
            let visible = DigestSourceSnapshot(node: current, messages: [assistant]).payload["messages"].arrayValue.first?["text"].stringValue ?? ""
            for paragraph in paragraphs(trim(visible)) {
                let withoutHeading = replace(replace(paragraph, pattern: "^#{1,6}" + whitespacePattern + "+[^\\n]+\\n+"),
                                             pattern: "^#{1,6}" + whitespacePattern + "+[^\\n]+$")
                let useful = trim(withoutHeading)
                if !useful.isEmpty { return clip(useful, maximum: 720) }
            }
        }
        guard let user = messages.first(where: { $0["role"] == "user" }) else { return "" }
        let unquoted = replace(user["content"].stringValue, pattern: "^>.*$", options: .anchorsMatchLines)
        let prompt = trim(replace(unquoted, pattern: "^/(?:btw|branch)" + whitespacePattern + "+", options: .caseInsensitive))
        return prompt.isEmpty ? "" : clip(prompt, maximum: 420)
    }

    private static func number(_ value: JSONValue) -> Double? {
        guard case .number(let number) = value, number.isFinite else { return nil }
        return number
    }
    // ECMAScript \s / String.trim, including FEFF but excluding U+0085.
    private static let whitespacePattern = #"[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]"#
    private static let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    private static func trim(_ text: String) -> String { text.trimmingCharacters(in: whitespace) }
    private static func replace(_ text: String, pattern: String, options: NSRegularExpression.Options = []) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
        return expression.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
    }
    private static func paragraphs(_ text: String) -> [String] {
        guard let expression = try? NSRegularExpression(pattern: "\\n" + whitespacePattern + "*\\n") else { return [text] }
        let source = text as NSString
        var result: [String] = [], start = 0
        for match in expression.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            result.append(source.substring(with: NSRange(location: start, length: match.range.location - start)))
            start = NSMaxRange(match.range)
        }
        result.append(source.substring(from: start))
        return result
    }
    private static func clip(_ text: String, maximum: Int) -> String {
        let compact = trim(text)
        guard compact.utf16.count > maximum else { return compact }
        // JavaScript limits count UTF-16 code units. Keep a surrogate pair
        // intact at the boundary instead of rendering a replacement glyph.
        var units = Array(compact.utf16.prefix(maximum))
        if let last = units.last, (0xD800...0xDBFF).contains(last) { units.removeLast() }
        let slice = String(decoding: units, as: UTF16.self)
        let source = slice as NSString
        let boundary = [". ", "。", "\n"].map { source.range(of: $0, options: .backwards).location }
            .filter { $0 != NSNotFound }.max() ?? -1
        let clipped = boundary > Int(Double(maximum) * 0.55) ? source.substring(to: boundary + 1) : slice
        return trim(clipped) + "…"
    }
}
