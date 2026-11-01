import Charts
import SwiftUI
import UIKit
import MichiCore

struct NativeClassDiagram: View {
    let diagram: MarkdownClassDiagram
    @Environment(\.michiTokens) private var tokens
    @ScaledMetric(relativeTo: .body) private var textScale: CGFloat = 1
    private var scale: CGFloat { min(3, max(1, textScale)) }

    var body: some View {
        let sizes = Dictionary(uniqueKeysWithValues: diagram.classes.map { ($0.id, boxSize($0)) })
        let annotations = diagram.relations.map {
            MarkdownEntityAnnotation.Extent(
                left: EntityDrawing.chipSize($0.leftCardinality, scale: scale),
                right: EntityDrawing.chipSize($0.rightCardinality, scale: scale),
                label: EntityDrawing.chipSize($0.label, scale: scale)
            )
        }
        let layout = MarkdownClassDiagramLayout(diagram: diagram, boxSizes: sizes, annotations: annotations, scale: scale)
        VStack(alignment: .leading, spacing: 8) {
            Text("Class diagram · \(diagram.classes.count) \(diagram.classes.count == 1 ? "class" : "classes")")
                .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
            if layout.size.width <= 8_192, layout.size.height <= 8_192 {
                ScrollView([.horizontal, .vertical]) {
                    ZStack(alignment: .topLeading) {
                        Canvas { context, _ in
                            for (index, relation) in diagram.relations.enumerated() {
                                draw(relation, edge: layout.edges[index], context: &context)
                            }
                        }
                        ForEach(diagram.classes) { item in
                            if let box = layout.boxes.first(where: { $0.id == item.id }) {
                                classCard(item, rect: box.rect).position(x: box.rect.midX, y: box.rect.midY)
                            }
                        }
                        ForEach(Array(diagram.relations.enumerated()), id: \.offset) { index, relation in
                            relationLabels(relation, edge: layout.edges[index])
                        }
                    }.frame(width: layout.size.width, height: layout.size.height)
                }.frame(height: min(layout.size.height, 520))
                    .accessibilityElement(children: .ignore).accessibilityLabel(diagram.accessibilityDescription)
                DisclosureGroup("Diagram source") { NativeCodeBlock(language: "text", text: diagram.source) }
            } else {
                Text("This diagram exceeds the native layout limit at the current text size.").font(.caption).foregroundStyle(tokens.muted)
                NativeCodeBlock(language: "text", text: diagram.source)
            }
        }
    }

