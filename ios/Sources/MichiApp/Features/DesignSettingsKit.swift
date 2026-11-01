import SwiftUI
import MichiCore

// Shared pieces for the Settings, Scheduled and Agents screens (ios/Design
// 23–27, 33, 44): full-bleed rows on the canvas, 1 pt `sep` hairlines,
// uppercase Geist captions, Geist Mono trailing values, small corners and
// semantic colors. Chrome stays system Liquid Glass with iOS 17–25 fallbacks.

enum DesignSettingsMetrics {
    static let rowInsets = EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20)
    static let bareInsets = EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20)
}

enum DesignSettingsFont {
    static var trail: Font { MichiFont.mono(size: 13, relativeTo: .footnote) }
    static var note: Font { MichiFont.rowSecondary }
    static var footnote: Font { MichiFont.sans(size: 12, relativeTo: .caption) }
    static var title: Font { MichiFont.sans(size: 17, relativeTo: .headline, weight: .semibold) }
    static var detailTitle: Font { MichiFont.sans(size: 26, relativeTo: .title, weight: .semibold) }
}

enum DesignSettingsTone {
    case plain, muted, ok, bad, run, warn, accent
}

extension MichiTokens {
    func designSettingsColor(_ tone: DesignSettingsTone) -> Color {
        switch tone {
        case .plain: return mid
        case .muted: return muted
        case .ok: return digest
        case .bad: return dangerText
        case .run, .warn: return selectInk
        case .accent: return accentText
        }
    }
}

// MARK: - List chrome

private struct DesignSettingsListModifier: ViewModifier {
    var onSheet: Bool
    @Environment(\.michiTokens) private var tokens

    func body(content: Content) -> some View {
        content
            // `.grouped` keeps a hairline above and below each section
            // without inset-grouped cards; rows are transparent cells.
            .listStyle(.grouped)
            .scrollContentBackground(.hidden)
            .background(onSheet ? Color.clear : tokens.bg)
            .listSectionSpacing(.compact)
            .environment(\.defaultMinListRowHeight, 48)
            .font(MichiFont.row)
            .labeledContentStyle(DesignSettingsLabeledContentStyle())
            .michiScrollEdge()
    }
}

private struct DesignSettingsBareRow: ViewModifier {
    var insets: EdgeInsets
    func body(content: Content) -> some View {
        content
            .listRowInsets(insets)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }
}

private struct DesignSettingsNavigationTitle: ViewModifier {
    let title: String
    let revealed: Bool
    @Environment(\.michiTokens) private var tokens

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title)
                        .font(DesignSettingsFont.title)
                        .foregroundStyle(tokens.fg)
                        .lineLimit(1)
                        .opacity(revealed ? 1 : 0)
                        .accessibilityHidden(!revealed)
                        .animation(.easeInOut(duration: 0.18), value: revealed)
                }
            }
            .michiToolbarBackground()
    }
}

private struct DesignSettingsProminentToolbarButton: ViewModifier {
    @Environment(\.michiTokens) private var tokens
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glassProminent).tint(tokens.accent).foregroundStyle(tokens.accentInk)
        } else {
            content.tint(tokens.accent)
        }
    }
}

private struct DesignSettingsSheetChrome: ViewModifier {
    @Environment(\.michiTokens) private var tokens
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.presentationDragIndicator(.visible)
        } else {
            content
                .presentationBackground(tokens.surface)
                .presentationDragIndicator(.visible)
        }
    }
}

extension View {
    /// Flat hairline list. `onSheet` leaves the sheet's glass or material visible.
    func designSettingsList(onSheet: Bool = false) -> some View {
        modifier(DesignSettingsListModifier(onSheet: onSheet))
    }

    /// A list row without its cell background or separators (titles, cards, chip rows).
    func designSettingsBareRow(_ insets: EdgeInsets = DesignSettingsMetrics.bareInsets) -> some View {
        modifier(DesignSettingsBareRow(insets: insets))
    }

