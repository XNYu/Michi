import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

/// Remaining 10-chats interactions: durable timestamps, exact mention chips,
/// branch context/agent inheritance and "Use prompt again".
@MainActor final class DesignChatContractTests: XCTestCase {
    // MARK: Fixtures

    private func recoveryStore() -> NativeComposerRecoveryStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("MichiDesignChatTests-" + UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return NativeComposerRecoveryStore(directory: directory)
    }
    private func cleanup(_ chat: ChatController, _ transport: AppContractTransport) {
        chat.detach()
        for suffix in [".draft", ".pendingComposer", ".activeTurn", "." + chat.composerWindowID + ".activeTurn"] {
            UserDefaults.standard.removeObject(forKey: "michi.\(transport.api.baseURL.absoluteString).\(chat.node.id)" + suffix)
        }
    }
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }
    private static func response(_ request: AppContractRequest, messages: JSONValue = []) -> AppContractResponse {
        if request.path.hasSuffix("/messages") { return .json(["messages": messages]) }
        if request.path.hasSuffix("/ensure-session") { return .json(["sessionState": [:]]) }
        if request.path.hasSuffix("/commands") { return .json(["ok": true]) }
        if request.path.hasSuffix("/agent/status") { return .json(["runtime": "claude"]) }
        if request.path.hasSuffix("/message") {
            let stamp: JSONValue = ["nodeId": request.body["nodeId"], "turnId": request.body["turnId"], "assistantId": "assistant"]
            return .events([("turn_start", stamp.merging(["seq": 0])), ("done", stamp.merging(["seq": 1, "stopReason": "end_turn"]))])
        }
        return .json(["error": "Unexpected request"], status: 400)
    }
    /// node-1 is the parent thread; node-2 an empty branch of it.
    private func branchGraph(parent: [String: JSONValue] = [:], branch: [String: JSONValue] = [:], treeArchived: Bool = false) -> WorkspaceGraph {
        let parentNode: JSONValue = ["id": "node-1", "workspace_id": "workspace-1", "tree_id": "tree-1", "title": "Parent", "status": "idle", "deleted_at": .null]
        let branchNode: JSONValue = ["id": "node-2", "workspace_id": "workspace-1", "tree_id": "tree-1", "parent_node_id": "node-1", "title": "", "status": "idle", "deleted_at": .null]
        return WorkspaceGraph(raw: [
            "workspace": ["id": "workspace-1", "name": "Fixture", "cwd": "/tmp/michi-contract", "created_at": 1, "archived_at": .null, "deleted_at": .null],
            "trees": [["id": "tree-1", "workspace_id": "workspace-1", "root_node_id": "node-1", "archived_at": treeArchived ? 2 : .null]],
            "nodes": [parentNode.merging(parent), branchNode.merging(branch)],
            "edges": [], "contexts": [],
        ])
    }
    private func row(_ id: String, _ role: String, seq: Int, content: String, node: String = "node-1", metadata: JSONValue = .null, createdAt: JSONValue = 1_767_000_000_000) -> JSONValue {
        ["id": .string(id), "node_id": .string(node), "workspace_id": "workspace-1", "role": .string(role), "seq": .number(Double(seq)),
         "content": .string(content), "metadata": metadata, "created_at": createdAt]
    }
    private func mention(_ start: Int, _ end: Int, kind: String = "node", ref: String, label: String) -> JSONValue {
        ["start": .number(Double(start)), "end": .number(Double(end)), "kind": .string(kind), "refId": .string(ref), "label": .string(label)]
    }
    private func message(_ id: String, _ role: String, _ text: String, metadata: JSONValue = .null) -> NativeMessage {
        var value = NativeMessage(id: id, role: role, text: text); value.metadata = metadata; return value
    }

    // MARK: Timestamps

    func testTimestampAcceptsOnlyPlausibleDurableMilliseconds() {
        XCTAssertEqual(DesignChatTimestamp.date(.number(1_767_000_000_000)), Date(timeIntervalSince1970: 1_767_000_000))
        XCTAssertNil(DesignChatTimestamp.date(.number(3)), "Small fixture/sequence numbers are not wall-clock times")
        XCTAssertNil(DesignChatTimestamp.date(.number(1_767_000_000)), "Seconds are not the stored millisecond unit")
        XCTAssertNil(DesignChatTimestamp.date(.string("1767000000000")))
        XCTAssertNil(DesignChatTimestamp.date(.null))
        XCTAssertNil(DesignChatTimestamp.date(.number(.infinity)))
        XCTAssertNil(DesignChatTimestamp.date(.number(DesignChatTimestamp.latestMillis)))

        XCTAssertEqual(NativeMessage(row("a1", "assistant", seq: 1, content: "Hi")).createdAt, Date(timeIntervalSince1970: 1_767_000_000))
        XCTAssertNil(NativeMessage(row("a1", "assistant", seq: 1, content: "Hi", createdAt: 2)).createdAt)
        XCTAssertNil(NativeMessage(id: "pending-x", role: "user", text: "Optimistic").createdAt)
    }

    func testTimestampLabelsFollowCalendarDays() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "UTC")!
        func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0) -> Date { calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))! }
        let now = at(2026, 10, 31, 12), locale = Locale(identifier: "en_US_POSIX")
        XCTAssertEqual(DesignChatTimestamp.kind(at(2026, 10, 31, 0, 30), now: now, calendar: calendar), .today)
        XCTAssertEqual(DesignChatTimestamp.kind(at(2026, 10, 30, 23, 59), now: now, calendar: calendar), .yesterday)
        XCTAssertEqual(DesignChatTimestamp.kind(at(2026, 1, 2, 9), now: now, calendar: calendar), .thisYear)
        XCTAssertEqual(DesignChatTimestamp.kind(at(2025, 12, 31, 23), now: now, calendar: calendar), .earlier)
        XCTAssertFalse(DesignChatTimestamp.label(at(2026, 10, 31, 9, 28), now: now, calendar: calendar, locale: locale).contains("Yesterday"))
        XCTAssertTrue(DesignChatTimestamp.label(at(2026, 10, 30, 9), now: now, calendar: calendar, locale: locale).hasPrefix("Yesterday "))
        XCTAssertFalse(DesignChatTimestamp.label(at(2026, 1, 2, 9), now: now, calendar: calendar, locale: locale).contains("2026"))
        XCTAssertTrue(DesignChatTimestamp.label(at(2025, 12, 31, 9), now: now, calendar: calendar, locale: locale).contains("2025"))
        XCTAssertTrue(DesignChatTimestamp.accessibilityLabel(at(2026, 10, 31, 9), locale: locale, timeZone: calendar.timeZone).contains("2026"))
    }

    // MARK: Mention chips

    func testDuplicateLabelsAreDistinctChipsAndRemovalKeepsTheOtherExactID() throws {
        let value = "@Plan and @Plan "
        let mentions = [mention(0, 5, ref: "node-a", label: "Plan"), mention(10, 15, ref: "node-b", label: "Plan")]
        let chips = DesignChatMentions.chips(value: value, mentions: mentions)
        XCTAssertEqual(chips.count, 2)
        XCTAssertNotEqual(chips[0].id, chips[1].id)
        XCTAssertEqual(chips.map(\.duplicateIndex), [1, 2])
        XCTAssertEqual(chips[1].accessibilityLabel, "Remove chat mention Plan, 2 of 2")
        XCTAssertEqual(chips[0].systemImage, "arrow.triangle.branch")

        let removed = try XCTUnwrap(DesignChatMentions.removing(chips[1], value: value, mentions: mentions))
        XCTAssertEqual(removed.value, "@Plan and ")
        XCTAssertEqual(removed.mentions, [mention(0, 5, ref: "node-a", label: "Plan")])
    }

    func testSameReferenceTwiceRemovesOnlyTheChosenRange() throws {
        let value = "Compare @Spec with @Spec"
        let mentions = [mention(8, 13, kind: "context", ref: "ctx-1", label: "Spec"), mention(19, 24, kind: "context", ref: "ctx-1", label: "Spec")]
        let chips = DesignChatMentions.chips(value: value, mentions: mentions)
        XCTAssertEqual(chips.map(\.id), ["8:13:context:ctx-1", "19:24:context:ctx-1"])
        XCTAssertEqual(chips[0].systemImage, "doc.text")

        let first = try XCTUnwrap(DesignChatMentions.removing(chips[0], value: value, mentions: mentions))
        XCTAssertEqual(first.value, "Compare with @Spec")
        XCTAssertEqual(first.mentions, [mention(13, 18, kind: "context", ref: "ctx-1", label: "Spec")])

        let last = try XCTUnwrap(DesignChatMentions.removing(chips[1], value: value, mentions: mentions))
        XCTAssertEqual(last.value, "Compare @Spec with", "A trailing mention takes its preceding space")
        XCTAssertEqual(last.mentions, [mention(8, 13, kind: "context", ref: "ctx-1", label: "Spec")])
    }

    func testRemovalShiftsLaterMentionsByUTF16Length() throws {
        // "@🚀 Launch" is 10 UTF-16 units (the emoji is a surrogate pair) but 9 Characters.
        let value = "@🚀 Launch @Notes x"
        let mentions = [mention(0, 10, kind: "context", ref: "file-1", label: "🚀 Launch"), mention(11, 17, ref: "node-9", label: "Notes")]
        XCTAssertEqual(DesignChatMentions.chips(value: value, mentions: mentions).count, 2)
        let chip = DesignChatMentions.chips(value: value, mentions: mentions)[0]
        let removed = try XCTUnwrap(DesignChatMentions.removing(chip, value: value, mentions: mentions))
        XCTAssertEqual(removed.value, "@Notes x")
        XCTAssertEqual(removed.mentions, [mention(0, 6, ref: "node-9", label: "Notes")])
    }

    func testRemovalNeverJoinsWordsOrConsumesAnotherMention() throws {
        let comma = try XCTUnwrap(DesignChatMentions.removing(DesignChatMentions.chips(value: "a @X, b", mentions: [mention(2, 4, ref: "x", label: "X")])[0],
                                                              value: "a @X, b", mentions: [mention(2, 4, ref: "x", label: "X")]))
        XCTAssertEqual(comma.value, "a, b")
        let word = try XCTUnwrap(DesignChatMentions.removing(DesignChatMentions.chips(value: "a @Xb", mentions: [mention(2, 4, ref: "x", label: "X")])[0],
                                                             value: "a @Xb", mentions: [mention(2, 4, ref: "x", label: "X")]))
        XCTAssertEqual(word.value, "a b", "The separating space stays when a word follows directly")
        let pair = [mention(0, 2, ref: "a", label: "A"), mention(3, 5, ref: "b", label: "B")]
        let adjacent = try XCTUnwrap(DesignChatMentions.removing(DesignChatMentions.chips(value: "@A @B", mentions: pair)[0], value: "@A @B", mentions: pair))
        XCTAssertEqual(adjacent.value, "@B")
        XCTAssertEqual(adjacent.mentions, [mention(0, 2, ref: "b", label: "B")])
    }

    func testStaleChipChangesNothing() {
        let value = "@Plan next"
        let mentions = [mention(0, 5, ref: "node-a", label: "Plan")]
        let chip = DesignChatMentions.chips(value: value, mentions: mentions)[0]
        // The draft was edited after the chip rendered: the mention moved.
        XCTAssertNil(DesignChatMentions.removing(chip, value: "Hi @Plan next", mentions: [mention(3, 8, ref: "node-a", label: "Plan")]))
        // Same range and label, different reference.
        XCTAssertNil(DesignChatMentions.removing(chip, value: value, mentions: [mention(0, 5, ref: "node-z", label: "Plan")]))
        // Metadata that no longer matches its text is never offered or removed.
        XCTAssertTrue(DesignChatMentions.chips(value: "@Plam next", mentions: mentions).isEmpty)
    }

    /// NFC U+00E9 vs NFD e+U+0301. Swift `String ==` treats them as equal.
    private let nfcID = "id-\u{E9}"
    private let nfdID = "id-e\u{301}"

    func testStaleChipCannotRemoveReplacedCanonicalReference() throws {
        XCTAssertEqual(nfcID, nfdID)
        XCTAssertFalse(nfcID.utf8.elementsEqual(nfdID.utf8))
        let value = "@Plan next"
        let nfcMentions = [mention(0, 5, ref: nfcID, label: "Plan")]
        let chip = DesignChatMentions.chips(value: value, mentions: nfcMentions)[0]
        XCTAssertNil(DesignChatMentions.removing(chip, value: value, mentions: [mention(0, 5, ref: nfdID, label: "Plan")]),
                     "A replaced NFC/NFD reference is a different mention")
        let kept = try XCTUnwrap(DesignChatMentions.removing(chip, value: value, mentions: nfcMentions))
        XCTAssertTrue(kept.mentions.isEmpty)
    }

    func testControllerRemovesExactMentionAndRefusesReadOnly() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        defer { transport.close() }
        let graph = appContractGraph()
        let chat = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore())
        defer { cleanup(chat, transport) }
        await chat.load()
        chat.insertMention(kind: "node", id: "node-a", label: "Plan")
        chat.insertMention(kind: "node", id: "node-b", label: "Plan")
        XCTAssertEqual(chat.draft, "@Plan @Plan ")
        let chips = chat.mentionChips
        XCTAssertEqual(chips.map(\.refID), ["node-a", "node-b"])
        XCTAssertTrue(chat.removeMention(chips[0]))
        XCTAssertEqual(chat.draft, "@Plan ")
        XCTAssertEqual(chat.mentions, [mention(0, 5, ref: "node-b", label: "Plan")])
        XCTAssertFalse(chat.removeMention(chips[0]), "A chip from the previous render is stale")
        XCTAssertEqual(chat.draft, "@Plan ")

        let archived = appContractGraph(treeArchived: true)
        let readOnly = ChatController(api: transport.api, graph: archived, node: archived.nodes[0], recoveryStore: recoveryStore(), windowID: "read-only-window")
        defer { cleanup(readOnly, transport) }
        readOnly.draft = "@Plan "
        readOnly.mentions = [mention(0, 5, ref: "node-a", label: "Plan")]
        XCTAssertFalse(readOnly.removeMention(readOnly.mentionChips[0]))
        XCTAssertEqual(readOnly.draft, "@Plan ")
        XCTAssertEqual(readOnly.mentions.count, 1)
    }

    // MARK: Branch context

    func testBranchPlanOffersCurrentReplyOnlyForAnEarlierDurableReply() {
        let ids = ["u1", "a1", "u2", "a2"]
        let earlier = DesignChatBranchPlan(requestedAnchor: "a1", durableIDs: ids)
        XCTAssertTrue(earlier.offersChoice)
        XCTAssertEqual(earlier.defaultContext, .currentReply)
        XCTAssertEqual(earlier.anchor(for: .currentReply), "a1")
        XCTAssertEqual(earlier.anchor(for: .fullThread), "a2")

        let latest = DesignChatBranchPlan(requestedAnchor: "a2", durableIDs: ids)
        XCTAssertFalse(latest.offersChoice, "Both choices would be the same cut")
        XCTAssertEqual(latest.defaultContext, .fullThread)
        XCTAssertEqual(latest.anchor(for: .currentReply), "a2")

        for unsaved in ["pending-turn", "u-steer-a2-4"] {
            let plan = DesignChatBranchPlan(requestedAnchor: unsaved, durableIDs: ids)
            XCTAssertTrue(plan.missingRequestedAnchor)
            XCTAssertFalse(plan.offersChoice)
            XCTAssertNil(plan.anchor(for: .currentReply), "A missing reply must not inherit the latest tail")
            XCTAssertEqual(plan.anchor(for: .fullThread), "a2")
            XCTAssertFalse(plan.allowsCreation(for: .currentReply))
            XCTAssertTrue(plan.allowsCreation(for: .fullThread))
            XCTAssertEqual(plan.defaultContext, .currentReply)
        }

        let unspecified = DesignChatBranchPlan(requestedAnchor: nil, durableIDs: ids)
        XCTAssertFalse(unspecified.missingRequestedAnchor)
        XCTAssertFalse(unspecified.offersChoice)
        XCTAssertEqual(unspecified.anchor(for: .currentReply), "a2")
        XCTAssertEqual(unspecified.defaultContext, .fullThread)

        let empty = DesignChatBranchPlan(requestedAnchor: "a1", durableIDs: [])
        XCTAssertTrue(empty.missingRequestedAnchor)
        XCTAssertNil(empty.anchor(for: .fullThread))
        XCTAssertNil(empty.anchor(for: .currentReply))
        XCTAssertFalse(empty.allowsCreation(for: .currentReply))
        XCTAssertTrue(empty.allowsCreation(for: .fullThread))
        XCTAssertTrue(empty.detail(for: .fullThread).contains("no saved messages"))
        XCTAssertTrue(empty.detail(for: .currentReply).localizedCaseInsensitiveContains("full thread"))
    }

    func testBranchPlanDoesNotReplaceVanishedOrCanonicallyEqualAnchors() throws {
        XCTAssertEqual(nfcID, nfdID)
        XCTAssertFalse(nfcID.utf8.elementsEqual(nfdID.utf8))

        let vanished = DesignChatBranchPlan(requestedAnchor: "a1", durableIDs: ["u2", "a2"])
        XCTAssertTrue(vanished.missingRequestedAnchor)
        XCTAssertNil(vanished.currentReplyID)
        XCTAssertEqual(vanished.tailID, "a2")
        XCTAssertNil(vanished.anchor(for: .currentReply))
        XCTAssertEqual(vanished.anchor(for: .fullThread), "a2")
        XCTAssertEqual(vanished.defaultContext, .currentReply)
        XCTAssertTrue(vanished.showsContextPicker)
        XCTAssertFalse(vanished.allowsCreation(for: .currentReply))
        switch vanished.createAnchor(for: .currentReply) {
        case .failure(let message):
            XCTAssertTrue(message.localizedDescription.localizedCaseInsensitiveContains("full thread"))
            XCTAssertTrue(message.localizedDescription.localizedCaseInsensitiveContains("saved"))
        case .success:
            XCTFail("Creating from a vanished reply must fail")
        }
        XCTAssertEqual(try vanished.createAnchor(for: .fullThread).get(), Optional("a2"))

        // Tail is NFC; the requested NFD id is an earlier durable row, not the same cut.
        let mismatched = DesignChatBranchPlan(requestedAnchor: nfdID, durableIDs: ["u1", nfdID, "u2", nfcID])
        XCTAssertFalse(mismatched.missingRequestedAnchor)
        XCTAssertTrue(mismatched.offersChoice)
        XCTAssertTrue(DesignChatOpaqueID.same(mismatched.currentReplyID ?? "", nfdID))
        XCTAssertTrue(DesignChatOpaqueID.same(mismatched.tailID ?? "", nfcID))
        XCTAssertTrue(DesignChatOpaqueID.same(mismatched.anchor(for: .currentReply) ?? "", nfdID))
        XCTAssertTrue(DesignChatOpaqueID.same(mismatched.anchor(for: .fullThread) ?? "", nfcID))

        let missingEquivalent = DesignChatBranchPlan(requestedAnchor: nfcID, durableIDs: ["u1", nfdID])
        XCTAssertTrue(missingEquivalent.missingRequestedAnchor)
        XCTAssertNil(missingEquivalent.anchor(for: .currentReply))
        XCTAssertTrue(DesignChatOpaqueID.same(missingEquivalent.anchor(for: .fullThread) ?? "", nfdID))
        XCTAssertFalse(missingEquivalent.allowsCreation(for: .currentReply))
        XCTAssertTrue(missingEquivalent.allowsCreation(for: .fullThread))
    }

    func testDurableIDsExcludeForeignPendingAndOtherNodeRows() async {
        let rows: JSONValue = [
            row("a1", "assistant", seq: 2, content: "Second"),
            row("u1", "user", seq: 1, content: "First"),
            row("pending-x", "user", seq: 3, content: "Optimistic"),
            row("b1", "user", seq: 4, content: "Other node", node: "node-2"),
            row("w1", "user", seq: 5, content: "Other workspace").merging(["workspace_id": "workspace-9"]),
        ]
        let transport = AppContractTransport { request, _ in Self.response(request, messages: rows) }
        defer { transport.close() }
        let graph = appContractGraph()
        let chat = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore())
        defer { cleanup(chat, transport) }
        await chat.load()
        XCTAssertEqual(chat.durableMessageIDs, ["u1", "a1"])
    }

    func testDurableIDsRejectCanonicallyEqualForeignOwners() async {
        XCTAssertEqual(nfcID, nfdID)
        let rows: JSONValue = [
            row("keep", "user", seq: 1, content: "Owned", node: nfcID).merging(["workspace_id": .string(nfcID)]),
            row("other-node", "user", seq: 2, content: "NFD node", node: nfdID).merging(["workspace_id": .string(nfcID)]),
            row("other-ws", "user", seq: 3, content: "NFD workspace", node: nfcID).merging(["workspace_id": .string(nfdID)]),
        ]
        let transport = AppContractTransport { request, _ in Self.response(request, messages: rows) }
        defer { transport.close() }
        let graph = accentOwnerGraph(id: nfcID)
        let chat = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore(), windowID: "accent-history")
        defer { cleanup(chat, transport) }
        await chat.load()
        XCTAssertEqual(chat.durableMessageIDs, ["keep"])
    }

    private func accentOwnerGraph(id: String, parentID: String? = nil) -> WorkspaceGraph {
        var node: JSONValue = ["id": .string(id), "workspace_id": .string(id), "tree_id": "tree-1", "title": "Accent", "status": "idle", "deleted_at": .null]
        if let parentID { node = node.merging(["parent_node_id": .string(parentID)]) }
        return WorkspaceGraph(raw: [
            "workspace": ["id": .string(id), "name": "Accent", "cwd": "/tmp/michi-contract", "created_at": 1, "archived_at": .null, "deleted_at": .null],
            "trees": [["id": "tree-1", "workspace_id": .string(id), "root_node_id": .string(parentID ?? id), "archived_at": .null]],
            "nodes": [node],
            "edges": [], "contexts": [],
        ])
    }

    // MARK: Same as parent

    func testAgentSettingsNormalizeModesAndApproveForMe() {
        XCTAssertEqual(DesignChatAgentSettings(permissionMode: "root", approveForMe: true).normalized.permissionMode, "ask")
        XCTAssertFalse(DesignChatAgentSettings(permissionMode: "trust", approveForMe: true).normalized.approveForMe)
        XCTAssertTrue(DesignChatAgentSettings(permissionMode: "ask", approveForMe: true).normalized.approveForMe)
    }

    func testSameAsParentReachesTheBranchsFirstEnsureSession() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        defer { transport.close() }
        let graph = branchGraph(parent: ["runtime_id": "codex", "provider_id": "openai", "model_id": "gpt-x", "reasoning": "high", "permission_mode": "trust"])
        let parent = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore(), windowID: "parent-window")
        defer { cleanup(parent, transport) }
        let settings = parent.agentSettings
        XCTAssertEqual(settings, DesignChatAgentSettings(runtimeID: "codex", providerID: "openai", modelID: "gpt-x", reasoning: "high", permissionMode: "trust"))

        let branch = ChatController(api: transport.api, graph: graph, node: graph.nodes[1], recoveryStore: recoveryStore(), windowID: "branch-window")
        defer { cleanup(branch, transport) }
        XCTAssertTrue(branch.adoptBranchAgentSettings(settings, parentNodeID: "node-1", workspaceID: "workspace-1"))
        // An unrelated store reload must not restore the blank branch defaults.
        branch.refresh(graph: graph, node: graph.nodes[1])
        XCTAssertEqual(branch.runtimeID, "codex")
        XCTAssertEqual(branch.permissionMode, "trust")

        await branch.load()
        branch.draft = "First branch question"; branch.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/nodes/node-2/ensure-session") } }
        let body = transport.requests.first { $0.path.hasSuffix("/nodes/node-2/ensure-session") }!.body
        XCTAssertEqual(body["runtimeId"], "codex")
        XCTAssertEqual(body["providerId"], "openai")
        XCTAssertEqual(body["modelId"], "gpt-x")
        XCTAssertEqual(body["reasoning"], "high")
        XCTAssertEqual(body["permissionMode"], "trust")
        XCTAssertEqual(body["approveForMe"], false)
        XCTAssertEqual(body["parentChatId"], "node-1")
    }

    func testInheritedExplicitDefaultEffortSendsNullReasoning() async {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        defer { transport.close() }
        let graph = branchGraph(parent: ["reasoning": "high"], branch: ["reasoning": "medium"])
        let parent = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore(), windowID: "parent-window")
        defer { cleanup(parent, transport) }
        parent.selectReasoning("")
        XCTAssertTrue(parent.agentSettings.reasoningExplicit)

        let branch = ChatController(api: transport.api, graph: graph, node: graph.nodes[1], recoveryStore: recoveryStore(), windowID: "branch-window")
        defer { cleanup(branch, transport) }
        XCTAssertTrue(branch.adoptBranchAgentSettings(parent.agentSettings, parentNodeID: "node-1", workspaceID: "workspace-1"))
        await branch.load()
        branch.draft = "Use the default effort"; branch.send()
        await eventually { transport.requests.contains { $0.path.hasSuffix("/ensure-session") } }
        let body = transport.requests.first { $0.path.hasSuffix("/ensure-session") }!.body
        XCTAssertNotNil(body.objectValue["reasoning"])
        XCTAssertEqual(body["reasoning"], .null, "The branch's own stored effort must not replace the inherited default")
    }

    func testInheritedApproveForMeSurvivesReloadButRemoteChangesStillApply() {
        let transport = AppContractTransport { request, _ in Self.response(request) }
        defer { transport.close() }
        let graph = branchGraph(parent: ["permission_mode": "ask", "permission_approve_for_me": 1])
        let parent = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore(), windowID: "parent-window")
        defer { cleanup(parent, transport) }
        let branch = ChatController(api: transport.api, graph: graph, node: graph.nodes[1], recoveryStore: recoveryStore(), windowID: "branch-window")
        defer { cleanup(branch, transport) }
        XCTAssertTrue(branch.adoptBranchAgentSettings(parent.agentSettings, parentNodeID: "node-1", workspaceID: "workspace-1"))
        branch.refresh(graph: graph, node: graph.nodes[1])
        XCTAssertEqual(branch.permissionMode, "ask")
        XCTAssertTrue(branch.approveForMe, "Same mode with a different unsaved approval is still a local choice")

        // A controller without local edits keeps following the saved node.
        let untouched = ChatController(api: transport.api, graph: graph, node: graph.nodes[1], recoveryStore: recoveryStore(), windowID: "other-window")
        defer { cleanup(untouched, transport) }
        let changed = branchGraph(branch: ["permission_mode": "ask", "permission_approve_for_me": 1])
        untouched.refresh(graph: changed, node: changed.nodes[1])
        XCTAssertTrue(untouched.approveForMe)
    }

    func testAdoptionRefusesTheWrongTargetOrAStartedBranch() async {
        let settings = DesignChatAgentSettings(runtimeID: "codex", permissionMode: "trust")
        let rows: JSONValue = [row("u1", "user", seq: 1, content: "Already started", node: "node-2")]
        let transport = AppContractTransport { request, _ in Self.response(request, messages: rows) }
        defer { transport.close() }
        let graph = branchGraph()
        let branch = ChatController(api: transport.api, graph: graph, node: graph.nodes[1], recoveryStore: recoveryStore(), windowID: "branch-window")
        defer { cleanup(branch, transport) }
        XCTAssertFalse(branch.adoptBranchAgentSettings(settings, parentNodeID: "node-9", workspaceID: "workspace-1"))
        XCTAssertFalse(branch.adoptBranchAgentSettings(settings, parentNodeID: "node-1", workspaceID: "workspace-9"))
        XCTAssertEqual(branch.runtimeID, "")

        let root = ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: recoveryStore(), windowID: "root-window")
        defer { cleanup(root, transport) }
        XCTAssertFalse(root.adoptBranchAgentSettings(settings, parentNodeID: "", workspaceID: "workspace-1"), "A root thread has no parent to inherit from")

        let archived = branchGraph(treeArchived: true)
        let readOnly = ChatController(api: transport.api, graph: archived, node: archived.nodes[1], recoveryStore: recoveryStore(), windowID: "archived-window")
        defer { cleanup(readOnly, transport) }
        XCTAssertFalse(readOnly.adoptBranchAgentSettings(settings, parentNodeID: "node-1", workspaceID: "workspace-1"))

        await branch.load()
        XCTAssertFalse(branch.adoptBranchAgentSettings(settings, parentNodeID: "node-1", workspaceID: "workspace-1"), "Saved user history already chose its session")
        XCTAssertEqual(branch.runtimeID, "")
        XCTAssertEqual(branch.permissionMode, "ask")
    }

    func testAdoptionRequiresByteExactParentAndWorkspace() {
        XCTAssertEqual(nfcID, nfdID)
        let settings = DesignChatAgentSettings(runtimeID: "codex", permissionMode: "trust")
        let transport = AppContractTransport { request, _ in Self.response(request) }
        defer { transport.close() }
        let parent: JSONValue = ["id": .string(nfcID), "workspace_id": .string(nfcID), "tree_id": "tree-1", "title": "Parent", "status": "idle", "deleted_at": .null]
        let child: JSONValue = ["id": "node-2", "workspace_id": .string(nfcID), "tree_id": "tree-1", "parent_node_id": .string(nfcID), "title": "", "status": "idle", "deleted_at": .null]
        let graph = WorkspaceGraph(raw: [
            "workspace": ["id": .string(nfcID), "name": "Accent", "cwd": "/tmp/michi-contract", "created_at": 1, "archived_at": .null, "deleted_at": .null],
            "trees": [["id": "tree-1", "workspace_id": .string(nfcID), "root_node_id": .string(nfcID), "archived_at": .null]],
            "nodes": [parent, child],
            "edges": [], "contexts": [],
        ])
        let branch = ChatController(api: transport.api, graph: graph, node: graph.nodes[1], recoveryStore: recoveryStore(), windowID: "accent-adopt")
        defer { cleanup(branch, transport) }
        XCTAssertFalse(branch.adoptBranchAgentSettings(settings, parentNodeID: nfdID, workspaceID: nfcID))
        XCTAssertFalse(branch.adoptBranchAgentSettings(settings, parentNodeID: nfcID, workspaceID: nfdID))
        XCTAssertEqual(branch.runtimeID, "")
        XCTAssertTrue(branch.adoptBranchAgentSettings(settings, parentNodeID: nfcID, workspaceID: nfcID))
        XCTAssertEqual(branch.runtimeID, "codex")
    }

    // MARK: Use prompt again

    private var savedPromptMetadata: JSONValue {
        ["quotedText": "Quoted source", "quoteSource": ["type": "attached"], "attachments": [["name": "notes.md", "absPath": "/tmp/notes.md", "size": 12]]]
    }

    func testPromptSourceRestoresQuoteAndAttachmentsButNeverMentions() throws {
        let messages = [message("u1", "user", "Compare @Spec with the plan", metadata: savedPromptMetadata), message("a1", "assistant", "Answer")]
        let source = try DesignChatPromptAgain.source(forReply: "a1", messages: messages, durableIDs: ["u1", "a1"]).get()
        XCTAssertEqual(source.messageID, "u1")
        XCTAssertEqual(source.composer.value, "Compare @Spec with the plan")
        XCTAssertEqual(source.composer.quotedText, "Quoted source")
        XCTAssertEqual(source.composer.quoteSource, ["type": "attached"])
        XCTAssertEqual(source.composer.attachments, [["name": "notes.md", "absPath": "/tmp/notes.md"]])
        XCTAssertTrue(source.composer.mentions.isEmpty, "Mention ids were never persisted with the sent message")
        XCTAssertTrue(source.mentionsNotRestored)

        let artifact = DesignChatPromptAgain.composer(from: message("u1", "user", "x", metadata: ["quotedText": "Q", "quoteSource": ["type": "artifact"]]))
        XCTAssertEqual(artifact.quotedText, "Q")
        XCTAssertEqual(artifact.quoteSource, .null, "An artifact source without its file path is not trusted")
        XCTAssertFalse(DesignChatPromptAgain.mayContainMentions("mail a@b.com or @ alone"))
        XCTAssertTrue(DesignChatPromptAgain.mayContainMentions("@Spec first"))
    }

    func testPromptSourceRefusesUnsavedAmbiguousAndMissingPrompts() {
        let steered = message("u3", "user", "Also this", metadata: ["steered": true])
        let messages = [message("a0", "assistant", "Intro"), message("u1", "user", "One"), message("a1", "assistant", "First"),
                        message("u2", "user", "Two"), steered, message("a2", "assistant", "Second"),
                        message("pending-t", "user", "Unsaved"), message("a3", "assistant", "Third")]
        let durable = ["a0", "u1", "a1", "u2", "u3", "a2", "a3"]
        XCTAssertEqual(DesignChatPromptAgain.source(forReply: "u1", messages: messages, durableIDs: durable), .failure(.notAReply))
        XCTAssertEqual(DesignChatPromptAgain.source(forReply: "a0", messages: messages, durableIDs: durable), .failure(.noSavedPrompt))
        XCTAssertEqual(DesignChatPromptAgain.source(forReply: "a2", messages: messages, durableIDs: durable), .failure(.ambiguousPrompt))
        XCTAssertEqual(DesignChatPromptAgain.source(forReply: "a3", messages: messages, durableIDs: durable), .failure(.noSavedPrompt))
        XCTAssertEqual(DesignChatPromptAgain.source(forReply: "a1", messages: messages, durableIDs: durable.filter { $0 != "a1" }), .failure(.notSaved))
        XCTAssertEqual(DesignChatPromptAgain.source(forReply: "a1", messages: [message("u1", "user", "  "), message("a1", "assistant", "x")], durableIDs: ["u1", "a1"]), .failure(.emptyPrompt))
        XCTAssertEqual(DesignChatPromptAgain.availableReplyIDs(messages: messages, durableIDs: durable), [DesignChatOpaqueID(raw: "a1")])
    }

    func testPromptSourceDoesNotSwitchCanonicallyEqualHistoryIDs() throws {
        XCTAssertEqual(nfcID, nfdID)
        let messages = [
            message("u-nfc", "user", "NFC prompt"), message(nfcID, "assistant", "NFC reply"),
            message("u-nfd", "user", "NFD prompt"), message(nfdID, "assistant", "NFD reply"),
        ]
        let durable = ["u-nfc", nfcID, "u-nfd", nfdID]
        let nfcSource = try DesignChatPromptAgain.source(forReply: nfcID, messages: messages, durableIDs: durable).get()
        XCTAssertTrue(DesignChatOpaqueID.same(nfcSource.messageID, "u-nfc"))
        XCTAssertEqual(nfcSource.composer.value, "NFC prompt")
        let nfdSource = try DesignChatPromptAgain.source(forReply: nfdID, messages: messages, durableIDs: durable).get()
        XCTAssertTrue(DesignChatOpaqueID.same(nfdSource.messageID, "u-nfd"))
        XCTAssertEqual(nfdSource.composer.value, "NFD prompt")

        let available = DesignChatPromptAgain.availableReplyIDs(messages: messages, durableIDs: durable)
        XCTAssertEqual(available.count, 2)
        XCTAssertTrue(available.includes(nfcID))
        XCTAssertTrue(available.includes(nfdID))
        XCTAssertFalse(DesignChatPromptAgain.availableReplyIDs(messages: messages, durableIDs: ["u-nfc", nfdID, "u-nfd"]).includes(nfcID),
                       "A durable NFD id must not make the NFC reply look saved")
    }

    private func promptChat(_ transport: AppContractTransport, graph: WorkspaceGraph = appContractGraph(), store: NativeComposerRecoveryStore? = nil, windowID: String = "prompt-window") -> ChatController {
        ChatController(api: transport.api, graph: graph, node: graph.nodes[0], recoveryStore: store ?? recoveryStore(), windowID: windowID)
    }
    private var promptRows: JSONValue {
        [row("u1", "user", seq: 1, content: "Draft this @Spec", metadata: savedPromptMetadata), row("a1", "assistant", seq: 2, content: "Done")]
    }

    func testUsePromptAgainFillsAnEmptyComposerWithoutSending() async throws {
        let rows = promptRows
        let transport = AppContractTransport { request, _ in Self.response(request, messages: rows) }
        defer { transport.close() }
        let chat = promptChat(transport); defer { cleanup(chat, transport) }
        await chat.load()
        let reply = try XCTUnwrap(chat.messages.first { $0.id == "a1" })
        XCTAssertEqual(chat.promptAgainReplyIDs, [DesignChatOpaqueID(raw: "a1")])

        chat.draft = "My unsent words"
        XCTAssertEqual(chat.usePromptAgain(reply), .blocked(.draftNotEmpty))
        XCTAssertEqual(chat.draft, "My unsent words", "An unsent draft is never overwritten")
        chat.draft = ""

        XCTAssertEqual(chat.usePromptAgain(reply), .filled(mentionsNotRestored: true))
        XCTAssertEqual(chat.draft, "Draft this @Spec")
        XCTAssertTrue(chat.mentions.isEmpty)
        XCTAssertEqual(chat.quotedText, "Quoted source")
        XCTAssertEqual(chat.attachments.count, 1)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(chat.busy)
        XCTAssertFalse(transport.requests.contains { $0.path.hasSuffix("/message") || $0.path.hasSuffix("/ensure-session") }, "Only an explicit Send submits")
        XCTAssertNotNil(DesignChatPromptAgain.notice(for: .filled(mentionsNotRestored: true)))
    }

    func testUsePromptAgainIsBlockedByUnknownOrSavedSubmissions() async throws {
        let rows = promptRows
        let transport = AppContractTransport { request, _ in Self.response(request, messages: rows) }
        defer { transport.close() }

        let unknown = promptChat(transport); defer { cleanup(unknown, transport) }
        await unknown.load()
        let reply = try XCTUnwrap(unknown.messages.first { $0.id == "a1" })
        var earlier = NativeComposer(); earlier.value = "Earlier"
        unknown.queued = [NativeQueuedMessage(composer: earlier, outcomeUnknown: true)]
        XCTAssertEqual(unknown.usePromptAgain(reply), .blocked(.submissionUnresolved))
        XCTAssertEqual(unknown.draft, "")

        // A command saved before transport whose result was never confirmed.
        let store = recoveryStore(), windowID = "recovering-window"
        let scope = NativeComposerRecoveryScope(connection: transport.api.baseURL.absoluteString, workspaceID: "workspace-1", nodeID: "node-1", windowID: windowID)
        var command = NativeComposer(); command.value = "/compact"
        try store.reserve(NativeComposerSubmission(id: "sub-1", kind: "command", turnID: nil, path: "/chats/node-1/compact", payload: [:], composer: command, queueEntries: []), queue: [], scope: scope)
        let recovering = promptChat(transport, store: store, windowID: windowID); defer { cleanup(recovering, transport) }
        XCTAssertNotNil(recovering.pendingSubmission)
        await recovering.load()
        XCTAssertEqual(recovering.usePromptAgain(reply), .blocked(.submissionUnresolved))
        XCTAssertEqual(recovering.draft, "")

        let archived = appContractGraph(treeArchived: true)
        let readOnly = promptChat(transport, graph: archived, windowID: "archived-window"); defer { cleanup(readOnly, transport) }
        XCTAssertEqual(readOnly.usePromptAgain(reply), .blocked(.readOnly))
        let unloaded = promptChat(transport, windowID: "unloaded-window"); defer { cleanup(unloaded, transport) }
        XCTAssertEqual(unloaded.usePromptAgain(reply), .blocked(.notLoaded))

        XCTAssertFalse(transport.requests.contains { $0.method == "POST" && !$0.path.hasSuffix("/commands") }, "Nothing was submitted or re-run")
    }
}
