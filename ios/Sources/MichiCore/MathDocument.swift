import Foundation

/// Original delimiters remain available for selection, copying and lossless fallback.
public struct MathExpression: Equatable, Sendable {
    public let tex: String
    public let source: String
    public let display: Bool
    public init(tex: String, source: String, display: Bool) {
        self.tex = tex; self.source = source; self.display = display
    }
}

public enum MathInlineRun: Equatable, Sendable {
    case text(String), math(MathExpression)
}

public enum MathAttributedRun {
    case text(AttributedString), math(MathExpression, attributes: AttributeContainer)
}

public enum NativeMathSyntax {
    /// Parse formatting once across every formula; splitting Markdown first loses
    /// emphasis and links that begin before a formula and end after it.
    public static func attributedRuns(_ source: String) -> [MathAttributedRun] {
        let marker = "\u{F0000}"
        guard !source.contains(marker) else { return [.text(AttributedString(source))] }
        var markdown = "", expressions: [MathExpression] = []
        for run in inline(source) {
            switch run {
            case .text(let value): markdown += value
            case .math(let expression): markdown += marker; expressions.append(expression)
            }
        }
        let original: AttributedString
        if markdown.utf8.count <= 64_000,
           let parsed = try? AttributedString(markdown: markdown, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) { original = parsed }
        else { original = AttributedString(markdown) }
        var safe = original
        for run in original.runs {
            if let url = run.link, !MarkdownDocument.safeLink(url), NativeMichiReference.parse(url.absoluteString) == nil {
                safe[run.range].link = nil
            }
        }
        var remainder = safe[safe.startIndex..<safe.endIndex], result: [MathAttributedRun] = [], index = 0
        while let range = remainder.range(of: marker), index < expressions.count {
            result.append(.text(AttributedString(remainder[remainder.startIndex..<range.lowerBound])))
            result.append(.math(expressions[index], attributes: remainder[range].runs.first?.attributes ?? AttributeContainer()))
            remainder = remainder[range.upperBound..<remainder.endIndex]; index += 1
        }
        guard index == expressions.count else { return [.text(AttributedString(source))] }
        result.append(.text(AttributedString(remainder)))
        return result
    }

