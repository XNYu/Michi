import SwiftUI
import MichiCore

/// How recommendation chrome is drawn. `standalone` is the historical
/// Chats-embedded view (greeting, default headline, vertical cards).
/// `dashboard` sits under Home's own hero: no second date/greeting, and
/// the designed horizontal hairline cards.
enum NativeHomeCardsPresentation: Equatable {
    case standalone
    case dashboard
}

/// Phone Home recommendations. Embed inside an existing `NavigationStack`.
///
/// Prefer `onSelection` so destination and prompt arrive in one value. The
/// older split callbacks still fire when `onSelection` is omitted.
///
/// A configured custom Home page renders inline with native rich blocks.
/// `onInlineDestination` is for thread, database, task, file and component
/// targets. `onPageNavigation` is TOC / named-block jump on the same page.
struct NativeHomeCards: View {
    @StateObject private var model: HomeCardsModel
    @Environment(\.michiAppearance) private var appearance
    @Environment(\.michiTokens) private var tokens
    let presentation: NativeHomeCardsPresentation
    let managesReload: Bool
    let workspaceIDs: [String]
    let hasConversation: Bool
    let onSelection: ((HomeCardPickResult) -> Void)?
    let onOpenConversation: ((String, String) -> Void)?
    let onPrompt: ((String) -> Void)?
    let onStartMention: (() -> Void)?
    let onOpenPagesHome: (() -> Void)?
    let onOpenContentPage: ((String, String) -> Void)?
    let onInlineDestination: ((NativeInlineHomeDestination) -> Void)?
    let onPageNavigation: ((PageNavigationJump) -> Void)?
    @State private var unsupportedNote: String?

    /// Existing callers. Owns a `HomeCardsModel` and draws standalone chrome.
    init(
        api: MichiAPI,
        workspaceIDs: [String] = [],
        hasConversation: Bool = true,
        onSelection: ((HomeCardPickResult) -> Void)? = nil,
        onOpenConversation: ((String, String) -> Void)? = nil,
        onPrompt: ((String) -> Void)? = nil,
        onStartMention: (() -> Void)? = nil,
        onOpenPagesHome: (() -> Void)? = nil,
        onOpenContentPage: ((String, String) -> Void)? = nil,
        onInlineDestination: ((NativeInlineHomeDestination) -> Void)? = nil,
        onPageNavigation: ((PageNavigationJump) -> Void)? = nil
    ) {
        _model = StateObject(wrappedValue: HomeCardsModel(api: api, workspaceIDs: workspaceIDs, hasConversation: hasConversation))
        self.presentation = .standalone
        self.managesReload = true
        self.workspaceIDs = workspaceIDs
        self.hasConversation = hasConversation
        self.onSelection = onSelection
        self.onOpenConversation = onOpenConversation
        self.onPrompt = onPrompt
        self.onStartMention = onStartMention
        self.onOpenPagesHome = onOpenPagesHome
        self.onOpenContentPage = onOpenContentPage
        self.onInlineDestination = onInlineDestination
        self.onPageNavigation = onPageNavigation
    }

    /// Shared-model entry for the Home dashboard. Does not fetch again.
    init(
        model: HomeCardsModel,
        presentation: NativeHomeCardsPresentation = .dashboard,
        workspaceIDs: [String] = [],
        hasConversation: Bool = true,
        onSelection: ((HomeCardPickResult) -> Void)? = nil,
        onOpenConversation: ((String, String) -> Void)? = nil,
        onPrompt: ((String) -> Void)? = nil,
        onStartMention: (() -> Void)? = nil,
        onOpenPagesHome: (() -> Void)? = nil,
        onOpenContentPage: ((String, String) -> Void)? = nil,
        onInlineDestination: ((NativeInlineHomeDestination) -> Void)? = nil,
        onPageNavigation: ((PageNavigationJump) -> Void)? = nil
    ) {
        _model = StateObject(wrappedValue: model)
        self.presentation = presentation
        self.managesReload = false
        self.workspaceIDs = workspaceIDs
        self.hasConversation = hasConversation
        self.onSelection = onSelection
        self.onOpenConversation = onOpenConversation
        self.onPrompt = onPrompt
        self.onStartMention = onStartMention
        self.onOpenPagesHome = onOpenPagesHome
        self.onOpenContentPage = onOpenContentPage
        self.onInlineDestination = onInlineDestination
        self.onPageNavigation = onPageNavigation
    }

