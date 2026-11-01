import Foundation
import Combine
import MichiCore

/// Navigation resolves the current durable node/tree, rather than trusting
/// the tree ID recorded when the scheduled run originally started.
struct NativeRunConversationTarget: Equatable {
    let workspaceID: String
    let treeID: String
    let nodeID: String
    let readOnly: Bool
}

enum NativeScheduledRunContract {
    static let statuses = ["running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"]
    static func validate(_ value: JSONValue, expectedID: String? = nil, jobID: String? = nil) throws -> JSONValue {
        guard !value.id.isEmpty, !value["jobId"].stringValue.isEmpty, !value["workspaceId"].stringValue.isEmpty,
              statuses.contains(value["status"].stringValue), ["scheduled", "manual"].contains(value["trigger"].stringValue),
              let start = value["startedAt"].featureOptionalNumber, start.isFinite, start >= 0,
              expectedID.map({ value.id == $0 }) ?? true,
              jobID.map({ value["jobId"].stringValue == $0 }) ?? true else {
            throw NativeFailure("The backend returned an invalid scheduled run. Your previous view has been kept.")
        }
        for field in ["nodeId", "treeId"] where !value[field].isNull {
            guard let id = value[field].optionalString, !id.isEmpty else { throw NativeFailure("This run has an invalid conversation reference.") }
        }
        return value
    }
    static func target(run: JSONValue, workspace: JSONValue) throws -> NativeRunConversationTarget {
        let workspaceID = run["workspaceId"].stringValue, nodeID = run["nodeId"].stringValue
        guard !nodeID.isEmpty else { throw NativeFailure("This run has no conversation yet.") }
        guard workspace["workspace"].id == workspaceID, workspace["workspace"]["deleted_at"].isNull,
              case .array(let nodes) = workspace["nodes"], case .array(let trees) = workspace["trees"],
              let node = nodes.first(where: { $0.id == nodeID }), node["workspace_id"].stringValue == workspaceID,
              node["deleted_at"].isNull, !node["tree_id"].stringValue.isEmpty,
              let tree = trees.first(where: { $0.id == node["tree_id"].stringValue }),
              tree["workspace_id"].isNull || tree["workspace_id"].stringValue == workspaceID else {
            throw NativeFailure("That conversation is no longer available in this workspace.")
        }
        return NativeRunConversationTarget(workspaceID: workspaceID, treeID: tree.id, nodeID: nodeID,
            readOnly: !workspace["workspace"]["archived_at"].isNull || !tree["archived_at"].isNull)
    }
    static func duration(_ run: JSONValue) -> String? {
        guard let start = run["startedAt"].featureOptionalNumber, let end = run["finishedAt"].featureOptionalNumber,
              start.isFinite, end.isFinite, end >= start else { return nil }
        let seconds = min((end - start) / 1000, Double(Int.max - 1))
        guard seconds < Double(Int.max) else { return nil }
        let total = Int(seconds)
        if total >= 3600 { return "\(total / 3600)h \((total % 3600) / 60)m" }
        if total >= 60 { return "\(total / 60)m \(total % 60)s" }
        return "\(total)s"
    }
}

@MainActor final class NativeRunHistoryModel: ObservableObject {
    let api: MichiAPI
    let jobID: String
    @Published var runs: [JSONValue] = []
    @Published var loaded = false
    @Published var loading = false
    @Published var error: String?
    init(api: MichiAPI, jobID: String) { self.api = api; self.jobID = jobID }
    func reload() async {
        guard !loading, !jobID.isEmpty else { return }
        loading = true; defer { loading = false }
        do {
            let result = try await api.request("/scheduled-jobs/\(MichiAPI.pathSegment(jobID))/runs")
            guard case .array(let records) = result["runs"], records.count <= 500 else { throw NativeFailure("Scheduled run history could not be read.") }
            let valid = try records.map { try NativeScheduledRunContract.validate($0, jobID: jobID) }
            guard Set(valid.map(\.id)).count == valid.count else { throw NativeFailure("Scheduled run history contains duplicate IDs.") }
            runs = valid.sorted { first, second in
                first["startedAt"] == second["startedAt"] ? first.id < second.id : first["startedAt"].doubleValue > second["startedAt"].doubleValue
            }
            loaded = true; error = nil
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

@MainActor final class NativeScheduledRunModel: ObservableObject {
    let api: MichiAPI
    let runID: String
    @Published var run: JSONValue = .null
    @Published var loaded = false
    @Published var loading = false
    @Published var opening = false
    @Published var error: String?
    init(api: MichiAPI, runID: String) { self.api = api; self.runID = runID }
    var hasConversation: Bool { loaded && !run["nodeId"].stringValue.isEmpty }
    @discardableResult func reload() async -> Bool {
        guard !loading, !runID.isEmpty else { return false }
        loading = true; defer { loading = false }
        do {
            let result = try await api.request("/scheduled-jobs/runs/\(MichiAPI.pathSegment(runID))")
            run = try NativeScheduledRunContract.validate(result, expectedID: runID)
            loaded = true; error = nil; return true
        } catch is CancellationError { return false }
        catch { self.error = error.localizedDescription; return false }
    }
    /// A GET does not acknowledge Electron delivery or create browser read state.
    /// There is no shared inbox/read receipt contract for phone-web notifications.
    func conversationTarget() async -> NativeRunConversationTarget? {
        guard !opening else { return nil }
        opening = true; defer { opening = false }
        guard await reload() else { return nil }
        guard hasConversation else { error = "This run has no conversation yet."; return nil }
        let currentRun = run
        do {
            let workspaceID = currentRun["workspaceId"].stringValue
            let workspace = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))")
            let result = try NativeScheduledRunContract.target(run: currentRun, workspace: workspace)
            error = nil; return result
        } catch is CancellationError { return nil }
        catch { self.error = error.localizedDescription; return nil }
    }
}
