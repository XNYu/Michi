#if DEBUG
import SwiftUI
import MichiCore

enum ContinuationFixtures {
    static var arguments: [String] { ProcessInfo.processInfo.arguments }
    static let page: JSONValue = ["id": "page-preview", "workspaceId": "ws-preview", "title": "Today at Michi", "revision": 1, "blocks": [
        ["id": "welcome", "rev": 1, "type": "heading", "text": "Your day, in focus"],
        ["id": "intro", "rev": 1, "type": "markdown", "text": "Your custom Home document now appears **right here**, with native page controls."],
        ["id": "metrics", "rev": 1, "type": "metrics", "items": [["label": "In progress", "value": "3"], ["label": "Ready to review", "value": "2"]]],
        ["id": "check", "rev": 1, "type": "checklist", "items": [["text": "Review the native interface", "done": true], ["text": "Try a focused conversation", "done": false]]],
        ["id": "native-code", "rev": 1, "type": "code", "language": "swift", "code": "Text(\"Welcome to Michi\")"]
    ]]
    static let component: JSONValue = ["id": "component-preview", "ownerUserId": "fixture-owner", "workspaceId": "ws-preview", "name": "focus-card", "description": "A workspace component with saved source and immutable versions.", "enabled": true, "activeVersion": 2, "libraryRevision": 4, "revocationEpoch": 1, "deletedAt": .null, "versions": 2, "createdAt": 1, "updatedAt": 2]
    static let database: JSONValue = ["id": "db-preview", "workspaceId": "ws-preview", "title": "Native release", "revision": 4, "columns": [
        ["id": "title", "name": "Title", "type": "text"],
        ["id": "status", "name": "Status", "type": "select", "options": [["value": "todo", "label": "To do"], ["value": "done", "label": "Done"]]],
        ["id": "priority", "name": "Priority", "type": "number"]
    ], "views": [
        ["id": "board", "name": "Board", "type": "board", "position": 0, "config": ["group": "status", "visible": ["title", "priority"], "filters": [], "sorts": []]],
        ["id": "list", "name": "List", "type": "list", "position": 1, "config": ["filters": [], "sorts": []]]
    ], "rows": [
        ["id": "r-ui", "rev": 1, "position": 0, "values": ["title": "Native Home", "status": "done", "priority": 1]],
        ["id": "r-graph", "rev": 1, "position": 1, "values": ["title": "Relationship graph", "status": "todo", "priority": 2]],
        ["id": "r-review", "rev": 1, "position": 2, "values": ["title": "Review on iPhone", "status": "todo", "priority": 3]]
    ]]

    static func response(path: String, method: String, url: URL) -> JSONValue? {
        guard method == "GET" else { return nil }
        if arguments.contains("--preview-home-page") {
            if path == "/home/cards" { return ["contentMode": "page", "contentPage": page, "cardsCustomized": false, "greeting": .null, "sets": [], "generatedAt": 1, "inputFingerprint": "native-home-fixture"] }
            if path == "/pages/page-preview" { return ["page": page] }
        }
        if arguments.contains("--preview-components"), !NativeComponentRuntimeFixtures.active {
            if path == "/workspaces/ws-preview/components" { return ["revision": 4, "items": [component]] }
            if path == "/components/component-preview/references" { return ["items": [["componentId": "component-preview", "workspaceId": "ws-preview", "kind": "page_block", "pageId": "page-preview", "blockId": "widget", "pinnedVersion": 2, "protected": true, "hostRevision": 1]]] }
            if path == "/components/component-preview" {
                let version = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "version" })?.value.flatMap(Int.init) ?? 2
                return ["componentId": "component-preview", "version": .number(Double(version)), "code": "const title = document.createElement('h2');\ntitle.textContent = props.title;\nroot.appendChild(title);", "propsSchema": ["type": "object", "properties": ["title": ["type": "string"]]], "source": ["kind": "user"], "createdAt": 2]
            }
        }
        if arguments.contains("--preview-database-management") || arguments.contains("--preview-database-order") || NativeParityFixtures.board || NativeComponentRuntimeFixtures.databaseView {
            if path == "/databases/db-preview" { return ["database": NativeParityFixtures.liveDatabase()] }
        }
        return nil
    }

    static func augment(_ original: JSONValue) -> JSONValue {
        guard arguments.contains("--preview-graph") else { return original }
        var graph = original
        func node(_ id: String, _ parent: String?, _ title: String, tree: String = "tree-preview") -> JSONValue {
            ["id": .string(id), "workspace_id": "ws-preview", "tree_id": .string(tree), "parent_node_id": parent.map(JSONValue.string) ?? .null, "title": .string(title), "kind": "chat", "status": "idle", "deleted_at": .null, "created_at": 1]
        }
        graph["nodes"] = [node("n-preview", nil, "Michi native iOS"), node("n-home", "n-preview", "Home & pages"), node("n-data", "n-preview", "Data & recovery"), node("n-tests", "n-home", "Simulator validation"), node("n-context", nil, "Phone web contracts", tree: "tree-context")]
        graph["trees"] = .array(graph["trees"].arrayValue + [["id": "tree-context", "workspace_id": "ws-preview", "root_node_id": "n-context", "created_at": 1, "last_active_at": 1, "archived_at": .null]])
        graph["edges"] = [["id": "merge-context", "source_node_id": "n-context", "target_node_id": "n-preview", "kind": "merge"]]
        return graph
    }
}

