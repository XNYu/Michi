import Foundation
import Combine
import MichiCore

private func serviceRequireOK(_ value: JSONValue) throws {
    guard value["ok"].boolValue else { throw FeatureRequestError(message: "The backend did not confirm this change.") }
}

/// Credential endpoints can return third-party error strings containing inputs.
/// Deliberately do not display their raw body or error description.
func serviceCredentialError(_ error: Error) -> String {
    if let error = error as? MichiAPIError, let status = error.statusCode {
        return "The credential request failed (HTTP \(status)). Check the connection and your settings."
    }
    return "The credential request could not be confirmed. Check its saved status before trying again."
}

@MainActor final class ServiceSettingsModel: ObservableObject {
    let api: MichiAPI
    @Published var status: JSONValue = .null
    @Published var keys: [String: String] = [:]
    @Published var searchProvider = ""
    @Published var ready = false
    @Published var busy = false
    @Published var error: String?
    @Published var message: String?
    private var searchBaseline = ""
    var providers: [JSONValue] { status["providers"].arrayValue.filter { !$0.id.isEmpty } }
    var searchProviders: [JSONValue] { status["webSearchProviders"].arrayValue.filter { !$0.id.isEmpty } }
    var searchDirty: Bool { searchProvider != searchBaseline }
    init(api: MichiAPI) { self.api = api }
    func keySlot(provider: String, search: Bool) -> String { (search ? "search:" : "model:") + provider }
    func canEdit(_ provider: JSONValue, search: Bool) -> Bool {
        search || (provider.id != "amazon-bedrock" && provider["requiresUserKey"].featureOptionalBool != false)
    }
    func reload() async {
        guard !busy else { return }
        do {
            let value = try await api.request("/agent/status")
            guard case .object = value, !value["runtime"].stringValue.isEmpty else { throw NativeFailure("Provider settings are unavailable.") }
            let dirty = searchDirty
            status = value
            if !dirty { searchProvider = value["webSearchProvider"].stringValue; searchBaseline = searchProvider }
            ready = true; error = nil
        } catch { self.error = featureErrorMessage(error) }
    }
    private func provider(_ id: String, search: Bool) -> JSONValue? {
        (search ? searchProviders : providers).first { $0.id == id }
    }
    func saveKey(provider id: String, search: Bool) async {
        let slot = keySlot(provider: id, search: search)
        let entered = keys[slot, default: ""]
        let key = entered.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ready, !busy, !key.isEmpty, let provider = provider(id, search: search), canEdit(provider, search: search) else { return }
        busy = true; defer { busy = false }
        do {
            try serviceRequireOK(try await api.request(search ? "/agent/search-key" : "/agent/provider-key", method: "POST", body: ["provider": .string(id), "key": .string(key)]))
            if keys[slot] == entered { keys[slot] = "" }
            updatePresence(id, search: search, present: true)
            message = "Key saved on the connected backend."; error = nil
        } catch { self.error = serviceCredentialError(error) }
    }
    func clearKey(provider id: String, search: Bool, confirmed: Bool) async {
        guard confirmed, ready, !busy, let provider = provider(id, search: search), canEdit(provider, search: search) else { return }
        busy = true; defer { busy = false }
        do {
            let base = search ? "/agent/search-key/" : "/agent/provider-key/"
            try serviceRequireOK(try await api.request(base + MichiAPI.pathSegment(id), method: "DELETE"))
            updatePresence(id, search: search, present: false)
            message = "Saved key cleared. Environment credentials, if configured, may still be available."; error = nil
        } catch { self.error = serviceCredentialError(error) }
    }
    func verifyKey(provider id: String) async {
        guard ready, !busy, let provider = provider(id, search: false), canEdit(provider, search: false) else { return }
        let key = keys[keySlot(provider: id, search: false), default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty || provider["hasKey"].boolValue else { return }
        busy = true; defer { busy = false }
        var body: JSONValue = ["provider": .string(id)]
        if !key.isEmpty { body["key"] = .string(key) }
        let model = status["provider"].stringValue == id ? status["model"] : provider["defaultModel"]
        if !model.stringValue.isEmpty { body["model"] = model }
        do {
            let result = try await api.request("/agent/provider-key/verify", method: "POST", body: body)
            message = result["ok"].boolValue ? "Provider connection verified." : "Provider verification failed. Check the key, model and provider access."
            error = nil
        } catch { self.error = serviceCredentialError(error) }
    }
    func saveSearchProvider() async {
        guard ready, !busy, searchDirty, !searchProviders.isEmpty,
              searchProvider.isEmpty || searchProviders.contains(where: { $0.id == searchProvider }) else { return }
        let selected = searchProvider; busy = true; defer { busy = false }
        do {
            try serviceRequireOK(try await api.request("/agent/options", method: "POST", body: ["webSearchProvider": selected.isEmpty ? .null : .string(selected)]))
            searchBaseline = selected; status["webSearchProvider"] = selected.isEmpty ? .null : .string(selected)
            message = "Search setting saved."; error = nil
        } catch { self.error = featureErrorMessage(error) }
    }
    private func updatePresence(_ id: String, search: Bool, present: Bool) {
        let field = search ? "webSearchProviders" : "providers"
        status[field] = .array(status[field].arrayValue.map { $0.id == id ? $0.merging(["hasKey": .bool(present)]) : $0 })
    }
    func clearEnteredSecrets() { keys = [:] }
}

struct NativeBedrockDraft: Equatable {
    var region = "us-east-1"
    var source = "profile"
    var profile = ""
    var bearerToken = ""
    var accessKeyID = ""
    var secretAccessKey = ""
    var refreshCommand = ""
    func requestBody() throws -> JSONValue {
        func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !trimmed(region).isEmpty else { throw NativeFailure("Enter an AWS region.") }
        var body: JSONValue = ["region": .string(trimmed(region)), "credentialSource": .string(source)]
        switch source {
        case "profile":
            guard !trimmed(profile).isEmpty else { throw NativeFailure("Enter the profile name on the connected computer.") }
            body["profile"] = .string(trimmed(profile))
        case "bearer-token":
            guard !trimmed(bearerToken).isEmpty else { throw NativeFailure("Enter the new bearer token.") }
            body["bearerToken"] = .string(trimmed(bearerToken))
        case "access-keys":
            guard !trimmed(accessKeyID).isEmpty, !trimmed(secretAccessKey).isEmpty else { throw NativeFailure("Enter both the access key ID and secret access key.") }
            body["accessKeyId"] = .string(trimmed(accessKeyID)); body["secretAccessKey"] = .string(trimmed(secretAccessKey))
        case "auto": break
        default: throw NativeFailure("Choose a supported credential source.")
        }
        // The backend replaces the Bedrock object; an explicit empty command
        // is part of this deliberate replacement, never an on-load default save.
        body["authRefreshCommand"] = .string(trimmed(refreshCommand))
        return body
    }
}

@MainActor final class BedrockSettingsModel: ObservableObject {
    let api: MichiAPI
    @Published var config: JSONValue = .null
    @Published var draft = NativeBedrockDraft()
    @Published var ready = false
    @Published var busy = false
    @Published var error: String?
    @Published var message: String?
    private var baseline = NativeBedrockDraft()
    var dirty: Bool { draft != baseline }
    var replacesConfiguration: Bool { config["configured"].boolValue || !config["region"].isNull || config["hasAuthRefresh"].boolValue || config["hasProfile"].boolValue || config["hasBearerToken"].boolValue || config["hasAccessKeys"].boolValue }
    init(api: MichiAPI) { self.api = api }
    func reload() async {
        guard !busy else { return }
        do {
            let value = try await api.request("/agent/bedrock-config")
            guard value["configured"].featureOptionalBool != nil, value["envDetected"].featureOptionalBool != nil else { throw NativeFailure("Bedrock configuration is unavailable.") }
            config = value; ready = true
            if !dirty {
                if let region = value["region"].optionalString { draft.region = region }
                if ["profile", "bearer-token", "access-keys", "auto"].contains(value["credentialSource"].stringValue) { draft.source = value["credentialSource"].stringValue }
                baseline = draft
            }
            error = nil
        } catch { self.error = serviceCredentialError(error) }
    }
    func save(confirmedReplacement: Bool) async {
        guard ready, !busy, (!replacesConfiguration || confirmedReplacement) else { return }
        let submitted = draft
        let body: JSONValue
        do { body = try submitted.requestBody() } catch { self.error = error.localizedDescription; return }
        busy = true; defer { busy = false }
        do {
            try serviceRequireOK(try await api.request("/agent/bedrock-config", method: "POST", body: body))
            // Keep any edit made while a save was running. Clear only the
            // submitted secret values; no secret is ever repopulated from GET.
            if draft.bearerToken == submitted.bearerToken { draft.bearerToken = "" }
            if draft.accessKeyID == submitted.accessKeyID { draft.accessKeyID = "" }
            if draft.secretAccessKey == submitted.secretAccessKey { draft.secretAccessKey = "" }
            if draft.refreshCommand == submitted.refreshCommand { draft.refreshCommand = "" }
            baseline = draft
            config = try await api.request("/agent/bedrock-config")
            message = "Bedrock configuration saved."; error = nil
        } catch { self.error = serviceCredentialError(error) }
    }
    func clear(confirmed: Bool) async {
        guard confirmed, ready, !busy else { return }
        busy = true; defer { busy = false }
        do {
            try serviceRequireOK(try await api.request("/agent/bedrock-config", method: "DELETE"))
            config = try await api.request("/agent/bedrock-config")
            clearEnteredSecrets(); message = "Saved Bedrock configuration cleared. Environment credentials are unchanged."; error = nil
        } catch { self.error = serviceCredentialError(error) }
    }
    func verify() async {
        guard ready, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let result = try await api.request("/agent/bedrock-config/verify", method: "POST", body: [:])
            message = result["ok"].boolValue ? "Saved Bedrock connection verified." : "Bedrock verification failed. Check the credentials and provider access."
            error = nil
        } catch { self.error = serviceCredentialError(error) }
    }
    func clearEnteredSecrets() { draft.bearerToken = ""; draft.accessKeyID = ""; draft.secretAccessKey = ""; draft.refreshCommand = "" }
}

