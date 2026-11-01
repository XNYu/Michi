#if DEBUG
import Foundation
import MichiCore

/// Flag-gated in-memory writes for isolated Digest Save as page and page-trash
/// UI checks. Mutates only synthetic fixture data. Unknown hosts stay with
/// FixtureURLProtocol (403); unknown routes return nil and fail closed (404).
enum DesignWriteFixtures {
    struct Response {
        let value: JSONValue
        var status = 200
    }

    static var args: [String] { ProcessInfo.processInfo.arguments }
    static var uitesting: Bool { args.contains("--uitesting") }
    static var digestSave: Bool { uitesting && args.contains("--preview-digest-save") }
    static var trashPages: Bool { uitesting && args.contains("--preview-trash-pages") }
    static var active: Bool { digestSave || trashPages }

    static let workspaceID = "ws-preview"
    static let digestID = "digest-preview"
    static let trashPageID = "page-trash-preview"
    static let trashGroupID = "del-page-preview-1"
    static let pagePreviewID = "page-preview"
    /// Design 34: Launch FAQ · deleted Oct 25 (relative to Design 10's clock).
    static let trashDeletedAt = DesignPreviewFixtures.nowMs - 6 * 86_400_000

    static let digestContent = "# A native home for Michi\n\nChats, pages and agent controls share a native interface.\n\n## Open Questions\n- How should we validate the next milestone?\n- What belongs in the first iPhone release?"

    private static let lock = NSRecursiveLock()
    private static var pages: [String: Page] = [:]
    private static var nextPage = 1
    private static var nextBlock = 1
    private static var seeded = false

    private struct Page {
        var id: String
        var workspaceID: String
        var title: String
        var revision: Int
        var blocks: [JSONValue]
        var parentID: String?
        var position: Int
        var updatedAt: Double
        var deletedAt: Double?
        var deletionGroupID: String?
        var purged: Bool
    }

    static func augment(_ graph: JSONValue) -> JSONValue {
        guard digestSave else { return graph }
        if graph["nodes"].arrayValue.contains(where: { exact($0.id, digestID) }) { return graph }
        var next = graph
        let digest: JSONValue = [
            "status": "idle", "generatedAt": 1000, "viewedAt": 0, "sources": ["n-preview"],
            "content": .string(digestContent)
        ]
        next["nodes"] = .array(next["nodes"].arrayValue + [[
            "id": .string(digestID), "workspace_id": .string(workspaceID), "tree_id": .null,
            "parent_node_id": .null, "kind": "digest", "title": "Native iOS direction",
            "digest": .string(digest.prettyPrinted), "deleted_at": .null, "purged_at": .null,
            "created_at": 1000
        ]])
        return next
    }

    static func response(path: String, method: String, url: URL, body: JSONValue) -> Response? {
        guard active else { return nil }
        seedIfNeeded()
        if trashPages, path == "/persistence/capabilities", method == "GET" {
            return Response(value: [
                "protocolVersion": 2,
                "authoritativeTurnPersistence": true,
                "explicitCommands": true,
                "digestReadMarkers": "v1",
                "conditionalTrashPurge": "v1"
            ])
        }
        if let workspace = workspacePagesPath(path) {
            if !exact(workspace, workspaceID) { return notFound("Workspace not found") }
            if path.hasSuffix("/pages/trash") {
                guard trashPages else { return nil }
                guard method == "GET" else { return nil }
                return listTrash()
            }
            if path.hasSuffix("/pages") {
                if method == "POST" {
                    guard digestSave else { return nil }
                    return createPage(body)
                }
                if method == "GET" { return listPages(url: url) }
                return nil
            }
        }
        if path.hasPrefix("/pages/") {
            let parts = path.split(separator: "/").map(String.init)
            guard parts.count >= 2, parts[0] == "pages" else { return nil }
            let pageID = parts[1]
            if parts.count == 3, parts[2] == "edits" {
                guard digestSave, method == "POST" else { return nil }
                return editPage(id: pageID, body: body)
            }
            if parts.count == 3, parts[2] == "restore" {
                guard trashPages else { return nil }
                guard method == "POST" else { return nil }
                return restorePage(id: pageID, body: body)
            }
            if parts.count == 3, parts[2] == "permanent" {
                guard trashPages else { return nil }
                guard method == "DELETE" else { return nil }
                return purgePage(id: pageID, body: body)
            }
            if parts.count == 2, method == "GET" {
                return getPage(id: pageID)
            }
        }
        return nil
    }

