import Foundation
import Combine
import MichiCore

struct FeatureRuntimeProfileDraft {
    var runtimeId = ""
    var providerId = ""
    var modelId = ""
    var reasoning = ""
    var modeId = ""
    var options: JSONValue = [:]

    var json: JSONValue {
        var body: [String: JSONValue] = ["version": 1, "runtimeId": .string(runtimeId)]
        if !providerId.isEmpty { body["providerId"] = .string(providerId) }
        if !modelId.isEmpty { body["modelId"] = .string(modelId) }
        if !reasoning.isEmpty { body["reasoning"] = .string(reasoning) }
        if !modeId.isEmpty { body["modeId"] = .string(modeId) }
        if !options.objectValue.isEmpty { body["options"] = options }
        return .object(body)
    }

    static func from(_ value: JSONValue) -> FeatureRuntimeProfileDraft {
        FeatureRuntimeProfileDraft(
            runtimeId: value["runtimeId"].stringValue,
            providerId: value["providerId"].stringValue,
            modelId: value["modelId"].stringValue,
            reasoning: value["reasoning"].stringValue,
            modeId: value["modeId"].stringValue,
            options: value["options"].isNull ? [:] : value["options"]
        )
    }
}

struct FeatureAgentDraft: Identifiable {
    var id: String
    var status = "draft"
    var revision = 0
    var scope = "workspace"
    var workspaceId = ""
    var name = ""
    var description = ""
    var instructions = ""
    var runtimeProfile = FeatureRuntimeProfileDraft()
    var fallbackChain: [FeatureRuntimeProfileDraft] = []
    var includeWorkspaceInstructions = true
    var allowMessageContext = true
    var allowFileContext = true
    var allowArtifactContext = true
    var maxEstimatedChars = "100000"
    var permissionPreset = "research"
    var categories: [String: String] = [:]
    var maxDelegationDepth = "0"
    var maxConcurrentRuns = "1"
    var maxWallTimeMinutes = "60"
    var maxAttempts = "1"
    var storedPermissionPolicy: JSONValue?
    var sourceMaxWallTimeMs: Int?
    var loadedPermissionPreset = "research"
    var loadedCategories: [String: String] = [:]
    var loadedMaxDelegationDepth = "0"
    var loadedMaxConcurrentRuns = "1"
    var loadedMaxWallTimeMinutes = "60"
    var loadedMaxAttempts = "1"
    var toolRefs = ""
    var skillRefs = ""
    var mcpServerRefs = ""
    var defaultRunTtlMs: String = ""

    static let policyCategories = [
        "read", "search", "browse", "artifact_write", "filesystem_write", "shell_exec", "external_action", "spawn_agent",
    ]

    mutating func add(_ capability: JSONValue) {
        let ref = capability.id
        guard !ref.isEmpty else { return }
        switch capability["kind"].stringValue {
        case "skill":
            skillRefs = featureAppendLine(skillRefs, ref)
        case "mcp_server":
            mcpServerRefs = featureAppendLine(mcpServerRefs, ref)
        default:
            toolRefs = featureAppendLine(toolRefs, ref)
        }
    }

