import Foundation
import Combine
import MichiCore

struct HomeCardRecord: Equatable, Identifiable {
    enum Origin: Equatable {
        case recommendation
        case onboardingCompose
        case onboardingMention
        case onboardingSpaces
    }

    let id: String
    let kind: String
    let label: String
    let title: String
    let reason: String
    let buttonText: String
    let prompt: String
    let workspaceID: String?
    let sourceWorkspaceID: String?
    let sourcePageID: String?
    let sourceThreadNodeID: String?
    let origin: Origin
}

struct HomeGreetingRecord: Equatable {
    let text: String
    let detail: String?
}

struct HomeCardsSnapshot: Equatable {
    var contentMode = "default"
    var contentPageID: String?
    var contentPageWorkspaceID: String?
    var contentPageTitle: String?
    /// Full `PageDto` from `/home/cards` when `contentMode` is `page`. Unknown
    /// keys stay intact so inline Home can render without inventing a page GET
    /// during the cards read.
    var contentPage: JSONValue = .null
    var cardsCustomized = false
    var greeting: HomeGreetingRecord?
    var sets: [[HomeCardRecord]] = []
    var generatedAt: Double?
    var inputFingerprint: String?

    static let empty = HomeCardsSnapshot()
}

/// One user click, delivered together. `sends` is always false: a card never
/// submits the prompt. Root should apply destination and prompt atomically and
/// leave any existing composer draft until this result is handled.
struct HomeCardPickResult: Equatable {
    enum Kind: Equatable {
        case recommendation
        case compose
        case mention
        case pagesHome
        case contentPage
    }

    var kind: Kind = .recommendation
    var cardID: String?
    var prompt: String?
    /// Known live workspace for the composer or an existing thread. Set for
    /// workspace-only cards so root does not insert into an unrelated workspace.
    var workspaceID: String?
    var nodeID: String?
    var startMention = false
    var openPagesHome = false
    var contentPageID: String?
    var contentPageWorkspaceID: String?
    var unsupported: String?
    var usedConfirmed = false
    var usedUnknown = false
    var sends = false
}

typealias HomeCardPick = HomeCardPickResult

enum HomeCardsFormat {
    static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    static func eyebrow(now: Date = Date(), calendar: Calendar = .current) -> String {
        let weekday = calendar.component(.weekday, from: now)
        let month = calendar.component(.month, from: now)
        let day = calendar.component(.day, from: now)
        guard weekdays.indices.contains(weekday - 1), months.indices.contains(month - 1) else { return "" }
        return "\(weekdays[weekday - 1]), \(months[month - 1]) \(day)"
    }
}

enum HomeCardsContract {
    static let kinds: Set<String> = ["continue", "try", "from-space", "review", "stalled", "discover", "tip"]
    static let contentModes: Set<String> = ["default", "page", "hidden"]
    static let maxSets = 8
    static let maxCardsPerSet = 6
    static let maxTipsPerSet = 1
    static let maxID = 200
    static let maxLabel = 80
    static let maxTitle = 200
    static let maxReason = 500
    static let maxButton = 40
    static let maxPrompt = 4000
    static let maxGreeting = 300
    static let maxFingerprint = 200

    static let onboardingCards: [HomeCardRecord] = [
        HomeCardRecord(
            id: "onboarding:conversation", kind: "continue", label: "Get started · Chat",
            title: "Start a conversation",
            reason: "Ask anything. Michi starts a thread in the workspace shown under the box.",
            buttonText: "Write one", prompt: "Help me plan what to work on today.",
            workspaceID: nil, sourceWorkspaceID: nil, sourcePageID: nil, sourceThreadNodeID: nil,
            origin: .onboardingCompose
        ),
        HomeCardRecord(
            id: "onboarding:branch", kind: "try", label: "Worth a try · Branches",
            title: "Try branching",
            reason: "After a reply, branch a follow-up into its own pane and try two directions side by side.",
            buttonText: "Try it", prompt: "Give me two different ways to approach my next task, so I can branch and try both.",
            workspaceID: nil, sourceWorkspaceID: nil, sourcePageID: nil, sourceThreadNodeID: nil,
            origin: .onboardingCompose
        ),
        HomeCardRecord(
            id: "onboarding:mention", kind: "tip", label: "Tip",
            title: "@ a page",
            reason: "Type @ in the box to bring a page, a file or an earlier reply into the conversation.",
            buttonText: "Type @", prompt: "",
            workspaceID: nil, sourceWorkspaceID: nil, sourcePageID: nil, sourceThreadNodeID: nil,
            origin: .onboardingMention
        ),
        HomeCardRecord(
            id: "onboarding:spaces", kind: "from-space", label: "Pages",
            title: "Open Pages",
            reason: "Pages keeps a home page for each workspace, written from your conversations.",
            buttonText: "Open Pages", prompt: "",
            workspaceID: nil, sourceWorkspaceID: nil, sourcePageID: nil, sourceThreadNodeID: nil,
            origin: .onboardingSpaces
        ),
    ]

