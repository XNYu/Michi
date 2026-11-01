import SwiftUI
import UIKit
import MichiCore

struct NativeSequenceDiagram: View {
    let diagram: MarkdownSequenceDiagram
    @Environment(\.michiTokens) private var tokens
    @ScaledMetric(relativeTo: .body) private var textScale: CGFloat = 1
    @State private var availableWidth: CGFloat = 320
    private var scale: CGFloat { min(3, max(1, textScale)) }

    var body: some View {
        let layout = SequenceDiagramLayout(diagram: diagram, scale: scale, availableWidth: availableWidth)
        VStack(alignment: .leading, spacing: 8) {
            Label("Sequence diagram", systemImage: "arrow.left.arrow.right")
                .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
            if layout.width <= 8_192, layout.height <= 8_192 {
                ScrollView([.horizontal, .vertical]) {
                    ZStack(alignment: .topLeading) {
                        Canvas { context, _ in
                            for frame in diagram.fragments {
                                let rect = layout.frameRect(frame)
                                context.fill(Path(rect), with: .color(tokens.alt.opacity(0.35)))
                                context.stroke(Path(rect), with: .color(tokens.lineS), lineWidth: scale)
                                for branch in frame.branches.dropFirst() {
                                    let y = layout.rowTop(branch.headerRow)
                                    var separator = Path(); separator.move(to: CGPoint(x: rect.minX, y: y))
                                    separator.addLine(to: CGPoint(x: rect.maxX, y: y))
                                    context.stroke(separator, with: .color(tokens.lineS), style: StrokeStyle(lineWidth: scale, dash: [5 * scale, 3 * scale]))
                                }
                            }
                            for participant in diagram.participants {
                                var path = Path(); path.move(to: CGPoint(x: layout.x(participant.id), y: layout.header - 4 * scale))
                                path.addLine(to: CGPoint(x: layout.x(participant.id), y: layout.height - 8 * scale))
                                context.stroke(path, with: .color(tokens.lineS), style: StrokeStyle(lineWidth: scale, dash: [5 * scale, 5 * scale]))
                            }
                            for activation in diagram.activations {
                                let start = layout.arrowY(activation.start), end = layout.arrowY(activation.end)
                                let rect = CGRect(x: layout.x(activation.participant) - 5 * scale + CGFloat(activation.depth) * 4 * scale,
                                                  y: start, width: 10 * scale, height: max(8 * scale, end - start))
                                context.fill(Path(rect), with: .color(tokens.accent.opacity(0.3)))
                                context.stroke(Path(rect), with: .color(tokens.accent), lineWidth: scale)
                            }
                            for (index, event) in diagram.events.enumerated() {
                                guard case .message(let from, let to, let arrow, _, _) = event else { continue }
                                var a = CGPoint(x: layout.x(from), y: layout.arrowY(index)), b = CGPoint(x: layout.x(to), y: layout.arrowY(index))
                                var path = Path()
                                let direction: CGPoint
                                if from == to {
                                    a.y -= 8 * scale; b.y += 8 * scale
                                    path.move(to: a); path.addLine(to: CGPoint(x: a.x + 64 * scale, y: a.y))
                                    path.addLine(to: CGPoint(x: a.x + 64 * scale, y: b.y)); path.addLine(to: b)
                                    direction = CGPoint(x: b.x + 64 * scale, y: b.y)
                                } else { path.move(to: a); path.addLine(to: b); direction = a }
                                MermaidDrawing.arrow(context: &context, path: path, from: direction, to: b, ending: arrow.ending, dashed: arrow.dashed, color: tokens.fg, scale: scale)
                            }
                        }
                        ForEach(diagram.participants) { participant in
                            VStack(spacing: 4 * scale) {
                                if participant.actor { Image(systemName: "figure.stand").font(.system(size: 26 * scale)) }
                                Text(verbatim: participant.label).font(.system(size: 14 * scale, weight: .semibold))
                                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                            }.padding(8 * scale).frame(width: layout.cardWidth)
                                .foregroundStyle(tokens.fg)
                                .background(tokens.surface, in: RoundedRectangle(cornerRadius: 8 * scale))
                                .overlay { RoundedRectangle(cornerRadius: 8 * scale).stroke(tokens.lineS, lineWidth: 1.2 * scale) }
                                .position(x: layout.x(participant.id), y: layout.header / 2)
                        }
                        ForEach(Array(diagram.events.enumerated()), id: \.offset) { index, event in
                            eventLabel(event, index: index, layout: layout)
                        }
                        ForEach(diagram.fragments) { frame in
                            ForEach(Array(frame.branches.enumerated()), id: \.offset) { index, branch in
                                Text(verbatim: layout.branchTitle(frame, index: index))
                                    .font(.system(size: 13 * scale, weight: .semibold))
                                    .foregroundStyle(tokens.mid)
                                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                                    .frame(width: layout.frameRect(frame).width - 16 * scale, alignment: .leading)
                                    .padding(.vertical, 4 * scale).background(tokens.surface)
                                    .position(x: layout.frameRect(frame).midX,
                                              y: layout.rowTop(branch.headerRow) + layout.rowHeights[branch.headerRow] / 2)
                            }
                        }
                    }.frame(width: layout.width, height: layout.height)
                }.frame(height: min(layout.height, 520))
                    .accessibilityElement(children: .ignore).accessibilityLabel(diagram.accessibilityDescription)
                NativeDiagramSource(source: diagram.source)
            } else {
                Text("This diagram exceeds the native layout limit at the current text size.").font(.caption).foregroundStyle(tokens.muted)
                NativeDiagramSource(source: diagram.source, expanded: true)
            }
        }.modifier(DiagramViewportWidth(width: $availableWidth))
    }