    func requestJSON(includingRevision: Bool) throws -> JSONValue {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { throw FeatureRequestError(message: "Name is required.") }
        if description.isEmpty { throw FeatureRequestError(message: "Describe what this agent does and when to use it.") }
        if runtimeProfile.runtimeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw FeatureRequestError(message: "Primary runtime is required.")
        }
        if scope == "workspace" && workspaceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw FeatureRequestError(message: "Choose a workspace.")
        }
        guard let maxChars = Int(maxEstimatedChars), maxChars >= 1, maxChars <= 1_000_000 else {
            throw FeatureRequestError(message: "Max characters must be 1–1000000.")
        }
        var body: [String: JSONValue] = [
            "version": 1,
            "scope": .string(scope),
            "workspaceId": scope == "global" ? .null : .string(workspaceId),
            "name": .string(name),
            "description": .string(description),
            "instructions": .string(instructions),
            "runtimeProfile": runtimeProfile.json,
            "fallbackChain": .array(fallbackChain.map(\.json)),
            "toolRefs": featureJSONStrings(featureLines(toolRefs)),
            "skillRefs": featureJSONStrings(featureLines(skillRefs)),
            "mcpServerRefs": featureJSONStrings(featureLines(mcpServerRefs)),
            "contextPolicy": [
                "version": 1,
                "includeWorkspaceInstructions": .bool(includeWorkspaceInstructions),
                "allowMessageContext": .bool(allowMessageContext),
                "allowFileContext": .bool(allowFileContext),
                "allowArtifactContext": .bool(allowArtifactContext),
                "maxEstimatedChars": .number(Double(maxChars)),
            ],
            "permissionPolicy": featureAgentPermissionPolicy(
                stored: storedPermissionPolicy,
                sourceMaxWallTimeMs: sourceMaxWallTimeMs,
                preset: permissionPreset,
                categories: categories,
                maxDelegationDepth: maxDelegationDepth,
                maxConcurrentRuns: maxConcurrentRuns,
                maxWallTimeMinutes: maxWallTimeMinutes,
                maxAttempts: maxAttempts,
                loadedPreset: loadedPermissionPreset,
                loadedCategories: loadedCategories,
                loadedMaxDelegationDepth: loadedMaxDelegationDepth,
                loadedMaxConcurrentRuns: loadedMaxConcurrentRuns,
                loadedMaxWallTimeMinutes: loadedMaxWallTimeMinutes,
                loadedMaxAttempts: loadedMaxAttempts,
                creating: id == "new"
            ),
            "defaultRunTtlMs": defaultRunTtlMs.isEmpty ? .null : .number(Double(Int(defaultRunTtlMs) ?? 0)),
        ]
        if includingRevision {
            body["expectedRevision"] = .number(Double(max(revision, 1)))
        }
        return .object(body)
    }

    static func from(_ agent: JSONValue) -> FeatureAgentDraft {
        let policy = agent["permissionPolicy"]
        var categories: [String: String] = [:]
        for (key, value) in policy["categories"].objectValue {
            categories[key] = value.stringValue
        }
        let preset = policy.isNull ? "research" : policy["preset"].stringValue
        let depth = String(policy["maxDelegationDepth"].intValue)
        let concurrent = String(max(policy["maxConcurrentRuns"].intValue, 1))
        let wallMinutes = String(max(policy["maxWallTimeMs"].intValue / 60_000, 1))
        let attempts = String(max(policy["maxAttempts"].intValue, 1))
        return FeatureAgentDraft(
            id: agent.id,
            status: agent["status"].stringValue,
            revision: agent["revision"].intValue,
            scope: agent["scope"].stringValue,
            workspaceId: agent["workspaceId"].stringValue,
            name: agent["name"].stringValue,
            description: agent["description"].stringValue,
            instructions: agent["instructions"].stringValue,
            runtimeProfile: .from(agent["runtimeProfile"]),
            fallbackChain: agent["fallbackChain"].arrayValue.map(FeatureRuntimeProfileDraft.from),
            includeWorkspaceInstructions: agent["contextPolicy"]["includeWorkspaceInstructions"].boolValue,
            allowMessageContext: agent["contextPolicy"]["allowMessageContext"].boolValue,
            allowFileContext: agent["contextPolicy"]["allowFileContext"].boolValue,
            allowArtifactContext: agent["contextPolicy"]["allowArtifactContext"].boolValue,
            maxEstimatedChars: String(agent["contextPolicy"]["maxEstimatedChars"].intValue),
            permissionPreset: preset,
            categories: categories,
            maxDelegationDepth: depth,
            maxConcurrentRuns: concurrent,
            maxWallTimeMinutes: wallMinutes,
            maxAttempts: attempts,
            storedPermissionPolicy: policy.isNull ? nil : policy,
            sourceMaxWallTimeMs: policy["maxWallTimeMs"].isNull ? nil : policy["maxWallTimeMs"].intValue,
            loadedPermissionPreset: preset,
            loadedCategories: categories,
            loadedMaxDelegationDepth: depth,
            loadedMaxConcurrentRuns: concurrent,
            loadedMaxWallTimeMinutes: wallMinutes,
            loadedMaxAttempts: attempts,
            toolRefs: featureStringList(agent["toolRefs"]).joined(separator: "\n"),
            skillRefs: featureStringList(agent["skillRefs"]).joined(separator: "\n"),
            mcpServerRefs: featureStringList(agent["mcpServerRefs"]).joined(separator: "\n"),
            defaultRunTtlMs: agent["defaultRunTtlMs"].isNull ? "" : String(agent["defaultRunTtlMs"].intValue)
        )
    }
}

