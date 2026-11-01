import SwiftUI
import UniformTypeIdentifiers
import QuickLook
import ImageIO
import MichiCore

struct ArtifactScreen: View {
    @StateObject private var model: ArtifactLibraryModel
    var subtitle: String?
    var onQuote: ((String, JSONValue) -> Void)?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens
    @State private var filter = ""
    @State private var kind = Kind.all
    private enum Kind: String, CaseIterable { case all = "All", documents = "Documents", images = "Images" }
    init(api: MichiAPI, graph: WorkspaceGraph, subtitle: String? = nil, onQuote: ((String, JSONValue) -> Void)? = nil) {
        _model = StateObject(wrappedValue: ArtifactLibraryModel(api: api, graph: graph)); self.subtitle = subtitle; self.onQuote = onQuote
    }
    private var artifacts: [JSONValue] {
        model.artifacts.filter { artifact in
            let matches = filter.isEmpty || artifact["name"].stringValue.localizedCaseInsensitiveContains(filter) || artifact["file_path"].stringValue.localizedCaseInsensitiveContains(filter)
            switch kind {
            case .all: return matches
            case .images: return matches && artifact["type"].stringValue == "image"
            case .documents: return matches && artifact["type"].stringValue != "image" && artifact["type"].stringValue != "link"
            }
        }
    }
    var body: some View {
        NavigationStack {
            List {
                Picker("File type", selection: $kind) { ForEach(Kind.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 14, trailing: 16))
                if let error = model.error { Label(error, systemImage: "exclamationmark.triangle").font(MichiFont.row).foregroundStyle(tokens.dangerText).listRowBackground(Color.clear) }
                ForEach(artifacts, id: \.id) { artifact in
                    Group {
                        if artifact["type"].stringValue == "link" {
                            if let url = URL(string: artifact["url"].stringValue), MarkdownDocument.safeLink(url) {
                                Link(destination: url) { fileRow(artifact, symbol: "link", detail: url.host() ?? "Link") }
                            } else { fileRow(artifact, symbol: "link.badge.plus", detail: "Unavailable link").opacity(0.6) }
                        } else {
                            NavigationLink {
                                ArtifactDetail(api: model.api, workspaceID: model.workspaceID, artifact: artifact, onQuote: onQuote.map { callback in
                                    { text, source in callback(text, source); dismiss() }
                                })
                            } label: { fileRow(artifact, symbol: Self.symbol(artifact), detail: Self.detail(artifact)) }
                        }
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparatorTint(tokens.sep)
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 52 }
                }
                if artifacts.isEmpty {
                    ContentUnavailableView(filter.isEmpty && kind == .all ? "No saved files" : "No matching files", systemImage: "doc.text", description: Text("Files saved by your agents appear here."))
                        .listRowBackground(Color.clear)
                } else {
                    Text("Tap a file to preview it. From its preview you can download, share, attach or quote it.")
                        .font(MichiFont.sans(size: 12, relativeTo: .caption)).foregroundStyle(tokens.muted)
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
            }
            .michiPlainList()
            .navigationBarTitleDisplayMode(.inline)
            .michiToolbarBackground()
            .searchable(text: $filter, prompt: "Find a file")
            .refreshable { await model.refresh() }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("Files").font(MichiFont.sans(size: 15, relativeTo: .headline, weight: .semibold)).foregroundStyle(tokens.fg)
                        if let subtitle, !subtitle.isEmpty { Text(subtitle).font(MichiFont.mono(size: 11, relativeTo: .caption2)).foregroundStyle(tokens.muted).lineLimit(1) }
                    }
                }
                ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Done") }
            }
            .navigationTitle("Files & artifacts")
            .task { await model.refresh() }
        }
    }

    private func fileRow(_ artifact: JSONValue, symbol: String, detail: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 15))
                .foregroundStyle(artifact["type"].stringValue == "image" ? tokens.digest : tokens.mid)
                .frame(width: 36, height: 36)
                .background(artifact["type"].stringValue == "image" ? tokens.digestF : tokens.alt, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(tokens.line, lineWidth: 1) }
            VStack(alignment: .leading, spacing: 2) {
                Text(artifact["name"].stringValue).font(MichiFont.mono(size: 15, relativeTo: .body)).foregroundStyle(tokens.fg).lineLimit(1)
                Text(detail).font(MichiFont.rowSecondary).foregroundStyle(tokens.muted).lineLimit(2)
            }
        }
        .frame(minHeight: 52)
        .accessibilityElement(children: .combine)
    }

    private static func symbol(_ artifact: JSONValue) -> String {
        let ext = (artifact["file_path"].stringValue as NSString).pathExtension.lowercased()
        if artifact["type"].stringValue == "image" { return "photo" }
        if ["csv", "tsv", "xlsx", "numbers"].contains(ext) { return "tablecells" }
        if ["html", "htm", "js", "svg"].contains(ext) { return "globe" }
        return "doc.text"
    }

    private static func detail(_ artifact: JSONValue) -> String {
        let ext = (artifact["file_path"].stringValue as NSString).pathExtension.lowercased()
        if ["html", "htm", "js", "svg"].contains(ext) { return "Shown as source. Web apps don’t run in Michi for iOS." }
        var parts: [String] = []
        if !ext.isEmpty { parts.append(ext == "md" || ext == "markdown" ? "Markdown" : ext.uppercased()) }
        if case .number(let size) = artifact["size"], size >= 0 { parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
        if parts.isEmpty { parts.append(artifact["file_path"].stringValue) }
        return parts.joined(separator: " · ")
    }
}

