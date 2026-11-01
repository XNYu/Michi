import Foundation

/// A bounded lexical highlighter, not a compiler or syntax validator. Every
/// result reassembles to the original Unicode scalars, including whitespace.
/// Interpolated strings, regex/division slash ambiguity, shell substitutions and
/// heredocs deliberately fall back to plain text instead of guessing a grammar.
public enum NativeCodeSyntax {
    public enum Kind: Sendable, Equatable {
        case plain, keyword, string, number, comment, property, variable, punctuation
    }

    public struct Token: Sendable, Equatable {
        public let text: String
        public let kind: Kind
        public init(text: String, kind: Kind) { self.text = text; self.kind = kind }
    }

    public static let maximumUTF8Bytes = 64_000
    public static let maximumTokens = 2_048

    public static func tokens(_ text: String, language: String) -> [Token] {
        let plain = [Token(text: text, kind: .plain)]
        // Prefix counting does not traverse arbitrarily large streaming blocks.
        guard text.utf8.prefix(maximumUTF8Bytes + 1).count <= maximumUTF8Bytes,
              language.utf8.prefix(65).count <= 64,
              let language = Language(label: language), !text.isEmpty else { return plain }
        var lexer = Lexer(text: text, language: language)
        return lexer.scan() ?? plain
    }

