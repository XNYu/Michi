import SwiftUI
import UIKit
import MichiCore

/// Native static HTML. No WebView, no script, no resource loads.
struct NativeHTMLView: View {
    let document: NativeHTMLDocument
    /// Document-global table index of the first table in this tree. Nil ordinal
    /// when this view is presenting inline-paragraph HTML (local cover only).
    var tableOrdinalBase: Int = 0
    var hostedTables: Bool = true
    @State private var availableWidth: CGFloat = 0

    var body: some View {
        NativeHTMLNodeList(
            document: document,
            nodes: document.nodes,
            path: [],
            tableOrdinalBase: tableOrdinalBase,
            hostedTables: hostedTables,
            availableWidth: availableWidth
        )
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .background {
            GeometryReader { geometry in
                Color.clear.onAppear { availableWidth = geometry.size.width }
                    .onChange(of: geometry.size.width) { _, width in availableWidth = width }
            }
        }
    }

    @MainActor
    static func inlineNode(
        _ node: NativeHTMLNode,
        attributes: AttributeContainer = AttributeContainer(),
        fontSize: CGFloat,
        color: UIColor,
        displayScale: CGFloat,
        availableWidth: CGFloat
    ) -> Text {
        switch node {
        case .text(let value):
            return NativeMathInlineLayout.html(value, attributes: attributes, fontSize: fontSize, color: color, displayScale: displayScale, availableWidth: availableWidth)
        case .unsupported(let source):
            var next = attributes
            next.font = .system(.body, design: .monospaced)
            return Text(AttributedString(source, attributes: next))
        case .element(let element):
            if element.name == .br { return Text("\n") }
            var next = attributes
            next.merge(style(element))
            var text = Text("")
            if element.name == .q { text = text + Text("“") }
            for child in element.children {
                text = text + inlineNode(child, attributes: next, fontSize: fontSize, color: color, displayScale: displayScale, availableWidth: availableWidth)
            }
            if element.name == .q { text = text + Text("”") }
            return text
        }
    }

    static func attributed(_ nodes: [NativeHTMLNode], attributes: AttributeContainer = AttributeContainer()) -> AttributedString {
        var result = AttributedString()
        for node in nodes {
            switch node {
            case .text(let value):
                result += AttributedString(value, attributes: attributes)
            case .unsupported(let source):
                var next = attributes
                next.font = .system(.body, design: .monospaced)
                result += AttributedString(source, attributes: next)
            case .element(let element):
                if element.name == .br { result += AttributedString("\n"); continue }
                if element.name == .q { result += AttributedString("“") }
                var next = attributes
                next.merge(style(element))
                result += attributed(element.children, attributes: next)
                if element.name == .q { result += AttributedString("”") }
            }
        }
        return result
    }

    fileprivate static func style(_ element: NativeHTMLElement) -> AttributeContainer {
        var attributes = AttributeContainer()
        switch element.name {
        case .strong, .b: attributes.inlinePresentationIntent = .stronglyEmphasized
        case .em, .i: attributes.inlinePresentationIntent = .emphasized
        case .s, .strike, .del: attributes.inlinePresentationIntent = .strikethrough
        case .ins, .a:
            attributes.underlineStyle = .single
            if element.name == .a, let href = element.href, let url = NativeHTMLSyntax.linkURL(href) {
                attributes.link = url
            }
        case .code, .samp, .tt, .variable: attributes.font = .system(.body, design: .monospaced)
        case .kbd:
            attributes.font = .system(.body, design: .monospaced)
            attributes.backgroundColor = Color.secondary.opacity(0.16)
        case .mark: attributes.backgroundColor = Color.yellow.opacity(0.35)
        case .sup:
            attributes.baselineOffset = 6
            attributes.font = .system(.footnote)
        case .sub:
            attributes.baselineOffset = -4
            attributes.font = .system(.footnote)
        default: break
        }
        return attributes
    }

    fileprivate enum Chunk { case inline([NativeHTMLNode]), block(offset: Int, node: NativeHTMLNode) }

    fileprivate static func chunks(_ nodes: [NativeHTMLNode]) -> [Chunk] {
        var result: [Chunk] = [], inline: [NativeHTMLNode] = []
        func flush() {
            if !inline.isEmpty { result.append(.inline(inline)); inline = [] }
        }
        for (offset, node) in nodes.enumerated() {
            if node.isBlock { flush(); result.append(.block(offset: offset, node: node)) }
            else { inline.append(node) }
        }
        flush()
        return result
    }
}