    /// Inline Geist title. `revealed` hides it while a large title row is on screen.
    func designSettingsTitle(_ title: String, revealed: Bool = true) -> some View {
        modifier(DesignSettingsNavigationTitle(title: title, revealed: revealed))
    }

    /// Tinted glass for the one primary toolbar action; tinted text before iOS 26.
    func designSettingsProminentToolbarButton() -> some View {
        modifier(DesignSettingsProminentToolbarButton())
    }

    /// Floating glass sheet on iOS 26, surface-colored sheet before it.
    func designSettingsSheetChrome() -> some View {
        modifier(DesignSettingsSheetChrome())
    }
}

// MARK: - Sections

struct DesignSettingsSection<Content: View>: View {
    var title: String? = nil
    var count: String? = nil
    var footer: String? = nil
    @ViewBuilder var content: () -> Content
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Section {
            Group { content() }
                .listRowBackground(Color.clear)
                .listRowSeparatorTint(tokens.sep)
                .listRowInsets(DesignSettingsMetrics.rowInsets)
        } header: {
            if let title { DesignSettingsCaption(title: title, count: count) }
        } footer: {
            if let footer { DesignSettingsFootnote(text: footer) }
        }
    }
}

struct DesignSettingsCaption: View {
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
            Spacer(minLength: 8)
            if let count {
                Text(count)
                    .font(MichiFont.meta)
                    .textCase(nil)
                    .foregroundStyle(tokens.muted)
            }
        }
        .listRowInsets(EdgeInsets(top: 18, leading: 20, bottom: 8, trailing: 20))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

struct DesignSettingsFootnote: View {
    let text: String
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Text(text)
            .font(DesignSettingsFont.footnote)
            .foregroundStyle(tokens.muted)
            .textCase(nil)
            .fixedSize(horizontal: false, vertical: true)
            .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 4, trailing: 20))
    }
}

/// Large Geist title as the first list row; reports visibility so the inline
/// title appears only once it scrolls away.
struct DesignSettingsTitleRow<Accessory: View>: View {
    let title: String
    @Binding var visible: Bool
    @ViewBuilder var accessory: () -> Accessory
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(MichiFont.largeTitle)
                .tracking(-0.6)
                .foregroundStyle(tokens.fg)
                .accessibilityAddTraits(.isHeader)
            accessory()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .designSettingsBareRow(EdgeInsets(top: 4, leading: 20, bottom: 6, trailing: 20))
        .onAppear { visible = true }
        .onDisappear { visible = false }
    }
}

extension DesignSettingsTitleRow where Accessory == EmptyView {
    init(title: String, visible: Binding<Bool>) {
        self.init(title: title, visible: visible, accessory: { EmptyView() })
    }
}

struct DesignSettingsSubtitle: View {
    let text: String
    var systemImage: String? = nil
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage).font(.system(size: 11, weight: .regular)).accessibilityHidden(true)
            }
            Text(text)
        }
        .font(MichiFont.mono(size: 12, relativeTo: .caption))
        .foregroundStyle(tokens.muted)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Rows

struct DesignSettingsLabeledContentStyle: LabeledContentStyle {
    func makeBody(configuration: Configuration) -> some View {
        DesignSettingsLabeledRow(label: configuration.label, content: configuration.content)
    }
}

