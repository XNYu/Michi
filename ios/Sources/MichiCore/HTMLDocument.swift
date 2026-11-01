import Foundation

/// Bounded static HTML for the native transcript. Scripts, event handlers and
/// resource fetches are never supported semantics; their exact source is kept.
public struct NativeHTMLDocument: Equatable, Sendable {
    public var nodes: [NativeHTMLNode]
    public var source: String
    public var truncated: Bool
    public var reconstructed: String { source }

    public init(nodes: [NativeHTMLNode], source: String, truncated: Bool = false) {
        self.nodes = nodes; self.source = source; self.truncated = truncated
    }

    public var searchableText: String {
        nodes.flatMap(\.visibleTexts).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: " ")
    }

    public func tables() -> [NativeHTMLTable] {
        nodes.flatMap(\.tables)
    }
}

/// HTML → `NativeMarkdownTableView` conversion. `headers` / `rows` keep a
/// sanitized inline source so copy/export and the string cell path retain
/// strong/em/code/sup/sub/kbd/mark/link/math markup. `headerCells` / `rowCells`
/// are the same content as fragments (text stays text; tags are not reparsed).
public struct NativeHTMLTable: Equatable, Sendable {
    public var headers: [String]
    public var alignments: [MarkdownAlignment]
    public var rows: [[String]]
    public var headerCells: [[NativeInlineFragment]]
    public var rowCells: [[[NativeInlineFragment]]]

    public init(
        headers: [String],
        alignments: [MarkdownAlignment],
        rows: [[String]],
        headerCells: [[NativeInlineFragment]] = [],
        rowCells: [[[NativeInlineFragment]]] = []
    ) {
        self.headers = headers
        self.alignments = alignments
        self.rows = rows
        self.headerCells = headerCells
        self.rowCells = rowCells
    }
}

public enum NativeHTMLNode: Equatable, Sendable {
    case text(String)
    case element(NativeHTMLElement)
    case unsupported(String)
}

public struct NativeHTMLElement: Equatable, Sendable {
    public var name: NativeHTMLName
    public var children: [NativeHTMLNode]
    public var href: String?
    public var open: Bool
    public var rowspan: String?
    public var colspan: String?

    public init(
        name: NativeHTMLName,
        children: [NativeHTMLNode] = [],
        href: String? = nil,
        open: Bool = false,
        rowspan: String? = nil,
        colspan: String? = nil
    ) {
        self.name = name; self.children = children; self.href = href; self.open = open
        self.rowspan = rowspan; self.colspan = colspan
    }

    public var hasGridSpan: Bool { rowspan != nil || colspan != nil }
}

public enum NativeInlineFragment: Equatable, Sendable {
    case text(String)
    case html(node: NativeHTMLNode, source: String)
}

public enum NativeHTMLName: String, Equatable, Sendable {
    case details, summary
    case sup, sub, kbd, mark
    case strong, em, b, i, s, strike, del, ins, code, q, samp, tt
    case a, p, br, div, span, blockquote, pre
    case ul, ol, li, dl, dt, dd
    case table, thead, tbody, tfoot, tr, th, td
    case h1, h2, h3, h4, h5, h6, hr
    case variable = "var"

    public var isBlock: Bool {
        switch self {
        case .details, .p, .div, .blockquote, .pre, .ul, .ol, .li, .dl, .dt, .dd,
             .table, .thead, .tbody, .tfoot, .tr, .th, .td, .h1, .h2, .h3, .h4, .h5, .h6, .hr:
            return true
        default: return false
        }
    }
}

public enum NativeHTMLSyntax {
    public static let maxUTF8 = 64_000
    public static let maxNodes = 512
    public static let maxDepth = 8
    public static let maxSteps = 131_072

    public static func parse(_ source: String) -> NativeHTMLDocument {
        guard source.utf8.count <= maxUTF8 else {
            return NativeHTMLDocument(nodes: [.unsupported(source)], source: source, truncated: true)
        }
        var parser = Parser(source: source)
        return NativeHTMLDocument(nodes: parser.finish(parser.readNodes(until: nil, depth: 0)), source: source, truncated: parser.truncated)
    }

