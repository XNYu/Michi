import Foundation
import Combine
import MichiCore

struct NativeAppearancePreferences: Equatable {
    var palette = "monokai"
    /// True only when the backend (or a user save) actually named a palette.
    /// The default string `"monokai"` is also used for an unset preference, so
    /// this flag is the only way to tell them apart.
    var paletteExplicit = false
    var accentOverrides: [String: String] = [:]
    var uiFont = "Geist"
    var messageFont = "Geist"
    var messageSize = 16.0
    var composerSize = 16.0
    var sidebarDensity = "comfortable"
    var sidebarInset = 2.0
    var codeStyle = "hairline"
    var codeWrap = false
    var terminalDensity = "compact"
    var readingWidth: Double? = 676
    var notifications = "all"
    var followUps = true
    var sidecarTitles = false
    // These are not accepted by the backend /prefs allowlist.
    var reduceMotion = false
    var showTimestamps = false
    var homeRecommendations = true
    var showThoughts = true
    var quoteLines = 2
    var sidebarThreadLimit = 5

    static let palettes = ["bone", "slate", "monokai", "gruvbox"]
    var usesDarkPalette: Bool { palette == "monokai" || palette == "gruvbox" }

    /// Deterministic palette choice. Precedence:
    /// 1. Local Match system (`appearance == "system"`) follows the live OS
    ///    (light Bone, dark Monokai), even when a palette is already saved.
    /// 2. An explicit saved palette wins when Match system is off
    ///    (Bone stays Bone in system dark).
    /// 3. Unset + Light → Bone; unset + Dark → Monokai.
    /// Device chrome (`michi.appearance`) uses an unset fallback of Dark so a
    /// first launch is Monokai. A stored `"system"` value is an explicit choice
    /// and does not clear `terminalPalette`.
    static func resolvedPalette(palette: String, paletteExplicit: Bool, appearance: String, systemIsLight: Bool) -> String {
        if appearance == "system" { return systemIsLight ? "bone" : "monokai" }
        if paletteExplicit { return palette }
        if appearance == "light" { return "bone" }
        if appearance == "dark" { return "monokai" }
        return systemIsLight ? "bone" : "monokai"
    }

    /// `nil` means follow the system. Match system is always `nil`, including
    /// when a palette is saved. Otherwise an explicit palette forces a matching
    /// scheme so a light chrome cannot sit on a dark canvas (or the reverse).
    static func preferredColorScheme(palette: String, paletteExplicit: Bool, appearance: String) -> String? {
        if appearance == "system" { return nil }
        if paletteExplicit {
            if palette == "bone" || palette == "slate" { return "light" }
            if palette == "monokai" || palette == "gruvbox" { return "dark" }
            return nil
        }
        if appearance == "light" || appearance == "dark" { return appearance }
        return nil
    }

    /// Pins this palette as the saved choice. Tapping the current default
    /// Monokai is a real change (`paletteExplicit` flips) even though the
    /// display string was already `"monokai"`.
    mutating func selectPalette(_ id: String) {
        palette = id
        paletteExplicit = true
    }

