import Foundation

/// Native sequence subset: participants/actors, aliases, eight standard arrows,
/// self messages, notes, autonumber, balanced activations, and alt/else, opt,
/// loop, par/and, critical/option and break frames. Control frames are limited to
/// three levels, twelve frames and eight branches per frame. rect/box backgrounds,
/// create/destroy, configuration, links and HTML reject the entire diagram so the
/// caller can show its exact source.
public struct MarkdownSequenceDiagram: Equatable, Sendable {
    public struct Participant: Equatable, Sendable, Identifiable {
        public let id: String
        public var label: String
        public var actor: Bool
    }
    public enum Arrow: String, Equatable, Sendable {
        case line = "->", dashedLine = "-->", arrow = "->>", dashedArrow = "-->>"
        case cross = "-x", dashedCross = "--x", open = "-)", dashedOpen = "--)"
        public var dashed: Bool { rawValue.hasPrefix("--") }
        public var ending: String {
            switch self { case .line, .dashedLine: return "line"; case .cross, .dashedCross: return "cross"; case .open, .dashedOpen: return "open"; default: return "arrow" }
        }
    }
    public enum NotePlacement: String, Equatable, Sendable { case left, right, over }
    public enum Event: Equatable, Sendable {
        case message(from: String, to: String, arrow: Arrow, text: String, number: Int?)
        case note(placement: NotePlacement, participants: [String], text: String)
        case activation(participant: String, active: Bool)
        public var text: String {
            switch self { case .message(_, _, _, let text, _), .note(_, _, let text): return text; case .activation(let id, let active): return "\(active ? "Activate" : "Deactivate") \(id)" }
        }
    }
    public struct Activation: Equatable, Sendable {
        public let participant: String
        public let start: Int
        public let end: Int
        public let depth: Int
    }
    public struct Fragment: Equatable, Sendable, Identifiable {
        public enum Kind: String, Equatable, Sendable {
            case alt, opt, loop, par, critical, breakFrame = "break"
            /// Keyword that starts a further branch, if the frame has branches.
            public var separator: String? {
                switch self { case .alt: return "else"; case .par: return "and"; case .critical: return "option"; default: return nil }
            }
            public var spokenName: String {
                switch self {
                case .alt: return "alternative"; case .opt: return "optional sequence"; case .loop: return "loop"
                case .par: return "parallel"; case .critical: return "critical region"; case .breakFrame: return "break"
                }
            }
        }
        public struct Branch: Equatable, Sendable {
            public let label: String
            public let headerRow: Int
            /// Message/note/activation indices; nested fragments keep source order.
            public let events: Range<Int>
        }
        public let id: Int
        public let kind: Kind
        public let depth: Int
        public let startRow: Int
        public let endRow: Int
        public let branches: [Branch]
        /// Actual participants referenced in the frame, in global declaration order.
        public let participants: [String]
    }
    /// `fragmentElse` is any branch separator: `else`, `and` or `option`.
    public enum Row: Equatable, Sendable {
        case event(Int), fragmentStart(Int), fragmentElse(fragment: Int, branch: Int), fragmentEnd(Int)
    }
    public let source: String
    public let participants: [Participant]
    public let events: [Event]
    public let activations: [Activation]
    public let fragments: [Fragment]
    public let rows: [Row]

    private struct OpenFragment {
        let id: Int
        let kind: Fragment.Kind
        let depth: Int
        let startRow: Int
        let startEvent: Int
        var branches: [Fragment.Branch]
        var branchLabel: String
        var branchRow: Int
        var branchStart: Int
    }

    /// Shared by the native renderer and tests. Bounds prevent overflowing or
    /// non-finite Canvas coordinates even when Dynamic Type makes labels tall.
    public func rowOffsets(heights: [Double]) -> [Double]? {
        guard heights.count == rows.count else { return nil }
        var offsets: [Double] = [0]
        for height in heights {
            guard height.isFinite, height > 0, height <= 8_192 else { return nil }
            let next = offsets.last! + height
            guard next <= 8_192 else { return nil }
            offsets.append(next)
        }
        return offsets
    }