struct NativeContinuationPreview: View {
    let api: MichiAPI
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        if let reference = ReferenceParityFixtures.reference {
            NativeReferenceScreen(api: api, reference: reference)
        } else {
        NavigationStack {
            Group {
                if ContinuationFixtures.arguments.contains("--preview-reference-table") {
                    NativeReferenceTablePreview(api: api)
                } else if TaskUpkeepFixtures.active && ContinuationFixtures.arguments.contains("--preview-task-board") {
                    FeatureDatabaseScreen(api: api, databaseId: "db-upkeep", workspaceId: "ws-preview")
                } else if TaskUpkeepFixtures.active {
                    NativeTaskUpkeepPreview(api: api)
                } else if ReferenceParityFixtures.active && ContinuationFixtures.arguments.contains("--preview-page-sources") {
                    FeaturePageScreen(api: api, pageId: "page-reference", workspaceId: "ws-preview", workspaces: [], scrollTargetID: "source-body")
                } else if ContentParityFixtures.navigationRequested {
                    FeaturePageScreen(api: api, pageId: "page-navigation", workspaceId: "ws-preview", workspaces: [], scrollTargetID: ContentParityFixtures.navigationTarget)
                } else if ContinuationFixtures.arguments.contains("--preview-provider-video") {
                    FeaturePageScreen(api: api, pageId: "page-content", workspaceId: "ws-preview", workspaces: [])
                } else if NativeComponentRuntimeFixtures.page {
                    FeaturePageScreen(api: api, pageId: NativeComponentRuntimeFixtures.calculatorPageID, workspaceId: "ws-preview", workspaces: [])
                } else if NativeComponentRuntimeFixtures.library {
                    NativeComponentLibraryScreen(api: api, workspaceID: "ws-preview",
                        initialComponentID: NativeComponentRuntimeFixtures.calculatorID, initialVersion: 2)
                } else if NativeComponentRuntimeFixtures.databaseView {
                    FeatureDatabaseScreen(api: api, databaseId: "db-preview", workspaceId: "ws-preview", initialViewId: NativeComponentRuntimeFixtures.customViewID)
                } else if NativeParityFixtures.board {
                    FeatureDatabaseScreen(api: api, databaseId: "db-preview", workspaceId: "ws-preview", initialViewId: "board")
                } else if ContinuationFixtures.arguments.contains("--preview-components") {
                    NativeComponentLibraryScreen(api: api, workspaceID: "ws-preview", initialComponentID: "component-preview")
                } else if ContinuationFixtures.arguments.contains("--preview-database-management") || ContinuationFixtures.arguments.contains("--preview-database-order") {
                    NativeDatabasePreview(api: api)
                } else { NativeBlockCatalogScreen() }
            }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        }
    }
}

/// Dedicated real-component preview of NativeMarkdownTableView plus a stable
/// presenter. This is not a live streaming conversation or full page flow.
private struct NativeReferenceTablePreview: View {
    let api: MichiAPI
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Nested table references")
                    .font(.headline)
                Text("This preview hosts the real table component on a stable NavigationStack presenter.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                NativeMarkdownTableView(
                    headers: ["Source", "Link"],
                    alignments: [.leading, .leading],
                    rows: [[
                        "Cited page",
                        "[Open cited page](michi://page/page-reference?block=source-body)"
                    ]]
                )
            }
            .padding()
        }
        .navigationTitle("Table references")
        .nativeMichiReferences(api: api)
    }
}

private struct NativeDatabasePreview: View {
    @StateObject private var model: FeatureDatabaseModel
    init(api: MichiAPI) { _model = StateObject(wrappedValue: FeatureDatabaseModel(api: api, databaseId: "db-preview", workspaceId: "ws-preview")) }
    var body: some View {
        Group {
            if ContinuationFixtures.arguments.contains("--preview-database-order") { DatabaseOrderingScreen(model: model) }
            else { DatabaseManagementScreen(model: model) }
        }
    }
}
#endif
