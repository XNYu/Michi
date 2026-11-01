import SwiftUI
import MichiCore

/// Production host for a page block or database custom view. Preview mode
/// runs library source with isolated sample data and never calls the
/// capability service.
///
/// The runtime is created once per view identity, so it stays pinned to the
/// api credential, workspace, host and component it started with. Host,
/// component, pin, props, binding, data and read-only changes are applied
/// through `applyHost`; side-effect handlers are refreshed on every
/// evaluation, and a nil handler makes the matching request fail locally.
struct NativeComponentHostView: View {
    /// Inputs compared by exact bytes, so a change only in Unicode
    /// normalization still reaches the runtime.
    struct Inputs: Equatable {
        var host: JSONValue
        var componentID: String
        var pinnedVersion: Int?
        var props: JSONValue
        var data: JSONValue
        var bindingKey: JSONValue
        var readOnly: Bool
        var initialHeight: Int?

        static func == (a: Inputs, b: Inputs) -> Bool {
            a.pinnedVersion == b.pinnedVersion && a.readOnly == b.readOnly && a.initialHeight == b.initialHeight
                && ComponentSandbox.sameID(a.componentID, b.componentID)
                && ComponentSandbox.sameJSON(a.host, b.host) && ComponentSandbox.sameJSON(a.props, b.props)
                && ComponentSandbox.sameJSON(a.data, b.data) && ComponentSandbox.sameJSON(a.bindingKey, b.bindingKey)
        }
    }

    struct PreviewSource: Equatable {
        var name: String
        var code: String
        var version: Int

        static func == (a: PreviewSource, b: PreviewSource) -> Bool {
            a.version == b.version && a.name == b.name && ComponentSandbox.sameID(a.code, b.code)
        }
    }

