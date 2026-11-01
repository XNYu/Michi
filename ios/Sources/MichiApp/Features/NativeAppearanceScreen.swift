import SwiftUI
import MichiCore

private struct NativeAppearanceEnvironmentKey: EnvironmentKey {
    static let defaultValue = NativeAppearancePreferences()
}
extension EnvironmentValues {
    var michiAppearance: NativeAppearancePreferences {
        get { self[NativeAppearanceEnvironmentKey.self] }
        set { self[NativeAppearanceEnvironmentKey.self] = newValue }
    }
}

/// Appearance (ios/Design 27): palette cards previewed with each palette's real
/// tokens, the system-appearance switch, accent swatches and reading settings,
/// followed by every other /prefs and device preference this screen already had.
/// Nothing is written until Save; unknown stored values are shown and kept.
struct NativeAppearanceScreen: View {
    @StateObject private var model: NativeAppearanceModel
    let onApply: (NativeAppearancePreferences) -> Void
    /// Same key and unset default ("dark") as the shell.
    @AppStorage("michi.appearance") private var appearance = "dark"
    @Environment(\.michiTokens) private var tokens
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(api: MichiAPI, onApply: @escaping (NativeAppearancePreferences) -> Void = { _ in }) {
        _model = StateObject(wrappedValue: NativeAppearanceModel(api: api)); self.onApply = onApply
    }
    init(model: NativeAppearanceModel, onApply: @escaping (NativeAppearancePreferences) -> Void = { _ in }) {
        _model = StateObject(wrappedValue: model); self.onApply = onApply
    }