    /// Chrome stored when Match system is turned off: the chosen palette's
    /// own light/dark, or the canvas currently on screen if none is saved.
    static func appearanceRestoredFromMatch(palette: String, paletteExplicit: Bool, canvasIsDark: Bool) -> String {
        if paletteExplicit {
            return (palette == "monokai" || palette == "gruvbox") ? "dark" : "light"
        }
        return canvasIsDark ? "dark" : "light"
    }
    var accentHex: String {
        if let custom = accentOverrides[palette], Self.isHexColor(custom) { return custom }
        return ["bone": "#b8451f", "slate": "#1a4d8f", "monokai": "#66d9ef", "gruvbox": "#83a598"][palette] ?? "#b8451f"
    }
    static func isHexColor(_ value: String) -> Bool {
        value.count == 7 && value.hasPrefix("#") && value.dropFirst().allSatisfy { $0.isASCII && $0.isHexDigit }
    }
    init() {}
    init(remote: JSONValue, local: JSONValue = .null) {
        let defaults = NativeAppearancePreferences()
        if let saved = remote["terminalPalette"].optionalString, !saved.isEmpty {
            palette = saved
            paletteExplicit = true
        } else {
            palette = defaults.palette
            paletteExplicit = false
        }
        accentOverrides = remote["terminalAccentOverrides"].objectValue.compactMapValues(\.optionalString)
        uiFont = remote["uiFont"].optionalString ?? defaults.uiFont
        messageFont = remote["messageFont"].optionalString ?? defaults.messageFont
        messageSize = Self.number(remote["messageFontSize"], default: defaults.messageSize, range: 11...28)
        composerSize = Self.number(remote["composerFontSize"], default: defaults.composerSize, range: 11...28)
        sidebarDensity = remote["sidebarDensity"].optionalString ?? defaults.sidebarDensity
        sidebarInset = Self.number(remote["sidebarInset"], default: defaults.sidebarInset, range: 0...24)
        codeStyle = remote["codeBlockStyle"].optionalString ?? defaults.codeStyle
        codeWrap = remote["codeWrap"].featureOptionalBool ?? defaults.codeWrap
        terminalDensity = remote["terminalDensity"].optionalString ?? defaults.terminalDensity
        if let value = remote.objectValue["singlePaneContentWidth"] {
            readingWidth = value.isNull ? nil : Self.number(value, default: 676, range: 320...1600)
        }
        notifications = remote["notifications"].optionalString ?? defaults.notifications
        followUps = remote["enableFollowUps"].featureOptionalBool ?? defaults.followUps
        sidecarTitles = remote["enableKiroSidecarTitles"].featureOptionalBool ?? defaults.sidecarTitles
        reduceMotion = local["reduceMotion"].featureOptionalBool ?? defaults.reduceMotion
        showTimestamps = local["showSidebarTimestamps"].featureOptionalBool ?? defaults.showTimestamps
        homeRecommendations = local["homeRecommendations"].featureOptionalBool ?? defaults.homeRecommendations
        showThoughts = local["showThoughts"].featureOptionalBool ?? defaults.showThoughts
        quoteLines = Int(Self.number(local["quoteMaxLines"], default: 2, range: 1...10))
        sidebarThreadLimit = Int(Self.number(local["sidebarThreadLimit"], default: 5, range: 1...30))
    }
    private static func number(_ value: JSONValue, default fallback: Double, range: ClosedRange<Double>) -> Double {
        guard let number = value.featureOptionalNumber, number.isFinite, range.contains(number) else { return fallback }
        return number
    }
    var localRecord: JSONValue {
        ["reduceMotion": .bool(reduceMotion), "showSidebarTimestamps": .bool(showTimestamps), "homeRecommendations": .bool(homeRecommendations),
         "showThoughts": .bool(showThoughts), "quoteMaxLines": .number(Double(quoteLines)), "sidebarThreadLimit": .number(Double(sidebarThreadLimit))]
    }
    var remoteRecord: JSONValue {
        ["terminalPalette": .string(palette), "terminalAccentOverrides": .object(accentOverrides.mapValues(JSONValue.string)),
         "uiFont": .string(uiFont), "messageFont": .string(messageFont), "messageFontSize": .number(messageSize), "composerFontSize": .number(composerSize),
         "sidebarDensity": .string(sidebarDensity), "sidebarInset": .number(sidebarInset), "codeBlockStyle": .string(codeStyle), "codeWrap": .bool(codeWrap),
         "terminalDensity": .string(terminalDensity), "singlePaneContentWidth": readingWidth.map(JSONValue.number) ?? .null,
         "notifications": .string(notifications), "enableFollowUps": .bool(followUps), "enableKiroSidecarTitles": .bool(sidecarTitles)]
    }
    func patch(against baseline: NativeAppearancePreferences, latest: JSONValue) throws -> JSONValue {
        var changes = remoteRecord.objectValue.filter { baseline.remoteRecord[$0.key] != $0.value }
        // The unset default string is also `"monokai"`. Pinning it is a
        // `paletteExplicit` flip and must still write `terminalPalette`.
        if paletteExplicit != baseline.paletteExplicit, paletteExplicit {
            changes["terminalPalette"] = .string(palette)
        }
        let choices: [String: Set<String>] = [
            "terminalPalette": Set(Self.palettes), "uiFont": ["Geist", "IBM Plex Sans", "Inter"], "messageFont": ["Geist", "Source Serif 4"],
            "sidebarDensity": ["compact", "comfortable", "airy"], "terminalDensity": ["compact", "comfortable", "dense"],
            "codeBlockStyle": ["hairline", "header"], "notifications": ["all", "approval-only", "off"]
        ]
        for (key, allowed) in choices { if let value = changes[key], !allowed.contains(value.stringValue) { throw NativeFailure("Choose a supported value for \(key).") } }
        for (key, range) in ["messageFontSize": 11.0...28.0, "composerFontSize": 11.0...28.0, "sidebarInset": 0.0...24.0, "singlePaneContentWidth": 320.0...1600.0] {
            if let value = changes[key], !value.isNull {
                guard let number = value.featureOptionalNumber, number.isFinite, range.contains(number) else { throw NativeFailure("The value for \(key) is outside the supported range.") }
            }
        }
        if changes["terminalAccentOverrides"] != nil {
            // Only the palette entries edited here are merged into a fresh
            // GET; preserve other clients' palettes and future non-string data.
            var accents = latest["terminalAccentOverrides"].objectValue
            for key in Set(accentOverrides.keys).union(baseline.accentOverrides.keys) where accentOverrides[key] != baseline.accentOverrides[key] {
                if let value = accentOverrides[key] {
                    guard Self.isHexColor(value) else { throw NativeFailure("Choose a six-digit accent color.") }
                    accents[key] = .string(value)
                } else { accents.removeValue(forKey: key) }
            }
            changes["terminalAccentOverrides"] = .object(accents)
        }
        return .object(changes)
    }
    func rebased(since submitted: Self, onto committed: Self) -> Self {
        func keep<T: Equatable>(_ current: T, _ sent: T, _ fresh: T) -> T { current == sent ? fresh : current }
        var next = self
        next.palette = keep(palette, submitted.palette, committed.palette)
        next.paletteExplicit = keep(paletteExplicit, submitted.paletteExplicit, committed.paletteExplicit)
        next.uiFont = keep(uiFont, submitted.uiFont, committed.uiFont)
        next.messageFont = keep(messageFont, submitted.messageFont, committed.messageFont)
        next.messageSize = keep(messageSize, submitted.messageSize, committed.messageSize)
        next.composerSize = keep(composerSize, submitted.composerSize, committed.composerSize)
        next.sidebarDensity = keep(sidebarDensity, submitted.sidebarDensity, committed.sidebarDensity)
        next.sidebarInset = keep(sidebarInset, submitted.sidebarInset, committed.sidebarInset)
        next.codeStyle = keep(codeStyle, submitted.codeStyle, committed.codeStyle)
        next.codeWrap = keep(codeWrap, submitted.codeWrap, committed.codeWrap)
        next.terminalDensity = keep(terminalDensity, submitted.terminalDensity, committed.terminalDensity)
        next.readingWidth = keep(readingWidth, submitted.readingWidth, committed.readingWidth)
        next.notifications = keep(notifications, submitted.notifications, committed.notifications)
        next.followUps = keep(followUps, submitted.followUps, committed.followUps)
        next.sidecarTitles = keep(sidecarTitles, submitted.sidecarTitles, committed.sidecarTitles)
        next.reduceMotion = keep(reduceMotion, submitted.reduceMotion, committed.reduceMotion)
        next.showTimestamps = keep(showTimestamps, submitted.showTimestamps, committed.showTimestamps)
        next.homeRecommendations = keep(homeRecommendations, submitted.homeRecommendations, committed.homeRecommendations)
        next.showThoughts = keep(showThoughts, submitted.showThoughts, committed.showThoughts)
        next.quoteLines = keep(quoteLines, submitted.quoteLines, committed.quoteLines)
        next.sidebarThreadLimit = keep(sidebarThreadLimit, submitted.sidebarThreadLimit, committed.sidebarThreadLimit)
        next.accentOverrides = committed.accentOverrides
        for key in Set(accentOverrides.keys).union(submitted.accentOverrides.keys) where accentOverrides[key] != submitted.accentOverrides[key] {
            next.accentOverrides[key] = accentOverrides[key]
        }
        return next
    }
}

