import SwiftUI
import MichiCore

struct FeatureStatusBanner: View {
    let title: String
    let message: String
    var retry: (() -> Void)?
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .font(MichiFont.rowTitle)
                .foregroundStyle(tokens.dangerText)
            Text(message)
                .font(MichiFont.rowSecondary)
                .foregroundStyle(tokens.muted)
                .textSelection(.enabled)
            if let retry {
                Button("Try Again", action: retry)
                    .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .semibold))
                    .foregroundStyle(tokens.accentText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tokens.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct FeatureLoadingView: View {
    var message: String = "Loading"
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(message)
                .font(MichiFont.rowSecondary)
                .foregroundStyle(tokens.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(tokens.bg)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }
}

struct FeatureEmptyView: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        ContentUnavailableView(title, systemImage: symbol, description: Text(detail))
    }
}

struct FeatureBusyOverlay: ViewModifier {
    let busy: Bool
    @Environment(\.michiTokens) private var tokens

    func body(content: Content) -> some View {
        content
            .disabled(busy)
            .overlay {
                if busy {
                    ProgressView()
                        .padding(16)
                        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(tokens.line, lineWidth: 1)
                        }
                }
            }
    }
}

extension View {
    func featureBusy(_ busy: Bool) -> some View {
        modifier(FeatureBusyOverlay(busy: busy))
    }
}

struct FeatureInspectView: View {
    let value: JSONValue
    var title: String = "Details"

    var body: some View {
        List {
            FeatureInspectNode(key: title, value: value)
        }
        .navigationTitle(title)
    }
}

private struct FeatureInspectNode: View {
    let key: String
    let value: JSONValue

    var body: some View {
        switch value {
        case .object(let fields):
            Section(key) {
                ForEach(fields.keys.sorted(), id: \.self) { field in
                    FeatureInspectRow(key: field, value: fields[field] ?? .null)
                }
            }
        case .array(let items):
            Section(key) {
                if items.isEmpty {
                    Text("Empty")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                        FeatureInspectRow(key: "\(index + 1)", value: item)
                    }
                }
            }
        default:
            LabeledContent(key) {
                Text(featureInspectLeaf(value))
                    .font(.footnote)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.trailing)
            }
        }
    }
}

private struct FeatureInspectRow: View {
    let key: String
    let value: JSONValue

    var body: some View {
        switch value {
        case .object, .array:
            NavigationLink {
                List { FeatureInspectNode(key: key, value: value) }
                    .navigationTitle(key)
            } label: {
                LabeledContent(key, value: value.objectValue.isEmpty ? "\(value.arrayValue.count) items" : "\(value.objectValue.count) fields")
            }
        default:
            LabeledContent(key) {
                Text(featureInspectLeaf(value))
                    .font(.footnote)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.trailing)
            }
        }
    }
}

private func featureInspectLeaf(_ value: JSONValue) -> String {
    switch value {
    case .string(let text): return text.isEmpty ? "—" : text
    case .number(let number): return number.rounded() == number ? String(Int(number)) : String(number)
    case .bool(let flag): return flag ? "Yes" : "No"
    case .null: return "—"
    default: return value.prettyPrinted
    }
}

struct FeatureMarkdownBlock: View {
    let text: String

    var body: some View {
        Text(featureMarkdown(text))
            .font(MichiFont.row)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }
}

struct FeatureConfirmDelete {
    var title: String
    var message: String
    var action: () -> Void
}
