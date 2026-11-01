import Foundation
import MichiCore

struct NativeSearchSnippet: Identifiable, Equatable {
    let raw: JSONValue
    let index: Int
    var id: String { messageID ?? "title-\(index)" }
    /// Title-only matches deliberately carry an empty messageId on the backend.
    var messageID: String? { raw["messageId"].optionalString.flatMap { $0.isEmpty ? nil : $0 } }
    var role: String { raw["role"].stringValue }
    var text: String { NativeSearchContract.plainSnippet(raw["snippet"].stringValue) }
    var markRanges: [NativeSearchHighlight.UTF16Range] { NativeSearchHighlight.marks(in: raw["snippet"].stringValue).ranges }
}

struct NativeSearchResult: Identifiable, Equatable {
    let raw: JSONValue
    let snippets: [NativeSearchSnippet]
    var id: String { nodeID }
    var nodeID: String { raw["nodeId"].stringValue }
    var workspaceID: String { raw["workspaceId"].stringValue }
    var treeID: String? { raw["treeId"].optionalString }
    var title: String { raw["nodeTitle"].optionalString.flatMap { $0.isEmpty ? nil : $0 } ?? "New conversation" }
    var workspaceName: String { raw["workspaceName"].stringValue }
    var breadcrumb: [String] { raw["breadcrumb"].arrayValue.map(\.stringValue) }
    var totalMatches: Int { raw["totalMatches"].intValue }
    var lastMessageAt: Double { raw["lastMessageAt"].doubleValue }
    var remainingMatches: Int { max(0, totalMatches - snippets.filter { $0.messageID != nil }.count) }
    var navigation: NativeSearchNavigationTarget { NativeSearchNavigationTarget.of(self) }
}

/// Display-only highlight ranges. Navigation still uses exact UTF-8 IDs.
enum NativeSearchHighlight {
    struct UTF16Range: Equatable, Sendable {
        let location: Int
        let length: Int
        var end: Int { location + length }
    }

    struct Run: Equatable, Sendable {
        let text: String
        let isMatch: Bool
    }

    /// SQLite paired `<mark>` tags only. Unmatched tags stay literal text.
    /// Tags are found by Unicode scalar, not Character: SQLite inserts them at
    /// byte offsets, so a tag's `>` can precede a combining mark and would
    /// otherwise not match. Every other scalar is copied unchanged.
    static func marks(in source: String) -> (plain: String, ranges: [UTF16Range]) {
        let scalars = Array(source.unicodeScalars)
        let open = Array("<mark>".unicodeScalars), close = Array("</mark>".unicodeScalars)
        var plain = String.UnicodeScalarView(), ranges: [UTF16Range] = [], utf16 = 0, cursor = 0
        func find(_ tag: [Unicode.Scalar], from start: Int) -> Int? {
            var index = start
            while index + tag.count <= scalars.count {
                if scalars[index..<index + tag.count].elementsEqual(tag) { return index }
                index += 1
            }
            return nil
        }
        func copy(_ range: Range<Int>) {
            for scalar in scalars[range] { plain.append(scalar); utf16 += scalar.utf16.count }
        }
        while let opening = find(open, from: cursor), let closing = find(close, from: opening + open.count) {
            copy(cursor..<opening)
            let start = utf16
            copy(opening + open.count..<closing)
            if utf16 > start { ranges.append(UTF16Range(location: start, length: utf16 - start)) }
            cursor = closing + close.count
        }
        copy(cursor..<scalars.count)
        return (String(plain), ranges)
    }

