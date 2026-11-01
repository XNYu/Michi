import Foundation
import Combine
import MichiCore

struct FeatureRuntimeDraft: Equatable {
    var runtime = ""
    var provider = ""
    var model = ""
    var reasoning = ""
    var webSearchProvider = ""
    var nativeResume = false
    var nativeFork = false
    var workflows = false
}

@MainActor
final class FeatureRuntimeSettingsModel: ObservableObject {
    let api: MichiAPI

    @Published var status: JSONValue = .null
    @Published var draft = FeatureRuntimeDraft()
    @Published var baseline = FeatureRuntimeDraft()
    @Published var runtimes: [JSONValue] = []
    @Published var providers: [JSONValue] = []
    @Published var models: [JSONValue] = []
    @Published var webSearchProviders: [JSONValue] = []
    @Published var capabilities: JSONValue = [:]
    @Published var ready = false
    @Published var saving = false
    @Published var error: String?
    private var catalogEpoch = 0

    init(api: MichiAPI) {
        self.api = api
    }

    var dirty: Bool { draft != baseline }

    var reasoningLevels: [String] {
        let listed = featureStringList(capabilities["supportedReasoningLevels"])
        return listed.isEmpty ? ["minimal", "low", "medium", "high", "xhigh", "max"] : listed
    }

    var workflowCapable: Bool {
        status["workflowRuntimes"].arrayValue.contains { $0.stringValue == draft.runtime }
    }

    func reload() async {
        do {
            let loaded = try await FeatureAPI.get(api, "/agent/status")
            status = loaded
            runtimes = loaded["availableRuntimes"].arrayValue
            webSearchProviders = loaded["webSearchProviders"].arrayValue
            capabilities = loaded["capabilities"]
            let next = featureRuntimeDraft(from: loaded, runtime: loaded["runtime"].stringValue)
            draft = next
            baseline = next
            ready = true
            error = nil
            await loadCatalog(for: next.runtime)
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
            ready = false
        }
    }

    func selectRuntime(_ runtime: String) async {
        guard ready, !runtime.isEmpty else { return }
        let webSearch = draft.webSearchProvider
        var next = featureRuntimeDraft(from: status, runtime: runtime)
        next.webSearchProvider = webSearch
        draft = next
        providers = []; models = []; capabilities = [:]
        await loadCatalog(for: runtime)
    }

    func loadCatalog(for runtime: String) async {
        guard !runtime.isEmpty else { return }
        catalogEpoch += 1
        let epoch = catalogEpoch
        let provider = draft.provider
        var path = "/agent/runtime-catalog?runtime=\(FeatureAPI.segment(runtime))"
        if !provider.isEmpty {
            path += "&provider=\(FeatureAPI.segment(provider))"
        }
        let catalog = try? await FeatureAPI.get(api, path)
        guard epoch == catalogEpoch, draft.runtime == runtime, draft.provider == provider else { return }
        if let catalog {
            if !catalog["providers"].arrayValue.isEmpty {
                providers = catalog["providers"].arrayValue
            } else if runtime == status["runtime"].stringValue {
                providers = status["providers"].arrayValue
            } else {
                providers = []
            }
            if let caps = featureOptional(catalog["capabilities"]) {
                capabilities = caps
            } else if runtime == status["runtime"].stringValue {
                capabilities = status["capabilities"]
            }
            if !catalog["models"].arrayValue.isEmpty {
                models = catalog["models"].arrayValue
                return
            }
        } else if runtime == status["runtime"].stringValue {
            providers = status["providers"].arrayValue
            capabilities = status["capabilities"]
        } else {
            providers = []
            models = []
            return
        }
        if runtime != status["runtime"].stringValue {
            models = []
            return
        }
        await loadModels()
    }

    func loadModels() async {
        guard !draft.runtime.isEmpty else { return }
        catalogEpoch += 1
        let epoch = catalogEpoch
        let runtime = draft.runtime
        let provider = draft.provider
        var path = "/agent/models?expectedRuntime=\(FeatureAPI.segment(runtime))"
        if !provider.isEmpty {
            path += "&provider=\(FeatureAPI.segment(provider))"
        }
        let payload = try? await FeatureAPI.get(api, path)
        guard epoch == catalogEpoch, draft.runtime == runtime, draft.provider == provider else { return }
        if let payload {
            models = payload["models"].arrayValue
        }
    }

    func save() async {
        guard ready, dirty else { return }
        saving = true
        defer { saving = false }
        do {
            let selectedBaseline = featureRuntimeDraft(from: status, runtime: draft.runtime)
            var body: [String: JSONValue] = [
                "expectedRuntime": .string(status["runtime"].stringValue),
            ]
            if draft.runtime != baseline.runtime { body["runtime"] = .string(draft.runtime) }
            if draft.provider != selectedBaseline.provider { body["provider"] = .string(draft.provider) }
            if draft.model != selectedBaseline.model { body["model"] = .string(draft.model) }
            if draft.reasoning != selectedBaseline.reasoning { body["reasoning"] = .string(draft.reasoning) }
            if draft.webSearchProvider != baseline.webSearchProvider {
                body["webSearchProvider"] = draft.webSearchProvider.isEmpty ? .null : .string(draft.webSearchProvider)
            }
            if draft.nativeResume != selectedBaseline.nativeResume {
                body["nativeResumeByRuntime"] = [draft.runtime: .bool(draft.nativeResume)]
            }
            if draft.nativeFork != selectedBaseline.nativeFork {
                body["nativeForkByRuntime"] = [draft.runtime: .bool(draft.nativeFork)]
            }
            if draft.workflows != selectedBaseline.workflows, workflowCapable {
                body["workflowsByRuntime"] = [draft.runtime: .bool(draft.workflows)]
            }
            let result = try await FeatureAPI.send(api, "/agent/options", method: "POST", body: .object(body))
            if result["ok"].featureOptionalBool == false {
                throw FeatureRequestError(message: featureError(from: result, fallback: "Couldn’t save runtime options"))
            }
            await reload()
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }
}

func featureRuntimeLabel(_ runtime: JSONValue) -> String {
    let label = runtime["label"].optionalString ?? runtime.id
    return runtime["available"].boolValue ? label : "\(label) (unavailable)"
}

func featureRuntimeFlag(_ map: JSONValue, runtime: String, absent: Bool) -> Bool {
    let value = map[runtime]
    return value.isNull ? absent : value.boolValue
}

func featureRuntimeDraft(from status: JSONValue, runtime: String) -> FeatureRuntimeDraft {
    let active = runtime == status["runtime"].stringValue
    var next = FeatureRuntimeDraft()
    next.runtime = runtime
    next.provider = status["providerByRuntime"][runtime].stringValue
    if next.provider.isEmpty, active { next.provider = status["provider"].stringValue }
    next.model = status["modelByRuntime"][runtime].stringValue
    if next.model.isEmpty, active { next.model = status["model"].stringValue }
    next.reasoning = status["reasoningByRuntime"][runtime].stringValue
    if next.reasoning.isEmpty, active { next.reasoning = status["reasoning"].stringValue }
    next.webSearchProvider = status["webSearchProvider"].stringValue
    next.nativeResume = featureRuntimeFlag(status["nativeResumeByRuntime"], runtime: runtime, absent: true)
    next.nativeFork = featureRuntimeFlag(status["nativeForkByRuntime"], runtime: runtime, absent: true)
    next.workflows = status["workflowsByRuntime"][runtime].boolValue
    return next
}