    public static func parse(_ source: String) -> Self? {
        guard let lines = MermaidSubset.lines(source), lines.first == "sequenceDiagram" else { return nil }
        var participants: [Participant] = [], events: [Event] = [], activations: [Activation] = []
        var active: [String: [Int]] = [:], numbered = false, messageNumber = 0
        var rows: [Row] = [], fragments: [Fragment?] = [], open: [OpenFragment] = []
        func append(_ event: Event) -> Bool {
            guard events.count < 48, rows.count < 96 else { return false }
            rows.append(.event(events.count)); events.append(event); return true
        }
        func ensure(_ id: String) -> Bool {
            guard MermaidSubset.identifier(id), !["alt", "else", "opt", "loop", "end", "par", "and", "break", "critical", "option", "rect", "box"].contains(id.lowercased()) else { return false }
            if !participants.contains(where: { $0.id == id }) { participants.append(.init(id: id, label: id, actor: false)) }
            return participants.count <= 8
        }
        func activate(_ id: String, row: Int) -> Bool {
            guard ensure(id), active[id, default: []].count < 3 else { return false }
            active[id, default: []].append(row); return true
        }
        func deactivate(_ id: String, row: Int) -> Bool {
            guard var starts = active[id], let start = starts.popLast() else { return false }
            activations.append(.init(participant: id, start: start, end: row, depth: starts.count))
            active[id] = starts; return true
        }
        for line in lines.dropFirst() {
            if let fields = MermaidSubset.capture(#"(?i)^(alt|opt|loop|par|critical|break)(?:\s+(.*))?$"#, line) {
                guard open.count < 3, fragments.count < 12, rows.count < 96,
                      let kind = Fragment.Kind(rawValue: fields[0].lowercased()),
                      let label = fragmentLabel(fields[1]) else { return nil }
                let id = fragments.count, row = rows.count
                fragments.append(nil)
                open.append(.init(id: id, kind: kind, depth: open.count, startRow: row, startEvent: events.count,
                                  branches: [], branchLabel: label, branchRow: row, branchStart: events.count))
                rows.append(.fragmentStart(id)); continue
            }
            if let fields = MermaidSubset.capture(#"(?i)^(else|and|option)(?:\s+(.*))?$"#, line) {
                // Each separator belongs only to its own frame kind (else/alt, and/par, option/critical).
                guard var frame = open.popLast(), frame.kind.separator == fields[0].lowercased(), frame.branches.count < 7,
                      rows.count < 96, let label = fragmentLabel(fields[1]) else { return nil }
                frame.branches.append(.init(label: frame.branchLabel, headerRow: frame.branchRow, events: frame.branchStart..<events.count))
                frame.branchLabel = label; frame.branchRow = rows.count; frame.branchStart = events.count
                rows.append(.fragmentElse(fragment: frame.id, branch: frame.branches.count))
                open.append(frame); continue
            }
            if line.lowercased() == "end" {
                guard var frame = open.popLast(), rows.count < 96 else { return nil }
                frame.branches.append(.init(label: frame.branchLabel, headerRow: frame.branchRow, events: frame.branchStart..<events.count))
                var used = Set<String>()
                for event in events[frame.startEvent...] {
                    switch event {
                    case .message(let from, let to, _, _, _): used.formUnion([from, to])
                    case .note(_, let ids, _): used.formUnion(ids)
                    case .activation(let id, _): used.insert(id)
                    }
                }
                fragments[frame.id] = .init(id: frame.id, kind: frame.kind, depth: frame.depth, startRow: frame.startRow,
                                           endRow: rows.count, branches: frame.branches, participants: participants.filter { used.contains($0.id) }.map(\.id))
                rows.append(.fragmentEnd(frame.id)); continue
            }
            if line == "autonumber" {
                guard !numbered, rows.isEmpty else { return nil }; numbered = true; continue
            }
            if let fields = MermaidSubset.capture(#"^(participant|actor) ([A-Za-z_][A-Za-z0-9_]{0,47})(?: as (.+))?$"#, line) {
                let id = fields[1]
                guard ensure(id), let label = MermaidSubset.label(fields[2].isEmpty ? id : fields[2], limit: 80) else { return nil }
                let index = participants.firstIndex(where: { $0.id == id })!
                participants[index].label = label; participants[index].actor = fields[0] == "actor"; continue
            }
            if let fields = MermaidSubset.capture(#"^(activate|deactivate) ([A-Za-z_][A-Za-z0-9_]{0,47})$"#, line) {
                let turningOn = fields[0] == "activate", id = fields[1], row = events.count
                guard turningOn ? activate(id, row: row) : deactivate(id, row: row) else { return nil }
                guard append(.activation(participant: id, active: turningOn)) else { return nil }; continue
            }
            if let fields = MermaidSubset.capture(#"^[Nn]ote (left of|right of|over) ([A-Za-z_][A-Za-z0-9_]{0,47})(?:\s*,\s*([A-Za-z_][A-Za-z0-9_]{0,47}))?\s*:\s*(.+)$"#, line) {
                let ids = fields[2].isEmpty ? [fields[1]] : [fields[1], fields[2]]
                guard ids.allSatisfy(ensure), Set(ids).count == ids.count,
                      fields[0] == "over" || ids.count == 1,
                      let label = MermaidSubset.label(fields[3]) else { return nil }
                let placement: NotePlacement = fields[0] == "over" ? .over : fields[0] == "left of" ? .left : .right
                guard append(.note(placement: placement, participants: ids, text: label)) else { return nil }; continue
            }
            if let fields = MermaidSubset.capture(#"^([A-Za-z_][A-Za-z0-9_]{0,47})\s*(-->>|->>|-->|->|--x|-x|--\)|-\))([+-]?)\s*([A-Za-z_][A-Za-z0-9_]{0,47})\s*:\s*(.*)$"#, line) {
                let from = fields[0], to = fields[3], row = events.count
                guard ensure(from), ensure(to), let arrow = Arrow(rawValue: fields[1]), let label = MermaidSubset.label(fields[4], allowEmpty: true) else { return nil }
                if fields[2] == "+", !activate(to, row: row) { return nil }
                if fields[2] == "-", !deactivate(from, row: row) { return nil }
                messageNumber += 1
                guard append(.message(from: from, to: to, arrow: arrow, text: label, number: numbered ? messageNumber : nil)) else { return nil }; continue
            }
            return nil
        }
        guard !participants.isEmpty, open.isEmpty, active.values.allSatisfy(\.isEmpty) else { return nil }
        return .init(source: source, participants: participants, events: events, activations: activations, fragments: fragments.compactMap { $0 }, rows: rows)
    }

