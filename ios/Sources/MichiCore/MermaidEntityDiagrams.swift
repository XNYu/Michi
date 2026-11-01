import CoreGraphics
import Foundation

/// Bounded native `classDiagram` subset. Class names, attributes, methods and
/// the eight standard relation marks (with quoted cardinality) are kept; anything
/// whose mark or member cannot be drawn rejects the whole source.
public struct MarkdownClassDiagram: Equatable, Sendable {
    public enum Direction: String, Equatable, Sendable {
        case topToBottom = "TB", bottomToTop = "BT", leftToRight = "LR", rightToLeft = "RL"
        public var horizontal: Bool { self == .leftToRight || self == .rightToLeft }
        public var reversed: Bool { self == .bottomToTop || self == .rightToLeft }
    }
    public enum Visibility: String, Equatable, Sendable {
        case publicAccess = "+", privateAccess = "-", protectedAccess = "#", packageAccess = "~"
        public var spoken: String {
            switch self {
            case .publicAccess: return "public"
            case .privateAccess: return "private"
            case .protectedAccess: return "protected"
            case .packageAccess: return "package"
            }
        }
    }
    public enum Classifier: String, Equatable, Sendable {
        case staticMember = "$", abstractMember = "*"
        public var spoken: String { self == .staticMember ? "static" : "abstract" }
    }
    public struct Member: Equatable, Sendable {
        public enum Kind: String, Equatable, Sendable { case attribute, method }
        public let visibility: Visibility?
        public let text: String
        public let kind: Kind
        public let classifier: Classifier?
    }
    public struct Class: Equatable, Sendable, Identifiable {
        public let id: String
        public var members: [Member]
    }
    public enum RelationKind: String, Equatable, Sendable {
        case inheritance, composition, aggregation, association, dependency, realization, link, dashedLink
        public var spoken: String {
            switch self {
            case .inheritance: return "inherits"
            case .composition: return "composes"
            case .aggregation: return "aggregates"
            case .association: return "associates with"
            case .dependency: return "depends on"
            case .realization: return "realizes"
            case .link: return "links to"
            case .dashedLink: return "dashed-links to"
            }
        }
    }
    public struct Relation: Equatable, Sendable {
        public let left: String
        public let right: String
        public let leftCardinality: String
        public let rightCardinality: String
        public let kind: RelationKind
        public let token: String
        public let from: String
        public let to: String
        public let label: String
    }
    public let source: String
    public let direction: Direction
    public let classes: [Class]
    public let relations: [Relation]

    public var accessibilityDescription: String {
        let types = classes.map { item -> String in
            let members = item.members.map { member -> String in
                let visibility = member.visibility.map { $0.spoken + " " } ?? ""
                let classifier = member.classifier.map { ", " + $0.spoken } ?? ""
                return "\(visibility)\(member.kind.rawValue) \(member.text)\(classifier)"
            }
            return "Class \(item.id)." + (members.isEmpty ? "" : " " + members.joined(separator: ". ") + ".")
        }
        let links = relations.map { relation -> String in
            var text = "\(relation.from) \(relation.kind.spoken) \(relation.to)"
            if !relation.leftCardinality.isEmpty || !relation.rightCardinality.isEmpty {
                let left = relation.leftCardinality.isEmpty ? "unspecified" : relation.leftCardinality
                let right = relation.rightCardinality.isEmpty ? "unspecified" : relation.rightCardinality
                text += ", cardinality \(left) at \(relation.left), \(right) at \(relation.right)"
            }
            if !relation.label.isEmpty { text += ": " + relation.label }
            return text + "."
        }
        return (["Class diagram."] + types + links).joined(separator: " ")
    }

