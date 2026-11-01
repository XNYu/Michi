#if DEBUG
import SwiftUI
import MichiCore

/// Synthetic, read-only responses for the actual task board and row screens.
/// FixtureURLProtocol also restricts these to its isolated preview host.
enum TaskUpkeepFixtures {
    struct Response {
        let value: JSONValue
        var status = 200
    }
    static let flags = ["--preview-task-board", "--preview-task-upkeep", "--preview-task-origin", "--preview-task-proposal"]
    static var active: Bool {
        let args = ProcessInfo.processInfo.arguments
        return args.contains("--uitesting") && flags.contains { args.contains($0) }
    }
    // Stable for this process, recent enough to exercise the real mark expiry.
    static let at = (Date().timeIntervalSince1970 * 1000).rounded(.down)
    static let row: JSONValue = [
        "id": "r-upkeep", "rev": 4, "position": 0, "updatedAt": .number(at),
        "values": ["task": "Review release checklist", "status": "waiting", "threads": [], "next": "Confirm native parity"],
        "body": "A saved task with one suggestion waiting for review.",
        "edited": ["task": .number(at), "next": .number(at)], "bodyEditedAt": .null
    ]
    static let addedRow: JSONValue = [
        "id": "r-upkeep-added", "rev": 4, "position": 1, "updatedAt": .number(at),
        "values": ["task": "Verify saved sources", "status": "todo", "threads": [], "next": "Review cited conversation"],
        "body": "", "edited": [:], "bodyEditedAt": .null
    ]
    static let database: JSONValue = [
        "id": "db-upkeep", "workspaceId": "ws-preview", "role": "tasks", "title": "Workspace tasks", "revision": 4, "updatedAt": .number(at),
        "columns": [
            ["id": "task", "name": "Task", "type": "text"],
            ["id": "status", "name": "Status", "type": "select", "options": [
                ["value": "todo", "label": "To do"], ["value": "doing", "label": "In progress"],
                ["value": "waiting", "label": "Waiting on you"], ["value": "done", "label": "Done"]]],
            ["id": "threads", "name": "Conversations", "type": "threads"],
            ["id": "next", "name": "Next step", "type": "text"]
        ],
        "views": [["id": "tasks-board", "name": "Board", "type": "board", "position": 0,
            "config": ["filters": [], "match": "all", "sorts": [], "group": "status", "visible": ["task", "next"]]]],
        "rows": [row, addedRow]
    ]
    static var suggestion: JSONValue {
        var proposed = row
        proposed["values"]["next"] = "Verify the native app on a physical iPhone"
        let location: JSONValue = ["position": 0, "after": .null]
        return [
            "id": "change-upkeep", "seq": 12, "batchId": "batch-upkeep",
            "target": ["kind": "row", "databaseId": "db-upkeep", "rowId": "r-upkeep", "columnIds": ["next"]],
            "op": "row",
            "before": ["kind": "row", "exists": true, "row": row, "location": location],
            "after": ["kind": "row", "exists": true, "row": proposed, "location": location],
            "forward": ["kind": "row", "op": "patch", "id": "r-upkeep", "values": ["next": "Verify the native app on a physical iPhone"]],
            "inverse": ["kind": "row", "op": "patch", "id": "r-upkeep", "values": ["next": "Confirm native parity"]],
            "baseRev": 4, "appliedRev": .null, "previousHeadId": .null,
            "source": ["kind": "maintenance", "jobId": "job-upkeep", "runId": "run-upkeep", "nodeId": "n-preview", "turnId": "source-turn", "assistantId": "source-answer",
                "read": ["kind": "conversations", "count": 2], "evidence": [ReferenceParityFixtures.ordinarySource]],
            "proposalState": "pending", "applicationState": .null, "createdAt": .number(at), "resolvedAt": .null
        ]
    }
    static var activity: JSONValue {
        ["suggestions": [suggestion],
         "marks": [["rowId": "r-upkeep", "kind": "updated", "at": .number(at)], ["rowId": "r-upkeep-added", "kind": "new", "at": .number(at)]],
         "latestUpkeep": ["batchId": "batch-upkeep", "at": .number(at), "added": 1, "updated": 0, "removed": 0, "suggested": 1,
            "source": ReferenceParityFixtures.ordinarySource.merging(["title": "Native release evidence"])]]
    }
    static func response(path: String, method: String) -> Response? {
        guard active else { return nil }
        let owned = path == "/databases/db-upkeep" || path.hasPrefix("/databases/db-upkeep/") || path.hasPrefix("/page-changes/change-upkeep/")
        guard owned else { return nil }
        guard method == "GET" else {
            return Response(value: ["error": ["code": "fixture_read_only", "message": "Task upkeep preview is read-only; no change was applied."]], status: 404)
        }
        switch path {
        case "/databases/db-upkeep": return Response(value: ["database": database])
        case "/databases/db-upkeep/task-activity": return Response(value: activity)
        case "/databases/db-upkeep/rows/r-upkeep/origin": return Response(value: ["origin": ["by": "meta-agent", "conversations": 2, "at": .number(at)]])
        case "/databases/db-upkeep/rows/r-upkeep-added/origin": return Response(value: ["origin": ["by": "meta-agent", "conversations": 1, "at": .number(at)]])
        default: return Response(value: ["error": ["code": "not_found", "message": "Unknown task upkeep fixture read."]], status: 404)
        }
    }
}

struct NativeTaskUpkeepPreview: View {
    let api: MichiAPI
    @StateObject private var model: FeatureDatabaseModel
    private var originOnly: Bool { ProcessInfo.processInfo.arguments.contains("--preview-task-origin") }
    private var proposalOnly: Bool { ProcessInfo.processInfo.arguments.contains("--preview-task-proposal") }
    init(api: MichiAPI) {
        self.api = api
        _model = StateObject(wrappedValue: FeatureDatabaseModel(api: api, databaseId: "db-upkeep", workspaceId: "ws-preview"))
    }
    var body: some View {
        Group {
            if originOnly {
                Form { NativeTaskOriginSection(api: api, databaseId: "db-upkeep", rowId: "r-upkeep") }
                    .navigationTitle("Task origin")
            } else if proposalOnly {
                Form {
                    if let change = model.taskActivity.suggestions(for: "r-upkeep").first {
                        Section("Suggestions") {
                            NativeTaskSuggestionCard(model: model, change: change)
                        }
                    } else if model.database.isNull {
                        if let error = model.error { Text(error) }
                        else { ProgressView("Loading proposal preview") }
                    }
                    NativeTaskOriginSection(api: api, databaseId: "db-upkeep", rowId: "r-upkeep")
                }
                .navigationTitle("Task proposal")
                .accessibilityIdentifier("task-proposal-preview")
            } else if model.database.isNull {
                if let error = model.error { Text(error) }
                else { ProgressView("Loading task preview") }
            } else if let row = model.rows.first(where: { $0.id == "r-upkeep" }) {
                FeatureDatabaseRowScreen(model: model, row: row)
            }
        }
        .task { if !originOnly { await model.refresh() } }
    }
}
#endif
