import SwiftUI

/// Named Michi tokens. Web `tokens.ts` names and values are identical; iOS-only
/// extras (`sep`, `bubble`, `bar`, `accentText`, `info`) match `ios/Design`.
struct MichiTokens: Equatable {
    var bg: Color
    var bgDeep: Color
    var surface: Color
    var alt: Color
    var alt2: Color
    var grouped: Color
    var line: Color
    var lineS: Color
    var sep: Color
    var fg: Color
    var mid: Color
    var muted: Color
    var faint: Color
    var accent: Color
    var accentF: Color
    var accentInk: Color
    var accentText: Color
    var select: Color
    var selectF: Color
    var selectInk: Color
    var digest: Color
    var digestF: Color
    var mauve: Color
    var mauveF: Color
    var info: Color
    var infoF: Color
    var danger: Color
    var dangerText: Color
    var bubble: Color
    var bar: Color
    var codeKw: Color
    var codeFn: Color
    var codeStr: Color
    var codeTy: Color
    var codeNum: Color
    var usesDarkCanvas: Bool

    static let monokai = MichiTokens(
        bg: Color(hex: 0x272822), bgDeep: Color(hex: 0x1D1E19), surface: Color(hex: 0x2D2E28),
        alt: Color(hex: 0x383930), alt2: Color(hex: 0x3E3F38), grouped: Color(hex: 0x272822),
        line: Color(hex: 0x49483E), lineS: Color(hex: 0x75715E), sep: Color(hex: 0x3A3B33),
        fg: Color(hex: 0xF8F8F2), mid: Color(hex: 0xC0C0B8), muted: Color(hex: 0xA2A298), faint: Color(hex: 0x868371),
        accent: Color(hex: 0x66D9EF), accentF: Color(hex: 0x12292E), accentInk: Color(hex: 0x1D1E19), accentText: Color(hex: 0x66D9EF),
        select: Color(hex: 0xE6DB74), selectF: Color(hex: 0x2A2810), selectInk: Color(hex: 0xE6DB74),
        digest: Color(hex: 0xA6E22E), digestF: Color(hex: 0x1A2210),
        mauve: Color(hex: 0xAE81FF), mauveF: Color(hex: 0x1E1428),
        info: Color(hex: 0x66D9EF), infoF: Color(hex: 0x12292E),
        danger: Color(hex: 0xF92672), dangerText: Color(hex: 0xFF5C8A),
        bubble: Color(hex: 0x33352D), bar: Color(hex: 0x2D2E28),
        codeKw: Color(hex: 0xF92672), codeFn: Color(hex: 0xA6E22E), codeStr: Color(hex: 0xE6DB74),
        codeTy: Color(hex: 0x66D9EF), codeNum: Color(hex: 0xAE81FF),
        usesDarkCanvas: true
    )

    static let bone = MichiTokens(
        bg: Color(hex: 0xFDFDFC), bgDeep: Color(hex: 0xFFFFFF), surface: Color(hex: 0xFFFFFF),
        alt: Color(hex: 0xEFECE5), alt2: Color(hex: 0xE8E4D8), grouped: Color(hex: 0xFDFDFC),
        line: Color(hex: 0xD8D2C4), lineS: Color(hex: 0xB5AC98), sep: Color(hex: 0xE8E4D8),
        fg: Color(hex: 0x1A1916), mid: Color(hex: 0x5A544A), muted: Color(hex: 0x70695D), faint: Color(hex: 0x8C877C),
        accent: Color(hex: 0xB8451F), accentF: Color(hex: 0xF4DCCF), accentInk: Color(hex: 0xFDFDFC), accentText: Color(hex: 0x9E3A1A),
        select: Color(hex: 0xC48300), selectF: Color(hex: 0xF8ECCF), selectInk: Color(hex: 0x8A5C00),
        digest: Color(hex: 0x2F6B4E), digestF: Color(hex: 0xD7E7DF),
        mauve: Color(hex: 0x6D4AA8), mauveF: Color(hex: 0xEBE4F6),
        info: Color(hex: 0x1A4D8F), infoF: Color(hex: 0xDDE6F2),
        danger: Color(hex: 0xA8261A), dangerText: Color(hex: 0xA8261A),
        bubble: Color(hex: 0xF8EBE3), bar: Color(hex: 0xFFFFFF),
        codeKw: Color(hex: 0xB8451F), codeFn: Color(hex: 0x1A4D8F), codeStr: Color(hex: 0x2F6B4E),
        codeTy: Color(hex: 0x6D4AA8), codeNum: Color(hex: 0x6D4AA8),
        usesDarkCanvas: false
    )