struct ArtifactDetail: View {
    @StateObject private var model: ArtifactFileModel
    var onQuote: ((String, JSONValue) -> Void)?
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSource = false
    @State private var quoteEditor = false
    @State private var exporter = false
    @State private var exportDocument: DownloadedArtifactDocument?
    @State private var preview: ArtifactPreviewItem?
    @State private var actionError: String?
    init(api: MichiAPI, workspaceID: String, artifact: JSONValue, onQuote: ((String, JSONValue) -> Void)? = nil) {
        _model = StateObject(wrappedValue: ArtifactFileModel(api: api, workspaceID: workspaceID, artifact: artifact)); self.onQuote = onQuote
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let error = model.error {
                    Label(error, systemImage: model.missing ? "doc.badge.ellipsis" : "exclamationmark.triangle").foregroundStyle(.red)
                    if model.showingCachedContent { Text("Showing the last successfully loaded content.").font(.caption).foregroundStyle(.secondary) }
                }
                if let content = model.content { rendered(content) }
                else if model.loading { ProgressView("Loading file…") }
                else if !model.missing { Text("Use Download to save or preview files that cannot be displayed as text.").foregroundStyle(.secondary) }
                downloadActions
                if let error = model.downloadError ?? actionError { Text(error).foregroundStyle(.red) }
                if let watchError = model.watchError { Text(watchError).font(.caption).foregroundStyle(.secondary) }
            }.padding()
        }
        .navigationTitle(model.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.loading).accessibilityLabel("Refresh artifact")
                if let content = model.content, content.imageData == nil {
                    Button { showSource.toggle() } label: { Image(systemName: showSource ? "text.alignleft" : "chevron.left.forwardslash.chevron.right") }.accessibilityLabel(showSource ? "Show formatted text" : "Show source")
                }
            }
        }
        .onAppear { if scenePhase == .active { model.start() } }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.start() } else { model.stop() } }
        .onChange(of: model.downloaded?.fileURL) { _, url in if url == nil { preview = nil; exportDocument = nil } }
        .sheet(item: $preview) { item in ArtifactQuickLook(url: item.url).ignoresSafeArea() }
        .sheet(isPresented: $quoteEditor) {
            ArtifactQuoteEditor(text: model.content?.text ?? "", name: model.name) { text in
                onQuote?(text, model.quoteSource)
            }
        }
        .fileExporter(isPresented: $exporter, document: exportDocument, contentType: .data, defaultFilename: model.downloaded?.filename ?? model.name) { result in
            if case .failure(let error) = result { actionError = error.localizedDescription }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(model.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            if let content = model.content {
                Text("\(ByteCountFormatter.string(fromByteCount: Int64(content.size), countStyle: .file)) · Modified \(Date(timeIntervalSince1970: content.modifiedAt / 1000).formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
            }
            if let checked = model.lastChecked { Text("Checked \(checked.formatted(date: .omitted, time: .shortened)) · Refreshes while open").font(.caption2).foregroundStyle(.secondary) }
            if onQuote != nil && !model.missing {
                HStack {
                    Button("Attach reference", systemImage: "at") { onQuote?(model.referenceText, model.quoteSource) }
                    if model.content?.imageData == nil, model.content != nil { Button("Quote text…", systemImage: "quote.bubble") { quoteEditor = true } }
                }.font(.subheadline).buttonStyle(.bordered)
            }
        }
    }

    @ViewBuilder private func rendered(_ content: ArtifactContent) -> some View {
        if let data = content.imageData {
            if let image = thumbnail(data) { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(model.name) }
            else { Label("This image could not be decoded.", systemImage: "photo.badge.exclamationmark").foregroundStyle(.secondary) }
        } else if !showSource && ["md", "markdown", "mdown"].contains(content.fileExtension) {
            NativeMarkdown(text: content.text)
        } else {
            // HTML, SVG and JS are inert source text here, never a WebView.
            ScrollView(.horizontal) { Text(verbatim: content.text).font(.system(.subheadline, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        }
    }

    private func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2_048
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    private var downloadActions: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let file = model.downloaded {
                HStack {
                    Button("Save to Files", systemImage: "square.and.arrow.down") {
                        exportDocument = DownloadedArtifactDocument(url: file.fileURL); exporter = true
                    }
                    ShareLink(item: file.fileURL) { Label("Share", systemImage: "square.and.arrow.up") }
                }
                if ArtifactFileModel.canPreviewDownload(file.filename), QLPreviewController.canPreview(file.fileURL as NSURL) {
                    Button("Open native preview", systemImage: "doc.viewfinder") { preview = ArtifactPreviewItem(url: file.fileURL) }
                }
            } else {
                Button {
                    actionError = nil
                    Task { _ = await model.prepareDownload() }
                } label: {
                    if model.downloading { ProgressView("Downloading…") }
                    else { Label("Download file", systemImage: "arrow.down.circle") }
                }.disabled(model.downloading || model.missing)
                Text("Downloads are limited to 50 MB.").font(.caption).foregroundStyle(.secondary)
            }
        }.buttonStyle(.bordered)
    }
}

private struct DownloadedArtifactDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    let url: URL?
    private let data: Data?
    init(url: URL) { self.url = url; data = nil }
    init(configuration: ReadConfiguration) throws { url = nil; data = configuration.file.regularFileContents }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        if let url { return try FileWrapper(url: url, options: .immediate) }
        return FileWrapper(regularFileWithContents: data ?? Data())
    }
}

private struct ArtifactPreviewItem: Identifiable { let url: URL; var id: URL { url } }
private struct ArtifactQuickLook: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController(); controller.dataSource = context.coordinator; return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.url != url { context.coordinator.url = url; controller.reloadData() }
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

private struct ArtifactQuoteEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String
    let name: String
    let truncated: Bool
    let insert: (String) -> Void
    init(text: String, name: String, insert: @escaping (String) -> Void) {
        _selection = State(initialValue: String(text.prefix(20_000)))
        self.name = name; truncated = text.count > 20_000; self.insert = insert
    }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("Keep the passage you want to quote from \(name).").font(.subheadline)
                if truncated { Text("The first 20,000 characters are shown. Edit the selection before inserting.").font(.caption).foregroundStyle(.secondary) }
                TextEditor(text: $selection).font(.body).accessibilityLabel("Quoted passage")
                Text("\(selection.count) / 20,000 characters").font(.caption).foregroundStyle(.secondary)
            }.padding().navigationTitle("Quote from file").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Insert quote") { insert(selection); dismiss() }
                            .disabled(selection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selection.count > 20_000)
                    }
                }
        }
    }
}
