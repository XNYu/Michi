import Foundation
import Combine
import MichiCore

/// The assistant endpoints provision their own restricted system conversation.
/// Page ids are context, never conversation ids or a reason to create a worker.
enum NativeSpacesContract {
    /// ECMAScript String.trim(), including BOM/FEFF (the server normalizes both fields).
    static func trimmed(_ value: String) -> String {
        let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
        return value.trimmingCharacters(in: whitespace)
    }
    static func usableID(_ value: String) -> Bool {
        !value.isEmpty && value.utf16.count <= 200 && !value.hasPrefix("remote:")
            && !value.unicodeScalars.contains { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }
    }
    static func boundedTitle(_ text: String) -> String {
        var result = "", length = 0
        for character in text {
            let size = String(character).utf16.count
            if length + size > 300 { break }
            result.append(character); length += size
        }
        return result
    }
    static func context(page: JSONValue?, blockID: String?, knownPages: [JSONValue]) throws -> JSONValue {
        var references: [JSONValue] = [], seen = Set<String>()
        for candidate in ([page].compactMap { $0 } + knownPages) {
            guard usableID(candidate.id), seen.insert(candidate.id).inserted, references.count < 500 else { continue }
            var reference: JSONValue = ["id": .string(candidate.id), "title": .string(boundedTitle(candidate["title"].stringValue))]
            let workspace = candidate["workspaceId"].stringValue
            if usableID(workspace) { reference["workspaceId"] = .string(workspace) }
            references.append(reference)
        }
        let pageID = page?.id ?? ""
        if !pageID.isEmpty && !usableID(pageID) { throw NativeFailure("This page cannot be sent as assistant context.") }
        if let blockID {
            guard !pageID.isEmpty, usableID(blockID), page?["blocks"].arrayValue.contains(where: { $0.id == blockID }) == true else {
                throw NativeFailure("The selected block no longer belongs to this page. Refresh before asking about it.")
            }
        }
        return ["pageId": pageID.isEmpty ? .null : .string(pageID), "blockId": blockID.map(JSONValue.string) ?? .null, "pages": .array(references)]
    }
    static func assistantInfo(_ value: JSONValue) throws -> JSONValue {
        guard usableID(value["nodeId"].stringValue), usableID(value["workspaceId"].stringValue), usableID(value["treeId"].stringValue),
              !value["settings"]["runtimeId"].stringValue.isEmpty, case .array(let runtimes) = value["supportedRuntimes"],
              runtimes.allSatisfy({ !$0.stringValue.isEmpty }) else { throw NativeFailure("This backend did not return a usable Michi assistant.") }
        return value
    }
    static func assistantGraph(_ value: JSONValue, info: JSONValue, purpose: String) throws -> WorkspaceGraph {
        let graph = WorkspaceGraph(raw: value)
        let pointer = purpose == "schedule" ? "scheduleNodeId" : "nodeId"
        guard graph.id == info["workspaceId"].stringValue, !graph.isDeleted, !graph.isArchived,
              graph.workspace["settings"].parsedJSON["system"] == "assistant",
              graph.workspace["settings"].parsedJSON["assistant"][pointer] == info["nodeId"],
              let node = graph.node(info["nodeId"].stringValue), node["workspace_id"].stringValue == graph.id,
              node["tree_id"] == info["treeId"], node["kind"] == "chat", node["deleted_at"].isNull,
              graph.trees.contains(where: { $0.id == info["treeId"].stringValue && $0["root_node_id"] == info["nodeId"] && $0["archived_at"].isNull }) else {
            throw NativeFailure("The assistant conversation changed or its workspace identity did not match. Refresh to continue.")
        }
        return graph
    }
    static func layout(_ value: JSONValue) throws -> JSONValue {
        guard case .string(let text) = value["text"], text.utf16.count <= 8_000,
              case .number(let revision) = value["revision"], revision >= 0, revision.rounded(.down) == revision else {
            throw NativeFailure("The page layout preferences could not be read.")
        }
        return value
    }
    static func ruleBody(text: String, section: String?, maxAge: Int?, maxItems: Int?, isHome: Bool) throws -> JSONValue {
        let trimmed = Self.trimmed(text)
        guard !trimmed.isEmpty, trimmed.utf16.count <= 500 else { throw NativeFailure("A rule needs 1–500 characters.") }
        var body: JSONValue = ["text": .string(trimmed)]
        if let section {
            guard isHome, ["waiting", "stalled", "done"].contains(section), maxAge != nil || maxItems != nil,
                  maxAge.map({ (1...365).contains($0) }) ?? true, maxItems.map({ (1...8).contains($0) }) ?? true else {
                throw NativeFailure("Home section limits allow 1–365 days and 1–8 items.")
            }
            var limit: JSONValue = ["section": .string(section)]
            if let maxAge { limit["maxAgeDays"] = .number(Double(maxAge)) }
            if let maxItems { limit["maxItems"] = .number(Double(maxItems)) }
            body["sectionLimit"] = limit
        }
        return body
    }
    static func firstRun(_ value: JSONValue) throws -> JSONValue {
        guard case .array(let workspaces) = value["workspaces"], ["waiting", "due", "running", "done"].contains(value["summary"]["state"].stringValue),
              workspaces.allSatisfy({ usableID($0["workspaceId"].stringValue) }) else { throw NativeFailure("The first-read progress could not be read.") }
        return value
    }
    static func confirmedRejection(_ error: Error) -> Bool {
        guard let error = error as? MichiAPIError else { return false }
        return error.statusCode.map { [400, 401, 403, 404, 409, 422].contains($0) } == true
    }
}

