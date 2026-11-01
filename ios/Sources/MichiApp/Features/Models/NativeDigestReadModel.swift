import Foundation
import Combine
import MichiCore

/// Opaque server ids compare byte for byte. Swift `==` on String uses canonical
/// equivalence, so an NFC and an NFD spelling of two ids would otherwise match.
private func digestReadExact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

/// A receipt changes only local read metadata, and only on the generation that
/// was actually visible. It must never replace content from a fresh snapshot.
struct NativeDigestReadReceipt: Equatable {
    let workspaceID: String
    let nodeID: String
    let generatedAt: Double
    let viewedAt: Double

    static func == (a: Self, b: Self) -> Bool {
        digestReadExact(a.workspaceID, b.workspaceID) && digestReadExact(a.nodeID, b.nodeID)
            && a.generatedAt == b.generatedAt && a.viewedAt == b.viewedAt
    }

    func applying(to node: JSONValue) -> JSONValue {
        guard digestReadExact(node.id, nodeID), digestReadExact(node["workspace_id"].stringValue, workspaceID),
              node["kind"] == "digest", node["deleted_at"].isNull, node["purged_at"].isNull,
              node["digest"].parsedJSON["status"] == "idle",
              node["digest"].parsedJSON["generatedAt"] == .number(generatedAt) else { return node }
        var result = node, digest = node["digest"].parsedJSON
        digest["viewedAt"] = .number(max(digest["viewedAt"].doubleValue, viewedAt))
        result["digest"] = node["digest"].optionalString == nil ? digest : .string(digest.prettyPrinted)
        return result
    }
}

/// What an explicit tap does for one unread generation.
enum NativeDigestReadAction: Equatable {
    /// Sends the marker. Not attempted in this session, or only blocked by a
    /// cached unsupported capability, which the tap reads again first.
    case mark
    /// The last send was refused by the server, so nothing was written; the
    /// tap sends the marker again.
    case retry
    /// An earlier send has an unknown outcome. The tap only reads the saved
    /// state and never sends the marker again.
    case check
}

/// The caller invokes this only for an on-screen, hydrated, idle digest, never
/// during generation/save or in a read-only workspace. The server independently
/// rechecks ownership/liveness/generation inside its transaction.
///
/// Automatic calls (on view) send at most one marker per generation per
/// session. A user-initiated call may also resend after a confirmed refusal and
/// re-read a cached unsupported capability. An unknown outcome is reconciled
/// with GET only, whoever calls.
@MainActor final class NativeDigestReadModel: ObservableObject {
    let api: MichiAPI
    let workspaceID: String
    @Published private(set) var marking = false
    @Published private(set) var notice: String?
    @Published private(set) var error: String?
    private let defaults: UserDefaults
    private var supported: Bool?
    private var attempted = Set<String>()
    /// Sent, then refused with a 4xx: known not written, so the user may resend.
    private var rejected = Set<String>()
    private var receipts: [String: NativeDigestReadReceipt] = [:]

    init(api: MichiAPI, workspaceID: String, defaults: UserDefaults = .standard) {
        self.api = api; self.workspaceID = workspaceID; self.defaults = defaults
    }

    /// What tapping Mark as read would do for this generation; nil when the
    /// digest is already read, unusable, or a tap would do nothing.
    func action(for node: JSONValue) -> NativeDigestReadAction? {
        guard let generation = Self.generation(node, workspaceID: workspaceID) else { return nil }
        let key = pendingKey(nodeID: node.id, generation: generation)
        guard receipts[key] == nil, Self.receipt(node: node, workspaceID: workspaceID, generation: generation) == nil else { return nil }
        if defaults.bool(forKey: key) { return .check }
        if rejected.contains(key) { return .retry }
        return attempted.contains(key) ? nil : .mark
    }