    public static func parse(_ source: String) -> Self? {
        guard let lines = EntityMermaid.lines(source, allowBraces: true), lines.first == "classDiagram" else { return nil }
        var classes: [Class] = [], relations: [Relation] = [], declared = Set<String>()
        var direction = Direction.topToBottom, directionSeen = false, open: String?
        func ensure(_ id: String) -> Bool {
            guard EntityMermaid.identifier(id), !Self.reserved.contains(id) else { return false }
            if classes.contains(where: { $0.id == id }) { return true }
            guard classes.count < 12 else { return false }
            classes.append(.init(id: id, members: []))
            return true
        }
        func declare(_ id: String) -> Bool { ensure(id) && declared.insert(id).inserted }
        func addMember(_ id: String, _ member: Member) -> Bool {
            guard ensure(id), let index = classes.firstIndex(where: { $0.id == id }), classes[index].members.count < 8 else { return false }
            classes[index].members.append(member)
            return true
        }
        for line in lines.dropFirst() {
            if line.hasPrefix("direction ") {
                let value = String(line.dropFirst(10))
                guard open == nil, !directionSeen, classes.isEmpty, relations.isEmpty,
                      let next = Direction(rawValue: value == "TD" ? "TB" : value) else { return nil }
                direction = next; directionSeen = true; continue
            }
            if line == "}" {
                guard open != nil else { return nil }
                open = nil; continue
            }
            if line.contains("{") || line.contains("}") {
                guard let id = EntityMermaid.capture(#"^class ([A-Za-z_][A-Za-z0-9_]{0,47})\s*\{$"#, line)?.first,
                      open == nil, declare(id) else { return nil }
                open = id; continue
            }
            if let id = EntityMermaid.capture(#"^class ([A-Za-z_][A-Za-z0-9_]{0,47})$"#, line)?.first {
                guard open == nil, declare(id) else { return nil }; continue
            }
            if let openID = open {
                guard let member = parseMember(line), addMember(openID, member) else { return nil }; continue
            }
            if let relation = parseRelation(line) {
                guard ensure(relation.left), ensure(relation.right), relations.count < 16 else { return nil }
                relations.append(relation); continue
            }
            if let fields = EntityMermaid.capture(#"^([A-Za-z_][A-Za-z0-9_]{0,47})\s*:\s*(.+)$"#, line),
               let member = parseMember(fields[1]) {
                guard addMember(fields[0], member) else { return nil }; continue
            }
            return nil
        }
        guard open == nil, !classes.isEmpty else { return nil }
        return .init(source: source, direction: direction, classes: classes, relations: relations)
    }

    private static let reserved: Set<String> = [
        "class", "classDiagram", "direction", "namespace", "note", "click", "style", "cssClass",
        "callback", "link", "end", "accTitle", "accDescr", "annotate", "hide"
    ]
    private static let tokens = [
        "<|--", "--|>", "<|..", "..|>", "*--", "--*", "o--", "--o", "-->", "<--", "..>", "<..", "--", ".."
    ]

    private static func parseMember(_ line: String) -> Member? {
        var body = line, visibility: Visibility?, classifier: Classifier?
        if let mark = line.first, let value = Visibility(rawValue: String(mark)) {
            visibility = value; body = String(line.dropFirst())
        }
        if let mark = body.last, let value = Classifier(rawValue: String(mark)) {
            classifier = value; body = String(body.dropLast())
        }
        guard let text = EntityMermaid.label(body, limit: 80), !text.contains("~") else { return nil }
        let method = text.contains("(")
        if method {
            var depth = 0
            for char in text {
                if char == "(" { depth += 1 }
                if char == ")" { depth -= 1; if depth < 0 { return nil } }
            }
            guard depth == 0, text.contains(")") else { return nil }
        }
        return .init(visibility: visibility, text: text, kind: method ? .method : .attribute, classifier: classifier)
    }

    private static func parseRelation(_ line: String) -> Relation? {
        var cursor = EntityMermaid.Cursor(line)
        guard let left = cursor.identifier() else { return nil }
        cursor.spaces()
        let leftCard = cursor.current == "\"" ? cursor.quoted(limit: 24) : ""
        guard let leftCardinality = leftCard else { return nil }
        cursor.spaces()
        guard let token = cursor.take(tokens), let kind = kind(for: token) else { return nil }
        cursor.spaces()
        let rightCard = cursor.current == "\"" ? cursor.quoted(limit: 24) : ""
        guard let rightCardinality = rightCard else { return nil }
        cursor.spaces()
        guard let right = cursor.identifier() else { return nil }
        cursor.spaces()
        var label = ""
        if cursor.current == ":" {
            cursor.offset += 1
            guard let text = EntityMermaid.relationLabel(cursor.rest, allowEmpty: true) else { return nil }
            label = text
        } else if !cursor.ended { return nil }
        let reverse = ["<|--", "<|..", "--*", "--o", "<--", "<.."].contains(token)
        return .init(left: left, right: right, leftCardinality: leftCardinality, rightCardinality: rightCardinality,
                     kind: kind, token: token, from: reverse ? right : left, to: reverse ? left : right, label: label)
    }

    private static func kind(for token: String) -> RelationKind? {
        switch token {
        case "<|--", "--|>": return .inheritance
        case "*--", "--*": return .composition
        case "o--", "--o": return .aggregation
        case "-->", "<--": return .association
        case "..>", "<..": return .dependency
        case "<|..", "..|>": return .realization
        case "--": return .link
        case "..": return .dashedLink
        default: return nil
        }
    }
}

/// Single-line 12 pt edge chips used by class/ER layouts. Tests and Core share
/// the same box so cardinality/label clearance is measurable.
public enum MarkdownEntityAnnotation {
    public struct Extent: Equatable, Sendable {
        public var left: CGSize
        public var right: CGSize
        public var label: CGSize
        public init(left: CGSize = .zero, right: CGSize = .zero, label: CGSize = .zero) {
            self.left = left
            self.right = right
            self.label = label
        }
    }

    public static func size(_ text: String, scale: CGFloat = 1) -> CGSize {
        guard !text.isEmpty, scale.isFinite, scale > 0 else { return .zero }
        return CGSize(width: CGFloat(text.count) * 7.2 * scale + 4 * scale, height: 20 * scale)
    }

    public static func extent(left: String = "", right: String = "", label: String = "", scale: CGFloat = 1) -> Extent {
        Extent(left: size(left, scale: scale), right: size(right, scale: scale), label: size(label, scale: scale))
    }
}

/// Source-order boxes. TB/BT stack vertically; LR/RL sit in a row. Invalid sizes
/// become an infinite canvas so the UI can keep the exact source instead.
public struct MarkdownClassDiagramLayout: Equatable, Sendable {
    public struct Box: Equatable, Sendable { public let id: String; public let rect: CGRect }
    public struct EdgeGeometry: Equatable, Sendable {
        public let points: [CGPoint]
        public let leftCardinality: CGPoint
        public let rightCardinality: CGPoint
        public let label: CGPoint
    }
    public let size: CGSize
    public let boxes: [Box]
    public let edges: [EdgeGeometry]

    public init(diagram: MarkdownClassDiagram, boxSizes: [String: CGSize] = [:], annotations: [MarkdownEntityAnnotation.Extent] = [], scale: CGFloat = 1) {
        let chips = diagram.relations.enumerated().map { index, relation in
            annotations.indices.contains(index)
                ? annotations[index]
                : MarkdownEntityAnnotation.extent(left: relation.leftCardinality, right: relation.rightCardinality, label: relation.label, scale: scale)
        }
        let ids = diagram.classes.map(\.id)
        var gap = 48 * scale
        for (index, relation) in diagram.relations.enumerated() {
            guard let left = ids.firstIndex(of: relation.left), let right = ids.firstIndex(of: relation.right),
                  abs(left - right) == 1 else { continue }
            gap = max(gap, EntityBoxLayout.adjacentGap(chips[index], scale: scale))
        }
        let placed = EntityBoxLayout.place(
            ids: ids,
            sizes: Dictionary(uniqueKeysWithValues: diagram.classes.map {
                ($0.id, boxSizes[$0.id] ?? CGSize(width: 180 * scale, height: CGFloat(36 + 20 * $0.members.count) * scale))
            }),
            horizontal: diagram.direction.horizontal, reversed: diagram.direction.reversed, scale: scale, gap: gap)
        guard let placed,
              let routed = EntityBoxLayout.route(
                pairs: diagram.relations.enumerated().map { (left: $1.left, right: $1.right, chips: chips[$0]) },
                boxes: placed.boxes, size: placed.size,
                horizontal: diagram.direction.horizontal, scale: scale)
        else { size = CGSize(width: CGFloat.infinity, height: CGFloat.infinity); boxes = []; edges = []; return }
        size = routed.size
        boxes = placed.boxes.map { Box(id: $0.id, rect: $0.rect) }
        edges = routed.edges.map {
            EdgeGeometry(points: $0.points, leftCardinality: $0.leftCardinality, rightCardinality: $0.rightCardinality, label: $0.label)
        }
    }
}

/// Bounded native `erDiagram` subset. Entity attributes and both-end cardinalities
/// (identifying / non-identifying) are retained; unknown marks reject the source.
public struct MarkdownERDiagram: Equatable, Sendable {
    public enum Cardinality: String, Equatable, Sendable {
        case zeroOrOne, exactlyOne, zeroOrMore, oneOrMore
        public var spoken: String {
            switch self {
            case .zeroOrOne: return "zero or one"
            case .exactlyOne: return "exactly one"
            case .zeroOrMore: return "zero or more"
            case .oneOrMore: return "one or more"
            }
        }
    }
    public enum Key: String, Equatable, Sendable {
        case primary, foreign, unique
        public var spoken: String {
            switch self { case .primary: return "primary key"; case .foreign: return "foreign key"; case .unique: return "unique key" }
        }
    }
    public struct Attribute: Equatable, Sendable {
        public let type: String
        public let name: String
        public let keys: [Key]
        public let comment: String
    }
    public struct Entity: Equatable, Sendable, Identifiable {
        public let id: String
        public var attributes: [Attribute]
    }
    public struct Relation: Equatable, Sendable {
        public let left: String
        public let right: String
        public let leftCardinality: Cardinality
        public let rightCardinality: Cardinality
        public let identifying: Bool
        public let label: String
    }
    public let source: String
    public let entities: [Entity]
    public let relations: [Relation]

    public var accessibilityDescription: String {
        let items = entities.map { entity -> String in
            let attributes = entity.attributes.map { attribute -> String in
                var text = "\(attribute.type) \(attribute.name)"
                if !attribute.keys.isEmpty { text += ", " + attribute.keys.map(\.spoken).joined(separator: ", ") }
                if !attribute.comment.isEmpty { text += ", " + attribute.comment }
                return text
            }
            return "Entity \(entity.id)." + (attributes.isEmpty ? "" : " " + attributes.joined(separator: ". ") + ".")
        }
        let links = relations.map { relation in
            "\(relation.left) \(relation.label) \(relation.right), \(relation.leftCardinality.spoken) to \(relation.rightCardinality.spoken), \(relation.identifying ? "identifying" : "non-identifying")."
        }
        return (["ER diagram."] + items + links).joined(separator: " ")
    }

    public static func parse(_ source: String) -> Self? {
        guard let lines = EntityMermaid.lines(source, allowBraces: true), lines.first == "erDiagram" else { return nil }
        var entities: [Entity] = [], relations: [Relation] = [], declared = Set<String>(), open: String?
        func ensure(_ id: String) -> Bool {
            guard EntityMermaid.identifier(id, extra: "-"), !Self.reserved.contains(id) else { return false }
            if entities.contains(where: { $0.id == id }) { return true }
            guard entities.count < 12 else { return false }
            entities.append(.init(id: id, attributes: []))
            return true
        }
        for line in lines.dropFirst() {
            if line == "}" {
                guard open != nil else { return nil }
                open = nil; continue
            }
            // Crow's-foot cardinalities contain braces too; distinguish a
            // complete relationship before treating a brace as an entity body.
            if open == nil, let relation = parseRelation(line) {
                guard ensure(relation.left), ensure(relation.right), relations.count < 16 else { return nil }
                relations.append(relation); continue
            }
            if line.contains("{") || line.contains("}") {
                guard let id = EntityMermaid.capture(#"^([A-Za-z_][A-Za-z0-9_-]{0,47})\s*\{$"#, line)?.first,
                      open == nil, EntityMermaid.identifier(id, extra: "-"), !reserved.contains(id),
                      ensure(id), declared.insert(id).inserted else { return nil }
                open = id; continue
            }
            if let openID = open {
                guard let attribute = parseAttribute(line),
                      let index = entities.firstIndex(where: { $0.id == openID }),
                      entities[index].attributes.count < 8 else { return nil }
                entities[index].attributes.append(attribute); continue
            }
            return nil
        }
        guard open == nil, !entities.isEmpty else { return nil }
        return .init(source: source, entities: entities, relations: relations)
    }

    private static let reserved: Set<String> = ["erDiagram", "direction", "note", "accTitle", "accDescr", "style"]

    private static func parseAttribute(_ line: String) -> Attribute? {
        var rest = line, comment = ""
        if line.contains("\"") {
            guard let fields = EntityMermaid.capture(#"^(.+?)\s+\"([^\"]+)\"$"#, line),
                  let text = EntityMermaid.label(fields[1], limit: 80) else { return nil }
            rest = fields[0]; comment = text
        }
        let tokens = rest.replacingOccurrences(of: ",", with: " ").split(whereSeparator: \.isWhitespace).map(String.init)
        guard tokens.count >= 2, EntityMermaid.identifier(tokens[0]), EntityMermaid.identifier(tokens[1]),
              !tokens[0].contains("~"), !tokens[1].contains("~") else { return nil }
        var keys: [Key] = []
        for token in tokens.dropFirst(2) {
            let key: Key? = token == "PK" ? .primary : token == "FK" ? .foreign : token == "UK" ? .unique : nil
            guard let key, !keys.contains(key) else { return nil }
            keys.append(key)
        }
        return .init(type: tokens[0], name: tokens[1], keys: keys, comment: comment)
    }

    private static func parseRelation(_ line: String) -> Relation? {
        var cursor = EntityMermaid.Cursor(line)
        guard let left = cursor.erName() else { return nil }
        cursor.spaces()
        guard let leftMark = cursor.take(["||", "|o", "}|", "}o"]),
              let link = cursor.take(["--", ".."]),
              let rightMark = cursor.take(["||", "o|", "|{", "o{"]) else { return nil }
        cursor.spaces()
        guard let right = cursor.erName() else { return nil }
        cursor.spaces()
        guard cursor.current == ":" else { return nil }
        cursor.offset += 1
        guard let label = EntityMermaid.relationLabel(cursor.rest) else { return nil }
        return .init(left: left, right: right, leftCardinality: cardinality(leftMark),
                     rightCardinality: cardinality(rightMark), identifying: link == "--", label: label)
    }

    private static func cardinality(_ mark: String) -> Cardinality {
        switch mark {
        case "||": return .exactlyOne
        case "|o", "o|": return .zeroOrOne
        case "}o", "o{": return .zeroOrMore
        default: return .oneOrMore
        }
    }
}

public struct MarkdownERDiagramLayout: Equatable, Sendable {
    public struct Box: Equatable, Sendable { public let id: String; public let rect: CGRect }
    public struct EdgeGeometry: Equatable, Sendable {
        public let points: [CGPoint]
        public let leftCardinality: CGPoint
        public let rightCardinality: CGPoint
        public let label: CGPoint
    }
    public let size: CGSize
    public let boxes: [Box]
    public let edges: [EdgeGeometry]

    public init(diagram: MarkdownERDiagram, boxSizes: [String: CGSize] = [:], annotations: [MarkdownEntityAnnotation.Extent] = [], scale: CGFloat = 1) {
        let chips = diagram.relations.enumerated().map { index, relation in
            annotations.indices.contains(index)
                ? annotations[index]
                : MarkdownEntityAnnotation.extent(label: relation.label, scale: scale)
        }
        let ids = diagram.entities.map(\.id)
        var gap = 48 * scale
        for (index, relation) in diagram.relations.enumerated() {
            guard let left = ids.firstIndex(of: relation.left), let right = ids.firstIndex(of: relation.right),
                  abs(left - right) == 1 else { continue }
            gap = max(gap, EntityBoxLayout.adjacentGap(chips[index], scale: scale))
        }
        let placed = EntityBoxLayout.place(
            ids: ids,
            sizes: Dictionary(uniqueKeysWithValues: diagram.entities.map {
                ($0.id, boxSizes[$0.id] ?? CGSize(width: 200 * scale, height: CGFloat(36 + 20 * $0.attributes.count) * scale))
            }),
            horizontal: false, reversed: false, scale: scale, gap: gap)
        guard let placed,
              let routed = EntityBoxLayout.route(
                pairs: diagram.relations.enumerated().map { (left: $1.left, right: $1.right, chips: chips[$0]) },
                boxes: placed.boxes, size: placed.size,
                horizontal: false, scale: scale)
        else { size = CGSize(width: CGFloat.infinity, height: CGFloat.infinity); boxes = []; edges = []; return }
        size = routed.size
        boxes = placed.boxes.map { Box(id: $0.id, rect: $0.rect) }
        edges = routed.edges.map {
            EdgeGeometry(points: $0.points, leftCardinality: $0.leftCardinality, rightCardinality: $0.rightCardinality, label: $0.label)
        }
    }
}

/// Bounded native `pie` subset: optional `showData` / `title` and quoted label /
/// unsigned decimal pairs. Zero slices are kept when the total is positive;
/// negative, non-finite or zero totals reject the source.
public struct MarkdownPieChart: Equatable, Sendable {
    public struct Slice: Equatable, Sendable, Identifiable {
        public var id: String { label }
        public let label: String
        public let value: Double
    }
    public let source: String
    public let title: String
    public let showData: Bool
    public let slices: [Slice]
    public var total: Double { slices.reduce(0) { $0 + $1.value } }

    public var accessibilityDescription: String {
        let heading = title.isEmpty ? "Pie chart." : "Pie chart. \(title)."
        let shown = showData ? " Showing values." : ""
        let items = slices.map { slice in
            "\(slice.label) \(EntityMermaid.number(slice.value)), \(EntityMermaid.percent(slice.value, total: total)) percent."
        }
        return heading + shown + " " + items.joined(separator: " ")
    }

    public static func parse(_ source: String) -> Self? {
        guard let lines = EntityMermaid.lines(source), let header = lines.first,
              header == "pie" || header.hasPrefix("pie ") else { return nil }
        var rest = header == "pie" ? "" : String(header.dropFirst(4)).trimmingCharacters(in: .whitespaces)
        var showData = false, title = ""
        if rest.hasPrefix("showData") {
            let after = String(rest.dropFirst(8))
            guard after.isEmpty || after.hasPrefix(" ") else { return nil }
            showData = true
            rest = after.trimmingCharacters(in: .whitespaces)
        } else if rest.lowercased().hasPrefix("showdata") { return nil }
        if rest.hasPrefix("title") {
            let after = String(rest.dropFirst(5))
            guard after.isEmpty || after.hasPrefix(" ") else { return nil }
            guard let text = EntityMermaid.label(after, limit: 120) else { return nil }
            title = text; rest = ""
        }
        guard rest.isEmpty else { return nil }
        var slices: [Slice] = [], seen = Set<String>()
        for line in lines.dropFirst() {
            if line == "showData" {
                guard !showData, slices.isEmpty else { return nil }
                showData = true; continue
            }
            if line.hasPrefix("title ") || line == "title" {
                guard title.isEmpty, slices.isEmpty, let text = EntityMermaid.label(String(line.dropFirst(5)), limit: 120) else { return nil }
                title = text; continue
            }
            guard let fields = EntityMermaid.capture(#"^\"([^\"]+)\"\s*:\s*(.+)$"#, line),
                  let label = EntityMermaid.label(fields[0], limit: 80), seen.insert(label).inserted,
                  fields[1].range(of: #"^\d+(\.\d+)?$"#, options: .regularExpression) != nil,
                  let value = Double(fields[1]), value.isFinite, value >= 0, slices.count < 12 else { return nil }
            slices.append(.init(label: label, value: value))
        }
        let total = slices.reduce(0) { $0 + $1.value }
        guard !slices.isEmpty, total.isFinite, total > 0 else { return nil }
        return .init(source: source, title: title, showData: showData, slices: slices)
    }
}

public struct MarkdownPieChartLayout: Equatable, Sendable {
    public struct SliceGeometry: Equatable, Sendable {
        public let start: Double
        public let end: Double
        public let percent: Double
    }
    public let slices: [SliceGeometry]
    public let total: Double
    public let diameter: Double

    public init(diagram: MarkdownPieChart, diameter: Double = 200) {
        let total = diagram.total
        guard diameter.isFinite, diameter > 0, diameter <= 8_192, total.isFinite, total > 0 else {
            self.slices = []; self.total = .infinity; self.diameter = .infinity; return
        }
        var angle = -Double.pi / 2, result: [SliceGeometry] = []
        for slice in diagram.slices {
            let sweep = slice.value / total * 2 * .pi
            result.append(.init(start: angle, end: angle + sweep, percent: slice.value / total * 100))
            angle += sweep
        }
        self.slices = result
        self.total = total
        self.diameter = diameter
    }
}

private enum EntityBoxLayout {
    static func adjacentGap(_ chips: MarkdownEntityAnnotation.Extent, scale: CGFloat) -> CGFloat {
        let mark = 12 * scale, slack = 8 * scale
        return mark
            + (chips.left.height > 0 ? chips.left.height + slack : 0)
            + (chips.label.height > 0 ? chips.label.height + slack : 0)
            + (chips.right.height > 0 ? chips.right.height : 0)
            + mark
    }

    static func place(ids: [String], sizes: [String: CGSize], horizontal: Bool, reversed: Bool, scale: CGFloat, gap: CGFloat) -> (size: CGSize, boxes: [(id: String, rect: CGRect)])? {
        guard scale.isFinite, scale > 0, scale <= 3, !ids.isEmpty,
              gap.isFinite, gap > 0, gap <= 1_024 else { return nil }
        var frames: [(String, CGSize)] = []
        for id in ids {
            guard let size = sizes[id], size.width.isFinite, size.height.isFinite,
                  size.width > 0, size.height > 0, size.width <= 1_024, size.height <= 1_024 else { return nil }
            frames.append((id, size))
        }
        if reversed { frames.reverse() }
        let pad = 16 * scale
        let maxWidth = frames.map(\.1.width).max() ?? 0, maxHeight = frames.map(\.1.height).max() ?? 0
        var boxes: [(id: String, rect: CGRect)] = [], cursor = pad
        for (id, size) in frames {
            if horizontal {
                boxes.append((id, CGRect(x: cursor, y: pad + (maxHeight - size.height) / 2, width: size.width, height: size.height)))
                cursor += size.width + gap
            } else {
                boxes.append((id, CGRect(x: pad + (maxWidth - size.width) / 2, y: cursor, width: size.width, height: size.height)))
                cursor += size.height + gap
            }
        }
        let size = horizontal
            ? CGSize(width: cursor - gap + pad, height: maxHeight + pad * 2)
            : CGSize(width: maxWidth + pad * 2, height: cursor - gap + pad)
        guard size.width.isFinite, size.height.isFinite, size.width <= 8_192, size.height <= 8_192 else { return nil }
        return (size, boxes)
    }

    static func route(
        pairs: [(left: String, right: String, chips: MarkdownEntityAnnotation.Extent)],
        boxes: [(id: String, rect: CGRect)],
        size: CGSize,
        horizontal: Bool,
        scale: CGFloat
    ) -> (size: CGSize, edges: [(points: [CGPoint], leftCardinality: CGPoint, rightCardinality: CGPoint, label: CGPoint)])? {
        guard scale.isFinite, scale > 0, size.width.isFinite, size.height.isFinite else { return nil }
        let frames = Dictionary(uniqueKeysWithValues: boxes.map { ($0.id, $0.rect) })
        var order: [String: Int] = [:]
        for (index, box) in boxes.enumerated() { order[box.id] = index }
        func pairKey(_ left: String, _ right: String) -> String {
            left <= right ? left + "\u{0}" + right : right + "\u{0}" + left
        }
        var totals: [String: Int] = [:]
        for pair in pairs { totals[pairKey(pair.left, pair.right), default: 0] += 1 }
        var seen: [String: Int] = [:]
        var nextLane = 0
        let columnRight = boxes.map(\.rect.maxX).max() ?? 0
        let rowBottom = boxes.map(\.rect.maxY).max() ?? 0
        var built: [(points: [CGPoint], leftCardinality: CGPoint, rightCardinality: CGPoint, label: CGPoint, chips: MarkdownEntityAnnotation.Extent)] = []
        for pair in pairs {
            guard let left = frames[pair.left], let right = frames[pair.right],
                  let leftIndex = order[pair.left], let rightIndex = order[pair.right] else { return nil }
            let key = pairKey(pair.left, pair.right)
            let slot = seen[key, default: 0]
            seen[key] = slot + 1
            let siblings = max(totals[key] ?? 1, 1)
            let chipWidth = max(pair.chips.left.width, pair.chips.right.width)
            let offset = (CGFloat(slot) - CGFloat(siblings - 1) / 2) * max(14 * scale, chipWidth + 8 * scale)
            let looping = pair.left == pair.right
            let skip = !looping && abs(leftIndex - rightIndex) != 1
            let points: [CGPoint]
            var labelNudge = CGPoint.zero
            if looping || skip {
                let lane = nextLane
                nextLane += 1
                if looping {
                    let out = columnRight + (36 + CGFloat(lane) * 28) * scale
                    // Cardinalities sit 22pt along the two stubs, so they share x.
                    // midY±8 is only 16pt; a 20pt chip pair then intersects.
                    let span = max(16 * scale, pair.chips.left.height / 2 + pair.chips.right.height / 2 + 8 * scale)
                    var startY = left.midY - span / 2
                    var endY = right.midY + span / 2
                    if startY < 0 {
                        endY -= startY
                        startY = 0
                    }
                    let start = CGPoint(x: left.maxX, y: startY)
                    let end = CGPoint(x: right.maxX, y: endY)
                    points = [start, CGPoint(x: out, y: start.y), CGPoint(x: out, y: end.y), end]
                } else if horizontal {
                    let laneY = rowBottom + (36 + CGFloat(lane) * 28) * scale
                    let start = CGPoint(x: left.midX, y: left.maxY)
                    let end = CGPoint(x: right.midX, y: right.maxY)
                    points = [start, CGPoint(x: start.x, y: laneY), CGPoint(x: end.x, y: laneY), end]
                } else {
                    let laneX = columnRight + (36 + CGFloat(lane) * 28) * scale
                    let start = CGPoint(x: left.maxX, y: left.midY)
                    let end = CGPoint(x: right.maxX, y: right.midY)
                    points = [start, CGPoint(x: laneX, y: start.y), CGPoint(x: laneX, y: end.y), end]
                }
            } else if abs(left.midX - right.midX) <= abs(left.midY - right.midY) {
                let start: CGPoint, end: CGPoint
                if left.midY <= right.midY {
                    start = CGPoint(x: left.midX + offset, y: left.maxY)
                    end = CGPoint(x: right.midX + offset, y: right.minY)
                } else {
                    start = CGPoint(x: left.midX + offset, y: left.minY)
                    end = CGPoint(x: right.midX + offset, y: right.maxY)
                }
                points = [start, end]
                let length = max(hypot(end.x - start.x, end.y - start.y), 1)
                let along = (CGFloat(slot) - CGFloat(siblings - 1) / 2) * max(16 * scale, pair.chips.label.height + 8 * scale)
                labelNudge = CGPoint(x: (end.x - start.x) / length * along, y: (end.y - start.y) / length * along)
            } else {
                let start: CGPoint, end: CGPoint
                if left.midX <= right.midX {
                    start = CGPoint(x: left.maxX, y: left.midY + offset)
                    end = CGPoint(x: right.minX, y: right.midY + offset)
                } else {
                    start = CGPoint(x: left.minX, y: left.midY + offset)
                    end = CGPoint(x: right.maxX, y: right.midY + offset)
                }
                points = [start, end]
                let length = max(hypot(end.x - start.x, end.y - start.y), 1)
                let along = (CGFloat(slot) - CGFloat(siblings - 1) / 2) * max(16 * scale, pair.chips.label.height + 8 * scale)
                labelNudge = CGPoint(x: (end.x - start.x) / length * along, y: (end.y - start.y) / length * along)
            }
            built.append(geometry(points: points, scale: scale, labelNudge: labelNudge, chips: pair.chips, polyline: looping || skip))
        }
        let pad = 16 * scale
        var maxX = size.width, maxY = size.height
        for edge in built {
            let extents: [(CGPoint, CGSize)] = [
                (edge.leftCardinality, edge.chips.left),
                (edge.rightCardinality, edge.chips.right),
                (edge.label, edge.chips.label)
            ]
            for point in edge.points {
                guard point.x.isFinite, point.y.isFinite else { return nil }
                maxX = max(maxX, point.x + pad)
                maxY = max(maxY, point.y + pad)
            }
            for (point, chip) in extents {
                guard point.x.isFinite, point.y.isFinite else { return nil }
                maxX = max(maxX, point.x + chip.width / 2 + pad)
                maxY = max(maxY, point.y + chip.height / 2 + pad)
            }
        }
        let next = CGSize(width: maxX, height: maxY)
        guard next.width.isFinite, next.height.isFinite, next.width <= 8_192, next.height <= 8_192 else { return nil }
        return (next, built.map { (points: $0.points, leftCardinality: $0.leftCardinality, rightCardinality: $0.rightCardinality, label: $0.label) })
    }

    private static func geometry(
        points: [CGPoint],
        scale: CGFloat,
        labelNudge: CGPoint,
        chips: MarkdownEntityAnnotation.Extent,
        polyline: Bool
    ) -> (points: [CGPoint], leftCardinality: CGPoint, rightCardinality: CGPoint, label: CGPoint, chips: MarkdownEntityAnnotation.Extent) {
        let inset = 22 * scale
        let leftCard = along(points, distance: inset)
        let rightCard = along(Array(points.reversed()), distance: inset)
        let base: CGPoint
        if points.count >= 4 {
            let a = points[1], b = points[points.count - 2]
            base = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        } else if let first = points.first, let last = points.last {
            base = CGPoint(x: (first.x + last.x) / 2, y: (first.y + last.y) / 2)
        } else {
            base = .zero
        }
        var label = CGPoint(x: base.x + labelNudge.x, y: base.y + labelNudge.y)
        let direction: CGPoint
        if polyline, points.count >= 2 {
            direction = CGPoint(x: points[1].x - points[0].x, y: points[1].y - points[0].y)
        } else if let first = points.first, let last = points.last, abs(last.x - first.x) > abs(last.y - first.y) {
            direction = CGPoint(x: 0, y: 1)
        } else {
            direction = CGPoint(x: 1, y: 0)
        }
        if !polyline {
            let length = max(hypot(direction.x, direction.y), 1)
            label = CGPoint(x: label.x + direction.x / length * 16 * scale, y: label.y + direction.y / length * 16 * scale)
        }
        label = clear(label, size: chips.label, obstacles: [(leftCard, chips.left), (rightCard, chips.right)], direction: direction, scale: scale)
        return (points, leftCard, rightCard, label, chips)
    }

    private static func clear(
        _ origin: CGPoint,
        size: CGSize,
        obstacles: [(CGPoint, CGSize)],
        direction: CGPoint,
        scale: CGFloat
    ) -> CGPoint {
        guard size.width > 0, size.height > 0 else { return origin }
        let length = max(hypot(direction.x, direction.y), 1)
        let ux = direction.x / length, uy = direction.y / length
        let step = 4 * scale
        var current = origin
        for _ in 0..<32 {
            let box = CGRect(x: current.x - size.width / 2, y: current.y - size.height / 2, width: size.width, height: size.height)
                .insetBy(dx: -2 * scale, dy: -2 * scale)
            let hit = obstacles.contains { point, chip in
                guard chip.width > 0, chip.height > 0 else { return false }
                return box.intersects(CGRect(x: point.x - chip.width / 2, y: point.y - chip.height / 2, width: chip.width, height: chip.height))
            }
            if !hit { return current }
            current = CGPoint(x: current.x + ux * step, y: current.y + uy * step)
        }
        return current
    }

    private static func along(_ points: [CGPoint], distance: CGFloat) -> CGPoint {
        guard let start = points.first, points.count >= 2 else { return .zero }
        let next = points[1]
        let dx = next.x - start.x, dy = next.y - start.y
        let length = max(hypot(dx, dy), 1)
        return CGPoint(x: start.x + dx / length * min(distance, length), y: start.y + dy / length * min(distance, length))
    }
}

private enum EntityMermaid {
    static func lines(_ source: String, allowBraces: Bool = false) -> [String]? {
        guard source.utf8.count <= 12_000 else { return nil }
        let raw = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        guard raw.count <= 160 else { return nil }
        var result: [String] = []
        for item in raw {
            let line = item.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("%%{") { return nil }
            if line.isEmpty || line.hasPrefix("%%") { continue }
            guard !line.contains(";"), !line.contains("%%"), !line.contains(":::"), !line.contains("`"),
                  allowBraces || (!line.contains("{") && !line.contains("}")) else { return nil }
            result.append(line)
        }
        return result
    }
    static func capture(_ pattern: String, _ source: String) -> [String]? {
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)) else { return nil }
        return (1..<match.numberOfRanges).map { Range(match.range(at: $0), in: source).map { String(source[$0]) } ?? "" }
    }
    static func identifier(_ source: String, extra: String = "") -> Bool {
        extra.isEmpty
            ? source.range(of: #"^[A-Za-z_][A-Za-z0-9_]{0,47}$"#, options: .regularExpression) != nil
            : source.range(of: #"^[A-Za-z_][A-Za-z0-9_-]{0,47}$"#, options: .regularExpression) != nil
    }
    static func relationLabel(_ source: String, limit: Int = 180, allowEmpty: Bool = false) -> String? {
        var text = source.trimmingCharacters(in: .whitespaces)
        if text.count >= 2, text.first == "\"", text.last == "\"" { text = String(text.dropFirst().dropLast()) }
        return label(text, limit: limit, allowEmpty: allowEmpty)
    }
    static func label(_ source: String, limit: Int = 180, allowEmpty: Bool = false) -> String? {
        let text = source.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "<br/>", with: "\n").replacingOccurrences(of: "<br />", with: "\n").replacingOccurrences(of: "<br>", with: "\n")
        guard (allowEmpty || !text.isEmpty), text.count <= limit, text.components(separatedBy: "\n").count <= 4,
              text.range(of: #"</?[A-Za-z!][^>]*>"#, options: .regularExpression) == nil,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && $0 != "\n" }) else { return nil }
        return text
    }
    static func number(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        if value == value.rounded() { return String(format: "%.0f", value) }
        return String(format: "%g", value)
    }
    static func percent(_ value: Double, total: Double) -> String {
        let percent = value / total * 100
        if abs(percent - percent.rounded()) < 1e-9 { return String(Int(percent.rounded())) }
        return String(format: "%.1f", percent)
    }

    struct Cursor {
        let chars: [Character]
        var offset = 0
        init(_ source: String) { chars = Array(source) }
        var ended: Bool { offset >= chars.count }
        var current: Character? { ended ? nil : chars[offset] }
        var rest: String { String(chars[offset...]) }
        mutating func spaces() { while let char = current, char == " " || char == "\t" { offset += 1 } }
        mutating func take(_ tokens: [String]) -> String? {
            for token in tokens where chars.dropFirst(offset).starts(with: token) {
                offset += token.count; return token
            }
            return nil
        }
        mutating func identifier() -> String? {
            let start = offset
            while let char = current, char.isASCII && (char.isLetter || char.isNumber || char == "_") { offset += 1 }
            let id = String(chars[start..<offset])
            return EntityMermaid.identifier(id) ? id : nil
        }
        mutating func erName() -> String? {
            let start = offset
            while let char = current, char.isASCII && (char.isLetter || char.isNumber || char == "_" || char == "-") { offset += 1 }
            let id = String(chars[start..<offset])
            return EntityMermaid.identifier(id, extra: "-") ? id : nil
        }
        mutating func quoted(limit: Int) -> String? {
            guard current == "\"" else { return nil }
            offset += 1
            let start = offset
            while let char = current, char != "\"" { offset += 1 }
            guard current == "\"" else { return nil }
            let text = String(chars[start..<offset])
            offset += 1
            return EntityMermaid.label(text, limit: limit)
        }
    }
}
