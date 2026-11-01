import Foundation

/// Assistant URLs follow frontend/state/assistant/assistantLinks.ts. Structured
/// page sources have a different, opaque-ID contract and are never URI parsed.
public enum NativeMichiReference: Hashable, Sendable {
    case node(id: String, messageID: String?)
    case page(id: String, blockID: String?)
    case source(nodeID: String, turnID: String, assistantID: String)

    public static func parse(_ string: String) -> Self? {
        // Match JavaScript trim/\s, including BOM but excluding U+0085.
        let whitespace = "\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
        let trim = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
        let value = string.trimmingCharacters(in: trim)
        for (kind, query) in [("node", "message"), ("page", "block")] {
            // JS /i without /u does not fold non-ASCII letters into ASCII.
            let insensitive: (String) -> String = { $0.map { "[\($0)\(String($0).uppercased())]" }.joined() }
            let pattern = "^\(insensitive("michi"))://\(insensitive(kind))/([^/?#\(whitespace)]+)/?(?:\\?\(insensitive(query))=([^&#\(whitespace)]+))?$"
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
                  match.range.length == value.utf16.count,
                  let idRange = Range(match.range(at: 1), in: value),
                  let id = decodeID(String(value[idRange])) else { continue }
            var target: String?
            if match.range(at: 2).location != NSNotFound {
                guard let range = Range(match.range(at: 2), in: value), let decoded = decodeID(String(value[range])) else { return nil }
                target = decoded
            }
            return kind == "node" ? .node(id: id, messageID: target) : .page(id: id, blockID: target)
        }
        return nil
    }

    /// Validates the page BlockSource triple without trimming, normalizing or
    /// interpreting IDs as URLs. JavaScript's length counts UTF-16 code units.
    public static func source(_ value: JSONValue) -> Self? {
        guard let node = value["nodeId"].optionalString,
              let turn = value["turnId"].optionalString,
              let assistant = value["assistantId"].optionalString,
              [node, turn, assistant].allSatisfy(validSourceID) else { return nil }
        return .source(nodeID: node, turnID: turn, assistantID: assistant)
    }

    /// Also validates directly constructed cases before issuing any request.
    public var isValid: Bool {
        switch self {
        case .node(let id, let message): return Self.validLinkID(id) && (message.map(Self.validLinkID) ?? true)
        case .page(let id, let block): return Self.validLinkID(id) && (block.map(Self.validLinkID) ?? true)
        case .source(let node, let turn, let assistant): return [node, turn, assistant].allSatisfy(Self.validSourceID)
        }
    }

    // Opaque source IDs use JavaScript/SQLite exact identity. Swift String's
    // default equality would merge precomposed and decomposed Unicode IDs.
    public static func == (lhs: Self, rhs: Self) -> Bool { lhs.identityBytes == rhs.identityBytes }
    public func hash(into hasher: inout Hasher) { hasher.combine(identityBytes) }
    private var identityBytes: [[UInt8]] {
        switch self {
        case .node(let id, let message): return [[0], Array(id.utf8), [message == nil ? 0 : 1], Array((message ?? "").utf8)]
        case .page(let id, let block): return [[1], Array(id.utf8), [block == nil ? 0 : 1], Array((block ?? "").utf8)]
        case .source(let node, let turn, let assistant): return [[2], Array(node.utf8), Array(turn.utf8), Array(assistant.utf8)]
        }
    }

    public enum LinkDecision: Equatable, Sendable {
        case open(NativeMichiReference)
        case system
        case discard
    }

    /// Internal `michi://` links use the same strict grammar as `parse`.
    /// Everything else stays on the existing safe-external allowlist.
    public static func linkDecision(for url: URL, allowInternal: Bool) -> LinkDecision {
        if allowInternal, let target = parse(url.absoluteString) { return .open(target) }
        return MarkdownDocument.safeLink(url) ? .system : .discard
    }

    private static func decodeID(_ raw: String) -> String? {
        guard let decoded = raw.removingPercentEncoding, validLinkID(decoded) else { return nil }
        return decoded
    }
    private static func validLinkID(_ id: String) -> Bool {
        let allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:~@+=-"
        return (1...256).contains(id.utf8.count) && id.utf8.allSatisfy { allowed.utf8.contains($0) } && !id.allSatisfy { $0 == "." }
    }
    private static func validSourceID(_ id: String) -> Bool { !id.isEmpty && id.utf16.count <= 200 }
}