    var body: some View {
        Group {
            if showsBody {
                content
                    .task {
                        if managesReload { await model.reload() }
                    }
            }
        }
        .onAppear { applyContext() }
        .onChange(of: hasConversation) { _, _ in applyContext() }
        .onChange(of: workspaceIDs) { _, _ in applyContext() }
    }

    private var showsBody: Bool {
        if model.showsCustomPageStatus { return true }
        return appearance.homeRecommendations
    }

    @ViewBuilder
    private var content: some View {
        if presentation == .dashboard {
            dashboard
        } else {
            standalone
        }
    }

    private var standalone: some View {
        VStack(alignment: .leading, spacing: 16) {
            if appearance.homeRecommendations {
                if model.showsDefaultHeadline {
                    Text("_ Another road diverged in a yellow wood.")
                        .font(.title2.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                        .accessibilityAddTraits(.isHeader)
                } else if model.showsGreetingChrome {
                    greeting
                }
            }
            if model.showsCustomPageStatus { customPage }
            if appearance.homeRecommendations, !model.visibleCards.isEmpty { standaloneGrid }
            notes
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    private var dashboard: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.showsCustomPageStatus {
                customPage
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
            }
            if appearance.homeRecommendations, !model.visibleCards.isEmpty {
                dashboardGrid
            }
            notes
                .padding(.horizontal, 20)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(HomeCardsFormat.eyebrow())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            if let greeting = model.snapshot.greeting {
                VStack(alignment: .leading, spacing: 4) {
                    Text("_ \(greeting.text)")
                        .font(.title3.weight(.semibold))
                    if let detail = greeting.detail {
                        Text(detail).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var customPage: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.showsInlineHomeDocument, let pageID = model.snapshot.contentPageID {
                NativeInlineHomeDocument(
                    api: model.api,
                    pageID: pageID,
                    workspaceID: model.snapshot.contentPageWorkspaceID,
                    initialPage: model.snapshot.contentPage,
                    onOpenConfiguredPage: { Task { deliver(await model.openContentPage()) } },
                    onDestination: handleInlineDestination,
                    onPageNavigation: onPageNavigation
                )
                .id(pageID)
            } else {
                Text(model.customPageUnavailableMessage)
                    .font(presentation == .dashboard ? MichiFont.rowSecondary : .subheadline)
                    .foregroundStyle(presentation == .dashboard ? tokens.muted : Color.secondary)
                    .accessibilityAddTraits(.isStaticText)
            }
        }
    }

    private var standaloneGrid: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Start here")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Spacer()
                if model.canShuffle {
                    Button { model.shuffle() } label: {
                        Label("Shuffle", systemImage: "arrow.clockwise")
                    }
                    .font(.caption)
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("home-cards-shuffle")
                }
                Button { deliver(model.pagesHomeSelection()) } label: {
                    Label("Full summary on Pages Home", systemImage: "chevron.right")
                }
                .font(.caption)
                .buttonStyle(.borderless)
                .accessibilityIdentifier("home-cards-pages-home")
            }
            ForEach(model.visibleCards) { card in
                Button { choose(card) } label: { NativeHomeCardRow(card: card) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("home-card")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Start here")
    }

    private var dashboardGrid: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(NativeHomeActivitySection.continueWork.title)
                    .font(MichiFont.section)
                    .tracking(0.88)
                    .textCase(.uppercase)
                    .foregroundStyle(tokens.muted)
                Spacer()
                if model.canShuffle {
                    Button { model.shuffle() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.clockwise")
                            Text("Shuffle")
                        }
                        .font(MichiFont.sans(size: 15, relativeTo: .subheadline, weight: .medium))
                        .foregroundStyle(tokens.accent)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("home-cards-shuffle")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 8)
            .accessibilityAddTraits(.isHeader)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(model.visibleCards) { card in
                        Button { choose(card) } label: {
                            NativeHomeDashboardCard(card: card)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("home-card")
                    }
                }
                .padding(.horizontal, 20)
            }

            Button { deliver(model.pagesHomeSelection()) } label: {
                HStack(spacing: 4) {
                    Text("Full summary on Pages Home")
                    Image(systemName: "chevron.right")
                }
                .font(MichiFont.rowSecondary)
                .foregroundStyle(tokens.muted)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .accessibilityIdentifier("home-cards-pages-home")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(NativeHomeActivitySection.continueWork.title)
    }

    @ViewBuilder
    private var notes: some View {
        if let unsupportedNote {
            Text(unsupportedNote)
                .font(presentation == .dashboard ? MichiFont.rowSecondary : .footnote)
                .foregroundStyle(presentation == .dashboard ? tokens.muted : Color.secondary)
        }
        if let error = model.error {
            Text(error)
                .font(presentation == .dashboard ? MichiFont.rowSecondary : .footnote)
                .foregroundStyle(presentation == .dashboard ? tokens.dangerText : Color.red)
        }
        if model.loading && !model.loaded {
            ProgressView("Loading Home…")
                .frame(maxWidth: .infinity)
        }
    }

    private func applyContext() {
        model.workspaceIDs = Set(workspaceIDs)
        model.hasConversation = hasConversation
    }

    private func choose(_ card: HomeCardRecord) {
        Task { deliver(await model.pick(card)) }
    }

    private func handleInlineDestination(_ destination: NativeInlineHomeDestination) {
        onInlineDestination?(destination)
        switch destination {
        case .page(let id, let workspace):
            deliver(model.linkedPageSelection(pageID: id, workspaceID: workspace))
        case .prompt(let text):
            deliver(model.composeFromDocument(text))
        case .thread(let id, let workspace):
            if onSelection == nil { onOpenConversation?(workspace, id) }
        case .database, .tasks, .file, .component:
            break
        }
    }

    /// One click → one result. `onSelection` is the atomic path. Split
    /// callbacks run only when it is omitted, so a draft is not written twice.
    private func deliver(_ result: HomeCardPickResult) {
        if let onSelection {
            onSelection(result)
            unsupportedNote = note(for: result, usingUnified: true)
            return
        }
        if result.openPagesHome { onOpenPagesHome?() }
        if result.startMention { onStartMention?() }
        if let pageID = result.contentPageID, let workspaceID = result.contentPageWorkspaceID {
            onOpenContentPage?(pageID, workspaceID)
        }
        if let workspaceID = result.workspaceID, let nodeID = result.nodeID {
            onOpenConversation?(workspaceID, nodeID)
        }
        if let prompt = result.prompt { onPrompt?(prompt) }
        unsupportedNote = note(for: result, usingUnified: false)
    }

    private func note(for result: HomeCardPickResult, usingUnified: Bool) -> String? {
        if result.startMention, !usingUnified, onStartMention == nil {
            return "Type @ in a conversation composer. Home does not start a mention from this list."
        }
        if result.openPagesHome, !usingUnified, onOpenPagesHome == nil {
            return "Pages Home is not opened from these cards on the phone list."
        }
        if result.kind == .contentPage, result.contentPageID == nil {
            return model.customPageUnavailableMessage
        }
        return nil
    }
}

private struct NativeHomeDashboardCard: View {
    let card: HomeCardRecord
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .medium))
                Text(card.label)
                    .font(MichiFont.tag)
                    .tracking(0.66)
                    .textCase(.uppercase)
                    .lineLimit(1)
            }
            .foregroundStyle(tokens.muted)
            Text(card.title)
                .font(MichiFont.row)
                .foregroundStyle(tokens.fg)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(width: 240, alignment: .leading)
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.label). \(card.title). \(card.buttonText)")
    }

    private var icon: String {
        switch card.kind {
        case "continue": return "bubble.left.and.bubble.right"
        case "try": return "arrow.triangle.branch"
        case "from-space": return "doc.text"
        case "review": return "calendar"
        case "stalled": return "pause.circle"
        case "discover": return "arrow.clockwise"
        case "tip": return "lightbulb"
        default: return "square"
        }
    }
}

private struct NativeHomeCardRow: View {
    let card: HomeCardRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(card.label, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tone)
                .labelStyle(.titleAndIcon)
                .lineLimit(1)
            Text(card.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
            if !card.reason.isEmpty {
                Text(card.reason)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
            HStack(spacing: 4) {
                Text(card.buttonText)
                Image(systemName: "chevron.right")
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.secondary.opacity(0.18), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.label). \(card.title). \(card.buttonText)")
    }

    private var icon: String {
        switch card.kind {
        case "continue": return "chevron.right"
        case "try": return "arrow.triangle.branch"
        case "from-space": return "doc"
        case "review": return "calendar"
        case "stalled": return "pause.circle"
        case "discover": return "arrow.clockwise"
        case "tip": return "lightbulb"
        default: return "square"
        }
    }

    private var tone: Color {
        switch card.kind {
        case "continue": return .accentColor
        case "try": return .purple
        case "from-space": return .blue
        case "review": return .orange
        default: return .secondary
        }
    }
}
