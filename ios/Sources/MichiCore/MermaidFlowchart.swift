import Foundation
import CoreGraphics

/// Bounded native Mermaid flowcharts. Grammar checked against Mermaid 11.12.2's
/// flow.jison (node delimiters and LINK/START_LINK tokens). `subgraph … end` groups
/// nest up to three levels (eight groups); a node belongs to the first subgraph that
/// closes while listing it, modelled on Mermaid 11's flowDb.addSubGraph de-duplication
/// (not re-run against an installed Mermaid for this subset). Styles,
/// directives, HTML/Markdown/entity labels, links to subgraph ids, empty or
/// differently directed subgraphs and unimplemented link semantics reject the whole
/// diagram, so MarkdownDocument retains the exact source as code.
public struct MarkdownFlowchart: Equatable, Sendable {
    public enum Direction: String, Equatable, Sendable {
        case topToBottom = "TB", bottomToTop = "BT", leftToRight = "LR", rightToLeft = "RL"
        public var horizontal: Bool { self == .leftToRight || self == .rightToLeft }
        public var reversed: Bool { self == .bottomToTop || self == .rightToLeft }
        public var description: String {
            switch self { case .topToBottom: return "Top to bottom"; case .bottomToTop: return "Bottom to top"
            case .leftToRight: return "Left to right"; case .rightToLeft: return "Right to left" }
        }
    }
    public struct Node: Equatable, Sendable, Identifiable {
        public let id: String
        public var label: String
        public var shape: Shape
        public var rank: Int
        /// Index into `groups` of the innermost subgraph that owns this node.
        public var group: Int? = nil
        public enum Shape: String, Equatable, Sendable { case rectangle, rounded, stadium, decision, circle, doubleCircle, cylinder }
    }
    /// A Mermaid subgraph. Indices follow `subgraph` statement order, so a parent
    /// always precedes its children.
    public struct Group: Equatable, Sendable, Identifiable {
        /// Explicit Mermaid id, or `[group <n>]` (never a valid explicit id) when
        /// Mermaid would generate one.
        public let id: String
        public let title: String
        public let parent: Int?
        public let depth: Int
        /// Distinct nodes seen before the subgraph opened; orders it among sibling nodes.
        public let position: Int
    }
    public struct Edge: Equatable, Sendable {
        public enum Stroke: String, Equatable, Sendable { case solid, dotted, thick }
        public let from: String
        public let to: String
        public let label: String
        public let arrow: Bool
        public let stroke: Stroke
    }
    public let source: String
    public let direction: Direction
    public var horizontal: Bool { direction.horizontal }
    public let nodes: [Node]
    public let edges: [Edge]
    public let groups: [Group]