    private func classCard(_ item: MarkdownClassDiagram.Class, rect: CGRect) -> some View {
        VStack(alignment: .leading, spacing: 2 * scale) {
            Text(verbatim: item.id).font(.system(size: 14 * scale, weight: .semibold))
                .frame(maxWidth: .infinity)
            if !item.members.isEmpty { Rectangle().fill(tokens.line).frame(height: 1) }
            ForEach(Array(item.members.enumerated()), id: \.offset) { _, member in
                Text(verbatim: memberLine(member))
                    .font(.system(size: 13 * scale, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10 * scale).frame(width: rect.width, height: rect.height, alignment: .top)
        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 8 * scale))
        .overlay { RoundedRectangle(cornerRadius: 8 * scale).stroke(tokens.lineS, lineWidth: 1.2 * scale) }
        .foregroundStyle(tokens.fg)
    }

    private func memberLine(_ member: MarkdownClassDiagram.Member) -> String {
        (member.visibility?.rawValue ?? "") + member.text + (member.classifier?.rawValue ?? "")
    }

    private func boxSize(_ item: MarkdownClassDiagram.Class) -> CGSize {
        let width: CGFloat = 188 * scale
        let title = EntityDrawing.height(item.id, width: width - 20 * scale, fontSize: 14 * scale, weight: .semibold)
        let members = item.members.reduce(CGFloat.zero) { $0 + EntityDrawing.height(memberLine($1), width: width - 20 * scale, fontSize: 13 * scale) }
        return CGSize(width: width, height: title + members + (item.members.isEmpty ? 20 : 28) * scale)
    }

    @ViewBuilder private func relationLabels(_ relation: MarkdownClassDiagram.Relation, edge: MarkdownClassDiagramLayout.EdgeGeometry) -> some View {
        if !relation.leftCardinality.isEmpty {
            annotationChip(relation.leftCardinality, at: edge.leftCardinality)
        }
        if !relation.rightCardinality.isEmpty {
            annotationChip(relation.rightCardinality, at: edge.rightCardinality)
        }
        if !relation.label.isEmpty {
            annotationChip(relation.label, at: edge.label)
        }
    }

    private func annotationChip(_ text: String, at point: CGPoint) -> some View {
        Text(verbatim: text)
            .font(.system(size: 12 * scale))
            .foregroundStyle(tokens.mid)
            .padding(2 * scale)
            .background(tokens.surface, in: RoundedRectangle(cornerRadius: 3 * scale))
            .fixedSize()
            .position(point)
    }

    private func draw(_ relation: MarkdownClassDiagram.Relation, edge: MarkdownClassDiagramLayout.EdgeGeometry, context: inout GraphicsContext) {
        guard edge.points.count >= 2 else { return }
        var path = Path(); path.move(to: edge.points[0])
        for point in edge.points.dropFirst() { path.addLine(to: point) }
        let dashed = relation.token.contains("..")
        context.stroke(path, with: .color(tokens.fg.opacity(0.75)), style: StrokeStyle(lineWidth: 1.4 * scale, dash: dashed ? [5 * scale, 4 * scale] : []))
        let start = edge.points[0], end = edge.points.last!, beforeEnd = edge.points[edge.points.count - 2], afterStart = edge.points[1]
        EntityDrawing.mark(context: &context, token: relation.token, start: start, afterStart: afterStart, beforeEnd: beforeEnd, end: end, color: tokens.fg, scale: scale)
    }
}

struct NativeERDiagram: View {
    let diagram: MarkdownERDiagram
    @Environment(\.michiTokens) private var tokens
    @ScaledMetric(relativeTo: .body) private var textScale: CGFloat = 1
    private var scale: CGFloat { min(3, max(1, textScale)) }

    var body: some View {
        let sizes = Dictionary(uniqueKeysWithValues: diagram.entities.map { ($0.id, boxSize($0)) })
        let annotations = diagram.relations.map {
            MarkdownEntityAnnotation.Extent(label: EntityDrawing.chipSize($0.label, scale: scale))
        }
        let layout = MarkdownERDiagramLayout(diagram: diagram, boxSizes: sizes, annotations: annotations, scale: scale)
        VStack(alignment: .leading, spacing: 8) {
            Text("ER diagram · \(diagram.entities.count) \(diagram.entities.count == 1 ? "entity" : "entities")")
                .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
            if layout.size.width <= 8_192, layout.size.height <= 8_192 {
                ScrollView([.horizontal, .vertical]) {
                    ZStack(alignment: .topLeading) {
                        Canvas { context, _ in
                            for (index, relation) in diagram.relations.enumerated() {
                                draw(relation, edge: layout.edges[index], context: &context)
                            }
                        }
                        ForEach(diagram.entities) { entity in
                            if let box = layout.boxes.first(where: { $0.id == entity.id }) {
                                entityCard(entity, rect: box.rect).position(x: box.rect.midX, y: box.rect.midY)
                            }
                        }
                        ForEach(Array(diagram.relations.enumerated()), id: \.offset) { index, relation in
                            if !relation.label.isEmpty {
                                Text(verbatim: relation.label)
                                    .font(.system(size: 12 * scale))
                                    .foregroundStyle(tokens.mid)
                                    .padding(2 * scale)
                                    .background(tokens.surface, in: RoundedRectangle(cornerRadius: 3 * scale))
                                    .fixedSize()
                                    .position(layout.edges[index].label)
                            }
                        }
                    }.frame(width: layout.size.width, height: layout.size.height)
                }.frame(height: min(layout.size.height, 520))
                    .accessibilityElement(children: .ignore).accessibilityLabel(diagram.accessibilityDescription)
                DisclosureGroup("Diagram source") { NativeCodeBlock(language: "text", text: diagram.source) }
            } else {
                Text("This diagram exceeds the native layout limit at the current text size.").font(.caption).foregroundStyle(tokens.muted)
                NativeCodeBlock(language: "text", text: diagram.source)
            }
        }
    }