    static func parse(_ value: JSONValue) throws -> HomeCardsSnapshot {
        guard case .object = value else { throw NativeFailure("Home cards could not be read.") }
        var snapshot = HomeCardsSnapshot()
        snapshot.contentMode = try contentMode(value["contentMode"], present: value.objectValue["contentMode"] != nil)
        if let page = try contentPage(value["contentPage"], present: value.objectValue["contentPage"] != nil) {
            snapshot.contentPage = page
            snapshot.contentPageID = page.id
            snapshot.contentPageWorkspaceID = NativeInlineHomeContract.workspaceID(from: page)
            snapshot.contentPageTitle = NativeInlineHomeContract.title(from: page)
        }
        snapshot.cardsCustomized = try flag(value["cardsCustomized"], present: value.objectValue["cardsCustomized"] != nil, name: "cardsCustomized")
        snapshot.greeting = try greeting(value["greeting"], present: value.objectValue["greeting"] != nil)
        snapshot.sets = try sets(value["sets"])
        snapshot.generatedAt = try timestamp(value["generatedAt"], present: value.objectValue["generatedAt"] != nil, name: "generatedAt")
        snapshot.inputFingerprint = try fingerprint(value["inputFingerprint"], present: value.objectValue["inputFingerprint"] != nil)
        return snapshot
    }

    static func parseUsed(_ value: JSONValue, expectedID: String) throws -> (cardId: String, usedAt: Double) {
        let cardId = value["cardId"].stringValue
        guard cardId == expectedID, !cardId.isEmpty, cardId.count <= maxID,
              let usedAt = value["usedAt"].featureOptionalNumber, usedAt.isFinite, usedAt >= 0 else {
            throw NativeFailure("The backend did not confirm this Home card as used.")
        }
        return (cardId, usedAt)
    }

    static func usedPath(_ cardId: String) throws -> String {
        guard !cardId.isEmpty, cardId.count <= maxID else {
            throw NativeFailure("This Home card cannot be marked used.")
        }
        return "/home/cards/\(MichiAPI.pathSegment(cardId))/used"
    }

    static func pagePath(_ pageId: String) throws -> String {
        guard !pageId.isEmpty else { throw NativeFailure("This Home page has no identity.") }
        return "/pages/\(MichiAPI.pathSegment(pageId))"
    }

    /// GET `/pages/:pageId` returns the `PageDto` (sometimes wrapped as `{page}`).
    static func ownedPage(_ value: JSONValue, expectedID: String) throws -> (id: String, workspaceID: String) {
        let page = featureUnwrap(value, "page")
        let workspaceID = page["workspaceId"].stringValue
        guard page.id == expectedID, !page.id.isEmpty, !workspaceID.isEmpty else {
            throw NativeFailure("The Home page is no longer available.")
        }
        return (page.id, workspaceID)
    }

    /// Web `selectProject` uses `card.workspaceId` when it is one of the user's
    /// live workspaces. A thread is opened only when `source.threadNodeId` is
    /// also present. `workspaceId: null` leaves the current composer workspace.
    static func pickDestination(_ card: HomeCardRecord, workspaceIDs: Set<String>) -> (workspaceID: String?, nodeID: String?) {
        let composer = known(card.workspaceID, in: workspaceIDs)
        let source = known(card.sourceWorkspaceID, in: workspaceIDs)
        let node = card.sourceThreadNodeID.flatMap { $0.isEmpty ? nil : $0 }
        if let node {
            let workspace = composer ?? source
            return (workspace, workspace == nil ? nil : node)
        }
        return (composer, nil)
    }