    public var accessibilityDescription: String {
        let names = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.label.isEmpty ? $0.id : $0.label) })
        let vertices = nodes.map { "\(names[$0.id] ?? $0.id), \($0.shape.rawValue == "doubleCircle" ? "double circle" : $0.shape.rawValue)." }.joined(separator: " ")
        let clusters = groups.indices.map { index -> String in
            let group = groups[index]
            let members = nodes.filter { $0.group == index }.map { names[$0.id] ?? $0.id } + groups.filter { $0.parent == index }.map { "group " + $0.title }
            return "Group \(group.title)\(group.parent.map { ", inside \(groups[$0].title)," } ?? "") contains \(members.joined(separator: ", "))."
        }.joined(separator: " ")
        let links = edges.map { edge in
            "\(names[edge.from] ?? edge.from) \(edge.arrow ? "leads to" : "connects to") \(edge.from == edge.to ? "itself" : names[edge.to] ?? edge.to)\(edge.label.isEmpty ? "" : ", " + edge.label), \(edge.stroke.rawValue) line."
        }.joined(separator: " ")
        return "Flowchart. \(direction.description). \(vertices) \(clusters.isEmpty ? "" : clusters + " ")\(links)"
    }

    public static func parse(_ source: String) -> MarkdownFlowchart? {
        guard source.utf8.count <= 12_000, let statements = statements(source), let header = statements.first else { return nil }
        let words = header.split(whereSeparator: \.isWhitespace)
        guard words.count == 2, ["graph", "flowchart"].contains(String(words[0])),
              let direction = Direction(rawValue: words[1] == "TD" ? "TB" : String(words[1])) else { return nil }
        var nodes: [Node] = [], edges: [Edge] = [], groups: [Group] = []
        // Open subgraphs with the node ids their statements list, in order.
        var open: [(index: Int, members: [String])] = [], owner: [String: Int] = [:], groupNames = Set<String>()
        func readNode(_ cursor: inout Cursor) -> String? {
            cursor.spaces()
            let start = cursor.offset
            while let char = cursor.current, char.isASCII && (char.isLetter || char.isNumber || char == "_") { cursor.offset += 1 }
            let id = String(cursor.chars[start..<cursor.offset])
            guard (1...64).contains(id.count), !reserved.contains(id) else { return nil }
            cursor.spaces()
            var label = id, shape = Node.Shape.rectangle, declared = false
            for (open, close, candidate) in shapes where cursor.has(open) {
                cursor.offset += open.count
                guard let text = cursor.delimited(close: close, limit: 200) else { return nil }
                label = text; shape = candidate; declared = true; break
            }
            if let index = nodes.firstIndex(where: { $0.id == id }) {
                if declared { nodes[index].label = label; nodes[index].shape = shape }
            } else {
                guard nodes.count < 24 else { return nil }
                nodes.append(Node(id: id, label: label, shape: shape, rank: 0))
            }
            if !open.isEmpty { open[open.count - 1].members.append(id) }
            return id
        }
        for statement in statements.dropFirst() {
            if statement == "end" {
                // Mermaid adds a subgraph when it closes and drops members an
                // already added subgraph owns, so inner and earlier groups win.
                guard let group = open.popLast() else { return nil }
                for id in group.members where owner[id] == nil { owner[id] = group.index }
                guard owner.values.contains(group.index) || groups.contains(where: { $0.parent == group.index }) else { return nil }
                continue
            }
            if statement.hasPrefix("subgraph"), statement.dropFirst(8).first.map({ $0 == " " || $0 == "\t" }) ?? true {
                guard open.count < 3, groups.count < 8, let header = subgraphHeader(String(statement.dropFirst(8))) else { return nil }
                // A single-word quoted title may become Mermaid's id; keep it unreferenceable too.
                for name in [header.id, header.id == nil && identifier(header.title) ? header.title : nil].compactMap({ $0 }) {
                    guard !reserved.contains(name), groupNames.insert(name).inserted else { return nil }
                }
                groups.append(Group(id: header.id ?? "[group \(groups.count)]", title: header.title,
                                    parent: open.last?.index, depth: open.count, position: nodes.count))
                open.append((groups.count - 1, []))
                continue
            }
            if statement.hasPrefix("direction"), statement.dropFirst(9).first.map({ $0 == " " || $0 == "\t" }) ?? true {
                // Inside a subgraph only a no-op matching the diagram direction is native.
                let value = statement.dropFirst(9).trimmingCharacters(in: .whitespaces)
                guard !open.isEmpty, Direction(rawValue: value == "TD" ? "TB" : value) == direction else { return nil }
                continue
            }
            var cursor = Cursor(statement)
            guard var from = readNode(&cursor) else { return nil }
            cursor.spaces()
            while !cursor.ended {
                guard edges.count < 32, let link = cursor.link(), let to = readNode(&cursor) else { return nil }
                edges.append(Edge(from: from, to: to, label: link.label, arrow: link.arrow, stroke: link.stroke))
                from = to; cursor.spaces()
            }
        }
        // Mermaid links to a subgraph id as a cluster; that routing is not native.
        guard open.isEmpty, !nodes.isEmpty, !nodes.contains(where: { groupNames.contains($0.id) }) else { return nil }
        for index in nodes.indices { nodes[index].group = owner[nodes[index].id] }
        rank(&nodes, edges: edges)
        return MarkdownFlowchart(source: source, direction: direction, nodes: nodes, edges: edges, groups: groups)
    }

    private static let reserved: Set<String> = ["subgraph", "end", "direction", "style", "linkStyle", "classDef", "class", "click", "accTitle", "accDescr"]

    private static func identifier(_ value: String) -> Bool {
        (1...64).contains(value.count) && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
    }

    /// `subgraph id [title]`, `subgraph id["title"]`, `subgraph "title"`, `subgraph word`
    /// (id and title) or `subgraph several words` (generated id, as in flowDb).
    private static func subgraphHeader(_ text: String) -> (id: String?, title: String)? {
        let rest = text.trimmingCharacters(in: .whitespaces)
        guard let first = text.first, first == " " || first == "\t", !rest.isEmpty else { return nil }
        if rest.first == "\"" {
            let inner = String(rest.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
            guard rest.count >= 2, rest.last == "\"", !inner.isEmpty, !inner.contains("\""), Cursor.plain(inner, limit: 120) else { return nil }
            return (nil, inner)
        }
        if let open = rest.firstIndex(of: "["), rest.last == "]" {
            let id = rest[..<open].trimmingCharacters(in: .whitespaces)
            var cursor = Cursor(String(rest[rest.index(after: open)...]))
            guard identifier(id), let title = cursor.delimited(close: "]", limit: 120), cursor.ended else { return nil }
            let trimmed = title.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return nil }
            return (id, trimmed)
        }
        guard !rest.contains(where: { "[](){}\"|;".contains($0) }), Cursor.plain(rest, limit: 120) else { return nil }
        let generated = rest.contains(where: { $0 == " " || $0 == "\t" })
        return (generated ? nil : rest, rest)
    }

    private static let shapes: [(String, String, Node.Shape)] = [
        ("([", "])", .stadium), ("(((", ")))", .doubleCircle), ("((", "))", .circle), ("[(", ")]", .cylinder),
        ("[", "]", .rectangle), ("(", ")", .rounded), ("{", "}", .decision)
    ]

    /// Only whole-line comments are ignored. Directives must never be treated as
    /// comments. Statement separators inside quoted/plain node labels are kept.
    private static func statements(_ source: String) -> [String]? {
        guard !source.contains("%%{") else { return nil }
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        guard !normalized.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && $0 != "\n" && $0 != "\t" }) else { return nil }
        let lines = normalized.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("%%") }
        var result: [String] = [], current = "", stack: [Character] = [], quoted = false
        for char in lines.joined(separator: "\n") {
            if char == "\"" { quoted.toggle(); current.append(char); continue }
            if !quoted {
                if let close = [Character("["): Character("]"), "(": ")", "{": "}"][char] { stack.append(close) }
                else if ["]", ")", "}"].contains(char) { guard stack.popLast() == char else { return nil } }
            }
            if char == "\n" || (char == ";" && stack.isEmpty && !quoted) {
                guard stack.isEmpty && !quoted else { return nil }
                let text = current.trimmingCharacters(in: .whitespaces)
                if !text.isEmpty { result.append(text) }; current = ""
            } else { current.append(char) }
        }
        guard stack.isEmpty && !quoted else { return nil }
        let last = current.trimmingCharacters(in: .whitespaces)
        if !last.isEmpty { result.append(last) }
        return result
    }

    private struct Cursor {
        let chars: [Character]
        var offset = 0
        init(_ source: String) { chars = Array(source) }
        var ended: Bool { offset >= chars.count }
        var current: Character? { ended ? nil : chars[offset] }
        func has(_ token: String) -> Bool { chars.dropFirst(offset).starts(with: token) }
        mutating func spaces() { while let char = current, char == " " || char == "\t" { offset += 1 } }
        mutating func delimited(close: String, limit: Int) -> String? {
            spaces()
            let raw: String
            if current == "\"" {
                offset += 1; let start = offset
                while let char = current, char != "\"" { offset += 1 }
                guard !ended else { return nil }
                raw = String(chars[start..<offset]); offset += 1; spaces()
            } else {
                let start = offset
                while !ended && !has(close) { offset += 1 }
                raw = String(chars[start..<offset]).trimmingCharacters(in: .whitespaces)
                guard !raw.contains(where: { "[](){}\"".contains($0) }) else { return nil }
            }
            guard has(close), Self.plain(raw, limit: limit) else { return nil }
            offset += close.count
            return raw
        }
        static func plain(_ value: String, limit: Int) -> Bool {
            value.count <= limit && !value.contains(where: { "<>`&#\\".contains($0) || $0.isNewline })
        }
        mutating func link() -> (label: String, arrow: Bool, stroke: Edge.Stroke)? {
            spaces()
            let complete: [(String, Bool, Edge.Stroke)] = [("-.->", true, .dotted), ("-->", true, .solid), ("---", false, .solid), ("==>", true, .thick), ("===", false, .thick), ("-.-", false, .dotted)]
            for (token, arrow, stroke) in complete where has(token) {
                offset += token.count
                // Adjacent o/x endings are Mermaid's circle/cross arrows, not IDs.
                if !arrow, current == "o" || current == "x" { return nil }
                spaces(); var label = ""
                if current == "|" { offset += 1; guard let text = delimited(close: "|", limit: 120) else { return nil }; label = text }
                return (label, arrow, stroke)
            }
            // Mermaid's alternative labels: -- text -->, -. text .->, == text ==>.
            for (start, endings, stroke) in [("--", ["-->", "---"], Edge.Stroke.solid), ("-.", [".->", ".-"], .dotted), ("==", ["==>", "==="], .thick)] where has(start) {
                offset += start.count; spaces()
                let begin = offset
                var quoted = false
                while !ended {
                    if current == "\"" { quoted.toggle() }
                    if !quoted, let ending = endings.first(where: { has($0) }) {
                        var label = String(chars[begin..<offset]).trimmingCharacters(in: .whitespaces)
                        let quotedLabel = label.hasPrefix("\"") && label.hasSuffix("\"") && label.count >= 2
                        if quotedLabel { label = String(label.dropFirst().dropLast()) }
                        guard !label.isEmpty, !label.contains("\""), quotedLabel || !label.contains(where: { "[](){}|".contains($0) }), Self.plain(label, limit: 120) else { return nil }
                        offset += ending.count
                        let arrow = ending.hasSuffix(">")
                        if !arrow, current == "o" || current == "x" { return nil }
                        return (label, arrow, stroke)
                    }
                    offset += 1
                }
                return nil
            }
            return nil
        }
    }

    /// Strongly connected components are collapsed to a DAG. Components take
    /// longest-path ranks; members of a cycle occupy consecutive ranks in first
    /// source appearance order. This is deterministic and leaves returns explicit.
    private static func rank(_ nodes: inout [Node], edges: [Edge]) {
        let ids = nodes.map(\.id), indices = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, $0.offset) })
        let adjacent = ids.map { id in Array(Set(edges.filter { $0.from == id }.compactMap { indices[$0.to] })).sorted() }
        var serial = 0, indexes = Array(repeating: -1, count: ids.count), low = indexes
        var stack: [Int] = [], onStack = Set<Int>(), components: [[Int]] = []
        func visit(_ v: Int) {
            indexes[v] = serial; low[v] = serial; serial += 1; stack.append(v); onStack.insert(v)
            for w in adjacent[v] {
                if indexes[w] == -1 { visit(w); low[v] = min(low[v], low[w]) }
                else if onStack.contains(w) { low[v] = min(low[v], indexes[w]) }
            }
            if low[v] == indexes[v] {
                var members: [Int] = []
                while let w = stack.popLast() { onStack.remove(w); members.append(w); if w == v { break } }
                components.append(members.sorted())
            }
        }
        for v in ids.indices where indexes[v] == -1 { visit(v) }
        components.sort { $0[0] < $1[0] }
        var membership = Array(repeating: 0, count: ids.count)
        for (component, members) in components.enumerated() { for member in members { membership[member] = component } }
        var links = Array(repeating: Set<Int>(), count: components.count), incoming = Array(repeating: 0, count: components.count)
        for v in ids.indices { for w in adjacent[v] where membership[v] != membership[w] { links[membership[v]].insert(membership[w]) } }
        for targets in links { for target in targets { incoming[target] += 1 } }
        var ranks = Array(repeating: 0, count: components.count), ready = incoming.indices.filter { incoming[$0] == 0 }
        while let component = ready.first {
            ready.removeFirst()
            for (offset, member) in components[component].enumerated() { nodes[member].rank = ranks[component] + offset }
            for target in links[component].sorted() {
                ranks[target] = max(ranks[target], ranks[component] + components[component].count)
                incoming[target] -= 1
                if incoming[target] == 0 { ready.append(target); ready.sort() }
            }
        }
    }
}