    private let api: MichiAPI
    private let workspaceID: String
    private let inputs: Inputs
    private let previewSource: PreviewSource?
    private let onNavigatePage: ((String) -> Void)?
    private let onAskDraft: ((String) -> Void)?
    private let onDatabaseChanged: (() -> Void)?
    @StateObject private var model: NativeComponentRuntimeModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.michiAppearance) private var appearance
    @AppStorage("michi.appearance") private var appearanceMode = "dark"

    private var componentTheme: [String: String] {
        let palette = NativeAppearancePreferences.resolvedPalette(palette: appearance.palette, paletteExplicit: appearance.paletteExplicit, appearance: appearanceMode, systemIsLight: colorScheme == .light)
        return ComponentSandbox.theme(palette: palette, accent: appearance.accentOverrides[palette], uiFont: appearance.uiFont)
    }

    /// `bindingKey` is `[block.rev, block.edit]` for a page block or
    /// `[view.config, view.edit]` for a database view; a change re-mints. Page
    /// blocks read their `data` through the capability, so the `data`
    /// argument is used only for database views.
    init(api: MichiAPI, workspaceID: String, host: JSONValue, componentID: String, pinnedVersion: Int?,
         props: JSONValue, data: JSONValue, bindingKey: JSONValue = .null, readOnly: Bool = false,
         initialHeight: Int? = nil,
         onNavigatePage: ((String) -> Void)? = nil, onAskDraft: ((String) -> Void)? = nil,
         onDatabaseChanged: (() -> Void)? = nil) {
        self.api = api
        self.workspaceID = workspaceID
        self.inputs = Inputs(host: host, componentID: componentID, pinnedVersion: pinnedVersion, props: props,
                             data: data, bindingKey: bindingKey, readOnly: readOnly, initialHeight: initialHeight)
        self.previewSource = nil
        self.onNavigatePage = onNavigatePage
        self.onAskDraft = onAskDraft
        self.onDatabaseChanged = onDatabaseChanged
        _model = StateObject(wrappedValue: NativeComponentRuntimeModel(
            api: api, workspaceID: workspaceID, host: host, componentID: componentID,
            pinnedVersion: pinnedVersion, props: props, data: data, bindingKey: bindingKey, readOnly: readOnly,
            preview: false, initialHeight: initialHeight, theme: ComponentSandbox.theme(palette: "monokai")
        ))
    }

    /// Library source/version preview. Calls no capability and answers no host calls.
    init(api: MichiAPI, workspaceID: String, componentID: String, version: Int, name: String, code: String, props: JSONValue = [:]) {
        self.api = api
        self.workspaceID = workspaceID
        self.inputs = Inputs(host: .null, componentID: componentID, pinnedVersion: version, props: props,
                             data: ComponentSandbox.previewData, bindingKey: .null, readOnly: false, initialHeight: nil)
        self.previewSource = PreviewSource(name: name, code: code, version: version)
        self.onNavigatePage = nil
        self.onAskDraft = nil
        self.onDatabaseChanged = nil
        _model = StateObject(wrappedValue: NativeComponentRuntimeModel(
            api: api, workspaceID: workspaceID, host: .null, componentID: componentID,
            pinnedVersion: version, props: props, data: ComponentSandbox.previewData, readOnly: false, preview: true,
            theme: ComponentSandbox.theme(palette: "monokai")
        ))
    }

    /// The runtime keeps the server, credential and workspace it was created
    /// with; a caller that changes them without a new view identity is refused.
    private var scopeMatches: Bool {
        ComponentSandbox.sameID(model.api.baseURL.absoluteString, api.baseURL.absoluteString)
            && ComponentSandbox.sameID(model.api.credentialIdentityFingerprint, api.credentialIdentityFingerprint)
            && ComponentSandbox.sameID(model.workspaceID, workspaceID)
    }

    var body: some View {
        let _ = model.updateHandlers(navigate: onNavigatePage, draft: onAskDraft, databaseChanged: onDatabaseChanged)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(model.name) · v\(max(model.version, 1))")
                    .font(.subheadline.weight(.medium))
                if model.preview { Text("Sample preview · isolated data").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Stop") { model.stop() }.disabled(model.stopped || !scopeMatches)
                Button("Restart") { model.restart() }.disabled(!scopeMatches)
            }
            if !scopeMatches {
                Text("This component belongs to another connection or workspace. Reopen it to run it here.")
                    .font(.caption).foregroundStyle(.red)
            } else if model.readOnly && !model.preview {
                Label(NativeComponentRuntimeModel.readOnlyMessage, systemImage: "lock")
                    .font(.caption).foregroundStyle(.secondary)
            } else if model.stopped {
                if let error = model.error {
                    Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                }
                Text(model.notice ?? "This component was stopped. Use Restart to run it again.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if model.loading && model.session == nil {
                ProgressView("Loading component…")
            } else if let error = model.displayError, model.session == nil {
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            } else if model.showsSandbox {
                NativeComponentSandbox(model: model)
                    .frame(height: CGFloat(model.height))
                    .accessibilityLabel("\(model.name) component")
            }
            if scopeMatches, !model.stopped, model.session != nil, let error = model.error {
                Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
            }
            if let notice = model.notice, !model.stopped {
                Text(notice).font(.caption).foregroundStyle(.secondary)
            }
            if let unconfirmed = model.unconfirmedWrite {
                VStack(alignment: .leading, spacing: 4) {
                    Text(unconfirmed).font(.caption).foregroundStyle(.orange)
                    Button("I checked the data") { model.acknowledgeUnconfirmedWrite() }
                        .font(.caption)
                }
            }
        }
        .onChange(of: inputs) { previous, next in
            guard scopeMatches else { return }
            if previous.initialHeight != next.initialHeight { model.applyConfiguredHeight(next.initialHeight) }
            model.applyHost(host: next.host, componentID: next.componentID, pinnedVersion: next.pinnedVersion,
                            props: next.props, data: next.data, bindingKey: next.bindingKey, readOnly: next.readOnly)
        }
        .onChange(of: previewSource) { _, next in
            guard let next, scopeMatches else { return }
            model.updatePreviewSource(name: next.name, code: next.code, version: next.version)
        }
        .onAppear {
            model.applyTheme(componentTheme)
            guard scopeMatches else { return }
            if let previewSource {
                model.installPreviewSource(name: previewSource.name, code: previewSource.code, version: previewSource.version)
            } else {
                model.applyHost(host: inputs.host, componentID: inputs.componentID, pinnedVersion: inputs.pinnedVersion,
                                props: inputs.props, data: inputs.data, bindingKey: inputs.bindingKey, readOnly: inputs.readOnly)
            }
            model.appear()
        }
        .onDisappear { model.disappear() }
        .onChange(of: componentTheme) { _, next in
            model.applyTheme(next)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: model.enterBackground()
            case .active: model.enterForeground()
            default: break
            }
        }
    }
}
