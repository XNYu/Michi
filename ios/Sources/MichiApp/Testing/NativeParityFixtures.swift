#if DEBUG
import Foundation
import MichiCore

/// Isolated DEBUG preview surfaces for remaining native parity. Synthetic only:
/// no host backend, agent, network, or production writes. Unknown hosts stay
/// with FixtureURLProtocol (403); unknown routes return nil and fail closed.
enum NativeParityFixtures {
    struct Response {
        let value: JSONValue
        var status = 200
    }

    struct StreamFrame {
        let event: String
        let body: JSONValue
        let seq: Int
    }

    static var args: [String] { ProcessInfo.processInfo.arguments }
    static var rich: Bool { args.contains("--preview-parity-rich") }
    static var stream: Bool { args.contains("--preview-parity-stream") }
    static var search: Bool { args.contains("--preview-parity-search") }
    static var board: Bool { args.contains("--preview-parity-board") }
    static var flowchartSubgraph: Bool { args.contains("--preview-parity-flowchart-subgraph") }
    static var sequencePar: Bool { args.contains("--preview-parity-sequence-par") }
    static var stateComposite: Bool { args.contains("--preview-parity-state-composite") }
    static var math: Bool { args.contains("--preview-parity-math") }
    static var html: Bool { args.contains("--preview-parity-html") }
    static var classDiagram: Bool { args.contains("--preview-parity-class") }
    static var erDiagram: Bool { args.contains("--preview-parity-er") }
    static var pie: Bool { args.contains("--preview-parity-pie") }
    static var databaseWrites: Bool {
        args.contains("--preview-database-order") || args.contains("--preview-database-management") || board || NativeComponentRuntimeFixtures.databaseView
    }

    static let databaseID = "db-preview"
    static let workspaceID = "ws-preview"
    static var chunkInterval: TimeInterval { args.contains("--preview-parity-slow") ? 15 : 5 }

    /// Combined transcript plus compact selector samples. Exact fences match
    /// `MarkdownDocument.mermaidBlock`, `NativeMathSyntax`, and `NativeHTMLDocument`.
    static let flowchartSupported = """
    ```mermaid
    flowchart TB
    Start([Start]) --> Gate{Ready?}
    Gate -- Yes --> Saved[(Saved)]
    Gate -. Retry .-> Gate
    Saved ==> Done((Done))
    ```
    """

    static let flowchartSubgraphSample = """
    ```mermaid
    flowchart TB
    subgraph Review [Review]
    Draft([Draft]) --> Gate{Ready?}
    end
    Gate -- Yes --> Saved[(Saved)]
    Gate -. Retry .-> Draft
    Saved ==> Done((Done))
    ```
    """

    static let sequenceSupported = """
    ```mermaid
    sequenceDiagram
    participant You
    participant Michi
    You->>Michi: Review draft
    alt Approved
    Michi-->>You: Saved
    else Needs changes
    loop Revise
    You->>Michi: Update
    Michi-->>You: Preview
    end
    end
    ```
    """

    static let sequenceParSample = """
    ```mermaid
    sequenceDiagram
    participant You
    participant Michi
    par Search
    You->>Michi: Query
    and Rank
    Michi-->>You: Hits
    end
    critical Save
    Michi->>You: Persist
    option Conflict
    Michi-->>You: Retry
    end
    ```
    """

    static let stateSupported = """
    ```mermaid
    stateDiagram-v2
    [*] --> Draft
    Draft --> Review: Submit
    Review --> Draft: Revise
    Review --> Done: Approve
    Done --> [*]
    ```
    """

    static let stateCompositeSample = """
    ```mermaid
    stateDiagram-v2
    [*] --> Review
    state Review {
    [*] --> Draft
    Draft --> Ready: Submit
    Ready --> Draft: Revise
    }
    Review --> Done: Approve
    Done --> [*]
    ```
    """

    static let mathSample = """
    $$
    \\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}
    $$

    $$
    \\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}
    $$

    $$
    \\begin{cases}x&x>0\\\\-x&x\\le 0\\end{cases}
    $$

    Inline fonts: $\\mathbb{R}$, $\\mathcal{L}$, $\\mathbf{v}$, $\\mathrm{d}x$.
    """

    static let htmlSample = """
    <details>
    <summary>Safe static details</summary>
    <p>Water is H<sub>2</sub>O. Energy is E=mc<sup>2</sup>.</p>
    <table>
    <thead><tr><th>Kind</th><th>Example</th></tr></thead>
    <tbody>
    <tr><td>subscript</td><td>H<sub>2</sub>O</td></tr>
    <tr><td>superscript</td><td>mc<sup>2</sup></td></tr>
    </tbody>
    </table>
    </details>
    """

