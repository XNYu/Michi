import Foundation
import Combine
import CryptoKit
import MichiCore

/// Opaque identifiers and saved text compare byte for byte. Swift `==` on
/// String uses canonical equivalence, so two distinct server ids (an NFC and
/// an NFD spelling, say) would otherwise match each other.
private func digestExportExact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

/// The page a digest export created, known by its exact server identity.
struct NativeDigestExportedPage: Identifiable, Hashable {
    let id: String
    let workspaceID: String
    let title: String

    static func == (a: Self, b: Self) -> Bool {
        digestExportExact(a.id, b.id) && digestExportExact(a.workspaceID, b.workspaceID) && digestExportExact(a.title, b.title)
    }
    func hash(into hasher: inout Hasher) {
        hasher.combine(Data(id.utf8)); hasher.combine(Data(workspaceID.utf8))
    }
}

/// What one save will write: a title and the digest's visible markdown, split
/// losslessly into page-block-sized parts. Nothing is truncated or invented.
struct NativeDigestPagePlan: Equatable {
    let digestID: String
    let generatedAt: Double
    let title: String
    let parts: [String]
    let contentSHA256: String
}

enum NativeDigestPageExport {
    /// shared/src/pages/blocks.ts PAGE_BLOCK_LIMITS.text, a JavaScript length (UTF-16 units).
    static let blockTextLimit = 2_000
    /// shared/src/pages/types.ts PAGE_LIMITS.title, also UTF-16 units.
    static let titleLimit = 200
    /// A client bound on writes per save. Longer digests are refused, never cut.
    static let maxParts = 40

    /// The web export's text: sentinel markers removed (the same projection the
    /// digest watermark uses), surrounding whitespace trimmed.
    static func visibleMarkdown(_ content: String) -> String {
        DigestSourceSnapshot.visibleAssistant(content).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func validatedTitle(_ input: String) throws -> String {
        let title = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw NativeFailure("Enter a title for the page.") }
        let length = title.utf16.count
        guard length <= titleLimit else {
            throw NativeFailure("Page titles can have at most \(titleLimit) characters; this one has \(length). Shorten it. Michi won't cut it for you.")
        }
        return title
    }

    /// Same rule as NativeDigestReadModel's receipt: a read marker for this generation.
    static func isRead(_ digest: JSONValue) -> Bool {
        let value = digest["digest"].parsedJSON
        guard let generated = value["generatedAt"].featureOptionalNumber,
              let viewed = value["viewedAt"].featureOptionalNumber else { return false }
        return viewed.isFinite && viewed > 0 && viewed >= generated
    }

    static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func plan(digest: JSONValue, workspaceID: String, title: String) throws -> NativeDigestPagePlan {
        guard !digest.id.isEmpty, digestExportExact(digest["workspace_id"].stringValue, workspaceID),
              digest["kind"] == "digest", digest["deleted_at"].isNull, digest["purged_at"].isNull else {
            throw NativeFailure("This digest is no longer available.")
        }
        let value = digest["digest"].parsedJSON
        guard value["status"] == "idle", let generated = value["generatedAt"].featureOptionalNumber,
              generated.isFinite, generated >= 0 else {
            throw NativeFailure("Wait for this digest to finish before saving it.")
        }
        let checkedTitle = try validatedTitle(title)
        let visible = visibleMarkdown(value["content"].stringValue)
        let pieces = try parts(visible)
        let catalog = try NativeBlockCatalog()
        for piece in pieces { try catalog.validate(["type": "markdown", "text": .string(piece)]) }
        return NativeDigestPagePlan(digestID: digest.id, generatedAt: generated, title: checkedTitle, parts: pieces, contentSHA256: sha256(visible))
    }