    static let slate = MichiTokens(
        bg: Color(hex: 0xF3F4F6), bgDeep: Color(hex: 0xFFFFFF), surface: Color(hex: 0xFFFFFF),
        alt: Color(hex: 0xE5E7EB), alt2: Color(hex: 0xD8DBE1), grouped: Color(hex: 0xF3F4F6),
        line: Color(hex: 0xD1D5DB), lineS: Color(hex: 0x9CA3AF), sep: Color(hex: 0xE5E7EB),
        fg: Color(hex: 0x111827), mid: Color(hex: 0x4B5563), muted: Color(hex: 0x616876), faint: Color(hex: 0x7D8491),
        accent: Color(hex: 0x1A4D8F), accentF: Color(hex: 0xDBEAFE), accentInk: Color(hex: 0xFFFFFF), accentText: Color(hex: 0x1A4D8F),
        select: Color(hex: 0xC48300), selectF: Color(hex: 0xFEF3C7), selectInk: Color(hex: 0x8A5C00),
        digest: Color(hex: 0x2F6B4E), digestF: Color(hex: 0xD1FAE5),
        mauve: Color(hex: 0x6D4AA8), mauveF: Color(hex: 0xEDE9FE),
        info: Color(hex: 0x1A4D8F), infoF: Color(hex: 0xDBEAFE),
        danger: Color(hex: 0xB91C1C), dangerText: Color(hex: 0xB91C1C),
        bubble: Color(hex: 0xE8EEF6), bar: Color(hex: 0xFFFFFF),
        codeKw: Color(hex: 0x1A4D8F), codeFn: Color(hex: 0x2F6B4E), codeStr: Color(hex: 0xB8451F),
        codeTy: Color(hex: 0x6D4AA8), codeNum: Color(hex: 0x6D4AA8),
        usesDarkCanvas: false
    )

    static let gruvbox = MichiTokens(
        bg: Color(hex: 0x282828), bgDeep: Color(hex: 0x1D1D1D), surface: Color(hex: 0x2E2E2E),
        alt: Color(hex: 0x3C3836), alt2: Color(hex: 0x504945), grouped: Color(hex: 0x282828),
        line: Color(hex: 0x504945), lineS: Color(hex: 0x665C54), sep: Color(hex: 0x3C3836),
        fg: Color(hex: 0xEBDBB2), mid: Color(hex: 0xCABB9B), muted: Color(hex: 0xAFA088), faint: Color(hex: 0x8D816F),
        accent: Color(hex: 0x83A598), accentF: Color(hex: 0x1E2826), accentInk: Color(hex: 0x1D1D1D), accentText: Color(hex: 0x83A598),
        select: Color(hex: 0xFABD2F), selectF: Color(hex: 0x2A2410), selectInk: Color(hex: 0xFABD2F),
        digest: Color(hex: 0xB8BB26), digestF: Color(hex: 0x1E2210),
        mauve: Color(hex: 0xD3869B), mauveF: Color(hex: 0x281A20),
        info: Color(hex: 0x83A598), infoF: Color(hex: 0x1E2826),
        danger: Color(hex: 0xFB4934), dangerText: Color(hex: 0xFB4934),
        bubble: Color(hex: 0x3C3836), bar: Color(hex: 0x2E2E2E),
        codeKw: Color(hex: 0xFB4934), codeFn: Color(hex: 0xB8BB26), codeStr: Color(hex: 0xFABD2F),
        codeTy: Color(hex: 0x83A598), codeNum: Color(hex: 0xD3869B),
        usesDarkCanvas: true
    )

    static func named(_ palette: String) -> MichiTokens {
        switch palette {
        case "bone": return .bone
        case "slate": return .slate
        case "gruvbox": return .gruvbox
        default: return .monokai
        }
    }

    /// Compatible entry point. Pass `paletteExplicit: false` for an unset
    /// default. When `appearance` is `"system"`, the live scheme wins even if
    /// this caller treats the palette as saved.
    static func resolved(palette: String, appearance: String, colorScheme: ColorScheme) -> MichiTokens {
        resolved(palette: palette, appearance: appearance, colorScheme: colorScheme, paletteExplicit: true)
    }

    static func resolved(palette: String, appearance: String, colorScheme: ColorScheme, paletteExplicit: Bool) -> MichiTokens {
        named(NativeAppearancePreferences.resolvedPalette(
            palette: palette,
            paletteExplicit: paletteExplicit,
            appearance: appearance,
            systemIsLight: colorScheme == .light
        ))
    }

    func withAccent(_ hex: String?) -> MichiTokens {
        guard let hex, NativeAppearancePreferences.isHexColor(hex) else { return self }
        var next = self
        next.accent = Color(hexString: hex)
        if usesDarkCanvas { next.accentText = next.accent; next.info = next.accent }
        return next
    }
}

private struct MichiTokensKey: EnvironmentKey {
    static let defaultValue = MichiTokens.monokai
}

extension EnvironmentValues {
    var michiTokens: MichiTokens {
        get { self[MichiTokensKey.self] }
        set { self[MichiTokensKey.self] = newValue }
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }

    init(hexString: String) {
        let digits = hexString.dropFirst(hexString.hasPrefix("#") ? 1 : 0)
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else {
            self = .accentColor
            return
        }
        self.init(hex: value)
    }

}

extension View {
    func michiTheme(_ tokens: MichiTokens) -> some View {
        environment(\.michiTokens, tokens)
            .tint(tokens.accent)
            .background(tokens.bg.ignoresSafeArea())
    }
}