@MainActor final class ServicePreferencesModel: ObservableObject {
    let api: MichiAPI
    @Published var telemetry: JSONValue = .null
    @Published var telemetryEnabled = false
    @Published var telemetryReady = false
    @Published var telemetryError: String?
    @Published var crewMode = "persistent"
    @Published var crewReady = false
    @Published var crewError: String?
    @Published var busy = false
    private var telemetryBaseline = false
    private var crewBaseline = "persistent"
    let crewModes = ["persistent", "incognito", "temporary"]
    var telemetryDirty: Bool { telemetryEnabled != telemetryBaseline }
    var crewDirty: Bool { crewMode != crewBaseline }
    init(api: MichiAPI) { self.api = api }
    func reload() async {
        guard !busy else { return }
        do {
            let value = try await api.request("/usage-telemetry")
            guard value["available"].featureOptionalBool != nil, let enabled = value["enabled"].featureOptionalBool else { throw NativeFailure("Usage reporting settings are unavailable.") }
            telemetry = value; telemetryReady = true; telemetryError = nil
            if !telemetryDirty { telemetryEnabled = enabled; telemetryBaseline = enabled }
        } catch { telemetryError = featureErrorMessage(error) }
        do {
            let value = try await api.request("/crew/memory")
            guard crewModes.contains(value["defaultMode"].stringValue) else { throw NativeFailure("Crew memory settings are unavailable.") }
            crewReady = true; crewError = nil
            if !crewDirty { crewMode = value["defaultMode"].stringValue; crewBaseline = crewMode }
        } catch { crewError = featureErrorMessage(error) }
    }
    func saveTelemetry() async {
        guard telemetryReady, telemetry["available"].boolValue, telemetryDirty, !busy else { return }
        let submitted = telemetryEnabled; busy = true; defer { busy = false }
        do {
            let result = try await api.request("/usage-telemetry", method: "PUT", body: ["enabled": .bool(submitted)])
            guard let actual = result["enabled"].featureOptionalBool else { throw NativeFailure("Usage reporting change was not confirmed.") }
            telemetry = result; telemetryBaseline = actual
            if telemetryEnabled == submitted { telemetryEnabled = actual }
            telemetryError = nil
        } catch { telemetryError = featureErrorMessage(error) }
    }
    func saveCrew() async {
        guard crewReady, crewDirty, crewModes.contains(crewMode), !busy else { return }
        let submitted = crewMode; busy = true; defer { busy = false }
        do {
            let result = try await api.request("/crew/memory", method: "POST", body: ["defaultMode": .string(submitted)])
            guard crewModes.contains(result["defaultMode"].stringValue) else { throw NativeFailure("Crew memory change was not confirmed.") }
            crewBaseline = result["defaultMode"].stringValue
            if crewMode == submitted { crewMode = crewBaseline }
            crewError = nil
        } catch { crewError = featureErrorMessage(error) }
    }
}