    /// Splits only at a blank line between two paragraphs, outside code and math
    /// fences, and only where the next paragraph starts flush left. Joining the
    /// parts with a blank line reproduces the input byte for byte; anything that
    /// cannot be split that way is refused.
    static func parts(_ text: String) throws -> [String] {
        guard !text.isEmpty else { throw NativeFailure("This digest has no text to save.") }
        if text.utf16.count <= blockTextLimit { return [text] }
        var result: [String] = [], current = ""
        for unit in try units(text) {
            guard unit.utf16.count <= blockTextLimit else {
                throw NativeFailure("One paragraph or code block in this digest is longer than \(blockTextLimit) characters, the limit for a page block. Michi won't cut it, so nothing was saved.")
            }
            if current.isEmpty { current = unit }
            else if current.utf16.count + 2 + unit.utf16.count <= blockTextLimit { current += "\n\n" + unit }
            else { result.append(current); current = unit }
        }
        if !current.isEmpty { result.append(current) }
        guard result.count <= maxParts else {
            throw NativeFailure("This digest needs more than \(maxParts) page blocks. Nothing was saved.")
        }
        guard result.joined(separator: "\n\n").utf8.elementsEqual(text.utf8) else {
            throw NativeFailure("This digest couldn't be divided into page blocks without changing it. Nothing was saved.")
        }
        return result
    }

    private struct Fence { let marker: Unicode.Scalar; let count: Int }

    private static func units(_ text: String) throws -> [String] {
        let scalars = Array(text.unicodeScalars)
        var cuts: [Int] = [], fence: Fence?, math = false, start = 0
        while start < scalars.count {
            var end = start
            while end < scalars.count && scalars[end] != "\n" { end += 1 }
            let line = Array(scalars[start..<end])
            try classify(line, fence: &fence, math: &math)
            if fence == nil, !math, end + 2 < scalars.count, scalars[end + 1] == "\n",
               let last = line.last, !last.properties.isWhitespace, !scalars[end + 2].properties.isWhitespace {
                cuts.append(end)
            }
            start = end + 1
        }
        var units: [String] = [], from = 0
        for cut in cuts {
            units.append(String(String.UnicodeScalarView(scalars[from..<cut])))
            from = cut + 2
        }
        units.append(String(String.UnicodeScalarView(scalars[from..<scalars.count])))
        return units
    }

    /// Tracks fenced code and `$$` math blocks. Raw HTML blocks and link or
    /// footnote definitions would render differently once separated, so a
    /// digest that needs splitting and contains them is refused.
    private static func classify(_ line: [Unicode.Scalar], fence: inout Fence?, math: inout Bool) throws {
        let indent = line.prefix { $0 == " " }.count
        let rest = Array(line.dropFirst(min(indent, 3)))
        if let open = fence {
            let run = rest.prefix { $0 == open.marker }.count
            if indent <= 3, run >= open.count, rest.dropFirst(run).allSatisfy({ $0.properties.isWhitespace }) { fence = nil }
            return
        }
        if math {
            if dollarPairs(line) % 2 == 1 { math = false }
            return
        }
        guard indent <= 3, let first = rest.first else { return }
        if first == "`" || first == "~" {
            let run = rest.prefix { $0 == first }.count
            if run >= 3 && !(first == "`" && rest.dropFirst(run).contains("`")) {
                fence = Fence(marker: first, count: run); return
            }
        }
        if first == "$", rest.count >= 2, rest[1] == "$", dollarPairs(rest) % 2 == 1 { math = true; return }
        if first == "<", rest.count > 1, isHTMLStart(rest[1]), !isAutolink(rest) {
            throw NativeFailure("This digest contains raw HTML. Michi can't split it into page blocks without risking a change, so nothing was saved.")
        }
        if first == "[", let close = rest.firstIndex(of: "]"), close + 1 < rest.count, rest[close + 1] == ":" {
            throw NativeFailure("This digest uses reference-style links or footnotes. Splitting it into page blocks would break them, so nothing was saved.")
        }
    }

