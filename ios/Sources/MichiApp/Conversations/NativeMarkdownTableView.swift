import SwiftUI
import UIKit
import MichiCore

private struct LiveAnswerContentKey: EnvironmentKey {
    static let defaultValue = false
}
private struct MarkdownTablePresenterKey: EnvironmentKey {
    static let defaultValue: NativeMarkdownTablePresenter? = nil
}
private struct MarkdownTableDocumentKey: EnvironmentKey {
    static let defaultValue: NativeMarkdownTableDocument? = nil
}

extension EnvironmentValues {
    /// Transient streaming answer rows. A token rebuild can drop a local cover
    /// there, so these rows offer fullscreen only through `markdownTablePresenter`.
    var liveAnswerContent: Bool {
        get { self[LiveAnswerContentKey.self] }
        set { self[LiveAnswerContentKey.self] = newValue }
    }
    var markdownTablePresenter: NativeMarkdownTablePresenter? {
        get { self[MarkdownTablePresenterKey.self] }
        set { self[MarkdownTablePresenterKey.self] = newValue }
    }
    var markdownTableDocument: NativeMarkdownTableDocument? {
        get { self[MarkdownTableDocumentKey.self] }
        set { self[MarkdownTableDocumentKey.self] = newValue }
    }
}

/// Native counterpart of MarkdownFeatureTable. Export always uses the original
/// arrays, never the visible page or a shortened cell preview.
struct NativeMarkdownTableView: View {
    let headers: [String]
    let alignments: [MarkdownAlignment]
    let rows: [[String]]
    /// HTML table cells: text stays text. Nil means ordinary Markdown cells.
    var headerCells: [[NativeInlineFragment]]? = nil
    var rowCells: [[[NativeInlineFragment]]]? = nil
    /// Document-global table index (`NativeMarkdownTableOrder`). Without it the
    /// table cannot be anchored to its source, so it keeps a local cover.
    var ordinal: Int? = nil
    @State private var fullscreen = false
    @Environment(\.markdownTablePresenter) private var presenter
    @Environment(\.markdownTableDocument) private var document
    @Environment(\.liveAnswerContent) private var liveAnswerContent

    private var snapshot: NativeMarkdownTableSnapshot {
        NativeMarkdownTableSnapshot(headers: headers, alignments: alignments, rows: rows, headerCells: headerCells, rowCells: rowCells)
    }
    private var usesHostedCover: Bool { presenter != nil && document != nil && ordinal != nil }
    private var canExpand: Bool { usesHostedCover || !liveAnswerContent }

    var body: some View {
        NativeMarkdownTablePanel(
            headers: headers,
            alignments: alignments,
            rows: rows,
            headerCells: headerCells,
            rowCells: rowCells,
            fullscreen: false,
            onExpand: canExpand ? expand : nil
        )
        .onAppear { syncHosted() }
        .onChange(of: rows) { _, _ in syncHosted() }
        .onChange(of: headers) { _, _ in syncHosted() }
        .fullScreenCover(isPresented: Binding(
            get: { fullscreen && !usesHostedCover },
            set: { fullscreen = $0 }
        )) {
            NativeMarkdownTableFullscreen(
                headers: headers,
                alignments: alignments,
                rows: rows,
                headerCells: headerCells,
                rowCells: rowCells
            ) { fullscreen = false }
        }
    }

    private func expand() {
        if let presenter, let document, let ordinal {
            presenter.present(document: document, snapshot: snapshot, ordinal: ordinal)
            fullscreen = false
        } else {
            fullscreen = true
        }
    }

    private func syncHosted() {
        guard let presenter, let document, let ordinal else { return }
        presenter.sync(document: document, snapshot: snapshot, ordinal: ordinal)
    }
}

