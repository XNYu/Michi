import Foundation
import Combine
import MichiCore

// MARK: - Permissions

let featurePermissionModes = ["ask", "trust", "yolo"]
private let featureNoYoloRuntimeIds: Set<String> = ["kiro", "crew", "pi"]

struct FeaturePermissionDraft: Equatable {
    var global = false
    var mode = "ask"
    var approveForMe = false
}

func featureIsPermissionMode(_ value: String) -> Bool {
    featurePermissionModes.contains(value)
}

func featureSupportsChatYolo(runtimeId: String) -> Bool {
    !featureNoYoloRuntimeIds.contains(runtimeId)
}

func featureApproveForMeRuntimeIds(_ status: JSONValue) -> [String] {
    status["availableRuntimes"].arrayValue.compactMap { runtime in
        runtime["approveForMe"].featureOptionalBool == true ? runtime.id : nil
    }.filter { !$0.isEmpty }
}

func featurePermissionRuntimeIds(_ status: JSONValue) -> [String] {
    status["availableRuntimes"].arrayValue.map(\.id).filter { !$0.isEmpty }
}

func featurePermissionDraft(from value: JSONValue) throws -> FeaturePermissionDraft {
    guard let global = value["global"].featureOptionalBool, featureIsPermissionMode(value["mode"].stringValue) else {
        throw FeatureRequestError(message: "Permission settings are unavailable on this Backend")
    }
    let approve = value["approveForMe"]
    if !approve.isNull, approve.featureOptionalBool == nil {
        throw FeatureRequestError(message: "Permission settings are unavailable on this Backend")
    }
    return FeaturePermissionDraft(
        global: global,
        mode: value["mode"].stringValue,
        approveForMe: approve.featureOptionalBool == true
    )
}

/// PUT body starts from the GET record so extra and null fields stay on the wire.
func featurePermissionSettingsBody(stored: JSONValue, draft: FeaturePermissionDraft) throws -> JSONValue {
    guard featureIsPermissionMode(draft.mode) else {
        throw FeatureRequestError(message: "Permission mode must be ask, trust, or yolo.")
    }
    var fields = stored.objectValue
    fields["global"] = .bool(draft.global)
    fields["mode"] = .string(draft.mode)
    if draft.mode == "ask" && draft.approveForMe {
        fields["approveForMe"] = true
    } else if stored.objectValue["approveForMe"] != nil, draft.mode == "ask", stored["approveForMe"].featureOptionalBool != true {
        fields["approveForMe"] = stored["approveForMe"]
    } else {
        fields.removeValue(forKey: "approveForMe")
    }
    return .object(fields)
}

@MainActor
final class FeaturePermissionsSettingsModel: ObservableObject {
    let api: MichiAPI

    @Published var stored: JSONValue = .null
    @Published var status: JSONValue = .null
    @Published var draft = FeaturePermissionDraft()
    @Published var baseline = FeaturePermissionDraft()
    @Published var ready = false
    @Published var saving = false
    @Published var error: String?

    init(api: MichiAPI) {
        self.api = api
    }

    var dirty: Bool { draft != baseline }

    var runtimeIds: [String] { featurePermissionRuntimeIds(status) }
    var approveRuntimeIds: [String] { featureApproveForMeRuntimeIds(status) }
    var supportsYolo: Bool { runtimeIds.contains(where: featureSupportsChatYolo) || draft.mode == "yolo" }
    var supportsApproveForMe: Bool { !approveRuntimeIds.isEmpty || draft.approveForMe }
    var claudeAvailable: Bool { runtimeIds.contains("claude") }

    func reload() async {
        do {
            let loaded = try await FeatureAPI.get(api, "/permissions/settings")
            let next = try featurePermissionDraft(from: loaded)
            stored = loaded
            draft = next
            baseline = next
            ready = true
            error = nil
            if let status = try? await FeatureAPI.get(api, "/agent/status") {
                self.status = status
            }
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
            ready = false
        }
    }

