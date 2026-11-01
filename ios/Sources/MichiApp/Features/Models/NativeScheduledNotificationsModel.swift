import Foundation
import Combine
import MichiCore

struct NativeScheduledNoticeIdentity: Hashable {
    let runID: String
    let phase: String
    let attention: String?
    let status: String
    let at: Double
}

struct NativeScheduledNotice: Identifiable, Equatable {
    let id: NativeScheduledNoticeIdentity
    let jobID: String
    let workspaceID: String
    let nodeID: String
    let title: String
    let subtitle: String
    let body: String
    var needsAttention: Bool { id.phase == "attention" }
}

struct NativeScheduledNotificationTarget: Equatable {
    let workspaceID: String
    let nodeID: String
    let treeID: String
    let readOnly: Bool
}

enum NativeScheduledNotificationsContract {
    static func validID(_ id: String) -> Bool { !id.isEmpty && id.utf16.count <= 200 }

    /// Mirrors phone-web describeScheduledRunNotice. Scheduling has its own
    /// per-job notify switch: "approval-only" does not suppress that switch.
    /// Only the global "off" preference suppresses all scheduled notices.
    static func notice(_ event: JSONValue) -> NativeScheduledNotice? {
        let phase = event["phase"].stringValue, status = event["status"].stringValue
        guard ["started", "finished", "attention"].contains(phase),
              ["running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"].contains(status),
              validID(event["runId"].stringValue), validID(event["jobId"].stringValue),
              validID(event["workspaceId"].stringValue), validID(event["nodeId"].stringValue),
              let jobName = event["jobName"].optionalString, !jobName.isEmpty,
              let notify = event["notify"].featureOptionalBool,
              let at = event["at"].featureOptionalNumber, at.isFinite, at >= 0,
              at.rounded(.down) == at, at <= 9_007_199_254_740_991,
              event["treeId"].isNull || event["treeId"].optionalString.map(validID) == true,
              event["summary"].isNull || event["summary"].optionalString != nil,
              event["error"].isNull || event["error"].optionalString != nil else { return nil }
        let attention = event["attention"].optionalString
        let subtitle: String, body: String
        if phase == "attention" {
            guard status == "running", attention == "approval" || attention == "input" else { return nil }
            subtitle = attention == "input" ? "Needs your input" : "Needs your approval"
            body = "The scheduled run is waiting. Open it to continue."
        } else {
            guard phase == "finished", notify else { return nil }
            switch status {
            case "succeeded":
                subtitle = "Scheduled job finished"
                body = event["summary"].stringValue.isEmpty ? "Open the conversation to see the result." : event["summary"].stringValue
            case "failed", "timed_out":
                subtitle = "Scheduled job failed"
                body = event["error"].stringValue.isEmpty ? "Open the job for details." : event["error"].stringValue
            default: return nil
            }
        }
        return NativeScheduledNotice(
            id: NativeScheduledNoticeIdentity(runID: event["runId"].stringValue, phase: phase, attention: attention, status: status, at: at),
            jobID: event["jobId"].stringValue, workspaceID: event["workspaceId"].stringValue, nodeID: event["nodeId"].stringValue,
            title: String(jobName.prefix(200)), subtitle: subtitle, body: String(body.prefix(1_500)))
    }

    /// Use the current durable node/tree; the run's historical tree may have moved.
    static func target(for notice: NativeScheduledNotice, workspace: JSONValue) throws -> NativeScheduledNotificationTarget {
        let record = workspace["workspace"]
        guard record.id == notice.workspaceID, record["deleted_at"].isNull, record["purged_at"].isNull,
              case .array(let nodes) = workspace["nodes"], case .array(let trees) = workspace["trees"],
              let node = nodes.first(where: { $0.id == notice.nodeID }),
              node["workspace_id"].stringValue == notice.workspaceID,
              node["deleted_at"].isNull, node["purged_at"].isNull,
              node["kind"].isNull || node["kind"].stringValue == "chat",
              let tree = trees.first(where: { $0.id == node["tree_id"].stringValue && !$0.id.isEmpty }),
              tree["workspace_id"].isNull || tree["workspace_id"].stringValue == notice.workspaceID,
              tree["deleted_at"].isNull, tree["purged_at"].isNull else {
            throw FeatureRequestError(message: "This scheduled conversation is no longer available in its workspace.")
        }
        return NativeScheduledNotificationTarget(workspaceID: notice.workspaceID, nodeID: notice.nodeID, treeID: tree.id,
            readOnly: !record["archived_at"].isNull || !tree["archived_at"].isNull)
    }
}

