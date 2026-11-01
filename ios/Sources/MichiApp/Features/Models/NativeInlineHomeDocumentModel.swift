import Foundation
import Combine
import MichiCore

/// Navigation from an inline Home page. Root opens these with existing
/// page/conversation/database screens — this model does not nest stacks.
/// Workspace is the confirmed Home page workspace, not the chat picker.
enum NativeInlineHomeDestination: Hashable {
    case page(id: String, workspaceID: String)
    case thread(id: String, workspaceID: String)
    case database(id: String, viewID: String?, workspaceID: String)
    case tasks(viewID: String?, workspaceID: String)
    case file(path: String, workspaceID: String)
    case prompt(String)
    case component(id: String, version: String?, workspaceID: String)
}

enum NativeInlineHomeContract {
    static let loadingMessage = "Loading Home content…"
    static let unavailableMessage = "Your Home page is unavailable. Ask the agent to choose another page or restore the default Home."
    static let cannotRenderMessage = "This Home page cannot be rendered here. Open the page in Pages to view or edit it."
    static let unsupportedCustomMessage = "Custom HTML/JS cannot run here."
    static let openPageTitle = "Open Home page"
    static let retryTitle = "Retry"
    static let unconfirmedReadMessage = "The Home page could not be confirmed. Your last preview is kept."
    static let unknownWriteMessage = "The page change outcome is unknown. Refresh Home and check before trying again; it will not be sent again automatically."

    static func workspaceID(from page: JSONValue) -> String? {
        page["workspaceId"].optionalString.flatMap { $0.isEmpty ? nil : $0 }
    }

    static func title(from page: JSONValue) -> String? {
        page["title"].optionalString.flatMap { $0.isEmpty ? nil : $0 }
    }

    static func visibleBlocks(in page: JSONValue) -> [JSONValue] {
        page["blocks"].arrayValue.filter(RichPageBlockModel.isMainContent)
    }

    static func hasUnsupportedCustom(in page: JSONValue) -> Bool {
        page["blocks"].arrayValue.contains(where: featureIsUnsupportedCustomBlock)
    }

    static func blockAnchorID(_ block: JSONValue, index: Int) -> String {
        let id = block.id
        return id.isEmpty ? "home-inline-block-\(index)-\(block["type"].stringValue)" : id
    }

    static func pagePath(_ pageId: String) throws -> String {
        try HomeCardsContract.pagePath(pageId)
    }

    static func editPath(_ pageId: String) throws -> String {
        guard !pageId.isEmpty else { throw NativeFailure("This Home page has no identity.") }
        return "/pages/\(MichiAPI.pathSegment(pageId))/edits"
    }

    static func editBody(revision: Int, ops: [JSONValue]) -> JSONValue {
        ["revision": .number(Double(revision)), "ops": .array(ops)]
    }

    /// Finite whole number ≥ 1. Rejects fractions, NaN/Inf, and `intValue` fallbacks.
    static func positiveInt(_ value: JSONValue) -> Int? {
        guard let number = value.featureOptionalNumber, number.isFinite, number >= 1, number < Double(Int.max) else { return nil }
        let whole = number.rounded(.towardZero)
        guard number == whole else { return nil }
        return Int(whole)
    }

    static func validateBlocks(_ value: JSONValue) throws {
        guard case .array(let blocks) = value else {
            throw NativeFailure("The Home page did not return its blocks.")
        }
        var seen = Set<String>()
        for block in blocks {
            guard case .object = block else { throw NativeFailure("The Home page has an invalid block.") }
            let id = block["id"].optionalString ?? ""
            guard !id.isEmpty, seen.insert(id).inserted else {
                throw NativeFailure("The Home page has an invalid block identity.")
            }
            if block.objectValue["rev"] != nil, positiveInt(block["rev"]) == nil {
                throw NativeFailure("The Home page has an invalid block revision.")
            }
        }
    }

    /// GET `/pages/:id` or an edits receipt. Identity, workspace, a positive
    /// whole revision and a real blocks array are required. Unknown keys stay.
    static func ownedPage(_ value: JSONValue, expectedID: String) throws -> JSONValue {
        let page = featureUnwrap(value, "page")
        guard page.id == expectedID, !page.id.isEmpty else {
            throw NativeFailure("The Home page is no longer available.")
        }
        guard workspaceID(from: page) != nil else {
            throw NativeFailure("The Home page is no longer available.")
        }
        guard positiveInt(page["revision"]) != nil else {
            throw NativeFailure("The Home page did not return a saved revision.")
        }
        try validateBlocks(page["blocks"])
        return page
    }

    static func savedPage(_ value: JSONValue, expectedID: String) throws -> JSONValue {
        try ownedPage(value, expectedID: expectedID)
    }
}

struct NativeInlineHomeVisibleBlock: Identifiable, Equatable {
    let id: String
    let block: JSONValue
}

