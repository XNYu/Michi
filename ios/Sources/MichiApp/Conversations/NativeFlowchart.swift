import SwiftUI
import UIKit
import MichiCore

struct NativeFlowchart: View {
    let graph: MarkdownFlowchart
    @Environment(\.michiTokens) private var tokens
    @ScaledMetric(relativeTo: .body) private var textScale: CGFloat = 1
    @State private var availableWidth: CGFloat = 320
    @State private var sizeMode: FlowchartSizeMode = .fit
    private var scale: CGFloat { min(3, max(1, textScale)) }

    var body: some View {
        let layout = MarkdownFlowchartLayout(graph: graph,
            nodeSizes: Dictionary(uniqueKeysWithValues: graph.nodes.map { ($0.id, nodeSize($0)) }),
            labelSizes: graph.edges.map { edge in
                edge.label.isEmpty ? .zero : CGSize(width: 152 * scale, height: textHeight(edge.label, width: 140 * scale, fontSize: 13 * scale) + 12 * scale)
            },
            groupTitleSizes: graph.groups.map { group in
                CGSize(width: 148 * scale, height: textHeight(group.title, width: 140 * scale, fontSize: 13 * scale, weight: .semibold) + 8 * scale)
            }, scale: scale)
        let fitScale = flowchartFitScale(layoutSize: layout.size, width: availableWidth)
        let showsSizeToggle = layout.size.width <= 8_192 && layout.size.height <= 8_192 && fitScale < 0.995
        VStack(alignment: .leading, spacing: 8) {
            Text(graph.groups.isEmpty ? "Flowchart · \(graph.direction.description)" : "Flowchart · \(graph.direction.description) · \(graph.groups.count) \(graph.groups.count == 1 ? "group" : "groups")")
                .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
            if showsSizeToggle {
                Picker("Flowchart size", selection: $sizeMode) {
                    Text("Fit").tag(FlowchartSizeMode.fit)
                    Text("Actual").tag(FlowchartSizeMode.actual)
                }
                .pickerStyle(.segmented)
                .controlSize(.small)
                .frame(maxWidth: 180)
                .accessibilityHint("Fit shows the whole flowchart. Actual size pans at the current text size.")
            }
            if layout.size.width <= 8_192, layout.size.height <= 8_192 {
                framedCanvas(layout: layout, fitScale: fitScale, fitted: sizeMode == .fit || !showsSizeToggle)
                    .accessibilityElement(children: .ignore).accessibilityLabel(graph.accessibilityDescription)
                DisclosureGroup("Diagram description") {
                    Text(verbatim: graph.accessibilityDescription).font(.subheadline).textSelection(.enabled)
                }
                DisclosureGroup("Diagram source") { NativeCodeBlock(language: "text", text: graph.source) }
            } else {
                Text("This flowchart exceeds the native layout limit at this text size.").font(.caption).foregroundStyle(tokens.muted)
                Text(verbatim: graph.accessibilityDescription).font(.subheadline).textSelection(.enabled)
                NativeCodeBlock(language: "text", text: graph.source)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            GeometryReader { proxy in
                Color.clear.onAppear { availableWidth = max(160, proxy.size.width) }
                    .onChange(of: proxy.size.width) { _, value in availableWidth = max(160, value) }
            }
        }
    }

    @ViewBuilder
    private func framedCanvas(layout: MarkdownFlowchartLayout, fitScale: CGFloat, fitted: Bool) -> some View {
        let canvas = diagramCanvas(layout: layout)
            .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
        if fitted {
            canvas
                .scaleEffect(fitScale, anchor: .topLeading)
                .frame(width: max(1, layout.size.width * fitScale), height: max(1, layout.size.height * fitScale), alignment: .topLeading)
                .clipped()
        } else {
            ScrollView([.horizontal, .vertical]) { canvas }
                .frame(height: min(layout.size.height, 520))
        }
    }

    private func diagramCanvas(layout: MarkdownFlowchartLayout) -> some View {
        ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                // Outer frames first so nested groups read as layered containers.
                for frame in layout.groups.sorted(by: { $0.depth < $1.depth }) {
                    let shape = RoundedRectangle(cornerRadius: 10 * scale).path(in: frame.rect)
                    context.fill(shape, with: .color(tokens.alt.opacity(0.45)))
                    context.stroke(shape, with: .color(tokens.lineS), lineWidth: scale)
                }
                for route in layout.routes { draw(route, edge: graph.edges[route.edgeIndex], context: &context) }
            }
            ForEach(Array(layout.groups.enumerated()), id: \.offset) { index, frame in
                Text(verbatim: graph.groups[index].title).font(.system(size: 13 * scale, weight: .semibold))
                    .foregroundStyle(tokens.mid).multilineTextAlignment(.leading)
                    .frame(width: frame.titleRect.width - 8 * scale, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .position(x: frame.titleRect.midX, y: frame.titleRect.midY)
            }
            ForEach(Array(layout.routes.enumerated()), id: \.offset) { _, route in
                let edge = graph.edges[route.edgeIndex]
                if !edge.label.isEmpty {
                    Text(verbatim: edge.label).font(.system(size: 13 * scale))
                        .foregroundStyle(tokens.mid)
                        .multilineTextAlignment(.center).frame(width: 140 * scale)
                        .fixedSize(horizontal: false, vertical: true).padding(6 * scale)
                        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 4 * scale))
                        .position(x: route.labelRect.midX, y: route.labelRect.midY)
                }
            }
            ForEach(Array(graph.nodes.enumerated()), id: \.element.id) { index, node in
                let rect = layout.nodes[index].rect
                ZStack {
                    FlowchartNodeShape(kind: node.shape).fill(tokens.surface)
                    FlowchartNodeShape(kind: node.shape).stroke(tokens.lineS, lineWidth: 1.5 * scale)
                    if node.shape == .doubleCircle { Circle().inset(by: 6 * scale).stroke(tokens.lineS, lineWidth: 1.5 * scale) }
                    if node.shape == .cylinder { FlowchartCylinderLip().stroke(tokens.lineS, lineWidth: 1.5 * scale) }
                    Text(verbatim: node.label).font(.system(size: 14 * scale, weight: .medium))
                        .foregroundStyle(tokens.fg)
                        .multilineTextAlignment(.center).frame(width: labelWidth(node))
                        .fixedSize(horizontal: false, vertical: true)
                }.frame(width: rect.width, height: rect.height).position(x: rect.midX, y: rect.midY)
            }
        }
    }

    private func labelWidth(_ node: MarkdownFlowchart.Node) -> CGFloat {
        switch node.shape {
        case .circle, .doubleCircle: return 112 * scale
        case .decision: return 120 * scale
        default: return 156 * scale
        }
    }
    private func nodeSize(_ node: MarkdownFlowchart.Node) -> CGSize {
        let width = labelWidth(node)
        let height = textHeight(node.label, width: width, fontSize: 14 * scale, weight: .medium)
        switch node.shape {
        case .circle, .doubleCircle:
            let diameter = max(144 * scale, hypot(width + 32 * scale, height + 32 * scale))
            return CGSize(width: diameter, height: diameter)
        case .decision: return CGSize(width: (width + 24 * scale) * 2, height: max(96 * scale, (height + 20 * scale) * 2))
        case .cylinder: return CGSize(width: 180 * scale, height: max(80 * scale, height + 48 * scale))
        case .stadium:
            let totalHeight = max(68 * scale, height + 24 * scale)
            return CGSize(width: width + totalHeight, height: totalHeight)
        default: return CGSize(width: 180 * scale, height: max(68 * scale, height + 24 * scale))
        }
    }
    private func textHeight(_ text: String, width: CGFloat, fontSize: CGFloat, weight: UIFont.Weight = .regular) -> CGFloat {
        let font = UIFont.systemFont(ofSize: fontSize, weight: weight)
        let bounds = (text as NSString).boundingRect(with: CGSize(width: width, height: 2_048), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil)
        return max(ceil(bounds.height), ceil(font.lineHeight))
    }
    private func draw(_ route: MarkdownFlowchartLayout.Route, edge: MarkdownFlowchart.Edge, context: inout GraphicsContext) {
        guard let start = route.points.first, let end = route.points.last, route.points.count >= 2 else { return }
        var path = Path(); path.move(to: start)
        for point in route.points.dropFirst() { path.addLine(to: point) }
        let width: CGFloat = (edge.stroke == .thick ? 3.5 : 1.5) * scale
        context.stroke(path, with: .color(tokens.fg.opacity(0.75)), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: edge.stroke == .dotted ? [2 * scale, 5 * scale] : []))
        if edge.arrow {
            let previous = route.points[route.points.count - 2]
            let dx = end.x - previous.x, dy = end.y - previous.y, length = hypot(dx, dy)
            guard length > 0 else { return }
            let ux = dx / length, uy = dy / length
            var arrow = Path(); arrow.move(to: end)
            arrow.addLine(to: CGPoint(x: end.x - ux * 9 * scale - uy * 4.5 * scale, y: end.y - uy * 9 * scale + ux * 4.5 * scale))
            arrow.addLine(to: CGPoint(x: end.x - ux * 9 * scale + uy * 4.5 * scale, y: end.y - uy * 9 * scale - ux * 4.5 * scale))
            arrow.closeSubpath(); context.fill(arrow, with: .color(tokens.fg.opacity(0.75)))
        }
    }
}