    public static func containsMarkup(_ source: String) -> Bool {
        guard source.contains("<"), source.utf8.count <= maxUTF8 * 2 else { return false }
        let scalars = Array(source.unicodeScalars)
        var index = 0
        while index < scalars.count {
            if scalars[index] == "<", let tag = tagName(scalars, at: index + 1), hasTagEnd(scalars, from: tag.next) {
                return true
            }
            index += 1
        }
        return false
    }

    public static func inlineFragments(_ source: String) -> [NativeInlineFragment] {
        guard source.utf8.count <= maxUTF8 else { return [.text(source)] }
        let scalars = Array(source.unicodeScalars)
        var fragments: [NativeInlineFragment] = []
        var index = 0
        var textStart = 0
        func flush(to end: Int) {
            if textStart < end {
                fragments.append(.text(String(String.UnicodeScalarView(scalars[textStart..<end]))))
            }
        }
        while index < scalars.count {
            if scalars[index] == "`" {
                index = skipCodeSpan(scalars, at: index)
                continue
            }
            if scalars[index] == "<", let taken = completeExtractable(in: source, at: index) {
                flush(to: index)
                fragments.append(.html(node: taken.node, source: taken.source))
                index = taken.end
                textStart = index
                continue
            }
            index += 1
        }
        flush(to: scalars.count)
        return fragments.isEmpty ? [.text(source)] : fragments
    }

    /// Structural serialization for cell source and honest table fallback.
    /// Text is emitted as parsed (entities already decoded); elements use
    /// bounded known names. Resource/active tags stay `.unsupported` source.
    public static func serialized(_ node: NativeHTMLNode) -> String {
        switch node {
        case .text(let value): return value
        case .unsupported(let source): return source
        case .element(let element):
            if element.name == .br { return "<br>" }
            let name = element.name.rawValue
            var attrs = ""
            if element.name == .a, let href = element.href {
                attrs += " href=\"\(escapeAttribute(href))\""
            }
            if let rowspan = element.rowspan { attrs += " rowspan=\"\(escapeAttribute(rowspan))\"" }
            if let colspan = element.colspan { attrs += " colspan=\"\(escapeAttribute(colspan))\"" }
            if void.contains(name) { return "<\(name)\(attrs)>" }
            return "<\(name)\(attrs)>\(element.children.map(serialized).joined())</\(name)>"
        }
    }

    public static func cellSource(_ nodes: [NativeHTMLNode]) -> String {
        nodes.map(serialized).joined()
    }

    public static func cellFragments(_ nodes: [NativeHTMLNode]) -> [NativeInlineFragment] {
        nodes.map { node in
            switch node {
            case .text(let value): return .text(value)
            case .unsupported(let source): return .html(node: node, source: source)
            case .element: return .html(node: node, source: serialized(node))
            }
        }
    }

    /// Nested tables and block structure cannot be shown as a cell. rowspan /
    /// colspan would produce an incorrect rectangular grid.
    public static func cellHasUnsupportedSemantics(_ nodes: [NativeHTMLNode]) -> Bool {
        nodes.contains { node in
            guard case .element(let element) = node else { return false }
            if element.hasGridSpan { return true }
            switch element.name {
            case .table, .ul, .ol, .details, .pre, .blockquote, .hr, .dl,
                 .thead, .tbody, .tfoot, .tr, .th, .td, .h1, .h2, .h3, .h4, .h5, .h6:
                return true
            default:
                return cellHasUnsupportedSemantics(element.children)
            }
        }
    }