    @ViewBuilder private func eventLabel(_ event: MarkdownSequenceDiagram.Event, index: Int, layout: SequenceDiagramLayout) -> some View {
        switch event {
        case .message(_, _, _, let text, let number):
            Text(verbatim: (number.map { "\($0). " } ?? "") + text)
                .font(.system(size: 14 * scale)).foregroundStyle(tokens.fg).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true).frame(width: layout.labelWidth(event))
                .padding(.horizontal, 2 * scale).background(tokens.surface)
                .position(x: layout.labelX(event), y: layout.top(index) + (layout.eventHeight(index) - 24 * scale) / 2)
        case .note(_, _, let text):
            Text(verbatim: text).font(.system(size: 14 * scale)).foregroundStyle(tokens.fg).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true).padding(8 * scale)
                .frame(width: layout.labelWidth(event))
                .background(tokens.surface, in: RoundedRectangle(cornerRadius: 6 * scale))
                .overlay { RoundedRectangle(cornerRadius: 6 * scale).stroke(tokens.lineS, lineWidth: 1.2 * scale) }
                .position(x: layout.labelX(event), y: layout.top(index) + layout.eventHeight(index) / 2)
        case .activation(_, let active):
            Text(active ? "Activation begins" : "Activation ends").font(.system(size: 13 * scale)).foregroundStyle(tokens.muted)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                .frame(width: layout.labelWidth(event)).padding(2 * scale).background(tokens.surface)
                .position(x: layout.labelX(event), y: layout.top(index) + layout.eventHeight(index) / 2)
        }
    }
}

/// Adapts spacing to the container, keeping text at 14 pt or the requested larger Dynamic Type size.
/// Side notes/self messages reserve additional space only when they actually need it.
private struct SequenceDiagramLayout {
    let diagram: MarkdownSequenceDiagram
    let scale: CGFloat
    let availableWidth: CGFloat
    private(set) var rowHeights: [CGFloat] = []
    private var offsets: [CGFloat]?
    private var eventRows: [Int] = []