    private func entityCard(_ entity: MarkdownERDiagram.Entity, rect: CGRect) -> some View {
        VStack(alignment: .leading, spacing: 2 * scale) {
            Text(verbatim: entity.id).font(.system(size: 14 * scale, weight: .semibold))
                .frame(maxWidth: .infinity)
            if !entity.attributes.isEmpty { Rectangle().fill(tokens.line).frame(height: 1) }
            ForEach(Array(entity.attributes.enumerated()), id: \.offset) { _, attribute in
                Text(verbatim: attributeLine(attribute))
                    .font(.system(size: 13 * scale, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10 * scale).frame(width: rect.width, height: rect.height, alignment: .top)
        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 8 * scale))
        .overlay { RoundedRectangle(cornerRadius: 8 * scale).stroke(tokens.lineS, lineWidth: 1.2 * scale) }
        .foregroundStyle(tokens.fg)
    }

    private func attributeLine(_ attribute: MarkdownERDiagram.Attribute) -> String {
        let keys = attribute.keys.isEmpty ? "" : " " + attribute.keys.map {
            switch $0 { case .primary: return "PK"; case .foreign: return "FK"; case .unique: return "UK" }
        }.joined(separator: ",")
        let comment = attribute.comment.isEmpty ? "" : " \"\(attribute.comment)\""
        return attribute.type + " " + attribute.name + keys + comment
    }

    private func boxSize(_ entity: MarkdownERDiagram.Entity) -> CGSize {
        let width: CGFloat = 208 * scale
        let title = EntityDrawing.height(entity.id, width: width - 20 * scale, fontSize: 14 * scale, weight: .semibold)
        let rows = entity.attributes.reduce(CGFloat.zero) { $0 + EntityDrawing.height(attributeLine($1), width: width - 20 * scale, fontSize: 13 * scale) }
        return CGSize(width: width, height: title + rows + (entity.attributes.isEmpty ? 20 : 28) * scale)
    }

    private func draw(_ relation: MarkdownERDiagram.Relation, edge: MarkdownERDiagramLayout.EdgeGeometry, context: inout GraphicsContext) {
        guard edge.points.count >= 2 else { return }
        var path = Path(); path.move(to: edge.points[0])
        for point in edge.points.dropFirst() { path.addLine(to: point) }
        context.stroke(path, with: .color(tokens.fg.opacity(0.75)),
                       style: StrokeStyle(lineWidth: 1.4 * scale, dash: relation.identifying ? [] : [5 * scale, 4 * scale]))
        EntityDrawing.crow(context: &context, at: edge.points[0], toward: edge.points[1], cardinality: relation.leftCardinality, color: tokens.fg, scale: scale)
        EntityDrawing.crow(context: &context, at: edge.points.last!, toward: edge.points[edge.points.count - 2], cardinality: relation.rightCardinality, color: tokens.fg, scale: scale)
    }
}

struct NativePieChart: View {
    let diagram: MarkdownPieChart
    @Environment(\.michiTokens) private var tokens
    @ScaledMetric(relativeTo: .body) private var textScale: CGFloat = 1
    private var scale: CGFloat { min(3, max(1, textScale)) }
    private var palette: [Color] { [tokens.accent, tokens.digest, tokens.mauve, tokens.select, tokens.info, tokens.danger] }