    private static func known(_ id: String?, in workspaceIDs: Set<String>) -> String? {
        guard let id, !id.isEmpty, workspaceIDs.contains(id) else { return nil }
        return id
    }

    private static func contentMode(_ value: JSONValue, present: Bool) throws -> String {
        if !present || value.isNull { return "default" }
        guard let mode = value.optionalString, contentModes.contains(mode) else {
            throw NativeFailure("Home cards returned an unknown content mode.")
        }
        return mode
    }

    /// `contentPage` is a `PageDto`. Keep the object as returned so revision,
    /// blocks and unknown fields survive. A missing workspace is left nil so
    /// an explicit Open or inline refresh can resolve it; the cards GET never
    /// fetches `/pages/:id`.
    private static func contentPage(_ value: JSONValue, present: Bool) throws -> JSONValue? {
        if !present || value.isNull { return nil }
        guard case .object = value else { throw NativeFailure("Home cards returned an invalid content page.") }
        if value.id.isEmpty { return nil }
        return value
    }

    private static func flag(_ value: JSONValue, present: Bool, name: String) throws -> Bool {
        if !present || value.isNull { return false }
        guard let flag = value.featureOptionalBool else { throw NativeFailure("Home cards \(name) is invalid.") }
        return flag
    }

    private static func greeting(_ value: JSONValue, present: Bool) throws -> HomeGreetingRecord? {
        if !present || value.isNull { return nil }
        guard case .object = value else { throw NativeFailure("Home greeting must be an object or null.") }
        let greetingText = try text(value["text"], name: "greeting.text", max: maxGreeting, required: true)
        let detail: String?
        if value.objectValue["detail"] == nil || value["detail"].isNull {
            detail = nil
        } else {
            let raw = try text(value["detail"], name: "greeting.detail", max: maxGreeting, required: false)
            detail = raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : raw
        }
        return HomeGreetingRecord(text: greetingText, detail: detail)
    }

    private static func sets(_ value: JSONValue) throws -> [[HomeCardRecord]] {
        guard case .array(let rows) = value else { throw NativeFailure("Home cards sets must be an array.") }
        guard rows.count <= maxSets else { throw NativeFailure("Home cards returned too many sets.") }
        var seen = Set<String>()
        return try rows.enumerated().map { index, row in
            guard case .object = row else { throw NativeFailure("Home cards set \(index) is invalid.") }
            guard case .array(let cards) = row["cards"], (1...maxCardsPerSet).contains(cards.count) else {
                throw NativeFailure("Home cards set \(index) must hold 1 to \(maxCardsPerSet) cards.")
            }
            let parsed = try cards.enumerated().map { cardIndex, card in
                try self.card(card, name: "sets[\(index)].cards[\(cardIndex)]")
            }
            if parsed.filter({ $0.kind == "tip" }).count > maxTipsPerSet {
                throw NativeFailure("Home cards set \(index) holds more than one tip.")
            }
            for card in parsed {
                if !seen.insert(card.id).inserted { throw NativeFailure("Home cards returned a duplicate card.") }
            }
            return parsed
        }
    }

    private static func card(_ value: JSONValue, name: String) throws -> HomeCardRecord {
        guard case .object = value else { throw NativeFailure("\(name) must be an object.") }
        guard value.objectValue["workspaceId"] != nil else { throw NativeFailure("\(name).workspaceId is required.") }
        guard kinds.contains(value["kind"].stringValue) else { throw NativeFailure("\(name).kind is not a card kind.") }
        try sourceObject(value["source"], name: name)
        let workspaceID: String?
        if value["workspaceId"].isNull {
            workspaceID = nil
        } else {
            workspaceID = try identifier(value["workspaceId"], name: "\(name).workspaceId")
        }
        return HomeCardRecord(
            id: try identifier(value["id"], name: "\(name).id"),
            kind: value["kind"].stringValue,
            label: try text(value["label"], name: "\(name).label", max: maxLabel, required: false),
            title: try text(value["title"], name: "\(name).title", max: maxTitle, required: true),
            reason: try text(value["reason"], name: "\(name).reason", max: maxReason, required: false),
            buttonText: try text(value["buttonText"], name: "\(name).buttonText", max: maxButton, required: true),
            prompt: try text(value["prompt"], name: "\(name).prompt", max: maxPrompt, required: false),
            workspaceID: workspaceID,
            sourceWorkspaceID: try optionalIdentifier(value["source"]["workspaceId"], name: "\(name).source.workspaceId"),
            sourcePageID: try optionalIdentifier(value["source"]["pageId"], name: "\(name).source.pageId"),
            sourceThreadNodeID: try optionalIdentifier(value["source"]["threadNodeId"], name: "\(name).source.threadNodeId"),
            origin: .recommendation
        )
    }