@MainActor final class NativeAppearanceModel: ObservableObject {
    let api: MichiAPI
    let defaults: UserDefaults
    let localKey: String
    @Published var draft = NativeAppearancePreferences()
    @Published private(set) var applied = NativeAppearancePreferences()
    @Published private(set) var stored: JSONValue = .null
    @Published var ready = false
    @Published var loading = false
    @Published var saving = false
    @Published var error: String?
    private var baseline = NativeAppearancePreferences()
    var dirty: Bool { draft != baseline }
    init(api: MichiAPI, defaults: UserDefaults = .standard) {
        self.api = api; self.defaults = defaults
        localKey = "michi.nativeAppearance." + api.baseURL.absoluteString
        let local = defaults.string(forKey: localKey).flatMap { try? JSONValue.parse($0) } ?? .null
        draft = NativeAppearancePreferences(remote: .null, local: local); baseline = draft; applied = draft
    }
    private func readPrefs() async throws -> JSONValue {
        let result = try await api.request("/prefs")
        guard case .object = result["prefs"] else { throw NativeFailure("Preferences could not be loaded. Your current settings have been kept.") }
        return result["prefs"]
    }
    func reload() async {
        guard !loading, !saving else { return }
        loading = true; defer { loading = false }
        do {
            let loaded = try await readPrefs()
            stored = loaded; ready = true; error = nil
            if !dirty {
                draft = NativeAppearancePreferences(remote: loaded, local: draft.localRecord)
                baseline = draft; applied = draft
            }
        } catch { self.error = error.localizedDescription }
    }
    func save() async {
        guard ready, !loading, !saving, dirty else { return }
        let submitted = draft, previous = baseline
        saving = true; defer { saving = false }
        do {
            let remoteChanged = submitted.remoteRecord != previous.remoteRecord || submitted.paletteExplicit != previous.paletteExplicit
            let latest = remoteChanged ? try await readPrefs() : stored
            let patch = try submitted.patch(against: previous, latest: latest)
            if !patch.objectValue.isEmpty {
                let result = try await api.request("/prefs", method: "PUT", body: patch)
                guard result["ok"].boolValue else { throw NativeFailure("Preference changes were not confirmed.") }
            }
            stored = latest.merging(patch.objectValue)
            // A change typed during the request stays in the editor. Commit
            // only the captured values that this Save actually submitted.
            let committed = NativeAppearancePreferences(remote: stored, local: submitted.localRecord)
            draft = draft.rebased(since: submitted, onto: committed)
            baseline = committed; applied = committed
            defaults.set(submitted.localRecord.prettyPrinted, forKey: localKey)
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    func discardEdits() { draft = baseline; error = nil }
}