    var body: some View {
        let layout = MarkdownPieChartLayout(diagram: diagram, diameter: 200 * Double(scale))
        let plots: [NativePieSlicePlot] = zip(diagram.slices, layout.slices).map {
            NativePieSlicePlot(id: $0.label, label: $0.label, share: max(0, $1.percent), value: $0.value)
        }
        let nativePie = layout.diameter <= 8_192 && layout.total.isFinite && plots.count == diagram.slices.count
        VStack(alignment: .leading, spacing: 8) {
            Text(diagram.title.isEmpty ? "Pie chart" : "Pie chart · \(diagram.title)")
                .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
            if nativePie {
                Chart(plots) { plot in
                    SectorMark(angle: .value("Share", plot.share), innerRadius: .ratio(0))
                        .foregroundStyle(by: .value("Slice", plot.label))
                        .accessibilityLabel(plot.label)
                        .accessibilityValue(diagram.showData ? EntityDrawing.number(plot.value) : "")
                }
                .chartForegroundStyleScale(domain: plots.map(\.label), range: plots.indices.map { palette[$0 % palette.count] })
                .chartLegend(position: .bottom)
                .frame(height: 240 * scale)
                .accessibilityElement(children: .ignore).accessibilityLabel(diagram.accessibilityDescription)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(diagram.slices.enumerated()), id: \.element.id) { index, slice in
                        HStack {
                            Circle().fill(palette[index % palette.count]).frame(width: 8, height: 8)
                            Text(verbatim: slice.label).font(MichiFont.sans(size: 14, relativeTo: .body))
                            Spacer()
                            if diagram.showData {
                                Text("\(EntityDrawing.number(slice.value)) · \(EntityDrawing.percent(slice.value, total: diagram.total))%")
                                    .font(MichiFont.mono(size: 13, relativeTo: .footnote)).foregroundStyle(tokens.mid)
                            }
                        }
                    }
                }
                DisclosureGroup("Diagram source") { NativeCodeBlock(language: "text", text: diagram.source) }
            } else {
                Text("This diagram exceeds the native layout limit at the current text size.").font(.caption).foregroundStyle(tokens.muted)
                NativeCodeBlock(language: "text", text: diagram.source)
            }
        }
    }
}

private struct NativePieSlicePlot: Identifiable {
    let id: String
    let label: String
    let share: Double
    let value: Double
}

