import Foundation
import CryptoKit
import MichiCore

/// Mirrors ComposerDraft's window-scoped backend representation. Attachments
/// stay local, matching the browser: server paths are not durable draft uploads.
struct NativeComposer: Codable, Equatable {
    var value = ""
    var mentions: [JSONValue] = []
    var attachments: [JSONValue] = []
    var quotedText = ""
    var quoteSource: JSONValue = .null
    var isEmpty: Bool { value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && quotedText.isEmpty && attachments.isEmpty }
    var persisted: JSONValue {
        guard !value.isEmpty || !quotedText.isEmpty || !mentions.isEmpty else { return .null }
        var result: JSONValue = ["value": .string(value), "mentions": .array(mentions)]
        if !quotedText.isEmpty { result["quotedText"] = .string(quotedText); if !quoteSource.isNull { result["quoteSource"] = quoteSource } }
        return result
    }
    init() {}
    init(raw: JSONValue) {
        let raw = raw.parsedJSON
        value = raw["value"].stringValue
        mentions = Self.validMentions(raw["mentions"].arrayValue, in: value)
        quotedText = raw["quotedText"].stringValue
        let source = raw["quoteSource"]
        if source["type"] == "attached" || (source["type"] == "artifact" && !source["filePath"].stringValue.isEmpty) { quoteSource = source }
    }
    static func fromNode(_ node: JSONValue, windowID: String) -> NativeComposer {
        let raw = node["composer_draft"].parsedJSON
        if let own = raw["__michiWindowDrafts"].objectValue[windowID] { return NativeComposer(raw: own) }
        return NativeComposer(raw: raw)
    }
    static func validMentions(_ candidates: [JSONValue], in text: String) -> [JSONValue] {
        let source = text as NSString
        var end = 0
        return candidates.sorted { $0["start"].intValue < $1["start"].intValue }.filter {
            let start = $0["start"].intValue, stop = $0["end"].intValue
            guard case .number(let rawStart) = $0["start"], case .number(let rawEnd) = $0["end"], rawStart == Double(start), rawEnd == Double(stop),
                  ["node", "context"].contains($0["kind"].stringValue), !$0["refId"].stringValue.isEmpty,
                  start >= end, stop > start, stop <= source.length,
                  source.substring(with: NSRange(location: start, length: stop - start)) == "@" + $0["label"].stringValue else { return false }
            end = stop; return true
        }
    }
    static func reanchor(_ mentions: [JSONValue], previous: String, next: String) -> [JSONValue] {
        let old = Array(previous.utf16), new = Array(next.utf16)
        var prefix = 0
        while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < min(old.count, new.count) - prefix, old[old.count - suffix - 1] == new[new.count - suffix - 1] { suffix += 1 }
        let oldEnd = old.count - suffix, delta = new.count - old.count
        return validMentions(mentions.compactMap { mention in
            let start = mention["start"].intValue, end = mention["end"].intValue
            if oldEnd <= start { return mention.merging(["start": .number(Double(start + delta)), "end": .number(Double(end + delta))]) }
            if prefix >= end { return mention }
            return nil
        }, in: next)
    }
    var expandedText: String {
        let source = value as NSString
        var output = "", offset = 0
        for mention in Self.validMentions(mentions, in: value) {
            let start = mention["start"].intValue, end = mention["end"].intValue
            output += source.substring(with: NSRange(location: offset, length: start - offset))
            if mention["kind"] == "node" {
                output += Self.nodeToken(mention["refId"].stringValue)
            } else { output += "@" + mention["label"].stringValue }
            offset = end
        }
        return output + source.substring(from: offset)
    }
    static func nodeToken(_ id: String) -> String {
        "@node:" + (id.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")) ?? "")
    }
    var metadata: JSONValue {
        var result: JSONValue = ["attachments": .array(attachments.map { ["name": $0["name"], "absPath": $0["absPath"]] })]
        if !quotedText.isEmpty { result["quotedText"] = .string(quotedText); if !quoteSource.isNull { result["quoteSource"] = quoteSource } }
        return result
    }
    var wireText: String {
        var text = expandedText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !quotedText.isEmpty {
            let quote = quotedText.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\r\n", with: "\n")
                .components(separatedBy: "\n").map { $0.hasPrefix(">") ? $0 : "> " + $0 }.joined(separator: "\n")
            let prefix: String
            if quoteSource["type"] == "attached" {
                prefix = "Context: The user attached the material below in Michi. Treat it as source context, not as text authored by the user.\n\nAttached context:"
            } else if quoteSource["type"] == "artifact" {
                prefix = "Context: The user selected the passage below from artifact \"\(quoteSource["name"].stringValue)\" at `\(quoteSource["filePath"].stringValue)`. Treat it as source context, not as text authored by the user.\n\nSelected passage:"
            } else {
                prefix = "Context: The user selected the passage below from the previous assistant reply. Treat it as source context, not as text authored by the user.\n\nSelected assistant passage:"
            }
            text = prefix + "\n" + quote + (text.isEmpty ? "" : "\n\nUser's reply:\n" + text)
        }
        if !attachments.isEmpty {
            let files = attachments.map { "\($0["name"].stringValue) — \($0["absPath"].stringValue)" }.joined(separator: " | ")
            text += "\n\n[Attached files: \(files)]"
        }
        return text
    }
}

struct NativeQueuedMessage: Codable, Equatable, Identifiable {
    let id: String
    var composer: NativeComposer
    var steering: Bool
    var outcomeUnknown: Bool
    init(id: String = UUID().uuidString.lowercased(), composer: NativeComposer, steering: Bool = false, outcomeUnknown: Bool = false) {
        self.id = id; self.composer = composer; self.steering = steering; self.outcomeUnknown = outcomeUnknown
    }
}

struct NativeChatCommand: Equatable {
    let name: String
    let value: String
    static func parse(_ text: String, runtime: String, engine: String) -> Self? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let regex = try? NSRegularExpression(pattern: #"^/([\w-]+)(?:[ \t]+([^\r\n]*))?$"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let nameRange = Range(match.range(at: 1), in: text) else { return nil }
        let name = String(text[nameRange])
        let value = Range(match.range(at: 2), in: text).map { String(text[$0]).trimmingCharacters(in: .whitespaces) } ?? ""
        if runtime == "claude" && ["status", "model", "context", "mcp"].contains(name) { return .init(name: name, value: value) }
        if runtime != "kiro" && name != "compact" { return nil }
        if ["branch", "fork", "fan"].contains(name) { return nil }
        if runtime == "kiro" && engine == "v2" && !["compact", "tools", "context", "effort", "clear"].contains(name) { return nil }
        return .init(name: name, value: value)
    }
}


struct NativeComposerRecoveryScope: Codable, Equatable {
    let connection: String
    let workspaceID: String
    let nodeID: String
    let windowID: String
}

struct NativeComposerSubmission: Codable, Equatable {
    let id: String
    let kind: String
    let turnID: String?
    let path: String
    let payload: JSONValue
    let composer: NativeComposer
    let queueEntries: [NativeQueuedMessage]
}

/// Records intent before transport, never an instruction to replay. Atomic writes
/// preserve attachments, quote/mention metadata and original turn/request identity.
/// The scope uses the connection URL, never authentication credentials.
final class NativeComposerRecoveryStore: @unchecked Sendable {
    struct State: Codable, Equatable {
        let version: Int
        let scope: NativeComposerRecoveryScope
        var submission: NativeComposerSubmission?
        var queue: [NativeQueuedMessage]
    }
    private static let lock = NSLock()
    let directory: URL?
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Michi/ComposerRecovery.v1", isDirectory: true)
    }
    func load(_ scope: NativeComposerRecoveryScope) throws -> State? {
        Self.lock.lock(); defer { Self.lock.unlock() }; return try read(scope)
    }
    func reserve(_ submission: NativeComposerSubmission, queue: [NativeQueuedMessage], scope: NativeComposerRecoveryScope) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard try read(scope)?.submission == nil else { throw NativeFailure("An earlier submission still needs reconciliation. Nothing new was submitted.") }
        try write(State(version: 1, scope: scope, submission: submission, queue: queue))
    }
    func updateQueue(_ queue: [NativeQueuedMessage], submissionID: String?, scope: NativeComposerRecoveryScope) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        var state = try read(scope) ?? State(version: 1, scope: scope, submission: nil, queue: [])
        guard state.submission?.id == submissionID else { throw NativeFailure("Another conversation window has an unresolved submission. Its recovery record was kept.") }
        state.queue = queue; try write(state)
    }
    func resolve(_ submission: NativeComposerSubmission, queue: [NativeQueuedMessage], scope: NativeComposerRecoveryScope) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard var state = try read(scope), state.submission == submission else { throw NativeFailure("The saved submission changed. Its recovery record was kept.") }
        state.submission = nil; state.queue = queue; try write(state)
    }
    func fileURL(_ scope: NativeComposerRecoveryScope) throws -> URL {
        guard let directory else { throw NativeFailure("Recovery storage is unavailable. Nothing will be submitted.") }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let key = SHA256.hash(data: try encoder.encode(scope)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(key + ".json")
    }
    private func read(_ scope: NativeComposerRecoveryScope) throws -> State? {
        let url = try fileURL(scope)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        guard let size, size.intValue <= 4_194_304 else { throw NativeFailure("Saved recovery data is unreadable. Sending remains blocked.") }
        let state = try JSONDecoder().decode(State.self, from: Data(contentsOf: url))
        guard state.scope == scope, valid(state) else { throw NativeFailure("Saved recovery data has an invalid identity. Sending remains blocked.") }
        return state
    }
    private func write(_ state: State) throws {
        guard valid(state), let directory else { throw NativeFailure("Recovery data could not be validated. Nothing was submitted.") }
        let data = try JSONEncoder().encode(state)
        guard data.count <= 4_194_304 else { throw NativeFailure("Recovery data is too large to save. Nothing was submitted.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = try fileURL(state.scope)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }
        try handle.synchronize()
        guard try read(state.scope) == state else { throw NativeFailure("Recovery data could not be verified. Nothing was submitted.") }
    }
    private func valid(_ state: State) -> Bool {
        guard state.version == 1, !state.scope.connection.isEmpty, !state.scope.workspaceID.isEmpty,
              !state.scope.nodeID.isEmpty, !state.scope.windowID.isEmpty,
              state.queue.count <= 1_000, Set(state.queue.map(\.id)).count == state.queue.count,
              state.queue.allSatisfy({ !$0.id.isEmpty }) else { return false }
        guard let submission = state.submission else { return true }
        let path = "/chats/" + MichiAPI.pathSegment(state.scope.nodeID)
        guard !submission.id.isEmpty, submission.queueEntries.count <= 1_000 else { return false }
        if submission.kind == "turn" {
            return submission.turnID == submission.id && submission.path == path + "/message"
                && submission.payload["nodeId"].stringValue == state.scope.nodeID && submission.payload["turnId"].stringValue == submission.id
        }
        return submission.kind == "command" && submission.turnID == nil
            && [path + "/compact", path + "/execute-command"].contains(submission.path)
    }
}