    static let classSample = """
    ```mermaid
    classDiagram
    class Animal {
    +String name
    +eat()
    }
    class Duck {
    +String beakColor
    +quack()
    }
    Animal "1" <|-- "many" Duck : inherits
    ```
    """

    static let erSample = """
    ```mermaid
    erDiagram
    CUSTOMER ||--o{ ORDER : places
    CUSTOMER {
    string name PK
    string sector
    }
    ORDER {
    int orderNumber PK
    string deliveryAddress
    }
    ```
    """

    static let pieSample = """
    ```mermaid
    pie showData
    title Pets adopted
    "Dogs" : 386
    "Cats" : 85
    "Rats" : 15
    ```
    """

    static let richMessage = """
    # Native parity preview

    Deterministic synthetic chat. No host, agent, or network.

    ## Flowchart

    Supported today (no subgraph):

    \(flowchartSupported)

    Flowchart subgraph:

    \(flowchartSubgraphSample)

    ## Sequence

    Supported today (`alt` / `opt` / `loop`):

    \(sequenceSupported)

    Sequence `par` / `critical`:

    \(sequenceParSample)

    ## State

    Supported today (flat `stateDiagram-v2`):

    \(stateSupported)

    Composite state:

    \(stateCompositeSample)

    ## Mathematics

    Supported matrices, cases, and fonts:

    \(mathSample)

    ## Safe static HTML

    No script, iframe, or embedded players.

    \(htmlSample)
    """

    static let streamOpening = """
    A native table streams over about \(Int(chunkInterval * 7)) seconds.

    | Step | Surface | Status |
    | --- | --- | --- |
    | 1 | Inline cards | Visible |
    """

    static let streamRows = [
        "\n| 2 | Fullscreen | Open now |",
        "\n| 3 | Row growth | Adding |",
        "\n| 4 | Close cover | Keep stream |",
        "\n| 5 | Reopen cover | Same table |",
        "\n| 6 | Stop cancels | Timers halt |",
        "\n| 7 | History | Same turn |",
        "\n| 8 | Complete | Persisted |"
    ]

    /// Combining acute + supplementary-plane emoji. `<mark>` pairs only.
    static let searchSnippet = "Native café <mark>日本語</mark> and cafe\u{0301} <mark>👨‍👩‍👧‍👦</mark> résumé."

    private static let lock = NSRecursiveLock()
    private static var databaseStore: JSONValue?
    private static var streamSession: StreamSession?

    private struct StreamSession {
        var node: String
        var turn: String
        var assistant: String
        var answer: String
        var frames: [StreamFrame]
        var remaining: [String]
        var nextSeq: Int
        var finished: Bool
    }

    static func seededMessages() -> [JSONValue]? {
        guard rich else { return nil }
        return [[
            "id": "parity-rich",
            "node_id": "n-preview",
            "role": "assistant",
            "content": .string(selectedRichMessage()),
            "seq": 0,
            "created_at": 1
        ]]
    }

    static func selectedRichMessage() -> String {
        let sections: [(flag: Bool, title: String, body: String)] = [
            (flowchartSubgraph, "Flowchart subgraph", flowchartSubgraphSample),
            (sequencePar, "Sequence par / critical", sequenceParSample),
            (stateComposite, "Composite state", stateCompositeSample),
            (math, "Mathematics", mathSample),
            (html, "Safe static HTML", htmlSample),
            (classDiagram, "Class diagram", classSample),
            (erDiagram, "Entity relationships", erSample),
            (pie, "Pie chart", pieSample)
        ]
        let selected = sections.filter(\.flag)
        guard !selected.isEmpty else { return richMessage }
        return "# Native parity preview\n\n" + selected.map { "## \($0.title)\n\n\($0.body)" }.joined(separator: "\n\n")
    }

    static func liveDatabase() -> JSONValue {
        lock.lock(); defer { lock.unlock() }
        if databaseStore == nil {
            var initial = ContinuationFixtures.database
            if NativeComponentRuntimeFixtures.databaseView {
                var rows = initial["rows"].arrayValue
                if let index = rows.firstIndex(where: { exact($0.id, "r-ui") }) {
                    rows[index]["values"]["status"] = "todo"
                }
                initial["rows"] = .array(rows)
            }
            databaseStore = initial
        }
        var snapshot = databaseStore ?? ContinuationFixtures.database
        if NativeComponentRuntimeFixtures.databaseView {
            snapshot = NativeComponentRuntimeFixtures.withCustomView(snapshot)
            databaseStore = snapshot
        }
        return snapshot
    }