@MainActor final class NativeSpacesPageModel: ObservableObject {
    let api: MichiAPI
    let pageID: String
    let workspaceID: String
    @Published private(set) var page: JSONValue = .null
    @Published private(set) var preferences: JSONValue = .null
    @Published var preferenceDraft = ""
    @Published private(set) var rules: [JSONValue] = []
    @Published private(set) var cards: [JSONValue] = []
    @Published private(set) var firstRun: JSONValue = .null
    @Published private(set) var loading = false
    @Published private(set) var saving = false
    @Published private(set) var ruleOutcomeUnknown = false
    @Published var error: String?
    @Published var progressError: String?
    @Published var ruleText = ""
    private var preferenceBaseline: JSONValue = .null
    private var pendingRule: JSONValue?
    @Published private(set) var firstRunUnknown = false
    private var pendingFirstRun: JSONValue?
    private var firstRunReading = false
    private var firstRunWriting = false
    private var ruleRequestID: String?
    var pendingRuleBody: JSONValue? { pendingRule?["body"] }
    var preferenceDirty: Bool { !preferenceBaseline.isNull && preferenceDraft != preferenceBaseline["text"].stringValue }
    var expectedRevision: Int { preferenceBaseline["revision"].intValue }
    var isHome: Bool { page["role"] == "spaces-home" }
    var hasLoaded: Bool { !page.isNull }
    private var pendingKey: String { "michi.spaces.rule.\(api.baseURL.absoluteString).\(pageID)" }
    private var firstRunKey: String { "michi.spaces.first-run-retry.\(api.baseURL.absoluteString)" }
    init(api: MichiAPI, pageID: String, workspaceID: String) {
        self.api = api; self.pageID = pageID; self.workspaceID = workspaceID
        if let raw = UserDefaults.standard.string(forKey: pendingKey), let saved = try? JSONValue.parse(raw) {
            pendingRule = saved.merging(["requestID": .string(saved["requestID"].optionalString ?? UUID().uuidString)])
            ruleOutcomeUnknown = true; ruleText = saved["body"]["text"].stringValue
        }
        if let raw = UserDefaults.standard.string(forKey: firstRunKey), let saved = try? JSONValue.parse(raw) {
            pendingFirstRun = saved; firstRunUnknown = true
        }
    }
    func refresh() async {
        guard !loading, !saving else { return }
        loading = true; defer { loading = false }
        let draftAtRead = preferenceDraft
        do {
            let loaded = try await api.request("/pages/\(MichiAPI.pathSegment(pageID))")
            guard loaded.id == pageID, loaded["workspaceId"].stringValue == workspaceID, loaded["deletedAt"].isNull else { throw NativeFailure("The page is unavailable in this workspace.") }
            page = loaded
            let latest = try NativeSpacesContract.layout(await api.request("/pages/\(MichiAPI.pathSegment(pageID))/layout-preferences"))
            preferences = latest
            if !preferenceDirty && preferenceDraft == draftAtRead { preferenceBaseline = latest; preferenceDraft = latest["text"].stringValue }
            else if preferenceBaseline.isNull { preferenceBaseline = latest }
            let rows = try await api.request("/pages/\(MichiAPI.pathSegment(pageID))/layout-rules")
            guard case .array(let items) = rows["items"], items.allSatisfy({ !$0.id.isEmpty && !$0["text"].stringValue.isEmpty }) else { throw NativeFailure("The page rules could not be read.") }
            rules = items
            reconcileRule()
            let progress = try await api.request("/pages/\(MichiAPI.pathSegment(pageID))/progress-cards")
            guard case .array(let items) = progress["items"] else { throw NativeFailure("The page progress could not be read.") }
            cards = items.filter { $0["startedFromPageId"].stringValue == pageID && $0["dismissedAt"].isNull && NativeSpacesContract.usableID($0["threadNodeId"].stringValue) }
            error = nil
        } catch { self.error = error.localizedDescription }
        await refreshFirstRun()
    }
    func discardPreferenceDraft() {
        guard !loading, !saving, !preferences.isNull else { return }
        preferenceBaseline = preferences; preferenceDraft = preferences["text"].stringValue
    }
    func savePreferences() async -> Bool {
        guard hasLoaded, !loading, !saving, !preferenceBaseline.isNull else { return false }
        guard preferenceDraft.utf16.count <= 8_000 else { error = "Layout preferences allow at most 8,000 characters."; return false }
        saving = true; defer { saving = false }
        let submitted = preferenceDraft
        do {
            let result = try NativeSpacesContract.layout(await api.request("/pages/\(MichiAPI.pathSegment(pageID))/layout-preferences", method: "PUT", body: ["text": .string(submitted), "expectedRevision": preferenceBaseline["revision"]]))
            guard result["text"].stringValue == NativeSpacesContract.trimmed(submitted), result["revision"].intValue >= expectedRevision else { throw NativeFailure("The saved layout did not match this draft. Refresh before trying again.") }
            preferences = result; preferenceBaseline = result
            if preferenceDraft == submitted { preferenceDraft = result["text"].stringValue }
            error = nil; return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func addRule(section: String? = nil, maxAge: Int? = nil, maxItems: Int? = nil) async -> Bool {
        guard hasLoaded, !loading, !saving, !ruleOutcomeUnknown, pendingRule == nil, ruleRequestID == nil else { return false }
        let body: JSONValue
        do { body = try NativeSpacesContract.ruleBody(text: ruleText, section: section, maxAge: maxAge, maxItems: maxItems, isHome: isHome) }
        catch { self.error = error.localizedDescription; return false }
        guard rules.count < 50 else { error = "A page can keep up to 50 rules."; return false }
        let requestID = UUID().uuidString
        saving = true; ruleRequestID = requestID
        defer { saving = false; if ruleRequestID == requestID { ruleRequestID = nil } }
        pendingRule = ["requestID": .string(requestID), "body": body, "knownIds": .array(rules.map { .string($0.id) })]
        UserDefaults.standard.set(pendingRule!.prettyPrinted, forKey: pendingKey)
        do {
            let result = try await api.request("/pages/\(MichiAPI.pathSegment(pageID))/layout-rules", method: "POST", body: body)
            guard pendingRule?["requestID"].stringValue == requestID else { return false }
            guard !result.id.isEmpty, result["text"] == body["text"], result["sectionLimit"] == body["sectionLimit"] else { throw NativeFailure("The rule response could not be confirmed. Refresh before adding it again.") }
            rules.removeAll { $0.id == result.id }; rules.append(result)
            clearPendingRule(); if NativeSpacesContract.trimmed(ruleText) == body["text"].stringValue { ruleText = "" }; error = nil; return true
        } catch {
            guard pendingRule?["requestID"].stringValue == requestID else { return false }
            if NativeSpacesContract.confirmedRejection(error) { clearPendingRule() } else { ruleOutcomeUnknown = true }
            self.error = error.localizedDescription; return false
        }
    }
    private func reconcileRule() {
        guard ruleRequestID == nil, let pendingRule else { return }
        let known = Set(pendingRule["knownIds"].arrayValue.map(\.stringValue)), body = pendingRule["body"]
        let matches = rules.filter { !known.contains($0.id) && $0["text"] == body["text"] && $0["sectionLimit"] == body["sectionLimit"] }
        if matches.count == 1 { clearPendingRule(); if NativeSpacesContract.trimmed(ruleText) == body["text"].stringValue { ruleText = "" } }
    }
    /// Explicit warning-confirmed local recovery. No network request is retried or cancelled.
    @discardableResult func forgetPendingRule() -> JSONValue? {
        guard !loading, !saving, ruleRequestID == nil, ruleOutcomeUnknown, let body = pendingRuleBody else { return nil }
        ruleText = body["text"].stringValue; clearPendingRule()
        error = "The local pending record was forgotten. The original request may still save; adding this rule again may create a duplicate."
        return body
    }
    private func clearPendingRule() { pendingRule = nil; ruleOutcomeUnknown = false; UserDefaults.standard.removeObject(forKey: pendingKey) }
    func deleteRule(_ rule: JSONValue) async {
        guard !loading, !saving, rules.contains(where: { $0.id == rule.id }) else { return }
        saving = true; defer { saving = false }
        do {
            let result = try await api.request("/pages/\(MichiAPI.pathSegment(pageID))/layout-rules/\(MichiAPI.pathSegment(rule.id))", method: "DELETE", body: [:])
            guard case .array(let items) = result["items"], !items.contains(where: { $0.id == rule.id }) else { throw NativeFailure("The rule deletion was not confirmed. Refresh to check it.") }
            rules = items; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func refreshFirstRun() async {
        guard !firstRunReading, !firstRunWriting else { return }
        firstRunReading = true; defer { firstRunReading = false }
        do {
            firstRun = try NativeSpacesContract.firstRun(await api.request("/spaces-home/first-run"))
            reconcileFirstRun()
            progressError = firstRunUnknown ? "The retry outcome is still unknown. The previous failed run has not been replaced in the latest progress; no retry was sent. Refresh again to check." : nil
        }
        catch { progressError = error.localizedDescription }
    }
    private func reconcileFirstRun() {
        guard !firstRunWriting, let pending = pendingFirstRun else { return }
        let targets = pending["targets"].arrayValue
        // Failed progress is immutable on the server. A newer startedAt proves
        // that a retry replaced it, even when that new attempt has already failed.
        let replaced = !targets.isEmpty && targets.allSatisfy { target in
            guard let current = firstRun["workspaces"].arrayValue.first(where: { $0["workspaceId"] == target["workspaceId"] }),
                  case .number(let started) = current["firstRun"]["startedAt"],
                  case .number(let previous) = target["firstRun"]["startedAt"] else { return false }
            return started > previous
        }
        let liftedStop = targets.isEmpty && !pending["haltedReason"].isNull && firstRun["haltedReason"].isNull
        if replaced || liftedStop { clearPendingFirstRun() }
    }
    private func clearPendingFirstRun() {
        pendingFirstRun = nil; firstRunUnknown = false; UserDefaults.standard.removeObject(forKey: firstRunKey)
    }
    func startFirstRun(retryWorkspace: String? = nil, retry: Bool = false) async {
        guard !loading, !saving, !firstRunReading, !firstRunWriting, !(retry && firstRunUnknown) else { return }
        if let retryWorkspace, !firstRun["workspaces"].arrayValue.contains(where: { $0["workspaceId"].stringValue == retryWorkspace && $0["firstRun"]["state"] == "failed" }) { return }
        let targets = firstRun["workspaces"].arrayValue.filter { $0["firstRun"]["state"] == "failed" && (retryWorkspace == nil || $0["workspaceId"].stringValue == retryWorkspace) }
        if retry {
            guard !targets.isEmpty || !firstRun["haltedReason"].isNull else { return }
            pendingFirstRun = ["targets": .array(targets), "haltedReason": firstRun["haltedReason"]]
            UserDefaults.standard.set(pendingFirstRun!.prettyPrinted, forKey: firstRunKey)
        }
        saving = true; firstRunWriting = true; defer { saving = false; firstRunWriting = false }
        do {
            let result = try await api.request("/spaces-home/first-run" + (retry ? "/retry" : ""), method: "POST", body: retryWorkspace.map { ["workspaceId": .string($0)] } ?? [:])
            firstRun = try NativeSpacesContract.firstRun(result)
            if retry { clearPendingFirstRun() }
            progressError = firstRunUnknown ? "A previous retry still needs confirmation. Refresh progress to check it." : nil
        } catch {
            if retry {
                if NativeSpacesContract.confirmedRejection(error) { clearPendingFirstRun() }
                else { firstRunUnknown = true }
            }
            progressError = error.localizedDescription + (firstRunUnknown ? " The retry outcome is unknown; refresh progress before taking further action." : "")
        }
    }
    func openCard(_ card: JSONValue) async -> (workspace: String, node: String)? {
        guard cards.contains(where: { $0["threadNodeId"] == card["threadNodeId"] && $0["workspaceId"] == card["workspaceId"] && $0["startedFromPageId"].stringValue == pageID }) else { return nil }
        do {
            let workspace = card["workspaceId"].stringValue, node = card["threadNodeId"].stringValue
            let graph = WorkspaceGraph(raw: try await api.request("/workspaces/\(MichiAPI.pathSegment(workspace))"))
            guard graph.id == workspace, !graph.isDeleted, !graph.isSystem, let current = graph.node(node),
                  current["workspace_id"].stringValue == workspace, current["kind"] == "chat", current["deleted_at"].isNull,
                  graph.trees.contains(where: { $0.id == current["tree_id"].stringValue && $0["workspace_id"].stringValue == workspace }) else { throw NativeFailure("This conversation is no longer available in the card's workspace.") }
            // Seeing the card starts its server-owned 24-hour expiry. Only an
            // explicit validated conversation open sends this idempotent stamp.
            do {
                let seen = try await api.request("/progress-cards/\(MichiAPI.pathSegment(node))/seen", method: "POST", body: [:])
                guard seen["threadNodeId"].stringValue == node, seen["workspaceId"].stringValue == workspace,
                      seen["startedFromPageId"].stringValue == pageID, case .number(let seenAt) = seen["seenAt"], seenAt > 0 else {
                    throw NativeFailure("The progress card's seen status could not be confirmed.")
                }
                cards = cards.map { $0["threadNodeId"].stringValue == node ? seen : $0 }; error = nil
            } catch { self.error = "The conversation can be opened, but its card's seen status was not confirmed. " + error.localizedDescription }
            return (workspace, node)
        } catch { self.error = error.localizedDescription; return nil }
    }
    func dismissCard(_ card: JSONValue) async {
        guard !loading, !saving, cards.contains(where: { $0["threadNodeId"] == card["threadNodeId"] }) else { return }
        saving = true; defer { saving = false }
        do {
            let result = try await api.request("/progress-cards/\(MichiAPI.pathSegment(card["threadNodeId"].stringValue))/dismiss", method: "POST", body: [:])
            guard result["threadNodeId"] == card["threadNodeId"], !result["dismissedAt"].isNull else { throw NativeFailure("The progress card dismissal was not confirmed.") }
            cards.removeAll { $0["threadNodeId"] == card["threadNodeId"] }; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

@MainActor final class NativeSpacesAssistantModel: ObservableObject {
    let api: MichiAPI
    let store: MichiStore
    let pageID: String?
    let workspaceID: String?
    let blockID: String?
    let purpose: String
    @Published private(set) var info: JSONValue = .null
    @Published private(set) var chat: ChatController?
    @Published private(set) var loading = false
    @Published private(set) var changing = false
    @Published private(set) var history: [JSONValue] = []
    @Published private(set) var nextCursor: String?
    @Published var error: String?
    @Published private(set) var unknownChange = false
    private var historyLoading = false
    var path: String { purpose == "schedule" ? "/assistant/schedule" : "/assistant" }
    init(api: MichiAPI, pageID: String? = nil, workspaceID: String? = nil, blockID: String? = nil, purpose: String = "spaces") {
        self.api = api; store = MichiStore(api: api); self.pageID = pageID; self.workspaceID = workspaceID; self.blockID = blockID
        self.purpose = purpose == "schedule" ? "schedule" : "spaces"
    }
    /// Explicitly opening the assistant provisions its server-owned conversation.
    func open() async {
        guard !loading, !changing else { return }
        loading = true; defer { loading = false }
        freezeChat()
        do { try await adopt(await api.request(path)); unknownChange = false; error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func adopt(_ value: JSONValue) async throws {
        let candidate = try NativeSpacesContract.assistantInfo(value)
        let raw = try await api.request("/workspaces/\(MichiAPI.pathSegment(candidate["workspaceId"].stringValue))")
        let graph = try NativeSpacesContract.assistantGraph(raw, info: candidate, purpose: purpose)
        let context: JSONValue
        if purpose == "schedule" { context = ["schedule": ["workspaceId": workspaceID.map(JSONValue.string) ?? .null]] }
        else {
            var page: JSONValue?
            if let pageID {
                let fetched = try await api.request("/pages/\(MichiAPI.pathSegment(pageID))")
                guard fetched.id == pageID, workspaceID == nil || fetched["workspaceId"].stringValue == workspaceID, fetched["deletedAt"].isNull else { throw NativeFailure("The page on screen changed. Reopen the assistant from that page.") }
                page = fetched
            }
            let known = await knownPages()
            context = try NativeSpacesContract.context(page: page, blockID: blockID, knownPages: known)
        }
        store.graphs = [graph]; store.hydrated = true
        guard let next = store.chat(for: candidate["nodeId"].stringValue) else { throw NativeFailure("The assistant conversation could not be loaded.") }
        next.refresh(graph: graph, node: graph.node(candidate["nodeId"].stringValue)!)
        next.metaAgentContext = context
        next.loaded = false
        guard await next.load() else { next.detach(); throw NativeFailure(next.error ?? "The assistant history could not be read.") }
        info = candidate; chat = next
    }
    private func freezeChat() {
        chat?.loaded = false; chat?.metaAgentContext = nil; chat?.detach(); chat = nil
    }
    private func knownPages() async -> [JSONValue] {
        var pages: [JSONValue] = []
        if let home = try? await api.request("/spaces-home"), !home["page"].id.isEmpty { pages.append(home["page"]) }
        if let workspaces = try? await api.request("/spaces-home/workspaces") {
            for workspace in workspaces["items"].arrayValue where !workspace["homePageId"].stringValue.isEmpty {
                pages.append(["id": workspace["homePageId"], "title": workspace["workspaceName"], "workspaceId": workspace["workspaceId"]])
            }
        }
        var cursor: String?, seen = Set<String>()
        for _ in 0..<5 {
            let path = "/spaces?limit=100" + (cursor.map { "&cursor=" + MichiAPI.queryComponent($0) } ?? "")
            guard let response = try? await api.request(path) else { break }
            pages += response["items"].arrayValue
            guard let next = response["nextCursor"].optionalString, !next.isEmpty, seen.insert(next).inserted, pages.count < 500 else { break }
            cursor = next
        }
        return pages
    }
    func reset() async { await change(path: path + "/reset", body: ["nodeId": info["nodeId"]]) }
    func activate(_ row: JSONValue) async {
        guard purpose == "spaces", history.contains(where: { $0["nodeId"] == row["nodeId"] }) else { return }
        await change(path: "/assistant/conversations/\(MichiAPI.pathSegment(row["nodeId"].stringValue))/activate", body: ["currentNodeId": info["nodeId"]])
    }
    private func change(path: String, body: JSONValue) async {
        guard !changing, !loading, !unknownChange, !info.isNull, chat?.busy != true else { return }
        changing = true; defer { changing = false }
        freezeChat()
        let accepted: JSONValue
        do { accepted = try await api.request(path, method: "POST", body: body) }
        catch {
            if !NativeSpacesContract.confirmedRejection(error) { unknownChange = true }
            self.error = error.localizedDescription
            return
        }
        // Once POST has succeeded, a follow-up GET failure is never a mutation
        // rejection. Keep the old composer detached until authoritative adoption.
        unknownChange = true
        do { try await adopt(accepted); unknownChange = false; error = nil }
        catch { freezeChat(); self.error = "The conversation changed, but could not be opened. Refresh to load the current assistant. " + error.localizedDescription }
    }
    func loadHistory(more: Bool = false) async {
        guard purpose == "spaces", !historyLoading, !more || nextCursor != nil else { return }
        historyLoading = true; defer { historyLoading = false }
        do {
            let cursor = more ? nextCursor : nil
            let response = try await api.request("/assistant/conversations?limit=5" + (cursor.map { "&cursor=" + MichiAPI.queryComponent($0) } ?? ""))
            guard case .array(let items) = response["items"], items.allSatisfy({ NativeSpacesContract.usableID($0["nodeId"].stringValue) && $0["title"].optionalString != nil }),
                  response["nextCursor"].isNull || response["nextCursor"].optionalString != nil else { throw NativeFailure("Assistant history could not be read.") }
            if more { let existing = Set(history.map { $0["nodeId"].stringValue }); history += items.filter { !existing.contains($0["nodeId"].stringValue) } }
            else { history = items }
            nextCursor = response["nextCursor"].optionalString; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func saveSettings(runtime: String, provider: String, model: String, reasoning: String) async -> Bool {
        guard !changing, !loading, !unknownChange, !info.isNull, chat?.busy != true, info["supportedRuntimes"].arrayValue.contains(.string(runtime)) else { return false }
        changing = true; defer { changing = false }
        let node = info["nodeId"]
        freezeChat()
        let result: JSONValue
        do {
            result = try await api.request("/assistant/settings", method: "PUT", body: ["nodeId": node, "runtimeId": .string(runtime), "providerId": provider.isEmpty ? .null : .string(provider), "modelId": model.isEmpty ? .null : .string(model), "reasoning": reasoning.isEmpty ? .null : .string(reasoning)])
        } catch {
            unknownChange = !NativeSpacesContract.confirmedRejection(error)
            self.error = error.localizedDescription; return false
        }
        unknownChange = true
        do {
            guard result["nodeId"] == node else { throw NativeFailure("The assistant settings response referred to another conversation.") }
            try await adopt(result); unknownChange = false; error = nil; return true
        } catch { freezeChat(); self.error = "The settings were accepted, but could not be refreshed. Refresh the assistant before sending. " + error.localizedDescription; return false }
    }
    func detach() { store.disconnectStreams(); chat?.detach() }
    func resume() { if !loading && !changing && !unknownChange { chat?.resumeIfNeeded() } }
}