func featureAgentPermissionPolicy(
    stored: JSONValue?,
    sourceMaxWallTimeMs: Int?,
    preset: String,
    categories: [String: String],
    maxDelegationDepth: String,
    maxConcurrentRuns: String,
    maxWallTimeMinutes: String,
    maxAttempts: String,
    loadedPreset: String,
    loadedCategories: [String: String],
    loadedMaxDelegationDepth: String,
    loadedMaxConcurrentRuns: String,
    loadedMaxWallTimeMinutes: String,
    loadedMaxAttempts: String,
    creating: Bool
) -> JSONValue {
    let edited = preset != loadedPreset
        || categories != loadedCategories
        || maxDelegationDepth != loadedMaxDelegationDepth
        || maxConcurrentRuns != loadedMaxConcurrentRuns
        || maxWallTimeMinutes != loadedMaxWallTimeMinutes
        || maxAttempts != loadedMaxAttempts
    if !edited {
        if let stored { return stored }
        return creating ? featureAgentDefaultPermissionPolicy(preset: preset) : .null
    }
    var next = stored ?? featureAgentDefaultPermissionPolicy(preset: preset)
    next["version"] = 1
    next["preset"] = .string(preset)
    next["maxDelegationDepth"] = .number(Double(Int(maxDelegationDepth) ?? 0))
    next["maxConcurrentRuns"] = .number(Double(Int(maxConcurrentRuns) ?? 1))
    if maxWallTimeMinutes != loadedMaxWallTimeMinutes {
        next["maxWallTimeMs"] = .number(Double((Int(maxWallTimeMinutes) ?? 60) * 60_000))
    } else if let ms = sourceMaxWallTimeMs, ms > 0 {
        next["maxWallTimeMs"] = .number(Double(ms))
    } else {
        next["maxWallTimeMs"] = .number(Double((Int(maxWallTimeMinutes) ?? 60) * 60_000))
    }
    next["maxAttempts"] = .number(Double(Int(maxAttempts) ?? 1))
    if preset == "custom" {
        var categoriesObject = next["categories"].objectValue
        for category in FeatureAgentDraft.policyCategories {
            categoriesObject[category] = .string(categories[category] ?? categoriesObject[category]?.stringValue ?? "deny")
        }
        next["categories"] = .object(categoriesObject)
    }
    return next
}

func featureAgentDefaultPermissionPolicy(preset: String) -> JSONValue {
    [
        "version": 1,
        "preset": .string(preset),
        "categories": [:],
        "maxDelegationDepth": 0,
        "maxConcurrentRuns": 1,
        "maxWallTimeMs": 3_600_000,
        "maxAttempts": 1,
    ]
}

@MainActor
final class FeatureAgentLibraryModel: ObservableObject {
    let api: MichiAPI

    @Published var agents: [JSONValue] = []
    @Published var runtimes: [JSONValue] = []
    @Published var capabilities: [JSONValue] = []
    @Published var blockers: [JSONValue] = []
    @Published var customAgentsEnabled: Bool?
    @Published var loading = false
    @Published var mutating = false
    @Published var error: String?
    @Published var detailError: String?
    @Published var createDraft: FeatureAgentDraft?
    @Published var editDraft: FeatureAgentDraft?