    fileprivate static func escapeAttribute(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    public static func reconstructed(_ fragments: [NativeInlineFragment]) -> String {
        fragments.map { fragment in
            switch fragment {
            case .text(let value): return value
            case .html(_, let source): return source
            }
        }.joined()
    }

    /// Emphasis, code, or a link opened in one text run and closed after an HTML
    /// node cannot be rendered without inventing a wrapper. Callers show source.
    public static func markdownCrossesHTML(_ fragments: [NativeInlineFragment]) -> Bool {
        var bold = false, italic = false, code = 0, link = 0
        for fragment in fragments {
            guard case .text(let text) = fragment else {
                if bold || italic || code > 0 || link > 0 { return true }
                continue
            }
            let chars = Array(text)
            var index = 0
            while index < chars.count {
                if chars[index] == "\\" { index = min(chars.count, index + 2); continue }
                if chars[index] == "`" {
                    var end = index
                    while end < chars.count, chars[end] == "`" { end += 1 }
                    let count = end - index
                    if code == 0 { code = count }
                    else if code == count { code = 0 }
                    index = end
                    continue
                }
                if code > 0 { index += 1; continue }
                if chars[index] == "[", link == 0 { link = 1; index += 1; continue }
                if chars[index] == "]", index + 1 < chars.count, chars[index + 1] == "(", link == 1 {
                    link = 2
                    index += 2
                    var depth = 1
                    while index < chars.count, depth > 0 {
                        if chars[index] == "\\" { index = min(chars.count, index + 2); continue }
                        if chars[index] == "(" { depth += 1 }
                        if chars[index] == ")" { depth -= 1 }
                        index += 1
                    }
                    if depth == 0 { link = 0 }
                    continue
                }
                if index + 1 < chars.count, chars[index] == "*", chars[index + 1] == "*" {
                    bold.toggle(); index += 2; continue
                }
                if chars[index] == "*" || chars[index] == "_" { italic.toggle() }
                index += 1
            }
        }
        return false
    }

    public static func linkURL(_ raw: String) -> URL? {
        let href = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !href.isEmpty, let url = URL(string: href) else { return nil }
        if NativeMichiReference.parse(href) != nil { return url }
        return MarkdownDocument.safeLink(url) ? url : nil
    }

    fileprivate static let void: Set<String> = ["br", "hr", "img", "input", "source", "wbr", "meta", "link", "area", "col", "embed", "base"]
    fileprivate static let extractableInline: Set<String> = [
        "sup", "sub", "kbd", "mark", "strong", "em", "b", "i", "s", "strike", "del", "ins",
        "code", "q", "samp", "tt", "var", "a", "span", "br"
    ]
    fileprivate static let extractableBlock: Set<String> = ["table"]
    fileprivate static let resource: Set<String> = [
        "script", "style", "iframe", "object", "embed", "applet", "link", "meta", "base",
        "svg", "math", "video", "audio", "source", "track", "canvas", "template", "noscript",
        "img", "picture", "form", "input", "button", "textarea", "select", "option"
    ]
    fileprivate static let block: Set<String> = [
        "details", "summary", "ul", "ol", "dl", "table", "thead", "tbody", "tfoot", "tr",
        "blockquote", "div", "section", "pre", "p", "script", "style", "iframe", "object",
        "embed", "h1", "h2", "h3", "h4", "h5", "h6", "hr"
    ]

    static var htmlBlockNames: Set<String> { block }

    fileprivate static func tagName(_ scalars: [Unicode.Scalar], at start: Int) -> (name: String, next: Int, closing: Bool)? {
        var index = start
        var closing = false
        if index < scalars.count, scalars[index] == "/" { closing = true; index += 1 }
        guard index < scalars.count, isNameStart(scalars[index]) else { return nil }
        let begin = index
        index += 1
        while index < scalars.count, isName(scalars[index]) { index += 1 }
        let name = String(String.UnicodeScalarView(scalars[begin..<index])).lowercased()
        guard index < scalars.count, isTagBoundary(scalars[index]) else { return nil }
        return (name, index, closing)
    }

    fileprivate static func isTagBoundary(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "/" || scalar == ">" || [9, 10, 13, 32].contains(Int(scalar.value))
    }

    fileprivate static func hasTagEnd(_ scalars: [Unicode.Scalar], from start: Int) -> Bool {
        var index = start, steps = 0
        while index < scalars.count, steps < 4_096 {
            if scalars[index] == ">" { return true }
            index += 1
            steps += 1
        }
        return false
    }

    fileprivate static func skipCodeSpan(_ scalars: [Unicode.Scalar], at start: Int) -> Int {
        var end = start
        while end < scalars.count, scalars[end] == "`" { end += 1 }
        let count = end - start
        var cursor = end
        while cursor < scalars.count {
            guard scalars[cursor] == "`" else { cursor += 1; continue }
            let runStart = cursor
            var close = cursor
            while close < scalars.count, scalars[close] == "`" { close += 1 }
            cursor = close
            if close - runStart == count { return cursor }
        }
        return start + 1
    }

    fileprivate static func completeExtractable(in source: String, at start: Int) -> (node: NativeHTMLNode, end: Int, source: String)? {
        var parser = Parser(source: source)
        parser.index = start
        guard let node = parser.readCompleteExtractable() else { return nil }
        return (node, parser.index, String(String.UnicodeScalarView(parser.scalars[start..<parser.index])))
    }

    fileprivate static func isNameStart(_ scalar: Unicode.Scalar) -> Bool {
        (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
    }
    fileprivate static func isName(_ scalar: Unicode.Scalar) -> Bool {
        isNameStart(scalar) || (48...57).contains(scalar.value) || scalar == "-"
    }
}

private struct Parser {
    let scalars: [Unicode.Scalar]
    var index: Int = 0
    var steps = 0
    var nodeCount = 0
    var truncated = false

    init(source: String) { scalars = Array(source.unicodeScalars) }

    mutating func finish(_ nodes: [NativeHTMLNode]) -> [NativeHTMLNode] {
        nodes.isEmpty && !scalars.isEmpty ? [.text(decode(ArraySlice(scalars)))] : nodes
    }

    mutating func readNodes(until stop: String?, depth: Int) -> [NativeHTMLNode] {
        var nodes: [NativeHTMLNode] = []
        while index < scalars.count, steps < NativeHTMLSyntax.maxSteps, nodeCount < NativeHTMLSyntax.maxNodes {
            steps += 1
            if scalars[index] == "<" {
                if let comment = readComment() {
                    appendUnsupported(comment, into: &nodes)
                    continue
                }
                if let special = readDeclaration() {
                    appendUnsupported(special, into: &nodes)
                    continue
                }
                if let tag = NativeHTMLSyntax.tagName(scalars, at: index + 1) {
                    if tag.closing {
                        if let stop, tag.name == stop { return nodes }
                        appendUnsupported(readThroughTag(), into: &nodes)
                        continue
                    }
                    if depth >= NativeHTMLSyntax.maxDepth || nodeCount >= NativeHTMLSyntax.maxNodes {
                        truncated = true
                        appendUnsupported(readThroughMatching(tag.name), into: &nodes)
                        continue
                    }
                    let elementStart = index
                    if let element = readElement(tag: tag, depth: depth) {
                        // Children can exhaust the budget before their parent
                        // is appended. Keep that parent's complete source;
                        // appending only the unread tail would lose its content.
                        if nodeCount >= NativeHTMLSyntax.maxNodes {
                            truncated = true
                            appendUnsupported(ArraySlice(scalars[elementStart...]), into: &nodes)
                            index = scalars.count
                            return nodes
                        }
                        append(element, into: &nodes)
                        continue
                    }
                }
                append(.text("<"), into: &nodes)
                index += 1
                continue
            }
            let text = readText()
            if !text.isEmpty { append(.text(decode(text)), into: &nodes) }
        }
        if index < scalars.count {
            truncated = true
            appendUnsupported(ArraySlice(scalars[index...]), into: &nodes)
            index = scalars.count
        }
        return nodes
    }

    mutating func readCompleteExtractable() -> NativeHTMLNode? {
        let start = index
        let saved = (steps, nodeCount, truncated)
        func restore() {
            index = start
            (steps, nodeCount, truncated) = saved
        }
        guard index < scalars.count, scalars[index] == "<",
              let tag = NativeHTMLSyntax.tagName(scalars, at: index + 1), !tag.closing,
              NativeHTMLSyntax.extractableInline.contains(tag.name) || NativeHTMLSyntax.extractableBlock.contains(tag.name)
        else { return nil }
        index = tag.next
        let attributes = readAttributes()
        let selfClosing = consume("/")
        guard consume(">") else { restore(); return nil }
        if NativeHTMLSyntax.resource.contains(tag.name) { restore(); return nil }
        guard let name = NativeHTMLName(rawValue: tag.name) else { restore(); return nil }
        var children: [NativeHTMLNode] = []
        if !selfClosing, !NativeHTMLSyntax.void.contains(tag.name) {
            children = readNodes(until: tag.name, depth: 1)
            guard index < scalars.count, scalars[index] == "<",
                  let closer = NativeHTMLSyntax.tagName(scalars, at: index + 1),
                  closer.closing, closer.name == tag.name
            else { restore(); return nil }
            index = closer.next
            skipSpaces()
            _ = consume("/")
            guard consume(">") else { restore(); return nil }
        }
        var href = attributes["href"]
        if name == .a, let value = href, NativeHTMLSyntax.linkURL(value) == nil { href = nil }
        if name != .a { href = nil }
        return .element(.init(
            name: name,
            children: children,
            href: href,
            open: name == .details && attributes["open"] != nil,
            rowspan: attributes["rowspan"],
            colspan: attributes["colspan"]
        ))
    }

    mutating func readElement(tag: (name: String, next: Int, closing: Bool), depth: Int) -> NativeHTMLNode? {
        let start = index
        index = tag.next
        let attributes = readAttributes()
        let selfClosing = consume("/")
        guard consume(">") else {
            index = start
            return nil
        }
        if NativeHTMLSyntax.resource.contains(tag.name) || NativeHTMLName(rawValue: tag.name) == nil {
            if !selfClosing, !NativeHTMLSyntax.void.contains(tag.name) {
                _ = readThroughMatchingFromCurrent(tag.name)
            }
            return .unsupported(slice(start, index))
        }
        guard let name = NativeHTMLName(rawValue: tag.name) else { return .unsupported(slice(start, index)) }
        var children: [NativeHTMLNode] = []
        if !selfClosing, !NativeHTMLSyntax.void.contains(tag.name) {
            children = readNodes(until: tag.name, depth: depth + 1)
            if index < scalars.count, scalars[index] == "<",
               let closer = NativeHTMLSyntax.tagName(scalars, at: index + 1), closer.closing, closer.name == tag.name {
                index = closer.next
                skipSpaces()
                _ = consume("/")
                _ = consume(">")
            }
        }
        var href = attributes["href"]
        if name == .a, let value = href, NativeHTMLSyntax.linkURL(value) == nil { href = nil }
        if name != .a { href = nil }
        return .element(.init(
            name: name,
            children: children,
            href: href,
            open: name == .details && attributes["open"] != nil,
            rowspan: attributes["rowspan"],
            colspan: attributes["colspan"]
        ))
    }

    mutating func readAttributes() -> [String: String] {
        var values: [String: String] = [:]
        while index < scalars.count {
            skipSpaces()
            guard index < scalars.count, NativeHTMLSyntax.isNameStart(scalars[index]) else { break }
            let begin = index
            index += 1
            while index < scalars.count, NativeHTMLSyntax.isName(scalars[index]) || scalars[index] == ":" { index += 1 }
            let rawName = String(String.UnicodeScalarView(scalars[begin..<index]))
            let name = rawName.lowercased()
            skipSpaces()
            var value = ""
            if consume("=") {
                skipSpaces()
                if index < scalars.count, scalars[index] == "\"" || scalars[index] == "'" {
                    let quote = scalars[index]; index += 1
                    let contentStart = index
                    while index < scalars.count, scalars[index] != quote { index += 1 }
                    value = decode(ArraySlice(scalars[contentStart..<index]))
                    if index < scalars.count { index += 1 }
                } else {
                    let contentStart = index
                    while index < scalars.count, !isSpace(scalars[index]), scalars[index] != ">" { index += 1 }
                    value = decode(ArraySlice(scalars[contentStart..<index]))
                }
            } else { value = name }
            if name.hasPrefix("on") || ["src", "srcset", "poster", "style", "action", "formaction", "xlink:href"].contains(name) { continue }
            if values.count < 32 { values[name] = value }
        }
        skipSpaces()
        return values
    }

    mutating func readText() -> ArraySlice<Unicode.Scalar> {
        let start = index
        while index < scalars.count, scalars[index] != "<" { index += 1 }
        return ArraySlice(scalars[start..<index])
    }

    mutating func readComment() -> ArraySlice<Unicode.Scalar>? {
        guard match("<!--") else { return nil }
        let start = index - 4
        while index + 2 < scalars.count, !(scalars[index] == "-" && scalars[index + 1] == "-" && scalars[index + 2] == ">") { index += 1 }
        if index + 2 < scalars.count { index += 3 } else { index = scalars.count }
        return ArraySlice(scalars[start..<index])
    }

    mutating func readDeclaration() -> ArraySlice<Unicode.Scalar>? {
        guard index + 1 < scalars.count, scalars[index] == "<", scalars[index + 1] == "!" || scalars[index + 1] == "?" else { return nil }
        return readThroughTag()
    }

    mutating func readThroughTag() -> ArraySlice<Unicode.Scalar> {
        let start = index
        index += 1
        while index < scalars.count, scalars[index] != ">" { index += 1 }
        if index < scalars.count { index += 1 }
        return ArraySlice(scalars[start..<index])
    }

    mutating func readThroughMatching(_ name: String) -> ArraySlice<Unicode.Scalar> {
        let start = index
        _ = readThroughTag()
        if !NativeHTMLSyntax.void.contains(name) { _ = readThroughMatchingFromCurrent(name) }
        return ArraySlice(scalars[start..<index])
    }

    mutating func readThroughMatchingFromCurrent(_ name: String) -> ArraySlice<Unicode.Scalar> {
        let start = index
        var depth = 1
        while index < scalars.count, depth > 0, steps < NativeHTMLSyntax.maxSteps {
            steps += 1
            guard scalars[index] == "<", let tag = NativeHTMLSyntax.tagName(scalars, at: index + 1) else {
                index += 1; continue
            }
            let open = index
            index = tag.next
            _ = readAttributes()
            let selfClosing = consume("/")
            _ = consume(">")
            if tag.name != name { continue }
            if tag.closing { depth -= 1 }
            else if !selfClosing, !NativeHTMLSyntax.void.contains(name) { depth += 1 }
            if depth == 0 { return ArraySlice(scalars[open..<index]) }
        }
        truncated = true
        return ArraySlice(scalars[start..<index])
    }

    mutating func append(_ node: NativeHTMLNode, into nodes: inout [NativeHTMLNode]) {
        if case .text(let value) = node, case .text(let existing) = nodes.last {
            nodes[nodes.count - 1] = .text(existing + value)
            return
        }
        guard nodeCount < NativeHTMLSyntax.maxNodes else {
            truncated = true
            placeUnsupported(String(String.UnicodeScalarView(ArraySlice(scalars[index...]))), into: &nodes)
            index = scalars.count
            return
        }
        nodeCount += 1
        nodes.append(node)
    }

    mutating func appendUnsupported(_ slice: ArraySlice<Unicode.Scalar>, into nodes: inout [NativeHTMLNode]) {
        placeUnsupported(String(String.UnicodeScalarView(slice)), into: &nodes)
    }

    /// Remainder / unsupported source is coalesced or placed directly. Never
    /// re-enters `append`, which would recurse once `nodeCount` is at the cap.
    mutating func placeUnsupported(_ text: String, into nodes: inout [NativeHTMLNode]) {
        guard !text.isEmpty else { return }
        if case .unsupported(let existing) = nodes.last {
            nodes[nodes.count - 1] = .unsupported(existing + text)
            return
        }
        if nodeCount < NativeHTMLSyntax.maxNodes {
            nodeCount += 1
            nodes.append(.unsupported(text))
            return
        }
        truncated = true
        nodes.append(.unsupported(text))
    }

    mutating func consume(_ text: String) -> Bool {
        let tokens = Array(text.unicodeScalars)
        guard index + tokens.count <= scalars.count, Array(scalars[index..<(index + tokens.count)]) == tokens else { return false }
        index += tokens.count
        return true
    }
    mutating func match(_ text: String) -> Bool {
        let tokens = Array(text.unicodeScalars)
        guard index + tokens.count <= scalars.count, Array(scalars[index..<(index + tokens.count)]) == tokens else { return false }
        index += tokens.count
        return true
    }
    mutating func skipSpaces() {
        while index < scalars.count, isSpace(scalars[index]) { index += 1 }
    }
    func isSpace(_ scalar: Unicode.Scalar) -> Bool { [9, 10, 13, 32].contains(Int(scalar.value)) }
    func slice(_ start: Int, _ end: Int) -> String { String(String.UnicodeScalarView(scalars[start..<end])) }
    func decode(_ slice: ArraySlice<Unicode.Scalar>) -> String {
        NativeHTMLSyntax.decodeEntities(String(String.UnicodeScalarView(slice)))
    }
}

extension NativeHTMLSyntax {
    fileprivate static let namedEntities: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{00A0}"
    ]

    static func decodeEntities(_ text: String) -> String {
        guard text.contains("&") else { return text }
        var result = "", index = text.startIndex
        while index < text.endIndex {
            if text[index] == "&", let end = text[index...].firstIndex(of: ";"),
               text.distance(from: index, to: end) <= 12 {
                let body = text[text.index(after: index)..<end]
                if let named = namedEntities[String(body)] {
                    result += named; index = text.index(after: end); continue
                }
                if body.first == "#", body.count > 1 {
                    let digits = body.dropFirst()
                    let value: UInt32?
                    if digits.first == "x" || digits.first == "X" { value = UInt32(digits.dropFirst(), radix: 16) }
                    else { value = UInt32(digits, radix: 10) }
                    if let value, value != 0, let scalar = Unicode.Scalar(value), !CharacterSet.controlCharacters.contains(scalar) || [9, 10, 13].contains(Int(value)) {
                        result.unicodeScalars.append(scalar); index = text.index(after: end); continue
                    }
                }
            }
            result.append(text[index]); index = text.index(after: index)
        }
        return result
    }
}

extension NativeHTMLNode {
    var visibleTexts: [String] {
        switch self {
        case .text(let value): return [value]
        case .element(let element): return element.children.flatMap(\.visibleTexts)
        case .unsupported: return []
        }
    }