/// Live document for Chat Home when `contentMode` is `page`.
///
/// Cards GET may supply the initial `PageDto`. That preview is read-only until
/// GET `/pages/:id` confirms ownership and revision — the same barrier as web
/// `useHomeDocument` (`readOnly` until the page hook is ready). Writes use
/// `POST /pages/:id/edits` with the page revision and each block's `expectRev`.
@MainActor
final class NativeInlineHomeDocumentModel: ObservableObject {
    let api: MichiAPI
    @Published private(set) var expectedID: String
    @Published private(set) var workspaceID: String
    @Published private(set) var page: JSONValue = .null
    @Published private(set) var liveOwned = false
    @Published private(set) var loading = false
    @Published private(set) var stale = false
    @Published private(set) var saving = false
    @Published private(set) var unknownWrite = false
    @Published var error: String?
    private var loadGeneration = UUID()
    private var writeGeneration = UUID()

    init(api: MichiAPI, pageID: String, workspaceID: String? = nil, initial: JSONValue = .null) {
        self.api = api
        self.expectedID = pageID
        self.workspaceID = workspaceID ?? NativeInlineHomeContract.workspaceID(from: initial) ?? ""
        applyInitial(initial)
    }

    var revision: Int { NativeInlineHomeContract.positiveInt(page["revision"]) ?? 0 }
    var title: String { page["title"].stringValue }
    var blocks: [JSONValue] { page["blocks"].arrayValue }
    var visibleBlocks: [JSONValue] { NativeInlineHomeContract.visibleBlocks(in: page) }
    var visibleBlockItems: [NativeInlineHomeVisibleBlock] {
        visibleBlocks.enumerated().map { index, block in
            NativeInlineHomeVisibleBlock(id: NativeInlineHomeContract.blockAnchorID(block, index: index), block: block)
        }
    }
    var hasPreview: Bool { page.id == expectedID && !page.id.isEmpty }
    var showsLoading: Bool { loading && !hasPreview }
    var canRender: Bool { hasPreview }
    var hasUnsupportedCustom: Bool { NativeInlineHomeContract.hasUnsupportedCustom(in: page) }
    var readOnly: Bool { !liveOwned || stale || unknownWrite || revision <= 0 || saving }
    var canOpenPage: Bool { !expectedID.isEmpty && (!workspaceID.isEmpty || hasPreview) }
    var needsOpenPageFallback: Bool {
        !expectedID.isEmpty && (!canRender || !liveOwned || hasUnsupportedCustom || error != nil || stale || unknownWrite)
    }
    var canRetryLiveRefresh: Bool {
        !expectedID.isEmpty && !loading && (error != nil || unknownWrite || stale)
    }

    var statusMessage: String? {
        if expectedID.isEmpty { return NativeInlineHomeContract.unavailableMessage }
        if showsLoading { return nil }
        if !canRender { return error ?? NativeInlineHomeContract.cannotRenderMessage }
        return error
    }

    var unsupportedCustomMessage: String? {
        hasUnsupportedCustom ? NativeInlineHomeContract.unsupportedCustomMessage : nil
    }

    func pageComponentOwnership(api: MichiAPI) -> NativePageComponentOwnership {
        NativePageComponentOwnership(
            connectionIdentity: api.baseURL.absoluteString,
            credentialIdentity: api.credentialIdentityFingerprint,
            workspaceID: workspaceID,
            pageID: page.id,
            expectedID: expectedID,
            title: title,
            revision: revision,
            readOnly: readOnly,
            available: liveOwned
                && NativePageComponentContract.exact(page.id, expectedID)
                && !workspaceID.isEmpty
                && revision > 0
        )
    }

    func pageDestination(_ pageID: String) -> NativeInlineHomeDestination? {
        guard !pageID.isEmpty, let workspace = destinationWorkspace else { return nil }
        return .page(id: pageID, workspaceID: workspace)
    }

    func threadDestination(_ nodeID: String) -> NativeInlineHomeDestination? {
        guard !nodeID.isEmpty, let workspace = destinationWorkspace else { return nil }
        return .thread(id: nodeID, workspaceID: workspace)
    }

    func databaseDestination(id: String, viewID: String?) -> NativeInlineHomeDestination? {
        guard !id.isEmpty, let workspace = destinationWorkspace else { return nil }
        return .database(id: id, viewID: viewID, workspaceID: workspace)
    }

    func tasksDestination(viewID: String?) -> NativeInlineHomeDestination? {
        guard let workspace = destinationWorkspace else { return nil }
        return .tasks(viewID: viewID, workspaceID: workspace)
    }

    func fileDestination(path: String) -> NativeInlineHomeDestination? {
        guard !path.isEmpty, let workspace = destinationWorkspace else { return nil }
        return .file(path: path, workspaceID: workspace)
    }

    func componentDestination(id: String, version: String?) -> NativeInlineHomeDestination? {
        guard !id.isEmpty, let workspace = destinationWorkspace else { return nil }
        return .component(id: id, version: version, workspaceID: workspace)
    }