    static func replaceDatabase(_ database: JSONValue) {
        lock.lock(); defer { lock.unlock() }
        databaseStore = database
    }

    static func response(path: String, method: String, url _: URL, body: JSONValue) -> Response? {
        if search, path == "/search", method == "GET" {
            return Response(value: searchPayload())
        }
        if databaseWrites, path == "/databases/\(databaseID)/edits", method == "POST" {
            return editDatabase(body)
        }
        return nil
    }

    static func beginStream(node: String, turn: String, assistant: String) {
        lock.lock(); defer { lock.unlock() }
        streamSession = StreamSession(
            node: node, turn: turn, assistant: assistant,
            answer: streamOpening, frames: [], remaining: streamRows,
            nextSeq: 0, finished: false
        )
    }

    static func recordFrame(event: String, body: JSONValue, seq: Int) {
        lock.lock(); defer { lock.unlock() }
        guard streamSession != nil else { return }
        streamSession?.frames.append(StreamFrame(event: event, body: body, seq: seq))
        streamSession?.nextSeq = seq + 1
    }

    static func appendAnswer(_ text: String) {
        lock.lock(); defer { lock.unlock() }
        streamSession?.answer += text
    }

    static func popStreamRow() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard streamSession != nil, !(streamSession?.remaining.isEmpty ?? true) else { return nil }
        return streamSession?.remaining.removeFirst()
    }

    static func currentAnswer() -> String {
        lock.lock(); defer { lock.unlock() }
        return streamSession?.answer ?? streamOpening
    }

    static func hasRemainingRows() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !(streamSession?.remaining.isEmpty ?? true)
    }

    static func recordedFrames() -> [StreamFrame] {
        lock.lock(); defer { lock.unlock() }
        return streamSession?.frames ?? []
    }

    static func matchesStream(node: String, turn: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let session = streamSession else { return false }
        return exact(session.node, node) && exact(session.turn, turn)
    }

    static func streamIdentity() -> (node: String, turn: String, assistant: String)? {
        lock.lock(); defer { lock.unlock() }
        guard let session = streamSession else { return nil }
        return (session.node, session.turn, session.assistant)
    }

    static func markStreamFinished() {
        lock.lock(); defer { lock.unlock() }
        streamSession?.finished = true
        streamSession?.remaining = []
    }

    static func isStreamFinished() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return streamSession?.finished == true
    }

    static func nextStreamSeq() -> Int {
        lock.lock(); defer { lock.unlock() }
        return streamSession?.nextSeq ?? 0
    }

    private static func searchPayload() -> JSONValue {
        [
            "totalNodes": 1,
            "results": [[
                "nodeId": "n-preview",
                "nodeTitle": "A native home for your ideas",
                "workspaceId": .string(workspaceID),
                "workspaceName": "Michi Studio",
                "treeId": "tree-preview",
                "lastMessageAt": 1,
                "totalMatches": 1,
                "breadcrumb": ["A native home for your ideas"],
                "snippets": [[
                    "messageId": .string(rich ? "parity-rich" : "welcome"),
                    "role": "assistant",
                    "snippet": .string(searchSnippet)
                ]]
            ]]
        ]
    }

    private static func editDatabase(_ body: JSONValue) -> Response {
        guard case .object = body,
              case .number(let revisionNumber) = body["revision"],
              revisionNumber.isFinite, revisionNumber.rounded(.towardZero) == revisionNumber,
              revisionNumber >= 1, revisionNumber <= 9_007_199_254_740_991,
              case .array(let ops) = body["ops"], !ops.isEmpty, ops.count <= 50 else {
            return invalid("Invalid database edit")
        }
        lock.lock(); defer { lock.unlock() }
        if databaseStore == nil { databaseStore = ContinuationFixtures.database }
        guard let database = databaseStore, exact(database.id, databaseID),
              exact(database["workspaceId"].stringValue, workspaceID) else {
            return notFound("Database not found")
        }
        let requested = Int(revisionNumber)
        if database["revision"].intValue != requested {
            return Response(value: error("stale_revision", "Database revision changed"), status: 409)
        }
        var next = database
        for op in ops {
            switch op["op"].stringValue {
            case "row.move":
                if let failed = applyRowMove(op, to: &next) { return failed }
            case "column.move":
                if let failed = applyColumnMove(op, to: &next) { return failed }
            case "row.update":
                if let failed = applyRowUpdate(op, to: &next) { return failed }
            case "view.save":
                let view = op["view"]
                guard !view.id.isEmpty, !view["name"].stringValue.isEmpty,
                      view["type"] == "custom", case .object = view["config"],
                      case .object = view["config"]["props"],
                      NativePageComponentContract.pinnedVersion(view["config"]["pinnedVersion"]) != nil else {
                    return invalid("Invalid custom view binding")
                }
                let component = view["config"]["componentId"].stringValue
                guard exact(component, NativeComponentRuntimeFixtures.calculatorID) || exact(component, NativeComponentRuntimeFixtures.databaseComponentID) else {
                    return notFound("Component unavailable")
                }
                var views = next["views"].arrayValue
                let existing = views.firstIndex { exact($0.id, view.id) }
                var saved = view
                saved["position"] = existing.map { views[$0]["position"] } ?? .number(Double(views.count))
                saved["edit"] = ["at": .number(Date().timeIntervalSince1970 * 1_000)]
                if let existing { views[existing] = saved } else { views.append(saved) }
                next["views"] = .array(views)
            default:
                return invalid("Unsupported fixture database command")
            }
        }
        next["revision"] = .number(Double(requested + 1))
        databaseStore = next
        return Response(value: [
            "database": next,
            "changes": ["applied": .array(ops), "rejected": []]
        ])
    }

    private static func applyRowMove(_ operation: JSONValue, to database: inout JSONValue) -> Response? {
        guard !operation["id"].stringValue.isEmpty else { return invalid("Invalid row move") }
        do {
            let expected = try DatabaseOrdering.expectedIDs(database: database, operation: operation)
            let rows = DatabaseOrdering.orderedRows(database)
            let byID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
            guard expected.allSatisfy({ byID[$0] != nil }), expected.count == rows.count else {
                return invalid("The move target is invalid.")
            }
            database["rows"] = .array(expected.enumerated().map { index, id in
                byID[id]!.merging(["position": .number(Double(index))])
            })
            return nil
        } catch {
            return invalid((error as? FeatureRequestError)?.message ?? "The move target is invalid.")
        }
    }

    private static func applyColumnMove(_ operation: JSONValue, to database: inout JSONValue) -> Response? {
        guard !operation["id"].stringValue.isEmpty else { return invalid("Invalid column move") }
        do {
            let expected = try DatabaseOrdering.expectedIDs(database: database, operation: operation)
            let columns = database["columns"].arrayValue
            let byID = Dictionary(uniqueKeysWithValues: columns.map { ($0.id, $0) })
            guard expected.allSatisfy({ byID[$0] != nil }), expected.count == columns.count else {
                return invalid("The move target is invalid.")
            }
            database["columns"] = .array(expected.compactMap { byID[$0] })
            return nil
        } catch {
            return invalid((error as? FeatureRequestError)?.message ?? "The move target is invalid.")
        }
    }

    private static func applyRowUpdate(_ operation: JSONValue, to database: inout JSONValue) -> Response? {
        let id = operation["id"].stringValue
        guard !id.isEmpty, case .object(let values) = operation["values"], !values.isEmpty,
              let expectRev = exactRevision(operation["expectRev"]) else {
            return invalid("Invalid row update")
        }
        var rows = database["rows"].arrayValue
        guard let index = rows.firstIndex(where: { exact($0.id, id) }) else {
            return invalid("The row no longer belongs to the database.")
        }
        let currentRev = rows[index]["rev"].intValue
        if currentRev != expectRev {
            return Response(value: error("stale_revision", "Row revision changed"), status: 409)
        }
        var row = rows[index]
        var merged = row["values"].objectValue
        for (key, value) in values { merged[key] = value }
        row["values"] = .object(merged)
        row["rev"] = .number(Double(currentRev + 1))
        rows[index] = row
        database["rows"] = .array(rows)
        return nil
    }

    private static func exact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    private static func exactRevision(_ value: JSONValue) -> Int? {
        guard case .number(let number) = value, number.isFinite, number.rounded(.towardZero) == number,
              number >= 1, number <= 9_007_199_254_740_991 else { return nil }
        return Int(number)
    }

    private static func error(_ code: String, _ message: String) -> JSONValue {
        ["error": ["code": .string(code), "message": .string(message)]]
    }
    private static func invalid(_ message: String) -> Response { Response(value: error("invalid", message), status: 400) }
    private static func notFound(_ message: String) -> Response { Response(value: error("not_found", message), status: 404) }
}
#endif
