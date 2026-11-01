import Foundation
import Combine
import MichiCore

/// Byte-exact conversation source that owns a Markdown table. Swift `String`
/// equality would merge NFC/NFD IDs; those remain distinct sources.
///
/// `live` is one streaming answer block: its turn, its assistant message and
/// the projection block id (`<assistantId>-b-<n>`, TurnProjection). `message`
/// is a saved fragment: message id, block offset and durable block id. Durable
/// blocks reuse the projection's ids (shared/src/turnProjection.ts
/// nextBlockId); that byte match is the only proof that a live block became a
/// particular saved block. Messages without blocks have neither.
struct NativeMarkdownTableDocument: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case live(turnID: String?, assistantID: String?, blockID: String)
        case message(messageID: String, fragment: Int?, blockID: String?)
    }

    let nodeID: String
    let kind: Kind

    static func live(nodeID: String, turnID: String?, assistantID: String?, blockID: String) -> Self {
        .init(nodeID: nodeID, kind: .live(turnID: turnID, assistantID: assistantID, blockID: blockID))
    }

    static func message(nodeID: String, messageID: String, fragment: Int? = nil, blockID: String? = nil) -> Self {
        .init(nodeID: nodeID, kind: .message(messageID: messageID, fragment: fragment, blockID: blockID))
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        guard same(lhs.nodeID, rhs.nodeID) else { return false }
        switch (lhs.kind, rhs.kind) {
        case let (.live(lt, la, lb), .live(rt, ra, rb)):
            return sameOptional(lt, rt) && sameOptional(la, ra) && same(lb, rb)
        case let (.message(lm, lf, lb), .message(rm, rf, rb)):
            return same(lm, rm) && lf == rf && sameOptional(lb, rb)
        default:
            return false
        }
    }

    /// The same streaming block or the same saved fragment. A live block's
    /// turn or assistant id can become known after its first render, so an
    /// absent value is compatible; two known values must match byte for byte.
    func isSameSource(as other: Self) -> Bool {
        guard Self.same(nodeID, other.nodeID) else { return false }
        switch (kind, other.kind) {
        case let (.live(lt, la, lb), .live(rt, ra, rb)):
            return Self.same(lb, rb) && Self.compatible(lt, rt) && Self.compatible(la, ra)
        case (.message, .message):
            return self == other
        default:
            return false
        }
    }

    /// True when this saved fragment is provably the persisted form of `live`:
    /// its message is that block's assistant message and its durable block id
    /// is that block's projection id. Unknown ids prove nothing.
    func isPersistedForm(of live: Self) -> Bool {
        guard Self.same(nodeID, live.nodeID),
              case .live(_, let assistantID?, let liveBlock) = live.kind,
              case .message(let messageID, _, let savedBlock?) = kind else { return false }
        return Self.same(messageID, assistantID) && Self.same(savedBlock, liveBlock)
    }

    /// Keeps ids learned from an earlier render of the same live block.
    func refining(_ previous: Self) -> Self {
        guard case let .live(turn, assistant, block) = kind,
              case let .live(previousTurn, previousAssistant, _) = previous.kind else { return self }
        return .live(nodeID: nodeID, turnID: turn ?? previousTurn, assistantID: assistant ?? previousAssistant, blockID: block)
    }

    private static func same(_ lhs: String, _ rhs: String) -> Bool { DesignChatOpaqueID.same(lhs, rhs) }

    private static func sameOptional(_ lhs: String?, _ rhs: String?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): return true
        case let (a?, b?): return same(a, b)
        default: return false
        }
    }

    private static func compatible(_ lhs: String?, _ rhs: String?) -> Bool {
        guard let lhs, let rhs else { return true }
        return same(lhs, rhs)
    }
}

struct NativeMarkdownTableSignature: Equatable, Sendable {
    let headers: [String]
    let alignments: [MarkdownAlignment]

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.alignments == rhs.alignments && sameStrings(lhs.headers, rhs.headers)
    }
}

struct NativeMarkdownTableSnapshot: Equatable, Sendable {
    let headers: [String]
    let alignments: [MarkdownAlignment]
    let rows: [[String]]
    var headerCells: [[NativeInlineFragment]]? = nil
    var rowCells: [[[NativeInlineFragment]]]? = nil

    var signature: NativeMarkdownTableSignature {
        NativeMarkdownTableSignature(headers: headers, alignments: alignments)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.signature == rhs.signature && lhs.headerCells == rhs.headerCells && lhs.rowCells == rhs.rowCells
            && lhs.rows.count == rhs.rows.count
            && zip(lhs.rows, rhs.rows).allSatisfy { sameStrings($0, $1) }
    }
}