    private static func seedIfNeeded() {
        lock.lock(); defer { lock.unlock() }
        guard !seeded else { return }
        seeded = true
        if trashPages {
            pages[trashPageID] = Page(
                id: trashPageID, workspaceID: workspaceID, title: "Launch FAQ", revision: 1,
                blocks: [markdownBlock(id: "block-trash-0", rev: 1, text: "Questions from the native launch.")],
                parentID: nil, position: 2, updatedAt: trashDeletedAt,
                deletedAt: trashDeletedAt, deletionGroupID: trashGroupID, purged: false
            )
        }
    }

    private static func workspacePagesPath(_ path: String) -> String? {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 3, parts[0] == "workspaces", parts.last == "pages" || Array(parts.suffix(2)) == ["pages", "trash"] else { return nil }
        return parts[1]
    }

    private static func createPage(_ body: JSONValue) -> Response {
        if !ownKeys(body, ["title", "template", "parentId"]) {
            return invalid("Invalid request body")
        }
        guard case .string(let title) = body["title"] else { return invalid("Invalid title") }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, title.utf16.count <= 200 else {
            return invalid("Page title must contain 1 to 200 characters")
        }
        if !body["parentId"].isNull { return invalid("Save as page creates a top-level page") }
        let template = body["template"]
        if !template.isNull, template != "blank" { return invalid("Invalid template") }
        lock.lock(); defer { lock.unlock() }
        let live = pages.values.filter { exact($0.workspaceID, workspaceID) && $0.deletedAt == nil && !$0.purged }
        if live.count >= 2_000 { return Response(value: error("invalid", "Workspace page limit reached"), status: 409) }
        let id = "page-write-\(nextPage)"; nextPage += 1
        let blockID = "block-write-\(nextBlock)"; nextBlock += 1
        let now = millis()
        let page = Page(
            id: id, workspaceID: workspaceID, title: title, revision: 1,
            blocks: [markdownBlock(id: blockID, rev: 1, text: "")],
            parentID: nil, position: live.count + 3, updatedAt: now,
            deletedAt: nil, deletionGroupID: nil, purged: false
        )
        pages[id] = page
        return Response(value: pageDTO(page), status: 201)
    }