@MainActor final class MetaMaintenanceModel: ObservableObject {
    let api: MichiAPI
    @Published var overview: JSONValue = .null
    @Published var round: JSONValue = .null
    @Published var runResult: JSONValue = .null
    @Published var busy = false
    @Published var overviewReady = false
    @Published var roundReady = false
    @Published var outcomeUnknown = false
    @Published var error: String?
    @Published var overviewError: String?
    var running: Bool { round["workspaces"].arrayValue.contains { $0["running"].boolValue } }
    init(api: MichiAPI) { self.api = api }
    private func validOverview(_ value: JSONValue) -> Bool {
        guard case .array(let cursors) = value["cursors"], case .array = value["recentRuns"] else { return false }
        return ["running", "paused", "error"].contains(value["state"].stringValue) && cursors.count <= 10000
    }
    func reload() async {
        guard !busy else { return }
        do {
            let result = try await api.request("/meta-agent/overview")
            guard validOverview(result) else { throw NativeFailure("Meta agent overview is unavailable.") }
            overview = result; overviewReady = true; overviewError = nil
        } catch { overviewError = featureErrorMessage(error) }
        await refreshRound()
    }
    func refreshRound() async {
        do {
            let result = try await api.request("/meta-agent/run-now")
            guard case .array = result["workspaces"] else { throw NativeFailure("Meta agent run status is unavailable.") }
            round = result; roundReady = true; error = nil
        } catch { self.error = featureErrorMessage(error) }
    }
    func setPaused(_ paused: Bool, confirmed: Bool) async {
        guard confirmed, overviewReady, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let result = try await api.request(paused ? "/meta-agent/pause" : "/meta-agent/resume", method: "POST", body: [:])
            guard validOverview(result) else { throw NativeFailure("Maintenance state could not be confirmed. Refresh before another change.") }
            overview = result; overviewError = nil
        } catch { overviewError = featureErrorMessage(error) }
    }
    func runNow(confirmed: Bool) async {
        guard confirmed, roundReady, !busy, !running, !outcomeUnknown else { return }
        busy = true; defer { busy = false }
        do {
            let result = try await api.request("/meta-agent/run-now", method: "POST", body: [:])
            guard case .array = result["workspaces"] else { outcomeUnknown = true; throw NativeFailure("The run request could not be confirmed. Check recent runs before starting again.") }
            runResult = result
            // A started response is sufficient to prevent double taps even if
            // the immediate GET fails or the scheduler has not yet advanced.
            round = ["workspaces": .array(result["workspaces"].arrayValue.map { $0.merging(["running": .bool($0["outcome"] == "started")]) })]
            error = nil
        } catch {
            if let apiError = error as? MichiAPIError, apiError.statusCode == nil || (apiError.statusCode ?? 0) >= 500 { outcomeUnknown = true }
            self.error = featureErrorMessage(error)
        }
    }
    func acknowledgeReviewedOutcome() { if roundReady && !running { outcomeUnknown = false } }
}
