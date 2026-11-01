import SwiftUI

/// Bundled Geist / Geist Mono, selected by PostScript name per weight.
/// Dynamic Type is preserved via `Font.custom(_:size:relativeTo:)`.
enum MichiFont {
    static func sans(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        Font.custom(sansName(weight), size: size(style), relativeTo: style)
    }

    static func mono(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        Font.custom(monoName(weight), size: size(style), relativeTo: style)
    }

    static func sans(size: CGFloat, relativeTo style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        Font.custom(sansName(weight), size: size, relativeTo: style)
    }

    static func mono(size: CGFloat, relativeTo style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        Font.custom(monoName(weight), size: size, relativeTo: style)
    }

    static func sansName(_ weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black: return "Geist-Bold"
        case .semibold: return "Geist-SemiBold"
        case .medium: return "Geist-Medium"
        default: return "Geist-Regular"
        }
    }

    static func monoName(_ weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black, .semibold: return "GeistMono-SemiBold"
        case .medium: return "GeistMono-Medium"
        default: return "GeistMono-Regular"
        }
    }

    static func size(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: return 34
        case .title: return 28
        case .title2: return 22
        case .title3: return 20
        case .headline: return 17
        case .body: return 16
        case .callout: return 15
        case .subheadline: return 15
        case .footnote: return 13
        case .caption: return 12
        case .caption2: return 11
        default: return 16
        }
    }

    static var screenTitle: Font { sans(size: 28, relativeTo: .title, weight: .semibold) }
    static var largeTitle: Font { sans(size: 30, relativeTo: .title, weight: .semibold) }
    static var greeting: Font { sans(size: 26, relativeTo: .title2, weight: .medium) }
    static var section: Font { sans(size: 11, relativeTo: .caption2, weight: .semibold) }
    static var row: Font { sans(size: 15, relativeTo: .subheadline) }
    static var rowTitle: Font { sans(size: 15, relativeTo: .subheadline, weight: .medium) }
    static var rowSecondary: Font { sans(size: 12.5, relativeTo: .caption) }
    static var reply: Font { sans(size: 16, relativeTo: .body) }
    static var meta: Font { mono(size: 11.5, relativeTo: .caption2) }
    static var prompt: Font { mono(size: 14, relativeTo: .footnote, weight: .semibold) }
    static var code: Font { mono(size: 13, relativeTo: .footnote) }
    static var tag: Font { mono(size: 11, relativeTo: .caption2, weight: .medium) }
    static var chip: Font { mono(size: 12, relativeTo: .caption, weight: .medium) }
}

struct MichiSectionHeader: View {
    let title: String
    var count: String? = nil
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(MichiFont.section)
                .tracking(0.88)
                .textCase(.uppercase)
                .foregroundStyle(tokens.muted)
            Spacer()
            if let count {
                Text(count)
                    .font(MichiFont.meta)
                    .foregroundStyle(tokens.muted)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 24)
        .padding(.bottom, 8)
        .accessibilityAddTraits(.isHeader)
    }
}

struct MichiLargeTitle: View {
    let text: String
    var subtitle: String? = nil
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .font(MichiFont.largeTitle)
                .tracking(-0.56)
                .foregroundStyle(tokens.fg)
            if let subtitle {
                Text(subtitle)
                    .font(MichiFont.meta)
                    .foregroundStyle(tokens.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .accessibilityAddTraits(.isHeader)
    }
}