private enum FlowchartSizeMode {
    case fit, actual
}

private func flowchartFitScale(layoutSize: CGSize, width: CGFloat) -> CGFloat {
    let viewportWidth = max(160, width)
    let viewportHeight: CGFloat = 520
    guard layoutSize.width > 0, layoutSize.height > 0, layoutSize.width.isFinite, layoutSize.height.isFinite else { return 1 }
    return min(1, viewportWidth / layoutSize.width, viewportHeight / layoutSize.height)
}

private struct FlowchartNodeShape: Shape {
    let kind: MarkdownFlowchart.Node.Shape
    func path(in rect: CGRect) -> Path {
        switch kind {
        case .circle, .doubleCircle: return Circle().path(in: rect)
        case .rectangle: return RoundedRectangle(cornerRadius: 4).path(in: rect)
        case .stadium: return Capsule().path(in: rect)
        case .rounded: return RoundedRectangle(cornerRadius: min(rect.height / 3, 24)).path(in: rect)
        case .decision:
            var p = Path(); p.move(to: CGPoint(x: rect.midX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)); p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.midY)); p.closeSubpath(); return p
        case .cylinder:
            let cap = min(rect.height / 5, rect.width / 10)
            var p = Path(); p.move(to: CGPoint(x: rect.minX, y: rect.minY + cap))
            p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + cap), control: CGPoint(x: rect.midX, y: rect.minY - cap))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - cap))
            p.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - cap), control: CGPoint(x: rect.midX, y: rect.maxY + cap))
            p.closeSubpath(); return p
        }
    }
}

private struct FlowchartCylinderLip: Shape {
    func path(in rect: CGRect) -> Path {
        let cap = min(rect.height / 5, rect.width / 10)
        var p = Path(); p.move(to: CGPoint(x: rect.minX, y: rect.minY + cap))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + cap), control: CGPoint(x: rect.midX, y: rect.minY + 3 * cap))
        return p
    }
}