    private static func optionalIdentifier(_ value: JSONValue, name: String) throws -> String? {
        if value.isNull { return nil }
        return try identifier(value, name: name)
    }

    private static func sourceObject(_ value: JSONValue, name: String) throws {
        guard case .object = value else { throw NativeFailure("\(name).source must be an object.") }
    }

    private static func identifier(_ value: JSONValue, name: String) throws -> String {
        try text(value, name: name, max: maxID, required: true)
    }

    private static func text(_ value: JSONValue, name: String, max: Int, required: Bool) throws -> String {
        guard let text = value.optionalString else { throw NativeFailure("\(name) must be a string.") }
        if required && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NativeFailure("\(name) must not be empty.")
        }
        if text.count > max { throw NativeFailure("\(name) is longer than \(max) characters.") }
        return text
    }

    private static func timestamp(_ value: JSONValue, present: Bool, name: String) throws -> Double? {
        if !present || value.isNull { return nil }
        guard let number = value.featureOptionalNumber, number.isFinite, number >= 0 else {
            throw NativeFailure("Home cards \(name) is invalid.")
        }
        return number
    }

    private static func fingerprint(_ value: JSONValue, present: Bool) throws -> String? {
        if !present || value.isNull { return nil }
        return try text(value, name: "inputFingerprint", max: maxFingerprint, required: true)
    }
}

@MainActor final class HomeCardsModel: ObservableObject {
    let api: MichiAPI
    @Published var workspaceIDs: Set<String>
    @Published var hasConversation: Bool
    @Published private(set) var snapshot = HomeCardsSnapshot.empty
    @Published private(set) var loaded = false
    @Published private(set) var loading = false
    @Published private(set) var setIndex = 0
    @Published private(set) var confirmedUsed: Set<String> = []
    @Published private(set) var unknownUsed: Set<String> = []
    @Published var error: String?
    private var marking: Set<String> = []

    init(api: MichiAPI, workspaceIDs: [String] = [], hasConversation: Bool = true) {
        self.api = api
        self.workspaceIDs = Set(workspaceIDs)
        self.hasConversation = hasConversation
    }

    var showsRecommendationGrid: Bool { snapshot.contentMode == "default" }

    var showsOnboarding: Bool {
        loaded && !hasConversation && !snapshot.cardsCustomized && showsRecommendationGrid
    }

    var visibleCards: [HomeCardRecord] {
        guard loaded, showsRecommendationGrid else { return [] }
        if showsOnboarding { return HomeCardsContract.onboardingCards }
        guard !snapshot.sets.isEmpty else { return [] }
        return snapshot.sets[setIndex % snapshot.sets.count]
    }

    var canShuffle: Bool { !showsOnboarding && snapshot.sets.count > 1 }

    var showsDefaultHeadline: Bool {
        snapshot.contentMode == "default" && snapshot.greeting == nil && visibleCards.isEmpty && !snapshot.cardsCustomized
    }

    var showsGreetingChrome: Bool { !showsDefaultHeadline }

    var showsCustomPageStatus: Bool { snapshot.contentMode == "page" }

    var showsInlineHomeDocument: Bool { snapshot.contentMode == "page" && snapshot.contentPageID != nil }

    var canOpenContentPage: Bool { snapshot.contentMode == "page" && snapshot.contentPageID != nil }

    var customPageUnavailableMessage: String {
        if snapshot.contentPageID == nil {
            return NativeInlineHomeContract.unavailableMessage
        }
        let title = snapshot.contentPageTitle.map { "“\($0)”" } ?? "the selected page"
        return "This Home uses \(title). Open it in Pages if this preview cannot show everything."
    }