    private static func editPage(id: String, body: JSONValue) -> Response {
        if !ownKeys(body, ["revision", "ops"]) { return invalid("Invalid request body") }
        guard case .number(let revisionNumber) = body["revision"],
              revisionNumber.isFinite, revisionNumber.rounded(.towardZero) == revisionNumber,
              revisionNumber >= 1 else {
            return invalid("Invalid page revision")
        }
        let requested = Int(revisionNumber)
        guard case .array(let ops) = body["ops"], !ops.isEmpty, ops.count <= 50 else {
            return invalid("Invalid page edit operations")
        }
        lock.lock(); defer { lock.unlock() }
        guard var page = pages[id], exact(page.workspaceID, workspaceID), !page.purged, page.deletedAt == nil else {
            return notFound("Page not found")
        }
        if page.revision != requested {
            return Response(value: error("stale_revision", "Page revision changed"), status: 409)
        }
        let nextRevision = page.revision + 1
        for op in ops {
            switch op["op"].stringValue {
            case "update":
                let blockID = op["id"].stringValue
                guard !blockID.isEmpty, case .object = op["block"] else { return invalid("Invalid operation") }
                guard let index = page.blocks.firstIndex(where: { exact($0.id, blockID) }) else {
                    return invalid("Block \(blockID) does not exist")
                }
                if let expected = exactRevision(op["expectRev"]), expected != page.blocks[index]["rev"].intValue {
                    return invalid("Block \(blockID) revision changed")
                }
                if op["expectRev"] != .null && exactRevision(op["expectRev"]) == nil {
                    return invalid("Invalid expectRev")
                }
                let input = op["block"]
                guard input["type"] == "markdown", case .string = input["text"] else {
                    return invalid("Updated content must be valid and retain the block type")
                }
                var fields = input.objectValue
                fields.removeValue(forKey: "id")
                fields.removeValue(forKey: "rev")
                fields.removeValue(forKey: "sources")
                fields.removeValue(forKey: "edit")
                page.blocks[index] = .object(fields).merging([
                    "id": .string(blockID),
                    "rev": .number(Double(nextRevision))
                ])
            case "insert":
                guard case .object = op["block"], case .string(let after) = op["after"] else {
                    return invalid("insert takes {op, block, after}")
                }
                guard let index = page.blocks.firstIndex(where: { exact($0.id, after) }) else {
                    return invalid("Insertion anchor does not exist")
                }
                let input = op["block"]
                guard input["type"] == "markdown", case .string = input["text"] else {
                    return invalid("Invalid block content")
                }
                var fields = input.objectValue
                fields.removeValue(forKey: "id")
                fields.removeValue(forKey: "rev")
                fields.removeValue(forKey: "sources")
                fields.removeValue(forKey: "edit")
                let blockID = "block-write-\(nextBlock)"; nextBlock += 1
                let block = JSONValue.object(fields).merging([
                    "id": .string(blockID),
                    "rev": .number(Double(nextRevision))
                ])
                page.blocks.insert(block, at: index + 1)
            default:
                return invalid("Invalid page edit operations")
            }
        }
        page.revision = nextRevision
        page.updatedAt = millis()
        pages[id] = page
        return Response(value: [
            "page": pageDTO(page),
            "changes": ["applied": [], "rejected": []]
        ])
    }

    private static func getPage(id: String) -> Response? {
        lock.lock(); defer { lock.unlock() }
        guard let page = pages[id] else { return nil }
        if page.purged || page.deletedAt != nil { return notFound("Page not found") }
        return Response(value: pageDTO(page))
    }

    private static func listPages(url: URL) -> Response {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let parent = query.first(where: { $0.name == "parentId" })?.value
        lock.lock(); defer { lock.unlock() }
        var items: [JSONValue] = []
        if parent == nil || parent == "null" {
            items.append([
                "id": .string(pagePreviewID), "workspaceId": .string(workspaceID),
                "title": "Native iOS roadmap", "revision": 1, "parentId": .null,
                "updatedAt": 1, "pendingProposals": 0
            ])
        }
        let live = pages.values
            .filter { exact($0.workspaceID, workspaceID) && $0.deletedAt == nil && !$0.purged }
            .sorted { $0.position < $1.position }
        for page in live {
            if parent == nil {
                items.append(summary(page))
            } else if parent == "null", page.parentID == nil {
                items.append(summary(page))
            } else if let parent, let parentID = page.parentID, exact(parentID, parent) {
                items.append(summary(page))
            }
        }
        return Response(value: ["items": .array(items), "nextCursor": .null])
    }

    private static func listTrash() -> Response {
        lock.lock(); defer { lock.unlock() }
        let groups = pages.values
            .filter { exact($0.workspaceID, workspaceID) && $0.deletedAt != nil && !$0.purged && $0.deletionGroupID != nil }
            .sorted { ($0.deletedAt ?? 0) > ($1.deletedAt ?? 0) }
            .map { page -> JSONValue in
                [
                    "deletionGroupId": .string(page.deletionGroupID ?? ""),
                    "deletedAt": .number(page.deletedAt ?? 0),
                    "root": pageDTO(page),
                    "pages": [summary(page)],
                    "databases": []
                ]
            }
        return Response(value: ["items": .array(groups), "nextCursor": .null])
    }

