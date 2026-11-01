import SwiftUI
import MichiCore
#if canImport(UIKit)
import UIKit
#endif

struct PageNavigationCommand: Equatable {
    let target: PageNavigationTarget
    let token: UUID

    init(target: PageNavigationTarget, token: UUID = UUID()) {
        self.target = target
        self.token = token
    }
}

private struct PageNavigationCommandKey: EnvironmentKey {
    static let defaultValue: PageNavigationCommand? = nil
}

private struct PageNavigationJumpKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

private struct PageNavigationHighlightKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

enum PageNavigationViewport: Hashable { case page, namedView(UUID) }
private struct PageNavigationViewportKey: EnvironmentKey {
    static let defaultValue = PageNavigationViewport.page
}

extension EnvironmentValues {
    var pageNavigationViewport: PageNavigationViewport {
        get { self[PageNavigationViewportKey.self] }
        set { self[PageNavigationViewportKey.self] = newValue }
    }
    var pageNavigationCommand: PageNavigationCommand? {
        get { self[PageNavigationCommandKey.self] }
        set { self[PageNavigationCommandKey.self] = newValue }
    }

    var pageNavigationJump: ((String) -> Void)? {
        get { self[PageNavigationJumpKey.self] }
        set { self[PageNavigationJumpKey.self] = newValue }
    }

    var pageNavigationHighlight: String? {
        get { self[PageNavigationHighlightKey.self] }
        set { self[PageNavigationHighlightKey.self] = newValue }
    }
}

/// Scrolls and highlights inside a named-view sheet. Resolves only the
/// displayed snapshot so a TOC tap cannot move the hidden parent page.
struct PageNavigationScopedViewport<Content: View>: View {
    let blocks: [JSONValue]
    @ViewBuilder let content: () -> Content
    @State private var command: PageNavigationCommand?
    @State private var highlight: String?
    @State private var viewportID = UUID()

    var body: some View {
        ScrollViewReader { proxy in
            content()
                .environment(\.pageNavigationCommand, command)
                .environment(\.pageNavigationHighlight, highlight)
                .environment(\.pageNavigationJump, { id in jump(id, proxy: proxy) })
                .environment(\.pageNavigationViewport, .namedView(viewportID))
                .modifier(PageNavigationScrollDriver(command: command, proxy: proxy, highlight: $highlight, viewport: .namedView(viewportID)))
                .onChange(of: blocks) { _, _ in command = nil; highlight = nil }
        }
    }

    private func jump(_ id: String, proxy: ScrollViewProxy) {
        guard case .scroll(let target) = PageNavigation.resolveInScope(targetID: id, blocks: blocks) else { return }
        command = PageNavigationCommand(target: target)
    }
}

private struct PageNavigationAvailabilityKey: PreferenceKey {
    static let defaultValue: [PageNavigationViewport: Set<PageNavigationScrollAnchor>] = [:]
    static func reduce(value: inout [PageNavigationViewport: Set<PageNavigationScrollAnchor>], nextValue: () -> [PageNavigationViewport: Set<PageNavigationScrollAnchor>]) {
        for (scope, anchors) in nextValue() { value[scope, default: []].formUnion(anchors) }
    }
}

/// Geometry preferences are emitted only once a real anchor has entered layout.
/// They intentionally carry no frame/state from an unrelated viewport.
struct PageNavigationAnchorPresence: ViewModifier {
    let anchor: PageNavigationScrollAnchor?
    @Environment(\.pageNavigationViewport) private var viewport
    init(id: String?) { anchor = id.flatMap { $0.isEmpty ? nil : .block($0) } }
    init(anchor: PageNavigationScrollAnchor) { self.anchor = anchor }

    func body(content: Content) -> some View {
        content.background {
            GeometryReader { geometry in
                Color.clear.preference(key: PageNavigationAvailabilityKey.self,
                    value: anchor.map { geometry.size.height > 0 ? [viewport: Set([$0])] : [:] } ?? [:])
            }
        }
    }
}