private struct DesignSettingsLabeledRow<Label: View, Content: View>: View {
    let label: Label
    let content: Content
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            label
                .font(MichiFont.row)
                .foregroundStyle(tokens.fg)
            Spacer(minLength: 12)
            content
                .font(DesignSettingsFont.trail)
                .foregroundStyle(tokens.muted)
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Icon, title and Mono trail for navigation rows; the List draws the chevron.
struct DesignSettingsNavLabel: View {
    let title: String
    var systemImage: String? = nil
    var subtitle: String? = nil
    var trail: String? = nil
    var titleColor: Color? = nil
    var trailTone: DesignSettingsTone = .muted
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(spacing: 12) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(tokens.mid)
                    .frame(width: 24)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(MichiFont.row)
                    .foregroundStyle(titleColor ?? tokens.fg)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(DesignSettingsFont.note)
                        .foregroundStyle(tokens.muted)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if let trail, !trail.isEmpty {
                Text(trail)
                    .font(DesignSettingsFont.trail)
                    .foregroundStyle(tokens.designSettingsColor(trailTone))
                    .lineLimit(1)
            }
        }
        .frame(minHeight: 28)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct DesignSettingsNote: View {
    let text: String
    var tone: DesignSettingsTone = .muted
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Text(text)
            .font(DesignSettingsFont.note)
            .foregroundStyle(tokens.designSettingsColor(tone))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Mono status line with the web's semantic glyphs: green check, pink triangle,
/// yellow arc while running, cyan dot when it needs you.
struct DesignSettingsStatusLine: View {
    let text: String
    var tone: DesignSettingsTone = .muted
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            glyph.accessibilityHidden(true)
            Text(text)
                .font(MichiFont.meta)
                .foregroundStyle(tokens.designSettingsColor(tone))
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var glyph: some View {
        switch tone {
        case .ok:
            Image(systemName: "checkmark.circle").font(.system(size: 11, weight: .medium)).foregroundStyle(tokens.digest)
        case .bad:
            Image(systemName: "exclamationmark.triangle").font(.system(size: 11, weight: .medium)).foregroundStyle(tokens.dangerText)
        case .warn:
            Image(systemName: "exclamationmark.circle").font(.system(size: 11, weight: .medium)).foregroundStyle(tokens.selectInk)
        case .run:
            MichiThreadStateDot(state: .streaming)
        case .accent:
            MichiThreadStateDot(state: .waiting)
        case .plain, .muted:
            EmptyView()
        }
    }
}

struct DesignSettingsErrorRow: View {
    let title: String
    let message: String
    var retry: (() -> Void)? = nil
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(tokens.dangerText)
                    .accessibilityHidden(true)
                Text(title)
                    .font(MichiFont.rowTitle)
                    .foregroundStyle(tokens.fg)
            }
            Text(message)
                .font(DesignSettingsFont.note)
                .foregroundStyle(tokens.muted)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button(action: retry) {
                    Text("Try Again")
                        .font(MichiFont.sans(size: 13, relativeTo: .footnote, weight: .semibold))
                        .foregroundStyle(tokens.accentText)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

struct DesignSettingsLoading: View {
    var message: String
    var inline = false
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(spacing: 12) {
            ProgressView().tint(tokens.muted)
            Text(message)
                .font(MichiFont.meta)
                .foregroundStyle(tokens.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: inline ? nil : .infinity)
        .padding(.vertical, inline ? 20 : 0)
        .background(inline ? Color.clear : tokens.bg)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }
}

/// A full-width text action. Accent for ordinary actions, danger for destructive.
struct DesignSettingsActionRow: View {
    let title: String
    var systemImage: String? = nil
    var role: ButtonRole? = nil
    var busy = false
    let action: () -> Void
    @Environment(\.michiTokens) private var tokens
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(role: role, action: action) {
            HStack(spacing: 12) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 16, weight: .regular))
                        .frame(width: 24)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(MichiFont.row)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Spacer(minLength: 8)
                if busy { ProgressView().controlSize(.small) }
            }
            .foregroundStyle(role == .destructive ? tokens.dangerText : tokens.accentText)
            .opacity(isEnabled ? 1 : 0.45)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(title)
    }
}

struct DesignSettingsOption<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var id: Value { value }
}