    init(diagram: MarkdownSequenceDiagram, scale: CGFloat, availableWidth: CGFloat) {
        self.diagram = diagram; self.scale = scale; self.availableWidth = availableWidth
        eventRows = diagram.rows.indices.filter { if case .event = diagram.rows[$0] { return true }; return false }
        rowHeights = makeRowHeights()
        offsets = diagram.rowOffsets(heights: rowHeights.map { Double($0) })?.map { CGFloat($0) }
    }
    var cardWidth: CGFloat { 88 * scale }
    private var framePadding: CGFloat { CGFloat((diagram.fragments.map(\.depth).max() ?? -1) + 1) * 8 * scale }
    private var left: CGFloat {
        framePadding + (diagram.events.contains { if case .note(.left, let ids, _) = $0 { return ids.first == diagram.participants.first?.id }; return false } ? 148 * scale : 52 * scale)
    }
    private var right: CGFloat {
        framePadding + (diagram.events.contains {
            if case .note(.right, let ids, _) = $0 { return ids.first == diagram.participants.last?.id }
            if case .message(let from, let to, _, _, _) = $0 { return from == to && to == diagram.participants.last?.id }
            return false
        } ? 148 * scale : 52 * scale)
    }
    private var step: CGFloat { max(108 * scale, min(160 * scale, (availableWidth - left - right) / CGFloat(max(1, diagram.participants.count - 1)))) }
    private var contentWidth: CGFloat { left + right + CGFloat(max(0, diagram.participants.count - 1)) * step }
    var width: CGFloat { max(availableWidth, contentWidth) }
    func x(_ id: String) -> CGFloat { (width - contentWidth) / 2 + left + CGFloat(diagram.participants.firstIndex(where: { $0.id == id }) ?? 0) * step }
    var header: CGFloat {
        (diagram.participants.map {
            MermaidDrawing.textHeight($0.label, width: cardWidth - 16 * scale, fontSize: 14 * scale, weight: .semibold) + ($0.actor ? 30 : 0) * scale
        }.max() ?? 20 * scale) + 28 * scale
    }
    func eventHeight(_ index: Int) -> CGFloat { rowHeights[eventRows[index]] }
    private func measureEventHeight(_ index: Int) -> CGFloat {
        let event = diagram.events[index]
        let inset: CGFloat = { if case .note = event { return 16 * scale }; return 0 }()
        let text: String
        switch event {
        case .message(_, _, _, let label, let number): text = (number.map { "\($0). " } ?? "") + label
        case .note(_, _, let label): text = label
        case .activation(_, let active): text = active ? "Activation begins" : "Activation ends"
        }
        return MermaidDrawing.textHeight(text, width: labelWidth(event) - inset, fontSize: 14 * scale) + 36 * scale
    }
    private func makeRowHeights() -> [CGFloat] {
        diagram.rows.map { row in
            switch row {
            case .event(let index): return measureEventHeight(index)
            case .fragmentStart(let id): return branchHeight(diagram.fragments[id], index: 0)
            case .fragmentElse(let id, let branch): return branchHeight(diagram.fragments[id], index: branch)
            case .fragmentEnd: return 16 * scale
            }
        }
    }
    var height: CGFloat { offsets.map { header + $0.last! + 16 * scale } ?? .infinity }
    func rowTop(_ index: Int) -> CGFloat { header + (offsets?[index] ?? 0) }
    func top(_ index: Int) -> CGFloat { rowTop(eventRows[index]) }
    func arrowY(_ index: Int) -> CGFloat { top(index) + eventHeight(index) - 12 * scale }
    private func frameInset(_ frame: MarkdownSequenceDiagram.Fragment) -> CGFloat { CGFloat(frame.depth + 1) * 8 * scale }
    func frameRect(_ frame: MarkdownSequenceDiagram.Fragment) -> CGRect {
        let inset = frameInset(frame), y = rowTop(frame.startRow)
        return CGRect(x: inset, y: y, width: width - inset * 2, height: rowTop(frame.endRow) + 8 * scale - y)
    }
    func branchTitle(_ frame: MarkdownSequenceDiagram.Fragment, index: Int) -> String {
        let kind = index == 0 ? frame.kind.rawValue : frame.kind.separator ?? "else", label = frame.branches[index].label
        return kind + (label.isEmpty ? "" : " · " + label)
    }
    private func branchHeight(_ frame: MarkdownSequenceDiagram.Fragment, index: Int) -> CGFloat {
        MermaidDrawing.textHeight(branchTitle(frame, index: index), width: width - frameInset(frame) * 2 - 16 * scale,
                                  fontSize: 13 * scale, weight: .semibold) + 16 * scale
    }
    func labelWidth(_ event: MarkdownSequenceDiagram.Event) -> CGFloat {
        switch event {
        case .message(let from, let to, _, _, _): return from == to ? 120 * scale : max(88 * scale, abs(x(from) - x(to)) - 12 * scale)
        case .note(let placement, let ids, _): return placement == .over ? max(88 * scale, abs(x(ids.last!) - x(ids[0])) + cardWidth) : 128 * scale
        case .activation: return 96 * scale
        }
    }
    func labelX(_ event: MarkdownSequenceDiagram.Event) -> CGFloat {
        switch event {
        case .message(let from, let to, _, _, _): return from == to ? x(from) + 72 * scale : (x(from) + x(to)) / 2
        case .note(let placement, let ids, _):
            return placement == .left ? x(ids[0]) - 76 * scale : placement == .right ? x(ids[0]) + 76 * scale : (x(ids[0]) + x(ids.last!)) / 2
        case .activation(let id, _): return x(id)
        }
    }
}

