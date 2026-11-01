import Foundation

/// A bounded block parser for the native transcript. Unsupported syntax remains
/// readable text; it is never handed to a web renderer or an executable format.
public struct MarkdownDocument: Equatable, Sendable {
    public var blocks: [MarkdownBlock]
    public init(_ text: String) {
        guard text.utf8.count <= 1_048_576 else { blocks = [.literal(text)]; return }
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        guard lines.count <= 6_000 else { blocks = [.literal(text)]; return }
        blocks = Self.parse(lines, depth: 0)
    }

    /// Page blocks already contain diagram source. Never re-wrap it in a
    /// Markdown fence: an embedded fence must remain source, not escape into UI.
    public static func mermaidBlock(_ source: String) -> MarkdownBlock {
        if let graph = MarkdownFlowchart.parse(source) { return .flowchart(graph) }
        if let diagram = MarkdownSequenceDiagram.parse(source) { return .sequenceDiagram(diagram) }
        if let diagram = MarkdownStateDiagram.parse(source) { return .stateDiagram(diagram) }
        if let diagram = MarkdownClassDiagram.parse(source) { return .classDiagram(diagram) }
        if let diagram = MarkdownERDiagram.parse(source) { return .erDiagram(diagram) }
        if let diagram = MarkdownPieChart.parse(source) { return .pieChart(diagram) }
        return .code(language: "mermaid", text: source)
    }

