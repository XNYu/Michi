import Foundation
import Combine
import MichiCore

enum FeaturePageChangeAction: String, CaseIterable {
    case accept, dismiss, reopen, revert, redo
}

func featurePageChangesPath(
    _ pageId: String,
    afterSeq: Int? = nil,
    beforeSeq: Int? = nil,
    direction: String? = nil,
    limit: Int? = nil,
    proposalState: String? = nil,
    applicationState: String? = nil
) -> String {
    "/pages/\(FeatureAPI.segment(pageId))/changes" + FeatureAPI.query([
        ("afterSeq", afterSeq.map(String.init)),
        ("beforeSeq", beforeSeq.map(String.init)),
        ("direction", direction),
        ("limit", limit.map(String.init)),
        ("proposalState", proposalState),
        ("applicationState", applicationState),
    ])
}

func featurePageChangeActionPath(_ changeId: String, action: FeaturePageChangeAction) -> String {
    "/page-changes/\(FeatureAPI.segment(changeId))/\(action.rawValue)"
}

/// Local editor text for one FeaturePageChangeCard. Keyed by the model's
/// edit-session token so a cancelled or accepted draft on a duplicate card
/// cannot keep leftover text. Same-token onAppear keeps invalid draft text.
struct FeaturePageChangeDraftSession: Equatable {
    var token = UUID()
    var changeID = ""
    var text = ""
    var error: String?

    mutating func appear(token: UUID, changeID: String, modelText: String) {
        guard self.token != token else { return }
        begin(token: token, changeID: changeID, modelText: modelText)
    }

    mutating func begin(token: UUID, changeID: String, modelText: String) {
        self.token = token
        self.changeID = changeID
        text = modelText
        error = nil
    }

    mutating func discard() {
        token = UUID()
        changeID = ""
        text = ""
        error = nil
    }

    func visibleDraftText() -> String { text }
}

func featurePageDraftPayload(change: JSONValue, draft: JSONValue) throws -> JSONValue {
    let edited: JSONValue
    switch change["target"]["kind"].stringValue {
    case "block": edited = ["kind": "block", "block": draft]
    case "row":
        guard case .object(let fields) = draft else { throw NativeFailure("The proposed row must be an object.") }
        let allowed = Set(change["target"]["columnIds"].arrayValue.map(\.stringValue))
        guard Set(draft["values"].objectValue.keys).isSubset(of: allowed),
              draft.objectValue["body"] == nil || change["target"]["body"].boolValue else {
            throw NativeFailure("Edit only the fields included in this proposal.")
        }
        edited = .object(fields.merging(["kind": .string("row")]) { _, new in new })
    default: throw NativeFailure("This proposal does not support editing.")
    }
    try featureValidateEditedProposal(edited)
    return edited
}

func featurePageBatchPath(_ batchId: String) -> String {
    "/page-batches/\(FeatureAPI.segment(batchId))"
}

func featurePageBatchActionPath(_ batchId: String, action: String) -> String {
    "/page-batches/\(FeatureAPI.segment(batchId))/\(action)"
}

func featurePageChangeActionBody(action: FeaturePageChangeAction, editedContent: JSONValue? = nil) throws -> JSONValue {
    switch action {
    case .accept:
        if let editedContent {
            try featureValidateEditedProposal(editedContent)
            return ["editedContent": editedContent]
        }
        return [:]
    case .dismiss, .reopen, .revert, .redo:
        if editedContent != nil {
            throw FeatureRequestError(message: "Only accept can send edited proposal content.")
        }
        return [:]
    }
}