/// Pure geometry shared by the SwiftUI renderer and tests. Adjacent forward
/// edges occupy rank gaps. Returns, self loops, skips and parallel edges use
/// distinct outer channels, with stems in rank gaps rather than through peers.
/// Each subgraph owns a contiguous cross-axis band across its ranks, so its frame
/// contains exactly its members; its title takes a slot in its first visual rank,
/// never a gap, so no route or edge label crosses it.
public struct MarkdownFlowchartLayout: Equatable, Sendable {
    public struct NodeFrame: Equatable, Sendable { public let id: String; public let rect: CGRect }
    public struct GroupFrame: Equatable, Sendable {
        public let id: String
        public let rect: CGRect
        public let titleRect: CGRect
        public let depth: Int
    }
    public struct Route: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case direct, returning, selfLoop }
        public let edgeIndex: Int
        public let points: [CGPoint]
        public let labelRect: CGRect
        public let kind: Kind
    }
    public let nodes: [NodeFrame]
    /// One frame per `graph.groups` entry, in the same order.
    public let groups: [GroupFrame]
    public let routes: [Route]
    public let size: CGSize

    public init(graph: MarkdownFlowchart, nodeSizes: [String: CGSize] = [:], labelSizes: [CGSize] = [], groupTitleSizes: [CGSize] = [], scale: CGFloat = 1) {
        let scale = scale.isFinite ? min(3, max(1, scale)) : 1
        let horizontal = graph.horizontal
        func main(_ size: CGSize) -> CGFloat { horizontal ? size.width : size.height }
        func cross(_ size: CGSize) -> CGFloat { horizontal ? size.height : size.width }
        func safe(_ size: CGSize, fallback: CGSize) -> CGSize {
            guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return fallback }
            return CGSize(width: min(2_048, size.width), height: min(2_048, size.height))
        }
        let sizes = graph.nodes.map { node -> CGSize in
            let fallback = CGSize(width: 180 * scale, height: 80 * scale)
            var size = safe(nodeSizes[node.id] ?? fallback, fallback: fallback)
            if node.shape == .circle || node.shape == .doubleCircle { size = CGSize(width: max(size.width, size.height), height: max(size.width, size.height)) }
            return size
        }
        let labels = graph.edges.indices.map { i -> CGSize in
            if graph.edges[i].label.isEmpty { return .zero }
            let fallback = CGSize(width: 140 * scale, height: 40 * scale)
            return safe(labelSizes.indices.contains(i) ? labelSizes[i] : fallback, fallback: fallback)
        }
        let titles = graph.groups.indices.map { i -> CGSize in
            let fallback = CGSize(width: 148 * scale, height: 28 * scale)
            return safe(groupTitleSizes.indices.contains(i) ? groupTitleSizes[i] : fallback, fallback: fallback)
        }
        let byID = Dictionary(uniqueKeysWithValues: graph.nodes.enumerated().map { ($0.element.id, $0.offset) })
        let rankCount = (graph.nodes.map(\.rank).max() ?? 0) + 1
        let groupCount = graph.groups.count
        var lowRank = Array(repeating: Int.max, count: groupCount), highRank = Array(repeating: Int.min, count: groupCount)
        for node in graph.nodes {
            var current = node.group
            while let group = current, group < groupCount {
                lowRank[group] = min(lowRank[group], node.rank); highRank[group] = max(highRank[group], node.rank)
                current = graph.groups[group].parent.flatMap { $0 < group ? $0 : nil }
            }
        }
        for group in 0..<groupCount where lowRank[group] == .max { lowRank[group] = 0; highRank[group] = 0 }
        // Outer frames get wider main-axis padding than every frame they contain.
        var nesting = Array(repeating: 0, count: groupCount)
        for group in (0..<groupCount).reversed() { if let parent = graph.groups[group].parent, parent < group { nesting[parent] = max(nesting[parent], nesting[group] + 1) } }
        let framePad = nesting.map { 10 * scale + 8 * scale * CGFloat($0) }
        let titleRank = (0..<groupCount).map { graph.direction.reversed ? highRank[$0] : lowRank[$0] }
        var startPad = Array(repeating: CGFloat.zero, count: rankCount), endPad = startPad
        for group in 0..<groupCount {
            startPad[lowRank[group]] = max(startPad[lowRank[group]], framePad[group])
            endPad[highRank[group]] = max(endPad[highRank[group]], framePad[group])
        }
        let rankMembers = (0..<rankCount).map { rank in graph.nodes.indices.filter { graph.nodes[$0].rank == rank } }
        let mainSizes = (0..<rankCount).map { rank in
            max(rankMembers[rank].map { main(sizes[$0]) }.max() ?? 0, (0..<groupCount).filter { titleRank[$0] == rank }.map { main(titles[$0]) }.max() ?? 0)
        }
        // Bands: runs of loose sibling nodes stack per rank; each group is a band of
        // its own children. Siblings follow first appearance in the source.
        indirect enum Band { case stack([Int], title: Int?), group(Int, [Band]) }
        enum Slot { case node(Int), title(Int) }
        let slotGap = 32 * scale, bandGap = 32 * scale, frameInset = 12 * scale, frameGap = 24 * scale
        func bands(_ parent: Int?) -> [Band] {
            var keyed: [(key: Int, order: Int, group: Bool)] = graph.nodes.indices.filter { graph.nodes[$0].group == parent }.map { (key: 2 * $0 + 1, order: $0, group: false) }
            keyed += (0..<groupCount).filter { graph.groups[$0].parent == parent }.map { (key: 2 * graph.groups[$0].position, order: $0, group: true) }
            keyed.sort { ($0.key, $0.order) < ($1.key, $1.order) }
            var result: [Band] = [], loose: [Int] = []
            for entry in keyed {
                guard entry.group else { loose.append(entry.order); continue }
                if !loose.isEmpty { result.append(.stack(loose, title: nil)); loose = [] }
                result.append(.group(entry.order, bands(entry.order)))
            }
            if !loose.isEmpty { result.append(.stack(loose, title: nil)) }
            if let parent {
                if case .stack(let first, _)? = result.first { result[0] = .stack(first, title: parent) }
                else { result.insert(.stack([], title: parent), at: 0) }
            }
            return result
        }
        func slotCross(_ slot: Slot) -> CGFloat {
            switch slot { case .node(let i): return cross(sizes[i]); case .title(let g): return cross(titles[g]) }
        }
        func slots(_ members: [Int], _ title: Int?, _ rank: Int) -> [Slot] {
            (title.flatMap { titleRank[$0] == rank ? [Slot.title($0)] : nil } ?? []) + members.filter { graph.nodes[$0].rank == rank }.map(Slot.node)
        }
        func extent(_ list: [Slot]) -> CGFloat { list.reduce(CGFloat.zero) { $0 + slotCross($1) } + CGFloat(max(0, list.count - 1)) * slotGap }
        func width(_ band: Band) -> CGFloat {
            switch band {
            case .stack(let members, let title): return (0..<rankCount).map { extent(slots(members, title, $0)) }.max() ?? 0
            case .group(_, let children):
                return 2 * frameInset + children.reduce(CGFloat.zero) { $0 + width($1) } + CGFloat(max(0, children.count - 1)) * frameGap
            }
        }
        let roots = bands(nil)
        let crossLength = roots.reduce(CGFloat.zero) { $0 + width($1) } + CGFloat(max(0, roots.count - 1)) * bandGap
        let direct = graph.edges.indices.filter { i in
            let edge = graph.edges[i]
            guard let from = byID[edge.from], let to = byID[edge.to] else { return false }
            return graph.nodes[to].rank == graph.nodes[from].rank + 1 && !graph.edges.prefix(i).contains { $0.from == edge.from && $0.to == edge.to }
        }
        let directSet = Set(direct)
        let gapLabels = (0..<rankCount).map { rank in direct.filter { graph.nodes[byID[graph.edges[$0].from]!].rank == rank && !graph.edges[$0].label.isEmpty } }
        // A gap holds closing frame borders, then the edge/label region, then opening borders.
        let labelRegions = gapLabels.map { ids in max(56 * scale, ids.reduce(CGFloat.zero) { $0 + main(labels[$1]) + 20 * scale }) }
        var gaps: [CGFloat] = []
        for rank in 0..<rankCount {
            let openingPadding: CGFloat = rank + 1 < rankCount ? startPad[rank + 1] : 0
            gaps.append(endPad[rank] + labelRegions[rank] + openingPadding)
        }
        let margin = max(28 * scale, (labels.map(main).max() ?? 0) / 2 + 12 * scale)
        var origins: [CGFloat] = [], cursor = margin + startPad[0]
        for rank in 0..<rankCount { origins.append(cursor); cursor += mainSizes[rank] + (rank + 1 < rankCount ? gaps[rank] : 0) }
        let mainLength = cursor + endPad[rankCount - 1] + margin
        var centers = Array(repeating: CGPoint.zero, count: graph.nodes.count)
        var titleCenters = Array(repeating: CGPoint.zero, count: groupCount)
        var crossSpans = Array(repeating: (CGFloat.zero, CGFloat.zero), count: groupCount)
        func place(_ band: Band, at start: CGFloat) {
            switch band {
            case .stack(let members, let title):
                let bandWidth = width(band)
                for rank in 0..<rankCount {
                    var list = slots(members, title, rank)
                    var lane = start + (bandWidth - extent(list)) / 2
                    if case .title(let group)? = list.first {
                        // The title keeps the leading corner; the rank's nodes centre in the rest.
                        let size = titles[group], titleCross = cross(size), titleMain = main(size)
                        titleCenters[group] = CGPoint(x: graph.direction.reversed ? origins[rank] + mainSizes[rank] - titleMain / 2 : origins[rank] + titleMain / 2,
                                                      y: start + titleCross / 2)
                        list.removeFirst()
                        let rest = start + titleCross + slotGap
                        lane = rest + (start + bandWidth - rest - extent(list)) / 2
                    }
                    for slot in list {
                        guard case .node(let index) = slot else { continue }
                        centers[index] = CGPoint(x: origins[rank] + mainSizes[rank] / 2, y: lane + cross(sizes[index]) / 2)
                        lane += cross(sizes[index]) + slotGap
                    }
                }
            case .group(let group, let children):
                crossSpans[group] = (start, start + width(band))
                var lane = start + frameInset
                for child in children { place(child, at: lane); lane += width(child) + frameGap }
            }
        }
        var bandStart = 16 * scale
        for band in roots { place(band, at: bandStart); bandStart += width(band) + bandGap }
        func physical(_ point: CGPoint) -> CGPoint {
            let axis = graph.direction.reversed ? mainLength - point.x : point.x
            return horizontal ? CGPoint(x: axis, y: point.y) : CGPoint(x: point.y, y: axis)
        }
        nodes = graph.nodes.indices.map { i in
            let point = physical(centers[i])
            return NodeFrame(id: graph.nodes[i].id, rect: CGRect(x: point.x - sizes[i].width / 2, y: point.y - sizes[i].height / 2, width: sizes[i].width, height: sizes[i].height))
        }
        groups = (0..<groupCount).map { group in
            let a = physical(CGPoint(x: origins[lowRank[group]] - framePad[group], y: crossSpans[group].0))
            let b = physical(CGPoint(x: origins[highRank[group]] + mainSizes[highRank[group]] + framePad[group], y: crossSpans[group].1))
            let title = physical(titleCenters[group]), size = titles[group]
            return GroupFrame(id: graph.groups[group].id,
                              rect: CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y)),
                              titleRect: CGRect(x: title.x - size.width / 2, y: title.y - size.height / 2, width: size.width, height: size.height),
                              depth: graph.groups[group].depth)
        }
        var routes: [Route] = [], outside = 16 * scale + crossLength + 24 * scale
        for (i, edge) in graph.edges.enumerated() {
            guard let from = byID[edge.from], let to = byID[edge.to] else { continue }
            let a = CGPoint(x: centers[from].x + main(sizes[from]) / 2, y: centers[from].y)
            let b = CGPoint(x: centers[to].x - main(sizes[to]) / 2, y: centers[to].y)
            let fromRank = graph.nodes[from].rank, toRank = graph.nodes[to].rank
            let points: [CGPoint], labelCenter: CGPoint, kind: Route.Kind
            if directSet.contains(i) {
                let ids = gapLabels[fromRank]
                let before = ids.prefix(while: { $0 != i }).reduce(CGFloat.zero) { $0 + main(labels[$1]) + 20 * scale }
                let mid = origins[fromRank] + mainSizes[fromRank] + endPad[fromRank] + (edge.label.isEmpty ? labelRegions[fromRank] / 2 : before + 10 * scale + main(labels[i]) / 2)
                points = [a, CGPoint(x: mid, y: a.y), CGPoint(x: mid, y: b.y), b]
                labelCenter = CGPoint(x: mid, y: (a.y + b.y) / 2); kind = .direct
            } else {
                let channel = outside + max(12 * scale, cross(labels[i]) / 2)
                let exit = origins[fromRank] + mainSizes[fromRank] + endPad[fromRank] + 12 * scale
                let entry = origins[toRank] - startPad[toRank] - 12 * scale
                points = [a, CGPoint(x: exit, y: a.y), CGPoint(x: exit, y: channel), CGPoint(x: entry, y: channel), CGPoint(x: entry, y: b.y), b]
                labelCenter = CGPoint(x: (exit + entry) / 2, y: channel)
                outside = channel + max(12 * scale, cross(labels[i]) / 2) + 16 * scale
                kind = from == to ? .selfLoop : .returning
            }
            let center = physical(labelCenter)
            var compact: [CGPoint] = []
            for point in points.map(physical) where compact.last != point { compact.append(point) }
            routes.append(Route(edgeIndex: i, points: compact, labelRect: CGRect(x: center.x - labels[i].width / 2, y: center.y - labels[i].height / 2, width: labels[i].width, height: labels[i].height), kind: kind))
        }
        self.routes = routes
        let extent = max(16 * scale + crossLength + 16 * scale, outside)
        size = horizontal ? CGSize(width: mainLength, height: extent) : CGSize(width: extent, height: mainLength)
    }
}