/// Hosted fullscreen. The cover identity lives on the presenter so token-driven
/// row rebuilds update this panel instead of presenting a second modal.
struct NativeMarkdownTablePresentedCover: View {
    @ObservedObject var presenter: NativeMarkdownTablePresenter
    var body: some View {
        if let session = presenter.session {
            NativeMarkdownTableFullscreen(
                headers: session.snapshot.headers,
                alignments: session.snapshot.alignments,
                rows: session.snapshot.rows,
                headerCells: session.snapshot.headerCells,
                rowCells: session.snapshot.rowCells,
                onDismiss: { presenter.dismiss() }
            )
        }
    }
}

struct NativeMarkdownTableFullscreen: View {
    let headers: [String]
    let alignments: [MarkdownAlignment]
    let rows: [[String]]
    var headerCells: [[NativeInlineFragment]]? = nil
    var rowCells: [[[NativeInlineFragment]]]? = nil
    var onDismiss: () -> Void
    @Environment(\.michiTokens) private var tokens
    @Environment(\.michiReferenceAPI) private var referenceAPI

    var body: some View {
        NavigationStack {
            ScrollView {
                NativeMarkdownTablePanel(
                    headers: headers,
                    alignments: alignments,
                    rows: rows,
                    headerCells: headerCells,
                    rowCells: rowCells,
                    fullscreen: true
                )
                    .padding()
            }
            .background(tokens.bg)
            .toolbarBackground(tokens.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationTitle("Table")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { onDismiss() } } }
        }
        .michiTheme(tokens)
        .nativeMichiReferences(api: referenceAPI)
    }
}

private enum NativeTableLayout: String, CaseIterable { case cards = "Rows", grid = "Table" }