private enum EntityDrawing {
    static func chipSize(_ text: String, scale: CGFloat) -> CGSize {
        guard !text.isEmpty else { return .zero }
        let font = UIFont.systemFont(ofSize: 12 * scale)
        let bounds = (text as NSString).size(withAttributes: [.font: font])
        return CGSize(width: ceil(bounds.width) + 4 * scale, height: max(20 * scale, ceil(bounds.height) + 4 * scale))
    }
    static func height(_ text: String, width: CGFloat, fontSize: CGFloat, weight: UIFont.Weight = .regular) -> CGFloat {
        let bounds = (text as NSString).boundingRect(with: CGSize(width: max(1, width), height: .greatestFiniteMagnitude),
                                                   options: [.usesLineFragmentOrigin, .usesFontLeading],
                                                   attributes: [.font: UIFont.systemFont(ofSize: fontSize, weight: weight)], context: nil)
        return max(fontSize * 1.25, ceil(bounds.height))
    }
    static func number(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        if value == value.rounded() { return String(format: "%.0f", value) }
        return String(format: "%g", value)
    }
    static func percent(_ value: Double, total: Double) -> String {
        let percent = value / total * 100
        if abs(percent - percent.rounded()) < 1e-9 { return String(Int(percent.rounded())) }
        return String(format: "%.1f", percent)
    }
    static func mark(context: inout GraphicsContext, token: String, start: CGPoint, afterStart: CGPoint, beforeEnd: CGPoint, end: CGPoint, color: Color, scale: CGFloat) {
        let leftTokens = ["<|--", "<|..", "*--", "o--", "<--", "<.."]
        let atStart = leftTokens.contains(token)
        let tip = atStart ? start : end, tail = atStart ? afterStart : beforeEnd
        if ["<|--", "--|>", "<|..", "..|>"].contains(token) { triangle(context: &context, from: tail, to: tip, fill: false, color: color, scale: scale) }
        else if ["*--", "--*"].contains(token) { diamond(context: &context, from: tail, to: tip, fill: true, color: color, scale: scale) }
        else if ["o--", "--o"].contains(token) { diamond(context: &context, from: tail, to: tip, fill: false, color: color, scale: scale) }
        else if ["-->", "<--", "..>", "<.."].contains(token) { triangle(context: &context, from: tail, to: tip, fill: true, color: color, scale: scale) }
    }
    static func triangle(context: inout GraphicsContext, from: CGPoint, to: CGPoint, fill: Bool, color: Color, scale: CGFloat) {
        let angle = atan2(to.y - from.y, to.x - from.x), length = 10 * scale
        let a = CGPoint(x: to.x - length * cos(angle - .pi / 6), y: to.y - length * sin(angle - .pi / 6))
        let b = CGPoint(x: to.x - length * cos(angle + .pi / 6), y: to.y - length * sin(angle + .pi / 6))
        var path = Path(); path.move(to: a); path.addLine(to: to); path.addLine(to: b); path.closeSubpath()
        if fill { context.fill(path, with: .color(color.opacity(0.9))) }
        else { context.stroke(path, with: .color(color.opacity(0.9)), lineWidth: 1.4 * scale) }
    }
    static func diamond(context: inout GraphicsContext, from: CGPoint, to: CGPoint, fill: Bool, color: Color, scale: CGFloat) {
        let angle = atan2(to.y - from.y, to.x - from.x), length = 8 * scale
        let tip = to
        let back = CGPoint(x: tip.x - length * 1.6 * cos(angle), y: tip.y - length * 1.6 * sin(angle))
        let left = CGPoint(x: tip.x - length * cos(angle - .pi / 3), y: tip.y - length * sin(angle - .pi / 3))
        let right = CGPoint(x: tip.x - length * cos(angle + .pi / 3), y: tip.y - length * sin(angle + .pi / 3))
        var path = Path(); path.move(to: tip); path.addLine(to: left); path.addLine(to: back); path.addLine(to: right); path.closeSubpath()
        if fill { context.fill(path, with: .color(color.opacity(0.9))) }
        else { context.stroke(path, with: .color(color.opacity(0.9)), lineWidth: 1.4 * scale) }
    }
    static func crow(context: inout GraphicsContext, at tip: CGPoint, toward: CGPoint, cardinality: MarkdownERDiagram.Cardinality, color: Color, scale: CGFloat) {
        let angle = atan2(tip.y - toward.y, tip.x - toward.x)
        let back = CGPoint(x: tip.x - 12 * scale * cos(angle), y: tip.y - 12 * scale * sin(angle))
        func tick(_ center: CGPoint) {
            let nx = -sin(angle) * 5 * scale, ny = cos(angle) * 5 * scale
            var path = Path(); path.move(to: CGPoint(x: center.x - nx, y: center.y - ny)); path.addLine(to: CGPoint(x: center.x + nx, y: center.y + ny))
            context.stroke(path, with: .color(color), lineWidth: 1.4 * scale)
        }
        func foot() {
            for delta in [-0.45, 0.0, 0.45] {
                var path = Path(); path.move(to: tip)
                path.addLine(to: CGPoint(x: tip.x - 10 * scale * cos(angle + delta), y: tip.y - 10 * scale * sin(angle + delta)))
                context.stroke(path, with: .color(color), lineWidth: 1.4 * scale)
            }
        }
        switch cardinality {
        case .exactlyOne: tick(tip); tick(back)
        case .zeroOrOne:
            tick(back)
            context.stroke(Path(ellipseIn: CGRect(x: tip.x - 4 * scale, y: tip.y - 4 * scale, width: 8 * scale, height: 8 * scale)), with: .color(color), lineWidth: 1.4 * scale)
        case .zeroOrMore:
            foot()
            context.stroke(Path(ellipseIn: CGRect(x: back.x - 4 * scale, y: back.y - 4 * scale, width: 8 * scale, height: 8 * scale)), with: .color(color), lineWidth: 1.4 * scale)
        case .oneOrMore: foot(); tick(back)
        }
    }
}