/// String options plus the stored value when it is not one of them, so an
/// unknown saved setting is shown and kept rather than silently replaced.
func designSettingsOptions(_ base: [(String, String)], current: String) -> [DesignSettingsOption<String>] {
    var options = base.map { DesignSettingsOption(value: $0.0, label: $0.1) }
    if !base.contains(where: { $0.0 == current }) {
        options.append(DesignSettingsOption(value: current, label: current.isEmpty ? "None" : "Current: " + current))
    }
    return options
}

/// Title on the left, the current choice in Mono with a chevron pair on the
/// right; the system menu shows the checkmarked list.
struct DesignSettingsMenuPicker<Value: Hashable>: View {
    let title: String
    @Binding var selection: Value
    let options: [DesignSettingsOption<Value>]
    var systemImage: String? = nil
    @Environment(\.michiTokens) private var tokens
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Menu {
            Picker(title, selection: $selection) {
                ForEach(options) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 12) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 17, weight: .regular))
                        .foregroundStyle(tokens.mid)
                        .frame(width: 24)
                }
                Text(title)
                    .font(MichiFont.row)
                    .foregroundStyle(tokens.fg)
                    .multilineTextAlignment(.leading)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Spacer(minLength: 12)
                Text(currentLabel)
                    .font(DesignSettingsFont.trail)
                    .foregroundStyle(tokens.muted)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(tokens.muted)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.45)
        }
        .accessibilityLabel(title)
        .accessibilityValue(currentLabel)
    }

    private var currentLabel: String { options.first { $0.value == selection }?.label ?? "" }
}

struct DesignSettingsToggle: View {
    let title: String
    var subtitle: String? = nil
    @Binding var isOn: Bool
    @Environment(\.michiTokens) private var tokens
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(MichiFont.row)
                    .foregroundStyle(tokens.fg)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(DesignSettingsFont.note)
                        .foregroundStyle(tokens.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .opacity(isEnabled ? 1 : 0.45)
        }
        .tint(tokens.accent)
        .accessibilityLabel(title)
        .accessibilityHint(subtitle ?? "")
    }
}

struct DesignSettingsStepper: View {
    let title: String
    let value: String
    @Binding var count: Int
    let range: ClosedRange<Int>
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Stepper(value: $count, in: range) {
            HStack(spacing: 8) {
                Text(title).font(MichiFont.row).foregroundStyle(tokens.fg)
                Spacer(minLength: 8)
                Text(value).font(DesignSettingsFont.trail).foregroundStyle(tokens.muted)
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue(value)
    }
}

struct DesignSettingsFieldRow: View {
    let title: String
    let prompt: String
    @Binding var text: String
    var secure = false
    var mono = true
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .font(MichiFont.row)
                .foregroundStyle(tokens.fg)
                .layoutPriority(1)
            Group {
                if secure {
                    SecureField(prompt, text: $text)
                } else {
                    TextField(prompt, text: $text)
                }
            }
            .font(mono ? DesignSettingsFont.trail : MichiFont.row)
            .foregroundStyle(tokens.fg)
            .multilineTextAlignment(.trailing)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel(title)
        }
        .frame(minHeight: 28)
    }
}

/// Michi's glass segmented control: uppercase Mono labels in a soft track,
/// with a glass thumb on iOS 26 and a raised fill before it.
struct DesignSettingsSegmented<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [DesignSettingsOption<Value>]
    let accessibilityTitle: String
    @Namespace private var thumb
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options) { option in
                let selected = option.value == selection
                Button {
                    withAnimation(.snappy(duration: 0.24)) { selection = option.value }
                } label: {
                    Text(option.label)
                        .font(MichiFont.mono(size: 12, relativeTo: .caption, weight: .medium))
                        .tracking(0.72)
                        .textCase(.uppercase)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(selected ? tokens.fg : tokens.mid)
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        .background {
                            if selected {
                                DesignSettingsSegmentThumb().matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(option.label)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
        .padding(3)
        .background(tokens.fg.opacity(tokens.usesDarkCanvas ? 0.06 : 0.05), in: Capsule())
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityTitle)
    }
}

private struct DesignSettingsSegmentThumb: View {
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        if #available(iOS 26.0, *) {
            Capsule()
                .fill(tokens.fg.opacity(tokens.usesDarkCanvas ? 0.08 : 0.02))
                .glassEffect(.regular, in: Capsule())
        } else {
            Capsule()
                .fill(tokens.usesDarkCanvas ? tokens.alt2 : tokens.surface)
                .shadow(color: .black.opacity(0.18), radius: 4, y: 1)
        }
    }
}