    private enum Language {
        case json, javascript, typescript, python, shell, swift
        init?(label: String) {
            switch label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "json": self = .json
            case "js", "javascript": self = .javascript
            case "ts", "typescript": self = .typescript
            case "py", "python": self = .python
            case "sh", "bash", "shell", "zsh": self = .shell
            case "swift": self = .swift
            default: return nil
            }
        }
        var cComments: Bool { self == .javascript || self == .typescript || self == .swift }
        var keywords: Set<String> {
            switch self {
            case .json: return jsonWords
            case .javascript: return javascriptWords
            case .typescript: return javascriptWords.union(typescriptWords)
            case .python: return pythonWords
            case .shell: return shellWords
            case .swift: return swiftWords
            }
        }
    }

    private static let jsonWords: Set<String> = ["true", "false", "null"]
    private static let javascriptWords = Set("async await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield".split(separator: " ").map(String.init))
    private static let typescriptWords = Set("abstract any as asserts bigint boolean constructor declare enum implements infer interface is keyof module namespace never number private protected public readonly require satisfies string symbol type unique unknown".split(separator: " ").map(String.init))
    private static let pythonWords = Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(separator: " ").map(String.init))
    private static let shellWords = Set("case do done elif else esac fi for function if in select then time until while".split(separator: " ").map(String.init))
    private static let swiftWords = Set("Any Self actor any as associatedtype async await borrowing break case catch class consuming continue convenience copy default defer deinit didSet distributed do dynamic each else enum extension fallthrough false fileprivate final for func get guard if import in indirect inout internal is isolated lazy let macro mutating nil nonisolated nonmutating open operator optional override package postfix precedencegroup prefix private protocol public repeat required rethrows return self set some static struct subscript super switch throws throw true try typealias unowned var weak where while willSet".split(separator: " ").map(String.init))

    private struct Segment { let start: Int; var end: Int; let kind: Kind }

    private struct Lexer {
        let source: [Unicode.Scalar]
        let language: Language
        let keywords: Set<String>
        var index = 0
        var segments: [Segment] = []
        init(text: String, language: Language) {
            source = Array(text.unicodeScalars)
            self.language = language
            keywords = language.keywords
        }

        mutating func scan() -> [Token]? {
            while index < source.count {
                let start = index
                var kind: Kind = .plain
                let value = source[index].value

                if isWhitespace(value) {
                    repeat { index += 1 } while index < source.count && isWhitespace(source[index].value)
                } else if language.cComments && matches("//", at: index) {
                    lineComment(); kind = .comment
                } else if language.cComments && matches("/*", at: index) {
                    blockComment(nested: language == .swift); kind = .comment
                } else if (language == .python || language == .shell) && value == 35 {
                    if language == .python || shellWordBoundary(before: index) {
                        lineComment(); kind = .comment
                    } else { shellWord(); kind = .plain }
                } else if language == .swift && value == 35 {
                    var hashes = 0
                    while scalar(index + hashes) == 35 { hashes += 1 }
                    if scalar(index + hashes) == 34 {
                        index += hashes
                        guard quoted(quote: 34, triple: matches("\"\"\"", at: index), hashes: hashes, raw: false) else { return nil }
                        kind = .string
                    } else if scalar(index + hashes) == 47 { return nil }
                    else { index += hashes }
                } else if language == .shell && value == 36 {
                    guard shellVariable() else { return nil }
                    kind = .variable
                } else if language == .shell && (value == 96 || matches("<<", at: index)) {
                    return nil
                } else if value == 34 || (value == 39 && language != .json && language != .swift) ||
                            (value == 96 && (language == .javascript || language == .typescript)) {
                    let triple = (language == .python || language == .swift) && scalar(index + 1) == value && scalar(index + 2) == value
                    guard quoted(quote: value, triple: triple, hashes: 0, raw: language == .shell && value == 39) else { return nil }
                    kind = language == .json && nextNonWhitespace() == 58 ? .property : .string
                } else if language == .python, let prefixLength = pythonStringPrefix() {
                    // f-strings and Python 3.14 t-strings require a nested
                    // expression grammar, including reuse of the outer quote.
                    let prefix = text(start, start + prefixLength).lowercased()
                    guard !prefix.contains("f") && !prefix.contains("t") else { return nil }
                    index += prefixLength
                    let quote = source[index].value
                    guard quoted(quote: quote, triple: scalar(index + 1) == quote && scalar(index + 2) == quote,
                                 hashes: 0, raw: false) else { return nil }
                    kind = .string
                } else if language == .shell && value == 92 {
                    // A quoted shell character cannot start a comment, keyword
                    // or substitution. Keep its exact escape and character.
                    index = min(source.count, index + 2)
                } else if language == .shell && isShellWordStart(value) {
                    shellWord()
                    kind = keywords.contains(text(start, index)) ? .keyword : .plain
                } else if isDigit(value) || (value == 46 && isDigit(scalar(index + 1))) ||
                            (language == .json && value == 45 && isDigit(scalar(index + 1))) {
                    number()
                    kind = .number
                } else if identifierStart(value) {
                    repeat { index += 1 } while index < source.count && identifierPart(source[index].value)
                    kind = keywords.contains(text(start, index)) ? .keyword : .plain
                } else if value == 47 && language.cComments {
                    // JS/Swift use '/' both for division and regex literals.
                    // Without parser context, do not color regex content as code.
                    return nil
                } else {
                    index += 1
                    if "{}[]():,.;=+-*/%!?<>|&^~@".unicodeScalars.contains(source[start]) { kind = .punctuation }
                }
                append(start: start, end: index, kind: kind)
                guard segments.count <= maximumTokens else { return nil }
            }
            return segments.map { Token(text: text($0.start, $0.end), kind: $0.kind) }
        }

        func scalar(_ offset: Int) -> UInt32 { offset >= 0 && offset < source.count ? source[offset].value : 0 }
        func matches(_ literal: String, at offset: Int) -> Bool {
            for (i, scalar) in literal.unicodeScalars.enumerated() where self.scalar(offset + i) != scalar.value { return false }
            return true
        }
        func text(_ start: Int, _ end: Int) -> String { String(String.UnicodeScalarView(source[start..<end])) }
        func isLineBreak(_ value: UInt32) -> Bool {
            value == 10 || value == 13 || ((language == .javascript || language == .typescript) && (value == 0x2028 || value == 0x2029))
        }
        func isWhitespace(_ value: UInt32) -> Bool { value == 32 || value == 9 || value == 12 || isLineBreak(value) }
        func isDigit(_ value: UInt32) -> Bool { value >= 48 && value <= 57 }
        func identifierStart(_ value: UInt32) -> Bool {
            (65...90).contains(value) || (97...122).contains(value) || value == 95 || value >= 128 ||
                (value == 36 && (language == .javascript || language == .typescript || language == .swift))
        }
        func identifierPart(_ value: UInt32) -> Bool { identifierStart(value) || isDigit(value) }
        func nextNonWhitespace() -> UInt32 {
            var next = index
            while next < source.count && isWhitespace(source[next].value) { next += 1 }
            return scalar(next)
        }
        mutating func append(start: Int, end: Int, kind: Kind) {
            if segments.last?.kind == kind { segments[segments.count - 1].end = end }
            else { segments.append(Segment(start: start, end: end, kind: kind)) }
        }
        mutating func lineComment() {
            while index < source.count && !isLineBreak(scalar(index)) { index += 1 }
        }
        mutating func blockComment(nested: Bool) {
            index += 2
            var depth = 1
            while index < source.count {
                if matches("*/", at: index) {
                    depth -= 1; index += 2
                    if depth == 0 { return }
                } else if nested && matches("/*", at: index) { depth += 1; index += 2 }
                else { index += 1 }
            }
        }

        /// Returns false only for unsupported interpolation. An unfinished
        /// string/comment from a streaming response remains an opaque token.
        mutating func quoted(quote: UInt32, triple: Bool, hashes: Int, raw: Bool) -> Bool {
            let opening = triple ? 3 : 1
            index += opening
            while index < source.count {
                if scalar(index) == quote && (!triple || (scalar(index + 1) == quote && scalar(index + 2) == quote)) {
                    var end = index + opening
                    var found = 0
                    while found < hashes && scalar(end) == 35 { found += 1; end += 1 }
                    if found == hashes { index = end; return true }
                }
                if !raw && scalar(index) == 92 {
                    var escaped = index + 1
                    var found = 0
                    while found < hashes && scalar(escaped) == 35 { found += 1; escaped += 1 }
                    if found == hashes {
                        if language == .swift && scalar(escaped) == 40 { return false }
                        index = min(source.count, escaped + 1)
                        continue
                    }
                }
                if quote == 96 && scalar(index) == 36 && scalar(index + 1) == 123 { return false }
                if language == .shell && quote == 34 && (scalar(index) == 96 || matches("$(", at: index) || matches("${", at: index)) { return false }
                // Single-line source strings cannot consume the following
                // statement merely because a streaming quote is unfinished.
                if !triple && quote != 96 && language != .shell && isLineBreak(scalar(index)) { return true }
                index += 1
            }
            return true
        }

        func pythonStringPrefix() -> Int? {
            var next = index
            while next < min(source.count, index + 2) && "rRuUbBfFtT".unicodeScalars.contains(source[next]) { next += 1 }
            guard next > index, scalar(next) == 34 || scalar(next) == 39,
                  ["r", "u", "b", "f", "t", "br", "rb", "fr", "rf", "tr", "rt"].contains(text(index, next).lowercased()) else { return nil }
            return next - index
        }

        mutating func number() {
            if scalar(index) == 45 { index += 1 }
            if language != .json && scalar(index) == 48 {
                let radix = scalar(index + 1)
                if [UInt32(120), 88, 98, 66, 111, 79].contains(radix) {
                    index += 2
                    while index < source.count {
                        let value = scalar(index)
                        let valid = radix == 120 || radix == 88 ? isDigit(value) || (65...70).contains(value) || (97...102).contains(value) :
                            (radix == 98 || radix == 66 ? value == 48 || value == 49 : (48...55).contains(value))
                        guard valid || value == 95 else { break }
                        index += 1
                    }
                    return
                }
            }
            while isDigit(scalar(index)) || (language != .json && scalar(index) == 95) { index += 1 }
            if scalar(index) == 46 && isDigit(scalar(index + 1)) {
                index += 1
                while isDigit(scalar(index)) || (language != .json && scalar(index) == 95) { index += 1 }
            }
            if scalar(index) == 101 || scalar(index) == 69 {
                var next = index + 1
                if scalar(next) == 43 || scalar(next) == 45 { next += 1 }
                if isDigit(scalar(next)) {
                    index = next + 1
                    while isDigit(scalar(index)) { index += 1 }
                }
            }
            if (language == .javascript || language == .typescript) && scalar(index) == 110 { index += 1 }
        }

        func shellWordBoundary(before offset: Int) -> Bool {
            offset == 0 || isWhitespace(scalar(offset - 1)) || ";|&()<>".unicodeScalars.contains(source[offset - 1])
        }
        func isShellWordStart(_ value: UInt32) -> Bool {
            value != 0 && !isWhitespace(value) && !";|&()<>\"'`$\\".unicodeScalars.contains(Unicode.Scalar(value)!)
        }
        mutating func shellWord() {
            repeat { index += 1 } while index < source.count && isShellWordStart(scalar(index))
        }
        mutating func shellVariable() -> Bool {
            index += 1
            if scalar(index) == 40 { return false }
            if scalar(index) == 123 {
                index += 1
                let start = index
                while identifierPart(scalar(index)) { index += 1 }
                guard index > start, scalar(index) == 125 else { return false }
                index += 1
            } else if "?@*#$!-".unicodeScalars.contains(Unicode.Scalar(scalar(index))!) || isDigit(scalar(index)) {
                index += 1
            } else {
                while identifierPart(scalar(index)) { index += 1 }
            }
            return true
        }
    }
}
