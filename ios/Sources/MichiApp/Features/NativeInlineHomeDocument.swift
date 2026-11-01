import SwiftUI
import MichiCore

/// Chat Home's configured page, embedded in the conversations list row.
/// Do not wrap this in NavigationStack, List, or ScrollView — Home already
/// sits in that stack. Named views still use NativeRichPageBlock's sheet.
///
/// Nested TOC buttons cannot scroll the outer conversations `List`. A unique
/// current heading opens the native page at that exact block instead.
struct NativeInlineHomeDocument: View {
    @StateObject private var model: NativeInlineHomeDocumentModel
    @StateObject private var homeSections: NativePageHomeSectionModel
    @Environment(\.scenePhase) private var scenePhase
    let pageID: String
    let workspaceID: String?
    let initialPage: JSONValue
    let onOpenConfiguredPage: () -> Void
    let onDestination: ((NativeInlineHomeDestination) -> Void)?
    let onPageNavigation: ((PageNavigationJump) -> Void)?
    @State private var pageVisible = false

    init(
        api: MichiAPI,
        pageID: String,
        workspaceID: String? = nil,
        initialPage: JSONValue = .null,
        onOpenConfiguredPage: @escaping () -> Void,
        onDestination: ((NativeInlineHomeDestination) -> Void)? = nil,
        onPageNavigation: ((PageNavigationJump) -> Void)? = nil
    ) {
        self.pageID = pageID
        self.workspaceID = workspaceID
        self.initialPage = initialPage
        self.onOpenConfiguredPage = onOpenConfiguredPage
        self.onDestination = onDestination
        self.onPageNavigation = onPageNavigation
        _model = StateObject(wrappedValue: NativeInlineHomeDocumentModel(
            api: api, pageID: pageID, workspaceID: workspaceID, initial: initialPage
        ))
        _homeSections = StateObject(wrappedValue: NativePageHomeSectionModel(api: api))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let status = model.statusMessage {
                Text(status)
                    .font(MichiFont.rowSecondary)
                    .foregroundStyle(model.canRender ? Color.secondary : Color.primary)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier("home-inline-status")
            }
            if model.canRetryLiveRefresh {
                Button(NativeInlineHomeContract.retryTitle) { Task { await model.refresh() } }
                    .accessibilityIdentifier("home-inline-retry")
            }
            if let custom = model.unsupportedCustomMessage {
                NativeInlineHomeUnsupportedNotice(message: custom)
            }
            if model.showsLoading {
                ProgressView(NativeInlineHomeContract.loadingMessage)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("home-inline-loading")
            } else if model.canRender {
                document
            }
            if model.canOpenPage {
                Button(NativeInlineHomeContract.openPageTitle, action: onOpenConfiguredPage)
                    .accessibilityIdentifier("home-open-content-page")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .nativeMichiReferences(api: model.api)
        .environment(\.nativePageComponentOwnership, model.pageComponentOwnership(api: model.api))
        .environment(\.nativePageComponentActions, NativePageComponentActions(
            onNavigatePage: onDestination == nil ? nil : { emit(model.pageDestination($0)) },
            onAskDraft: onDestination == nil ? nil : { emit(.prompt($0)) }
        ))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Home content")
        .accessibilityIdentifier("home-inline-document")
        .task(id: pageID) {
            await model.bind(pageID: pageID, workspaceID: workspaceID, initial: initialPage)
        }
        .task(id: pageVisible && scenePhase == .active && hasHomeSections) {
            guard pageVisible, scenePhase == .active, hasHomeSections else { homeSections.stop(); return }
            while !Task.isCancelled {
                await homeSections.refresh()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
        .onChange(of: initialPage) { _, next in
            model.adoptCardsPage(next)
        }
        .onAppear { pageVisible = true }
        .onDisappear { pageVisible = false; homeSections.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { homeSections.stop() }
        }
    }

    private var hasHomeSections: Bool { NativePageHomeSectionModel.containsSection(in: model.blocks) }

    private var document: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.stale {
                Text("This Home page changed. Open it in Pages or refresh before editing.")
                    .font(MichiFont.meta)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("home-inline-readonly")
            }
            ForEach(model.visibleBlockItems) { item in
                NativeRichPageBlock(
                    block: item.block,
                    pageBlocks: model.blocks,
                    onApply: model.readOnly ? nil : { input, id, rev in
                        await model.updateBlock(id: id, expectRev: rev, input: input)
                    },
                    onOpenThread: { id in emit(model.threadDestination(id)) },
                    onOpenPage: { id in emit(model.pageDestination(id)) },
                    onOpenDatabase: { id, view in emit(model.databaseDestination(id: id, viewID: view)) },
                    onOpenTasks: { view in emit(model.tasksDestination(viewID: view)) },
                    onPrompt: { prompt in
                        guard onDestination != nil else { return false }
                        emit(.prompt(prompt))
                        return true
                    },
                    onOpenFile: { path in emit(model.fileDestination(path: path)) },
                    onScrollToBlock: jumpToHeading,
                    onOpenComponent: { id, version in emit(model.componentDestination(id: id, version: version.map(String.init))) },
                    homeSectionContent: { key in
                        if let section = NativeHomeSection(rawValue: key) {
                            return AnyView(NativePageHomeSectionView(model: homeSections, section: section, onOpen: openReminder))
                        }
                        return AnyView(Text("This reminder section is unsupported."))
                    }
                )
                .id(item.id)
                .accessibilityIdentifier(PageNavigation.blockAccessibilityID(item.id))
            }
        }
    }

    private func emit(_ destination: NativeInlineHomeDestination?) {
        guard let destination else { return }
        onDestination?(destination)
    }

    /// Home is one conversations-list row, so this cannot `scrollTo` a nested
    /// heading. A unique live target jumps to the native page at that block.
    private func jumpToHeading(_ id: String) {
        if case .openPage(let jump) = PageNavigation.resolveHomeJump(
            targetID: id,
            pageID: model.expectedID,
            workspaceID: model.workspaceID,
            blocks: model.blocks
        ) {
            onPageNavigation?(jump)
        }
    }

    private func openReminder(_ item: NativeHomeSectionItem) {
        switch item.target {
        case .conversation(let node, let workspace):
            emit(.thread(id: node, workspaceID: workspace))
        case .page(let page, _, _):
            let workspace = item.workspaceID ?? model.workspaceID
            emit(workspace.isEmpty ? nil : .page(id: page, workspaceID: workspace))
        }
    }
}

struct NativeInlineHomeUnsupportedNotice: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("home-inline-unsupported-custom")
    }
}