struct DesignSettingsChipLabel: View {
    let title: String
    var selected = false
    var systemImage: String? = nil
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(spacing: 4) {
            Text(title).font(MichiFont.chip)
            if let systemImage {
                Image(systemName: systemImage).font(.system(size: 9, weight: .semibold)).accessibilityHidden(true)
            }
        }
        .foregroundStyle(selected ? tokens.accentText : tokens.mid)
        .padding(.horizontal, 10)
        .frame(minWidth: 44, minHeight: 30)
        .background(selected ? tokens.accentF : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(selected ? tokens.accent.opacity(0.35) : tokens.line, lineWidth: 1)
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }
}

struct DesignSettingsFilterChip: View {
    let title: String
    var selected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            DesignSettingsChipLabel(title: title, selected: selected)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

struct DesignSettingsPromptBox: View {
    let text: String
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Text(text.isEmpty ? "No prompt" : text)
            .font(MichiFont.sans(size: 15, relativeTo: .body))
            .lineSpacing(4)
            .foregroundStyle(text.isEmpty ? tokens.muted : tokens.fg)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(tokens.bgDeep, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1)
            }
    }
}

/// Observes an optional store for rows that need its live state.
struct DesignSettingsStoreReader<Content: View>: View {
    @ObservedObject var store: MichiStore
    @ViewBuilder var content: (MichiStore) -> Content
    var body: some View { content(store) }
}

/// Searchable IANA time zone list for schedules. Unknown saved zones stay listed.
struct DesignSettingsTimeZoneList: View {
    @Binding var selection: String
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens

    private var zones: [String] {
        var all = TimeZone.knownTimeZoneIdentifiers
        if !selection.isEmpty, !all.contains(selection) { all.insert(selection, at: 0) }
        let device = TimeZone.current.identifier
        if let index = all.firstIndex(of: device), index > 0 { all.remove(at: index); all.insert(device, at: 0) }
        guard !query.isEmpty else { return all }
        return all.filter { $0.localizedCaseInsensitiveContains(query) || $0.replacingOccurrences(of: "_", with: " ").localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        List {
            DesignSettingsSection(footer: "Times in this schedule are evaluated in the zone you choose, including daylight-saving changes.") {
                ForEach(zones, id: \.self) { zone in
                    Button {
                        selection = zone
                        dismiss()
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(zone.replacingOccurrences(of: "_", with: " "))
                                    .font(MichiFont.row)
                                    .foregroundStyle(tokens.fg)
                                if zone == TimeZone.current.identifier {
                                    Text("This device").font(DesignSettingsFont.note).foregroundStyle(tokens.muted)
                                }
                            }
                            Spacer()
                            if zone == selection {
                                Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(tokens.accentText)
                            }
                        }
                        .frame(minHeight: 32)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityAddTraits(zone == selection ? [.isSelected] : [])
                }
            }
        }
        .designSettingsList()
        .designSettingsTitle("Time zone")
        .searchable(text: $query, prompt: "City or region")
    }
}

// MARK: - Formatting

func designSettingsClock(hour: Int, minute: Int) -> String {
    let date = Calendar.current.date(from: DateComponents(hour: hour, minute: minute)) ?? Date()
    return date.formatted(date: .omitted, time: .shortened)
}

