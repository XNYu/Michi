import XCTest
import MichiCore
#if canImport(Michi)
@testable import Michi
#else
@testable import MichiState
#endif

final class NativeDictationDraftTests: XCTestCase {
    func testPartialResultsReplaceOnlyTheDictatedTextAfterTheExistingDraft() {
        var session = NativeDictationDraft(draft: "Summarize")
        XCTAssertEqual(session.merge("the plan", into: "Summarize"), "Summarize the plan")
        XCTAssertEqual(session.merge("the plan for today.", into: "Summarize the plan"), "Summarize the plan for today.")
        XCTAssertEqual(session.merge("the plan.", into: "Summarize the plan for today."), "Summarize the plan.")
        XCTAssertFalse(session.detached)
    }

    func testSeparatorFollowsTheTextBeforeTheDictatedRange() {
        var empty = NativeDictationDraft(draft: "")
        XCTAssertEqual(empty.merge("Hello", into: ""), "Hello")
        var spaced = NativeDictationDraft(draft: "Note:\n")
        XCTAssertEqual(spaced.merge("  call Sam  ", into: "Note:\n"), "Note:\ncall Sam")
    }

    func testUnchangedOrEmptyTranscriptWritesNothing() {
        var session = NativeDictationDraft(draft: "Draft")
        XCTAssertNil(session.merge("", into: "Draft"))
        XCTAssertEqual(session.merge("one", into: "Draft"), "Draft one")
        XCTAssertNil(session.merge("one", into: "Draft one"))
        XCTAssertTrue(session.hasWritten)
    }

    func testMentionsBeforeTheDictatedRangeSurviveReanchoring() {
        let draft = "Ask @Plan"
        let mention: JSONValue = ["start": .number(4), "end": .number(9), "kind": "node", "refId": "node-1", "label": "Plan"]
        var session = NativeDictationDraft(draft: draft)
        let first = session.merge("about scope", into: draft)
        XCTAssertEqual(first, "Ask @Plan about scope")
        let anchored = NativeComposer.reanchor([mention], previous: draft, next: first ?? "")
        XCTAssertEqual(anchored, [mention])
        let second = session.merge("about scope and dates", into: first ?? "")
        XCTAssertEqual(NativeComposer.reanchor(anchored, previous: first ?? "", next: second ?? ""), [mention])
    }

    func testEditBeforeTheDictatedRangeMovesIt() {
        var session = NativeDictationDraft(draft: "Hi")
        XCTAssertEqual(session.merge("there", into: "Hi"), "Hi there")
        XCTAssertEqual(session.merge("there friend", into: "Oh hi there"), "Oh hi there friend")
        XCTAssertFalse(session.detached)
    }

    func testTextTypedAfterTheDictatedRangeIsKept() {
        var session = NativeDictationDraft(draft: "Draft")
        XCTAssertEqual(session.merge("one", into: "Draft"), "Draft one")
        XCTAssertEqual(session.merge("one two", into: "Draft one!"), "Draft one two!")
        XCTAssertEqual(session.merge("one two three", into: "Draft one two! Done"), "Draft one two three! Done")
    }

    func testTypingBeforeAnyResultPutsTheTranscriptAfterTheTypedText() {
        var session = NativeDictationDraft(draft: "Hello")
        XCTAssertEqual(session.merge("again", into: "Hello world"), "Hello world again")
    }

    func testEditingDictatedTextDetachesAndDropsLaterResults() {
        var session = NativeDictationDraft(draft: "A")
        XCTAssertEqual(session.merge("bee", into: "A"), "A bee")
        XCTAssertNil(session.merge("bee sting", into: "A bed"))
        XCTAssertTrue(session.detached)
        XCTAssertNil(session.merge("bee sting", into: "A bee"))
    }

    func testClearedOrSentDraftDetaches() {
        var session = NativeDictationDraft(draft: "Send this")
        XCTAssertNil(session.merge("now", into: ""))
        XCTAssertTrue(session.detached)
        var started = NativeDictationDraft(draft: "")
        XCTAssertEqual(started.merge("hello", into: ""), "hello")
        XCTAssertNil(started.merge("hello there", into: ""))
        XCTAssertTrue(started.detached)
    }

    func testUTF16OffsetsAroundEmoji() {
        var session = NativeDictationDraft(draft: "Ship 🚀")
        XCTAssertEqual(session.merge("now", into: "Ship 🚀"), "Ship 🚀 now")
        XCTAssertEqual(session.merge("now please", into: "🎉 Ship 🚀 now"), "🎉 Ship 🚀 now please")
    }

    // MARK: Unicode normalization

    /// Canonically equal spellings of "Café" with different UTF-16 lengths.
    private let nfc = "Caf\u{E9}", nfd = "Cafe\u{301}"

