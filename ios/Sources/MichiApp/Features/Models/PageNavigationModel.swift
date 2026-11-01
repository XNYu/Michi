import Foundation
import MichiCore

/// Same-page TOC / named-block jump, or an exact native page jump when the
/// conversations `List` cannot scroll nested Home anchors. Scrolling never
/// writes the page; callers must not POST because a target was selected.
enum PageNavigation {
    static let maxDepth = 6
    static let maxOutline = 64
    static let maxMarkdownCharacters = 32_768
    static let maxMarkdownLines = 2_000
    static let highlightDuration: TimeInterval = 0.6
    static let screenAccessibilityID = "page-nav-screen"
    static let namedViewsAccessibilityID = "page-nav-named-views"

    enum Rejection: String, Equatable {
        case emptyTarget
        case missingTarget
        case staleTarget
        case duplicateTarget
        case missingPageIdentity
        case missingWorkspace
    }

    enum Decision: Equatable {
        case scroll(PageNavigationTarget)
        case openPage(PageNavigationJump)
        case rejected(Rejection)
    }

    static func blockAccessibilityID(_ id: String) -> String {
        "page-nav-block-\(id)"
    }

    static func tocAccessibilityID(_ id: String) -> String {
        "page-nav-toc-\(id)"
    }

    static func normalizedTarget(_ id: String?) -> String? {
        guard let id else { return nil }
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Headings in reading order from the current snapshot, including Markdown
    /// and headings inside toggle / tab / column / grid slots.
    static func outline(_ blocks: [JSONValue]) -> [PageNavigationHeading] {
        var collected: [PageNavigationHeading] = []
        walkOutline(blocks, top: true, depth: 0, into: &collected)
        return collected
    }

    /// Segment IDs are exactly the indices in MarkdownDocument.blocks. Only
    /// segmented top-level Markdown gets inner anchors; every other block is
    /// anchored once by its outer native view.
    static func headingAnchorIDs(blockID: String, text: String, topLevel: Bool, editing: Bool = false) -> [String] {
        guard !blockID.isEmpty else { return [] }
        let parts = markdownParts(text)
        let headings = parts.filter { $0.kind == .heading }
        guard !headings.isEmpty else { return [] }
        guard topLevel && !editing && parts.count > 1 else { return [] }
        return headings.map { segmentID(blockID, $0.index) }
    }

    /// A persisted edit marker is an object, not a Boolean. Unknown non-null
    /// markers conservatively keep whole-block navigation.
    static func hasEditMarker(_ block: JSONValue) -> Bool {
        !block["edit"].isNull && block["edit"] != false
    }

    /// Full-page TOC: stay in the current viewport when the target is unique
    /// in this snapshot. Reveals are recomputed from the live tree.
    static func resolveOnPage(targetID: String, blocks: [JSONValue]) -> Decision {
        switch match(targetID, in: blocks) {
        case .unique(let target):
            return .scroll(target)
        case .duplicate:
            return .rejected(.duplicateTarget)
        case .stale:
            return .rejected(.staleTarget)
        case .missing(let rejection):
            return .rejected(rejection)
        }
    }

    /// Named-view sheet / inline body: resolve only against displayed blocks.
    /// Never invent a parent-page scroll for a target the view does not show.
    static func resolveInScope(targetID: String, blocks: [JSONValue]) -> Decision {
        switch resolveOnPage(targetID: targetID, blocks: blocks) {
        case .scroll(var target):
            target.revealNamedViews = false
            return .scroll(target)
        case let other:
            return other
        }
    }

    /// Inline Home cannot scroll the outer conversations `List` from a nested
    /// row. A unique current target becomes an exact page jump using the Home
    /// page's own identity and workspace — never the chat picker.
    static func resolveHomeJump(
        targetID: String,
        pageID: String,
        workspaceID: String,
        blocks: [JSONValue]
    ) -> Decision {
        guard !pageID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .rejected(.missingPageIdentity)
        }
        guard !workspaceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .rejected(.missingWorkspace)
        }
        switch resolveOnPage(targetID: targetID, blocks: blocks) {
        case .scroll(let target):
            return .openPage(PageNavigationJump(pageID: pageID, workspaceID: workspaceID, blockID: target.scrollID))
        case .openPage(let jump):
            return .openPage(jump)
        case .rejected(let rejection):
            return .rejected(rejection)
        }
    }
}

struct PageNavigationHeading: Equatable, Identifiable {
    let id: String
    let text: String
    let level: Int
}

enum PageNavigationReveal: Equatable {
    case toggle(String)
    case tab(String, Int)
}

struct PageNavigationTarget: Equatable {
    let scrollID: String
    let blockID: String
    let topLevelID: String
    let segmentIndex: Int?
    let reveals: [PageNavigationReveal]
    var revealNamedViews: Bool
}

