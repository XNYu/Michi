import SwiftUI
import UIKit
import MichiCore

struct NativeMarkdown: View {
    let text: String
    /// Optional TOC anchors for headings, in render order. Root merges only
    /// this top-level plumbing; do not attach it to flowchart rendering.
    var headingAnchorIDs: [String] = []
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.michiReferenceAPI) private var referenceAPI
    @Environment(\.openMichiReference) private var openMichiReference
    var body: some View {
        NativeMarkdownBlocks(blocks: MarkdownDocument(text).blocks, headingAnchorIDs: headingAnchorIDs)
            .modifier(MichiProseSize(size: preferences.messageSize, serif: preferences.messageFont == "Source Serif 4"))
            .environment(\.openURL, OpenURLAction { url in
                nativeMichiOpenURL(url, allowInternal: referenceAPI != nil, open: openMichiReference)
            })
    }
}

/// Geist reading prose (16/25 at the default size). The saved message size and
/// Dynamic Type compose; the Source Serif preference keeps a serif face.
struct MichiProseSize: ViewModifier {
    let size: Double
    var serif = false
    @ScaledMetric(relativeTo: .body) private var baseline = 16.0
    func body(content: Content) -> some View {
        content
            .font(serif ? .system(size: baseline * size / 16, design: .serif) : MichiFont.sans(size: CGFloat(size), relativeTo: .body))
            .lineSpacing(CGFloat(size) * 0.3)
    }
}

