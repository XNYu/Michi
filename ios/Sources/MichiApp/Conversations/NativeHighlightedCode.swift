import SwiftUI
import MichiCore

/// NativeCodeBlock owns wrapping/scrolling, padding and copy/share actions.
/// One selectable Text retains the exact code, without Markdown interpretation.
/// Colors follow the active palette (Monokai / Bone code schemes).
struct NativeHighlightedCode: View {
    private let text: String
    private let tokens: [NativeCodeSyntax.Token]?
    @Environment(\.michiTokens) private var palette

    init(text: String, language: String) {
        self.text = text
        let tokens = NativeCodeSyntax.tokens(text, language: language)
        // Large/unsupported content uses Text directly, avoiding a second full
        // attributed-string allocation after the tokenizer's bounded fallback.
        self.tokens = tokens.count == 1 && tokens[0].kind == .plain ? nil : tokens
    }

    var body: some View {
        content
            .font(MichiFont.code)
            .lineSpacing(4)
            .foregroundStyle(palette.fg)
            .textSelection(.enabled)
            .accessibilityLabel(Text(verbatim: text))
    }

    private var content: Text {
        guard let tokens else { return Text(verbatim: text) }
        var highlighted = AttributedString()
        for token in tokens {
            var part = AttributedString(token.text)
            switch token.kind {
            case .plain, .punctuation: part.foregroundColor = palette.fg
            case .keyword: part.foregroundColor = palette.codeKw
            case .variable: part.foregroundColor = palette.codeTy
            case .string: part.foregroundColor = palette.codeStr
            case .property: part.foregroundColor = palette.codeFn
            case .number: part.foregroundColor = palette.codeNum
            case .comment: part.foregroundColor = palette.faint
            }
            highlighted.append(part)
        }
        return Text(highlighted)
    }
}