    private static func fragmentLabel(_ source: String) -> String? {
        // Mermaid's LINE lexer handles # comments and wrap/nowrap directives.
        // Keep these outside the native subset rather than displaying syntax as a condition.
        guard !source.contains("#"), source.range(of: #"^:?(?:no)?wrap:"#, options: [.regularExpression, .caseInsensitive]) == nil else { return nil }
        return MermaidSubset.label(source, allowEmpty: true)
    }

    public var accessibilityDescription: String {
        let names = Dictionary(uniqueKeysWithValues: participants.map { ($0.id, $0.label) })
        func describe(_ event: Event) -> String {
            switch event {
            case .message(let from, let to, let arrow, let text, let number):
                return (number.map { "\($0). " } ?? "") + "\(names[from] ?? from) to \(names[to] ?? to), \(arrow.dashed ? "dashed " : "")\(arrow.ending): \(text)."
            case .note(_, let ids, let text): return "Note for \(ids.map { names[$0] ?? $0 }.joined(separator: " and ")): \(text)."
            case .activation(let id, let active): return "\(active ? "Activate" : "Deactivate") \(names[id] ?? id)."
            }
        }
        return "Sequence diagram. " + participants.map { ($0.actor ? "Actor " : "Participant ") + $0.label }.joined(separator: ". ") + ". " + rows.map { row in
            switch row {
            case .event(let index): return describe(events[index])
            case .fragmentStart(let id):
                let frame = fragments[id], label = frame.branches[0].label
                return "Begin \(frame.kind.spokenName)\(label.isEmpty ? "" : ": " + label)."
            case .fragmentElse(let id, let branch):
                let frame = fragments[id], label = frame.branches[branch].label
                let separator = frame.kind == .par ? "In parallel" : (frame.kind.separator ?? "else").capitalized
                return "\(separator)\(label.isEmpty ? "" : ": " + label)."
            case .fragmentEnd(let id): return "End \(fragments[id].kind.rawValue)."
            }
        }.joined(separator: " ")
    }

}

/// stateDiagram-v2 subset. Source-order layout supports cycles without
/// reinterpreting them as a DAG. Composite `state X { … }` blocks nest up to three
/// levels (six composites) with their own `[*]` start/end. A state lives in exactly
/// one scope: referencing it from another block, an empty block, concurrency
/// (`--`), choice/fork/join, notes, inner `direction` and styling all reject.
public struct MarkdownStateDiagram: Equatable, Sendable {
    public struct State: Equatable, Sendable, Identifiable {
        public enum Kind: Equatable, Sendable { case state, initial, final, composite }
        /// Root pseudo-states are `@start`/`@end`; a composite's are `<id>@start`/`<id>@end`.
        public let id: String
        public var label: String
        public let kind: Kind
        /// Enclosing composite id, nil at the top level.
        public let parent: String?
        public let depth: Int
    }
    public struct Transition: Equatable, Sendable {
        public let from: String
        public let to: String
        public let label: String
    }
    public let source: String
    public let horizontal: Bool
    /// Pre-order per scope: start, states (each composite followed by its contents), end.
    public let states: [State]
    public let transitions: [Transition]

