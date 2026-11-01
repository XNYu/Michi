import SwiftUI
import MichiCore

struct NativeSearchScreen: View {
    @ObservedObject var store: MichiStore
    @State private var query = ""
    @State private var scope = Scope.all
    @FocusState private var focused: Bool
    @Environment(\.michiTokens) private var tokens
    @Environment(\.openMichiReference) private var openMichiReference

    enum Scope: String, CaseIterable, Identifiable {
        case all, chats, pages
        var id: String { rawValue }
        var title: String { rawValue.uppercased() }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Scope", selection: $scope) {
                    ForEach(Scope.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                List {
                    if store.searchLoading {
                        ProgressView("Searching…").listRowBackground(tokens.bg).accessibilityIdentifier("search.loading")
                    } else if let error = store.searchError {
                        Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(tokens.dangerText)
                            .listRowBackground(tokens.bg).accessibilityIdentifier("search.error")
                    } else if store.searchCompleted && store.visibleSearchResults.isEmpty && !trimmed.isEmpty {
                        ContentUnavailableView.search(text: trimmed)
                            .listRowBackground(tokens.bg)
                            .accessibilityIdentifier("search.empty")
                    } else {
                        if scope != .pages && !store.visibleSearchResults.isEmpty {
                            Section {
                                ForEach(store.visibleSearchResults) { result in
                                    resultRow(result)
                                }
                            } header: {
                                MichiSectionHeader(title: "Messages", count: "\(store.visibleSearchResults.count)")
                            }
                        }
                    }
                }
                .michiPlainList()
            }
            .background(tokens.bg)
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.large)
            .michiToolbarBackground()
            .michiFloatingComposer {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").foregroundStyle(tokens.muted)
                    TextField("Search conversations and pages", text: $query)
                        .font(MichiFont.row)
                        .focused($focused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !query.isEmpty {
                        Button { query = ""; store.search("") } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(tokens.faint)
                        }
                        .michiHitTarget()
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: 52)
                .michiGlassCapsule()
            }
            .onChange(of: query) { _, value in store.search(value) }
            .onAppear {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--preview-search"), query.isEmpty { query = "native" }
                #endif
                store.search(query)
            }
            .onDisappear { store.cancelSearch() }
        }
    }

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func resultRow(_ result: NativeSearchResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { Task { await store.openSearchResult(result) } } label: {
                VStack(alignment: .leading, spacing: 4) {
                    // Highlight with the query these rows answered, not the field
                    // text the next debounced search has not answered yet.
                    NativeSearchHighlightedText(runs: NativeSearchHighlight.titleRuns(result, query: store.searchQuery))
                        .font(MichiFont.row).foregroundStyle(tokens.fg)
                    Text(verbatim: ([result.workspaceName] + result.breadcrumb).filter { !$0.isEmpty }.joined(separator: " › "))
                        .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted).lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search.node.\(result.navigation.nodeID)")

            ForEach(result.snippets) { snippet in
                Button {
                    guard store.canOpenSearchResult(result) else { return }
                    let target = NativeSearchNavigationTarget.of(result, snippet: snippet)
                    if let messageID = target.messageID {
                        openMichiReference(.node(id: target.nodeID, messageID: messageID))
                    } else {
                        Task { await store.openSearchResult(result) }
                    }
                } label: {
                    NativeSearchHighlightedText(runs: NativeSearchHighlight.snippetRuns(snippet, query: store.searchQuery))
                        .font(MichiFont.sans(size: 13.5, relativeTo: .footnote)).foregroundStyle(tokens.mid)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("search.snippet.\(result.nodeID).\(snippet.id)")
            }
        }
        .padding(.vertical, 6)
        .listRowBackground(tokens.bg)
    }
}

/// Highlighted search text shared by Search and the Chats tab. Runs come from
/// `NativeSearchHighlight`, so a match covers whole grapheme clusters and every
/// character, HTML-looking text included, is shown literally. Callers set the
/// base font and color; matches use the selection fill and ink.
struct NativeSearchHighlightedText: View {
    let runs: [NativeSearchHighlight.Run]
    @Environment(\.michiTokens) private var tokens

    var body: some View { Text(attributed) }

    private var attributed: AttributedString {
        var text = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            if run.isMatch {
                piece.swiftUI.backgroundColor = tokens.selectF
                piece.swiftUI.foregroundColor = tokens.selectInk
            }
            text += piece
        }
        return text
    }
}