    var tables: [NativeHTMLTable] {
        switch self {
        case .element(let element) where element.name == .table:
            if let table = NativeHTMLSyntax.convertedTable(element) { return [table] }
            return []
        case .element(let element): return element.children.flatMap(\.tables)
        default: return []
        }
    }
}

extension NativeHTMLSyntax {
    /// Rectangular native table, or `nil` when first-row promotion / spans /
    /// nested tables would lie about the source.
    public static func convertedTable(_ table: NativeHTMLElement) -> NativeHTMLTable? {
        struct Row { var cells: [Cell]; var isHeader: Bool }
        struct Cell { var nodes: [NativeHTMLNode]; var isTH: Bool }

        func cells(in row: NativeHTMLElement) -> [Cell]? {
            var result: [Cell] = []
            for child in row.children {
                guard case .element(let cell) = child, cell.name == .th || cell.name == .td else { continue }
                if cell.hasGridSpan || cellHasUnsupportedSemantics(cell.children) { return nil }
                result.append(Cell(nodes: cell.children, isTH: cell.name == .th))
            }
            return result
        }

        func rows(in nodes: [NativeHTMLNode], header: Bool?) -> [Row]? {
            var result: [Row] = []
            for node in nodes {
                guard case .element(let element) = node else { continue }
                if element.name == .tr {
                    guard let cells = cells(in: element) else { return nil }
                    let isHeader = header ?? (!cells.isEmpty && cells.allSatisfy(\.isTH))
                    result.append(Row(cells: cells, isHeader: isHeader))
                } else if [.thead, .tbody, .tfoot].contains(element.name) {
                    guard let nested = rows(in: element.children, header: element.name == .thead ? true : nil) else { return nil }
                    result.append(contentsOf: nested)
                }
            }
            return result
        }

        guard let extracted = rows(in: table.children, header: nil),
              let first = extracted.first, !first.cells.isEmpty,
              first.cells.count <= 20, extracted.count <= 301
        else { return nil }

        let width = first.cells.count
        let useHeader = first.isHeader
        let headerRow = useHeader ? first : nil
        let data = useHeader ? Array(extracted.dropFirst()) : extracted

        func pad(_ cells: [Cell]) -> [Cell] {
            cells + Array(repeating: Cell(nodes: [], isTH: false), count: max(0, width - cells.count))
        }
        func sources(_ cells: [Cell]) -> [String] { pad(cells).map { cellSource($0.nodes) } }
        func fragments(_ cells: [Cell]) -> [[NativeInlineFragment]] { pad(cells).map { cellFragments($0.nodes) } }

        return NativeHTMLTable(
            headers: headerRow.map { sources($0.cells) } ?? [],
            alignments: Array(repeating: .leading, count: width),
            rows: data.map { sources($0.cells) },
            headerCells: headerRow.map { fragments($0.cells) } ?? [],
            rowCells: data.map { fragments($0.cells) }
        )
    }
}

extension MarkdownDocument {
    static func htmlBlock(_ lines: [String], at start: Int) -> (NativeHTMLDocument, Int)? {
        guard htmlIndent(lines[start]) <= 3 else { return nil }
        let value = lines[start].drop(while: { $0 == " " || $0 == "\t" })
        guard value.first == "<", let name = htmlTagName(String(value)), NativeHTMLSyntax.htmlBlockNames.contains(name) else { return nil }
        if NativeHTMLSyntax.void.contains(name) || htmlSelfContained(String(value), name: name) {
            return (NativeHTMLSyntax.parse(lines[start]), start + 1)
        }
        var body = [lines[start]], bytes = lines[start].utf8.count, depth = htmlDelta(lines[start], name: name)
        guard depth > 0 else { return (NativeHTMLSyntax.parse(lines[start]), start + 1) }
        for end in (start + 1)..<min(lines.count, start + 257) {
            bytes += lines[end].utf8.count
            guard bytes <= 16_384 else { return nil }
            body.append(lines[end])
            depth += htmlDelta(lines[end], name: name)
            if depth <= 0 { return (NativeHTMLSyntax.parse(body.joined(separator: "\n")), end + 1) }
        }
        return nil
    }