    private var destinationWorkspace: String? {
        workspaceID.isEmpty ? nil : workspaceID
    }

    func bind(pageID: String, workspaceID: String?, initial: JSONValue) async {
        if pageID != expectedID {
            loadGeneration = UUID()
            writeGeneration = UUID()
            expectedID = pageID
            self.workspaceID = workspaceID ?? NativeInlineHomeContract.workspaceID(from: initial) ?? ""
            liveOwned = false
            stale = false
            unknownWrite = false
            error = nil
            page = .null
            saving = false
            applyInitial(initial)
        } else {
            if let workspaceID, !workspaceID.isEmpty, self.workspaceID.isEmpty, !unknownWrite {
                self.workspaceID = workspaceID
            }
            if !liveOwned, !unknownWrite, !stale { applyInitial(initial) }
        }
        await refresh()
    }

    /// Cards refresh may replace the preview only before a live GET or unknown
    /// write. It must not clear an edit lock or a failed confirmation.
    func adoptCardsPage(_ value: JSONValue) {
        guard !liveOwned, !unknownWrite, !stale else { return }
        applyInitial(value)
    }

    func refresh() async {
        guard !expectedID.isEmpty else { return }
        let pageID = expectedID
        let generation = loadGeneration
        loading = true
        defer { if generation == loadGeneration { loading = false } }
        do {
            let path = try NativeInlineHomeContract.pagePath(pageID)
            let result = try await api.request(path)
            guard generation == loadGeneration, expectedID == pageID else { return }
            applyLive(try NativeInlineHomeContract.ownedPage(result, expectedID: pageID))
            unknownWrite = false
            error = nil
        } catch is CancellationError {
            guard generation == loadGeneration, expectedID == pageID else { return }
            failClosed(NativeInlineHomeContract.unconfirmedReadMessage)
        } catch {
            guard generation == loadGeneration, expectedID == pageID else { return }
            failClosed(error.localizedDescription)
        }
    }

    @discardableResult
    func updateBlock(id: String, expectRev: Int, input: JSONValue) async -> Bool {
        let pageID = expectedID
        let expectedRevision = revision
        guard !readOnly, !id.isEmpty, expectedRevision > 0, page.id == pageID, expectRev > 0 else { return false }
        let generation = writeGeneration
        saving = true
        defer { if writeGeneration == generation { saving = false } }
        do {
            let path = try NativeInlineHomeContract.editPath(pageID)
            let body = NativeInlineHomeContract.editBody(
                revision: expectedRevision,
                ops: [featureBlockUpdateOperation(id: id, expectRev: expectRev, input: input)]
            )
            let result = try await api.request(path, method: "POST", body: body)
            guard writeGeneration == generation, expectedID == pageID else { return false }
            let rejected = result["changes"]["rejected"].arrayValue
            if let first = rejected.first {
                stale = true
                liveOwned = false
                throw NativeFailure(first["message"].optionalString ?? "Revision conflict. Reload and try again.")
            }
            applyLive(try NativeInlineHomeContract.savedPage(result, expectedID: pageID))
            unknownWrite = false
            error = nil
            return true
        } catch is CancellationError {
            guard writeGeneration == generation, expectedID == pageID else { return false }
            lockUnknownWrite()
            return false
        } catch let failure as MichiAPIError where failure.statusCode == 409 {
            guard writeGeneration == generation, expectedID == pageID else { return false }
            stale = true
            liveOwned = false
            self.error = failure.localizedDescription
            await refresh()
            return false
        } catch let failure as MichiAPIError where failure.statusCode == nil || (failure.statusCode ?? 0) >= 500 {
            guard writeGeneration == generation, expectedID == pageID else { return false }
            lockUnknownWrite()
            return false
        } catch {
            guard writeGeneration == generation, expectedID == pageID else { return false }
            lockUnknownWrite(error.localizedDescription)
            return false
        }
    }

    private func applyInitial(_ value: JSONValue) {
        guard case .object = value, value.id == expectedID, !value.id.isEmpty else { return }
        page = value
        if let workspace = NativeInlineHomeContract.workspaceID(from: value), !unknownWrite {
            workspaceID = workspace
        }
        liveOwned = false
    }

    private func applyLive(_ owned: JSONValue) {
        page = owned
        if let workspace = NativeInlineHomeContract.workspaceID(from: owned) {
            workspaceID = workspace
        }
        liveOwned = (NativeInlineHomeContract.positiveInt(owned["revision"]) ?? 0) > 0
        stale = false
    }

    private func failClosed(_ message: String) {
        liveOwned = false
        stale = true
        error = message
    }

    private func lockUnknownWrite(_ message: String = NativeInlineHomeContract.unknownWriteMessage) {
        unknownWrite = true
        stale = true
        liveOwned = false
        error = message
    }
}
