import Foundation
import MichiCore

/// One composer mention shown as a removable chip. Mentions stay inline
/// `@label` text in the draft (the wire format); the chip only offers a
    /// precise way to remove one. Identity is its exact UTF-16 range plus kind
    /// and byte-exact reference id, so equal labels or repeated references never alias.
struct DesignChatMentionChip: Identifiable, Equatable {
    let start: Int
    let end: Int
    let kind: String
    let refID: String
    let label: String
    /// 1-based position among chips with the same label, and how many share it.
    let duplicateIndex: Int
    let duplicateCount: Int

    var id: String { "\(start):\(end):\(kind):\(refID)" }
    /// 10-chats composer meta: chat mentions use the branch glyph, files doc.text.
    var systemImage: String { kind == "node" ? "arrow.triangle.branch" : "doc.text" }
    var accessibilityLabel: String {
        let noun = kind == "node" ? "chat" : "file"
        let position = duplicateCount > 1 ? ", \(duplicateIndex) of \(duplicateCount)" : ""
        return "Remove \(noun) mention \(label)\(position)"
    }
}

enum DesignChatMentions {
    static func chips(value: String, mentions: [JSONValue]) -> [DesignChatMentionChip] {
        let valid = NativeComposer.validMentions(mentions, in: value)
        var seen: [String: Int] = [:]
        let totals = Dictionary(grouping: valid, by: { $0["label"].stringValue }).mapValues(\.count)
        return valid.map { mention in
            let label = mention["label"].stringValue
            seen[label, default: 0] += 1
            return DesignChatMentionChip(start: mention["start"].intValue, end: mention["end"].intValue,
                                         kind: mention["kind"].stringValue, refID: mention["refId"].stringValue, label: label,
                                         duplicateIndex: seen[label] ?? 1, duplicateCount: totals[label] ?? 1)
        }
    }

    /// Removes exactly the chip's `@label` range and one adjacent separating
    /// space, then shifts later mentions by the removed UTF-16 length.
    /// Returns nil when the chip no longer matches the draft (stale view),
    /// so a concurrent edit is never misapplied to a different mention.
    static func removing(_ chip: DesignChatMentionChip, value: String, mentions: [JSONValue]) -> (value: String, mentions: [JSONValue])? {
        let valid = NativeComposer.validMentions(mentions, in: value)
        guard let target = valid.firstIndex(where: {
            $0["start"].intValue == chip.start && $0["end"].intValue == chip.end && $0["kind"].stringValue == chip.kind
                && DesignChatOpaqueID.same($0["refId"].stringValue, chip.refID) && $0["label"].stringValue == chip.label
        }) else { return nil }
        let source = value as NSString
        let others = valid.enumerated().filter { $0.offset != target }.map { ($0.element["start"].intValue, $0.element["end"].intValue) }
        func insideOther(_ index: Int) -> Bool { others.contains { $0.0 <= index && index < $0.1 } }
        func isSpace(_ index: Int) -> Bool { index >= 0 && index < source.length && source.character(at: index) == 0x20 && !insideOther(index) }
        func isWordCharacter(_ index: Int) -> Bool {
            guard index < source.length, let scalar = Unicode.Scalar(source.character(at: index)) else { return false }
            return CharacterSet.alphanumerics.contains(scalar)
        }
        var lower = chip.start, upper = chip.end
        if isSpace(upper) { upper += 1 }
        else if isSpace(lower - 1) && !isWordCharacter(upper) { lower -= 1 }
        let removed = upper - lower
        let next = source.replacingCharacters(in: NSRange(location: lower, length: removed), with: "")
        let shifted: [JSONValue] = valid.enumerated().compactMap { offset, mention in
            guard offset != target else { return nil }
            let start = mention["start"].intValue, end = mention["end"].intValue
            guard start >= upper else { return mention }
            return mention.merging(["start": .number(Double(start - removed)), "end": .number(Double(end - removed))])
        }
        return (next, NativeComposer.validMentions(shifted, in: next))
    }
}