    private static func restorePage(id: String, body: JSONValue) -> Response {
        guard isEmptyBody(body) else { return invalid("Invalid request body") }
        lock.lock(); defer { lock.unlock() }
        guard let page = pages[id], exact(page.workspaceID, workspaceID), !page.purged,
              page.deletedAt != nil, let group = page.deletionGroupID, !group.isEmpty else {
            return notFound("Deleted page not found")
        }
        var restored: [String] = []
        for (key, var member) in pages where exact(member.workspaceID, workspaceID)
            && member.deletionGroupID.map({ exact($0, group) }) == true
            && member.deletedAt != nil && !member.purged {
            member.deletedAt = nil
            member.deletionGroupID = nil
            member.updatedAt = millis()
            pages[key] = member
            restored.append(member.id)
        }
        guard restored.contains(where: { exact($0, id) }) else { return notFound("Deleted page not found") }
        return Response(value: ["restored": .number(Double(restored.count))])
    }

    private static func purgePage(id: String, body: JSONValue) -> Response {
        guard isEmptyBody(body) else { return invalid("Invalid request body") }
        lock.lock(); defer { lock.unlock() }
        guard let page = pages[id], exact(page.workspaceID, workspaceID), !page.purged,
              page.deletedAt != nil, let group = page.deletionGroupID, !group.isEmpty else {
            return notFound("Deleted page not found")
        }
        var purged: [String] = []
        for (key, var member) in pages where exact(member.workspaceID, workspaceID)
            && member.deletionGroupID.map({ exact($0, group) }) == true
            && member.deletedAt != nil && !member.purged {
            member.purged = true
            member.deletedAt = nil
            member.deletionGroupID = nil
            pages[key] = member
            purged.append(member.id)
        }
        guard purged.contains(where: { exact($0, id) }) else { return notFound("Deleted page not found") }
        return Response(value: ["purged": .number(Double(purged.count))])
    }

    private static func pageDTO(_ page: Page) -> JSONValue {
        [
            "id": .string(page.id),
            "workspaceId": .string(page.workspaceID),
            "parentId": page.parentID.map(JSONValue.string) ?? .null,
            "position": .number(Double(page.position)),
            "title": .string(page.title),
            "color": .null,
            "updatedAt": .number(page.updatedAt),
            "updatedBy": "user",
            "pendingProposals": 0,
            "helperNodeId": .null,
            "revision": .number(Double(page.revision)),
            "viewVersion": .number(Double(page.revision)),
            "blocks": .array(page.blocks)
        ]
    }

    private static func summary(_ page: Page) -> JSONValue {
        [
            "id": .string(page.id),
            "workspaceId": .string(page.workspaceID),
            "parentId": page.parentID.map(JSONValue.string) ?? .null,
            "position": .number(Double(page.position)),
            "title": .string(page.title),
            "color": .null,
            "updatedAt": .number(page.updatedAt),
            "updatedBy": "user",
            "pendingProposals": 0,
            "helperNodeId": .null
        ]
    }

    private static func markdownBlock(id: String, rev: Int, text: String) -> JSONValue {
        ["id": .string(id), "rev": .number(Double(rev)), "type": "markdown", "text": .string(text)]
    }

    private static func exact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    private static func exactRevision(_ value: JSONValue) -> Int? {
        guard case .number(let number) = value, number.isFinite, number.rounded(.towardZero) == number,
              number >= 1, number <= 9_007_199_254_740_991 else { return nil }
        return Int(number)
    }

    private static func ownKeys(_ body: JSONValue, _ allowed: [String]) -> Bool {
        if body.isNull { return allowed.isEmpty }
        guard case .object(let object) = body else { return false }
        return object.keys.allSatisfy(allowed.contains)
    }

    private static func isEmptyBody(_ body: JSONValue) -> Bool {
        body.isNull || (body.objectValue.isEmpty && {
            if case .object = body { return true }
            return false
        }())
    }

    private static func millis() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    private static func error(_ code: String, _ message: String) -> JSONValue {
        ["error": ["code": .string(code), "message": .string(message)]]
    }
    private static func invalid(_ message: String) -> Response { Response(value: error("invalid", message), status: 400) }
    private static func notFound(_ message: String) -> Response { Response(value: error("not_found", message), status: 404) }
}
#endif
