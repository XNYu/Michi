import SwiftUI
import UIKit

/// Web SelectionActions on iOS: a read-only UITextView whose system edit menu
/// gains Quote and Branch for the selected passage. Handles and long-press
/// stay system behavior; the rendered message itself is unchanged.
struct NativeMessageSelectionSheet: View {
    let text: String
    let canBranch: Bool
    let onQuote: (String) -> Void
    let onBranch: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                Text("Select a passage, then choose Quote or Branch.")
                    .font(MichiFont.rowSecondary).foregroundStyle(tokens.muted)
                    .padding(.horizontal, 20).padding(.top, 4)
                NativeSelectableText(text: text, color: UIColor(tokens.fg), tint: UIColor(tokens.accent), canBranch: canBranch,
                                     onQuote: { onQuote($0); dismiss() }, onBranch: { onBranch($0); dismiss() })
                    .padding(.horizontal, 16)
            }
            .background(tokens.bg)
            .navigationTitle("Select text").navigationBarTitleDisplayMode(.inline)
            .michiToolbarBackground()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct NativeSelectableText: UIViewRepresentable {
    let text: String
    let color: UIColor
    let tint: UIColor
    let canBranch: Bool
    let onQuote: (String) -> Void
    let onBranch: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        let base = UIFont(name: MichiFont.sansName(.regular), size: 17) ?? .preferredFont(forTextStyle: .body)
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: base)
        view.textContainerInset = UIEdgeInsets(top: 12, left: 0, bottom: 24, right: 0)
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "message-selection"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.textColor = color
        view.tintColor = tint
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativeSelectableText
        init(_ parent: NativeSelectableText) { self.parent = parent }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            let selected = (textView.text as NSString).substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !selected.isEmpty else { return nil }
            var actions: [UIMenuElement] = [
                UIAction(title: "Quote", image: UIImage(systemName: "text.quote")) { [weak self] _ in self?.parent.onQuote(selected) }
            ]
            if parent.canBranch {
                actions.append(UIAction(title: "Branch", image: UIImage(systemName: "arrow.triangle.branch")) { [weak self] _ in self?.parent.onBranch(selected) })
            }
            return UIMenu(children: actions + suggestedActions)
        }
    }
}