    static func queryRanges(in text: String, query: String, locale: Locale = .current) -> [UTF16Range] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !text.isEmpty else { return [] }
        var tokens = trimmed.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).map(String.init)
        if trimmed.contains(where: { $0.isWhitespace || $0.isNewline }) { tokens.insert(trimmed, at: 0) }
        var found: [UTF16Range] = []
        for token in tokens where !token.isEmpty {
            var search = text.startIndex
            while search < text.endIndex {
                guard let match = text.range(of: token, options: [.caseInsensitive, .diacriticInsensitive], range: search..<text.endIndex, locale: locale) else { break }
                if match.lowerBound == match.upperBound { break }
                let ns = NSRange(match, in: text)
                if ns.location != NSNotFound, ns.length > 0 {
                    found.append(UTF16Range(location: ns.location, length: ns.length))
                }
                search = match.upperBound
            }
        }
        return union(found)
    }

    static func union(_ ranges: [UTF16Range]) -> [UTF16Range] {
        let ordered = ranges.filter { $0.length > 0 && $0.location >= 0 }.sorted { $0.location < $1.location || ($0.location == $1.location && $0.length > $1.length) }
        var merged: [UTF16Range] = []
        for range in ordered {
            guard let last = merged.last else { merged.append(range); continue }
            if range.location <= last.end {
                merged[merged.count - 1] = UTF16Range(location: last.location, length: max(last.end, range.end) - last.location)
            } else {
                merged.append(range)
            }
        }
        return merged
    }

    static func displayRuns(plain: String, query: String, marks: [UTF16Range] = [], locale: Locale = .current) -> [Run] {
        runs(in: plain, ranges: marks + queryRanges(in: plain, query: query, locale: locale))
    }

    /// Title runs. The "New conversation" placeholder is not the node's text,
    /// so it is never shown as a match.
    static func titleRuns(_ result: NativeSearchResult, query: String, locale: Locale = .current) -> [Run] {
        guard let title = result.raw["nodeTitle"].optionalString, !title.isEmpty else {
            return [Run(text: result.title, isMatch: false)]
        }
        return displayRuns(plain: title, query: query, locale: locale)
    }

    static func snippetRuns(_ snippet: NativeSearchSnippet, query: String, locale: Locale = .current) -> [Run] {
        displayRuns(plain: snippet.text, query: query, marks: snippet.markRanges, locale: locale)
    }

    /// Partitions `text` into runs whose concatenation is `text` byte for byte.
    /// A range that starts or ends inside a grapheme cluster (combining marks,
    /// ZWJ emoji, flags) is widened to the whole cluster rather than dropped.
    static func runs(in text: String, ranges: [UTF16Range]) -> [Run] {
        let spans = clusterAligned(ranges, in: text)
        var result: [Run] = [], current = "", currentIsMatch = false, offset = 0, next = 0
        for character in text {
            while next < spans.count, spans[next].end <= offset { next += 1 }
            let isMatch = next < spans.count && spans[next].location <= offset
            if isMatch != currentIsMatch, !current.isEmpty {
                result.append(Run(text: current, isMatch: currentIsMatch))
                current = ""
            }
            currentIsMatch = isMatch
            current.append(character)
            offset += character.utf16.count
        }
        if !current.isEmpty { result.append(Run(text: current, isMatch: currentIsMatch)) }
        return result
    }

    /// Clamps to `text`, then widens each range outward to grapheme cluster
    /// boundaries and merges overlaps.
    static func clusterAligned(_ ranges: [UTF16Range], in text: String) -> [UTF16Range] {
        let total = text.utf16.count
        let clamped = ranges.compactMap { range -> UTF16Range? in
            let lower = max(0, range.location), upper = min(total, range.end)
            return lower < upper ? UTF16Range(location: lower, length: upper - lower) : nil
        }
        guard !clamped.isEmpty else { return [] }
        var boundaries: [Int] = [], offset = 0
        for character in text { boundaries.append(offset); offset += character.utf16.count }
        boundaries.append(total)
        return union(clamped.map { range in
            let start = boundaries.last(where: { $0 <= range.location }) ?? 0
            let end = boundaries.first(where: { $0 >= range.end }) ?? total
            return UTF16Range(location: start, length: end - start)
        })
    }
}

/// Exact navigation identity. Highlight folding must never be used here.
struct NativeSearchNavigationTarget: Equatable, Sendable {
    let workspaceID: String
    let nodeID: String
    let messageID: String?

    static func of(_ result: NativeSearchResult, snippet: NativeSearchSnippet? = nil) -> Self {
        .init(workspaceID: result.workspaceID, nodeID: result.nodeID, messageID: snippet?.messageID)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        NativeSearchContract.sameOpaque(lhs.workspaceID, rhs.workspaceID)
            && NativeSearchContract.sameOpaque(lhs.nodeID, rhs.nodeID)
            && optionalSame(lhs.messageID, rhs.messageID)
    }

    private static func optionalSame(_ lhs: String?, _ rhs: String?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): return true
        case (let a?, let b?): return NativeSearchContract.sameOpaque(a, b)
        default: return false
        }
    }
}

enum NativeSearchContract {
    // useNodeSearch requests 30 groups; search.ts returns at most 3 snippets and
    // builds root-first breadcrumbs with a 50-ancestor guard.
    static let resultLimit = 30
    static let snippetLimit = 3
    static let malformedMessage = "Michi returned search results that could not be read. Try searching again."