    /// Index of the last entry inside `states[index]` (itself unless it is a composite).
    public func subtreeEnd(_ index: Int) -> Int {
        guard states.indices.contains(index) else { return index }
        var end = index
        while end + 1 < states.count, states[end + 1].depth > states[index].depth { end += 1 }
        return end
    }

    public static func parse(_ source: String) -> Self? {
        guard let lines = MermaidSubset.lines(source, allowBraces: true), lines.first == "stateDiagram-v2" else { return nil }
        var states: [State] = [], transitions: [Transition] = [], horizontal = false, directionSeen = false
        var scopes: [String] = []
        func ensure(_ id: String, kind: State.Kind = .state) -> Bool {
            guard kind != .state || MermaidSubset.identifier(id) else { return false }
            // Mermaid does not support links between states of different composites.
            if let existing = states.first(where: { $0.id == id }) { return existing.parent == scopes.last }
            states.append(.init(id: id, label: kind == .initial ? "Start" : kind == .final ? "End" : id, kind: kind, parent: scopes.last, depth: scopes.count))
            return states.count <= 18
        }
        func label(_ id: String, _ source: String) -> Bool {
            guard ensure(id), let text = MermaidSubset.label(source, limit: 120) else { return false }
            states[states.firstIndex(where: { $0.id == id })!].label = text; return true
        }
        for line in lines.dropFirst() {
            if let fields = MermaidSubset.capture(#"^state (?:"([^"]+)" as )?([A-Za-z_][A-Za-z0-9_]{0,47})\s*\{$"#, line) {
                let id = fields[1]
                guard scopes.count < 3, states.filter({ $0.kind == .composite }).count < 6, ensure(id),
                      let index = states.firstIndex(where: { $0.id == id }), states[index].kind == .state,
                      fields[0].isEmpty || label(id, fields[0]) else { return nil }
                let state = states[index]
                states[index] = .init(id: id, label: state.label, kind: .composite, parent: state.parent, depth: state.depth)
                scopes.append(id); continue
            }
            if line == "}" {
                guard let scope = scopes.popLast(), states.contains(where: { $0.parent == scope }) else { return nil }
                continue
            }
            // Braces are only composite block delimiters in this subset.
            if line.contains("{") || line.contains("}") { return nil }
            if line.hasPrefix("direction ") {
                guard scopes.isEmpty, !directionSeen, ["direction TB", "direction LR"].contains(line), transitions.isEmpty else { return nil }
                horizontal = line == "direction LR"; directionSeen = true; continue
            }
            if let fields = MermaidSubset.capture(#"^(\[\*\]|[A-Za-z_][A-Za-z0-9_]{0,47})\s*-->\s*(\[\*\]|[A-Za-z_][A-Za-z0-9_]{0,47})(?:\s*:\s*(.*))?$"#, line) {
                guard !(fields[0] == "[*]" && fields[1] == "[*]"), let text = MermaidSubset.label(fields[2], allowEmpty: true) else { return nil }
                // [*] is scoped: inside a composite it is that composite's own start or end.
                let prefix = scopes.last ?? ""
                let from = fields[0] == "[*]" ? prefix + "@start" : fields[0], to = fields[1] == "[*]" ? prefix + "@end" : fields[1]
                guard ensure(from, kind: fields[0] == "[*]" ? .initial : .state), ensure(to, kind: fields[1] == "[*]" ? .final : .state) else { return nil }
                transitions.append(.init(from: from, to: to, label: text)); guard transitions.count <= 32 else { return nil }; continue
            }
            if let fields = MermaidSubset.capture(#"^state "([^"]+)" as ([A-Za-z_][A-Za-z0-9_]{0,47})$"#, line) {
                guard label(fields[1], fields[0]) else { return nil }; continue
            }
            if let fields = MermaidSubset.capture(#"^([A-Za-z_][A-Za-z0-9_]{0,47})\s*:\s*(.+)$"#, line) {
                guard label(fields[0], fields[1]) else { return nil }; continue
            }
            if MermaidSubset.identifier(line) { guard ensure(line) else { return nil }; continue }
            return nil
        }
        guard !states.isEmpty, scopes.isEmpty else { return nil }
        func ordered(_ parent: String?) -> [State] {
            let members = states.filter { $0.parent == parent }
            var result = members.filter { $0.kind == .initial }
            for state in members where state.kind == .state || state.kind == .composite {
                result.append(state)
                if state.kind == .composite { result += ordered(state.id) }
            }
            return result + members.filter { $0.kind == .final }
        }
        return .init(source: source, horizontal: horizontal, states: ordered(nil), transitions: transitions)
    }
    public var accessibilityDescription: String {
        let labels = Dictionary(uniqueKeysWithValues: states.map { ($0.id, $0.label) })
        func name(_ state: State) -> String {
            guard state.kind == .initial || state.kind == .final, let parent = state.parent else { return state.label }
            return "\(state.label) of \(labels[parent] ?? parent)"
        }
        let names = Dictionary(uniqueKeysWithValues: states.map { ($0.id, name($0)) })
        let entries = states.map { state -> String in
            guard state.kind == .composite else { return name(state) }
            return "\(state.label), composite state containing " + states.filter { $0.parent == state.id }.map(name).joined(separator: ", ")
        }
        return "State diagram. " + entries.joined(separator: ". ") + ". " + transitions.map {
            "\(names[$0.from] ?? $0.from) transitions to \(names[$0.to] ?? $0.to)\($0.label.isEmpty ? "" : ": " + $0.label)."
        }.joined(separator: " ")
    }
}

private enum MermaidSubset {
    /// `allowBraces` lets the state parser see composite block lines; it then
    /// rejects every other brace itself.
    static func lines(_ source: String, allowBraces: Bool = false) -> [String]? {
        guard source.utf8.count <= 12_000 else { return nil }
        let raw = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        guard raw.count <= 160 else { return nil }
        var result: [String] = []
        for item in raw {
            let line = item.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("%%{") { return nil }
            if line.isEmpty || line.hasPrefix("%%") { continue }
            // Semicolon-separated statements, inline comments and entities are
            // deliberately not reinterpreted by this bounded native subset.
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
    static func identifier(_ source: String) -> Bool {
        !["end", "state", "note", "direction", "classDef", "class", "activate", "deactivate", "participant", "actor", "autonumber", "accTitle", "accDescr"].contains(source) && source.range(of: #"^[A-Za-z_][A-Za-z0-9_]{0,47}$"#, options: .regularExpression) != nil
    }
    static func label(_ source: String, limit: Int = 180, allowEmpty: Bool = false) -> String? {
        let text = source.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "<br/>", with: "\n").replacingOccurrences(of: "<br />", with: "\n").replacingOccurrences(of: "<br>", with: "\n")
        guard (allowEmpty || !text.isEmpty), text.count <= limit, text.components(separatedBy: "\n").count <= 4,
              text.range(of: #"</?[A-Za-z!][^>]*>"#, options: .regularExpression) == nil,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && $0 != "\n" }) else { return nil }
        return text
    }
}