    func save() async {
        guard ready, dirty else { return }
        saving = true
        defer { saving = false }
        do {
            let body = try featurePermissionSettingsBody(stored: stored, draft: draft)
            let saved = try await FeatureAPI.send(api, "/permissions/settings", method: "PUT", body: body)
            let next = try featurePermissionDraft(from: saved)
            stored = saved
            draft = next
            baseline = next
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }
}

// MARK: - Meta agent

let featureMetaAgentRuntimes = ["claude", "pi", "codex", "kiro", "crew"]
let featureMetaAgentFirstRunDays = [7, 30, 90]
let featureMetaAgentDefaultFirstRunDays = 30
private let featureMetaAgentUnsupported: Set<String> = ["crew"]
private let featureMetaAgentSettingKeys = [
    "runtimeId", "providerId", "modelId", "reasoning", "writeWorkspaceHomes", "maintainSpacesHome", "firstRunDays",
]

struct FeatureMetaAgentDraft: Equatable {
    var followGlobal = true
    var runtimeId = ""
    var providerId: String?
    var modelId: String?
    var reasoning: String?
    var writeWorkspaceHomes = true
    var maintainSpacesHome = true
    var firstRunDays = featureMetaAgentDefaultFirstRunDays
}

func featureMetaAgentRuntimeSupported(_ id: String) -> Bool {
    !featureMetaAgentUnsupported.contains(id)
}

func featureMetaAgentRuntimeLabel(_ id: String) -> String {
    switch id {
    case "claude": return "Claude"
    case "pi": return "Pi"
    case "codex": return "Codex"
    case "kiro": return "Kiro"
    case "crew": return "Crew"
    default: return id
    }
}

func featureMetaAgentRestriction(_ id: String) -> String? {
    switch id {
    case "crew": return "the Meta agent can’t use Kiro Crew yet"
    case "claude", "pi", "codex", "kiro": return "Michi checks tool access; external tools are read-only"
    default: return nil
    }
}

func featureMetaAgentDraft(from info: JSONValue) -> FeatureMetaAgentDraft {
    let settings = info["settings"]
    let resolved = info["resolved"]
    let custom = !settings["runtimeId"].isNull
    var draft = FeatureMetaAgentDraft()
    draft.followGlobal = !custom
    draft.runtimeId = custom ? settings["runtimeId"].stringValue : resolved["runtimeId"].stringValue
    draft.providerId = featureNullableJSONString(settings["providerId"])
    draft.modelId = featureNullableJSONString(settings["modelId"])
    draft.reasoning = featureNullableJSONString(settings["reasoning"])
    draft.writeWorkspaceHomes = settings["writeWorkspaceHomes"].featureOptionalBool ?? true
    draft.maintainSpacesHome = settings["maintainSpacesHome"].featureOptionalBool ?? true
    let days = settings["firstRunDays"].featureOptionalNumber.map(Int.init)
    draft.firstRunDays = days.flatMap { featureMetaAgentFirstRunDays.contains($0) ? $0 : nil } ?? featureMetaAgentDefaultFirstRunDays
    return draft
}

func featureMetaAgentSettingsPatch(stored: JSONValue, draft: FeatureMetaAgentDraft, resolved: JSONValue) -> JSONValue {
    var patch: [String: JSONValue] = [:]
    let storedCustom = !stored["runtimeId"].isNull
    if draft.followGlobal {
        if storedCustom {
            patch["runtimeId"] = .null
            patch["providerId"] = .null
            patch["modelId"] = .null
            patch["reasoning"] = .null
        }
    } else {
        let runtimeId = draft.runtimeId.isEmpty ? resolved["runtimeId"].stringValue : draft.runtimeId
        if stored["runtimeId"].optionalString != runtimeId {
            patch["runtimeId"] = runtimeId.isEmpty ? .null : .string(runtimeId)
            // selectRuntime clears inherited choices; any values present now
            // were selected for the new runtime and must survive Save.
            patch["providerId"] = featureJSONOptionalString(draft.providerId)
            patch["modelId"] = featureJSONOptionalString(draft.modelId)
            patch["reasoning"] = featureJSONOptionalString(draft.reasoning)
        } else {
            if featureOptionalStringChanged(stored["providerId"], draft.providerId) {
                patch["providerId"] = featureJSONOptionalString(draft.providerId)
            }
            if featureOptionalStringChanged(stored["modelId"], draft.modelId) {
                patch["modelId"] = featureJSONOptionalString(draft.modelId)
            }
            if featureOptionalStringChanged(stored["reasoning"], draft.reasoning) {
                patch["reasoning"] = featureJSONOptionalString(draft.reasoning)
            }
        }
    }
    if featureOptionalFlagChanged(stored["writeWorkspaceHomes"], draft.writeWorkspaceHomes, defaultOn: true) {
        patch["writeWorkspaceHomes"] = .bool(draft.writeWorkspaceHomes)
    }
    if featureOptionalFlagChanged(stored["maintainSpacesHome"], draft.maintainSpacesHome, defaultOn: true) {
        patch["maintainSpacesHome"] = .bool(draft.maintainSpacesHome)
    }
    if featureFirstRunDaysChanged(stored["firstRunDays"], draft.firstRunDays) {
        patch["firstRunDays"] = .number(Double(draft.firstRunDays))
    }
    return .object(patch)
}

func featureMetaAgentGuardFailures(_ info: JSONValue) -> [JSONValue] {
    [info["guard"]["maintenance"], info["guard"]["chat"]].filter { $0["state"].stringValue == "failed" }
}

func featureMetaAgentUsageText(_ usage: JSONValue) -> String {
    if usage.isNull { return "Today’s usage could not be counted." }
    let checks = usage["checks"].intValue
    let calls = usage["modelCalls"].intValue
    let prefix = "Today: \(featureCount(checks, "check")), \(featureCount(calls, "AI call"))"
    if usage["tokens"].isNull {
        return "\(prefix); the AI service didn’t say how many tokens it used."
    }
    return "\(prefix), about \(featureTokenCount(usage["tokens"].intValue)) tokens."
}

func featureMetaAgentRetryBody(failures: [JSONValue]) -> JSONValue {
    if failures.count == 1, let toolset = failures[0]["toolset"].optionalString, toolset == "maintenance" || toolset == "chat" {
        return ["toolset": .string(toolset)]
    }
    return [:]
}

@MainActor
final class FeatureMetaAgentSettingsModel: ObservableObject {
    let api: MichiAPI