struct NativeMarkdownTableIdentity: Equatable, Sendable {
    let document: NativeMarkdownTableDocument
    /// Document-global table index (`NativeMarkdownTableOrder`, the numbering
    /// NativeMarkdown passes). Without it a table cannot be anchored, so hosts
    /// that cannot supply it (inline-paragraph HTML, previews) keep a local cover.
    let ordinal: Int
    let signature: NativeMarkdownTableSignature
}

struct NativeMarkdownTableOccurrence: Equatable, Sendable {
    let identity: NativeMarkdownTableIdentity
    let snapshot: NativeMarkdownTableSnapshot
}

/// One Markdown text the conversation currently renders, with its source.
struct NativeMarkdownTableSource: Equatable, Sendable {
    let document: NativeMarkdownTableDocument
    let markdown: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.document == rhs.document && lhs.markdown.utf8.elementsEqual(rhs.markdown.utf8)
    }
}

/// Change detector for an open table. Byte-exact, so an NFC/NFD-only edit of
/// a tracked source or the current node still triggers reconciliation.
struct NativeMarkdownTableWatch: Equatable, Sendable {
    static let idle = NativeMarkdownTableWatch(nodeID: nil, sources: [])

    let nodeID: String?
    let sources: [NativeMarkdownTableSource]

    static func == (lhs: Self, rhs: Self) -> Bool {
        let sameNode: Bool
        switch (lhs.nodeID, rhs.nodeID) {
        case (nil, nil): sameNode = true
        case let (a?, b?): sameNode = a.utf8.elementsEqual(b.utf8)
        default: sameNode = false
        }
        return sameNode && lhs.sources == rhs.sources
    }
}

struct NativeMarkdownTableSession: Equatable, Sendable {
    /// Stable cover token. Row rebuilds and a proven live → saved transfer
    /// keep it; any other source change dismisses instead.
    let id: UUID
    var identity: NativeMarkdownTableIdentity
    var snapshot: NativeMarkdownTableSnapshot
}

enum NativeMarkdownTablePresentResult: Equatable, Sendable {
    case presented
    case updated
    case ignored
}

enum NativeMarkdownTableCatalog {
    /// Tables numbered exactly as NativeMarkdown passes `ordinal`
    /// (`NativeMarkdownTableOrder`): depth-first Markdown tables, quoted
    /// tables and block-level HTML tables, including those inside `<details>`.
    /// An HTML table NativeHTMLView cannot render still takes its number.
    static func occurrences(in markdown: String, document: NativeMarkdownTableDocument) -> [NativeMarkdownTableOccurrence] {
        var items: [NativeMarkdownTableOccurrence] = [], ordinal = 0
        walk(MarkdownDocument(markdown).blocks, document: document, ordinal: &ordinal, items: &items)
        return items
    }

    static func occurrences(in sources: [NativeMarkdownTableSource]) -> [NativeMarkdownTableOccurrence] {
        sources.flatMap { occurrences(in: $0.markdown, document: $0.document) }
    }

    private static func walk(_ blocks: [MarkdownBlock], document: NativeMarkdownTableDocument, ordinal: inout Int, items: inout [NativeMarkdownTableOccurrence]) {
        for block in blocks {
            switch block {
            case .table(let headers, let alignments, let rows):
                append(.init(headers: headers, alignments: alignments, rows: rows), document: document, ordinal: &ordinal, items: &items)
            case .quote(let nested):
                walk(nested, document: document, ordinal: &ordinal, items: &items)
            case .html(let html):
                walk(html.nodes, source: html.source, document: document, ordinal: &ordinal, items: &items)
            default:
                break
            }
        }
    }

    /// Mirrors NativeHTMLView: a table is one entry and is not descended into.
    private static func walk(_ nodes: [NativeHTMLNode], source: String, document: NativeMarkdownTableDocument, ordinal: inout Int, items: inout [NativeMarkdownTableOccurrence]) {
        for node in nodes {
            guard case .element(let element) = node else { continue }
            guard element.name == .table else {
                walk(element.children, source: source, document: document, ordinal: &ordinal, items: &items)
                continue
            }
            if let table = NativeHTMLDocument(nodes: [node], source: source).tables().first {
                append(.init(headers: table.headers, alignments: table.alignments, rows: table.rows, headerCells: table.headerCells, rowCells: table.rowCells), document: document, ordinal: &ordinal, items: &items)
            } else {
                ordinal += 1
            }
        }
    }

    private static func append(_ snapshot: NativeMarkdownTableSnapshot, document: NativeMarkdownTableDocument, ordinal: inout Int, items: inout [NativeMarkdownTableOccurrence]) {
        items.append(.init(identity: .init(document: document, ordinal: ordinal, signature: snapshot.signature), snapshot: snapshot))
        ordinal += 1
    }
}

/// Conversation-scoped fullscreen owner. Inline table views may remount on
/// every token; this object keeps one session and one cover identity.
///
/// The session is anchored to its exact source block and table ordinal. It
/// follows only that table, plus the single provable transfer from a live
/// block to its persisted fragment. Same headers elsewhere — another reply,
/// another saved message, the next turn — never adopt the session.
@MainActor
final class NativeMarkdownTablePresenter: ObservableObject {
    @Published private(set) var session: NativeMarkdownTableSession?