func featurePageChangeResult(_ payload: JSONValue, expectedId: String, action: FeaturePageChangeAction) throws -> JSONValue {
    let change = featureUnwrap(payload, "change")
    guard !change.id.isEmpty else {
        throw FeatureRequestError(message: "Pages returned an empty change response")
    }
    if !expectedId.isEmpty, change.id != expectedId {
        throw FeatureRequestError(message: "Pages returned a different change.")
    }
    switch action {
    case .accept:
        guard change["proposalState"].stringValue == "accepted" else {
            throw FeatureRequestError(message: "Pages did not accept this proposal.")
        }
    case .dismiss:
        guard change["proposalState"].stringValue == "dismissed" else {
            throw FeatureRequestError(message: "Pages did not dismiss this proposal.")
        }
    case .reopen:
        guard change["proposalState"].stringValue == "pending" else {
            throw FeatureRequestError(message: "Pages did not reopen this proposal.")
        }
    case .revert:
        guard change["applicationState"].stringValue == "reverted" else {
            throw FeatureRequestError(message: "Pages did not revert this change.")
        }
    case .redo:
        guard change["applicationState"].stringValue == "applied" else {
            throw FeatureRequestError(message: "Pages did not restore this change.")
        }
    }
    return change
}

func featureRequirePageBatchResult(_ payload: JSONValue, action: String) throws {
    let key = action == "revert" ? "reverted" : "redone"
    guard payload.objectValue[key] != nil else {
        throw FeatureRequestError(message: "Pages did not \(action) this batch.")
    }
    if payload[key].arrayValue.isEmpty, let message = payload["conflicts"].arrayValue.first?["message"].optionalString, !message.isEmpty {
        throw FeatureRequestError(message: message)
    }
}

func featureValidateEditedProposal(_ edited: JSONValue) throws {
    let kind = edited["kind"].stringValue
    let keys = Set(edited.objectValue.keys)
    switch kind {
    case "block":
        guard keys.isSubset(of: ["kind", "block", "content"]), !(edited.objectValue["block"] != nil && edited.objectValue["content"] != nil) else {
            throw FeatureRequestError(message: "Edited content does not match this proposal.")
        }
        let block = edited["block"].isNull ? edited["content"] : edited["block"]
        if block.isNull || block.objectValue.isEmpty {
            throw FeatureRequestError(message: "Invalid edited block content.")
        }
    case "row":
        guard keys.isSubset(of: ["kind", "values", "body"]), !edited["values"].isNull || edited.objectValue["body"] != nil else {
            throw FeatureRequestError(message: "Edited content does not match this proposal.")
        }
    case "view":
        guard keys.isSubset(of: ["kind", "config"]), case .object = edited["config"] else {
            throw FeatureRequestError(message: "Edited content does not match this proposal.")
        }
    default:
        throw FeatureRequestError(message: "Invalid edited proposal content.")
    }
}

func featurePageChangeEditedBlock(_ change: JSONValue) -> JSONValue? {
    guard change["target"]["kind"].stringValue == "block",
          change["forward"]["kind"].stringValue == "block",
          change["forward"]["op"].stringValue == "upsert"
    else { return nil }
    return featureBlockInput(from: change["forward"]["block"])
}

func featurePageChangeEditedRow(_ change: JSONValue) -> JSONValue? {
    guard change["target"]["kind"].stringValue == "row",
          change["forward"]["kind"].stringValue == "row",
          change["forward"]["op"].stringValue == "patch"
    else { return nil }
    let allowed = Set(change["target"]["columnIds"].arrayValue.map(\.stringValue).filter { !$0.isEmpty })
    let values = change["forward"]["values"].objectValue.filter { allowed.contains($0.key) }
    var row: [String: JSONValue] = ["values": .object(values)]
    if change["target"]["body"].boolValue, change["forward"].objectValue["body"] != nil {
        row["body"] = change["forward"]["body"]
    }
    return .object(row)
}

func featureIsPendingProposal(_ change: JSONValue) -> Bool {
    change["proposalState"].stringValue == "pending"
}

func featureIsDismissedProposal(_ change: JSONValue) -> Bool {
    change["proposalState"].stringValue == "dismissed"
}

func featureIsPageChangeRevertible(_ change: JSONValue) -> Bool {
    change["applicationState"].stringValue == "applied"
        && (change["proposalState"].isNull || change["proposalState"].stringValue == "accepted")
        && change["source"]["kind"].stringValue != "user"
}