/// The disclosure anchor is typed so it cannot collide with a stored block ID.
enum PageNavigationScrollAnchor: Hashable {
    case block(String)
    case namedViews
}

/// A scroll request first materializes its List row. Hidden descendants only
/// become eligible after their actual views report layout, not after a timer.
struct PageNavigationScrollProgress: Equatable {
    struct Step: Equatable {
        let anchor: PageNavigationScrollAnchor
        let completes: Bool
    }
    let target: PageNavigationTarget
    private(set) var completed = false
    private var requested = Set<PageNavigationScrollAnchor>()

    init(target: PageNavigationTarget) { self.target = target }

    mutating func next(available: Set<PageNavigationScrollAnchor>) -> Step? {
        guard !completed else { return nil }
        if target.revealNamedViews, !available.contains(.namedViews) { return materialize(.namedViews) }
        let ancestor = PageNavigationScrollAnchor.block(target.topLevelID)
        if !available.contains(ancestor) { return materialize(ancestor) }
        let destination = PageNavigationScrollAnchor.block(target.scrollID)
        guard available.contains(destination) else { return nil }
        completed = true
        return Step(anchor: destination, completes: true)
    }

    private mutating func materialize(_ anchor: PageNavigationScrollAnchor) -> Step? {
        guard requested.insert(anchor).inserted else { return nil }
        return Step(anchor: anchor, completes: false)
    }
}

/// Navigation item for a confirmed page plus the exact block to reveal.
struct PageNavigationJump: Identifiable, Hashable {
    let pageID: String
    let workspaceID: String
    let blockID: String

    var id: String { pageID + "\u{1e}" + workspaceID + "\u{1e}" + blockID }

    static func make(pageID: String, workspaceID: String, blockID: String) -> Self? {
        let page = pageID.trimmingCharacters(in: .whitespacesAndNewlines)
        let workspace = workspaceID.trimmingCharacters(in: .whitespacesAndNewlines)
        let block = blockID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !page.isEmpty, !workspace.isEmpty, !block.isEmpty else { return nil }
        return Self(pageID: page, workspaceID: workspace, blockID: block)
    }
}

private enum PageNavigationMatch {
    case unique(PageNavigationTarget)
    case duplicate
    case stale
    case missing(PageNavigation.Rejection)
}

private struct PageNavigationHit {
    let blockID: String
    let scrollID: String
    let segmentIndex: Int?
    let reveals: [PageNavigationReveal]
    let topLevel: JSONValue
}

private struct PageNavigationMarkdownPart {
    enum Kind { case heading, other }
    let index: Int
    let kind: Kind
    let text: String
    let level: Int
}

private func match(_ targetID: String, in blocks: [JSONValue]) -> PageNavigationMatch {
    guard let target = PageNavigation.normalizedTarget(targetID) else {
        return .missing(.emptyTarget)
    }
    var hits: [PageNavigationHit] = []
    var stale = false
    walkHits(blocks, target: target, depth: 0, reveals: [], topLevel: nil, stale: &stale, into: &hits)
    if hits.count > 1 { return .duplicate }
    if let hit = hits.first {
        guard !hit.topLevel.id.isEmpty else { return .missing(.missingTarget) }
        return .unique(PageNavigationTarget(
            scrollID: hit.scrollID,
            blockID: hit.blockID,
            topLevelID: hit.topLevel.id,
            segmentIndex: hit.segmentIndex,
            reveals: hit.reveals,
            revealNamedViews: !RichPageBlockModel.isMainContent(hit.topLevel)
        ))
    }
    if stale { return .stale }
    return .missing(.missingTarget)
}

private func walkOutline(_ blocks: [JSONValue], top: Bool, depth: Int, into collected: inout [PageNavigationHeading]) {
    guard depth <= PageNavigation.maxDepth, collected.count < PageNavigation.maxOutline else { return }
    for block in blocks {
        guard collected.count < PageNavigation.maxOutline else { return }
        if block["type"].stringValue == "heading" {
            let text = headingWords(block["text"].stringValue)
            let id = block.id
            if !id.isEmpty, !text.isEmpty {
                let level = PageNavigation.positiveLevel(block["level"]) ?? 2
                collected.append(PageNavigationHeading(id: id, text: text, level: level))
            }
        } else if block["type"].stringValue == "markdown" {
            let parts = markdownParts(block["text"].stringValue)
            let cut = top && !PageNavigation.hasEditMarker(block) && parts.count > 1
            for part in parts where part.kind == .heading {
                guard collected.count < PageNavigation.maxOutline else { return }
                let text = headingWords(part.text)
                guard !text.isEmpty, !block.id.isEmpty else { continue }
                collected.append(PageNavigationHeading(
                    id: cut ? segmentID(block.id, part.index) : block.id,
                    text: text,
                    level: part.level
                ))
            }
        } else {
            for slot in navigationSlots(block) {
                walkOutline(slot, top: false, depth: depth + 1, into: &collected)
            }
        }
    }
}

