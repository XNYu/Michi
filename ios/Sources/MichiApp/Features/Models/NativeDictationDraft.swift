import Foundation

/// Merges one dictation session's transcript into a composer draft.
///
/// The session owns a single UTF-16 range of the draft, starting at the end of
/// the text present when dictation began. Each recognizer result replaces only
/// that range, so text and mentions before it are untouched (the composer's
/// mention re-anchoring sees an edit after them). Edits the user makes outside
/// the range move it; an edit that touches dictated text, or a cleared draft
/// (for example after sending), detaches the session so later results are
/// dropped instead of overwriting the user's change. Nothing here sends.
///
/// Offsets are UTF-16, so drafts are compared by code units: `String ==` is
/// canonical equivalence and treats an NFC/NFD rewrite as unchanged even
/// though it moves every offset after it. Not `Equatable` for the same reason.
struct NativeDictationDraft {
    /// UTF-16 offset of the owned range in `expected`.
    private(set) var start: Int
    /// Owned text: the transcript plus any separators added around it.
    private(set) var owned = ""
    /// The draft as of the last observation or write.
    private(set) var expected: String
    private(set) var detached = false

    init(draft: String) {
        start = draft.utf16.count
        expected = draft
    }

    var hasWritten: Bool { !owned.isEmpty }

    /// The draft to write for a cumulative `transcript`, or nil when nothing
    /// should be written (unchanged, or the session is detached).
    mutating func merge(_ transcript: String, into current: String) -> String? {
        guard !detached else { return nil }
        guard relocate(in: current) else { detached = true; return nil }
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = start + owned.utf16.count
        var next = text
        if !text.isEmpty {
            if let before = Self.character(in: current, before: start), !before.isWhitespace { next = " " + next }
            if let after = Self.character(in: current, at: end), after.isLetter || after.isNumber { next += " " }
        }
        // Canonical comparison on purpose: returning here changes no state, and
        // relocate has just matched `owned` to the draft by code units, so the
        // offsets stay valid. A result that differs only in normalization would
        // look identical, so the user's draft isn't rewritten for it.
        guard next != owned else { return nil }
        let result = (current as NSString).replacingCharacters(in: NSRange(location: start, length: owned.utf16.count), with: next)
        owned = next
        expected = result
        return result
    }

    mutating func detach() { detached = true }

    /// Follows edits made since the last write. Same prefix/suffix diff as
    /// `NativeComposer.reanchor`, so the two agree on where an edit landed.
    private mutating func relocate(in current: String) -> Bool {
        if current.utf16.elementsEqual(expected.utf16) { return true }
        let old = Array(expected.utf16), new = Array(current.utf16)
        if new.isEmpty { return false }
        var prefix = 0
        while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < min(old.count, new.count) - prefix, old[old.count - suffix - 1] == new[new.count - suffix - 1] { suffix += 1 }
        let changedEnd = old.count - suffix, end = start + owned.utf16.count
        // Checked first so typing at an empty range's position stays ahead of
        // the transcript, which then continues after the typed text.
        if changedEnd <= start { start += new.count - old.count }
        else if prefix < end { return false }
        expected = current
        return true
    }

    private static func character(in text: String, before offset: Int) -> Character? {
        guard offset > 0, offset <= text.utf16.count else { return nil }
        return text[..<text.utf16.index(text.utf16.startIndex, offsetBy: offset)].last
    }

    private static func character(in text: String, at offset: Int) -> Character? {
        guard offset >= 0, offset < text.utf16.count else { return nil }
        return text[text.utf16.index(text.utf16.startIndex, offsetBy: offset)...].first
    }
}

/// Speech or microphone permission, independent of the framework enums.
enum NativeDictationAccess: Equatable {
    case undetermined, denied, restricted, granted
}

/// What the device's recognizer for the current language can do.
struct NativeDictationRecognizer: Equatable {
    var exists: Bool
    var supportsOnDevice: Bool
    var available: Bool
}

/// Why dictation cannot run, with the guidance shown beside the microphone.
enum NativeDictationIssue: String, Error, Hashable, Identifiable, CaseIterable {
    case noRecognizer, speechDenied, speechRestricted, onDeviceUnsupported
    case microphoneDenied, recognizerBusy, noInput, startFailed, noSpeech, automation

    var id: String { rawValue }

    var title: String {
        switch self {
        case .noRecognizer: return "Dictation isn't available"
        case .speechDenied: return "Speech Recognition is off"
        case .speechRestricted: return "Dictation is restricted"
        case .onDeviceUnsupported: return "On-device dictation isn't available"
        case .microphoneDenied: return "Microphone access is off"
        case .recognizerBusy: return "Dictation isn't ready"
        case .noInput: return "No microphone found"
        case .startFailed: return "Dictation couldn't start"
        case .noSpeech: return "Nothing was transcribed"
        case .automation: return "Dictation is off in UI tests"
        }
    }

    var message: String {
        switch self {
        case .noRecognizer:
            return "Speech recognition isn't available for your current language on this device. You can keep typing."
        case .speechDenied:
            return "Allow Speech Recognition for Michi in Settings to dictate into drafts. Your voice is transcribed on this device."
        case .speechRestricted:
            return "Speech recognition is restricted on this device, for example by Screen Time or a device profile."
        case .onDeviceUnsupported:
            return "Michi only transcribes on this device and never sends your voice to a server. This device or language doesn't support on-device recognition."
        case .microphoneDenied:
            return "Allow Microphone for Michi in Settings to dictate into drafts. Michi listens only while the microphone is on."
        case .recognizerBusy:
            return "On-device speech recognition isn't ready right now. Try again in a moment."
        case .noInput:
            return "Michi couldn't find a microphone input. Connect one and try again."
        case .startFailed:
            return "The microphone couldn't start. Another app may be using it; try again."
        case .noSpeech:
            return "Michi didn't hear any words. Tap the microphone and speak again. Your draft wasn't changed."
        case .automation:
            return "Automated test runs never request microphone or speech access."
        }
    }

    /// Only a user denial can be changed from Michi's page in Settings.
    var opensSettings: Bool { self == .speechDenied || self == .microphoneDenied }
}

enum NativeDictationStep: Equatable {
    case requestSpeech, requestMicrophone, start
    case blocked(NativeDictationIssue)
}

/// Decides the next dictation step. Speech permission comes first: on-device
/// support is checked only after it, and a recognizer that cannot run on the
/// device blocks dictation before the microphone prompt; there is no remote
/// fallback. Requests are issued by the caller in response to a tap.
enum NativeDictationGate {
    static func next(speech: NativeDictationAccess, microphone: NativeDictationAccess, recognizer: NativeDictationRecognizer) -> NativeDictationStep {
        guard recognizer.exists else { return .blocked(.noRecognizer) }
        switch speech {
        case .undetermined: return .requestSpeech
        case .denied: return .blocked(.speechDenied)
        case .restricted: return .blocked(.speechRestricted)
        case .granted: break
        }
        guard recognizer.supportsOnDevice else { return .blocked(.onDeviceUnsupported) }
        switch microphone {
        case .undetermined: return .requestMicrophone
        case .denied, .restricted: return .blocked(.microphoneDenied)
        case .granted: break
        }
        return recognizer.available ? .start : .blocked(.recognizerBusy)
    }
}