/// Receives scheduled_job_run from MichiStore's existing /chats/background/subscribe
/// observer. The separate /scheduled-jobs/notifications/stream endpoint belongs to
/// Electron's global delivery protocol; opening it would register a desktop
/// notifier and change wake-up behavior. Native phone banners never use it or ack.
@MainActor final class NativeScheduledNotificationsModel: ObservableObject {
    static let deduplicationLimit = 512
    let api: MichiAPI
    @Published private(set) var notice: NativeScheduledNotice?
    @Published private(set) var active = false
    @Published private(set) var opening = false
    @Published private(set) var error: String?
    private(set) var notificationPreference: String?
    private var remembered: Set<NativeScheduledNoticeIdentity> = []
    private var order: [NativeScheduledNoticeIdentity] = []
    private var activationGeneration: UInt64 = 0
    private var openingGeneration: UUID?

    init(api: MichiAPI) { self.api = api }

    /// Attach/detach UI delivery with scene activity; the shell controls its one
    /// observer connection. Detaching does not cancel a scheduled run.
    func setActive(_ value: Bool) {
        guard value != active else { return }
        active = value; activationGeneration &+= 1
        if !value { notice = nil; error = nil; openingGeneration = nil; opening = false }
    }

    /// Pass nil until server preferences have loaded. Unknown values fail closed.
    func setNotificationPreference(_ value: String?) {
        let next = value.flatMap { ["all", "approval-only", "off"].contains($0) ? $0 : nil }
        guard next != notificationPreference else { return }
        notificationPreference = next
        if next == nil || next == "off" {
            notice = nil; activationGeneration &+= 1; openingGeneration = nil; opening = false
        }
    }

    /// No API calls, persistence writes, read receipts, or agent actions. Keep
    /// dedupe across reconnect/background transitions, bounded per connection.
    @discardableResult func receive(_ event: JSONValue) -> Bool {
        guard let next = NativeScheduledNotificationsContract.notice(event), remembered.insert(next.id).inserted else { return false }
        order.append(next.id)
        if order.count > Self.deduplicationLimit { remembered.remove(order.removeFirst()) }
        guard active, notificationPreference == "all" || notificationPreference == "approval-only" else { return false }
        notice = next; error = nil
        return true
    }

    func dismiss(_ id: NativeScheduledNoticeIdentity? = nil) {
        if id == nil || notice?.id == id { notice = nil }
    }
    func clearError() { error = nil }

    /// Explicit user navigation reads current ownership and deletion state. It
    /// never falls back to a cached graph if the GET failed or the scene changed.
    func target(for notice: NativeScheduledNotice) async -> NativeScheduledNotificationTarget? {
        guard active, !opening, remembered.contains(notice.id),
              notificationPreference == "all" || notificationPreference == "approval-only" else { return nil }
        let generation = activationGeneration, request = UUID()
        opening = true; openingGeneration = request; error = nil
        defer { if openingGeneration == request { opening = false; openingGeneration = nil } }
        do {
            let snapshot = try await api.request("/workspaces/\(MichiAPI.pathSegment(notice.workspaceID))")
            try Task.checkCancellation()
            guard active, activationGeneration == generation else { return nil }
            return try NativeScheduledNotificationsContract.target(for: notice, workspace: snapshot)
        } catch is CancellationError { return nil }
        catch {
            guard active, activationGeneration == generation else { return nil }
            self.error = "Couldn’t open the scheduled conversation. Refresh and try again."
            return nil
        }
    }
}