    private static func dollarPairs(_ line: [Unicode.Scalar]) -> Int {
        var count = 0, index = 0
        while index + 1 < line.count {
            if line[index] == "$" && line[index + 1] == "$" { count += 1; index += 2 } else { index += 1 }
        }
        return count
    }
    private static func isHTMLStart(_ scalar: Unicode.Scalar) -> Bool {
        scalar == "/" || scalar == "!" || scalar == "?" || (scalar.isASCII && scalar.properties.isAlphabetic)
    }
    /// `<scheme:...>` autolinks are ordinary inline text, not HTML blocks.
    private static func isAutolink(_ rest: [Unicode.Scalar]) -> Bool {
        let digits: ClosedRange<Unicode.Scalar> = "0"..."9"
        var index = 1
        while index < rest.count, rest[index].isASCII,
              rest[index].properties.isAlphabetic || digits.contains(rest[index]) || "+.-".unicodeScalars.contains(rest[index]) {
            index += 1
        }
        return index >= 3 && index < rest.count && rest[index] == ":"
    }

    /// The fresh snapshot must still show exactly the digest generation on screen.
    static func requireCurrent(_ snapshot: JSONValue, workspaceID: String, displayed: JSONValue) throws {
        let workspace = snapshot["workspace"]
        guard digestExportExact(workspace.id, workspaceID), workspace["deleted_at"].isNull, workspace["archived_at"].isNull,
              case .array(let nodes) = snapshot["nodes"] else {
            throw NativeFailure("This workspace could not be read, or it is archived or in Trash. Nothing was saved.")
        }
        let matches = nodes.filter { digestExportExact($0.id, displayed.id) }
        guard matches.count == 1, let node = matches.first, digestExportExact(node["workspace_id"].stringValue, workspaceID),
              node["kind"] == "digest", node["deleted_at"].isNull, node["purged_at"].isNull else {
            throw NativeFailure("This digest is no longer available. Nothing was saved.")
        }
        let fresh = node["digest"].parsedJSON, shown = displayed["digest"].parsedJSON
        guard fresh["status"] == "idle" else { throw NativeFailure("This digest is being rebuilt. Nothing was saved.") }
        guard fresh["generatedAt"] == shown["generatedAt"],
              digestExportExact(fresh["content"].stringValue, shown["content"].stringValue) else {
            throw NativeFailure("This digest changed on another device. Review the current version before saving it. Nothing was saved.")
        }
    }

    /// Codes the client raises before anything is sent.
    private static let unsentCodes: Set<String> = [MichiAPIError.Code.invalidConfiguration, MichiAPIError.Code.invalidPath,
                                                   MichiAPIError.Code.invalidRequest, MichiAPIError.Code.insecureURL]

    /// Page creation validates and refuses (400 invalid, 404 workspace, 409 page
    /// limit) before its transaction; ingress/auth refusals never reach it.
    /// Anything else, including a lost response, may have created the page.
    static func createWasRejected(_ error: Error) -> Bool {
        guard let failure = error as? MichiAPIError else { return false }
        guard let status = failure.statusCode else { return unsentCodes.contains(failure.code ?? "") }
        return [400, 401, 403, 404, 409, 413, 422].contains(status)
            && failure.code != MichiAPIError.Code.htmlResponse && failure.code != MichiAPIError.Code.invalidResponse
    }

    /// The same exact pre-write errors FeaturePageModel trusts for /edits.
    static func editWasRejected(_ error: Error) -> Bool {
        guard let failure = error as? MichiAPIError else { return false }
        if failure.statusCode == nil { return unsentCodes.contains(failure.code ?? "") }
        return (failure.statusCode == 409 && failure.code == "stale_revision") || (failure.statusCode == 400 && failure.code == "invalid")
    }

    struct CreatedPage {
        let id: String
        let revision: Int
        let blockID: String
        let blockRevision: Int
    }