    private static func htmlIndent(_ line: String) -> Int {
        line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
    }

    private static func htmlTagName(_ line: String) -> String? {
        NativeHTMLSyntax.tagName(Array(line.unicodeScalars), at: 1)?.name
    }

    private static func htmlSelfContained(_ line: String, name: String) -> Bool {
        htmlDelta(line, name: name) <= 0 && line.lowercased().contains("</\(name)>")
    }

    private static func htmlDelta(_ line: String, name: String) -> Int {
        let scalars = Array(line.unicodeScalars)
        var index = 0, depth = 0
        while index < scalars.count {
            if scalars[index] == "<", let tag = NativeHTMLSyntax.tagName(scalars, at: index + 1), tag.name == name {
                depth += tag.closing ? -1 : 1
                index = tag.next
            } else { index += 1 }
        }
        return depth
    }
}

public enum NativeMarkdownTableOrder {
    /// Depth-first table count used by NativeMarkdown and the catalog walker:
    /// Markdown `.table`, quoted nested tables, and `.html` tables including
    /// those nested in details. Row contents are not part of the identity.
    public static func count(in blocks: [MarkdownBlock]) -> Int {
        blocks.reduce(0) { partial, block in
            switch block {
            case .table: return partial + 1
            case .quote(let nested): return partial + count(in: nested)
            case .html(let document): return partial + count(in: document.nodes)
            default: return partial
            }
        }
    }

    public static func count(before offset: Int, in blocks: [MarkdownBlock]) -> Int {
        offset <= 0 ? 0 : count(in: Array(blocks.prefix(offset)))
    }

    public static func count(in nodes: [NativeHTMLNode]) -> Int {
        nodes.reduce(0) { $0 + count(in: $1) }
    }

    public static func count(in node: NativeHTMLNode) -> Int {
        switch node {
        case .element(let element) where element.name == .table: return 1
        case .element(let element): return count(in: element.children)
        default: return 0
        }
    }

    public static func index(ofTableAt path: [Int], in nodes: [NativeHTMLNode]) -> Int? {
        var ordinal = 0
        func walk(_ nodes: [NativeHTMLNode], prefix: [Int]) -> Int? {
            for (offset, node) in nodes.enumerated() {
                let here = prefix + [offset]
                guard case .element(let element) = node else { continue }
                if element.name == .table {
                    if here == path { return ordinal }
                    ordinal += 1
                } else if let found = walk(element.children, prefix: here) {
                    return found
                }
            }
            return nil
        }
        return walk(nodes, prefix: [])
    }
}
