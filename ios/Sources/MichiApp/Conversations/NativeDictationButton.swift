import AVFoundation
import Speech
import SwiftUI
import UIKit

/// Composer microphone (design 04/06/08: `mic` glyph in `mid`, 38 pt visual,
/// 44 pt hit area). Dictates into `draft` with Apple's on-device recognizer
/// only: every request requires on-device recognition, and the button refuses
/// to start when the device or language can't provide it. Permissions are
/// requested on the first tap, never on appearance. Results go through the
/// binding's setter into a range the session owns (`NativeDictationDraft`), so
/// existing text, later edits and mentions survive; nothing is ever sent.
/// Dictation is cancelled when the button disappears or is disabled, or the
/// scene moves to the background; text already written stays in the draft.
///
/// A composer that swaps the microphone out while the draft has text must keep
/// it mounted while `NativeDictationActiveKey` is true; removing it cancels.
struct NativeDictationButton: View {
    @Binding private var draft: String
    private let enabled: Bool
    @StateObject private var controller = NativeDictationController()
    @Environment(\.michiTokens) private var tokens
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(draft: Binding<String>, enabled: Bool) {
        _draft = draft
        self.enabled = enabled
    }

    var body: some View {
        Button { controller.toggle(draft: $draft, enabled: enabled) } label: { glyph }
            .buttonStyle(.plain)
            .michiHitTarget()
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.45)
            .accessibilityLabel(controller.isActive ? "Stop dictation" : "Dictate")
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(controller.isActive ? "" : "Transcribes on this device into the draft without sending.")
            .accessibilityIdentifier("dictation-button")
            .popover(isPresented: guidancePresented, arrowEdge: .bottom) {
                NativeDictationGuidance(issue: controller.lastGuidance) { controller.guidance = nil }
                    .presentationCompactAdaptation(.popover)
            }
            .preference(key: NativeDictationActiveKey.self, value: controller.isActive)
            .onChange(of: enabled) { _, now in if !now { controller.cancel() } }
            .onChange(of: scenePhase) { _, phase in if phase == .background { controller.cancel() } }
            .onDisappear { controller.cancel() }
    }

    @ViewBuilder private var glyph: some View {
        let accessibilityLayout = dynamicTypeSize.isAccessibilitySize
        let size: CGFloat = accessibilityLayout ? 44 : 38
        switch controller.phase {
        case .idle:
            Image(systemName: "mic")
                .font(.system(size: accessibilityLayout ? 19 : 16, weight: .regular))
                .foregroundStyle(tokens.mid)
                .frame(width: size, height: size)
        case .listening:
            Image(systemName: "waveform")
                .font(.system(size: accessibilityLayout ? 18 : 15, weight: .semibold))
                .foregroundStyle(tokens.selectInk)
                .symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
                .frame(width: size, height: size)
                .background(tokens.selectF, in: Circle())
        case .preparing, .finishing:
            ProgressView()
                .controlSize(.small)
                .tint(tokens.mid)
                .frame(width: size, height: size)
        }
    }

    private var accessibilityValue: String {
        switch controller.phase {
        case .idle: return ""
        case .preparing: return "Starting"
        case .listening: return "Listening"
        case .finishing: return "Finishing"
        }
    }

    private var guidancePresented: Binding<Bool> {
        Binding(get: { controller.guidance != nil }, set: { if !$0 { controller.guidance = nil } })
    }
}

/// True while a dictation button is starting, listening or finishing.
struct NativeDictationActiveKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

private struct NativeDictationGuidance: View {
    let issue: NativeDictationIssue
    let dismiss: () -> Void
    @Environment(\.michiTokens) private var tokens
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(issue.title, systemImage: issue.opensSettings ? "mic.slash" : "info.circle")
                .font(MichiFont.rowTitle)
                .foregroundStyle(tokens.fg)
            Text(issue.message)
                .font(MichiFont.rowSecondary)
                .foregroundStyle(tokens.mid)
                .fixedSize(horizontal: false, vertical: true)
            if issue.opensSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                Button { dismiss(); openURL(url) } label: {
                    Text("Open Settings")
                        .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .semibold))
                        .foregroundStyle(tokens.accentText)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("dictation-open-settings")
            }
        }
        .padding(14)
        .frame(width: 272, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dictation-guidance")
    }
}

/// UI-test runs never touch Speech or AVFoundation: DEBUG builds use a
/// deterministic stub (or a fixed blocked state), other builds stay blocked.
private enum NativeDictationMode {
    case live
    case blocked(NativeDictationIssue)
    #if DEBUG
    case stub
    static let stubPartial = "Dictated on"
    static let stubTranscript = "Dictated on this device"
    #endif