    @Published var info: JSONValue = .null
    @Published var status: JSONValue = .null
    @Published var draft = FeatureMetaAgentDraft()
    @Published var baseline = FeatureMetaAgentDraft()
    @Published var providers: [JSONValue] = []
    @Published var models: [JSONValue] = []
    @Published var capabilities: JSONValue = [:]
    @Published var ready = false
    @Published var unavailable = false
    @Published var saving = false
    @Published var error: String?
    private var catalogEpoch = 0

    init(api: MichiAPI) {
        self.api = api
    }

    var dirty: Bool { draft != baseline }
    var settings: JSONValue { info["settings"] }
    var resolved: JSONValue { info["resolved"] }
    var availability: JSONValue { info["availability"] }
    var failures: [JSONValue] { featureMetaAgentGuardFailures(info) }
    var toolApprovals: [JSONValue] { info["toolApprovals"].arrayValue }
    var reasoningLevels: [String] {
        let listed = featureStringList(capabilities["supportedReasoningLevels"])
        return listed.isEmpty ? ["minimal", "low", "medium", "high", "xhigh", "max"] : listed
    }

    func reload() async {
        do {
            let loaded = try await FeatureAPI.get(api, "/meta-agent")
            apply(loaded)
            unavailable = false
            ready = true
            error = nil
            if let status = try? await FeatureAPI.get(api, "/agent/status") {
                self.status = status
            }
            if !draft.followGlobal {
                await loadCatalog(for: draft.runtimeId)
            }
        } catch is CancellationError {
        } catch let error as MichiAPIError where error.statusCode == 404 {
            unavailable = true
            ready = true
            self.error = nil
        } catch {
            self.error = featureErrorMessage(error)
            if info.isNull { ready = false }
        }
    }