    /// Bounded delimiter recognition, before Markdown formatting. Code, destinations,
    /// escaped dollars, currency and JavaScript interpolation remain literal Markdown.
    public static func inline(_ source: String) -> [MathInlineRun] {
        guard source.utf8.count <= 64_000 else { return [.text(source)] }
        let chars = Array(source)
        let protectedEnds = protectedMarkupEnds(source, characters: chars)
        var runs: [MathInlineRun] = [], cursor = 0, start = 0, formulas = 0, delimiterSteps = 0
        func matches(_ token: [Character], at index: Int) -> Bool {
            index + token.count <= chars.count && Array(chars[index..<(index + token.count)]) == token
        }
        while cursor < chars.count {
            guard delimiterSteps < 131_072 else { break }
            if protectedEnds[cursor] > cursor { cursor = protectedEnds[cursor]; continue }
            if chars[cursor] == "`" {
                var end = cursor
                while end < chars.count, chars[end] == "`" { end += 1 }
                let count = end - cursor
                cursor = end
                // An unfinished code span stays literal during streaming.
                while cursor < chars.count {
                    guard chars[cursor] == "`" else { cursor += 1; continue }
                    let runStart = cursor
                    var close = cursor
                    while close < chars.count, chars[close] == "`" { close += 1 }
                    cursor = close
                    if close - runStart == count { break }
                }
                continue
            }
            // Do not split Markdown link targets (including parentheses in URLs).
            if matches(["]", "("], at: cursor) {
                cursor += 2; var depth = 1
                while cursor < chars.count, depth > 0 {
                    if chars[cursor] == "\\" { cursor = min(chars.count, cursor + 2); continue }
                    if chars[cursor] == "(" { depth += 1 }
                    if chars[cursor] == ")" { depth -= 1 }
                    cursor += 1
                }
                continue
            }
            var open: [Character] = [], close: [Character] = [], display = false
            if matches(["\\", "("], at: cursor) { open = ["\\", "("]; close = ["\\", ")"] }
            else if matches(["\\", "["], at: cursor) { open = ["\\", "["]; close = ["\\", "]"]; display = true }
            else if chars[cursor] == "\\" { cursor = min(chars.count, cursor + 2); continue }
            else if chars[cursor] == "$" {
                if cursor + 1 < chars.count, chars[cursor + 1] == "{" { cursor += 1; continue }
                display = matches(["$", "$"], at: cursor)
                open = display ? ["$", "$"] : ["$"]; close = open
            }
            guard !open.isEmpty else { cursor += 1; continue }
            let contentStart = cursor + open.count
            var end = contentStart, found = false
            while end < min(chars.count, contentStart + 2_049), delimiterSteps < 131_072 {
                delimiterSteps += 1
                if protectedEnds[end] > end { end = protectedEnds[end]; continue }
                if matches(close, at: end) {
                    // A single-dollar expression cannot consume one half of $$.
                    if close == ["$"], end + 1 < chars.count, chars[end + 1] == "$" { break }
                    found = true; break
                }
                if !display, chars[end] == "\n" { break }
                if chars[end] == "\\" { end = min(chars.count, end + 2) } else { end += 1 }
            }
            guard found else { cursor = contentStart; continue }
            let tex = String(chars[contentStart..<end]), finish = end + close.count
            let trimmed = tex.trimmingCharacters(in: .whitespacesAndNewlines)
            let currency = open == ["$"] && trimmed.first?.isNumber == true && !tex.contains(where: { "\\^_{}+-*/=<>|".contains($0) })
            if currency { cursor = contentStart; continue }
            if trimmed.isEmpty { cursor = finish; continue }
            if formulas >= 32 { break }
            if start < cursor { runs.append(.text(String(chars[start..<cursor]))) }
            runs.append(.math(MathExpression(tex: tex, source: String(chars[cursor..<finish]), display: display)))
            formulas += 1; cursor = finish; start = finish
        }
        if start < chars.count { runs.append(.text(String(chars[start...]))) }
        return runs.isEmpty ? [.text(source)] : runs
    }

    // Match only URI/email autolinks, syntactically formed HTML tags, and reference
    // definitions. A prose comparison such as `< b and $x$ >` is not protected.
    // These scans run only below the 64 KiB input bound. The end-offset array lets
    // both delimiter scans skip destinations in constant time without URL edits.
    private static let protectedMarkupPatterns: [NSRegularExpression] = {
        let attribute = #"[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?"#
        let tag = #"<(?:[A-Za-z][A-Za-z0-9-]*(?:\s+"# + attribute + #")*\s*/?|/[A-Za-z][A-Za-z0-9-]*\s*)>"#
        return [
            #"<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>"#,
            #"<[^\s<>@]+@[^\s<>@]+>"#,
            tag,
            #"(?m)^ {0,3}\[(?:\\[^\r\n]|[^\]\\\r\n]){1,999}\]:[ \t]*(?:\r?\n[ \t]*)?(?:<[^<>\r\n]*>|[^\s]+)(?:[ \t]+[^\r\n]*)?"#
        ].map { try! NSRegularExpression(pattern: $0) }
    }()

    private static func protectedMarkupEnds(_ source: String, characters: [Character]) -> [Int] {
        var boundaries: [Int: Int] = [0: 0], utf16Offset = 0
        for (index, character) in characters.enumerated() {
            utf16Offset += String(character).utf16.count; boundaries[utf16Offset] = index + 1
        }
        var ends = [Int](repeating: 0, count: characters.count)
        for regex in protectedMarkupPatterns {
            for match in regex.matches(in: source, range: NSRange(location: 0, length: utf16Offset)) {
                guard let start = boundaries[match.range.location], let end = boundaries[NSMaxRange(match.range)] else { continue }
                for index in start..<end { ends[index] = max(ends[index], end) }
            }
        }
        return ends
    }