    var body: some View {
        List {
            if let error = model.error {
                DesignSettingsSection {
                    DesignSettingsErrorRow(title: "Preferences not saved", message: error, retry: { Task { await model.reload() } })
                }
            }
            DesignSettingsSection(title: "Palette") {
                paletteGrid.designSettingsBareRow(EdgeInsets(top: 0, leading: 20, bottom: 4, trailing: 20))
            }
            DesignSettingsSection(footer: "Match system is stored on this device and follows this iPhone even when a palette is saved. Turning it off restores the chosen palette. Palette, accent and reading settings are saved for every Michi client when you save.") {
                DesignSettingsToggle(title: "Match system appearance", subtitle: systemSubtitle, isOn: matchSystem)
                if appearance != "system" && !paletteChosen {
                    DesignSettingsSegmented(selection: $appearance, options: [
                        DesignSettingsOption(value: "light", label: "Light"),
                        DesignSettingsOption(value: "dark", label: "Dark")
                    ], accessibilityTitle: "Appearance")
                }
            }
            DesignSettingsSection(title: "Accent", footer: "Accent applies to the \(designSettingsPaletteName(model.draft.palette)) palette.") {
                accentSwatches
                if !moreAccentOptions.isEmpty { moreColorsMenu }
            }
            DesignSettingsSection(title: "Reading", footer: "These settings are also saved for the web client. Serif uses the system serif face on iOS. Text keeps following Dynamic Type.") {
                DesignSettingsMenuPicker(title: "Reply font", selection: $model.draft.messageFont, options: designSettingsOptions([("Geist", "Geist"), ("Source Serif 4", "Serif")], current: model.draft.messageFont))
                sizeSlider(title: "Reply text size", value: $model.draft.messageSize)
                Text("A conversation can become a working landscape.")
                    .modifier(NativeTextSize(size: model.draft.messageSize, serif: model.draft.messageFont == "Source Serif 4"))
                    .foregroundStyle(tokens.fg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Preview")
                    .accessibilityValue("A conversation can become a working landscape.")
                LabeledContent("Composer text", value: pointLabel(model.draft.composerSize))
                sizeSlider(title: "Composer text size", value: $model.draft.composerSize)
                DesignSettingsToggle(title: "Wrap long code lines", isOn: $model.draft.codeWrap)
                DesignSettingsMenuPicker(title: "Code block style", selection: $model.draft.codeStyle, options: designSettingsOptions([("hairline", "Quiet label"), ("header", "Header")], current: model.draft.codeStyle))
                DesignSettingsToggle(title: "Full reading width", isOn: Binding(get: { model.draft.readingWidth == nil }, set: { model.draft.readingWidth = $0 ? nil : 676 }))
                if model.draft.readingWidth != nil {
                    LabeledContent("Maximum reading width", value: "\(Int(model.draft.readingWidth ?? 676)) pt")
                    Slider(value: Binding(get: { model.draft.readingWidth ?? 676 }, set: { model.draft.readingWidth = $0 }), in: 320...1280, step: 20)
                        .tint(tokens.accent)
                        .accessibilityLabel("Maximum reading width")
                        .accessibilityValue("\(Int(model.draft.readingWidth ?? 676)) points")
                }
            }
            DesignSettingsSection(title: "Conversation list") {
                DesignSettingsMenuPicker(title: "Row spacing", selection: $model.draft.sidebarDensity, options: designSettingsOptions([("compact", "Compact"), ("comfortable", "Comfortable"), ("airy", "Airy")], current: model.draft.sidebarDensity))
                DesignSettingsToggle(title: "Show last-active timestamps", isOn: $model.draft.showTimestamps)
                DesignSettingsStepper(title: "Threads per workspace", value: "\(model.draft.sidebarThreadLimit)", count: $model.draft.sidebarThreadLimit, range: 1...30)
            }
            DesignSettingsSection(title: "Chat behavior") {
                DesignSettingsToggle(title: "Follow-up suggestions", isOn: $model.draft.followUps)
                DesignSettingsToggle(title: "Kiro background titles", isOn: $model.draft.sidecarTitles)
                DesignSettingsToggle(title: "Show reasoning and plans", isOn: $model.draft.showThoughts)
                DesignSettingsStepper(title: "Quote preview lines", value: "\(model.draft.quoteLines)", count: $model.draft.quoteLines, range: 1...10)
            }
            DesignSettingsSection(title: "Notifications", footer: "All includes completion and approval notices. This preference does not grant iOS notification permission or set up push delivery.") {
                DesignSettingsMenuPicker(title: "Notification level", selection: $model.draft.notifications, options: designSettingsOptions(designSettingsNotificationChoices, current: model.draft.notifications))
            }
            DesignSettingsSection(title: "This device", footer: "Motion, Home recommendations, timestamps, thread count, reasoning visibility and quote preview length are stored on this device for this connection. The backend does not sync these fields.") {
                DesignSettingsToggle(title: "Reduce app motion", isOn: $model.draft.reduceMotion)
                DesignSettingsToggle(title: "Home recommendations", isOn: $model.draft.homeRecommendations)
            }
            DesignSettingsSection {
                DesignSettingsActionRow(title: model.saving ? "Saving…" : "Save preferences", busy: model.saving) { Task { await model.save() } }
                    .disabled(!model.ready || !model.dirty || model.saving || model.loading)
                DesignSettingsActionRow(title: "Discard changes", role: .cancel) { model.discardEdits() }
                    .disabled(!model.dirty || model.saving)
            }
        }
        .designSettingsList()
        .designSettingsTitle("Appearance")
        .disabled(model.saving)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.loading || model.saving)
                    .accessibilityLabel("Refresh preferences")
            }
            if model.dirty {
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.saving ? "Saving…" : "Save") { Task { await model.save() } }
                        .designSettingsProminentToolbarButton()
                        .disabled(!model.ready || model.saving || model.loading)
                        .accessibilityLabel(model.saving ? "Saving preferences" : "Save preferences")
                }
            }
        }
        .task { if !model.ready { await model.reload() } }
        .onChange(of: model.applied) { _, value in onApply(value) }
    }

    // MARK: Palette

    private var paletteIDs: [String] {
        let known = NativeAppearancePreferences.palettes
        return known.contains(model.draft.palette) ? known : known + [model.draft.palette]
    }

    private var paletteGrid: some View {
        let columns = dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        return LazyVGrid(columns: columns, spacing: 8) {
            ForEach(paletteIDs, id: \.self) { id in
                let preview = MichiTokens.named(id).withAccent(model.draft.accentOverrides[id])
                DesignPaletteCard(
                    name: NativeAppearancePreferences.palettes.contains(id) ? designSettingsPaletteName(id) : "Current: " + id,
                    tone: preview.usesDarkCanvas ? "Dark" : "Light",
                    preview: preview,
                    selected: effectivePalette == id
                ) { model.draft.selectPalette(id) }
            }
        }
    }

    /// A saved palette, or one picked here and not yet saved.
    private var paletteChosen: Bool {
        model.draft.paletteExplicit || model.draft.palette != model.applied.palette
    }

    /// The pinned card when a palette is chosen; otherwise the canvas on
    /// screen (Bone in Light, Monokai in Dark).
    private var effectivePalette: String {
        if paletteChosen { return model.draft.palette }
        return NativeAppearancePreferences.palettes.first { MichiTokens.named($0).bg == tokens.bg } ?? model.draft.palette
    }

    private var matchSystem: Binding<Bool> {
        Binding(
            get: { appearance == "system" },
            set: { isOn in
                if isOn {
                    appearance = "system"
                } else {
                    appearance = NativeAppearancePreferences.appearanceRestoredFromMatch(
                        palette: model.draft.palette,
                        paletteExplicit: paletteChosen,
                        canvasIsDark: tokens.usesDarkCanvas
                    )
                }
            }
        )
    }

    private var systemSubtitle: String {
        if appearance == "system" {
            let light = NativeAppearancePreferences.resolvedPalette(palette: model.draft.palette, paletteExplicit: model.draft.paletteExplicit, appearance: "system", systemIsLight: true)
            let dark = NativeAppearancePreferences.resolvedPalette(palette: model.draft.palette, paletteExplicit: model.draft.paletteExplicit, appearance: "system", systemIsLight: false)
            return "Light Mode uses \(designSettingsPaletteName(light)) · Dark Mode uses \(designSettingsPaletteName(dark))"
        }
        if paletteChosen {
            let tone = MichiTokens.named(model.draft.palette).usesDarkCanvas ? "dark" : "light"
            return "\(designSettingsPaletteName(model.draft.palette)) is chosen, so it keeps its \(tone) look"
        }
        let resolved = NativeAppearancePreferences.resolvedPalette(palette: model.draft.palette, paletteExplicit: false, appearance: appearance, systemIsLight: appearance == "light")
        return "Always uses " + designSettingsPaletteName(resolved)
    }

    // MARK: Accent

    private static let legacyAccents: [(String, String)] = [
        ("Rust", "#b8451f"), ("Ink", "#1a4d8f"), ("Moss", "#2f6b4e"), ("Violet", "#6d4aa8"),
        ("Amber", "#c48300"), ("Red", "#a8261a"), ("Mint", "#58c6a5"), ("Green", "#10a37f"),
        ("Clay", "#c15f3c"), ("Cyan", "#00d9ff"), ("Pink", "#ff2d95")
    ]

    private static func paletteAccents(_ palette: String) -> [(String, String)] {
        switch palette {
        case "monokai": return [("Cyan", "#66d9ef"), ("Green", "#a6e22e"), ("Yellow", "#e6db74"), ("Purple", "#ae81ff"), ("Orange", "#fd971f"), ("Pink", "#f92672")]
        case "gruvbox": return [("Aqua", "#83a598"), ("Green", "#b8bb26"), ("Yellow", "#fabd2f"), ("Purple", "#d3869b"), ("Orange", "#fe8019"), ("Red", "#fb4934")]
        case "slate": return [("Ink", "#1a4d8f"), ("Rust", "#b8451f"), ("Moss", "#2f6b4e"), ("Violet", "#6d4aa8"), ("Amber", "#c48300"), ("Red", "#a8261a")]
        default: return [("Rust", "#b8451f"), ("Ink", "#1a4d8f"), ("Moss", "#2f6b4e"), ("Violet", "#6d4aa8"), ("Amber", "#c48300"), ("Red", "#a8261a")]
        }
    }

    /// The palette's own default, computed by the model rather than restated here.
    private var defaultAccent: String {
        var plain = model.draft
        plain.accentOverrides.removeValue(forKey: plain.palette)
        return plain.accentHex.lowercased()
    }

    private var mainAccents: [(String, String)] {
        let palette = Self.paletteAccents(model.draft.palette)
        let defaultName = palette.first { $0.1 == defaultAccent }?.0 ?? "Default"
        return [(defaultName, defaultAccent)] + palette.filter { $0.1 != defaultAccent }.prefix(5)
    }

    private var moreAccents: [(String, String)] {
        let shown = Set(mainAccents.map(\.1))
        return Self.legacyAccents.filter { !shown.contains($0.1) }
    }

    /// A saved override that is in neither list, e.g. set by another client.
    private var customAccent: String? {
        guard let custom = model.draft.accentOverrides[model.draft.palette]?.lowercased(),
              NativeAppearancePreferences.isHexColor(custom) else { return nil }
        let known = Set(mainAccents.map(\.1) + Self.legacyAccents.map(\.1))
        return known.contains(custom) ? nil : custom
    }

    private var moreAccentOptions: [DesignSettingsOption<String>] {
        var options = moreAccents.map { DesignSettingsOption(value: $0.1, label: $0.0) }
        if let customAccent { options.insert(DesignSettingsOption(value: customAccent, label: "Custom " + customAccent), at: 0) }
        return options
    }

    private var moreColorsMenu: some View {
        let current = model.draft.accentHex.lowercased()
        let selected = moreAccentOptions.first { $0.value == current }?.label ?? ""
        return Menu {
            ForEach(moreAccentOptions) { option in
                Button { selectAccent(option.value) } label: {
                    if option.value == current { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
                }
            }
        } label: {
            HStack(spacing: 12) {
                Text("More colors").font(MichiFont.row).foregroundStyle(tokens.fg)
                Spacer(minLength: 12)
                if !selected.isEmpty {
                    Circle().fill(Color(hexString: current)).frame(width: 12, height: 12).accessibilityHidden(true)
                    Text(selected).font(DesignSettingsFont.trail).foregroundStyle(tokens.muted)
                }
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .medium)).foregroundStyle(tokens.muted)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("More accent colors")
        .accessibilityValue(selected)
    }

    private func selectAccent(_ hex: String) {
        if hex == defaultAccent { model.draft.accentOverrides.removeValue(forKey: model.draft.palette) }
        else { model.draft.accentOverrides[model.draft.palette] = hex }
    }

    private var accentSwatches: some View {
        HStack(spacing: 0) {
            ForEach(Array(mainAccents.enumerated()), id: \.offset) { index, accent in
                if index > 0 { Spacer(minLength: 2) }
                accentSwatch(name: accent.0, hex: accent.1, isDefault: index == 0)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Accent")
    }

    private func accentSwatch(name: String, hex: String, isDefault: Bool) -> some View {
        let selected = model.draft.accentHex.lowercased() == hex
        return Button { selectAccent(hex) } label: {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(Color(hexString: hex))
                .frame(width: 32, height: 32)
                .overlay {
                    if selected {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(tokens.fg, lineWidth: 1.5)
                            .padding(-3.5)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(isDefault ? "\(name) accent, palette default" : "\(name) accent")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: Reading

    private func sizeSlider(title: String, value: Binding<Double>) -> some View {
        HStack(spacing: 12) {
            Text("A").font(MichiFont.sans(size: 13, relativeTo: .footnote)).foregroundStyle(tokens.mid).accessibilityHidden(true)
            Slider(value: value, in: 11...28, step: 0.5)
                .tint(tokens.accent)
                .accessibilityLabel(title)
                .accessibilityValue(pointLabel(value.wrappedValue))
            Text("A").font(MichiFont.sans(size: 22, relativeTo: .title2)).foregroundStyle(tokens.mid).accessibilityHidden(true)
        }
        .frame(minHeight: 44)
    }

    private func pointLabel(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...1))) + " pt"
    }
}

private struct DesignPaletteCard: View {
    let name: String
    let tone: String
    let preview: MichiTokens
    let selected: Bool
    let action: () -> Void
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                GeometryReader { proxy in
                    VStack(alignment: .leading, spacing: 6) {
                        Capsule().fill(preview.accent).frame(width: proxy.size.width * 0.4, height: 8)
                        Capsule().fill(preview.line).frame(width: proxy.size.width * 0.85, height: 8)
                        Capsule().fill(preview.alt).frame(width: proxy.size.width * 0.65, height: 8)
                    }
                }
                .padding(10)
                .frame(height: 64)
                .frame(maxWidth: .infinity)
                .background(preview.bg)
                HStack(spacing: 4) {
                    Text(name)
                        .font(MichiFont.mono(size: 12, relativeTo: .caption, weight: .medium))
                        .foregroundStyle(tokens.fg)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(tone)
                        .font(MichiFont.mono(size: 11, relativeTo: .caption2))
                        .tracking(0.66)
                        .textCase(.uppercase)
                        .foregroundStyle(tokens.muted)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(minHeight: 32)
                .overlay(alignment: .top) { Rectangle().fill(tokens.line).frame(height: 1) }
            }
            .background(tokens.surface)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(selected ? tokens.accent : tokens.line, lineWidth: selected ? 1.5 : 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.borderless)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) palette, \(tone.lowercased())")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

func nativeAppearanceColor(_ hex: String) -> Color {
    guard NativeAppearancePreferences.isHexColor(hex), let number = UInt(hex.dropFirst(), radix: 16) else { return .accentColor }
    return Color(red: Double((number >> 16) & 255) / 255, green: Double((number >> 8) & 255) / 255, blue: Double(number & 255) / 255)
}

/// Uses a scaled baseline so a changed preference and Dynamic Type compose.
/// "Geist" renders the bundled Geist; "Source Serif 4" uses the system serif.
struct NativeTextSize: ViewModifier {
    let size: Double
    var serif = false
    @ScaledMetric(relativeTo: .body) private var baseline = 16.0
    func body(content: Content) -> some View {
        let points = baseline * size / 16
        let font: Font = serif ? Font.system(size: points, design: .serif) : Font.custom(MichiFont.sansName(.regular), fixedSize: points)
        return content.font(font)
    }
}
