import Foundation
import Combine
import MichiCore

struct FeatureBlockSession {
    var id = ""
    var rev = 0
    var conflict: String?

    mutating func capture(_ block: JSONValue) {
        id = block.id
        rev = block["rev"].intValue
        conflict = nil
    }

    mutating func consider(_ block: JSONValue, dirty: Bool) -> Bool {
        if featureShouldReplaceBlockDraft(current: block, baselineId: id, baselineRev: rev, dirty: dirty) {
            capture(block)
            return true
        }
        conflict = featureBlockDraftConflict(current: block, baselineId: id, baselineRev: rev, dirty: dirty)
        return false
    }
}

func featureShouldReplaceBlockDraft(current: JSONValue, baselineId: String, baselineRev: Int, dirty: Bool) -> Bool {
    if baselineId.isEmpty { return true }
    if current.id != baselineId { return true }
    return !dirty
}

func featureBlockDraftConflict(current: JSONValue, baselineId: String, baselineRev: Int, dirty: Bool) -> String? {
    guard dirty, !baselineId.isEmpty, current.id == baselineId, current["rev"].intValue != baselineRev else { return nil }
    return "This block changed on the server. Your draft is kept."
}

func featureBlockUpdateOperation(id: String, expectRev: Int, input: JSONValue) -> JSONValue {
    [
        "op": "update",
        "id": .string(id),
        "block": input,
        "expectRev": .number(Double(expectRev)),
    ]
}

func featureBlockSymbol(_ type: String) -> String {
    switch type {
    case "heading": return "textformat.size"
    case "markdown": return "text.alignleft"
    case "callout": return "exclamationmark.bubble"
    case "checklist": return "checklist"
    case "database-ref": return "tablecells"
    case "page-link": return "link"
    case "task-view": return "checkmark.circle"
    default: return "square.on.square"
    }
}

@MainActor
final class FeaturePageModel: ObservableObject {
    let api: MichiAPI
    let pageId: String
    @Published var workspaceId: String
    @Published var page: JSONValue = .null
    @Published var title = ""
    @Published var blocks: [JSONValue] = []
    @Published var children: [JSONValue] = []
    @Published var databases: [JSONValue] = []
    @Published var taskDatabaseId: String?
    @Published var openedTaskId: String?
    @Published var pendingChanges: [JSONValue] = []
    @Published var loading = false
    @Published var saving = false
    @Published var error: String?
    @Published var confirmDelete = false
    @Published var openedHistory = false
    @Published private(set) var insertionRecoveryMessage: String?
    private let insertionJournal: NativeBlockInsertionJournal
    private var hydrated = false
    private var reviewedInsertionToken: String?
    private var titleBaseline: String?
    private var titleRevision = 0
    var titleDirty: Bool { titleBaseline.map { $0 != title } ?? false }

    init(api: MichiAPI, pageId: String, workspaceId: String, insertionJournal: NativeBlockInsertionJournal = NativeBlockInsertionJournal()) {
        self.api = api
        self.pageId = pageId
        self.workspaceId = workspaceId
        self.insertionJournal = insertionJournal
        reloadInsertionRecovery()
    }

    var revision: Int { page["revision"].intValue }