    /// A new blank page: exact workspace and title, and only the template's empty markdown block.
    static func createdPage(_ payload: JSONValue, workspaceID: String, title: String) throws -> CreatedPage {
        let page = try featureRequirePage(payload)
        guard !page.id.isEmpty, digestExportExact(page["workspaceId"].stringValue, workspaceID),
              digestExportExact(page["title"].stringValue, title),
              let revision = exactRevision(page["revision"]), revision >= 1,
              case .array(let blocks) = page["blocks"], blocks.count == 1, let block = blocks.first, !block.id.isEmpty,
              block["type"] == "markdown", block["text"] == "", let blockRevision = exactRevision(block["rev"]), blockRevision >= 1 else {
            throw NativeFailure("The server's response did not confirm a new blank page.")
        }
        return CreatedPage(id: page.id, revision: revision, blockID: block.id, blockRevision: blockRevision)
    }

    struct ConfirmedEdit {
        let revision: Int
        let blockID: String
        let blockIDs: [String]
    }

    /// Confirms one write: the exact page, a newer revision, and the exact text,
    /// either replacing the template block or inserted directly after `after`.
    static func confirmEdit(_ payload: JSONValue, pageID: String, workspaceID: String, previousRevision: Int,
                            previousIDs: [String], input: JSONValue, text: String, replacing: String?, after: String?) throws -> ConfirmedEdit {
        if let rejected = payload["changes"]["rejected"].arrayValue.first {
            throw NativeFailure(rejected["message"].optionalString ?? "The page rejected this change.")
        }
        let page = try featureRequirePage(payload)
        guard digestExportExact(page.id, pageID), digestExportExact(page["workspaceId"].stringValue, workspaceID),
              let revision = exactRevision(page["revision"]), revision >= previousRevision + 1,
              case .array(let blocks) = page["blocks"] else {
            throw NativeFailure("The server returned a different or malformed page.")
        }
        let ids = blocks.map(\.id)
        guard ids.allSatisfy({ !$0.isEmpty }), Set(ids.map { Data($0.utf8) }).count == ids.count else {
            throw NativeFailure("The server returned a malformed page.")
        }
        func matches(_ block: JSONValue) -> Bool {
            block["type"] == "markdown" && digestExportExact(block["text"].stringValue, text) && featureBlockInput(from: block) == input
        }
        if let replacing {
            guard ids.count == previousIDs.count, let index = ids.firstIndex(where: { digestExportExact($0, replacing) }),
                  matches(blocks[index]) else { throw NativeFailure("The response did not confirm the saved text.") }
            return ConfirmedEdit(revision: revision, blockID: replacing, blockIDs: ids)
        }
        let added = ids.indices.filter { index in !previousIDs.contains { digestExportExact($0, ids[index]) } }
        guard added.count == 1, let index = added.first, matches(blocks[index]),
              let after, let anchor = ids.firstIndex(where: { digestExportExact($0, after) }), index == anchor + 1 else {
            throw NativeFailure("The response did not confirm the inserted text.")
        }
        return ConfirmedEdit(revision: revision, blockID: ids[index], blockIDs: ids)
    }

    private static func exactRevision(_ value: JSONValue) -> Int? {
        guard case .number(let number) = value, number.isFinite, number.rounded(.towardZero) == number,
              number >= 0, number <= 9_007_199_254_740_991 else { return nil }
        return Int(number)
    }
}

/// Persisted before the create request and kept until the outcome is known,
/// so a lost response can never become an automatic second page.
struct NativeDigestPageExportRecord: Codable, Equatable {
    var version = 1
    let token: String
    let connection: String
    let credential: String
    let workspaceID: String
    let digestID: String
    let generatedAt: Double
    let contentSHA256: String
    let title: String
    let partCount: Int
    let startedAt: Double
    var pageID: String?
    var savedParts: Int
    /// A part whose write was sent and not yet confirmed.
    var inFlightPart: Int?
}

