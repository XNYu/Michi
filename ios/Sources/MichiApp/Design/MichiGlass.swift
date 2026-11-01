import SwiftUI

/// iOS 26 Liquid Glass, with iOS 17–25 system-material fallbacks.
/// Layout and content stay the same across the branch.
enum MichiGlass {
    static var isLiquidGlassOS: Bool {
        if #available(iOS 26.0, *) { return true }
        return false
    }
}

extension View {
    @ViewBuilder
    func michiGlassCapsule() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: Capsule())
        } else {
            self.background(.regularMaterial, in: Capsule())
        }
    }

    @ViewBuilder
    func michiGlassCircle() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: Circle())
        } else {
            self.background(.regularMaterial, in: Circle())
        }
    }

    @ViewBuilder
    func michiGlassRounded(_ radius: CGFloat) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        } else {
            self.background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
    }

    @ViewBuilder
    func michiGlassButton(prominent: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            if prominent {
                self.buttonStyle(.glassProminent)
            } else {
                self.buttonStyle(.glass)
            }
        } else {
            if prominent {
                self.buttonStyle(.borderedProminent)
            } else {
                self.buttonStyle(.bordered)
            }
        }
    }

    @ViewBuilder
    func michiScrollEdge() -> some View {
        if #available(iOS 26.0, *) {
            self.scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }

    @ViewBuilder
    func michiToolbarBackground() -> some View {
        if #available(iOS 26.0, *) {
            self.toolbarBackground(.hidden, for: .navigationBar)
        } else {
            self
        }
    }

    func michiHitTarget() -> some View {
        frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }
}

struct MichiGlassIconButton: View {
    let systemImage: String
    var tinted = false
    var accessibility: String
    let action: () -> Void
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(tinted && !MichiGlass.isLiquidGlassOS ? tokens.accent : tokens.fg)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .modifier(MichiGlassButtonChrome(tinted: tinted))
        .accessibilityLabel(accessibility)
    }
}

private struct MichiGlassButtonChrome: ViewModifier {
    var tinted: Bool
    @Environment(\.michiTokens) private var tokens
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if tinted {
                content.glassEffect(.regular, in: Circle()).tint(tokens.accent)
            } else {
                content.glassEffect(.regular, in: Circle())
            }
        } else {
            content.foregroundStyle(tokens.accent)
        }
    }
}

struct MichiPrimaryButton: View {
    let title: String
    var systemImage: String? = nil
    var enabled = true
    let action: () -> Void
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title).font(MichiFont.sans(size: 15, relativeTo: .body, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 48)
        }
        .disabled(!enabled)
        .michiGlassButton(prominent: true)
        .tint(tokens.accent)
        .foregroundStyle(tokens.accentInk)
    }
}

struct MichiSecondaryButton: View {
    let title: String
    var systemImage: String? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title).font(MichiFont.sans(size: 15, relativeTo: .body, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 48)
        }
        .michiGlassButton(prominent: false)
    }
}