    var isPresenting: Bool { session != nil }

    /// Opens `document`'s table at `ordinal`. While a table is open, only that
    /// same table can refresh it; any other request is ignored.
    @discardableResult
    func present(document: NativeMarkdownTableDocument, snapshot: NativeMarkdownTableSnapshot, ordinal: Int) -> NativeMarkdownTablePresentResult {
        let incoming = Self.occurrence(document, snapshot, ordinal)
        guard let session else {
            self.session = NativeMarkdownTableSession(id: UUID(), identity: incoming.identity, snapshot: snapshot)
            return .presented
        }
        guard Self.isSameTable(session.identity, incoming.identity) else { return .ignored }
        apply(incoming)
        return .updated
    }

    /// Pushes the latest rows of the open table. Never opens or replaces.
    func sync(document: NativeMarkdownTableDocument, snapshot: NativeMarkdownTableSnapshot, ordinal: Int) {
        guard let session else { return }
        let incoming = Self.occurrence(document, snapshot, ordinal)
        if Self.isSameTable(session.identity, incoming.identity) { apply(incoming) }
    }

    /// Whether `document` can affect the open table: its own source, or the
    /// saved fragment a live source is provably persisted as.
    func tracks(_ document: NativeMarkdownTableDocument) -> Bool {
        guard let anchor = session?.identity.document else { return false }
        return document.isSameSource(as: anchor) || document.isPersistedForm(of: anchor)
    }

    /// `available` must contain every table of every tracked source currently
    /// rendered. A source that is missing means the table was removed.
    func reconcile(_ available: [NativeMarkdownTableOccurrence], currentNodeID: String) {
        guard let session else { return }
        guard DesignChatOpaqueID.same(session.identity.document.nodeID, currentNodeID) else {
            dismiss()
            return
        }
        if let match = Self.resolve(session.identity, in: available) {
            apply(match)
        } else {
            dismiss()
        }
    }

    func dismiss() {
        if session != nil { session = nil }
    }

    /// The open table's current occurrence, or `nil` when it cannot be proven.
    private static func resolve(_ anchor: NativeMarkdownTableIdentity, in available: [NativeMarkdownTableOccurrence]) -> NativeMarkdownTableOccurrence? {
        let own = available.filter {
            $0.identity.document.isSameSource(as: anchor.document) && $0.identity.ordinal == anchor.ordinal
        }
        if !own.isEmpty {
            // A different table now at this index, or two sources claiming
            // one block, is not provably the open table.
            guard own.count == 1, sameHeaders(own[0].identity, anchor) else { return nil }
            return own[0]
        }
        let persisted = available.filter {
            $0.identity.document.isPersistedForm(of: anchor.document)
                && $0.identity.ordinal == anchor.ordinal
                && sameHeaders($0.identity, anchor)
        }
        return persisted.count == 1 ? persisted[0] : nil
    }

    /// Present/sync requests must name the same source and the same ordinal.
    private static func isSameTable(_ anchor: NativeMarkdownTableIdentity, _ incoming: NativeMarkdownTableIdentity) -> Bool {
        anchor.ordinal == incoming.ordinal
            && incoming.document.isSameSource(as: anchor.document)
            && sameHeaders(incoming, anchor)
    }

    /// Header text identifies the table; alignments may still be streaming in
    /// the delimiter row and are updated rather than compared.
    private static func sameHeaders(_ lhs: NativeMarkdownTableIdentity, _ rhs: NativeMarkdownTableIdentity) -> Bool {
        sameStrings(lhs.signature.headers, rhs.signature.headers)
    }

    private static func occurrence(_ document: NativeMarkdownTableDocument, _ snapshot: NativeMarkdownTableSnapshot, _ ordinal: Int) -> NativeMarkdownTableOccurrence {
        .init(identity: .init(document: document, ordinal: ordinal, signature: snapshot.signature), snapshot: snapshot)
    }

    private func apply(_ match: NativeMarkdownTableOccurrence) {
        guard var next = session else { return }
        let identity = NativeMarkdownTableIdentity(
            document: match.identity.document.refining(next.identity.document),
            ordinal: match.identity.ordinal,
            signature: match.identity.signature
        )
        // Identical renders arrive on every token; publish only real changes.
        guard identity != next.identity || match.snapshot != next.snapshot else { return }
        next.identity = identity
        next.snapshot = match.snapshot
        session = next
    }
}

private func sameStrings(_ lhs: [String], _ rhs: [String]) -> Bool {
    lhs.count == rhs.count && zip(lhs, rhs).allSatisfy { $0.utf8.elementsEqual($1.utf8) }
}