/// One record per connection, credential, workspace and digest.
final class NativeDigestPageExportJournal {
    private static let lock = NSLock()
    private static let maxBytes = 64 * 1024
    let directory: URL?

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Michi/DigestPageExports.v1", isDirectory: true)
    }

    func load(api: MichiAPI, workspaceID: String, digestID: String) throws -> NativeDigestPageExportRecord? {
        Self.lock.lock(); defer { Self.lock.unlock() }
        return try read(api: api, workspaceID: workspaceID, digestID: digestID)
    }
    func reserve(_ record: NativeDigestPageExportRecord, api: MichiAPI) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard try read(api: api, workspaceID: record.workspaceID, digestID: record.digestID) == nil else {
            throw NativeFailure("An earlier save of this digest must be reviewed first.")
        }
        try write(record, api: api)
    }
    func update(_ record: NativeDigestPageExportRecord, api: MichiAPI) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let current = try read(api: api, workspaceID: record.workspaceID, digestID: record.digestID),
              digestExportExact(current.token, record.token) else {
            throw NativeFailure("This save's local record changed. Nothing more was sent.")
        }
        try write(record, api: api)
    }
    func clear(_ record: NativeDigestPageExportRecord, api: MichiAPI) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard let current = try read(api: api, workspaceID: record.workspaceID, digestID: record.digestID) else { return }
        guard digestExportExact(current.token, record.token) else { throw NativeFailure("A different save record is pending. It has been kept.") }
        try FileManager.default.removeItem(at: fileURL(api: api, workspaceID: record.workspaceID, digestID: record.digestID))
    }

    func fileURL(api: MichiAPI, workspaceID: String, digestID: String) throws -> URL {
        guard let directory else { throw NativeFailure("Local save recovery storage is unavailable.") }
        let scope = try JSONEncoder().encode([api.baseURL.absoluteString, api.credentialIdentityFingerprint, workspaceID, digestID])
        return directory.appendingPathComponent(SHA256.hash(data: scope).map { String(format: "%02x", $0) }.joined() + ".json")
    }

    private func write(_ record: NativeDigestPageExportRecord, api: MichiAPI) throws {
        guard let directory else { throw NativeFailure("Local save recovery storage is unavailable.") }
        let data = try JSONEncoder().encode(record)
        guard data.count <= Self.maxBytes else { throw NativeFailure("The save could not be recorded safely.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = try fileURL(api: api, workspaceID: record.workspaceID, digestID: record.digestID)
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }; try handle.synchronize()
        guard let stored = try read(api: api, workspaceID: record.workspaceID, digestID: record.digestID),
              digestExportExact(stored.token, record.token), stored == record else {
            throw NativeFailure("The save record could not be verified.")
        }
    }

    private func read(api: MichiAPI, workspaceID: String, digestID: String) throws -> NativeDigestPageExportRecord? {
        let url = try fileURL(api: api, workspaceID: workspaceID, digestID: digestID)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size, size.intValue <= Self.maxBytes else { throw NativeFailure("The saved export record cannot be read safely.") }
        let record = try JSONDecoder().decode(NativeDigestPageExportRecord.self, from: Data(contentsOf: url))
        guard record.version == 1, !record.token.isEmpty,
              digestExportExact(record.connection, api.baseURL.absoluteString),
              digestExportExact(record.credential, api.credentialIdentityFingerprint),
              digestExportExact(record.workspaceID, workspaceID), digestExportExact(record.digestID, digestID),
              (1...NativeDigestPageExport.maxParts).contains(record.partCount),
              (0...record.partCount).contains(record.savedParts),
              record.pageID.map({ !$0.isEmpty }) ?? true,
              record.inFlightPart.map({ record.pageID != nil && (0..<record.partCount).contains($0) }) ?? true else {
            throw NativeFailure("The saved export record's identity cannot be verified.")
        }
        return record
    }
}