private struct NativeMarkdownTablePanel: View {
    let headers: [String]
    let alignments: [MarkdownAlignment]
    let rows: [[String]]
    var headerCells: [[NativeInlineFragment]]? = nil
    var rowCells: [[[NativeInlineFragment]]]? = nil
    let fullscreen: Bool
    var onExpand: (() -> Void)? = nil
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.michiReferenceAPI) private var referenceAPI
    @Environment(\.openMichiReference) private var openMichiReference
    @Environment(\.michiTokens) private var tokens
    @State private var chosenLayout: NativeTableLayout?
    @State private var rowPage = 0
    @State private var columnPage = 0
    @State private var share: NativeTableShare?
    @State private var shareDirectory: URL?
    @State private var message: String?
    @State private var fullCell: NativeTableFullCell?
    private let rowsPerPage = 20
    private let columnsPerPage = 12

    private var width: Int { max(headers.count, rows.map(\.count).max() ?? 0) }
    private var layout: NativeTableLayout {
        chosenLayout ?? ((voiceOver || dynamicTypeSize.isAccessibilitySize || (!fullscreen && horizontalSizeClass == .compact)) ? .cards : .grid)
    }
    private var rowPages: Int { max(1, (rows.count + rowsPerPage - 1) / rowsPerPage) }
    private var columnPages: Int { max(1, (width + columnsPerPage - 1) / columnsPerPage) }
    private var visibleRows: Range<Int> {
        let start = min(max(0, rowPage), rowPages - 1) * rowsPerPage
        return start..<min(start + rowsPerPage, rows.count)
    }
    private var visibleColumns: Range<Int> {
        let start = min(max(0, columnPage), columnPages - 1) * columnsPerPage
        return start..<min(start + columnsPerPage, width)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            controls
            if width == 0 {
                Text("Empty table").foregroundStyle(.secondary)
            } else {
                Picker("Table layout", selection: Binding(get: { layout }, set: { chosenLayout = $0 })) {
                    Text("Rows").tag(NativeTableLayout.cards)
                    Text("Table").tag(NativeTableLayout.grid)
                }.pickerStyle(.segmented)
                    .accessibilityHint("Rows lists every value with its column label. Table keeps the original columns side by side.")
                if columnPages > 1 {
                    paging("Columns", range: visibleColumns, count: width, page: $columnPage, pages: columnPages)
                }
                if layout == .cards { cards } else { grid }
                if rowPages > 1 {
                    paging("Rows", range: visibleRows, count: rows.count, page: $rowPage, pages: rowPages)
                    Text("Copy and Share include every row and column.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let message { Text(verbatim: message).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("table.action.status") }
        }
        .padding(12)
        .background(tokens.usesDarkCanvas ? tokens.bgDeep : tokens.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table with \(width) columns and \(rows.count) rows")
        .environment(\.openURL, OpenURLAction { url in
            nativeMichiOpenURL(url, allowInternal: referenceAPI != nil, open: openMichiReference)
        })
        .sheet(item: $share, onDismiss: cleanShareFile) { item in
            NativeTableShareSheet(url: item.url) {
                if share?.id == item.id { share = nil }
            }
        }
        .sheet(item: $fullCell) { item in
            NavigationStack {
                ScrollView {
                    // Literal full source avoids expensive parsing for large cells;
                    // neither this view nor its copy action truncates the value.
                    Text(verbatim: item.value).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding()
                }
                .navigationTitle(item.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Copy cell") { UIPasteboard.general.string = item.value } }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { fullCell = nil } }
                }
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 12) {
            Text("\(rows.count) rows").font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Button(action: copyMarkdown) { Image(systemName: "doc.on.doc") }
                .accessibilityLabel("Copy table as Markdown")
                .accessibilityIdentifier("table.copy")
            Button(action: shareMarkdown) { Image(systemName: "square.and.arrow.up") }
                .accessibilityLabel("Share table.md file")
                .accessibilityIdentifier("table.share")
            if let onExpand {
                Button(action: onExpand) { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                    .accessibilityLabel("View table fullscreen")
                    .accessibilityIdentifier("table.fullscreen")
            }
        }.buttonStyle(.bordered).controlSize(.regular)
    }

    private var cards: some View {
        VStack(alignment: .leading, spacing: 12) {
            if rows.isEmpty {
                ForEach(visibleColumns, id: \.self) { column in
                    cell(header(column), title: "Column \(column + 1)", alignment: .leading, fragments: headerFragments(column))
                        .fontWeight(.semibold)
                }
                Text("No data rows").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(visibleRows, id: \.self) { row in
                VStack(alignment: .leading, spacing: 10) {
                    Text("Row \(row + 1)").font(.caption).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
                    ForEach(visibleColumns, id: \.self) { column in
                        if dynamicTypeSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 4) {
                                cell(header(column), title: "Column \(column + 1)", alignment: .leading, fragments: headerFragments(column)).foregroundStyle(.secondary)
                                cell(value(row, column), title: "Row \(row + 1), \(header(column))", alignment: .leading, fragments: rowFragments(row, column))
                            }
                        } else {
                            HStack(alignment: .top, spacing: 12) {
                                cell(header(column), title: "Column \(column + 1)", alignment: .leading, fragments: headerFragments(column))
                                    .foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
                                cell(value(row, column), title: "Row \(row + 1), \(header(column))", alignment: .leading, fragments: rowFragments(row, column))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }.padding(12).background(tokens.surface, in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Row \(row + 1)")
            }
        }
    }

    private var grid: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                gridRow(nil).fontWeight(.semibold).background(.quaternary.opacity(0.55))
                ForEach(visibleRows, id: \.self) { row in
                    Divider()
                    gridRow(row)
                }
            }.clipShape(RoundedRectangle(cornerRadius: 8))
        }.accessibilityHint("Scroll horizontally to read the original table, or choose Rows for labeled values.")
    }

    private func gridRow(_ row: Int?) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(visibleColumns, id: \.self) { column in
                let text = row.map { value($0, column) } ?? (column < headers.count ? headers[column] : "")
                let title = row.map { "Row \($0 + 1), \(header(column))" } ?? "Column \(column + 1)"
                cell(text, title: title, alignment: frameAlignment(column), fragments: row.map { rowFragments($0, column) } ?? headerFragments(column))
                    .multilineTextAlignment(textAlignment(column))
                    .frame(width: 170, alignment: frameAlignment(column)).padding(10)
                    .accessibilityLabel(title)
                    .accessibilityValue(text.count <= 4_000 ? text : "Long cell; open full cell to read all content")
            }
        }
    }

    @ViewBuilder private func cell(_ text: String, title: String, alignment: Alignment, fragments: [NativeInlineFragment]? = nil) -> some View {
        if text.utf8.count > 16_000 {
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: String(text.prefix(500)) + "…").textSelection(.enabled)
                Button("Open full cell") { fullCell = .init(title: String(title.prefix(120)), value: text) }
                    .font(.caption).accessibilityHint("The preview is shortened. Open to read or copy the complete cell.")
            }.frame(maxWidth: .infinity, alignment: alignment)
        } else if text.isEmpty, fragments == nil || fragments?.isEmpty == true {
            Text(" ").accessibilityLabel("Empty cell").frame(maxWidth: .infinity, alignment: alignment)
        } else {
            NativeMarkdownTableInlineCell(text: text, fragments: fragments, alignment: alignment)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func headerFragments(_ column: Int) -> [NativeInlineFragment]? {
        guard let headerCells, column < headerCells.count else { return nil }
        return headerCells[column]
    }
    private func rowFragments(_ row: Int, _ column: Int) -> [NativeInlineFragment]? {
        guard let rowCells, row < rowCells.count, column < rowCells[row].count else { return nil }
        return rowCells[row][column]
    }

    private func paging(_ label: String, range: Range<Int>, count: Int, page: Binding<Int>, pages: Int) -> some View {
        HStack {
            Button { page.wrappedValue = max(0, page.wrappedValue - 1) } label: { Image(systemName: "chevron.left") }
                .disabled(page.wrappedValue <= 0).accessibilityLabel("Previous \(label.lowercased())")
            Spacer()
            Text("\(label) \(range.lowerBound + 1)–\(range.upperBound) of \(count)").font(.caption).monospacedDigit()
            Spacer()
            Button { page.wrappedValue = min(pages - 1, page.wrappedValue + 1) } label: { Image(systemName: "chevron.right") }
                .disabled(page.wrappedValue >= pages - 1).accessibilityLabel("Next \(label.lowercased())")
        }.buttonStyle(.bordered)
    }

    private func header(_ column: Int) -> String {
        guard column < headers.count, !headers[column].isEmpty else { return "Column \(column + 1)" }
        return headers[column]
    }
    private func value(_ row: Int, _ column: Int) -> String { column < rows[row].count ? rows[row][column] : "" }
    private func frameAlignment(_ column: Int) -> Alignment {
        guard column < alignments.count else { return .leading }
        switch alignments[column] { case .leading: return .leading; case .center: return .center; case .trailing: return .trailing }
    }
    private func textAlignment(_ column: Int) -> TextAlignment {
        guard column < alignments.count else { return .leading }
        switch alignments[column] { case .leading: return .leading; case .center: return .center; case .trailing: return .trailing }
    }
    private func copyMarkdown() {
        do {
            let markdown = try MarkdownTableExport.serialize(headers: headers, alignments: alignments, rows: rows)
            UIPasteboard.general.string = markdown
            message = "Copied the complete table as Markdown."
        } catch { message = error.localizedDescription }
    }
    private func shareMarkdown() {
        guard share == nil else { return }
        do {
            let markdown = try MarkdownTableExport.serialize(headers: headers, alignments: alignments, rows: rows)
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("michi-table-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let url = directory.appendingPathComponent("table.md")
            do { try Data(markdown.utf8).write(to: url, options: .atomic) }
            catch { try? FileManager.default.removeItem(at: directory); throw error }
            shareDirectory = directory
            share = NativeTableShare(url: url)
            message = nil
        } catch { message = (error as? MarkdownTableExport.Failure)?.localizedDescription ?? "The table file could not be prepared. Nothing was shared." }
    }
    private func cleanShareFile() {
        if let shareDirectory { try? FileManager.default.removeItem(at: shareDirectory) }
        shareDirectory = nil
    }
}

/// Bounded cell renderer. Known inline HTML is shown; a nested table, crossed
/// markdown, or reconstruct mismatch stays literal source. Ordinary Markdown
/// cells still go through `NativeMathInlineText`.
private struct NativeMarkdownTableInlineCell: View {
    let text: String
    var fragments: [NativeInlineFragment]? = nil
    var alignment: Alignment = .leading
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    @State private var availableWidth: CGFloat = 0

    var body: some View {
        switch presentation {
        case .verbatim:
            Text(verbatim: text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: alignment)
        case .math:
            NativeMathInlineText(text: text, alignment: alignment)
        case .html(let fragments):
            htmlText(fragments, markdownText: false)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: alignment)
                .background {
                    GeometryReader { geometry in
                        Color.clear.onAppear { availableWidth = geometry.size.width }
                            .onChange(of: geometry.size.width) { _, width in availableWidth = width }
                    }
                }
        case .mixed(let fragments):
            htmlText(fragments, markdownText: true)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: alignment)
                .background {
                    GeometryReader { geometry in
                        Color.clear.onAppear { availableWidth = geometry.size.width }
                            .onChange(of: geometry.size.width) { _, width in availableWidth = width }
                    }
                }
        }
    }

    private enum Presentation {
        case math, verbatim, html([NativeInlineFragment]), mixed([NativeInlineFragment])
    }

    private var presentation: Presentation {
        if let fragments {
            if fragments.contains(where: Self.isTable) { return .verbatim }
            if fragments.allSatisfy({ if case .text = $0 { return true }; return false }) { return .math }
            return .html(fragments)
        }
        guard NativeHTMLSyntax.containsMarkup(text) else { return .math }
        let fragments = NativeHTMLSyntax.inlineFragments(text)
        if NativeHTMLSyntax.reconstructed(fragments) != text || NativeHTMLSyntax.markdownCrossesHTML(fragments) {
            return .verbatim
        }
        if fragments.contains(where: Self.isTable) { return .verbatim }
        if fragments.allSatisfy({ if case .text = $0 { return true }; return false }) { return .math }
        return .mixed(fragments)
    }

    private static func isTable(_ fragment: NativeInlineFragment) -> Bool {
        if case .html(let node, _) = fragment { return containsTable(node) }
        return false
    }
    private static func containsTable(_ node: NativeHTMLNode) -> Bool {
        if case .element(let element) = node {
            return element.name == .table || element.children.contains(where: containsTable)
        }
        return false
    }

    private func htmlText(_ fragments: [NativeInlineFragment], markdownText: Bool) -> Text {
        var result = Text("")
        let fontSize = min(96, CGFloat(preferences.messageSize) * scale)
        let color = nativeFormulaColor(colorScheme)
        for fragment in fragments {
            switch fragment {
            case .text(let value):
                if markdownText {
                    result = result + NativeMathInlineLayout.markdown(
                        NativeMathSyntax.attributedRuns(value),
                        fontSize: fontSize,
                        color: color,
                        displayScale: displayScale,
                        availableWidth: availableWidth
                    )
                } else {
                    result = result + NativeMathInlineLayout.html(
                        value,
                        attributes: AttributeContainer(),
                        fontSize: fontSize,
                        color: color,
                        displayScale: displayScale,
                        availableWidth: availableWidth
                    )
                }
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

private struct NativeTableFullCell: Identifiable { let id = UUID(); let title: String; let value: String }
private struct NativeTableShare: Identifiable { let id = UUID(); let url: URL }

private struct NativeTableShareSheet: UIViewControllerRepresentable {
    let url: URL
    let onComplete: () -> Void
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in
            // Activity completion/cancellation can dismiss UIKit before SwiftUI
            // updates its item binding. Clear the parent item explicitly so its
            // onDismiss removes the file and another Share is immediately usable.
            Task { @MainActor in onComplete() }
        }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