/// "Today 8:00 AM", "Yesterday 8:00 AM", otherwise a short date and time.
func designSettingsDayTime(_ millis: Double?) -> String {
    guard let date = featureDate(millis) else { return "—" }
    let calendar = Calendar.current
    let time = date.formatted(date: .omitted, time: .shortened)
    if calendar.isDateInToday(date) { return "Today \(time)" }
    if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
    if calendar.isDateInTomorrow(date) { return "Tomorrow \(time)" }
    return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
}

/// Section title for a run list grouped by day.
func designSettingsDayTitle(_ millis: Double?) -> String {
    guard let date = featureDate(millis) else { return "Earlier" }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "Today" }
    if calendar.isDateInYesterday(date) { return "Yesterday" }
    return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
}

struct DesignSettingsDayGroup: Identifiable {
    let id: String
    let title: String
    let items: [JSONValue]
}

/// Consecutive items that fall on the same day, in their existing order.
func designSettingsDayGroups(_ items: [JSONValue], date: (JSONValue) -> Double?) -> [DesignSettingsDayGroup] {
    var titles: [String] = []
    var buckets: [[JSONValue]] = []
    for item in items {
        let title = designSettingsDayTitle(date(item))
        if titles.last == title { buckets[buckets.count - 1].append(item) }
        else { titles.append(title); buckets.append([item]) }
    }
    return titles.indices.map { DesignSettingsDayGroup(id: "\($0)-\(titles[$0])", title: titles[$0], items: buckets[$0]) }
}

func designSettingsRunStatusLabel(_ status: String) -> String {
    switch status {
    case "succeeded": return "Succeeded"
    case "failed": return "Failed"
    case "running": return "Running"
    case "cancelled": return "Cancelled"
    case "timed_out": return "Timed out"
    case "interrupted": return "Interrupted"
    case "completed": return "Done"
    case "waiting": return "Needs you"
    case "": return "Unknown"
    default: return status.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

/// Plain-language schedule from the stored definition; unsupported cron
/// expressions are shown verbatim. A zone other than this device's is named.
func designSettingsScheduleText(_ schedule: JSONValue) -> String {
    switch schedule["kind"].stringValue {
    case "every":
        let seconds = schedule["everySeconds"].intValue
        if seconds > 0, seconds % 86_400 == 0 { let days = seconds / 86_400; return days == 1 ? "Every day" : "Every \(days) days" }
        if seconds > 0, seconds % 3600 == 0 { let hours = seconds / 3600; return hours == 1 ? "Every hour" : "Every \(hours) hours" }
        let minutes = max(1, seconds / 60)
        return minutes == 1 ? "Every minute" : "Every \(minutes) minutes"
    case "at":
        return "Once · " + designSettingsDayTime(schedule["at"].featureOptionalNumber)
    case "cron":
        let expression = schedule["expression"].stringValue
        var text: String
        if let parsed = featureSupportedCron(expression) {
            let clock = designSettingsClock(hour: parsed.hour, minute: parsed.minute)
            if parsed.days == "*" {
                text = "Every day at \(clock)"
            } else if parsed.days == "1-5" {
                text = "Weekdays at \(clock)"
            } else {
                let days = parsed.days.split(separator: ",").compactMap { Int($0) }.filter { (0...6).contains($0) }
                    .sorted { ($0 + 6) % 7 < ($1 + 6) % 7 }
                if days.count == 1 {
                    text = "\(Calendar.current.weekdaySymbols[days[0]])s at \(clock)"
                } else {
                    let short = Calendar.current.shortWeekdaySymbols
                    text = days.map { short[$0] }.joined(separator: ", ") + " at \(clock)"
                }
            }
        } else {
            text = "Cron " + expression
        }
        if let zone = schedule["timezone"].optionalString, !zone.isEmpty, zone != TimeZone.current.identifier {
            text += " (\(zone.replacingOccurrences(of: "_", with: " ")))"
        }
        return text
    default:
        return "Schedule"
    }
}
