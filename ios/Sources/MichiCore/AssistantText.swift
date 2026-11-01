import Foundation

/// Hide the backend's assistant metadata directives, including an incomplete
/// directive while streaming. User-authored text must not pass through this.
public enum AssistantText {
    public static func visible(_ input: String) -> String {
        var text = input
        let patterns = [
            #"\[TITLE:\s*[^\]]*\]"#,
            #"\[BRANCH-OVERVIEW:\s*[^\]]*\]"#,
            #"\[FOLLOW-UP\s+[1-3](?:\s*/\s*3)?\s*:\s*[^\]]*\]"#,
            #"\[FOLLOW-UPS:\s*[^\]]*\]"#
        ]
        for pattern in patterns {
            if let expression = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) {
                text = expression.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
            }
        }
        if let bracket = text.lastIndex(of: "[") {
            let tail = text[bracket...].uppercased()
            let markers = ["[TITLE:", "[BRANCH-OVERVIEW:", "[FOLLOW-UP", "[FOLLOW-UPS:"]
            if markers.contains(where: { $0.hasPrefix(tail) || tail.hasPrefix($0) }) && !tail.contains("]") {
                text = String(text[..<bracket])
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