struct NativeStateDiagram: View {
    let diagram: MarkdownStateDiagram
    @Environment(\.michiTokens) private var tokens
    @ScaledMetric(relativeTo: .body) private var textScale: CGFloat = 1
    @State private var availableWidth: CGFloat = 320
    private var scale: CGFloat { min(3, max(1, textScale)) }

    var body: some View {
        let layout = StateDiagramLayout(diagram: diagram, scale: scale, availableWidth: availableWidth)
        VStack(alignment: .leading, spacing: 8) {
            Label("State diagram", systemImage: "circle.grid.2x2")
                .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
            if layout.width <= 8_192, layout.height <= 8_192 {
                ScrollView([.horizontal, .vertical]) {
                    ZStack(alignment: .topLeading) {
                        Canvas { context, _ in
                            // Pre-order puts each composite before the composites it contains.
                            for index in layout.composites {
                                let frame = RoundedRectangle(cornerRadius: 14 * scale).path(in: layout.frameRect(index))
                                context.fill(frame, with: .color(tokens.alt.opacity(0.4)))
                                context.stroke(frame, with: .color(tokens.lineS), lineWidth: 1.2 * scale)
                            }
                            for (index, _) in diagram.transitions.enumerated() {
                                let points = layout.points(index)
                                guard points.count >= 2 else { continue }
                                var path = Path(); path.move(to: points[0])
                                for point in points.dropFirst() { path.addLine(to: point) }
                                MermaidDrawing.arrow(context: &context, path: path, from: points[points.count - 2], to: points.last!, ending: "arrow", dashed: false, color: tokens.fg, scale: scale)
                            }
                        }
                        ForEach(Array(diagram.states.enumerated()), id: \.element.id) { index, state in
                            if state.kind == .composite {
                                let title = layout.titleRect(index)
                                Text(verbatim: state.label).font(.system(size: 13 * scale, weight: .semibold))
                                    .foregroundStyle(tokens.mid)
                                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                                    .frame(width: title.width, alignment: .leading)
                                    .position(x: title.midX, y: title.midY)
                            } else {
                                let rect = layout.entryRect(index)
                                stateView(state, rect: rect).position(x: rect.midX, y: rect.midY)
                            }
                        }
                        ForEach(Array(diagram.transitions.enumerated()), id: \.offset) { index, edge in
                            if !edge.label.isEmpty {
                                Text(verbatim: edge.label).font(.system(size: 13 * scale)).foregroundStyle(tokens.mid)
                                    .multilineTextAlignment(.center)
                                    .fixedSize(horizontal: false, vertical: true).frame(width: layout.labelWidth)
                                    .padding(2 * scale).background(tokens.surface, in: RoundedRectangle(cornerRadius: 4 * scale))
                                    .position(layout.labelPosition(index))
                            }
                        }
                    }.frame(width: layout.width, height: layout.height)
                }.frame(height: min(layout.height, 520))
                    .accessibilityElement(children: .ignore).accessibilityLabel(diagram.accessibilityDescription)
                NativeDiagramSource(source: diagram.source)
            } else {
                Text("This diagram exceeds the native layout limit at the current text size.").font(.caption).foregroundStyle(tokens.muted)
                NativeDiagramSource(source: diagram.source, expanded: true)
            }
        }.modifier(DiagramViewportWidth(width: $availableWidth))
    }

