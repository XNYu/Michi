import SwiftUI
import MichiCore

/// Global runtime, model, and option settings. Reads /agent/status before any patch.
/// Runtime, provider and model names come from the backend's catalog.
struct RuntimeSettingsScreen: View {
    let api: MichiAPI

    @StateObject private var model: FeatureRuntimeSettingsModel

    init(api: MichiAPI) {
        self.api = api
        _model = StateObject(wrappedValue: FeatureRuntimeSettingsModel(api: api))
    }

    var body: some View {
            Group {
                if !model.ready {
                    if let error = model.error {
                        List {
                            DesignSettingsSection {
                                DesignSettingsErrorRow(title: "Couldn’t load runtime settings", message: error, retry: { Task { await model.reload() } })
                            }
                        }
                        .designSettingsList()
                    } else {
                        DesignSettingsLoading(message: "Reading current settings")
                    }
                } else {
                    List {
                        if let error = model.error {
                            DesignSettingsSection {
                                DesignSettingsErrorRow(title: "Update failed", message: error, retry: { Task { await model.reload() } })
                            }
                        }
                        DesignSettingsSection(title: "Runtime") {
                            DesignSettingsMenuPicker(title: "Runtime", selection: $model.draft.runtime, options: options(model.runtimes, label: featureRuntimeLabel, current: model.draft.runtime))
                                .disabled(model.runtimes.isEmpty)
                            if let selected = model.runtimes.first(where: { $0.id == model.draft.runtime }),
                               let reason = selected["unavailableReason"].optionalString, !reason.isEmpty {
                                DesignSettingsNote(text: reason, tone: .bad)
                            }
                        }
                        if model.capabilities["providerModels"].boolValue && !model.providers.isEmpty {
                            DesignSettingsSection(title: "Provider") {
                                DesignSettingsMenuPicker(title: "Provider", selection: $model.draft.provider, options: options(model.providers, label: { $0["label"].optionalString ?? $0.id }, current: model.draft.provider))
                            }
                        }
                        if model.capabilities["models"].boolValue {
                            DesignSettingsSection(title: "Model") {
                                if model.models.isEmpty {
                                    DesignSettingsFieldRow(title: "Model id", prompt: "Model id", text: $model.draft.model)
                                } else {
                                    DesignSettingsMenuPicker(title: "Model", selection: $model.draft.model, options: options(model.models, label: { $0["label"].optionalString ?? $0.id }, current: model.draft.model))
                                }
                            }
                        }
                        if model.capabilities["reasoning"].boolValue && !model.reasoningLevels.isEmpty {
                            DesignSettingsSection(title: "Reasoning") {
                                DesignSettingsMenuPicker(title: "Reasoning", selection: $model.draft.reasoning, options: designSettingsOptions(model.reasoningLevels.map { ($0, $0) }, current: model.draft.reasoning))
                            }
                        }
                        if !model.webSearchProviders.isEmpty {
                            DesignSettingsSection(title: "Web search") {
                                DesignSettingsMenuPicker(title: "Provider", selection: $model.draft.webSearchProvider, options: [DesignSettingsOption(value: "", label: "None")] + options(model.webSearchProviders, label: { $0["label"].optionalString ?? $0.id }, current: model.draft.webSearchProvider, allowEmpty: true))
                            }
                        }
                        if model.capabilities["nativeResume"].boolValue {
                            DesignSettingsSection(title: "Session") {
                                DesignSettingsToggle(title: "Native resume", isOn: $model.draft.nativeResume)
                                DesignSettingsToggle(title: "Native fork", isOn: $model.draft.nativeFork)
                            }
                        }
                        if model.workflowCapable {
                            DesignSettingsSection(title: "Workflows") {
                                DesignSettingsToggle(title: "Enable workflows", isOn: $model.draft.workflows)
                            }
                        }
                        DesignSettingsSection(footer: "Settings are read first. Nothing is written until you save.") {
                            DesignSettingsActionRow(title: model.saving ? "Saving…" : "Save", busy: model.saving) { Task { await model.save() } }
                                .disabled(!model.dirty || model.saving)
                        }
                        DesignSettingsSection(title: "Current") {
                            LabeledContent("Active", value: model.status["label"].optionalString ?? model.status["runtime"].stringValue)
                            LabeledContent("Has required key", value: model.status["hasRequiredKey"].boolValue ? "Yes" : "No")
                            NavigationLink {
                                FeatureInspectView(value: model.status, title: "Agent status")
                            } label: {
                                DesignSettingsNavLabel(title: "Inspect status")
                            }
                        }
                    }
                    .designSettingsList()
                }
            }
            .designSettingsTitle("Runtime & models")
            .refreshable { await model.reload() }
            .featureBusy(model.saving)
            .onChange(of: model.draft.runtime) { _, runtime in
                if model.ready { Task { await model.selectRuntime(runtime) } }
            }
            .onChange(of: model.draft.provider) { _, _ in
                if model.ready { Task { await model.loadModels() } }
            }
            .task { await model.reload() }

    }

    /// Catalog entries by id, keeping a saved id the catalog no longer lists.
    private func options(_ items: [JSONValue], label: (JSONValue) -> String, current: String, allowEmpty: Bool = false) -> [DesignSettingsOption<String>] {
        var list = items.map { DesignSettingsOption(value: $0.id, label: label($0)) }
        if !list.contains(where: { $0.value == current }) && !(allowEmpty && current.isEmpty) {
            list.append(DesignSettingsOption(value: current, label: current.isEmpty ? "None" : "Current: " + current))
        }
        return list
    }
}