    public static func safeLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return false }
        return !url.absoluteString.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    private static func parse(_ lines: [String], depth: Int) -> [MarkdownBlock] {
        guard depth < 8 else { return [.literal(lines.joined(separator: "\n"))] }
        var blocks: [MarkdownBlock] = [], i = 0
        while i < lines.count {
            if blocks.count >= 1_000 { blocks.append(.literal(lines[i...].joined(separator: "\n"))); break }
            let line = lines[i], trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { i += 1; continue }
            if let fence = openingFence(line) {
                i += 1; var body: [String] = []
                while i < lines.count, !closesFence(lines[i], fence: fence) { body.append(lines[i]); i += 1 }
                if i < lines.count { i += 1 }
                let code = body.joined(separator: "\n")
                if fence.language.lowercased() == "mermaid" { blocks.append(Self.mermaidBlock(code)) }
                else { blocks.append(.code(language: fence.language, text: code)) }
                continue
            }
            if let math = displayMath(lines, at: i) { blocks.append(.math(math.expression)); i = math.next; continue }
            if let html = htmlBlock(lines, at: i) { blocks.append(.html(html.0)); i = html.1; continue }
            if let heading = heading(line) { blocks.append(.heading(level: heading.0, text: heading.1)); i += 1; continue }
            if horizontalRule(trimmed) { blocks.append(.rule); i += 1; continue }
            if quoteLine(line) != nil {
                var quote: [String] = []
                while i < lines.count, let text = quoteLine(lines[i]) { quote.append(text); i += 1 }
                blocks.append(.quote(parse(quote, depth: depth + 1))); continue
            }
            if let item = listLine(line) {
                var text = item.text; i += 1
                // Continuations are indented content, not a new nested item.
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty,
                      indentation(lines[i]) > item.indent, listLine(lines[i]) == nil,
                      openingFence(lines[i]) == nil, quoteLine(lines[i]) == nil {
                    text += "\n" + lines[i].trimmingCharacters(in: .whitespaces); i += 1
                }
                blocks.append(.listItem(marker: item.marker, text: text, depth: min(8, item.indent / 2), checked: item.checked)); continue
            }
            if indentation(line) >= 4 {
                var code: [String] = []
                while i < lines.count, indentation(lines[i]) >= 4 || lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    let source = lines[i]
                    if source.hasPrefix("\t") { code.append(String(source.dropFirst())) }
                    else { code.append(String(source.dropFirst(min(4, source.prefix(while: { $0 == " " }).count)))) }
                    i += 1
                }
                while code.last?.isEmpty == true { code.removeLast() }
                blocks.append(.code(language: "", text: code.joined(separator: "\n"))); continue
            }
            if i + 1 < lines.count, let table = tableHeader(line, separator: lines[i + 1]) {
                i += 2; var rows: [[String]] = []
                while i < lines.count, rows.count < 300, lines[i].unicodeScalars.contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    let cells = tableCells(lines[i])
                    // Never discard an extra cell just to fit a malformed row.
                    guard cells.count <= table.headers.count else { break }
                    rows.append(cells + Array(repeating: "", count: table.headers.count - cells.count)); i += 1
                }
                blocks.append(.table(headers: table.headers, alignments: table.alignments, rows: rows)); continue
            }
            // Setext headers require a non-structural preceding line.
            if i + 1 < lines.count, let level = setextLevel(lines[i + 1]) {
                blocks.append(.heading(level: level, text: trimmed)); i += 2; continue
            }
            var paragraph = [line]; i += 1
            while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                let next = lines[i], nextTrimmed = next.trimmingCharacters(in: .whitespaces)
                if openingFence(next) != nil || heading(next) != nil || horizontalRule(nextTrimmed) || quoteLine(next) != nil || listLine(next) != nil || displayMath(lines, at: i) != nil || htmlBlock(lines, at: i) != nil { break }
                if i + 1 < lines.count, tableHeader(next, separator: lines[i + 1]) != nil || setextLevel(lines[i + 1]) != nil { break }
                paragraph.append(next); i += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
    }

    private static func displayMath(_ lines: [String], at start: Int) -> (expression: MathExpression, next: Int)? {
        guard indentation(lines[start]) <= 3 else { return nil }
        let opening = lines[start].trimmingCharacters(in: .whitespaces)
        guard opening.hasPrefix("$$") || opening.hasPrefix("\\[") else { return nil }
        if case .math(let expression)? = NativeMathSyntax.inline(opening).only,
           expression.display, expression.source == opening {
            return (MathExpression(tex: expression.tex, source: lines[start], display: true), start + 1)
        }
        let closing = opening.hasPrefix("$$") ? "$$" : "\\]"
        // A closer followed by punctuation belongs to inline parsing. Do not
        // consume a later, unrelated display block as this line's closer.
        guard !opening.dropFirst(2).contains(closing) else { return nil }
        var body = [String(opening.dropFirst(2))], byteCount = opening.utf8.count
        guard start + 1 < lines.count else { return nil }
        for end in (start + 1)..<min(lines.count, start + 257) {
            byteCount += lines[end].utf8.count
            guard byteCount <= 16_384 else { return nil }
            if lines[end].trimmingCharacters(in: .whitespaces) == closing, indentation(lines[end]) <= 3 {
                return (MathExpression(tex: body.joined(separator: "\n"), source: lines[start...end].joined(separator: "\n"), display: true), end + 1)
            }
            body.append(lines[end])
        }
        return nil
    }

    private struct Fence { let marker: Character; let count: Int; let language: String }
    private static func openingFence(_ line: String) -> Fence? {
        guard indentation(line) <= 3 else { return nil }
        let value = line.drop(while: { $0 == " " })
        guard let marker = value.first, marker == "`" || marker == "~" else { return nil }
        let count = value.prefix(while: { $0 == marker }).count
        guard count >= 3 else { return nil }
        let info = value.dropFirst(count).trimmingCharacters(in: .whitespaces)
        if marker == "`", info.contains("`") { return nil }
        return Fence(marker: marker, count: count, language: String(info.prefix(120)))
    }
    private static func closesFence(_ line: String, fence: Fence) -> Bool {
        guard indentation(line) <= 3 else { return false }
        let value = line.trimmingCharacters(in: .whitespaces)
        return value.count >= fence.count && value.allSatisfy { $0 == fence.marker }
    }
    private static func indentation(_ line: String) -> Int {
        line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
    }
    private static func heading(_ line: String) -> (Int, String)? {
        guard indentation(line) <= 3 else { return nil }
        let value = line.drop(while: { $0 == " " }), count = value.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(count) else { return nil }
        let suffix = value.dropFirst(count)
        guard suffix.isEmpty || suffix.first == " " || suffix.first == "\t" else { return nil }
        var text = suffix.trimmingCharacters(in: .whitespaces)
        if let range = text.range(of: #"[ \t]+#+[ \t]*$"#, options: .regularExpression) { text.removeSubrange(range) }
        return (count, text)
    }
    private static func horizontalRule(_ line: String) -> Bool {
        let compact = line.filter { $0 != " " && $0 != "\t" }
        guard compact.count >= 3, let marker = compact.first, ["-", "*", "_"].contains(marker) else { return false }
        return compact.allSatisfy { $0 == marker }
    }
    private static func setextLevel(_ line: String) -> Int? {
        guard indentation(line) <= 3 else { return nil }
        let text = line.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        if text.allSatisfy({ $0 == "=" }) { return 1 }
        if text.allSatisfy({ $0 == "-" }) { return 2 }
        return nil
    }
    private static func quoteLine(_ line: String) -> String? {
        guard indentation(line) <= 3 else { return nil }
        let value = line.drop(while: { $0 == " " })
        guard value.first == ">" else { return nil }
        let rest = value.dropFirst()
        return String(rest.first == " " ? rest.dropFirst() : rest)
    }
    private struct ListLine { let marker: String; let text: String; let indent: Int; let checked: Bool? }
    private static let listPattern = try! NSRegularExpression(pattern: #"^([ \t]*)([-+*]|[0-9]{1,9}[.)])[ \t]+(.*)$"#)
    private static func listLine(_ line: String) -> ListLine? {
        guard let match = listPattern.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let markerRange = Range(match.range(at: 2), in: line), let textRange = Range(match.range(at: 3), in: line) else { return nil }
        let marker = String(line[markerRange]); var text = String(line[textRange]); var checked: Bool?
        if text.hasPrefix("[ ] ") || text.hasPrefix("[x] ") || text.hasPrefix("[X] ") {
            checked = !text.hasPrefix("[ ] "); text = String(text.dropFirst(4))
        }
        return ListLine(marker: ["-", "+", "*"].contains(marker) ? "•" : marker, text: text, indent: indentation(line), checked: checked)
    }
    private static func tableHeader(_ line: String, separator: String) -> (headers: [String], alignments: [MarkdownAlignment])? {
        guard line.unicodeScalars.contains("|") else { return nil }
        let headers = tableCells(line), delimiters = tableCells(separator)
        guard !headers.isEmpty, headers.count <= 20, headers.count == delimiters.count else { return nil }
        var alignments: [MarkdownAlignment] = []
        for delimiter in delimiters {
            let value = delimiter.trimmingCharacters(in: .whitespaces)
            guard value.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil else { return nil }
            alignments.append(value.hasPrefix(":") && value.hasSuffix(":") ? .center : value.hasSuffix(":") ? .trailing : .leading)
        }
        return (headers, alignments)
    }
    /// Pipes escaped by a backslash or enclosed in an inline-code span are cell content.
    private static func tableCells(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var cells: [String] = [], current = "", codeTicks = 0, endedWithDelimiter = false
        let chars = Array(trimmed.unicodeScalars); var index = 0
        while index < chars.count {
            let char = chars[index]
            endedWithDelimiter = false
            if char == "\\" {
                // Only unescape the table delimiter; retain all other Markdown escapes.
                if index + 1 < chars.count, chars[index + 1] == "|" { current.append("|"); index += 2; continue }
                if index + 1 < chars.count, chars[index + 1] == "\\" { current += "\\\\"; index += 2; continue }
                current.unicodeScalars.append(char)
                index += 1; continue
            }
            if char == "`" {
                var end = index
                while end < chars.count, chars[end] == "`" { end += 1 }
                let count = end - index
                if codeTicks == 0 { codeTicks = count } else if codeTicks == count { codeTicks = 0 }
                current += String(repeating: "`", count: count); index = end; continue
            }
            if char == "|", codeTicks == 0 { cells.append(current.trimmingCharacters(in: .whitespaces)); current = ""; endedWithDelimiter = true }
            else { current.unicodeScalars.append(char) }
            index += 1
        }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        if trimmed.unicodeScalars.first == "|", cells.first?.isEmpty == true { cells.removeFirst() }
        if endedWithDelimiter, cells.last?.isEmpty == true { cells.removeLast() }
        return cells
    }
}

public enum MarkdownAlignment: Equatable, Sendable { case leading, center, trailing }
public indirect enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String), heading(level: Int, text: String)
    case listItem(marker: String, text: String, depth: Int, checked: Bool?)
    case quote([MarkdownBlock]), rule
    case code(language: String, text: String), literal(String)
    case table(headers: [String], alignments: [MarkdownAlignment], rows: [[String]])
    case flowchart(MarkdownFlowchart)
    case sequenceDiagram(MarkdownSequenceDiagram), stateDiagram(MarkdownStateDiagram)
    case classDiagram(MarkdownClassDiagram), erDiagram(MarkdownERDiagram), pieChart(MarkdownPieChart)
    case math(MathExpression)
    case html(NativeHTMLDocument)
}

private extension Array {
    var only: Element? { count == 1 ? first : nil }
}