    @discardableResult func markViewed(node: JSONValue, userInitiated: Bool = false) async -> NativeDigestReadReceipt? {
        guard !marking, let generation = Self.generation(node, workspaceID: workspaceID) else { return nil }
        let key = pendingKey(nodeID: node.id, generation: generation)
        if let receipt = receipts[key] { return receipt }
        if let receipt = Self.receipt(node: node, workspaceID: workspaceID, generation: generation) {
            receipts[key] = receipt; rejected.remove(key); defaults.removeObject(forKey: key); return receipt
        }
        let unknown = defaults.bool(forKey: key)
        guard unknown || !attempted.contains(key) || (userInitiated && rejected.contains(key)) else { return nil }
        marking = true; defer { marking = false }
        error = nil; notice = nil
        // Persist before POST so closing the screen/app cannot turn an unknown
        // result into an automatic resubmission. Reopening only reconciles GET.
        if unknown {
            return await reconcile(nodeID: node.id, generation: generation, key: key)
        }
        var sent = false
        do {
            if supported == nil || (userInitiated && supported == false) {
                // A failed re-read keeps the cached answer; only a readable one replaces it.
                let capabilities = try await api.request("/persistence/capabilities")
                guard case .object = capabilities else { throw NativeFailure("Read marker capabilities could not be read.") }
                supported = capabilities["digestReadMarkers"] == "v1"
            }
            guard supported == true else {
                notice = "This backend cannot safely save digest read markers. The digest remains readable; after updating the backend, tap Mark as read to check again."
                return nil
            }
            try Task.checkCancellation()
            attempted.insert(key); rejected.remove(key); defaults.set(true, forKey: key); sent = true
            let value = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))/nodes/\(MichiAPI.pathSegment(node.id))/digest/viewed",
                                              method: "POST", body: ["generatedAt": .number(generation)])
            guard digestReadExact(value["workspaceId"].stringValue, workspaceID), digestReadExact(value["nodeId"].stringValue, node.id),
                  value["generatedAt"] == .number(generation),
                  let viewed = value["viewedAt"].featureOptionalNumber, viewed.isFinite, viewed >= generation, viewed > 0 else {
                throw NativeFailure("The read marker response could not be confirmed.")
            }
            let receipt = NativeDigestReadReceipt(workspaceID: workspaceID, nodeID: node.id, generatedAt: generation, viewedAt: viewed)
            receipts[key] = receipt; defaults.removeObject(forKey: key)
            return receipt
        } catch {
            if let failure = error as? MichiAPIError, let status = failure.statusCode, (400..<500).contains(status) {
                // The server answered and refused, so nothing was written.
                defaults.removeObject(forKey: key)
                if sent { rejected.insert(key) }
                self.error = failure.localizedDescription
                return nil
            }
            if sent { return await reconcile(nodeID: node.id, generation: generation, key: key) }
            if !(error is CancellationError) { self.error = error.localizedDescription }
            return nil
        }
    }

    private func reconcile(nodeID: String, generation: Double, key: String) async -> NativeDigestReadReceipt? {
        notice = "Read marker status is unconfirmed. Check read state reads the saved digest without sending the marker again."
        do {
            let graph = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))")
            guard digestReadExact(graph["workspace"].id, workspaceID), graph["workspace"]["deleted_at"].isNull,
                  graph["workspace"]["archived_at"].isNull, case .array(let nodes) = graph["nodes"],
                  nodes.filter({ digestReadExact($0.id, nodeID) }).count == 1,
                  let node = nodes.first(where: { digestReadExact($0.id, nodeID) }),
                  let currentGeneration = Self.generation(node, workspaceID: workspaceID) else {
                throw NativeFailure("The saved digest could not be read. Its previous content has been kept.")
            }
            guard currentGeneration == generation else {
                notice = "The digest changed. Open the current version to mark it read."
                // The old generation can no longer be marked; never resend it.
                if currentGeneration > generation { defaults.removeObject(forKey: key); attempted.insert(key) }
                return nil
            }
            guard let receipt = Self.receipt(node: node, workspaceID: workspaceID, generation: generation) else { return nil }
            receipts[key] = receipt; defaults.removeObject(forKey: key); notice = nil; error = nil
            return receipt
        } catch {
            if !(error is CancellationError) { self.error = error.localizedDescription }
            return nil
        }
    }

    private func pendingKey(nodeID: String, generation: Double) -> String {
        let scope = [api.baseURL.absoluteString, workspaceID, nodeID, String(generation)]
        let data = (try? JSONEncoder().encode(scope)) ?? Data()
        return "michi.digest-read.pending." + data.base64EncodedString()
    }
    private static func generation(_ node: JSONValue, workspaceID: String) -> Double? {
        guard !node.id.isEmpty, digestReadExact(node["workspace_id"].stringValue, workspaceID),
              node["kind"] == "digest", node["deleted_at"].isNull, node["purged_at"].isNull,
              node["digest"].parsedJSON["status"] == "idle",
              let value = node["digest"].parsedJSON["generatedAt"].featureOptionalNumber,
              value.isFinite, value >= 0, value <= 9_007_199_254_740_991, value.rounded(.towardZero) == value else { return nil }
        return value
    }
    private static func receipt(node: JSONValue, workspaceID: String, generation: Double) -> NativeDigestReadReceipt? {
        guard Self.generation(node, workspaceID: workspaceID) == generation,
              let viewed = node["digest"].parsedJSON["viewedAt"].featureOptionalNumber,
              viewed.isFinite, viewed >= generation, viewed > 0 else { return nil }
        return NativeDigestReadReceipt(workspaceID: workspaceID, nodeID: node.id, generatedAt: generation, viewedAt: viewed)
    }
}