/// Saves the visible digest as a new top-level page: one create, then one
/// write per part. Each write is journaled first, never retried, and Stop
/// takes effect only between requests. A failure after the page exists opens
/// that page with the error instead of hiding a partial result.
@MainActor final class NativeDigestPageExportModel: ObservableObject {
    let api: MichiAPI
    let workspaceID: String
    @Published private(set) var busy = false
    @Published private(set) var writing = false
    @Published private(set) var progress: String?
    @Published private(set) var stopRequested = false
    @Published private(set) var error: String?
    @Published private(set) var notice: String?
    @Published private(set) var pending: NativeDigestPageExportRecord?
    /// A record exists but cannot be verified; saving stays blocked.
    @Published private(set) var pendingUnreadable: String?
    @Published private(set) var candidates: [NativeDigestExportedPage] = []
    @Published var openedPage: NativeDigestExportedPage?
    private let journal: NativeDigestPageExportJournal
    private let insertionJournal: NativeBlockInsertionJournal
    private let clock: () -> Date
    private var digestID: String?

    init(api: MichiAPI, workspaceID: String, journal: NativeDigestPageExportJournal = NativeDigestPageExportJournal(),
         insertionJournal: NativeBlockInsertionJournal = NativeBlockInsertionJournal(), clock: @escaping () -> Date = Date.init) {
        self.api = api; self.workspaceID = workspaceID
        self.journal = journal; self.insertionJournal = insertionJournal; self.clock = clock
    }

    var canStop: Bool { writing && !stopRequested }
    var isBlocked: Bool { pending != nil || pendingUnreadable != nil }

    /// Reads this digest's local record. File access only; never a request.
    func load(digestID next: String?) {
        guard !busy else { return }
        let same: Bool
        switch (digestID, next) {
        case (nil, nil): same = true
        case let (current?, next?): same = digestExportExact(current, next)
        default: same = false
        }
        if !same { error = nil; notice = nil }
        digestID = next; candidates = []; pendingUnreadable = nil
        guard let next, !next.isEmpty else { pending = nil; return }
        do { pending = try journal.load(api: api, workspaceID: workspaceID, digestID: next) }
        catch {
            pending = nil
            pendingUnreadable = "A saved export record for this digest can't be verified, so saving is blocked to avoid a duplicate page. " + featureErrorMessage(error)
        }
    }

    func requestStop() {
        guard writing, !stopRequested else { return }
        stopRequested = true
        notice = "Stopping after the current request…"
    }