private struct NativeMarkdownBlocks: View {
    let blocks: [MarkdownBlock]
    var headingAnchorIDs: [String] = []
    var tableOrdinalBase: Int = 0
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { offset, block in content(block, offset: offset) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tableOrdinal(at offset: Int) -> Int {
        tableOrdinalBase + NativeMarkdownTableOrder.count(before: offset, in: blocks)
    }

    @ViewBuilder private func content(_ block: MarkdownBlock, offset: Int) -> some View {
        switch block {
        case .paragraph(let text): NativeInlineText(text: text)
        case .html(let document): NativeHTMLView(document: document, tableOrdinalBase: tableOrdinal(at: offset), hostedTables: true)
        case .heading(let level, let text):
            NativeInlineText(text: text).font(headingFont(level)).tracking(level <= 2 ? -0.19 : 0).foregroundStyle(tokens.fg)
                .lineSpacing(2).padding(.top, 4).accessibilityAddTraits(.isHeader)
                .modifier(PageNavigationHeadingAnchor(id: headingAnchorID(before: offset)))
        case .rule: Rectangle().fill(tokens.line).frame(height: 1).padding(.vertical, 4)
        case .listItem(let marker, let text, let depth, let checked):
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if let checked {
                    Image(systemName: checked ? "checkmark.square" : "square")
                        .foregroundStyle(checked ? tokens.digest : tokens.faint)
                        .accessibilityLabel(checked ? "Completed" : "Not completed")
                } else { Text(verbatim: marker == "-" || marker == "*" || marker == "+" ? "•" : marker).monospacedDigit().foregroundStyle(tokens.faint) }
                NativeInlineText(text: text)
            }.padding(.leading, 4 + CGFloat(depth) * 16).accessibilityElement(children: .combine)
        case .quote(let blocks):
            // Type erasure terminates the recursive block view's static type.
            AnyView(NativeMarkdownBlocks(blocks: blocks, headingAnchorIDs: [], tableOrdinalBase: tableOrdinal(at: offset)))
                .italic()
                .foregroundStyle(tokens.mid)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(tokens.alt, in: UnevenRoundedRectangle(cornerRadii: .init(bottomTrailing: 4, topTrailing: 4), style: .continuous))
                .overlay(alignment: .leading) { Rectangle().fill(tokens.accent).frame(width: 2) }
                .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text): NativeCodeBlock(language: language, text: text)
        case .literal(let text):
            if text.utf8.count > 64_000 {
                DisclosureGroup("Large text · show full content") {
                    Text(verbatim: text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else { Text(verbatim: text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        case .table(let headers, let alignments, let rows):
            NativeMarkdownTableView(headers: headers, alignments: alignments, rows: rows, ordinal: tableOrdinal(at: offset))
        case .flowchart(let graph): NativeFlowchart(graph: graph)
        case .sequenceDiagram(let diagram): NativeSequenceDiagram(diagram: diagram)
        case .stateDiagram(let diagram): NativeStateDiagram(diagram: diagram)
        case .classDiagram(let diagram): NativeClassDiagram(diagram: diagram)
        case .erDiagram(let diagram): NativeERDiagram(diagram: diagram)
        case .pieChart(let diagram): NativePieChart(diagram: diagram)
        case .math(let expression): NativeMathView(tex: expression.tex, display: true, source: expression.source)
        }
    }
    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return MichiFont.sans(size: 22, relativeTo: .title2, weight: .semibold)
        case 2: return MichiFont.sans(size: 19, relativeTo: .title3, weight: .semibold)
        case 3: return MichiFont.sans(size: 17, relativeTo: .headline, weight: .semibold)
        default: return MichiFont.sans(size: 15.5, relativeTo: .subheadline, weight: .semibold)
        }
    }

    private func headingAnchorID(before offset: Int) -> String? {
        let ordinal = blocks.prefix(offset + 1).reduce(0) { count, block in
            if case .heading = block { return count + 1 }
            return count
        } - 1
        guard headingAnchorIDs.indices.contains(ordinal) else { return nil }
        return headingAnchorIDs[ordinal]
    }
}

private struct NativeInlineText: View {
    let text: String
    var alignment: Alignment = .leading
    var body: some View {
        Group {
            if NativeHTMLSyntax.containsMarkup(text) {
                let fragments = NativeHTMLSyntax.inlineFragments(text)
                if NativeHTMLSyntax.reconstructed(fragments) != text || NativeHTMLSyntax.markdownCrossesHTML(fragments) {
                    Text(verbatim: text)
                } else if fragments.allSatisfy({ if case .text = $0 { return true }; return false }) {
                    NativeMathInlineText(text: text, alignment: alignment)
                } else {
                    NativeInlineFragments(fragments: fragments, alignment: alignment)
                }
            } else {
                NativeMathInlineText(text: text, alignment: alignment)
            }
        }.lineLimit(nil).fixedSize(horizontal: false, vertical: true)
    }
}

private struct NativeInlineFragments: View {
    let fragments: [NativeInlineFragment]
    var alignment: Alignment = .leading
    var body: some View {
        let groups = NativeInlineFragments.groups(fragments)
        if groups.count == 1, case .inline(let inline) = groups[0] {
            NativeInlineFlow(fragments: inline, alignment: alignment)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                    switch group {
                    case .inline(let inline): NativeInlineFlow(fragments: inline, alignment: alignment)
                    case .table(let node, let source):
                        if let table = NativeHTMLDocument(nodes: [node], source: source).tables().first {
                            NativeMarkdownTableView(
                                headers: table.headers,
                                alignments: table.alignments,
                                rows: table.rows,
                                headerCells: table.headerCells,
                                rowCells: table.rowCells
                            )
                        } else {
                            Text(verbatim: source)
                        }
                    }
                }
            }
        }
    }

    private enum Group { case inline([NativeInlineFragment]), table(NativeHTMLNode, String) }

    private static func groups(_ fragments: [NativeInlineFragment]) -> [Group] {
        var result: [Group] = [], inline: [NativeInlineFragment] = []
        func flush() {
            if !inline.isEmpty { result.append(.inline(inline)); inline = [] }
        }
        for fragment in fragments {
            if case .html(let node, let source) = fragment, case .element(let element) = node, element.name == .table {
                flush()
                result.append(.table(node, source))
            } else {
                inline.append(fragment)
            }
        }
        flush()
        return result
    }
}