func featureIsPageChangeRedoable(_ change: JSONValue) -> Bool {
    change["applicationState"].stringValue == "reverted"
        && (change["proposalState"].isNull || change["proposalState"].stringValue == "accepted")
        && change["source"]["kind"].stringValue != "user"
}

func featureCanEditProposal(_ change: JSONValue) -> Bool {
    let op = change["op"].stringValue
    if op == "delete" || op == "move" { return false }
    return featurePageChangeEditedBlock(change) != nil || featurePageChangeEditedRow(change) != nil
}

func featurePageChangePreview(_ change: JSONValue) -> JSONValue {
    var preview: [String: JSONValue] = [
        "id": change["id"],
        "seq": change["seq"],
        "op": change["op"],
        "proposalState": change["proposalState"],
        "applicationState": change["applicationState"],
        "target": change["target"],
        "before": change["before"],
        "after": change["after"],
    ]
    if let block = featurePageChangeEditedBlock(change) { preview["proposedBlock"] = block }
    if let row = featurePageChangeEditedRow(change) { preview["proposedRow"] = row }
    return .object(preview)
}

func featurePageChangeLabel(_ change: JSONValue) -> String {
    if featureIsPendingProposal(change) {
        switch change["op"].stringValue {
        case "schema": return "Suggested database configuration"
        case "delete": return "Suggested removal"
        case "move": return "Suggested move"
        default: return change["target"]["kind"].stringValue == "row" ? "Suggested field update" : "Suggested rewrite"
        }
    }
    if featureIsDismissedProposal(change) { return "Suggestion dismissed" }
    if change["applicationState"].stringValue == "reverted" { return "Undone" }
    if change["proposalState"].stringValue == "accepted" { return "You accepted this rewrite" }
    return change["source"]["kind"].stringValue == "user" ? "Page updated" : "Agent updated"
}

@MainActor
final class FeaturePageHistoryModel: ObservableObject {
    let api: MichiAPI
    let pageId: String
    let workspaceId: String

    @Published var changes: [JSONValue] = []
    @Published var pending: [JSONValue] = []
    @Published var hasMore = false
    @Published var nextAfter: Int?
    @Published var loading = false
    @Published var saving = false
    @Published var error: String?
    @Published var draftChangeId = ""
    @Published var draftContent: JSONValue = .null
    @Published var draftRevision = 0
    @Published private(set) var draftToken = UUID()

    init(api: MichiAPI, pageId: String, workspaceId: String) {
        self.api = api
        self.pageId = pageId
        self.workspaceId = workspaceId
    }

