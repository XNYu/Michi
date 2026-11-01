import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

@MainActor final class NativeAppearanceTests: XCTestCase {
    private func preferences(_ more: [String: JSONValue] = [:]) -> JSONValue {
        JSONValue.object(["terminalPalette": "bone", "messageFontSize": 16, "composerFontSize": 16,
            "terminalAccentOverrides": ["bone": "#b8451f", "future-palette": ["opaque": true]],
            "futureSetting": ["preserved": true], "permissionMode": "ask"]).merging(more)
    }
    private func defaults() -> (UserDefaults, String) {
        let name = "NativeAppearanceTests-" + UUID().uuidString
        return (UserDefaults(suiteName: name)!, name)
    }
    func testLoadDoesNotWriteBackendOrLocalDefaults() async {
        let record = preferences(); let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { _, _ in .json(["prefs": record]) }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        XCTAssertTrue(model.ready); XCTAssertFalse(model.dirty)
        XCTAssertEqual(transport.requests.map(\.method), ["GET"])
        XCTAssertNil(defaults.string(forKey: model.localKey))
        XCTAssertEqual(model.stored["futureSetting"], ["preserved": true])
    }
    func testSaveUsesNarrowPatchAndDoesNotTouchPermissionsOrUnknownFields() async {
        let record = preferences(); let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { request, _ in request.method == "PUT" ? .json(["ok": true]) : .json(["prefs": record]) }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        model.draft.messageSize = 18.5; await model.save()
        XCTAssertEqual(transport.requests.last?.body, ["messageFontSize": .number(18.5)])
        XCTAssertEqual(model.stored["futureSetting"], ["preserved": true])
        XCTAssertEqual(model.stored["permissionMode"], "ask")
        XCTAssertEqual(model.applied.messageSize, 18.5)
    }
    func testFreshAccentMergeKeepsAnotherWindowAndOpaqueFutureEntries() async {
        let first = preferences()
        let fresh = preferences(["terminalAccentOverrides": ["bone": "#b8451f", "slate": "#123456", "future-palette": ["opaque": true]], "composerFontSize": 21])
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { request, requests in
            if request.method == "PUT" { return .json(["ok": true]) }
            return .json(["prefs": requests.count == 1 ? first : fresh])
        }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        model.draft.accentOverrides["bone"] = "#abcdef"; await model.save()
        XCTAssertEqual(transport.requests.last?.body, ["terminalAccentOverrides": ["bone": "#abcdef", "slate": "#123456", "future-palette": ["opaque": true]]])
        XCTAssertEqual(model.applied.composerSize, 21)
        XCTAssertEqual(model.draft.composerSize, 21)
        XCTAssertFalse(model.dirty)
    }
    func testResetOnlyRemovesTheEditedPaletteOverride() async throws {
        var baseline = NativeAppearancePreferences(remote: preferences())
        baseline.accentOverrides["slate"] = "#123456"
        var changed = baseline; changed.accentOverrides.removeValue(forKey: "bone")
        let latest: JSONValue = ["terminalAccentOverrides": ["bone": "#b8451f", "slate": "#654321", "future": .null]]
        let patch = try changed.patch(against: baseline, latest: latest)
        XCTAssertEqual(patch, ["terminalAccentOverrides": ["slate": "#654321", "future": .null]])
    }
    func testFailedFreshReadPreventsMutationAndKeepsDraft() async {
        let record = preferences(); let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { _, requests in requests.count == 1 ? .json(["prefs": record]) : .json(["error": "offline"], status: 503) }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        model.draft.codeWrap = true; await model.save()
        XCTAssertTrue(model.draft.codeWrap); XCTAssertFalse(model.applied.codeWrap); XCTAssertTrue(model.dirty)
        XCTAssertFalse(transport.requests.contains { $0.method == "PUT" })
    }
    func testUnknownWriteOutcomeDoesNotApplyOrAutomaticallyRetry() async {
        let record = preferences(); let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { request, _ in request.method == "PUT" ? .failure(.networkConnectionLost) : .json(["prefs": record]) }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        model.draft.notifications = "off"; await model.save()
        XCTAssertEqual(model.draft.notifications, "off"); XCTAssertEqual(model.applied.notifications, "all")
        XCTAssertNotNil(model.error); XCTAssertEqual(transport.requests.filter { $0.method == "PUT" }.count, 1)
    }
    func testEditsDuringSaveStayDirtyAndAreNotLostToAcknowledgement() async {
        let record = preferences(); let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { request, _ in request.method == "PUT" ? .delayedJSON(["ok": true], status: 200, delay: 0.15) : .json(["prefs": record]) }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        model.draft.messageSize = 18
        let task = Task { await model.save() }
        let deadline = Date().addingTimeInterval(2)
        while !transport.requests.contains(where: { $0.method == "PUT" }) && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        model.draft.messageSize = 20; model.draft.codeWrap = true
        await task.value
        XCTAssertEqual(model.applied.messageSize, 18); XCTAssertFalse(model.applied.codeWrap)
        XCTAssertEqual(model.draft.messageSize, 20); XCTAssertTrue(model.draft.codeWrap); XCTAssertTrue(model.dirty)
    }
    func testLocalOnlyChangesNeverSendUnsupportedFieldsToBackend() async {
        let record = preferences(); let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { _, _ in .json(["prefs": record]) }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        model.draft.reduceMotion = true; model.draft.showTimestamps = true; model.draft.homeRecommendations = false; await model.save()
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertTrue(model.applied.reduceMotion); XCTAssertTrue(model.applied.showTimestamps)
        let restored = NativeAppearanceModel(api: transport.api, defaults: defaults)
        XCTAssertTrue(restored.applied.reduceMotion); XCTAssertFalse(restored.applied.homeRecommendations)
    }
    func testReloadPreservesUnsavedControlsAndInvalidSnapshotCannotEnableSave() async {
        let record = preferences(); let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { _, _ in .json(["prefs": record]) }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        model.draft.composerSize = 20; await model.reload()
        XCTAssertEqual(model.draft.composerSize, 20); XCTAssertTrue(model.dirty)
        let bad = AppContractTransport { _, _ in .json(["prefs": []]) }; defer { bad.close() }
        let invalid = NativeAppearanceModel(api: bad.api, defaults: defaults); await invalid.reload()
        invalid.draft.codeWrap = true; await invalid.save()
        XCTAssertFalse(invalid.ready); XCTAssertEqual(bad.requests.count, 1)
    }
    func testUnsupportedExistingSettingIsNotOverwrittenByUnrelatedEdit() async throws {
        let record = preferences(["terminalPalette": "future-theme", "uiFont": "Future Font", "codeWrap": .null])
        let original = NativeAppearancePreferences(remote: record)
        var changed = original; changed.followUps = false
        XCTAssertEqual(try changed.patch(against: original, latest: record), ["enableFollowUps": false])
    }
    func testInvalidColorAndSizesCannotReachBackend() async throws {
        let original = NativeAppearancePreferences(remote: preferences())
        var changed = original; changed.accentOverrides["bone"] = "url(javascript:alert(1))"
        XCTAssertThrowsError(try changed.patch(against: original, latest: preferences()))
        changed = original; changed.messageSize = .infinity
        XCTAssertThrowsError(try changed.patch(against: original, latest: preferences()))
        XCTAssertFalse(NativeAppearancePreferences.isHexColor("#fff"))
        XCTAssertTrue(NativeAppearancePreferences.isHexColor("#A0bc09"))
    }
    func testUnsetPaletteDefaultsToMonokaiAndIsNotExplicit() {
        let unset = NativeAppearancePreferences(remote: [:])
        XCTAssertEqual(unset.palette, "monokai")
        XCTAssertFalse(unset.paletteExplicit)
        let saved = NativeAppearancePreferences(remote: ["terminalPalette": "bone"])
        XCTAssertEqual(saved.palette, "bone")
        XCTAssertTrue(saved.paletteExplicit)
    }
    func testMatchSystemFollowsOSForSavedBoneFreshMonokaiAndExplicitSystem() {
        // Old saved Bone is kept, but Match system follows the live OS.
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "bone", paletteExplicit: true, appearance: "system", systemIsLight: false), "monokai")
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "bone", paletteExplicit: true, appearance: "system", systemIsLight: true), "bone")
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "slate", paletteExplicit: true, appearance: "system", systemIsLight: false), "monokai")
        XCTAssertNil(NativeAppearancePreferences.preferredColorScheme(palette: "bone", paletteExplicit: true, appearance: "system"))
        // Turning Match system off restores the saved Bone (forced light).
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "bone", paletteExplicit: true, appearance: "light", systemIsLight: false), "bone")
        XCTAssertEqual(NativeAppearancePreferences.preferredColorScheme(palette: "bone", paletteExplicit: true, appearance: "light"), "light")
        XCTAssertEqual(NativeAppearancePreferences.appearanceRestoredFromMatch(palette: "bone", paletteExplicit: true, canvasIsDark: true), "light")
        // Fresh unset Monokai: Dark chrome / dark OS → Monokai, still not explicit.
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "monokai", paletteExplicit: false, appearance: "dark", systemIsLight: true), "monokai")
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "monokai", paletteExplicit: false, appearance: "light", systemIsLight: false), "bone")
        // Explicit System (appearance == "system") follows the OS for an unset palette.
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "monokai", paletteExplicit: false, appearance: "system", systemIsLight: false), "monokai")
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "monokai", paletteExplicit: false, appearance: "system", systemIsLight: true), "bone")
        XCTAssertNil(NativeAppearancePreferences.preferredColorScheme(palette: "monokai", paletteExplicit: false, appearance: "system"))
        // Match system off + explicit Monokai still forces dark, including on a light OS.
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: "monokai", paletteExplicit: true, appearance: "light", systemIsLight: true), "monokai")
        XCTAssertEqual(NativeAppearancePreferences.preferredColorScheme(palette: "monokai", paletteExplicit: true, appearance: "dark"), "dark")
        XCTAssertEqual(NativeAppearancePreferences.appearanceRestoredFromMatch(palette: "monokai", paletteExplicit: true, canvasIsDark: false), "dark")
        XCTAssertEqual(NativeAppearancePreferences.appearanceRestoredFromMatch(palette: "monokai", paletteExplicit: false, canvasIsDark: true), "dark")
    }

    func testPinningDefaultMonokaiIsDirtyAndPatchesTerminalPalette() async throws {
        let unset = NativeAppearancePreferences(remote: [:])
        XCTAssertEqual(unset.palette, "monokai")
        XCTAssertFalse(unset.paletteExplicit)
        var pinned = unset
        pinned.selectPalette("monokai")
        XCTAssertTrue(pinned.paletteExplicit)
        XCTAssertNotEqual(pinned, unset)
        XCTAssertEqual(try pinned.patch(against: unset, latest: [:]), ["terminalPalette": "monokai"])
    }

    func testSavePinsFreshMonokaiWithoutClearingUnrelatedPrefs() async {
        let record: JSONValue = ["futureSetting": ["preserved": true], "permissionMode": "ask"]
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { request, _ in
            request.method == "PUT" ? .json(["ok": true]) : .json(["prefs": record])
        }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        XCTAssertFalse(model.applied.paletteExplicit)
        XCTAssertFalse(model.dirty)
        model.draft.selectPalette("monokai")
        XCTAssertTrue(model.dirty)
        await model.save()
        XCTAssertEqual(transport.requests.last?.body, ["terminalPalette": "monokai"])
        XCTAssertTrue(model.applied.paletteExplicit)
        XCTAssertEqual(model.applied.palette, "monokai")
        XCTAssertEqual(model.stored["futureSetting"], ["preserved": true])
        XCTAssertEqual(model.stored["permissionMode"], "ask")
        XCTAssertFalse(model.dirty)
    }

    func testMatchSystemDoesNotPatchOrClearSavedBone() async throws {
        let saved = NativeAppearancePreferences(remote: ["terminalPalette": "bone"])
        XCTAssertTrue(saved.paletteExplicit)
        XCTAssertEqual(saved.palette, "bone")
        XCTAssertEqual(try saved.patch(against: saved, latest: ["terminalPalette": "bone"]), [:])
        XCTAssertEqual(NativeAppearancePreferences.resolvedPalette(palette: saved.palette, paletteExplicit: saved.paletteExplicit, appearance: "system", systemIsLight: false), "monokai")
        XCTAssertEqual(saved.palette, "bone")
        XCTAssertTrue(saved.paletteExplicit)
    }
    func testReloadPreservesExplicitPaletteFlag() async {
        let record = preferences(["terminalPalette": "bone"]); let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let transport = AppContractTransport { _, _ in .json(["prefs": record]) }; defer { transport.close() }
        let model = NativeAppearanceModel(api: transport.api, defaults: defaults); await model.reload()
        XCTAssertTrue(model.applied.paletteExplicit)
        XCTAssertEqual(model.applied.palette, "bone")
        model.draft.messageSize = 18; await model.reload()
        XCTAssertTrue(model.draft.paletteExplicit)
        XCTAssertEqual(model.draft.palette, "bone")
    }
}
