import SwiftUI
import MichiCore

/// Native, read-only navigation surface. Camera and selection are local UI
/// state; dragging never writes saved graph coordinates or modifies ownership.
/// Dot-grid paper, ASKED quote cards and a floating selected-node card follow
/// the web map; VoiceOver and large Dynamic Type use the list presentation.
struct NativeWorkspaceGraph: View {
    let layout: WorkspaceGraphLayout
    var showsList = false
    /// Full-screen canvas with floating glass controls (Map screen).
    var fullBleed = false
    /// Opening user prompt for a root card's ASKED band, when saved.
    var asked: ((JSONValue) -> String)? = nil
    let title: (JSONValue) -> String
    let summary: (JSONValue) -> String
    let onOpen: ((String) -> Void)?
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.michiTokens) private var tokens
    @State private var camera = WorkspaceGraphCamera()
    @State private var dragStart: WorkspaceGraphCamera?
    @State private var pinchStart: WorkspaceGraphCamera?
    @State private var selectedID: String?

    private var selected: WorkspaceGraphItem? { layout.nodes.first { $0.id == selectedID } }
    private var useList: Bool { showsList || voiceOver || dynamicType >= .xxLarge }

    var body: some View {
        Group {
            if fullBleed && !useList && !layout.nodes.isEmpty { canvasScreen }
            else if fullBleed { ScrollView { embedded.padding(.horizontal, 20).padding(.vertical, 12) } }
            else { embedded }
        }
        .onChange(of: layout.nodes.map(\.id)) { _, ids in if let selectedID, !ids.contains(selectedID) { self.selectedID = nil } }
    }

    // MARK: Full-bleed canvas

    private var canvasScreen: some View {
        GeometryReader { geometry in
            let width = Double(geometry.size.width), height = max(1.0, Double(geometry.size.height))
            ZStack(alignment: .bottom) {
                surface(width: width, height: height)
                VStack(spacing: 12) {
                    floatingControls(width: width, height: height)
                    if let selected { selectedCard(selected) }
                    if layout.omittedNodeCount > 0 || layout.inputLimited { limitNote.padding(.horizontal, 8) }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            }
            .onAppear { camera = .fit(layout, width: width, height: height) }
            .onChange(of: geometry.size) { _, size in camera = camera.clamped(layout: layout, width: Double(size.width), height: max(1.0, Double(size.height))) }
        }
        .ignoresSafeArea(edges: .bottom)
    }

    private func floatingControls(width: Double, height: Double) -> some View {
        HStack(spacing: 10) {
            HStack(spacing: 0) {
                Button { zoom(1 / 1.4, width: width, height: height) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom out")
                Text(camera.scale.formatted(.percent.precision(.fractionLength(0))))
                    .font(MichiFont.mono(size: 14, relativeTo: .footnote)).monospacedDigit().frame(minWidth: 48)
                    .accessibilityLabel("Zoom \(Int(camera.scale * 100)) percent")
                Button { zoom(1.4, width: width, height: height) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom in")
            }
            .font(.system(size: 17, weight: .medium))
            .buttonStyle(.plain)
            .foregroundStyle(tokens.fg)
            .padding(.horizontal, 4)
            .michiGlassCapsule()
            Spacer(minLength: 0)
            Button { focusRoot(width: width, height: height) } label: { Text("Root").padding(.horizontal, 14).frame(minHeight: 44) }
                .buttonStyle(.plain).foregroundStyle(tokens.fg).michiGlassCapsule()
            Button { camera = .fit(layout, width: width, height: height); resetGesture() } label: { Text("Fit").padding(.horizontal, 14).frame(minHeight: 44) }
                .buttonStyle(.plain).foregroundStyle(tokens.fg).michiGlassCapsule()
                .accessibilityLabel("Fit all")
        }
        .font(MichiFont.sans(size: 15, relativeTo: .body, weight: .medium))
    }

    private func selectedCard(_ item: WorkspaceGraphItem) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title(item.node)).font(MichiFont.mono(size: 13.5, relativeTo: .subheadline, weight: .semibold)).foregroundStyle(tokens.fg).lineLimit(1)
                Text(selectionDetail(item)).font(MichiFont.meta).foregroundStyle(tokens.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            Button("Clear selection", systemImage: "xmark") { selectedID = nil }
                .labelStyle(.iconOnly).buttonStyle(.plain).foregroundStyle(tokens.muted).frame(width: 44, height: 44)
            Button("Open") { onOpen?(item.id) }
                .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .semibold))
                .michiGlassButton(prominent: true).tint(tokens.accent)
                .disabled(onOpen == nil)
                .accessibilityLabel("Open conversation")
        }
        .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 10)
        .michiGlassRounded(12)
    }

    // MARK: Embedded / list

    private var embedded: some View {
        VStack(alignment: .leading, spacing: 12) {
            if layout.nodes.isEmpty {
                ContentUnavailableView("No visible conversations", systemImage: "point.3.connected.trianglepath.dotted")
            } else if useList {
                if !showsList { Text("List view is shown for accessibility.").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted) }
                accessibleList
            } else {
                GeometryReader { geometry in
                    VStack(spacing: 10) {
                        controls(width: geometry.size.width, height: geometry.size.height - 48)
                        surface(width: geometry.size.width, height: geometry.size.height - 48)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1))
                    }
                    .onAppear { camera = .fit(layout, width: Double(geometry.size.width), height: max(1.0, Double(geometry.size.height) - 48.0)) }
                    .onChange(of: geometry.size) { _, size in camera = camera.clamped(layout: layout, width: Double(size.width), height: max(1.0, Double(size.height) - 48.0)) }
                }.frame(height: 510)
                Text("Drag to pan and pinch to zoom. Select a card to inspect it, then open its conversation.")
                    .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
            }
            if let selected, useList || !fullBleed {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(title(selected.node)).font(MichiFont.mono(size: 14, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg)
                        Spacer()
                        Button("Clear selection", systemImage: "xmark.circle") { selectedID = nil }.labelStyle(.iconOnly).foregroundStyle(tokens.muted).frame(minWidth: 44, minHeight: 44)
                    }
                    if selected.isContext { Label("Merged context from another thread", systemImage: "arrow.triangle.merge").font(MichiFont.rowSecondary).foregroundStyle(tokens.muted) }
                    let text = summary(selected.node)
                    if !text.isEmpty { NativeMarkdown(text: String(text.prefix(1_200))) }
                    Button("Open conversation", systemImage: "bubble.left.and.text.bubble.right") { onOpen?(selected.id) }
                        .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .semibold))
                        .michiGlassButton(prominent: true).tint(tokens.accent).disabled(onOpen == nil)
                }
                .padding(12)
                .background(tokens.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1) }
            }
            if layout.omittedNodeCount > 0 || layout.inputLimited { limitNote }
            Text("Solid lines show branches. Dashed lines show merges; dotted lines show references. Merge context and references do not change a conversation’s thread.")
                .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
        }
    }

    private var limitNote: some View {
        Text("This map shows \(layout.nodes.count) conversations\(layout.omittedNodeCount > 0 ? "; \(layout.omittedNodeCount) more are outside its limit" : ""). Use Doc view to browse additional conversations.")
            .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
    }

    private var accessibleList: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(layout.nodes) { item in
                Button { selectedID = item.id } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: item.isContext ? "arrow.triangle.merge" : item.parentID == nil ? "bubble.left" : "arrow.turn.down.right")
                            .foregroundStyle(tokens.mid).frame(width: 24)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(title(item.node)).font(MichiFont.rowTitle).foregroundStyle(tokens.fg)
                            Text(detail(item)).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                        }
                        Spacer()
                        if selectedID == item.id { Image(systemName: "checkmark").foregroundStyle(tokens.accent) }
                    }
                    .padding(.vertical, 10).padding(.leading, CGFloat(min(item.depth, 4)) * 16)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .background(selectedID == item.id ? tokens.alt : .clear)
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .overlay(alignment: .bottom) { Rectangle().fill(tokens.sep).frame(height: 1) }
                    .accessibilityLabel(title(item.node) + ". " + detail(item))
                    .accessibilityHint("Select to inspect this conversation")
                    .accessibilityAddTraits(selectedID == item.id ? .isSelected : [])
                    .accessibilityAction(named: Text("Open conversation")) { onOpen?(item.id) }
                    .contextMenu { Button("Open conversation") { onOpen?(item.id) }.disabled(onOpen == nil) }
            }
        }
    }

    private func controls(width: Double, height: Double) -> some View {
        HStack(spacing: 14) {
            Button("Zoom out", systemImage: "minus") { zoom(1 / 1.4, width: width, height: height) }.labelStyle(.iconOnly)
            Text(camera.scale.formatted(.percent.precision(.fractionLength(0)))).font(MichiFont.mono(size: 13, relativeTo: .caption)).monospacedDigit().frame(minWidth: 42)
                .accessibilityLabel("Zoom \(Int(camera.scale * 100)) percent")
            Button("Zoom in", systemImage: "plus") { zoom(1.4, width: width, height: height) }.labelStyle(.iconOnly)
            Spacer(minLength: 0)
            Button("Root") { focusRoot(width: width, height: height) }
            Button("Fit all") { camera = .fit(layout, width: width, height: height); resetGesture() }
        }
        .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .medium))
        .michiGlassButton()
        .frame(height: 38)
    }

    private func surface(width: Double, height: Double) -> some View {
        let positions = Dictionary(uniqueKeysWithValues: layout.nodes.map { ($0.id, $0.point) })
        return ZStack(alignment: .topLeading) {
            MichiMapBackground()
            Canvas { context, _ in
                for edge in layout.edges {
                    guard let source = positions[edge.source], let target = positions[edge.target] else { continue }
                    let start = point(.init(x: source.x + WorkspaceGraphLayout.cardWidth / 2, y: source.y))
                    let end = point(.init(x: target.x - WorkspaceGraphLayout.cardWidth / 2, y: target.y))
                    let bend = max(24, abs(end.x - start.x) / 2)
                    var path = Path(); path.move(to: start)
                    path.addCurve(to: end, control1: CGPoint(x: start.x + bend, y: start.y), control2: CGPoint(x: end.x - bend, y: end.y))
                    let highlighted = edge.source == selectedID || edge.target == selectedID
                    let color: Color = highlighted ? tokens.accent : edge.kind == .merge ? tokens.mauve : edge.kind == .link ? tokens.info : tokens.lineS
                    let dash: [CGFloat] = edge.kind == .merge ? [7, 5] : edge.kind == .link ? [2, 5] : []
                    context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: highlighted ? 2 : 1.2, dash: dash))
                }
            }.accessibilityHidden(true)
            ForEach(layout.nodes) { item in
                Button { selectedID = item.id } label: { card(item) }
                    .buttonStyle(.plain)
                    .scaleEffect(camera.scale)
                    .position(point(item.point))
                    .accessibilityLabel(title(item.node) + ". " + detail(item))
                    .accessibilityHint("Select to inspect this conversation")
                    .accessibilityAddTraits(selectedID == item.id ? .isSelected : [])
                    .contextMenu { Button("Open conversation") { onOpen?(item.id) }.disabled(onOpen == nil) }
            }
        }
        .frame(width: width, height: max(1, height)).contentShape(Rectangle()).clipped()
        .highPriorityGesture(DragGesture(minimumDistance: 8).onChanged { value in
            if dragStart == nil { dragStart = camera }
            guard let start = dragStart else { return }
            camera = WorkspaceGraphCamera(x: start.x + value.translation.width, y: start.y + value.translation.height, scale: camera.scale)
                .clamped(layout: layout, width: width, height: height)
        }.onEnded { _ in dragStart = nil })
        .simultaneousGesture(MagnificationGesture().onChanged { value in
            if pinchStart == nil { pinchStart = camera }
            guard let start = pinchStart else { return }
            camera = start.zoomed(by: value, anchor: .init(x: width / 2, y: height / 2)).clamped(layout: layout, width: width, height: height)
        }.onEnded { _ in pinchStart = nil })
        .accessibilityIdentifier("workspace-native-graph")
    }

    /// Web map node: an ASKED band with the opening question on roots, then
    /// the mono title and uppercase status tags.
    private func card(_ item: WorkspaceGraphItem) -> some View {
        let isSelected = selectedID == item.id
        let asked = item.parentID == nil && !item.isContext ? String((self.asked?(item.node) ?? "").prefix(140)) : ""
        return VStack(alignment: .leading, spacing: 0) {
            if !asked.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Asked").font(MichiFont.mono(size: 10.5, relativeTo: .caption2, weight: .semibold)).tracking(0.84).textCase(.uppercase).foregroundStyle(tokens.accentText)
                    Text(asked).font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.mid).lineLimit(2)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(tokens.alt)
            }
            Text(title(item.node)).font(MichiFont.mono(size: 13.5, relativeTo: .subheadline, weight: .semibold)).foregroundStyle(tokens.fg)
                .lineLimit(asked.isEmpty ? 2 : 1).multilineTextAlignment(.leading)
                .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 4)
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                if item.id == layout.rootID { MichiTag(text: "main", kind: .accent) }
                if item.isContext { MichiTag(text: "context", kind: .tool) }
                if let tag = statusTag(item.node) { MichiTag(text: tag.text, kind: tag.kind) }
            }
            .padding(.horizontal, 10).padding(.bottom, 10)
        }
        .frame(width: WorkspaceGraphLayout.cardWidth, height: WorkspaceGraphLayout.cardHeight, alignment: .topLeading)
        .background(tokens.surface)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(isSelected ? tokens.accent : tokens.line, lineWidth: 1))
    }

    private func statusTag(_ node: JSONValue) -> (text: String, kind: MichiTag.Kind)? {
        if node["kind"].stringValue == "digest" { return ("digest", .ok) }
        switch node["status"].stringValue {
        case "streaming", "running": return ("responding", .warn)
        case "waiting", "needs_input", "permission": return ("approval", .accent)
        case "stalled": return ("stalled", .tool)
        case "error", "failed": return ("failed", .bad)
        default: return nil
        }
    }

    private func detail(_ item: WorkspaceGraphItem) -> String {
        let relation = item.isContext ? "Merged context" : item.id == layout.rootID ? "Thread root" : item.parentID == nil ? "Separate branch" : "Branch level \(item.depth)"
        return relation + (item.node["status"].stringValue.isEmpty ? "" : ", " + item.node["status"].stringValue)
    }
    private func selectionDetail(_ item: WorkspaceGraphItem) -> String {
        if item.isContext { return "merged context" }
        if let parent = item.parentID, let node = layout.nodes.first(where: { $0.id == parent }) { return "branch of " + title(node.node) }
        return item.id == layout.rootID ? "thread root" : "separate branch"
    }
    private func point(_ point: WorkspaceGraphPoint) -> CGPoint { CGPoint(x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y) }
    private func resetGesture() { dragStart = nil; pinchStart = nil }
    private func zoom(_ factor: Double, width: Double, height: Double) {
        camera = camera.zoomed(by: factor, anchor: .init(x: width / 2, y: height / 2)).clamped(layout: layout, width: width, height: height); resetGesture()
    }
    private func focusRoot(width: Double, height: Double) {
        guard let root = layout.nodes.first(where: { $0.id == layout.rootID }) else { return }
        camera = WorkspaceGraphCamera(x: width / 2 - root.point.x, y: 100 - root.point.y, scale: 1)
            .clamped(layout: layout, width: width, height: height); resetGesture()
    }
}