    /// SwiftMath 1.7.3 (`atom(forCharacter:)`) silently drops unknown Unicode and
    /// the TeX control characters `$ % # & ~`. Preflight keeps those exact
    /// sources. Accented Latin and Cyrillic that the factory maps, plus `'` / `~`
    /// and the Unicode letters/symbols in `renderingRewrites`, are accepted when
    /// they have a proven SwiftMath command. `'` is typeset as a superscript prime.
    public static func rejectionReason(for tex: String) -> String? {
        guard !tex.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Empty formula" }
        guard tex.utf8.count <= 2_048 else { return "Formula exceeds the native rendering limit" }
        for scalar in tex.unicodeScalars {
            let value = scalar.value
            let character = Character(scalar)
            if (32...126).contains(value) || [9, 10, 13].contains(value) { continue }
            if (0x0410...0x044F).contains(value) { continue }
            if swiftMathAccentedLatin.contains(character) { continue }
            if renderingRewrites[character] != nil || isPrimeShorthand(character) { continue }
            return "Unsupported formula characters"
        }
        let bytes = Array(tex.utf8)
        var index = 0, depth = 0, commands = 0, scripts = 0, cells = 0
        var radicalDegrees: [Int] = []
        var textFloors: [Int] = [], pendingText = false
        let forbidden: Set<String> = ["color", "textcolor", "colorbox", "definecolor", "newcommand", "renewcommand", "def", "input", "include", "href", "url", "htmlClass", "htmlId", "htmlStyle", "require"]
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 92 {
                pendingText = false
                index += 1; commands += 1
                guard index < bytes.count, commands <= 96 else { return "Incomplete or overly complex formula" }
                let begin = index
                while index < bytes.count, (65...90).contains(bytes[index]) || (97...122).contains(bytes[index]) { index += 1 }
                if index == begin { index += 1 }
                else {
                    let command = String(decoding: bytes[begin..<index], as: UTF8.self)
                    if forbidden.contains(command) { return "Unsupported formula command" }
                    pendingText = textCommands.contains(command)
                    if command == "sqrt" {
                        var next = index
                        while next < bytes.count, [9, 10, 13, 32].contains(bytes[next]) { next += 1 }
                        if next < bytes.count, bytes[next] == 91 { radicalDegrees.append(depth); index = next + 1 }
                    }
                }
                continue
            }
            if byte == 123 {
                depth += 1
                if pendingText { textFloors.append(depth); pendingText = false }
                if depth > 12 { return "Formula nesting exceeds the native rendering limit" }
            }
            if byte == 125 {
                if textFloors.last == depth { textFloors.removeLast() }
                depth -= 1
                if depth < 0 || radicalDegrees.last.map({ depth < $0 }) == true { return "Unbalanced formula braces or radical degree" }
            }
            if byte == 93, radicalDegrees.last == depth { radicalDegrees.removeLast() }
            if byte == 94 || byte == 95 { scripts += 1; if scripts > 48 { return "Too many formula scripts" } }
            if byte == 38 { cells += 1; if cells > 63 { return "Formula table exceeds the native rendering limit" } }
            let inText = pendingText || textFloors.contains { depth >= $0 }
            if [36, 37, 35].contains(byte) || ((byte == 126 || byte == 39) && inText) { return "Unsupported unescaped formula character" }
            if ![9, 10, 13, 32].contains(byte) { pendingText = false }
            index += 1
        }
        return depth == 0 && radicalDegrees.isEmpty ? nil : "Unbalanced formula braces or radical degree"
    }

    /// Maps SwiftMath-dropped shorthand onto commands the 1.7.3 factory typesets.
    /// Apostrophe runs become one superscript of `\prime` (`f'` → `f^{\prime}`),
    /// not a baseline `\prime` ordinary. Original `tex` is left unchanged.
    public static func renderingTeX(_ tex: String) -> String {
        var out = "", index = tex.startIndex, depth = 0, pendingText = false
        var textFloors: [Int] = []
        while index < tex.endIndex {
            let character = tex[index]
            if character == "\\" {
                let start = tex.index(after: index)
                var end = start
                while end < tex.endIndex, tex[end].isLetter { end = tex.index(after: end) }
                if start == end {
                    out.append(character)
                    if start < tex.endIndex { out.append(tex[start]); index = tex.index(after: start) }
                    else { index = end }
                    pendingText = false
                    continue
                }
                let command = String(tex[start..<end])
                out += "\\" + command
                pendingText = textCommands.contains(command)
                index = end
                continue
            }
            if character == "{" {
                depth += 1
                if pendingText { textFloors.append(depth); pendingText = false }
                out.append(character); index = tex.index(after: index); continue
            }
            if character == "}" {
                if textFloors.last == depth { textFloors.removeLast() }
                depth -= 1
                out.append(character); index = tex.index(after: index); continue
            }
            let inText = pendingText || textFloors.contains { depth >= $0 }
            if !inText, let primes = consumePrimes(in: tex, from: &index), primes > 0 {
                out += "^{" + String(repeating: "\\prime", count: primes) + "}"
                continue
            }
            if character == "~", !inText { out += "\\,"; index = tex.index(after: index); continue }
            if !inText, let rewritten = renderingRewrites[character] {
                out += rewritten
                index = tex.index(after: index)
                continue
            }
            if !character.isWhitespace { pendingText = false }
            out.append(character)
            index = tex.index(after: index)
        }
        return out
    }

    private static func isPrimeShorthand(_ character: Character) -> Bool {
        character == "\u{2032}" || character == "\u{2033}" || character == "\u{2034}"
    }

    private static func consumePrimes(in tex: String, from index: inout String.Index) -> Int? {
        var count = 0
        var cursor = index
        while cursor < tex.endIndex {
            switch tex[cursor] {
            case "'", "\u{2032}": count += 1
            case "\u{2033}": count += 2
            case "\u{2034}": count += 3
            default:
                if count == 0 { return nil }
                index = cursor
                return count
            }
            cursor = tex.index(after: cursor)
        }
        if count == 0 { return nil }
        index = cursor
        return count
    }

    private static let textCommands: Set<String> = ["text", "textrm", "textit", "textbf", "texttt", "textsf"]
    /// Proven SwiftMath 1.7.3 `supportedLatexSymbols` mappings only. Unicode ε/φ
    /// match `\varepsilon` / `\varphi`; `\epsilon` / `\phi` are different glyphs.
    private static let renderingRewrites: [Character: String] = [
        "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta",
        "ε": "\\varepsilon", "ζ": "\\zeta", "η": "\\eta", "θ": "\\theta",
        "ι": "\\iota", "κ": "\\kappa", "λ": "\\lambda", "μ": "\\mu",
        "ν": "\\nu", "ξ": "\\xi", "ο": "\\omicron", "π": "\\pi",
        "ρ": "\\rho", "σ": "\\sigma", "τ": "\\tau", "υ": "\\upsilon",
        "φ": "\\varphi", "χ": "\\chi", "ψ": "\\psi", "ω": "\\omega",
        "Γ": "\\Gamma", "Δ": "\\Delta", "Θ": "\\Theta", "Λ": "\\Lambda",
        "Ξ": "\\Xi", "Π": "\\Pi", "Σ": "\\Sigma", "Υ": "\\Upsilon",
        "Φ": "\\Phi", "Ψ": "\\Psi", "Ω": "\\Omega",
        "×": "\\times", "÷": "\\div", "±": "\\pm", "∞": "\\infty",
        "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx",
        "→": "\\rightarrow", "←": "\\leftarrow", "∈": "\\in",
        "∇": "\\nabla", "∂": "\\partial", "∑": "\\sum",
        "−": "-", "·": "\\cdot"
    ]
    /// Keys of SwiftMath 1.7.3 `supportedAccentedCharacters`, excluding `'`.
    private static let swiftMathAccentedLatin: Set<Character> = [
        "á", "é", "í", "ó", "ú", "ý", "à", "è", "ì", "ò", "ù",
        "â", "ê", "î", "ô", "û", "ä", "ë", "ï", "ö", "ü", "ÿ",
        "ã", "ñ", "õ", "ç", "ø", "å", "æ", "œ", "ß",
        "Á", "É", "Í", "Ó", "Ú", "Ý", "À", "È", "Ì", "Ò", "Ù",
        "Â", "Ê", "Î", "Ô", "Û", "Ä", "Ë", "Ï", "Ö", "Ü",
        "Ã", "Ñ", "Õ", "Ç", "Ø", "Å", "Æ", "Œ"
    ]
}