    @ViewBuilder private func stateView(_ state: MarkdownStateDiagram.State, rect: CGRect) -> some View {
        if state.kind == .state {
            Text(verbatim: state.label).font(.system(size: 14 * scale, weight: .medium))
                .foregroundStyle(tokens.fg)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                .padding(10 * scale).frame(width: rect.width, height: rect.height)
                .background(tokens.surface, in: RoundedRectangle(cornerRadius: 12 * scale))
                .overlay { RoundedRectangle(cornerRadius: 12 * scale).stroke(tokens.lineS, lineWidth: 1.5 * scale) }
        } else if state.kind == .final {
            Circle().fill(tokens.fg).frame(width: 18 * scale, height: 18 * scale)
                .padding(6 * scale).background(tokens.surface, in: Circle())
                .overlay { Circle().stroke(tokens.fg, lineWidth: 1.5 * scale) }
        } else { Circle().fill(tokens.fg).frame(width: 18 * scale, height: 18 * scale) }
    }
}

/// Adjacent forward transitions use the main axis; only returns, skips, and duplicate edges
/// need separate side channels. This keeps ordinary phone-sized state graphs fully visible.
/// A composite is a framed run of the source order: a title header, then its contents,
/// closed by one padding step per frame ending there. "Adjacent" means the entry right
/// after the whole run, so a line or side stem only crosses the frames it enters or leaves.
private struct StateDiagramLayout {
    let diagram: MarkdownStateDiagram
    let scale: CGFloat
    let availableWidth: CGFloat
    /// Composite indices in pre-order (outer frames before inner ones).
    let composites: [Int]
    private let indexByID: [String: Int]
    private let sizes: [CGSize]
    private let spans: [Int]
    private let origins: [CGFloat]
    private let closing: [CGFloat]
    /// Half of a composite frame's extent across the axis; zero for other entries.
    private let frameHalf: [CGFloat]
    private let titleHeights: [CGFloat]
    private let direct: [Bool]
    private let axis: CGFloat
    private let mainLength: CGFloat
    var labelWidth: CGFloat { 104 * scale }
    private var pad: CGFloat { 14 * scale }