    init(api: MichiAPI) {
        self.api = api
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            if let status = try? await FeatureAPI.get(api, "/agent/status") {
                customAgentsEnabled = status["customAgentsEnabled"].featureOptionalBool
                runtimes = status["availableRuntimes"].arrayValue
            }
            let payload = try await FeatureAPI.get(api, "/agents")
            agents = featureItems(payload, key: "definitions")
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func beginCreate() {
        var draft = FeatureAgentDraft(id: "new")
        draft.runtimeProfile.runtimeId = runtimes.first?["id"].stringValue ?? ""
        detailError = nil
        blockers = []
        createDraft = draft
        Task { await loadCapabilities(workspaceId: draft.workspaceId) }
    }

    func loadAgent(_ id: String) async {
        do {
            let payload = featureUnwrap(try await FeatureAPI.get(api, "/agents/\(FeatureAPI.segment(id))"), "definition")
            editDraft = FeatureAgentDraft.from(payload)
            detailError = nil
            blockers = []
            await loadCapabilities(workspaceId: payload["workspaceId"].stringValue)
        } catch {
            detailError = featureErrorMessage(error)
        }
    }

    func loadCapabilities(workspaceId: String) async {
        let query = workspaceId.isEmpty ? "/agent-capabilities" : "/agent-capabilities?workspaceId=\(FeatureAPI.segment(workspaceId))"
        capabilities = featureItems((try? await FeatureAPI.get(api, query)) ?? [:], key: "capabilities")
    }

    func save(_ draft: FeatureAgentDraft, enabling: Bool) async -> Bool {
        mutating = true
        defer { mutating = false }
        do {
            let isCreate = draft.id == "new"
            let saved: JSONValue
            if isCreate {
                saved = featureUnwrap(try await FeatureAPI.send(api, "/agents", method: "POST", body: try draft.requestJSON(includingRevision: false)), "definition")
            } else {
                saved = featureUnwrap(try await FeatureAPI.send(
                    api,
                    "/agents/\(FeatureAPI.segment(draft.id))",
                    method: "PATCH",
                    body: try draft.requestJSON(includingRevision: true)
                ), "definition")
            }
            applySaved(saved)
            if enabling {
                let enabled = try await FeatureAPI.send(api, "/agents/\(FeatureAPI.segment(saved.id))/enable", method: "POST")
                applySaved(featureUnwrap(enabled, "definition"))
            }
            detailError = nil
            blockers = []
            await refresh()
            return true
        } catch {
            captureBlockers(error)
            detailError = featureErrorMessage(error)
            return false
        }
    }

    func disable(id: String) async {
        await action(id, path: "disable")
    }

    func duplicate(id: String) async {
        await action(id, path: "duplicate")
    }

    func delete(id: String) async -> Bool {
        mutating = true
        defer { mutating = false }
        do {
            _ = try await FeatureAPI.send(api, "/agents/\(FeatureAPI.segment(id))", method: "DELETE")
            editDraft = nil
            await refresh()
            return true
        } catch {
            detailError = featureErrorMessage(error)
            return false
        }
    }

    private func action(_ id: String, path: String) async {
        mutating = true
        defer { mutating = false }
        do {
            let saved = featureUnwrap(try await FeatureAPI.send(api, "/agents/\(FeatureAPI.segment(id))/\(path)", method: "POST"), "definition")
            applySaved(saved)
            detailError = nil
            await refresh()
        } catch {
            captureBlockers(error)
            detailError = featureErrorMessage(error)
        }
    }

    private func applySaved(_ agent: JSONValue) {
        editDraft = FeatureAgentDraft.from(agent)
        if let index = agents.firstIndex(where: { $0.id == agent.id }) {
            agents[index] = agent
        } else {
            agents.insert(agent, at: 0)
        }
    }

    private func captureBlockers(_ error: Error) {
        let text = featureErrorMessage(error)
        if let parsed = try? JSONValue.parse(text), !parsed["blockers"].arrayValue.isEmpty {
            blockers = parsed["blockers"].arrayValue
        }
    }
}

func featureLines(_ text: String) -> [String] {
    text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
}

func featureAppendLine(_ text: String, _ line: String) -> String {
    let existing = Set(featureLines(text))
    if existing.contains(line) { return text }
    return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? line : text + "\n" + line
}