    /// `XCTAssertEqual` on strings is canonical, so it can't see these edits.
    private func assertCodeUnits(_ actual: String?, _ expected: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.map { Array($0.utf16) }, Array(expected.utf16), file: file, line: line)
    }

    func testNormalizationChangeBeforeTheDictatedRangeMovesIt() {
        var composed = NativeDictationDraft(draft: nfc)
        assertCodeUnits(composed.merge("menu", into: nfc), nfc + " menu")
        assertCodeUnits(composed.merge("menu please", into: nfd + " menu"), nfd + " menu please")
        var decomposed = NativeDictationDraft(draft: nfd)
        assertCodeUnits(decomposed.merge("menu", into: nfd), nfd + " menu")
        assertCodeUnits(decomposed.merge("menu please", into: nfc + " menu"), nfc + " menu please")
        XCTAssertFalse(composed.detached || decomposed.detached)
    }

    func testNormalizationChangeInsideTheDictatedRangeDetachesWithoutWriting() {
        var composed = NativeDictationDraft(draft: "Order")
        assertCodeUnits(composed.merge(nfc, into: "Order"), "Order " + nfc)
        XCTAssertNil(composed.merge(nfc + " latte", into: "Order " + nfd))
        XCTAssertTrue(composed.detached)
        // The shorter spelling would put the old owned range past the end.
        var decomposed = NativeDictationDraft(draft: "Order")
        assertCodeUnits(decomposed.merge(nfd, into: "Order"), "Order " + nfd)
        XCTAssertNil(decomposed.merge(nfd + " latte", into: "Order " + nfc))
        XCTAssertTrue(decomposed.detached)
    }

    func testTranscriptThatOnlyChangesNormalizationKeepsTheDraftAndItsRange() {
        var session = NativeDictationDraft(draft: "Order")
        let first = session.merge(nfc, into: "Order") ?? ""
        assertCodeUnits(first, "Order " + nfc)
        XCTAssertNil(session.merge(nfd, into: first))
        assertCodeUnits(session.merge(nfd + " latte", into: first), "Order " + nfd + " latte")
        XCTAssertFalse(session.detached)
    }

    // MARK: Gate

    private let onDevice = NativeDictationRecognizer(exists: true, supportsOnDevice: true, available: true)

    func testMissingRecognizerBlocksBeforeAnyPermissionPrompt() {
        let step = NativeDictationGate.next(speech: .undetermined, microphone: .undetermined,
                                            recognizer: .init(exists: false, supportsOnDevice: false, available: false))
        XCTAssertEqual(step, .blocked(.noRecognizer))
    }

    func testSpeechPermissionComesBeforeMicrophone() {
        XCTAssertEqual(NativeDictationGate.next(speech: .undetermined, microphone: .undetermined, recognizer: onDevice), .requestSpeech)
        XCTAssertEqual(NativeDictationGate.next(speech: .granted, microphone: .undetermined, recognizer: onDevice), .requestMicrophone)
        XCTAssertEqual(NativeDictationGate.next(speech: .granted, microphone: .granted, recognizer: onDevice), .start)
    }

    func testNoOnDeviceSupportNeverFallsBackOrPromptsForTheMicrophone() {
        let remoteOnly = NativeDictationRecognizer(exists: true, supportsOnDevice: false, available: true)
        XCTAssertEqual(NativeDictationGate.next(speech: .granted, microphone: .undetermined, recognizer: remoteOnly), .blocked(.onDeviceUnsupported))
        XCTAssertEqual(NativeDictationGate.next(speech: .granted, microphone: .granted, recognizer: remoteOnly), .blocked(.onDeviceUnsupported))
    }

    func testDeniedAndRestrictedAccessGiveDistinctGuidance() {
        XCTAssertEqual(NativeDictationGate.next(speech: .denied, microphone: .granted, recognizer: onDevice), .blocked(.speechDenied))
        XCTAssertEqual(NativeDictationGate.next(speech: .restricted, microphone: .granted, recognizer: onDevice), .blocked(.speechRestricted))
        XCTAssertEqual(NativeDictationGate.next(speech: .granted, microphone: .denied, recognizer: onDevice), .blocked(.microphoneDenied))
        XCTAssertTrue(NativeDictationIssue.speechDenied.opensSettings)
        XCTAssertTrue(NativeDictationIssue.microphoneDenied.opensSettings)
        XCTAssertFalse(NativeDictationIssue.speechRestricted.opensSettings)
        XCTAssertFalse(NativeDictationIssue.onDeviceUnsupported.opensSettings)
    }

    func testUnavailableRecognizerBlocksAfterPermissions() {
        let busy = NativeDictationRecognizer(exists: true, supportsOnDevice: true, available: false)
        XCTAssertEqual(NativeDictationGate.next(speech: .granted, microphone: .granted, recognizer: busy), .blocked(.recognizerBusy))
    }

    func testEveryIssueHasGuidance() {
        for issue in NativeDictationIssue.allCases {
            XCTAssertFalse(issue.title.isEmpty, issue.rawValue)
            XCTAssertFalse(issue.message.isEmpty, issue.rawValue)
        }
        XCTAssertTrue(NativeDictationIssue.onDeviceUnsupported.message.contains("never sends your voice"))
    }
}