    static var current: NativeDictationMode {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains("--uitesting") else { return .live }
        #if DEBUG
        if arguments.contains("--preview-dictation-denied") { return .blocked(.microphoneDenied) }
        if arguments.contains("--preview-dictation-unavailable") { return .blocked(.onDeviceUnsupported) }
        return .stub
        #else
        return .blocked(.automation)
        #endif
    }
}

/// One dictation session at a time. Every callback carries the generation it
/// was started with; teardown advances the generation, so results that arrive
/// after a stop, cancel or new session are dropped instead of written.
@MainActor private final class NativeDictationController: ObservableObject {
    enum Phase: Equatable { case idle, preparing, listening, finishing }

    @Published private(set) var phase = Phase.idle
    @Published var guidance: NativeDictationIssue? { didSet { if let guidance { lastGuidance = guidance } } }
    /// Kept through the popover's dismissal so its content doesn't change.
    private(set) var lastGuidance = NativeDictationIssue.recognizerBusy
    var isActive: Bool { phase != .idle }

    private let mode = NativeDictationMode.current
    private var generation = 0
    private var target: Binding<String>?
    private var merge: NativeDictationDraft?
    private var capture: NativeDictationCapture?
    private var deadline: Task<Void, Never>?

    func toggle(draft: Binding<String>, enabled: Bool) {
        switch phase {
        case .idle:
            guard enabled else { return }
            begin(draft)
        case .listening: finish()
        case .preparing, .finishing: cancel()
        }
    }

    /// Stops listening and keeps the final result if it arrives promptly.
    func finish() {
        guard phase == .listening else { return }
        let token = generation
        #if DEBUG
        if case .stub = mode { return receive(NativeDictationMode.stubTranscript, final: true, token: token) }
        #endif
        guard let capture else { return teardown() }
        phase = .finishing
        capture.finish()
        deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, token == self.generation else { return }
            self.teardown()
        }
    }

    /// Stops immediately; nothing more is written.
    func cancel() {
        guard phase != .idle else { return }
        teardown()
    }

    private func begin(_ draft: Binding<String>) {
        guidance = nil
        generation &+= 1
        let token = generation
        target = draft
        phase = .preparing
        Task { await prepare(token) }
    }

    private func prepare(_ token: Int) async {
        let recognizer: SFSpeechRecognizer?
        switch mode {
        case .blocked(let issue): return block(issue, token)
        #if DEBUG
        case .stub: return startStub(token)
        #endif
        case .live: recognizer = SFSpeechRecognizer()
        }
        // Each pass either requests one permission (only reached from a tap),
        // starts, or stops with guidance.
        for _ in 0..<3 {
            guard token == generation else { return }
            let state = NativeDictationRecognizer(exists: recognizer != nil,
                                                  supportsOnDevice: recognizer?.supportsOnDeviceRecognition ?? false,
                                                  available: recognizer?.isAvailable ?? false)
            switch NativeDictationGate.next(speech: Self.speechAccess(), microphone: Self.microphoneAccess(), recognizer: state) {
            case .requestSpeech: await Self.requestSpeech()
            case .requestMicrophone: await Self.requestMicrophone()
            case .blocked(let issue): return block(issue, token)
            case .start:
                guard let recognizer else { return block(.noRecognizer, token) }
                return startLive(recognizer, token)
            }
        }
        block(.recognizerBusy, token)
    }

    private func startLive(_ recognizer: SFSpeechRecognizer, _ token: Int) {
        guard token == generation, let target else { return }
        let capture = NativeDictationCapture(recognizer: recognizer)
        merge = NativeDictationDraft(draft: target.wrappedValue)
        do {
            try capture.start(onResult: { [weak self] text, final in self?.receive(text, final: final, token: token) },
                              onEnd: { [weak self] issue in self?.ended(issue, token: token) })
        } catch {
            capture.cancel()
            return block(error as? NativeDictationIssue ?? .startFailed, token)
        }
        // A synchronous recognizer failure may already have ended the session.
        guard token == generation else { return capture.cancel() }
        self.capture = capture
        phase = .listening
    }

    #if DEBUG
    private func startStub(_ token: Int) {
        guard token == generation, let target else { return }
        merge = NativeDictationDraft(draft: target.wrappedValue)
        phase = .listening
        receive(NativeDictationMode.stubPartial, final: false, token: token)
    }
    #endif

    private func receive(_ transcript: String, final: Bool, token: Int) {
        guard token == generation, var merge, let target else { return }
        if let next = merge.merge(transcript, into: target.wrappedValue) { target.wrappedValue = next }
        self.merge = merge
        // A detached session means the user changed dictated text or cleared
        // the draft; their edit wins and listening ends.
        if merge.detached || final { teardown() }
    }

    private func ended(_ issue: NativeDictationIssue?, token: Int) {
        guard token == generation else { return }
        teardown()
        if let issue { guidance = issue }
    }

    private func block(_ issue: NativeDictationIssue, _ token: Int) {
        guard token == generation else { return }
        teardown()
        guidance = issue
    }

    private func teardown() {
        generation &+= 1
        deadline?.cancel(); deadline = nil
        capture?.cancel(); capture = nil
        merge = nil; target = nil
        phase = .idle
    }

    nonisolated private static func speechAccess() -> NativeDictationAccess {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .undetermined
        @unknown default: return .restricted
        }
    }

    nonisolated private static func microphoneAccess() -> NativeDictationAccess {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        case .undetermined: return .undetermined
        @unknown default: return .denied
        }
    }

    nonisolated private static func requestSpeech() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            SFSpeechRecognizer.requestAuthorization { _ in done.resume() }
        }
    }

    nonisolated private static func requestMicrophone() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            AVAudioApplication.requestRecordPermission { _ in done.resume() }
        }
    }
}