    func linkedPageSelection(pageID: String, workspaceID: String) -> HomeCardPickResult {
        HomeCardPickResult(kind: .contentPage, contentPageID: pageID, contentPageWorkspaceID: workspaceID)
    }

    func composeFromDocument(_ prompt: String) -> HomeCardPickResult {
        HomeCardPickResult(kind: .compose, prompt: prompt)
    }

    func reload() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let result = try await api.request("/home/cards")
            snapshot = try HomeCardsContract.parse(result)
            setIndex = 0
            loaded = true
            error = nil
        } catch is CancellationError {
        } catch {
            if loaded {
                self.error = error.localizedDescription
            } else if error is MichiAPIError {
                snapshot = .empty
                loaded = true
                self.error = nil
            } else {
                snapshot = .empty
                self.error = error.localizedDescription
            }
        }
    }

    func shuffle() {
        guard canShuffle else { return }
        setIndex = (setIndex + 1) % snapshot.sets.count
    }

    func pagesHomeSelection() -> HomeCardPickResult {
        HomeCardPickResult(kind: .pagesHome, openPagesHome: true, unsupported: "spaces")
    }

    func pick(_ card: HomeCardRecord) async -> HomeCardPickResult {
        switch card.origin {
        case .onboardingMention:
            return HomeCardPickResult(kind: .mention, cardID: card.id, startMention: true, unsupported: "mention")
        case .onboardingSpaces:
            return HomeCardPickResult(kind: .pagesHome, cardID: card.id, openPagesHome: true, unsupported: "spaces")
        case .onboardingCompose:
            return HomeCardPickResult(kind: .compose, cardID: card.id, prompt: card.prompt)
        case .recommendation:
            var choice = HomeCardPickResult(kind: .recommendation, cardID: card.id, prompt: card.prompt)
            let destination = HomeCardsContract.pickDestination(card, workspaceIDs: workspaceIDs)
            choice.workspaceID = destination.workspaceID
            choice.nodeID = destination.nodeID
            let used = await markUsed(card.id)
            choice.usedConfirmed = used.confirmed
            choice.usedUnknown = used.unknown
            return choice
        }
    }

    /// Explicit user tap only. First load never fetches `/pages/:id`. When the
    /// cards GET already carried `contentPage.workspaceId`, this does not GET.
    func openContentPage() async -> HomeCardPickResult {
        var choice = HomeCardPickResult(kind: .contentPage)
        guard let pageID = snapshot.contentPageID, !pageID.isEmpty else {
            error = customPageUnavailableMessage
            return choice
        }
        if let workspaceID = snapshot.contentPageWorkspaceID, !workspaceID.isEmpty {
            choice.contentPageID = pageID
            choice.contentPageWorkspaceID = workspaceID
            error = nil
            return choice
        }
        do {
            let result = try await api.request(try HomeCardsContract.pagePath(pageID))
            let owned = try HomeCardsContract.ownedPage(result, expectedID: pageID)
            snapshot.contentPageWorkspaceID = owned.workspaceID
            choice.contentPageID = owned.id
            choice.contentPageWorkspaceID = owned.workspaceID
            error = nil
            return choice
        } catch is CancellationError {
            return choice
        } catch {
            self.error = error.localizedDescription
            return choice
        }
    }

    @discardableResult
    func markUsed(_ cardId: String) async -> (confirmed: Bool, unknown: Bool) {
        guard !cardId.hasPrefix("onboarding:") else { return (false, false) }
        guard !marking.contains(cardId) else { return (false, false) }
        if unknownUsed.contains(cardId) {
            error = "This card's used mark was not confirmed. Refresh Home and check before trying again."
            return (false, true)
        }
        marking.insert(cardId)
        defer { marking.remove(cardId) }
        do {
            let path = try HomeCardsContract.usedPath(cardId)
            let result = try await api.request(path, method: "POST")
            let used = try HomeCardsContract.parseUsed(result, expectedID: cardId)
            confirmedUsed.insert(used.cardId)
            unknownUsed.remove(used.cardId)
            error = nil
            return (true, false)
        } catch let failure as MichiAPIError where failure.statusCode == nil {
            unknownUsed.insert(cardId)
            error = "The card could not be marked used. Check Home before trying again; it will not be sent again automatically."
            return (false, true)
        } catch {
            self.error = error.localizedDescription
            return (false, false)
        }
    }
}
