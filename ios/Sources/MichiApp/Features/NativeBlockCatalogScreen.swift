import SwiftUI
import MichiCore

/// Native catalog destination. The caller supplies navigation and the page edit path.
/// Preview changes are local; Add always inserts the original catalog example.
struct NativeBlockCatalogScreen: View {
    var onInsert: ((JSONValue) async throws -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var catalog: NativeBlockCatalog?
    @State private var query = ""
    @State private var category = "all"
    @State private var busy: String?
    @State private var error: String?
    @State private var notice: String?

    init(onInsert: ((JSONValue) async throws -> Void)? = nil, now: Date = Date(), timeZone: TimeZone = .current) {
        self.onInsert = onInsert
        do { _catalog = State(initialValue: try NativeBlockCatalog(now: now, timeZone: timeZone)) }
        catch { _error = State(initialValue: error.localizedDescription) }
    }

    var body: some View {
        Group {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    Text("The building blocks of a page. Changes to these samples stay in the preview.")
                        .font(MichiFont.rowSecondary).foregroundStyle(.secondary)
                    if let catalog {
                        Picker("Category", selection: $category) {
                            Text("All (\(catalog.entries.count))").tag("all")
                            ForEach(catalog.categories, id: \.id) { item in Text(item["label"].stringValue).tag(item.id) }
                        }.pickerStyle(.menu)
                        if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
                        if let notice { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.secondary) }
                        let matches = catalog.filtered(query: query, category: category)
                        if matches.isEmpty { ContentUnavailableView.search(text: query) }
                        ForEach(matches) { entry in
                            VStack(alignment: .leading, spacing: 12) {
                                HStack { Text(entry.name).font(.headline); Spacer(); Text(entry.id).font(.caption.monospaced()).foregroundStyle(.secondary) }
                                Text(entry.description).font(.subheadline).foregroundStyle(.secondary)
                                NativeBlockCatalogPreview(entry: entry)
                                DisclosureGroup("Example source") {
                                    Text(entry.input.prettyPrinted).font(.caption.monospaced()).textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }.font(.caption)
                                if let addedBy = entry.addedBy { Text(addedBy).font(.caption).foregroundStyle(.secondary) }
                                else if let onInsert {
                                    Button {
                                        guard busy == nil else { return }
                                        busy = entry.id; error = nil; notice = nil
                                        Task {
                                            defer { busy = nil }
                                            do { try await onInsert(entry.input); notice = "Added \(entry.name) to the page." }
                                            catch { self.error = error.localizedDescription }
                                        }
                                    } label: {
                                        if busy == entry.id { ProgressView("Adding…") }
                                        else { Label("Add to page", systemImage: "plus") }
                                    }
                                    .buttonStyle(.bordered).disabled(busy != nil)
                                    .accessibilityLabel("Add \(entry.name) to the page")
                                }
                            }
                            .padding().background(.thinMaterial, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                    } else if let error { Text(error).foregroundStyle(.red) }
                }.padding()
            }
            .navigationTitle("Built-in components")
            .navigationBarTitleDisplayMode(.inline)
            .michiToolbarBackground()
            .searchable(text: $query, prompt: "Chart, checklist, calendar…")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct NativeBlockCatalogPreview: View {
    let entry: NativeBlockCatalogEntry
    @State private var sample: JSONValue
    @State private var draft: String?
    init(entry: NativeBlockCatalogEntry) {
        self.entry = entry
        _sample = State(initialValue: entry.input.merging(["id": .string("sample-" + entry.id), "rev": 1]))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if entry.id == "threads" { sampleThreads }
            else {
                NativeRichPageBlock(block: sample, pageBlocks: [sample], onApply: { input, _, _ in
                    guard input["type"].stringValue == entry.id else { return false }
                    sample = input.merging(["id": .string("sample-" + entry.id), "rev": 1]); return true
                }, onPrompt: { text in draft = text; return true }, homeSectionContent: { _ in AnyView(sampleThreads) })
            }
            if let draft {
                Text("Sample assistant input").font(.caption).foregroundStyle(.secondary)
                Text(draft).font(.callout).textSelection(.enabled)
                Text("Preview only. Nothing was sent.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding().frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
    private var sampleThreads: some View {
        VStack(alignment: .leading, spacing: 12) {
            thread("S3 · Schema naming", "waiting", "Asked: snake_case or camelCase for the new tables?")
            if entry.id == "threads" {
                thread("S7 · Migrate the MCP config", "stalled", "Failed: the end-to-end run timed out")
                thread("S5 · End-to-end tests", "running", "Running the last 9 suites.")
                thread("S2 · Update the docs", "done", "The migration guide is written.")
            }
        }
    }
    private func thread(_ title: String, _ state: String, _ summary: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: "bubble.left").font(.subheadline.bold())
            Text(state.capitalized).font(.caption).foregroundStyle(.secondary)
            Text(summary).font(.caption)
        }
    }
}
