import SwiftUI
import MichiCore

private struct NativePageComponentOwnershipKey: EnvironmentKey {
    static let defaultValue: NativePageComponentOwnership? = nil
}

private struct NativePageComponentActionsKey: EnvironmentKey {
    static let defaultValue = NativePageComponentActions.unused
}

extension EnvironmentValues {
    var nativePageComponentOwnership: NativePageComponentOwnership? {
        get { self[NativePageComponentOwnershipKey.self] }
        set { self[NativePageComponentOwnershipKey.self] = newValue }
    }

    var nativePageComponentActions: NativePageComponentActions {
        get { self[NativePageComponentActionsKey.self] }
        set { self[NativePageComponentActionsKey.self] = newValue }
    }
}

/// Bound page-block host. Identity is the page environment, never a workspace
/// guessed from the block. The runtime `StateObject` is remounted only when
/// credential/workspace/host/component bytes change.
struct NativePageBoundComponentHost: View {
    let api: MichiAPI
    let ownership: NativePageComponentOwnership
    let block: JSONValue
    var onNavigatePage: ((String) -> Void)?
    var onAskDraft: ((String) -> Void)?

    var body: some View {
        if let prepared = NativePageComponentContract.pageHost(ownership: ownership, block: block) {
            NativeComponentHostView(
                api: api,
                workspaceID: ownership.workspaceID,
                host: prepared.host,
                componentID: prepared.componentID,
                pinnedVersion: prepared.pinnedVersion,
                props: prepared.props,
                data: prepared.data,
                bindingKey: prepared.bindingKey,
                readOnly: ownership.readOnly,
                initialHeight: prepared.initialHeight,
                onNavigatePage: onNavigatePage,
                onAskDraft: onAskDraft,
                onDatabaseChanged: nil
            )
            .id(prepared.scope)
        }
    }
}

/// Bound custom database view. `data` must already be the saved-view snapshot.
struct NativeDatabaseBoundComponentHost: View {
    let api: MichiAPI
    let workspaceID: String
    let prepared: NativePageComponentPreparedHost
    let readOnly: Bool
    var onNavigatePage: ((String) -> Void)?
    var onAskDraft: ((String) -> Void)?
    var onDatabaseChanged: (() -> Void)?

    var body: some View {
        NativeComponentHostView(
            api: api,
            workspaceID: workspaceID,
            host: prepared.host,
            componentID: prepared.componentID,
            pinnedVersion: prepared.pinnedVersion,
            props: prepared.props,
            data: prepared.data,
            bindingKey: prepared.bindingKey,
            readOnly: readOnly,
            initialHeight: prepared.initialHeight,
            onNavigatePage: onNavigatePage,
            onAskDraft: onAskDraft,
            onDatabaseChanged: onDatabaseChanged
        )
        .id(prepared.scope)
    }
}