/// Named list view so recursive `some View` methods are not the type identity.
private struct NativeHTMLNodeList: View {
    let document: NativeHTMLDocument
    let nodes: [NativeHTMLNode]
    let path: [Int]
    let tableOrdinalBase: Int
    let hostedTables: Bool
    let availableWidth: CGFloat
    @Environment(\.michiTokens) private var tokens
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        let chunks = NativeHTMLView.chunks(nodes)
        if chunks.count == 1, case .inline(let inline) = chunks[0] {
            inlineChunk(inline)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(chunks.enumerated()), id: \.offset) { _, chunk in
                    switch chunk {
                    case .inline(let inline): inlineChunk(inline)
                    case .block(let offset, let node):
                        AnyView(NativeHTMLNodeBox(
                            document: document,
                            node: node,
                            path: path + [offset],
                            tableOrdinalBase: tableOrdinalBase,
                            hostedTables: hostedTables,
                            availableWidth: availableWidth
                        ))
                    }
                }
            }
        }
    }

    private func inlineChunk(_ nodes: [NativeHTMLNode]) -> some View {
        inlineText(nodes)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func inlineText(_ nodes: [NativeHTMLNode], attributes: AttributeContainer = AttributeContainer()) -> Text {
        var result = Text("")
        for node in nodes { result = result + nodeText(node, attributes: attributes) }
        return result
    }

    private func nodeText(_ node: NativeHTMLNode, attributes: AttributeContainer) -> Text {
        switch node {
        case .text(let value):
            return NativeMathInlineLayout.html(
                value,
                attributes: attributes,
                fontSize: min(96, CGFloat(preferences.messageSize) * scale),
                color: nativeFormulaColor(colorScheme),
                displayScale: displayScale,
                availableWidth: availableWidth
            )
        case .unsupported(let source):
            var next = attributes
            next.font = .system(.body, design: .monospaced)
            return Text(AttributedString(source, attributes: next))
        case .element(let element):
            if element.name == .br { return Text("\n") }
            if element.name.isBlock { return inlineText(element.children, attributes: attributes) }
            var next = attributes
            next.merge(NativeHTMLView.style(element))
            var text = Text("")
            if element.name == .q { text = text + Text("“") }
            text = text + inlineText(element.children, attributes: next)
            if element.name == .q { text = text + Text("”") }
            return text
        }
    }
}