/// Microphone capture feeding an on-device-only recognition request. Restores
/// the previous audio session category when it stops. Main-thread only; the
/// audio tap is built outside the main actor and recognizer callbacks hop back
/// before touching state.
@MainActor private final class NativeDictationCapture {
    private let recognizer: SFSpeechRecognizer
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var observers: [NSObjectProtocol] = []
    private var previous: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
    private var tapInstalled = false
    private var heard = false
    private var stopping = false
    private var closed = false
    private var onResult: (String, Bool) -> Void = { _, _ in }
    private var onEnd: (NativeDictationIssue?) -> Void = { _ in }

    init(recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

    func start(onResult: @escaping (String, Bool) -> Void, onEnd: @escaping (NativeDictationIssue?) -> Void) throws {
        guard recognizer.supportsOnDeviceRecognition else { throw NativeDictationIssue.onDeviceUnsupported }
        guard recognizer.isAvailable else { throw NativeDictationIssue.recognizerBusy }
        self.onResult = onResult
        self.onEnd = onEnd
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true

        let session = AVAudioSession.sharedInstance()
        previous = (session.category, session.mode, session.categoryOptions)
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch { throw NativeDictationIssue.startFailed }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard session.isInputAvailable, format.sampleRate > 0, format.channelCount > 0 else { throw NativeDictationIssue.noInput }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(appendingTo: request))
        tapInstalled = true
        engine.prepare()
        do { try engine.start() } catch { throw NativeDictationIssue.startFailed }

        self.request = request
        recognizer.queue = .main
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            let noSpeech = (error as NSError?).map { $0.domain == "kAFAssistantErrorDomain" && $0.code == 1110 } ?? false
            guard let self else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self.receive(text, final: final, failed: failed, noSpeech: noSpeech) } }
        }
        observe(session)
    }

    /// Ends audio input; the recognizer still delivers its final result.
    func finish() {
        guard !closed else { return }
        stopping = true
        stopAudio()
        request?.endAudio()
    }

    /// Ends the session without reporting back.
    func cancel() {
        guard !closed else { return }
        closed = true
        task?.cancel()
        teardownAudio()
    }

    nonisolated private static func tap(appendingTo request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    private func receive(_ text: String?, final: Bool, failed: Bool, noSpeech: Bool) {
        guard !closed else { return }
        if let text {
            if !text.isEmpty { heard = true }
            onResult(text, final)
        }
        guard final || failed else { return }
        let issue: NativeDictationIssue? = failed && !heard && !stopping ? (noSpeech ? .noSpeech : .recognizerBusy) : nil
        close(reporting: issue)
    }

    private func observe(_ session: AVAudioSession) {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            guard type == .began else { return }
            MainActor.assumeIsolated { self?.close(reporting: nil) }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.close(reporting: nil) }
        })
    }

    private func close(reporting issue: NativeDictationIssue?) {
        guard !closed else { return }
        closed = true
        task?.cancel()
        teardownAudio()
        onEnd(issue)
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        guard let previous else { return }
        self.previous = nil
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(previous.category, mode: previous.mode, options: previous.options)
    }

    private func teardownAudio() {
        stopAudio()
        request?.endAudio()
        request = nil
        task = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
    }
}
