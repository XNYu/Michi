#if DEBUG
import Foundation
import MichiCore

enum ContentParityFixtures {
    static let flowchart = "flowchart TB\nA([Start]) --> B{Ready?}\nB -- Yes --> C[(Saved data)]\nB -. Retry .-> B\nC ==> D((Done))\nD -->|Revise| B"
    static let fragments = "sequenceDiagram\nparticipant U as You\nparticipant M as Michi\nU->>M: Review draft\nalt Approved\nM-->>U: Saved\nelse Needs changes\nloop Revise\nU->>M: Update\nM-->>U: Preview\nend\nend"
    static let table = "| Task | Owner | Status |\n| --- | --- | --- |\n| Native navigation | Cursor | Ready to review |\n| Safe diagrams | Codex | Verified |\n| Parity audit | Claude | Complete |"
    static let code = "```swift\n// Native views, shared contracts\nstruct Welcome: View {\n    let title = \"Hello, Michi\"\n    var body: some View {\n        Text(title).padding(16)\n    }\n}\n```"
    static var message: String? {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--preview-flowchart") { return "```mermaid\n" + flowchart + "\n```" }
        if args.contains("--preview-fragments") { return "```mermaid\n" + fragments + "\n```" }
        if args.contains("--preview-table") { return table }
        if args.contains("--preview-code") { return code }
        return nil
    }
    static let navigationFlags = ["--preview-navigation", "--preview-navigation-markdown", "--preview-navigation-toggle", "--preview-navigation-tab"]
    static var navigationRequested: Bool { navigationFlags.contains { ProcessInfo.processInfo.arguments.contains($0) } }
    static var navigationTarget: String {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--preview-navigation-markdown") { return "markdown-headings~2" }
        if args.contains("--preview-navigation-toggle") { return "toggle-heading" }
        if args.contains("--preview-navigation-tab") { return "tab-heading" }
        return "target-heading"
    }
    static var page: JSONValue {
        var blocks: [JSONValue] = [
            ["id": "contents", "rev": 1, "type": "toc"],
            ["id": "start-heading", "rev": 1, "type": "heading", "text": "Navigation starts here"],
            ["id": "markdown-headings", "rev": 1, "type": "markdown", "text": "## Markdown section\n\nA heading inside ordinary Markdown.\n\n### A deeper heading\n\nThe same native document."],
            ["id": "folded", "rev": 1, "type": "toggle", "title": "More details", "blocks": [["id": "toggle-heading", "type": "heading", "text": "Inside the toggle"], ["type": "markdown", "text": "Nested content is revealed before navigation."]]],
            ["id": "tabbed", "rev": 1, "type": "tabs", "tabs": [["label": "Overview", "blocks": [["type": "markdown", "text": "The first tab."]]], ["label": "Details", "blocks": [["id": "tab-heading", "type": "heading", "text": "Inside the second tab"], ["type": "markdown", "text": "The target tab becomes selected."]]]]]
        ]
        for index in 1...12 { blocks.append(["id": .string("spacer-\(index)"), "rev": 1, "type": "markdown", "text": .string("Section \(index). A separate paragraph makes the target far enough away to verify a real scroll.")]) }
        blocks.append(["id": "target-heading", "rev": 1, "type": "heading", "text": "The requested destination"])
        blocks.append(["id": "destination-copy", "rev": 1, "type": "markdown", "text": "This is the exact target, not the beginning of the page."])
        return ["id": "page-navigation", "workspaceId": "ws-preview", "title": "Native document navigation", "revision": 1, "blocks": .array(blocks)]
    }
    static func response(path: String, method: String) -> JSONValue? {
        guard method == "GET" else { return nil }
        let args = ProcessInfo.processInfo.arguments
        if navigationRequested || args.contains("--preview-home-navigation") {
            if path == "/pages/page-navigation" { return ["page": page] }
            if path == "/home/cards" { return ["contentMode": "page", "contentPage": page, "cardsCustomized": false, "greeting": .null, "sets": [], "generatedAt": 1, "inputFingerprint": "navigation-fixture"] }
        }
        if args.contains("--preview-provider-video"), path == "/pages/page-content" {
            return ["page": ["id": "page-content", "workspaceId": "ws-preview", "title": "Video links", "revision": 1, "blocks": [
                ["id": "provider-video", "rev": 1, "type": "video", "url": "https://www.youtube.com/watch?v=example", "caption": "This provider uses its own player. Open it in the browser or app."],
                ["id": "provider-vimeo", "rev": 1, "type": "video", "url": "https://vimeo.com/123456", "caption": "The native app does not pass a webpage to AVPlayer."]
            ]]]
        }
        return nil
    }
}
#endif