/// Single-node box. `AnyView` + this named type terminate the list↔node cycle.
private struct NativeHTMLNodeBox: View {
    let document: NativeHTMLDocument
    let node: NativeHTMLNode
    let path: [Int]
    let tableOrdinalBase: Int
    let hostedTables: Bool
    let availableWidth: CGFloat
    @Environment(\.michiTokens) private var tokens
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        switch node {
        case .text(let value): NativeMathInlineText(text: value)
        case .unsupported(let source): unsupported(source)
        case .element(let element): elementView(element)
        }
    }

    @ViewBuilder private func elementView(_ element: NativeHTMLElement) -> some View {
        switch element.name {
        case .details:
            NativeHTMLDetails(open: element.open) {
                if let offset = element.children.firstIndex(where: { $0.name == .summary }),
                   case .element(let summary) = element.children[offset] {
                    subtree(summary.children, path: path + [offset])
                } else {
                    inlineChunk([.text("Details")])
                }
            } content: {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(element.children.enumerated()), id: \.offset) { offset, child in
                        if child.name != .summary { boxed(child, path: path + [offset]) }
                    }
                }
            }
        case .ul, .ol:
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(element.children.enumerated()), id: \.offset) { offset, node in
                    if case .element(let item) = node, item.name == .li {
                        let number = element.children.prefix(offset + 1).filter { $0.name == .li }.count
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(verbatim: element.name == .ol ? "\(number)." : "•").monospacedDigit().foregroundStyle(tokens.faint)
                            subtree(item.children, path: path + [offset])
                        }.padding(.leading, 4)
                    }
                }
            }
        case .table:
            if let table = NativeHTMLDocument(nodes: [.element(element)], source: document.source).tables().first {
                NativeMarkdownTableView(
                    headers: table.headers,
                    alignments: table.alignments,
                    rows: table.rows,
                    headerCells: table.headerCells,
                    rowCells: table.rowCells,
                    ordinal: hostedTables ? NativeMarkdownTableOrder.index(ofTableAt: path, in: document.nodes).map { tableOrdinalBase + $0 } : nil
                )
            } else { unsupported(NativeHTMLSyntax.serialized(.element(element))) }
        case .hr: Rectangle().fill(tokens.line).frame(height: 1).padding(.vertical, 4)
        case .pre:
            NativeCodeBlock(language: "", text: element.children.flatMap(\.visibleTexts).joined())
        case .blockquote:
            subtree(element.children, path: path)
                .italic()
                .foregroundStyle(tokens.mid)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(tokens.alt, in: UnevenRoundedRectangle(cornerRadii: .init(bottomTrailing: 4, topTrailing: 4), style: .continuous))
                .overlay(alignment: .leading) { Rectangle().fill(tokens.accent).frame(width: 2) }
        case .h1, .h2, .h3, .h4, .h5, .h6:
            inlineChunk(element.children).font(headingFont(element.name)).accessibilityAddTraits(.isHeader)
        case .p, .div, .span, .li, .dd, .dt, .dl, .thead, .tbody, .tfoot, .tr, .th, .td, .summary:
            subtree(element.children, path: path)
        default:
            inlineChunk([.element(element)])
        }
    }

    private func subtree(_ nodes: [NativeHTMLNode], path: [Int]) -> AnyView {
        AnyView(NativeHTMLNodeList(
            document: document,
            nodes: nodes,
            path: path,
            tableOrdinalBase: tableOrdinalBase,
            hostedTables: hostedTables,
            availableWidth: availableWidth
        ))
    }

    private func boxed(_ node: NativeHTMLNode, path: [Int]) -> AnyView {
        AnyView(NativeHTMLNodeBox(
            document: document,
            node: node,
            path: path,
            tableOrdinalBase: tableOrdinalBase,
            hostedTables: hostedTables,
            availableWidth: availableWidth
        ))
    }

    private func inlineChunk(_ nodes: [NativeHTMLNode]) -> some View {
        inlineText(nodes)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func inlineText(_ nodes: [NativeHTMLNode], attributes: AttributeContainer = AttributeContainer()) -> Text {
        var result = Text("")
        for node in nodes { result = result + nodeText(node, attributes: attributes) }
        return result
    }

    private func nodeText(_ node: NativeHTMLNode, attributes: AttributeContainer) -> Text {
        switch node {
        case .text(let value):
            return NativeMathInlineLayout.html(
                value,
                attributes: attributes,
                fontSize: min(96, CGFloat(preferences.messageSize) * scale),
                color: nativeFormulaColor(colorScheme),
                displayScale: displayScale,
                availableWidth: availableWidth
            )
        case .unsupported(let source):
            var next = attributes
            next.font = .system(.body, design: .monospaced)
            return Text(AttributedString(source, attributes: next))
        case .element(let element):
            if element.name == .br { return Text("\n") }
            if element.name.isBlock { return inlineText(element.children, attributes: attributes) }
            var next = attributes
            next.merge(NativeHTMLView.style(element))
            var text = Text("")
            if element.name == .q { text = text + Text("“") }
            text = text + inlineText(element.children, attributes: next)
            if element.name == .q { text = text + Text("”") }
            return text
        }
    }

    private func unsupported(_ source: String) -> some View {
        Group {
            if source.utf8.count > 64_000 {
                DisclosureGroup("Unsupported HTML · show full source") {
                    Text(verbatim: source).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                }
            } else {
                DisclosureGroup("Unsupported HTML · show source") {
                    Text(verbatim: source).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func headingFont(_ name: NativeHTMLName) -> Font {
        switch name {
        case .h1: return MichiFont.sans(size: 22, relativeTo: .title2, weight: .semibold)
        case .h2: return MichiFont.sans(size: 19, relativeTo: .title3, weight: .semibold)
        case .h3: return MichiFont.sans(size: 17, relativeTo: .headline, weight: .semibold)
        default: return MichiFont.sans(size: 15.5, relativeTo: .subheadline, weight: .semibold)
        }
    }
}

private struct NativeHTMLDetails<Summary: View, Content: View>: View {
    @State private var expanded: Bool
    let summary: Summary
    let content: Content
    init(open: Bool, @ViewBuilder summary: () -> Summary, @ViewBuilder content: () -> Content) {
        _expanded = State(initialValue: open)
        self.summary = summary()
        self.content = content()
    }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) { content } label: { summary }
    }
}


private extension NativeHTMLNode {
    var name: NativeHTMLName? { if case .element(let element) = self { return element.name }; return nil }
    var isBlock: Bool {
        switch self {
        case .element(let element): return element.name.isBlock
        case .unsupported: return true
        case .text: return false
        }
    }
    var visibleTexts: [String] {
        switch self {
        case .text(let value): return [value]
        case .element(let element): return element.children.flatMap(\.visibleTexts)
        case .unsupported: return []
        }
    }
}