private struct NativeInlineFlow: View {
    let fragments: [NativeInlineFragment]
    var alignment: Alignment = .leading
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    @State private var availableWidth: CGFloat = 0
    var body: some View {
        content
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: alignment)
            .background {
                GeometryReader { geometry in
                    Color.clear.onAppear { availableWidth = geometry.size.width }
                        .onChange(of: geometry.size.width) { _, width in availableWidth = width }
                }
            }
    }

    private var content: Text {
        var result = Text("")
        let fontSize = min(96, CGFloat(preferences.messageSize) * scale)
        let color = nativeFormulaColor(colorScheme)
        for fragment in fragments {
            switch fragment {
            case .text(let value):
                result = result + NativeMathInlineLayout.markdown(
                    NativeMathSyntax.attributedRuns(value),
                    fontSize: fontSize,
                    color: color,
                    displayScale: displayScale,
                    availableWidth: availableWidth
                )
            case .html(let node, _):
                result = result + NativeHTMLView.inlineNode(
                    node,
                    fontSize: fontSize,
                    color: color,
                    displayScale: displayScale,
                    availableWidth: availableWidth
                )
            }
        }
        return result
    }
}


struct NativeCodeBlock: View {
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.michiTokens) private var tokens
    let language: String
    let text: String
    @State private var copied = false
    private var isDiff: Bool { ["diff", "patch"].contains(language.lowercased()) }
    private var lines: [String] { text.components(separatedBy: "\n") }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Text(language.isEmpty ? "Code" : language)
                    .font(MichiFont.tag).tracking(0.88).textCase(.uppercase).foregroundStyle(tokens.muted)
                Spacer()
                ShareLink(item: text) { Image(systemName: "square.and.arrow.up").font(.system(size: 13)).frame(width: 44, height: 30) }
                    .foregroundStyle(tokens.muted).accessibilityLabel("Share code")
                #if canImport(UIKit)
                Button { UIPasteboard.general.string = text; copied = true } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 13)).frame(width: 44, height: 30)
                }
                .buttonStyle(.plain).foregroundStyle(copied ? tokens.digest : tokens.muted).accessibilityLabel(copied ? "Copied" : "Copy code")
                #endif
            }
            .padding(.leading, 10).padding(.trailing, 2)
            .frame(minHeight: 30)
            .contentShape(Rectangle())
            if preferences.codeStyle == "header" { Rectangle().fill(tokens.line).frame(height: 1) }
            if language.lowercased() == "mermaid" {
                Text("Diagram syntax is not supported by the native renderer. Source is shown below.")
                    .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted).padding(10)
            }
            if preferences.codeWrap { codeContent.frame(maxWidth: .infinity, alignment: .leading) }
            else { ScrollView(.horizontal) { codeContent } }
        }
        .background(tokens.usesDarkCanvas ? tokens.bgDeep : tokens.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1) }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5)); copied = false
        }
    }
    @ViewBuilder private var codeContent: some View {
                if isDiff && lines.count <= 1_200 {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            Text(verbatim: line.isEmpty ? " " : line)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 2)
                                .background(diffBackground(line))
                        }
                    }.font(MichiFont.code).foregroundStyle(tokens.fg).textSelection(.enabled).padding(.vertical, 8)
                } else {
                    NativeHighlightedCode(text: text, language: language).padding(.horizontal, 10).padding(.top, 2).padding(.bottom, 12)
                }
    }
    private func diffBackground(_ line: String) -> Color {
        if line.hasPrefix("+++ ") || line.hasPrefix("--- ") || line.hasPrefix("@@") { return tokens.alt }
        if line.hasPrefix("+") { return tokens.digest.opacity(0.18) }
        if line.hasPrefix("-") { return tokens.danger.opacity(0.16) }
        return .clear
    }
}