    @discardableResult func save(digest: JSONValue, title: String) async -> Bool {
        guard !busy else { return false }
        load(digestID: digest.id)
        error = nil; notice = nil; candidates = []
        if let pendingUnreadable { error = pendingUnreadable; return false }
        guard pending == nil else { error = "An earlier save of this digest hasn't been resolved. Review it first."; return false }
        let plan: NativeDigestPagePlan
        do { plan = try NativeDigestPageExport.plan(digest: digest, workspaceID: workspaceID, title: title) }
        catch { self.error = featureErrorMessage(error); return false }

        busy = true; writing = true; stopRequested = false; progress = "Checking the saved digest…"
        defer { busy = false; writing = false; stopRequested = false; progress = nil }
        do {
            let snapshot = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))")
            try NativeDigestPageExport.requireCurrent(snapshot, workspaceID: workspaceID, displayed: digest)
        } catch {
            self.error = featureErrorMessage(error)
            return false
        }
        if stopRequested { notice = "Stopped. Nothing was saved."; return false }

        var record = NativeDigestPageExportRecord(
            token: UUID().uuidString, connection: api.baseURL.absoluteString, credential: api.credentialIdentityFingerprint,
            workspaceID: workspaceID, digestID: plan.digestID, generatedAt: plan.generatedAt, contentSHA256: plan.contentSHA256,
            title: plan.title, partCount: plan.parts.count, startedAt: (clock().timeIntervalSince1970 * 1000).rounded(),
            pageID: nil, savedParts: 0, inFlightPart: nil)
        do { try journal.reserve(record, api: api) }
        catch { self.error = "This device could not record the save, so nothing was sent. " + featureErrorMessage(error); return false }
        pending = record

        progress = "Creating the page…"
        let created: JSONValue
        do {
            created = try await api.request("/workspaces/\(MichiAPI.pathSegment(workspaceID))/pages", method: "POST",
                                             body: ["title": .string(plan.title), "template": "blank"])
        } catch {
            if NativeDigestPageExport.createWasRejected(error) {
                do { try journal.clear(record, api: api); pending = nil } catch { reloadPending() }
                self.error = featureErrorMessage(error)
            } else {
                self.error = "The page may have been created, but Michi didn't receive a confirmation. It won't be created again automatically. Check Pages before saving this digest again."
            }
            return false
        }
        let page: NativeDigestPageExport.CreatedPage
        do { page = try NativeDigestPageExport.createdPage(created, workspaceID: workspaceID, title: plan.title) }
        catch {
            self.error = "Michi couldn't confirm the new page from the server's response, so nothing more was written. Check Pages before saving this digest again."
            return false
        }
        let exported = NativeDigestExportedPage(id: page.id, workspaceID: workspaceID, title: plan.title)
        record.pageID = page.id
        do { try journal.update(record, api: api); pending = record }
        catch {
            return stopWithPage(exported, error: "The page was created, but this device couldn't record it, so no text was added. " + featureErrorMessage(error))
        }

        var revision = page.revision, blockIDs = [page.blockID], anchor = page.blockID
        let total = plan.parts.count
        for (index, part) in plan.parts.enumerated() {
            if stopRequested {
                return stopWithPage(exported, notice: "Stopped after saving \(index) of \(total) parts. The rest of the digest was not added to the page.")
            }
            progress = total == 1 ? "Saving the digest text…" : "Saving part \(index + 1) of \(total)…"
            let input: JSONValue = ["type": "markdown", "text": .string(part)]
            // The blank template's empty block takes the first part, so the page has no stray empty block.
            let op: JSONValue = index == 0
                ? featureBlockUpdateOperation(id: page.blockID, expectRev: page.blockRevision, input: input)
                : ["op": "insert", "block": input, "after": .string(anchor)]
            let body: JSONValue = ["revision": .number(Double(revision)), "ops": [op]]
            record.inFlightPart = index
            do { try journal.update(record, api: api); pending = record }
            catch { return stopWithPage(exported, error: "This device couldn't record the next part, so nothing more was sent. " + featureErrorMessage(error)) }
            let insertion = index == 0 ? nil : NativeBlockInsertion(token: UUID().uuidString, workspaceID: workspaceID, body: body)
            if let insertion {
                do { try insertionJournal.reserve(insertion, api: api, pageID: page.id) }
                catch {
                    settle(&record, saved: index)
                    return stopWithPage(exported, error: featureErrorMessage(error))
                }
            }
            let result: JSONValue
            do {
                defer { if let insertion { insertionJournal.finish(insertion) } }
                result = try await api.request("/pages/\(MichiAPI.pathSegment(page.id))/edits", method: "POST", body: body)
            } catch {
                if NativeDigestPageExport.editWasRejected(error) {
                    if let insertion { try? insertionJournal.clear(insertion, api: api, pageID: page.id) }
                    settle(&record, saved: index)
                    return stopWithPage(exported, error: "Part \(index + 1) of \(total) wasn't saved: \(featureErrorMessage(error)) Michi stopped; the page has the first \(index).")
                }
                return stopWithPage(exported, error: "Part \(index + 1) of \(total) may or may not have been saved. It won't be sent again. Review the page before adding anything.")
            }
            let confirmed: NativeDigestPageExport.ConfirmedEdit
            do {
                confirmed = try NativeDigestPageExport.confirmEdit(result, pageID: page.id, workspaceID: workspaceID, previousRevision: revision,
                    previousIDs: blockIDs, input: input, text: part, replacing: index == 0 ? page.blockID : nil, after: index == 0 ? nil : anchor)
            } catch {
                return stopWithPage(exported, error: "Michi couldn't confirm part \(index + 1) of \(total). It won't be sent again. Review the page before adding anything. " + featureErrorMessage(error))
            }
            if let insertion {
                do { try insertionJournal.clear(insertion, api: api, pageID: page.id) }
                catch {
                    settle(&record, saved: index + 1)
                    return stopWithPage(exported, error: "Part \(index + 1) of \(total) was saved, but its local record couldn't be cleared, so Michi stopped. " + featureErrorMessage(error))
                }
            }
            revision = confirmed.revision; blockIDs = confirmed.blockIDs; anchor = confirmed.blockID
            settle(&record, saved: index + 1)
        }
        do { try journal.clear(record, api: api); pending = nil }
        catch { reloadPending() }
        notice = "Saved as “\(plan.title)”."
        openedPage = exported
        return true
    }

    /// Read-only: lists top-level pages with the recorded title created around
    /// the save. Never creates, resolves or changes anything.
    func checkPendingCreation() async {
        guard !busy, let record = pending, record.pageID == nil else { return }
        busy = true; progress = "Checking Pages…"; error = nil; notice = nil; candidates = []
        defer { busy = false; progress = nil }
        var found: [NativeDigestExportedPage] = [], cursor: String?, complete = false
        do {
            for _ in 0..<20 {
                let path = "/workspaces/\(MichiAPI.pathSegment(workspaceID))/pages"
                    + FeatureAPI.query([("parentId", "null"), ("limit", "100"), ("cursor", cursor)])
                let result = try await api.request(path)
                guard case .array(let items) = result["items"] else { throw NativeFailure("Pages could not be read.") }
                for item in items where !item.id.isEmpty && digestExportExact(item["workspaceId"].stringValue, workspaceID)
                    && digestExportExact(item["title"].stringValue, record.title)
                    && (item["updatedAt"].featureOptionalNumber ?? 0) >= record.startedAt - 300_000 {
                    found.append(NativeDigestExportedPage(id: item.id, workspaceID: workspaceID, title: record.title))
                }
                cursor = result["nextCursor"].optionalString.flatMap { $0.isEmpty ? nil : $0 }
                if cursor == nil { complete = true; break }
            }
        } catch { self.error = featureErrorMessage(error); return }
        candidates = found
        if found.isEmpty {
            notice = complete ? "No top-level page with this title has changed since the save. It may not have been created. Dismiss the record to allow saving again."
                : "Some pages could not be checked. Look in Pages before saving again."
        } else {
            notice = "Found \(found.count) page\(found.count == 1 ? "" : "s") with this title. Open \(found.count == 1 ? "it" : "them") to review; checking changes nothing."
        }
    }

    func openPendingPage() {
        guard let record = pending, let pageID = record.pageID else { return }
        openedPage = NativeDigestExportedPage(id: pageID, workspaceID: workspaceID, title: record.title)
    }

    /// Explicit, confirmed by the user: forgets this device's record so the
    /// digest can be saved again. It never deletes or changes a page.
    func dismissPending() {
        guard !busy, let record = pending else { return }
        do {
            try journal.clear(record, api: api)
            pending = nil; candidates = []; error = nil
            notice = "The record was dismissed. Saving again creates a new page."
        } catch { self.error = featureErrorMessage(error); reloadPending() }
    }

    private func settle(_ record: inout NativeDigestPageExportRecord, saved: Int) {
        record.savedParts = saved; record.inFlightPart = nil
        // Progress only: if this cannot be recorded, the earlier in-flight mark stays, which is the cautious reading.
        if (try? journal.update(record, api: api)) != nil { pending = record }
    }

    private func stopWithPage(_ page: NativeDigestExportedPage, error: String? = nil, notice: String? = nil) -> Bool {
        if let error { self.error = error }
        if let notice { self.notice = notice }
        reloadPending()
        openedPage = page
        return false
    }

    private func reloadPending() {
        guard let digestID else { return }
        do { pending = try journal.load(api: api, workspaceID: workspaceID, digestID: digestID); pendingUnreadable = nil }
        catch { pendingUnreadable = "A saved export record for this digest can't be verified, so saving is blocked. " + featureErrorMessage(error) }
    }
}