    func refresh() async {
        guard !loading else { return }
        loading = true
        hydrated = false
        reviewedInsertionToken = nil
        defer { loading = false }
        do {
            // A GET begun during the POST can return a pre-commit snapshot even
            // after the POST finishes. Only an already-inactive, unchanged
            // pending operation is eligible for explicit review acknowledgement.
            let pendingBeforeRead = try insertionJournal.load(api: api, pageID: pageId)
            let reviewEligible = pendingBeforeRead.map { !insertionJournal.isActive($0.token) } ?? false
            let loaded = try requireOwnedPage(try await FeatureAPI.get(api, "/pages/\(FeatureAPI.segment(pageId))"), minimumRevision: revision)
            apply(loaded)
            hydrated = true
            let pendingAfterRead = try insertionJournal.load(api: api, pageID: pageId)
            if reviewEligible, let pendingBeforeRead, pendingAfterRead == pendingBeforeRead,
               !insertionJournal.isActive(pendingBeforeRead.token) {
                reviewedInsertionToken = pendingBeforeRead.token
            }
            reloadInsertionRecovery()
            async let waiting = FeatureAPI.get(api, featurePageChangesPath(pageId, limit: 50, proposalState: "pending"))
            pendingChanges = (try await waiting)["changes"].arrayValue.filter(featureIsPendingProposal)
            if !workspaceId.isEmpty {
                async let childList = FeatureAPI.get(api, "/workspaces/\(FeatureAPI.segment(workspaceId))/pages?parentId=\(FeatureAPI.segment(pageId))")
                async let databaseList = FeatureAPI.get(api, "/workspaces/\(FeatureAPI.segment(workspaceId))/databases")
                async let task = FeatureAPI.get(api, "/workspaces/\(FeatureAPI.segment(workspaceId))/task-database")
                children = featureItems(try await childList)
                databases = featureItems(try await databaseList)
                taskDatabaseId = (try await task)["databaseId"].optionalString
            }
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func saveTitle() async {
        let next = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !saving, !next.isEmpty, revision > 0 else { return }
        let expected = titleRevision
        await mutate {
            let result = try await FeatureAPI.send(
                api,
                "/pages/\(FeatureAPI.segment(pageId))",
                method: "PATCH",
                body: ["revision": .number(Double(expected)), "title": .string(next)]
            )
            let loaded = try requireOwnedPage(result, minimumRevision: expected)
            titleBaseline = nil
            apply(loaded)
        }
    }

    func updateBlock(id: String, expectRev: Int, input: JSONValue) async -> Bool {
        guard !id.isEmpty else { return false }
        return await applyOps([featureBlockUpdateOperation(id: id, expectRev: expectRev, input: input)])
    }

    func deleteBlock(id: String) async {
        guard let current = blocks.first(where: { $0.id == id }) else { return }
        await applyOps([[
            "op": "delete",
            "id": .string(id),
            "expectRev": .number(Double(current["rev"].intValue)),
        ]])
    }

    func insertBlock(type: String) async {
        var block: JSONValue
        switch type {
        case "heading":
            block = ["type": "heading", "text": .string("Heading")]
        case "callout":
            block = ["type": "callout", "text": .string(""), "tone": "info"]
        case "checklist":
            block = ["type": "checklist", "items": .array([["text": .string("Item"), "done": false]])]
        default:
            block = ["type": "markdown", "text": .string("")]
        }
        _ = await insertBlock(input: block)
    }

    /// Accepts content only; server identity/revision is assigned atomically by /edits.
    @discardableResult
    func insertBlock(input: JSONValue) async -> Bool {
        guard !saving, !loading, hydrated, revision > 0 else {
            error = "Reload this page successfully before adding a block."
            return false
        }
        reloadInsertionRecovery()
        guard insertionRecoveryMessage == nil else { error = insertionRecoveryMessage; return false }
        do { try NativeBlockCatalog().validate(input) }
        catch { self.error = featureErrorMessage(error); return false }
        return await applyOps([["op": "insert", "block": input, "after": blocks.last.map { .string($0.id) } ?? .null]])
    }

    /// Explicit acknowledgement after inspecting a fresh page. Never resubmits.
    @discardableResult
    func resolveUnknownInsertionAfterReview() -> Bool {
        guard !saving, !loading, hydrated else { return false }
        do {
            guard let pending = try insertionJournal.load(api: api, pageID: pageId), reviewedInsertionToken == pending.token else {
                error = "Reload and inspect the page before resolving this insertion."
                return false
            }
            try insertionJournal.clear(pending, api: api, pageID: pageId, requireInactive: true)
            reviewedInsertionToken = nil
            reloadInsertionRecovery()
            error = nil
            return true
        } catch { self.error = featureErrorMessage(error); return false }
    }

    private func reloadInsertionRecovery() {
        do {
            insertionRecoveryMessage = try insertionJournal.load(api: api, pageID: pageId) == nil ? nil
                : "An earlier block insertion may have completed. Reload and inspect the page before adding more blocks. It will not be resent automatically."
        } catch { insertionRecoveryMessage = "The saved insertion could not be verified. New insertions remain blocked. " + featureErrorMessage(error) }
    }

    func moveBlocks(from source: IndexSet, to destination: Int) async {
        guard let from = source.first, blocks.indices.contains(from) else { return }
        var ordered = blocks
        let item = ordered.remove(at: from)
        let dest = destination > from ? destination - 1 : destination
        ordered.insert(item, at: min(dest, ordered.count))
        let after = dest == 0 ? nil : ordered[dest - 1].id
        var op: [String: JSONValue] = [
            "op": "move",
            "id": .string(item.id),
            "expectRev": .number(Double(item["rev"].intValue)),
        ]
        op["after"] = after.map { .string($0) } ?? .null
        await applyOps([.object(op)])
    }

    func createChild(title: String) async -> JSONValue? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var created: JSONValue?
        await mutate {
            created = try featureRequirePage(try await FeatureAPI.send(
                api,
                "/workspaces/\(FeatureAPI.segment(workspaceId))/pages",
                method: "POST",
                body: ["title": .string(trimmed), "parentId": .string(pageId)]
            ))
            await refresh()
        }
        return created
    }

    func openTasks() async {
        await mutate {
            let opened = try await FeatureAPI.send(
                api,
                "/workspaces/\(FeatureAPI.segment(workspaceId))/task-database",
                method: "POST",
                body: [:]
            )
            let database = try featureRequireDatabase(opened)
            taskDatabaseId = database.id
            openedTaskId = database.id
            await refresh()
        }
    }

    func deletePage() async -> Bool {
        var ok = false
        await mutate {
            let result = try await FeatureAPI.send(api, "/pages/\(FeatureAPI.segment(pageId))", method: "DELETE", body: [:])
            guard !result["deletionGroupId"].stringValue.isEmpty else {
                throw FeatureRequestError(message: "Pages did not delete this page.")
            }
            ok = true
        }
        return ok
    }

    func restorePage() async -> Bool {
        await mutate {
            let result = try await FeatureAPI.send(api, featurePageRestorePath(pageId), method: "POST", body: [:])
            try featureRequireRestoredPageIds(result, pageId: pageId)
            await refresh()
        }
    }

    @discardableResult
    private func applyOps(_ ops: [JSONValue]) async -> Bool {
        guard !saving, !loading, hydrated, revision > 0 else { return false }
        let expected = revision
        let expectedWorkspace = workspaceId
        let body: JSONValue = ["revision": .number(Double(expected)), "ops": .array(ops)]
        let insertion = ops.first?["op"] == "insert" ? NativeBlockInsertion(token: UUID().uuidString, workspaceID: workspaceId, body: body) : nil
        let previousIDs = Set(blocks.map(\.id))
        let succeeded = await mutate {
            if let insertion {
                try insertionJournal.reserve(insertion, api: api, pageID: pageId)
                reviewedInsertionToken = nil
            }
            defer { if let insertion { insertionJournal.finish(insertion) } }
            do {
                let result = try await FeatureAPI.send(api, "/pages/\(FeatureAPI.segment(pageId))/edits", method: "POST", body: body)
                if let first = result["changes"]["rejected"].arrayValue.first {
                    throw FeatureRequestError(message: first["message"].optionalString ?? "Revision conflict. Reload and try again.")
                }
                let loaded = try requireOwnedPage(result, minimumRevision: insertion == nil ? expected : expected + 1)
                guard expectedWorkspace.isEmpty || loaded["workspaceId"].stringValue == expectedWorkspace else {
                    throw FeatureRequestError(message: "The returned page belongs to another workspace. Reload before continuing.")
                }
                if let insertion {
                    let additions = loaded["blocks"].arrayValue.filter { !previousIDs.contains($0.id) }
                    guard additions.contains(where: { featureBlockInput(from: $0) == ops.first?["block"] }) else {
                        throw FeatureRequestError(message: "The response did not confirm the inserted block. Reload and inspect this page.")
                    }
                    try insertionJournal.clear(insertion, api: api, pageID: pageId)
                }
                if loaded["revision"].intValue >= revision { apply(loaded) }
                reloadInsertionRecovery()
            } catch {
                // These exact errors are raised before any write by userEdit's transaction.
                if let insertion, let failure = error as? MichiAPIError,
                   (failure.statusCode == 409 && failure.code == "stale_revision") || (failure.statusCode == 400 && failure.code == "invalid") {
                    try insertionJournal.clear(insertion, api: api, pageID: pageId)
                }
                reloadInsertionRecovery()
                throw error
            }
        }
        if !succeeded { reviewedInsertionToken = nil }
        return succeeded
    }

    private func requireOwnedPage(_ payload: JSONValue, minimumRevision: Int) throws -> JSONValue {
        let loaded = try featureRequirePage(payload)
        guard loaded.id == pageId, case .number(let value) = loaded["revision"], value.rounded(.towardZero) == value,
              value <= 9_007_199_254_740_991, loaded["revision"].intValue >= max(1, minimumRevision),
              case .array(let loadedBlocks) = loaded["blocks"],
              loadedBlocks.allSatisfy({ !$0.id.isEmpty }), Set(loadedBlocks.map(\.id)).count == loadedBlocks.count else {
            throw FeatureRequestError(message: "The server returned a different or malformed page. Existing content was kept.")
        }
        return loaded
    }

    func discardTitleChanges() {
        title = page["title"].stringValue; titleBaseline = title; titleRevision = revision
    }

    private func apply(_ loaded: JSONValue) {
        if !titleDirty {
            title = loaded["title"].stringValue
            titleBaseline = title; titleRevision = loaded["revision"].intValue
        }
        page = loaded
        blocks = loaded["blocks"].arrayValue
        if !loaded["workspaceId"].stringValue.isEmpty { workspaceId = loaded["workspaceId"].stringValue }
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