    init(diagram: MarkdownStateDiagram, scale: CGFloat, availableWidth: CGFloat) {
        self.diagram = diagram; self.scale = scale; self.availableWidth = availableWidth
        let states = diagram.states, transitions = diagram.transitions, horizontal = diagram.horizontal
        let nodeWidth = 132 * scale, labelWidth = 104 * scale, pad = 14 * scale
        let spans = states.indices.map { diagram.subtreeEnd($0) }
        let levels = (states.filter { $0.kind == .composite }.map(\.depth).max() ?? -1) + 1
        var sizes = Array(repeating: CGSize.zero, count: states.count)
        var frameHalf = Array(repeating: CGFloat.zero, count: states.count), titleHeights = frameHalf
        // Reverse pre-order measures contents before the composite that frames them.
        for i in states.indices.reversed() {
            let state = states[i]
            switch state.kind {
            case .initial: sizes[i] = CGSize(width: 18 * scale, height: 18 * scale)
            case .final: sizes[i] = CGSize(width: 30 * scale, height: 30 * scale)
            case .state:
                sizes[i] = CGSize(width: nodeWidth, height: max(44 * scale, MermaidDrawing.textHeight(state.label, width: nodeWidth - 20 * scale, fontSize: 14 * scale, weight: .medium) + 20 * scale))
            case .composite where horizontal:
                // Title column at the frame's leading edge, contents centred on the axis.
                let title = MermaidDrawing.textHeight(state.label, width: labelWidth, fontSize: 13 * scale, weight: .semibold)
                let inner = ((i + 1)..<(spans[i] + 1)).filter { states[$0].depth == state.depth + 1 }
                    .map { states[$0].kind == .composite ? frameHalf[$0] : sizes[$0].height / 2 }.max() ?? 0
                frameHalf[i] = max(inner + pad, title / 2 + 8 * scale); titleHeights[i] = title
                sizes[i] = CGSize(width: labelWidth + 16 * scale, height: frameHalf[i] * 2)
            case .composite:
                // Every frame at one depth shares a width; each level adds one pad per side.
                let width = nodeWidth + 2 * pad * CGFloat(levels - state.depth)
                let title = MermaidDrawing.textHeight(state.label, width: width - 24 * scale, fontSize: 13 * scale, weight: .semibold)
                frameHalf[i] = width / 2; titleHeights[i] = title
                sizes[i] = CGSize(width: width, height: title + 16 * scale)
            }
        }
        let index = Dictionary(uniqueKeysWithValues: states.enumerated().map { ($0.element.id, $0.offset) })
        let direct = transitions.indices.map { t -> Bool in
            guard let from = index[transitions[t].from], let to = index[transitions[t].to] else { return false }
            return to == spans[from] + 1 && !transitions.prefix(t).contains { prior in
                index[prior.from].map { spans[$0] == spans[from] } == true && prior.to == transitions[t].to
            }
        }
        var closing = Array(repeating: CGFloat.zero, count: states.count)
        for i in states.indices where states[i].kind == .composite { closing[spans[i]] += pad }
        func main(_ size: CGSize) -> CGFloat { horizontal ? size.width : size.height }
        var origins: [CGFloat] = [], cursor = 12 * scale
        for i in states.indices {
            let labels = transitions.indices.filter { t in
                direct[t] && index[transitions[t].from].map { spans[$0] } == i && !transitions[t].label.isEmpty
            }.map { MermaidDrawing.textHeight(transitions[$0].label, width: labelWidth, fontSize: 13 * scale) }
            let gap = horizontal ? (labels.isEmpty ? 32 * scale : labelWidth + 16 * scale) : max(32 * scale, (labels.max() ?? 0) + 20 * scale)
            origins.append(cursor); cursor += main(sizes[i]) + closing[i] + gap
        }
        self.composites = states.indices.filter { states[$0].kind == .composite }
        self.indexByID = index; self.sizes = sizes; self.spans = spans; self.origins = origins; self.closing = closing
        self.frameHalf = frameHalf; self.titleHeights = titleHeights; self.direct = direct
        let halves = states.indices.map { states[$0].kind == .composite ? frameHalf[$0] : (horizontal ? sizes[$0].height : sizes[$0].width) / 2 }
        axis = (horizontal ? (halves.max() ?? 22 * scale) : max(nodeWidth / 2, halves.max() ?? 0)) + 8 * scale
        mainLength = states.isEmpty ? 24 * scale : origins[states.count - 1] + main(sizes[states.count - 1]) + closing[states.count - 1] + 12 * scale
    }