    var draftDirty: Bool {
        guard !draftChangeId.isEmpty, let current = changes.first(where: { $0.id == draftChangeId }) else { return false }
        return draftContent != featurePageChangeEditedBlock(current) && draftContent != featurePageChangeEditedRow(current)
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            async let history = FeatureAPI.get(api, featurePageChangesPath(pageId, direction: "backward", limit: 50))
            async let waiting = FeatureAPI.get(api, featurePageChangesPath(pageId, limit: 50, proposalState: "pending"))
            let loaded = try await history
            let proposals = try await waiting
            adopt(loaded["changes"].arrayValue, replacing: true)
            pending = proposals["changes"].arrayValue.filter(featureIsPendingProposal)
            hasMore = loaded["hasMore"].boolValue
            nextAfter = loaded["nextBefore"].featureOptionalNumber.map(Int.init)
                ?? loaded["nextAfter"].featureOptionalNumber.map(Int.init)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func loadOlder() async {
        guard hasMore, let nextAfter, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let loaded = try await FeatureAPI.get(
                api,
                featurePageChangesPath(pageId, beforeSeq: nextAfter, direction: "backward", limit: 50)
            )
            adopt(loaded["changes"].arrayValue, replacing: false)
            hasMore = loaded["hasMore"].boolValue
            self.nextAfter = loaded["nextBefore"].featureOptionalNumber.map(Int.init) ?? loaded["nextAfter"].featureOptionalNumber.map(Int.init)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func beginEdit(_ change: JSONValue) {
        guard featureCanEditProposal(change) else { return }
        draftChangeId = change.id
        draftContent = featurePageChangeEditedBlock(change) ?? featurePageChangeEditedRow(change) ?? .null
        draftRevision = change["baseRev"].intValue
        draftToken = UUID()
    }

    func discardEdit() {
        draftChangeId = ""
        draftContent = .null
        draftRevision = 0
        draftToken = UUID()
    }

    func accept(_ change: JSONValue, edited: JSONValue? = nil) async -> Bool {
        await send(change, action: .accept, edited: edited)
    }

    func acceptDraft(_ change: JSONValue) async -> Bool {
        guard draftChangeId == change.id else { return await accept(change) }
        do { return await send(change, action: .accept, edited: try featurePageDraftPayload(change: change, draft: draftContent)) }
        catch { self.error = error.localizedDescription; return false }
    }

    func dismiss(_ change: JSONValue) async -> Bool { await send(change, action: .dismiss) }
    func reopen(_ change: JSONValue) async -> Bool { await send(change, action: .reopen) }
    func revert(_ change: JSONValue) async -> Bool { await send(change, action: .revert) }
    func redo(_ change: JSONValue) async -> Bool { await send(change, action: .redo) }

    func revertBatch(_ batchId: String) async -> Bool {
        await mutate {
            let result = try await FeatureAPI.send(api, featurePageBatchActionPath(batchId, action: "revert"), method: "POST", body: [:])
            try featureRequirePageBatchResult(result, action: "revert")
            await refresh()
        }
    }

    func redoBatch(_ batchId: String) async -> Bool {
        await mutate {
            let result = try await FeatureAPI.send(api, featurePageBatchActionPath(batchId, action: "redo"), method: "POST", body: [:])
            try featureRequirePageBatchResult(result, action: "redo")
            await refresh()
        }
    }

    @discardableResult
    private func send(_ change: JSONValue, action: FeaturePageChangeAction, edited: JSONValue? = nil) async -> Bool {
        await mutate {
            let body = try featurePageChangeActionBody(action: action, editedContent: edited)
            let result = try await FeatureAPI.send(api, featurePageChangeActionPath(change.id, action: action), method: "POST", body: body)
            let updated = try featurePageChangeResult(result, expectedId: change.id, action: action)
            replace(updated)
            if draftChangeId == change.id { discardEdit() }
        }
    }

    private func adopt(_ incoming: [JSONValue], replacing: Bool) {
        if replacing {
            if draftDirty {
                let kept = changes.first { $0.id == draftChangeId }
                changes = incoming.map { item in
                    if item.id == draftChangeId, let kept { return kept }
                    return item
                }
                return
            }
            changes = incoming
            return
        }
        var seen = Set(changes.map(\.id))
        var next = changes
        for item in incoming where !seen.contains(item.id) {
            seen.insert(item.id)
            next.append(item)
        }
        changes = next
    }

    private func replace(_ updated: JSONValue) {
        guard !updated.id.isEmpty else { return }
        if let index = changes.firstIndex(where: { $0.id == updated.id }) {
            changes[index] = updated
        } else {
            changes.insert(updated, at: 0)
        }
        if let index = pending.firstIndex(where: { $0.id == updated.id }) {
            if featureIsPendingProposal(updated) {
                pending[index] = updated
            } else {
                pending.remove(at: index)
            }
        } else if featureIsPendingProposal(updated) {
            pending.insert(updated, at: 0)
        }
    }

    @discardableResult
    private func mutate(_ work: () async throws -> Void) async -> Bool {
        guard !saving else { return false }
        saving = true
        defer { saving = false }
        do {
            try await work()
            error = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
    }
}