    static func results(_ payload: JSONValue) throws -> [NativeSearchResult] {
        guard case .array(let records) = payload["results"], records.count <= resultLimit,
              let count = integer(payload["totalNodes"]), count == records.count else { throw NativeFailure(malformedMessage) }
        var ids: Set<String> = []
        return try records.map { raw in
            guard validID(raw["nodeId"]), validID(raw["workspaceId"]),
                  ids.insert(raw["nodeId"].stringValue).inserted,
                  raw["treeId"].isNull || validID(raw["treeId"]),
                  raw["nodeTitle"].isNull || raw["nodeTitle"].optionalString != nil,
                  raw["workspaceName"].optionalString != nil,
                  let matches = integer(raw["totalMatches"]),
                  case .number(let at) = raw["lastMessageAt"], at.isFinite, at >= 0,
                  case .array(let breadcrumb) = raw["breadcrumb"], breadcrumb.count <= 50,
                  breadcrumb.allSatisfy({ $0.optionalString != nil }),
                  case .array(let snippets) = raw["snippets"], snippets.count <= snippetLimit else { throw NativeFailure(malformedMessage) }
            var messages: Set<String> = []
            let validated = try snippets.enumerated().map { index, snippet -> NativeSearchSnippet in
                guard let messageID = snippet["messageId"].optionalString,
                      snippet["snippet"].optionalString != nil,
                      ["user", "assistant"].contains(snippet["role"].stringValue),
                      messageID.isEmpty ? (matches == 0 && snippets.count == 1) : (validID(snippet["messageId"]) && messages.insert(messageID).inserted) else { throw NativeFailure(malformedMessage) }
                return NativeSearchSnippet(raw: snippet, index: index)
            }
            guard matches >= validated.filter({ $0.messageID != nil }).count else { throw NativeFailure(malformedMessage) }
            return NativeSearchResult(raw: raw, snippets: validated)
        }
    }

    /// SQLite inserts only these paired markers. Treat everything else, including
    /// HTML, entities and Markdown, as literal text just as the web palette does.
    /// Unmatched tags remain data rather than being silently removed.
    static func plainSnippet(_ source: String) -> String {
        NativeSearchHighlight.marks(in: source).plain
    }

    static func sameOpaque(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    /// Search rows carry hints, not navigation authority. Require the hydrated
    /// workspace and its current node/tree ownership before showing or opening.
    /// Archived workspaces/trees remain searchable and open read-only like web.
    static func destination(_ result: NativeSearchResult, graphs: [WorkspaceGraph]) -> (graph: WorkspaceGraph, node: JSONValue)? {
        let workspaces = graphs.filter { $0.id == result.workspaceID }
        // Swift String equality treats canonically equivalent Unicode as equal;
        // database IDs are byte identities. Also refuse duplicate graph owners,
        // because the ordinary navigation store uses a first-match lookup.
        let nodes = graphs.flatMap(\.nodes).filter { $0.id == result.nodeID }
        guard workspaces.count == 1, let graph = workspaces.first, sameID(graph.id, result.workspaceID),
              !graph.isDeleted, !graph.isSystem, graph.workspace["purged_at"].isNull,
              graph.workspace["settings"].parsedJSON["system"].isNull,
              nodes.count == 1, let node = graph.node(result.nodeID), sameID(node.id, result.nodeID),
              sameID(node["workspace_id"].stringValue, graph.id),
              node["deleted_at"].isNull, node["purged_at"].isNull,
              graph.isConversation(node), node["kind"].stringValue != "digest",
              let treeID = node["tree_id"].optionalString, !treeID.isEmpty,
              result.treeID.map({ sameID($0, treeID) }) ?? true else { return nil }
        let trees = graph.trees.filter { $0.id == treeID }
        guard trees.count == 1, let tree = trees.first, sameID(tree.id, treeID),
              sameID(tree["workspace_id"].stringValue, graph.id),
              tree["deleted_at"].isNull, tree["purged_at"].isNull,
              let rootID = tree["root_node_id"].optionalString else { return nil }
        let roots = graph.nodes.filter { $0.id == rootID }
        guard roots.count == 1, let root = roots.first, sameID(root.id, rootID),
              sameID(root["tree_id"].stringValue, treeID), sameID(root["workspace_id"].stringValue, graph.id),
              root["deleted_at"].isNull, root["purged_at"].isNull else { return nil }
        return (graph, node)
    }

    private static func sameID(_ a: String, _ b: String) -> Bool { sameOpaque(a, b) }
    private static func validID(_ raw: JSONValue) -> Bool {
        guard let value = raw.optionalString else { return false }
        return !value.isEmpty && value.utf16.count <= 200
            && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
    private static func integer(_ raw: JSONValue) -> Int? {
        guard case .number(let value) = raw, value.isFinite, value >= 0,
              value < Double(Int.max), value.rounded(.down) == value else { return nil }
        return Int(value)
    }
}