    private var routed: [Int] { diagram.transitions.indices.filter { !direct[$0] } }
    private func labelHeight(_ index: Int) -> CGFloat { MermaidDrawing.textHeight(diagram.transitions[index].label, width: labelWidth, fontSize: 13 * scale) }
    private func main(_ size: CGSize) -> CGFloat { diagram.horizontal ? size.width : size.height }
    private var directExtent: CGFloat {
        if !diagram.horizontal { return max(axis + 12 * scale + labelWidth, axis + (frameHalf.max() ?? 0)) + 8 * scale }
        let labelExtent = diagram.transitions.indices.filter { direct[$0] && !diagram.transitions[$0].label.isEmpty }.map { labelHeight($0) }.max() ?? 0
        return max(axis * 2, axis + 12 * scale + labelExtent) + 8 * scale
    }
    private func channel(_ index: Int) -> CGFloat {
        let rank = routed.firstIndex(of: index) ?? 0
        if !diagram.horizontal { return directExtent + 12 * scale + labelWidth / 2 + CGFloat(rank) * (labelWidth + 16 * scale) }
        return directExtent + 16 * scale + routed.prefix(rank).reduce(CGFloat.zero) { $0 + max(40 * scale, labelHeight($1) + 16 * scale) } + labelHeight(index) / 2
    }
    private var crossLength: CGFloat {
        guard let last = routed.last else { return directExtent }
        return channel(last) + (diagram.horizontal ? labelHeight(last) / 2 : labelWidth / 2) + 12 * scale
    }
    var width: CGFloat { max(availableWidth, diagram.horizontal ? mainLength : crossLength) }
    var height: CGFloat { diagram.horizontal ? crossLength : mainLength }
    private var horizontalOffset: CGFloat { (width - (diagram.horizontal ? mainLength : crossLength)) / 2 }
    /// The state, pseudo-state or composite header at `index`.
    func entryRect(_ index: Int) -> CGRect {
        let size = sizes[index]
        return CGRect(x: horizontalOffset + (diagram.horizontal ? origins[index] : axis - size.width / 2),
                      y: diagram.horizontal ? axis - size.height / 2 : origins[index], width: size.width, height: size.height)
    }
    /// Composite border: header through its last content plus its own closing step.
    func frameRect(_ index: Int) -> CGRect {
        let end = spans[index], depth = diagram.states[index].depth
        let inner = composites.filter { spans[$0] == end && diagram.states[$0].depth > depth }.count
        let length = origins[end] + main(sizes[end]) + pad * CGFloat(inner + 1) - origins[index]
        return diagram.horizontal
            ? CGRect(x: horizontalOffset + origins[index], y: axis - frameHalf[index], width: length, height: frameHalf[index] * 2)
            : CGRect(x: horizontalOffset + axis - frameHalf[index], y: origins[index], width: frameHalf[index] * 2, height: length)
    }
    func titleRect(_ index: Int) -> CGRect {
        let header = entryRect(index)
        return diagram.horizontal
            ? CGRect(x: header.minX + 8 * scale, y: header.minY + 8 * scale, width: labelWidth, height: titleHeights[index])
            : CGRect(x: header.minX + 12 * scale, y: header.minY + 8 * scale, width: header.width - 24 * scale, height: titleHeights[index])
    }
    /// Transitions attach to a composite's frame, not its header.
    private func endpointRect(_ index: Int) -> CGRect { diagram.states[index].kind == .composite ? frameRect(index) : entryRect(index) }
    private func sidePort(_ index: Int, source: Bool) -> CGPoint {
        let r = entryRect(index), state = diagram.states[index], offset = (source ? -1.0 : 1.0) * min(8 * scale, r.height / 4)
        if state.kind == .composite {
            let frame = frameRect(index)
            return diagram.horizontal ? CGPoint(x: r.midX + offset, y: frame.maxY) : CGPoint(x: frame.maxX, y: r.midY + offset)
        }
        let radius = r.width / 2
        let circlePort = sqrt(max(0, radius * radius - offset * offset))
        return diagram.horizontal ? CGPoint(x: r.midX + offset, y: r.midY + (state.kind == .state ? r.height / 2 : circlePort)) : CGPoint(x: r.midX + (state.kind == .state ? r.width / 2 : circlePort), y: r.midY + offset)
    }
    private func ends(_ transition: Int) -> (from: Int, to: Int)? {
        let edge = diagram.transitions[transition]
        guard let from = indexByID[edge.from], let to = indexByID[edge.to] else { return nil }
        return (from, to)
    }
    func points(_ index: Int) -> [CGPoint] {
        guard let pair = ends(index) else { return [] }
        let from = pair.from, to = pair.to, a = endpointRect(from), b = endpointRect(to)
        if direct[index] {
            return diagram.horizontal ? [CGPoint(x: a.maxX, y: a.midY), CGPoint(x: b.minX, y: b.midY)] : [CGPoint(x: a.midX, y: a.maxY), CGPoint(x: b.midX, y: b.minY)]
        }
        let start = sidePort(from, source: true), end = sidePort(to, source: false), lane = channel(index)
        return diagram.horizontal ? [start, CGPoint(x: start.x, y: lane), CGPoint(x: end.x, y: lane), end] : [start, CGPoint(x: horizontalOffset + lane, y: start.y), CGPoint(x: horizontalOffset + lane, y: end.y), end]
    }
    func labelPosition(_ index: Int) -> CGPoint {
        guard let pair = ends(index) else { return .zero }
        let from = pair.from, a = endpointRect(from), b = endpointRect(pair.to)
        if direct[index] {
            // Centre in the part of the gap after every frame that closes there.
            let last = spans[from], closed = origins[last] + main(sizes[last]) + closing[last]
            return diagram.horizontal ? CGPoint(x: (horizontalOffset + closed + b.minX) / 2, y: axis + 12 * scale + labelHeight(index) / 2)
                : CGPoint(x: a.midX + 12 * scale + labelWidth / 2, y: (closed + b.minY) / 2)
        }
        return diagram.horizontal ? CGPoint(x: (a.midX + b.midX) / 2, y: channel(index)) : CGPoint(x: horizontalOffset + channel(index), y: (a.midY + b.midY) / 2)
    }
}