/// Shared by the page List and each separate named-view ScrollView. Repeated
/// taps cancel the old highlight, and disappearing snapshots cancel navigation.
struct PageNavigationScrollDriver: ViewModifier {
    let command: PageNavigationCommand?
    let proxy: ScrollViewProxy
    @Binding var highlight: String?
    var viewport: PageNavigationViewport = .page
    @State private var available = Set<PageNavigationScrollAnchor>()
    @State private var progress: PageNavigationScrollProgress?
    @State private var token: UUID?
    @State private var highlightTask: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .onPreferenceChange(PageNavigationAvailabilityKey.self) { value in
                available = value[viewport] ?? []; advance()
            }
            .task(id: command?.token) {
                highlightTask?.cancel(); highlight = nil
                token = command?.token
                progress = command.map { PageNavigationScrollProgress(target: $0.target) }
                advance()
            }
            .onDisappear { highlightTask?.cancel(); token = nil; progress = nil; highlight = nil }
    }

    private func advance() {
        guard let command, command.token == token, var current = progress,
              let step = current.next(available: available) else { return }
        progress = current
        let scroll = {
            switch step.anchor {
            case .block(let id): proxy.scrollTo(id, anchor: .top)
            case .namedViews: proxy.scrollTo(PageNavigationScrollAnchor.namedViews, anchor: .top)
            }
        }
        if step.completes {
            withAnimation { scroll() }
            highlight = command.target.scrollID
            highlightTask?.cancel()
            highlightTask = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(PageNavigation.highlightDuration)) } catch { return }
                guard !Task.isCancelled else { return }
                highlight = nil
            }
        } else {
            // Bootstrap has a real List identity even before its nested views
            // exist. A later preference update performs the final target scroll.
            scroll()
        }
    }
}

struct PageNavigationHighlight: ViewModifier {
    let id: String?
    @Environment(\.pageNavigationHighlight) private var highlight

    func body(content: Content) -> some View {
        content
            .background(id != nil && id == highlight ? Color.accentColor.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .accessibilityAddTraits(id != nil && id == highlight ? .isSelected : [])
    }
}

struct PageNavigationHeadingAnchor: ViewModifier {
    let id: String?
    @Environment(\.pageNavigationCommand) private var command
    @Environment(\.pageNavigationHighlight) private var highlight

    func body(content: Content) -> some View {
        if let id, !id.isEmpty {
            content
                .id(id)
                .accessibilityIdentifier(PageNavigation.blockAccessibilityID(id))
                .modifier(PageNavigationHighlight(id: id))
                .modifier(PageNavigationAnchorPresence(id: id))
                .background {
                    #if canImport(UIKit)
                    // List can resolve its row identity without resolving a
                    // Text identity nested inside that row. Only after the
                    // shared driver has revealed and laid out this target do
                    // we align its actual native frame, in its own viewport.
                    PageNavigationNativeHeadingAnchor(token:
                        command?.target.scrollID == id && highlight == id ? command?.token : nil)
                    #endif
                }
        } else {
            content
        }
    }
}

#if canImport(UIKit)
private struct PageNavigationNativeHeadingAnchor: UIViewRepresentable {
    let token: UUID?

    func makeUIView(context: Context) -> PageNavigationHeadingAnchorView {
        let view = PageNavigationHeadingAnchorView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: PageNavigationHeadingAnchorView, context: Context) {
        view.navigationToken = token
        view.scheduleNavigation()
    }
}

/// This view retains no scroll view or page controller. Looking up the nearest
/// enclosing native scroll view keeps inline/sheet named views independent.
private final class PageNavigationHeadingAnchorView: UIView {
    var navigationToken: UUID?
    private var completedToken: UUID?
    private var scheduled = false

    override func didMoveToWindow() {
        super.didMoveToWindow()
        scheduleNavigation()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scheduleNavigation()
    }

    func scheduleNavigation() {
        guard !scheduled, let token = navigationToken, token != completedToken else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled = false
            guard self.navigationToken == token else { self.scheduleNavigation(); return }
            guard token != self.completedToken, self.window != nil, self.bounds.height > 0 else { return }
            var ancestor = self.superview
            while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
            guard let scrollView = ancestor as? UIScrollView,
                  scrollView.window === self.window, scrollView.bounds.height > 0,
                  scrollView.contentSize.height > 0 else { return }
            let frame = self.convert(self.bounds, to: scrollView)
            let inset = scrollView.adjustedContentInset
            let minimumY = -inset.top
            let maximumY = max(minimumY, scrollView.contentSize.height - scrollView.bounds.height + inset.bottom)
            let desiredY = min(maximumY, max(minimumY, frame.minY - inset.top - 8))
            guard desiredY.isFinite else { return }
            self.completedToken = token
            scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: desiredY),
                                        animated: !UIAccessibility.isReduceMotionEnabled)
        }
    }
}
#endif