    func save() async {
        guard ready, dirty, !unavailable else { return }
        saving = true
        defer { saving = false }
        do {
            let patch = featureMetaAgentSettingsPatch(stored: settings, draft: draft, resolved: resolved)
            if patch.objectValue.isEmpty {
                baseline = draft
                return
            }
            let unknown = patch.objectValue.keys.filter { !featureMetaAgentSettingKeys.contains($0) }
            if let extra = unknown.first {
                throw FeatureRequestError(message: "unknown field: \(extra)")
            }
            let saved = try await FeatureAPI.send(api, "/meta-agent/settings", method: "PUT", body: patch)
            apply(saved)
            error = nil
            if !draft.followGlobal {
                await loadCatalog(for: draft.runtimeId)
            }
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func chooseFollowGlobal() {
        guard !draft.followGlobal else { return }
        draft.followGlobal = true
        draft.providerId = nil
        draft.modelId = nil
        draft.reasoning = nil
        draft.runtimeId = resolved["runtimeId"].stringValue
    }

    func chooseCustom() {
        guard draft.followGlobal else { return }
        draft.followGlobal = false
        if availability["available"].featureOptionalBool == false {
            if let fallback = featureMetaAgentRuntimes.first(where: { $0 != resolved["runtimeId"].stringValue && runtimeAvailable($0) }) {
                draft.runtimeId = fallback
                draft.providerId = nil
                draft.modelId = nil
                draft.reasoning = nil
                Task { await loadCatalog(for: fallback) }
                return
            }
        }
        draft.runtimeId = resolved["runtimeId"].stringValue
        draft.providerId = featureNullableJSONString(resolved["providerId"])
        draft.modelId = featureNullableJSONString(resolved["modelId"])
        draft.reasoning = featureNullableJSONString(resolved["reasoning"])
        Task { await loadCatalog(for: draft.runtimeId) }
    }

    func selectRuntime(_ runtime: String) {
        guard runtime != draft.runtimeId else { return }
        draft.followGlobal = false
        draft.runtimeId = runtime
        draft.providerId = nil
        draft.modelId = nil
        draft.reasoning = nil
        Task { await loadCatalog(for: runtime) }
    }

    func retryGuard() async {
        saving = true
        defer { saving = false }
        do {
            let saved = try await FeatureAPI.send(api, "/meta-agent/retry", method: "POST", body: featureMetaAgentRetryBody(failures: failures))
            apply(saved)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func decideToolApproval(id: String, state: String) async {
        saving = true
        defer { saving = false }
        do {
            let saved = try await FeatureAPI.send(
                api,
                "/meta-agent/tool-approvals/\(FeatureAPI.segment(id))",
                method: "POST",
                body: ["state": .string(state)]
            )
            apply(saved)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func runtimeAvailable(_ id: String) -> Bool {
        guard featureMetaAgentRuntimeSupported(id) else { return false }
        guard let option = status["availableRuntimes"].arrayValue.first(where: { $0.id == id }) else { return true }
        return option["available"].featureOptionalBool != false
    }

    func loadCatalog(for runtime: String) async {
        guard !runtime.isEmpty else { return }
        catalogEpoch += 1
        let epoch = catalogEpoch
        var path = "/agent/runtime-catalog?runtime=\(FeatureAPI.segment(runtime))"
        if let provider = draft.providerId, !provider.isEmpty {
            path += "&provider=\(FeatureAPI.segment(provider))"
        }
        let catalog = try? await FeatureAPI.get(api, path)
        guard epoch == catalogEpoch, draft.runtimeId == runtime else { return }
        providers = catalog?["providers"].arrayValue ?? []
        models = catalog?["models"].arrayValue ?? []
        if let caps = catalog.flatMap({ featureOptional($0["capabilities"]) }) {
            capabilities = caps
        }
    }

    private func apply(_ loaded: JSONValue) {
        info = loaded
        draft = featureMetaAgentDraft(from: loaded)
        baseline = draft
        ready = true
        unavailable = false
    }
}

// MARK: - Backup

let featureMaxBackupBytes = 50 * 1024 * 1024
private let featureBackupGraphKeys = ["trees", "nodes", "edges", "messages", "contexts"]

struct FeatureBackupSummary: Equatable {
    var document: JSONValue
    var version: Int
    var exportedAt: Double?
    var workspaceCount: Int
    var messageCount: Int
}

func featureBackupSizeError(byteCount: Int) -> FeatureRequestError? {
    byteCount > featureMaxBackupBytes
        ? FeatureRequestError(message: "Backup files must be 50 MiB or smaller.")
        : nil
}

func featureInspectBackup(_ data: Data, byteCount: Int? = nil) throws -> FeatureBackupSummary {
    if let error = featureBackupSizeError(byteCount: byteCount ?? data.count) { throw error }
    let text = String(data: data, encoding: .utf8) ?? ""
    let value: JSONValue
    do {
        value = try JSONValue.parse(text)
    } catch {
        throw FeatureRequestError(message: "Choose a valid JSON backup file.")
    }
    return try featureInspectBackup(value)
}

func featureInspectBackup(_ value: JSONValue) throws -> FeatureBackupSummary {
    let version = value["version"].intValue
    let workspaces = value["workspaces"]
    let agents = value["agents"]
    let versionOK = value["version"] == 1 || value["version"] == 2
    let workspacesOK = featureIsJSONArray(workspaces)
    let agentsOK = version != 2 || featureIsJSONObject(agents)
    let entriesOK = workspaces.arrayValue.allSatisfy { entry in
        !entry["workspace"]["id"].stringValue.isEmpty
            && featureBackupGraphKeys.allSatisfy { featureIsJSONArray(entry[$0]) }
    }
    guard value["app"].stringValue == "michi", versionOK, workspacesOK, agentsOK, entriesOK else {
        throw FeatureRequestError(message: "This file is not a supported Michi backup.")
    }
    return FeatureBackupSummary(
        document: value,
        version: version,
        exportedAt: value["exportedAt"].featureOptionalNumber,
        workspaceCount: workspaces.arrayValue.count,
        messageCount: workspaces.arrayValue.reduce(0) { $0 + $1["messages"].arrayValue.count }
    )
}

func featureBackupEncodedSize(_ document: JSONValue) throws -> Int {
    try JSONEncoder().encode(document).count
}

@MainActor
final class FeatureBackupSettingsModel: ObservableObject {
    let api: MichiAPI

    @Published var pending: FeatureBackupSummary?
    @Published var pendingName = ""
    @Published var exportData: Data?
    @Published var exportFilename = "michi-backup.json"
    @Published var presentExporter = false
    @Published var restoredCount: Int?
    @Published var importOutcomeUnknown = false
    @Published var busy = false
    @Published var notice: String?
    @Published var error: String?

    init(api: MichiAPI) {
        self.api = api
    }

    var canRestore: Bool { pending != nil && restoredCount == nil && !importOutcomeUnknown }

    func exportBackup() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let payload = try await FeatureAPI.get(api, "/backup/export")
            let summary = try featureInspectBackup(payload)
            let data = try JSONEncoder().encode(summary.document)
            if let error = featureBackupSizeError(byteCount: data.count) { throw error }
            exportData = data
            exportFilename = featureBackupFilename(exportedAt: summary.exportedAt)
            presentExporter = true
            notice = nil
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func reviewImport(data: Data, name: String) throws {
        pending = nil
        let summary = try featureInspectBackup(data)
        pending = summary
        pendingName = name
        restoredCount = nil; importOutcomeUnknown = false
        error = nil
        notice = nil
    }

    func confirmImport() async {
        guard let pending, restoredCount == nil, !busy, !importOutcomeUnknown else { return }
        busy = true
        defer { busy = false }
        do {
            let bytes = try featureBackupEncodedSize(pending.document)
            if let error = featureBackupSizeError(byteCount: bytes) { throw error }
            let result = try await FeatureAPI.send(api, "/backup/import?mode=merge", method: "POST", body: pending.document)
            let count = result["workspaceCount"].intValue
            restoredCount = count
            self.pending = nil
            notice = "Restored \(count) workspace(s)."
            error = nil
        } catch let failure as MichiAPIError where failure.statusCode == nil {
            importOutcomeUnknown = true
            error = "The restore outcome is unknown. Refresh your saved workspaces before importing again; repeating the import may create duplicates."
        } catch is CancellationError {
            importOutcomeUnknown = true
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func cancelPending() {
        pending = nil
        pendingName = ""
        error = nil
    }
}

// MARK: - Shared helpers

private func featureNullableJSONString(_ value: JSONValue) -> String? {
    value.optionalString
}

private func featureJSONOptionalString(_ value: String?) -> JSONValue {
    if let value, !value.isEmpty { return .string(value) }
    return .null
}

private func featureOptionalStringChanged(_ stored: JSONValue, _ draft: String?) -> Bool {
    stored.optionalString != draft
}

private func featureOptionalFlagChanged(_ stored: JSONValue, _ draft: Bool, defaultOn: Bool) -> Bool {
    (stored.featureOptionalBool ?? defaultOn) != draft
}

private func featureFirstRunDaysChanged(_ stored: JSONValue, _ draft: Int) -> Bool {
    if stored.isNull { return draft != featureMetaAgentDefaultFirstRunDays }
    return stored.intValue != draft
}

private func featureCount(_ n: Int, _ one: String) -> String {
    "\(n) \(n == 1 ? one : "\(one)s")"
}

private func featureTokenCount(_ n: Int) -> String {
    if n < 1_000 { return String(n) }
    if n < 1_000_000 { return "\(Int((Double(n) / 1_000).rounded()))k" }
    let millions = Double(n) / 1_000_000
    let text = String(format: "%.1f", millions)
    return "\(text.hasSuffix(".0") ? String(text.dropLast(2)) : text)M"
}

private func featureIsJSONArray(_ value: JSONValue) -> Bool {
    if case .array = value { return true }
    return false
}

private func featureIsJSONObject(_ value: JSONValue) -> Bool {
    if case .object = value { return true }
    return false
}

private func featureBackupFilename(exportedAt: Double?) -> String {
    let date = featureDate(exportedAt) ?? Date()
    let stamp = ISO8601DateFormatter().string(from: date)
        .replacingOccurrences(of: ":", with: "-")
        .replacingOccurrences(of: ".", with: "-")
    return "michi-backup-\(stamp).json"
}