private struct DiagramViewportWidth: ViewModifier {
    @Binding var width: CGFloat
    func body(content: Content) -> some View {
        content.frame(maxWidth: .infinity, alignment: .leading).background {
            GeometryReader { proxy in
                Color.clear.onAppear { width = max(160, proxy.size.width) }
                    .onChange(of: proxy.size.width) { _, value in width = max(160, value) }
            }
        }
    }
}

private struct NativeDiagramSource: View {
    let source: String
    @State private var expanded: Bool
    init(source: String, expanded: Bool = false) { self.source = source; _expanded = State(initialValue: expanded) }
    var body: some View {
        DisclosureGroup("Diagram source", isExpanded: $expanded) {
            HStack {
                ShareLink(item: source) { Label("Share source", systemImage: "square.and.arrow.up") }
                Spacer()
                #if canImport(UIKit)
                Button { UIPasteboard.general.string = source } label: { Label("Copy source", systemImage: "doc.on.doc") }
                #endif
            }.font(.caption)
            Text(verbatim: source).font(.system(.body, design: .monospaced))
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private enum MermaidDrawing {
    static func textHeight(_ text: String, width: CGFloat, fontSize: CGFloat, weight: UIFont.Weight = .regular) -> CGFloat {
        let bounds = (text as NSString).boundingRect(with: CGSize(width: max(1, width), height: .greatestFiniteMagnitude),
                                                   options: [.usesLineFragmentOrigin, .usesFontLeading],
                                                   attributes: [.font: UIFont.systemFont(ofSize: fontSize, weight: weight)], context: nil)
        return max(fontSize * 1.25, ceil(bounds.height))
    }
    static func arrow(context: inout GraphicsContext, path: Path, from: CGPoint, to: CGPoint, ending: String, dashed: Bool, color: Color, scale: CGFloat) {
        context.stroke(path, with: .color(color.opacity(0.75)), style: StrokeStyle(lineWidth: 1.5 * scale, dash: dashed ? [5 * scale, 4 * scale] : []))
        guard ending != "line" else { return }
        var head = Path()
        if ending == "cross" {
            head.move(to: CGPoint(x: to.x - 5 * scale, y: to.y - 5 * scale)); head.addLine(to: CGPoint(x: to.x + 5 * scale, y: to.y + 5 * scale))
            head.move(to: CGPoint(x: to.x - 5 * scale, y: to.y + 5 * scale)); head.addLine(to: CGPoint(x: to.x + 5 * scale, y: to.y - 5 * scale))
        } else {
            let angle = atan2(to.y - from.y, to.x - from.x), length = 9 * scale
            let a = CGPoint(x: to.x - length * cos(angle - .pi / 6), y: to.y - length * sin(angle - .pi / 6))
            let b = CGPoint(x: to.x - length * cos(angle + .pi / 6), y: to.y - length * sin(angle + .pi / 6))
            head.move(to: a); head.addLine(to: to); head.addLine(to: b)
            if ending == "arrow" { head.closeSubpath(); context.fill(head, with: .color(color.opacity(0.85))); return }
        }
        context.stroke(head, with: .color(color.opacity(0.85)), lineWidth: 1.5 * scale)
    }
}

/// Direct adapter for a page's raw `mermaid.code`; it never interprets an
/// embedded Markdown fence as a way out of the source block.
struct NativeMermaidBlock: View {
    let source: String
    var body: some View {
        switch MarkdownDocument.mermaidBlock(source) {
        case .flowchart(let graph): NativeFlowchart(graph: graph)
        case .sequenceDiagram(let diagram): NativeSequenceDiagram(diagram: diagram)
        case .stateDiagram(let diagram): NativeStateDiagram(diagram: diagram)
        case .classDiagram(let diagram): NativeClassDiagram(diagram: diagram)
        case .erDiagram(let diagram): NativeERDiagram(diagram: diagram)
        case .pieChart(let diagram): NativePieChart(diagram: diagram)
        default: NativeCodeBlock(language: "mermaid", text: source)
        }
    }
}