private func walkHits(
    _ blocks: [JSONValue],
    target: String,
    depth: Int,
    reveals: [PageNavigationReveal],
    topLevel: JSONValue?,
    stale: inout Bool,
    into hits: inout [PageNavigationHit]
) {
    guard depth <= PageNavigation.maxDepth else { return }
    for block in blocks {
        let root = topLevel ?? block
        if block["type"].stringValue == "markdown" {
            let parts = markdownParts(block["text"].stringValue)
            if let segment = parseSegmentID(target), segment.blockID == block.id {
                if topLevel == nil, !PageNavigation.hasEditMarker(block), parts.count > 1,
                   let part = parts.first(where: { $0.index == segment.index }), part.kind == .heading, !block.id.isEmpty {
                    hits.append(PageNavigationHit(blockID: block.id, scrollID: target, segmentIndex: segment.index, reveals: reveals, topLevel: root))
                } else if !block.id.isEmpty {
                    stale = true
                }
            } else if block.id == target, !block.id.isEmpty {
                hits.append(PageNavigationHit(blockID: block.id, scrollID: block.id, segmentIndex: nil, reveals: reveals, topLevel: root))
            }
        } else if block.id == target, !block.id.isEmpty {
            hits.append(PageNavigationHit(blockID: block.id, scrollID: block.id, segmentIndex: nil, reveals: reveals, topLevel: root))
        }
        let slots = navigationSlots(block)
        for (index, slot) in slots.enumerated() {
            var next = reveals
            if let step = revealStep(block, slot: index) { next.append(step) }
            walkHits(slot, target: target, depth: depth + 1, reveals: next, topLevel: root, stale: &stale, into: &hits)
        }
    }
}

private func navigationSlots(_ block: JSONValue) -> [[JSONValue]] {
    switch block["type"].stringValue {
    case "toggle":
        return [Array(block["blocks"].arrayValue.prefix(20))]
    case "columns":
        return Array(block["columns"].arrayValue.prefix(4)).map { Array($0.arrayValue.prefix(20)) }
    case "tabs":
        return Array(block["tabs"].arrayValue.prefix(6)).map { Array($0["blocks"].arrayValue.prefix(20)) }
    case "grid":
        return Array(block["regions"].arrayValue.prefix(12)).map { Array($0["blocks"].arrayValue.prefix(20)) }
    default:
        return []
    }
}

private func revealStep(_ block: JSONValue, slot: Int) -> PageNavigationReveal? {
    let id = block.id
    guard !id.isEmpty else { return nil }
    switch block["type"].stringValue {
    case "toggle": return .toggle(id)
    case "tabs": return .tab(id, slot)
    default: return nil
    }
}

private func segmentID(_ blockID: String, _ index: Int) -> String { "\(blockID)~\(index)" }

private func parseSegmentID(_ id: String) -> (blockID: String, index: Int)? {
    guard let at = id.lastIndex(of: "~"), at > id.startIndex else { return nil }
    let tail = String(id[id.index(after: at)...])
    guard tail == "0" || (tail.first != "0" && tail.count <= 9 && tail.allSatisfy(\.isNumber)),
          let index = Int(tail) else { return nil }
    return (String(id[..<at]), index)
}

private func headingWords(_ line: String) -> String {
    var text = line
    if let regex = try? NSRegularExpression(pattern: #"!?\[([^\]]*)\]\([^)]*\)"#) {
        text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "$1")
    }
    if let regex = try? NSRegularExpression(pattern: #"[*_`~]"#) {
        text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
    }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

extension PageNavigation {
    fileprivate static func positiveLevel(_ value: JSONValue) -> Int? {
        guard let number = value.featureOptionalNumber, number.isFinite, (1...6).contains(number), number == number.rounded(.towardZero) else { return nil }
        return Int(number)
    }
}

private func markdownParts(_ text: String) -> [PageNavigationMarkdownPart] {
    guard text.count <= PageNavigation.maxMarkdownCharacters,
          text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count <= PageNavigation.maxMarkdownLines else { return [] }
    return MarkdownDocument(text).blocks.enumerated().map { index, block in
        if case .heading(let level, let text) = block {
            return PageNavigationMarkdownPart(index: index, kind: .heading, text: text, level: level)
        }
        return PageNavigationMarkdownPart(index: index, kind: .other, text: "", level: 0)
    }
}
